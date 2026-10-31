'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');
const { ControllerGatewayManager } = require('../desktop/controller-manager.cjs');
const { requestPrivateControl } = require('../desktop/private-control.cjs');
const { openControlSecret, sealControlSecret } = require('../desktop/protected-credential.cjs');
const { randomBytes, randomUUID } = require('node:crypto');
const { inspectNativeProcess } = require('../desktop/native-helper.cjs');
if (process.platform !== 'win32') throw new Error('此测试需要 Windows');
const root = path.resolve(__dirname, '..');
const stage = path.join(root, '.local', 'hajimink-stage');
const native = path.join(stage, 'controller', 'PrivateControlPipe.exe');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-controller-test-'));
const managers = [], servers = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { freePort } = require('./test-network.cjs');
function make(dir, port) { const m = new ControllerGatewayManager({ appRoot: stage, dataDir: dir, port, nodePath: process.execPath, runAsNode: false, startTimeoutMs: 15000 }); managers.push(m); return m; }
async function callParent(dir, port) {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'fixtures', 'controller-parent.cjs'), dir, String(port)], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => error += chunk);
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('父进程退出测试超时')), 40000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', value => { clearTimeout(timer); resolve(value); });
  });
  if (code !== 0) throw new Error(`父进程启动测试失败 ${code}: ${output.slice(0,1000)} ${error.slice(0,1000)}`);
  return JSON.parse(output);
}
async function forceSafeCleanup(dir) {
  // Only authenticated commands to the private controller; no process killing.
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'controller.instance.json'), 'utf8'));
    const secret = await openControlSecret(native, dir, r.instanceId);
    const expected = { instanceId: r.instanceId, dataDir: r.dataDir, entryPath: r.entryPath, nodePath: r.nodePath, controllerPath: r.controllerPath, port: r.port, processId: r.controllerPid, processCreation: r.controllerCreation };
    await requestPrivateControl(`\\\\.\\pipe\\${r.pipeName}`, secret, expected, 'stop', 15000);
    await delay(600);
  } catch {}
}
(async () => {
  assert.ok(fs.existsSync(native), '请先运行 node scripts/build-desktop-controller.cjs');
  const data = path.join(temp, '有空格 中文甲'); const port = await freePort();
  const first = make(data, port); const started = await first.start();
  assert.equal(started.state, 'ready', JSON.stringify(started)); assert.equal(started.managed, true);
  assert.equal((await (await fetch(`${started.origin}/api/health`)).json()).mode, 'local');
  const record = JSON.parse(fs.readFileSync(path.join(data, 'controller.instance.json'), 'utf8'));
  assert.ok(record.controllerPid && record.controllerCreation);
  const controllerInfo = await inspectNativeProcess(native, record.controllerPid, { kind: 'controller', entry: record.controllerPath });
  assert.equal(controllerInfo.creation, record.controllerCreation);
  const gatewayInfo = await inspectNativeProcess(native, started.pid, { kind: 'gateway', entry: record.entryPath, dataDir: data });
  assert.equal(gatewayInfo.pid, started.pid);
  await assert.rejects(inspectNativeProcess(native, started.pid, { kind: 'gateway', entry: path.join(stage, 'dist-server', 'wrong.js'), dataDir: data }), /启动参数不匹配/);
  await assert.rejects(inspectNativeProcess(native, started.pid, { kind: 'gateway', entry: record.entryPath, dataDir: path.join(temp, 'wrong-data') }), /启动参数不匹配/);
  const credential = fs.readFileSync(path.join(data, 'controller-secrets', `${record.instanceId}.dpapi`), 'utf8');
  const secret = await openControlSecret(native, data, record.instanceId); assert.ok(!credential.includes(secret));
  const expected = { instanceId: record.instanceId, dataDir: record.dataDir, entryPath: record.entryPath, nodePath: record.nodePath, controllerPath: record.controllerPath, port, processId: record.controllerPid, processCreation: record.controllerCreation };
  await assert.rejects(requestPrivateControl(`\\\\.\\pipe\\${record.pipeName}`, 'A'.repeat(43), expected, 'stop'));
  for (let i = 0; i < 15; i++) assert.equal((await requestPrivateControl(`\\\\.\\pipe\\${record.pipeName}`, secret, expected, 'status')).result.ok, true);
  assert.equal((await fetch(`${started.origin}/api/health`)).status, 200);
  first.close();
  const second = make(data, port); const attached = await second.start();
  assert.equal(attached.state, 'ready', JSON.stringify(attached)); assert.equal(attached.pid, started.pid); assert.equal(attached.controllerPid, record.controllerPid);
  const recordFile = path.join(data, 'controller.instance.json'); const savedRecord = fs.readFileSync(recordFile);
  if (!fs.realpathSync(data).toLowerCase().startsWith(fs.realpathSync(temp).toLowerCase() + path.sep)) throw new Error('Unexpected fixture path');
  fs.unlinkSync(recordFile);
  try {
    assert.equal((await second.stop()).state, 'error', 'a missing record while the port is occupied is not a confirmed stop');
    assert.equal((await fetch(`${started.origin}/api/health`)).status, 200, 'the still-running test gateway must remain untouched');
  } finally { fs.writeFileSync(recordFile, savedRecord, { flag: 'wx' }); }
  assert.equal((await second.stop()).state, 'stopped');
  await assert.rejects(fetch(`${started.origin}/api/health`)); assert.equal(fs.existsSync(path.join(data, 'controller.instance.json')), false);
  const restarted = await second.start(); assert.equal(restarted.state, 'ready', JSON.stringify(restarted));
  const restopped = await second.stop(); assert.equal(restopped.state, 'stopped', JSON.stringify(restopped));

  // Full private transport and child IPC issuance in a disposable pending-setup gateway.
  const diagnosticData = path.join(temp, 'diagnostic data'), diagnosticPort = await freePort();
  const diagnosticManager = make(diagnosticData, diagnosticPort);
  assert.equal((await diagnosticManager.start()).state, 'ready');
  const setup = await diagnosticManager.beginPasskeySetup('https://diagnostic.example');
  assert.equal(setup.gateway.streamDiagnostic, true);
  await assert.rejects(diagnosticManager.streamTicket({ ...setup.gateway, pid: setup.gateway.pid + 1 }), /变化/);
  const ticket = await diagnosticManager.streamTicket(setup.gateway);
  assert.match(ticket.token, /^[A-Za-z0-9_-]{43}$/);
  const socket = new WebSocket(`ws://127.0.0.1:${diagnosticPort}/api/diagnostics/stream`, { headers: { host: 'diagnostic.example', origin: 'https://diagnostic.example', 'x-hajimink-diagnostic': ticket.token } });
  try {
    await once(socket, 'open'); const received = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'ping', nonce: 'a'.repeat(32) }));
    assert.deepEqual(JSON.parse((await received)[0].toString()), { type: 'pong', nonce: 'a'.repeat(32) });
  } finally { socket.terminate(); }
  const gatewayLog = JSON.stringify(await diagnosticManager.logsSnapshot()); assert.equal(gatewayLog.includes(ticket.token), false);
  assert.equal((await diagnosticManager.stop()).state, 'stopped');

  const restartData = path.join(temp, 'parent exit 中文'); const restartPort = await freePort();
  const before = await callParent(restartData, restartPort);
  assert.equal(before.state, 'ready');
  assert.equal((await fetch(`http://127.0.0.1:${restartPort}/api/health`)).status, 200, 'gateway remains after its first desktop process exits');
  const after = make(restartData, restartPort); const resumed = await after.start();
  assert.equal(resumed.state, 'ready', JSON.stringify(resumed)); assert.equal(resumed.pid, before.pid); assert.equal(resumed.controllerPid, before.controllerPid);
  assert.equal((await after.stop()).state, 'stopped');
  await assert.rejects(fetch(`http://127.0.0.1:${restartPort}/api/health`));

  const sharedData = path.join(temp, 'parallel data'), sharedPort = await freePort();
  const sharedA = make(sharedData, sharedPort), sharedB = make(sharedData, sharedPort);
  const shared = await Promise.all([sharedA.start(), sharedB.start()]);
  assert.equal(shared[0].state, 'ready', JSON.stringify(shared)); assert.equal(shared[1].state, 'ready', JSON.stringify(shared));
  assert.equal(shared[0].controllerPid, shared[1].controllerPid); assert.equal(shared[0].pid, shared[1].pid);
  sharedA.close(); assert.equal((await sharedB.stop()).state, 'stopped');

  // A test-owned gateway that ignores its first stop request must stay alive;
  // after it exits on its own, the controller must report failure and clean up.
  const stubbornRoot = path.join(temp, 'stubborn app');
  fs.mkdirSync(path.join(stubbornRoot, 'controller'), { recursive: true });
  fs.mkdirSync(path.join(stubbornRoot, 'dist-server'), { recursive: true });
  for (const file of ['PrivateControlPipe.exe', 'gateway-controller.cjs', 'gateway-manager.cjs', 'native-helper.cjs', 'desktop-status.cjs', 'natapp-manager.cjs']) fs.copyFileSync(path.join(stage, 'controller', file), path.join(stubbornRoot, 'controller', file));
  fs.writeFileSync(path.join(stubbornRoot, 'dist-server', 'index.js'), `const http=require('node:http');const port=Number(process.env.AGENT_CONTROL_PORT);process.on('message',()=>{});http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({ok:true,mode:'local'}));}).listen(port,'127.0.0.1',()=>process.send({type:'hajimink:gateway-ready',port,mode:'local'}));setTimeout(()=>process.exit(17),8500);`);
  const stubbornData = path.join(temp, 'stubborn data'), stubbornPort = await freePort();
  const stubborn = new ControllerGatewayManager({ appRoot: stubbornRoot, dataDir: stubbornData, port: stubbornPort, nodePath: process.execPath, runAsNode: false, startTimeoutMs: 15000, stopTimeoutMs: 700 }); managers.push(stubborn);
  const stubbornStart = await stubborn.start(); assert.equal(stubbornStart.state, 'ready', JSON.stringify(stubbornStart));
  assert.equal(stubbornStart.streamDiagnostic, false, 'legacy gateways must not advertise unsupported diagnostics');
  const refusedStop = await stubborn.stop(); assert.equal(refusedStop.state, 'error', JSON.stringify(refusedStop));
  assert.equal((await fetch(`http://127.0.0.1:${stubbornPort}/api/health`)).status, 200, 'an unresponsive owned fixture must not be forcibly killed');
  const exitDeadline = Date.now() + 12000;
  while (Date.now() < exitDeadline) { try { await fetch(`http://127.0.0.1:${stubbornPort}/api/health`, { signal: AbortSignal.timeout(400) }); } catch { break; } await delay(200); }
  await assert.rejects(fetch(`http://127.0.0.1:${stubbornPort}/api/health`));
  const faultDeadline = Date.now() + 9000;
  while (stubborn.snapshot().message !== '本机网关进程已退出' && Date.now() < faultDeadline) await delay(200);
  assert.equal(stubborn.snapshot().message, '本机网关进程已退出', 'the controller must report the later unexpected process exit');
  assert.equal(stubborn.snapshot().managed, true, 'the live controller must remain manageable after gateway failure');
  assert.equal((await stubborn.stop()).state, 'stopped');

  // Same Node executable and a live PID are insufficient: the real command line
  // must identify the controller script and match its process creation time.
  const collisionData = path.join(temp, 'credential collision'); fs.mkdirSync(path.join(collisionData, 'controller-secrets'), { recursive: true });
  const collisionId = randomUUID(); const collisionPath = path.join(collisionData, 'controller-secrets', `${collisionId}.dpapi`);
  fs.writeFileSync(path.join(collisionData, 'controller.instance.json'), JSON.stringify({ instanceId: collisionId }));
  fs.writeFileSync(collisionPath, 'pre-existing fixture');
  const collision = make(collisionData, await freePort());
  await collision.removeUnstartedRecord(collisionId, false);
  assert.equal(fs.readFileSync(collisionPath, 'utf8'), 'pre-existing fixture', 'failed creation must not delete an existing credential file');

  const forgedData = path.join(temp, 'forged'); fs.mkdirSync(forgedData);
  const forgedPort = await freePort(), forgedId = randomUUID();
  const self = await inspectNativeProcess(native, process.pid);
  const forged = { version: 1, instanceId: forgedId, pipeName: `hajimink-${randomBytes(16).toString('hex')}`, port: forgedPort, dataDir: forgedData, entryPath: path.join(stage, 'dist-server', 'index.js'), nodePath: process.execPath, controllerPath: path.join(stage, 'controller', 'gateway-controller.cjs'), controllerPid: process.pid, controllerCreation: self.creation };
  fs.writeFileSync(path.join(forgedData, 'controller.instance.json'), JSON.stringify(forged));
  await sealControlSecret(native, forgedData, forgedId, randomBytes(32).toString('base64url'));
  const impostor = make(forgedData, forgedPort); impostor.startTimeoutMs = 1000;
  assert.equal((await impostor.start()).state, 'error');
  assert.equal((await impostor.stop()).state, 'error', 'the unknown process must not be stopped');
  assert.equal(fs.existsSync(path.join(forgedData, 'controller.instance.json')), true);

  const fake = http.createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end('{"ok":true,"mode":"local"}'); });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve)); servers.push(fake);
  const fakePort = fake.address().port, foreign = make(path.join(temp, 'foreign'), fakePort);
  assert.equal((await foreign.start()).state, 'error');
  assert.equal((await foreign.stop()).state, 'error', 'an occupied port without our controller record cannot be reported as stopped');
  assert.equal((await (await fetch(`http://127.0.0.1:${fakePort}/api/health`)).json()).ok, true);
  console.log('PASS Windows background controller: user-protected credentials and pipe, executable/arguments/start-time identity checks, owned gateway startup and stop, concurrent start, parent process exit and authenticated reattach, Unicode paths, unresponsive gateway protection, forged PID/command line and foreign listener protection');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const m of managers) { try { await m.stop(); } catch {} m.close(); }
  for (const dir of [path.join(temp, '有空格 中文甲'), path.join(temp, 'parent exit 中文'), path.join(temp, 'parallel data'), path.join(temp, 'stubborn data')]) await forceSafeCleanup(dir);
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  const leftovers = [path.join(temp, '有空格 中文甲'), path.join(temp, 'parent exit 中文'), path.join(temp, 'parallel data'), path.join(temp, 'stubborn data')].some(dir => fs.existsSync(path.join(dir, 'controller.instance.json')));
  if (leftovers) { console.error('测试实例未确认退出，保留临时目录供排查：', temp); process.exitCode = 1; return; }
  const resolved = fs.realpathSync(temp), safeRoot = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved).toLowerCase() !== safeRoot.toLowerCase() || !path.basename(resolved).startsWith('hajimink-controller-test-')) throw new Error('Unexpected test directory');
  fs.rmSync(resolved, { recursive: true, force: true });
});
