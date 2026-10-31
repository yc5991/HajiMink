'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { GatewayManager } = require('../desktop/gateway-manager.cjs');
const stage = path.resolve(__dirname, '..', '.local', 'hajimink-stage');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-manager-test-'));
const owned = [], servers = [];
let stubbornFixture;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { freePort } = require('./test-network.cjs');
function manager(name, port, extra = {}) {
  const value = new GatewayManager({ appRoot: stage, dataDir: path.join(temp, name), port, nodePath: process.execPath, runAsNode: false, ...extra });
  owned.push(value); return value;
}
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server); return server.address().port; }
(async () => {
  assert.ok(fs.existsSync(path.join(stage, 'dist-server', 'index.js')), '请先运行 npm run build:desktop:fixture');
  const port = await freePort();
  const m = manager('main', port);
  const [started, same] = await Promise.all([m.start(), m.start()]);
  assert.equal(started.state, 'ready', started.message); assert.equal(started.managed, true); assert.equal(same.pid, started.pid);
  assert.equal((await (await fetch(`${started.origin}/api/health`)).json()).mode, 'local');
  assert.equal((await fetch(started.origin)).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp, 'main', 'config.json'), 'utf8')), { mode: 'local', port, publicOrigin: started.origin });
  const otherWindow = manager('main', port);
  const conflict = await otherWindow.start();
  assert.equal(conflict.state, 'error'); assert.equal(conflict.managed, false);
  await otherWindow.stop(); assert.equal((await fetch(started.origin)).status, 200);
  assert.equal((await m.stop()).state, 'stopped'); await assert.rejects(fetch(`${started.origin}/api/health`));
  assert.equal(fs.existsSync(path.join(temp, 'main', 'gateway.instance.lock')), false);

  // Test real child-process shutdown with TCP peers that never finish headers.
  // These sockets belong only to this fixture and are released before cleanup.
  const partialManager = manager('partial-headers', await freePort());
  let idleSocket, partialSocket;
  try {
    assert.equal((await partialManager.start()).state, 'ready');
    const connect = () => new Promise((resolve, reject) => {
      const socket = net.connect(partialManager.port, '127.0.0.1');
      socket.on('error', reject); socket.once('connect', () => resolve(socket));
    });
    idleSocket = await connect(); partialSocket = await connect();
    partialSocket.write(`POST /api/threads HTTP/1.1\r\nHost: 127.0.0.1:${partialManager.port}\r\n`);
    await delay(150);
    const result = await partialManager.stop();
    assert.equal(result.state, 'stopped', 'unfinished request headers must not exhaust the controller stop timeout');
    assert.equal(result.managed, false);
  } finally {
    idleSocket?.destroy(); partialSocket?.destroy();
    await partialManager.stop();
  }

  const fake = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"mode":"local"}'); });
  const fakePort = await listen(fake); const spoof = manager('fake', fakePort);
  assert.equal((await spoof.start()).state, 'error');
  assert.equal(spoof.snapshot().managed, false); await spoof.stop();
  assert.equal((await (await fetch(`http://127.0.0.1:${fakePort}/api/health`)).json()).ok, true, 'unknown HTTP process must remain alive');

  const raw = net.createServer(socket => { socket.on('error', () => {}); });
  const rawPort = await listen(raw); const rawManager = manager('raw', rawPort);
  assert.equal((await rawManager.start()).state, 'error', 'non-HTTP listener must count as occupied');
  assert.equal(rawManager.snapshot().managed, false);

  const stalePort = await freePort(); const stale = manager('stale', stalePort);
  fs.mkdirSync(path.join(temp, 'stale'), { recursive: true });
  const lock = path.join(temp, 'stale', 'gateway.instance.lock');
  fs.writeFileSync(lock, '{"id":"existing-instance"}');
  assert.match((await stale.start()).message, /已有网关实例记录/);
  assert.equal(fs.readFileSync(lock, 'utf8'), '{"id":"existing-instance"}', 'stale locks must not be removed automatically');

  const unsupported = manager('linux', await freePort(), { platform: 'linux' });
  assert.equal((await unsupported.start()).state, 'unsupported');
  assert.equal(fs.existsSync(path.join(temp, 'linux')), false);

  const concurrentPortA = await freePort(), concurrentPortB = await freePort();
  const concurrentA = manager('shared', concurrentPortA), concurrentB = manager('shared', concurrentPortB);
  const concurrent = await Promise.all([concurrentA.start(), concurrentB.start()]);
  assert.equal(concurrent.filter(item => item.state === 'ready').length, 1, 'a data directory must have at most one managed instance');
  assert.equal(concurrent.filter(item => item.state === 'error').length, 1);
  const winner = concurrentA.snapshot().state === 'ready' ? concurrentA : concurrentB;
  const saved = JSON.parse(fs.readFileSync(path.join(temp, 'shared', 'config.json'), 'utf8'));
  assert.equal(saved.port, winner.port, 'a competing instance must not overwrite the winning config');
  assert.equal((await winner.stop()).state, 'stopped');

  const secret = 'secret-PASSWORD-cookie-token-body-123';
  const hangEntry = path.join(temp, 'silent-test.cjs');
  fs.writeFileSync(hangEntry, `process.stdout.write(${JSON.stringify(secret)});process.stderr.write(${JSON.stringify(secret)});process.on('message', m => { if(m.type === 'hajimink:gateway-stop') process.exit(0); });setInterval(()=>{},1000);`);
  const hung = manager('hung', await freePort(), { entryPath: hangEntry, startTimeoutMs: 900, stopTimeoutMs: 2000 });
  fs.mkdirSync(path.join(temp, 'hung'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'hung', 'gateway.stdout.log'), secret); // legacy file must not be loaded
  const fail = await hung.start(); assert.equal(fail.state, 'error'); assert.equal(fail.managed, false);
  assert.equal(fs.existsSync(path.join(temp, 'hung', 'gateway.instance.lock')), false);
  const logs = JSON.stringify(await hung.logsSnapshot()); assert.ok(!logs.includes(secret)); assert.ok(!JSON.stringify(fail).includes(secret));
  assert.equal(fs.existsSync(path.join(temp, 'hung', 'gateway.stderr.log')), false, 'raw stderr must not be written');

  const stubbornEntry = path.join(temp, 'stubborn-test.cjs');
  fs.writeFileSync(stubbornEntry, `process.on('message', m => { if(m.type === 'test:quit') process.exit(0); });setInterval(()=>{},1000);`);
  const stubborn = manager('stubborn', await freePort(), { entryPath: stubbornEntry, startTimeoutMs: 500, stopTimeoutMs: 300 });
  const stubbornFailure = await stubborn.start();
  assert.equal(stubbornFailure.state, 'error'); assert.equal(stubbornFailure.managed, true);
  assert.equal(fs.existsSync(path.join(temp, 'stubborn', 'gateway.instance.lock')), true, 'a live unresponsive process must keep its lock');
  stubbornFixture = stubborn.child;
  const exited = new Promise(resolve => stubbornFixture.once('exit', resolve));
  stubbornFixture.send({ type: 'test:quit' }); await exited; await stubborn.lockCleanup;
  assert.equal(fs.existsSync(path.join(temp, 'stubborn', 'gateway.instance.lock')), false);

  const missing = manager('missing', await freePort(), { nodePath: path.join(temp, 'does-not-exist.exe'), startTimeoutMs: 1000 });
  assert.equal((await missing.start()).state, 'error');
  assert.equal(missing.snapshot().managed, false);
  assert.equal(fs.existsSync(path.join(temp, 'missing', 'gateway.instance.lock')), false);

  const serial = manager('serial', await freePort());
  const first = serial.start(); const second = serial.stop();
  assert.equal((await first).state, 'ready'); assert.equal((await second).state, 'stopped');
  console.log('PASS gateway manager: owned IPC identity, real local HTTP startup, incomplete-header shutdown, serial start/stop, fake HTTP and non-HTTP port conflicts, preserved unknown processes, stale lock, data-directory exclusion, unsupported OS, failed spawn, timeout and unresponsive-child protection, private lifecycle-only logs');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (stubbornFixture?.connected && stubbornFixture.exitCode === null) {
    stubbornFixture.send({ type: 'test:quit' });
    await Promise.race([new Promise(resolve => stubbornFixture.once('exit', resolve)), delay(2000)]);
  }
  let safeToDelete = true;
  for (const m of owned) { const result = await m.stop().catch(() => null); if (result?.managed) { console.error('A test-owned gateway did not stop; fixture directory retained:', temp); process.exitCode = 1; safeToDelete = false; } }
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  if (!safeToDelete) return;
  const resolved = fs.realpathSync(temp), safeRoot = fs.realpathSync(os.tmpdir());
  if (!resolved.startsWith(safeRoot + path.sep) || !path.basename(resolved).startsWith('hajimink-manager-test-')) throw new Error('Unexpected test directory');
  fs.rmSync(resolved, { recursive: true, force: true });
});
