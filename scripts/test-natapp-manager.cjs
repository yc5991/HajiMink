'use strict';
// Only disposable fake NATAPP binaries and data are used; no service credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { NatappManager, readNatappSettings, saveNatappSettings } = require('../desktop/natapp-manager.cjs');
const { inspectNativeProcess, stopOwnedTunnel, countNatappProcesses, isOriginalProcessGone } = require('../desktop/native-helper.cjs');
if (process.platform !== 'win32') throw new Error('此测试需要 Windows');
const root = path.resolve(__dirname, '..');
const native = path.join(root, '.local', 'hajimink-stage', 'controller', 'PrivateControlPipe.exe');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-natapp-test-'));
const dataDir = path.join(temp, '资料'), binDir = path.join(temp, '客户端 文件');
const binaryPath = path.join(binDir, 'natapp.exe'), configPath = path.join(binDir, 'fixture config.ini');
const secret = 'fixture-secret-token-never-read-by-manager';
let external, externalIdentity, manager, reattached;
const expected = () => ({ kind: 'natapp', binaryPath, configPath });
(async () => {
  await fsp.mkdir(binDir, { recursive: true }); await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(configPath, `[default]\nauthtoken=${secret}\n`);
  const csc = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', `/out:${binaryPath}`, path.join(root, 'scripts', 'fixtures', 'FakeNatapp.cs')], { windowsHide: true, encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stdout || compiled.stderr);
  assert.equal(await countNatappProcesses(native), 0, 'run this isolated test only when no real NATAPP is active');
  const settings = await saveNatappSettings(dataDir, { binaryPath, configPath });
  assert.equal(settings.binaryPath.toLowerCase(), binaryPath.toLowerCase());
  assert.equal(settings.configPath.toLowerCase(), configPath.toLowerCase());
  assert.equal(fs.readFileSync(path.join(dataDir, 'natapp-settings.json'), 'utf8').includes(secret), false);
  assert.deepEqual(await readNatappSettings(dataDir), settings);
  await assert.rejects(saveNatappSettings(dataDir, { binaryPath: path.join(binDir, 'wrong.exe'), configPath }), /natapp\.exe/);
  await assert.rejects(saveNatappSettings(dataDir, { binaryPath, configPath: path.join(binDir, 'wrong.txt') }), /\.ini/);
  assert.equal(fs.readFileSync(configPath, 'utf8').includes(secret), true, 'the selected file must remain unchanged');

  let protectedGateway = false;
  manager = new NatappManager({ dataDir, nativePath: native, verifyGateway: async () => protectedGateway });
  assert.equal((await manager.start()).state, 'error');
  assert.equal(await countNatappProcesses(native), 0, 'unprotected gateway must never start NATAPP');
  protectedGateway = true;
  external = spawn(binaryPath, [`-config=${configPath}`, '-log=none'], { cwd: binDir, windowsHide: true, stdio: 'ignore' });
  external.on('error', () => {});
  for (let i = 0; i < 30 && !externalIdentity; i++) {
    externalIdentity = await inspectNativeProcess(native, external.pid, expected()).catch(() => null);
    if (!externalIdentity) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(externalIdentity, 'fixture process must be identifiable');
  assert.match((await manager.start()).message, /已有 NATAPP/);
  assert.equal(external.exitCode, null, 'existing NATAPP must never be stopped or adopted');
  const externalExited = new Promise(resolve => { if (external.exitCode !== null || external.signalCode !== null) resolve(); else external.once('exit', resolve); });
  await stopOwnedTunnel(native, external.pid, { ...expected(), creation: externalIdentity.creation });
  await externalExited; external = undefined;
  const started = await manager.start();
  assert.equal(started.state, 'running', JSON.stringify(started)); assert.equal(started.managed, true);
  assert.equal(manager.child.spawnargs.some(value => value.includes(secret)), false);
  const record = JSON.parse(await fsp.readFile(path.join(dataDir, 'natapp.instance.json'), 'utf8'));
  assert.equal(JSON.stringify(record).includes(secret), false);
  await assert.rejects(saveNatappSettings(dataDir, { binaryPath, configPath }), /先停止/);
  await assert.rejects(stopOwnedTunnel(native, started.pid, { ...expected(), creation: '134000000000000000' }));
  await assert.rejects(stopOwnedTunnel(native, started.pid, { ...expected(), configPath: path.join(binDir, 'wrong.ini'), creation: record.creation }));
  assert.equal((await manager.refresh()).state, 'running', 'failed forged stop must preserve the managed process');
  reattached = new NatappManager({ dataDir, nativePath: native, verifyGateway: async () => true });
  assert.equal((await reattached.refresh()).pid, started.pid);
  const stopped = await reattached.stop(); assert.equal(stopped.state, 'stopped', JSON.stringify(stopped));
  assert.equal(fs.existsSync(path.join(dataDir, 'natapp.instance.json')), false);
  assert.equal(await countNatappProcesses(native), 0);
  assert.equal(fs.readFileSync(configPath, 'utf8').includes(secret), true);

  // Simulate the original controller disappearing before its child exits.
  const again = await manager.start();
  assert.equal(again.state, 'running', JSON.stringify(again));
  const staleRecord = JSON.parse(await fsp.readFile(path.join(dataDir, 'natapp.instance.json'), 'utf8'));
  assert.equal(await isOriginalProcessGone(native, again.pid, staleRecord.creation), false);
  assert.equal(await isOriginalProcessGone(native, again.pid, '134000000000000000'), true, 'a reused PID must not be mistaken for the original instance');
  const unknown = new NatappManager({ dataDir, nativePath: native, verifyGateway: async () => true, inspect: async () => { throw new Error('not readable'); }, originalGone: async () => true });
  assert.equal((await unknown.refresh()).state, 'unconfirmed', 'any remaining NATAPP prevents stale-record cleanup');
  assert.equal(fs.existsSync(path.join(dataDir, 'natapp.instance.json')), true);
  const child = manager.child;
  child.removeAllListeners('exit');
  const exited = new Promise(resolve => child.once('exit', resolve));
  await stopOwnedTunnel(native, again.pid, { ...expected(), creation: staleRecord.creation });
  await exited;
  assert.equal(await isOriginalProcessGone(native, again.pid, staleRecord.creation), true);
  const denied = new NatappManager({ dataDir, nativePath: native, inspect: async () => { throw new Error('not readable'); }, originalGone: async () => { throw new Error('access denied'); } });
  assert.equal((await denied.refresh()).state, 'unconfirmed', 'failure to inspect must not clear the record');
  assert.equal(fs.existsSync(path.join(dataDir, 'natapp.instance.json')), true);
  const countDenied = new NatappManager({ dataDir, nativePath: native, inspect: async () => { throw new Error('not readable'); }, originalGone: async () => true, countProcesses: async () => { throw new Error('enumeration unavailable'); } });
  assert.equal((await countDenied.refresh()).state, 'unconfirmed', 'an unavailable process list must not clear the record');
  assert.equal(fs.existsSync(path.join(dataDir, 'natapp.instance.json')), true);
  const recovered = await reattached.start();
  assert.equal(recovered.state, 'running', JSON.stringify(recovered));
  assert.notEqual(JSON.parse(await fsp.readFile(path.join(dataDir, 'natapp.instance.json'), 'utf8')).instanceId, staleRecord.instanceId, 'restart should create a fresh instance record');
  assert.equal((await reattached.stop()).state, 'stopped');
  assert.equal(await countNatappProcesses(native), 0);
  console.log('PASS NATAPP manager: protected gateway gate, file-only settings, no token in args or records, existing-process protection, exact identity checks, reattach, safe stale-record recovery and owned stop');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  let safe = true;
  if (reattached) { const state = await reattached.stop().catch(() => null); if (state?.state === 'unconfirmed') safe = false; }
  if (manager) { const state = await manager.stop().catch(() => null); if (state?.state === 'unconfirmed') safe = false; }
  if (external && external.exitCode === null && externalIdentity) {
    try { await stopOwnedTunnel(native, external.pid, { ...expected(), creation: externalIdentity.creation }); } catch { safe = false; }
  }
  if (!safe) { console.error('Fixture state unconfirmed; retained:', temp); process.exitCode = 1; return; }
  const resolved = fs.realpathSync(temp), base = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved).toLowerCase() !== base.toLowerCase() || !path.basename(resolved).startsWith('hajimink-natapp-test-')) throw new Error('Unexpected fixture path');
  fs.rmSync(resolved, { recursive: true, force: true });
});
