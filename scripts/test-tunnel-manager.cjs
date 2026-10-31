'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { inspectNativeProcess, stopOwnedTunnel } = require('../desktop/native-helper.cjs');
const { TunnelManager } = require('../desktop/tunnel-manager.cjs');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-tunnel-test-'));
const fake = path.join(root, 'scripts', 'fixtures', 'fake-cloudflared.cjs');
const managers = [], foreignServers = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { freePort } = require('./test-network.cjs');
function make(dataDir, metricsPort, options = {}) {
  const manager = new TunnelManager({ dataDir, binaryPath: process.execPath, tokenPath: path.join(dataDir, 'tunnel-token'), metricsPort, platform: 'win32', requireFormalConfig: false, commandPrefix: [fake], spawnImpl: (file, args, opts) => spawn(file, args, opts), startTimeoutMs: 7000, stopTimeoutMs: 2000, inspectProcess: async (_binary, pid) => { try { process.kill(pid, 0); } catch { throw new Error('dead'); } return { pid, image: process.execPath, argsMatched: true, creation: '134000000000000000' }; }, stopProcess: async (_native, pid) => { process.kill(pid, 'SIGTERM'); const until = Date.now() + 3000; while (Date.now() < until) { try { process.kill(pid, 0); await delay(50); } catch { return; } } throw new Error('fixture stop timeout'); }, secureToken: async () => {}, ...options });
  managers.push(manager); return manager;
}
async function prepare(name) { const dir = path.join(temp, name); await fsp.mkdir(dir, { recursive: true }); await fsp.writeFile(path.join(dir, 'tunnel-token'), 'fixture-token-value-should-never-enter-process-args\n'); return dir; }
(async () => {
  const data = await prepare('有空格 中文'); const metrics = await freePort();
  let capturedEnvironment;
  process.env.TUNNEL_TOKEN = 'fixture-inherited-secret';
  const first = make(data, metrics, { spawnImpl: (file, args, opts) => { capturedEnvironment = opts.env; return spawn(file, args, opts); } }); const started = await first.start();
  delete process.env.TUNNEL_TOKEN;
  assert.equal(capturedEnvironment.TUNNEL_TOKEN, undefined, 'inherited cloudflared token must not override the file');
  assert.equal(started.state, 'connected', JSON.stringify(started)); assert.equal(started.managed, true); assert.equal(started.readyConnections, 1);
  assert.equal(first.child.spawnargs.includes('fixture-token-value-should-never-enter-process-args'), false);
  const record = JSON.parse(fs.readFileSync(path.join(data, 'tunnel.instance.json'), 'utf8')); assert.equal(record.token, undefined); assert.equal(record.tokenPath, path.join(data, 'tunnel-token'));
  first.close();
  const second = make(data, metrics); const attached = await second.start(); assert.equal(attached.state, 'connected'); assert.equal(attached.pid, started.pid);
  assert.equal((await second.stop()).state, 'stopped'); assert.equal(fs.existsSync(path.join(data, 'tunnel.instance.json')), false);
  await assert.rejects(fetch(`http://127.0.0.1:${metrics}/ready`));

  const conflictData = await prepare('foreign'); const conflictPort = await freePort(); const foreign = net.createServer(socket => { socket.on('error', () => {}); }); await new Promise(resolve => foreign.listen(conflictPort, '127.0.0.1', resolve)); foreignServers.push(foreign);
  const conflict = make(conflictData, conflictPort); const conflictResult = await conflict.start(); assert.equal(conflictResult.state, 'error'); assert.match(conflictResult.message, /占用/); assert.equal((await conflict.stop()).state, 'error');

  const missing = new TunnelManager({ dataDir: path.join(temp, 'missing'), binaryPath: path.join(temp, 'missing', 'cloudflared.exe'), tokenPath: path.join(temp, 'missing', 'tunnel-token'), metricsPort: await freePort(), platform: 'win32', requireFormalConfig: false });
  assert.equal((await missing.start()).state, 'unconfigured');

  const staleData = await prepare('stale'); const stalePath = path.join(staleData, 'tunnel.instance.json'); fs.writeFileSync(stalePath, '{"untrusted":true}');
  const stale = make(staleData, await freePort()); assert.equal((await stale.start()).state, 'error'); assert.equal((await stale.stop()).state, 'error');
  assert.equal(fs.readFileSync(stalePath, 'utf8'), '{"untrusted":true}', 'an untrusted existing record must never be removed');

  const failData = await prepare('fail'); const failScript = path.join(temp, 'fail.cjs'); fs.writeFileSync(failScript, 'setTimeout(() => process.exit(9), 50);');
  const failed = make(failData, await freePort(), { commandPrefix: [failScript] }); const failedState = await failed.start(); assert.equal(failedState.state, 'error'); assert.equal(fs.existsSync(path.join(failData, 'tunnel.instance.json')), false); assert.equal(fs.readFileSync(path.join(failData, 'tunnel-token'), 'utf8').includes('fixture-token-value'), true);

  const nativeData = await prepare('native 守护'); const nativePort = await freePort();
  const nativeHelper = path.join(root, '.local', 'hajimink-stage', 'controller', 'PrivateControlPipe.exe');
  const nativeBinary = path.join(nativeData, 'fake-cloudflared.exe');
  const csc = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const compile = spawnSync(csc, ['/nologo', '/target:exe', `/out:${nativeBinary}`, path.join(root, 'scripts', 'fixtures', 'FakeCloudflared.cs')], { windowsHide: true });
  assert.equal(compile.status, 0, 'native Tunnel fixture should compile');
  const nativeManager = new TunnelManager({ dataDir: nativeData, nativePath: nativeHelper, binaryPath: nativeBinary, tokenPath: path.join(nativeData, 'tunnel-token'), metricsPort: nativePort, platform: 'win32', requireFormalConfig: false, secureToken: async () => {} });
  const child = spawn(nativeBinary, nativeManager.args(), { cwd: nativeData, windowsHide: true, stdio: 'ignore' }); child.on('error', () => {});
  const expected = { kind: 'tunnel', binaryPath: nativeBinary, tokenPath: path.join(nativeData, 'tunnel-token'), metricsAddress: `127.0.0.1:${nativePort}`, protocol: 'http2', creation: '0' };
  try {
    const verified = await inspectNativeProcess(nativeHelper, child.pid, expected); expected.creation = verified.creation;
    await assert.rejects(stopOwnedTunnel(nativeHelper, child.pid, { ...expected, creation: '134000000000000000' }), /执行失败/);
    await assert.rejects(stopOwnedTunnel(nativeHelper, child.pid, { ...expected, tokenPath: path.join(nativeData, 'wrong-token') }), /执行失败/);
    assert.equal(child.exitCode, null, 'mismatched identity must preserve the fixture process');
    const exited = new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    await stopOwnedTunnel(nativeHelper, child.pid, expected);
    await exited;
  } finally {
    if (child.exitCode === null) { const info = await inspectNativeProcess(nativeHelper, child.pid, expected).catch(() => null); if (info) await stopOwnedTunnel(nativeHelper, child.pid, { ...expected, creation: info.creation }).catch(() => {}); }
  }

  const formalData = await prepare('formal'); const formalConfig = path.join(formalData, 'config.json'); fs.writeFileSync(formalConfig, JSON.stringify({ mode: 'owner', publicOrigin: 'https://agent.example.com', port: 3000 }));
  const formal = new TunnelManager({ dataDir: formalData, binaryPath: path.join(formalData, 'missing.exe'), tokenPath: path.join(formalData, 'tunnel-token'), metricsPort: await freePort(), gatewayPort: 3000, platform: 'win32' }); assert.equal((await formal.start()).state, 'unconfigured');
  let spawned = false;
  const gated = new TunnelManager({ dataDir: formalData, binaryPath: process.execPath, tokenPath: path.join(formalData, 'tunnel-token'), metricsPort: await freePort(), gatewayPort: 3000, platform: 'win32', spawnImpl: () => { spawned = true; throw new Error('must not spawn'); }, secureToken: async () => {}, verifyGateway: async () => false }); managers.push(gated);
  assert.match((await gated.start()).message, /身份验证未生效/); assert.equal(spawned, false);
  fs.writeFileSync(formalConfig, JSON.stringify({ mode: 'local', publicOrigin: 'http://localhost:3000', port: 3000 }));
  assert.match((await gated.start()).message, /正式网关配置不完整/); assert.equal(spawned, false);
  console.log('PASS Tunnel manager: configured/unconfigured states, HTTP/2 token-file command, no token in args or record, managed startup, metrics readiness, reattach, native process-handle stop and forged identity protection, foreign metrics-port protection, failed-start cleanup and Unicode paths');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  let safeToDelete = true;
  for (const manager of managers) { try { const result = await manager.stop(); if (result.managed) safeToDelete = false; } catch { safeToDelete = false; } manager.close(); }
  for (const server of foreignServers) await new Promise(resolve => server.close(resolve));
  if (!safeToDelete) { console.error('测试 Tunnel 仍在运行，保留临时目录：', temp); process.exitCode = 1; return; }
  const resolved = fs.realpathSync(temp), safeRoot = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved).toLowerCase() !== safeRoot.toLowerCase() || !path.basename(resolved).startsWith('hajimink-tunnel-test-')) throw new Error('Unexpected test directory');
  fs.rmSync(resolved, { recursive: true, force: true });
});
