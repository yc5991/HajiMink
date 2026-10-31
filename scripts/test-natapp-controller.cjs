'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ControllerGatewayManager } = require('../desktop/controller-manager.cjs');
const { countNatappProcesses } = require('../desktop/native-helper.cjs');
if (process.platform !== 'win32') throw new Error('Windows required');
const root = path.resolve(__dirname, '..'), stage = path.join(root, '.local', 'hajimink-stage');
const native = path.join(stage, 'controller', 'PrivateControlPipe.exe');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-natapp-controller-'));
const dataDir = path.join(temp, 'gateway data'), folder = path.join(temp, 'natapp fixture 中文');
const binaryPath = path.join(folder, 'natapp.exe'), configPath = path.join(folder, 'test.ini');
let first, second;
const { freePort } = require('./test-network.cjs');
(async () => {
  assert.equal(await countNatappProcesses(native), 0, 'real NATAPP must not be active during fixture');
  fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(configPath, '[default]\nauthtoken=fixture-controller-only\n');
  const csc = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const result = spawnSync(csc, ['/nologo', '/target:exe', `/out:${binaryPath}`, path.join(root, 'scripts', 'fixtures', 'FakeNatapp.cs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const port = await freePort();
  const make = () => new ControllerGatewayManager({ appRoot: stage, dataDir, port, nodePath: process.execPath, runAsNode: false, startTimeoutMs: 15000 });
  first = make();
  assert.equal((await first.start()).state, 'ready');
  await first.configureNatapp({ binaryPath, configPath });
  await first.refresh();
  await assert.rejects(first.natappAction('start'), /独立登录/);
  assert.equal(await countNatappProcesses(native), 0);
  const setup = await first.prepareAwaitingOrigin();
  assert.equal(setup.gateway.mode, 'owner'); assert.equal(setup.gateway.setupPending, true);
  const running = await first.natappAction('start');
  assert.equal(running.natapp?.state, 'running', JSON.stringify(running.natapp));
  assert.equal(running.natapp.managed, true); assert.ok(running.natapp.pid);
  await assert.rejects(first.configureNatapp({ binaryPath, configPath }), /先停止/);
  const pid = running.natapp.pid;
  // A retained tunnel must never allow a newly launched local-only gateway.
  const savedConfig = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
  const kept = await first.stopInternal(true);
  assert.equal(kept.state, 'stopped');
  assert.equal(kept.natapp?.state, 'running', 'address transition must report the retained NATAPP');
  assert.equal(await countNatappProcesses(native), 1);
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ mode: 'local', port, publicOrigin: `http://127.0.0.1:${port}` }));
  try {
    assert.equal((await first.start()).state, 'error', 'a retained tunnel must block unsafe local gateway startup');
    assert.equal(await countNatappProcesses(native), 1, 'the retained fixture tunnel must not be killed');
  } finally { fs.writeFileSync(path.join(dataDir, 'config.json'), savedConfig); }
  assert.equal((await first.start()).natapp?.pid, pid);
  const bound = await first.bindPendingOrigin('https://fixture.example');
  assert.equal(bound.gateway.natapp?.state, 'running', 'binding the acquired address must retain the running NATAPP');
  assert.equal(bound.gateway.natapp.pid, pid);
  first.close(); second = make();
  const reattached = await second.start();
  assert.equal(reattached.natapp?.state, 'running'); assert.equal(reattached.natapp.pid, pid);
  assert.equal((await second.natappAction('stop')).natapp?.state, 'stopped');
  assert.equal(await countNatappProcesses(native), 0);
  const restarted = await second.natappAction('start'); assert.equal(restarted.natapp?.state, 'running');
  const recordPath = path.join(dataDir, 'natapp.instance.json');
  const originalRecord = fs.readFileSync(recordPath, 'utf8');
  const forgedRecord = JSON.parse(originalRecord); forgedRecord.creation = '134000000000000000';
  fs.writeFileSync(recordPath, JSON.stringify(forgedRecord));
  try {
    assert.equal((await second.stop()).state, 'error', 'unconfirmed NATAPP must block gateway stop');
    assert.equal(await countNatappProcesses(native), 1, 'an unconfirmed process must not be stopped');
  } finally { fs.writeFileSync(recordPath, originalRecord); }
  const stoppedTogether = await second.stop();
  assert.equal(stoppedTogether.state, 'stopped');
  assert.equal(stoppedTogether.natapp?.state, 'stopped', 'gateway stop must report the tunnel as stopped');
  assert.equal(await countNatappProcesses(native), 0, 'stopping gateway must stop the owned NATAPP first');
  assert.equal(fs.existsSync(path.join(dataDir, 'natapp.instance.json')), false);
  assert.equal(fs.readFileSync(configPath, 'utf8').includes('fixture-controller-only'), true);

  // A previously verified owned NATAPP can outlive the controller during an
  // address change. The desktop observer must be able to stop it by identity.
  assert.equal((await second.start()).state, 'ready');
  assert.equal((await second.natappAction('start')).natapp?.state, 'running');
  assert.equal((await second.stopInternal(true)).state, 'stopped');
  assert.equal(fs.existsSync(path.join(dataDir, 'controller.instance.json')), false);
  const orphanOriginal = fs.readFileSync(recordPath, 'utf8');
  const orphanForged = JSON.parse(orphanOriginal); orphanForged.creation = '134000000000000000';
  fs.writeFileSync(recordPath, JSON.stringify(orphanForged));
  try {
    const denied = await second.stop();
    assert.equal(denied.state, 'error', 'without a controller, forged identity must block stop');
    assert.equal(denied.natapp?.state, 'unconfirmed');
    assert.equal(await countNatappProcesses(native), 1, 'unknown processes must never be stopped');
  } finally { fs.writeFileSync(recordPath, orphanOriginal); }
  const stoppedOrphan = await second.stop();
  assert.equal(stoppedOrphan.state, 'stopped', 'without a controller, owned NATAPP should stop safely');
  assert.equal(stoppedOrphan.natapp?.state, 'stopped', 'orphan stop must report the tunnel as stopped');
  assert.equal(await countNatappProcesses(native), 0);
  assert.equal(fs.existsSync(recordPath), false);

  assert.equal((await second.start()).state, 'ready');
  assert.equal((await second.natappAction('start')).natapp?.state, 'running');
  assert.equal((await second.stopInternal(true)).state, 'stopped');
  assert.equal((await second.natappAction('stop')).natapp?.state, 'stopped', 'direct NATAPP stop must work without a controller');
  assert.equal(await countNatappProcesses(native), 0);

  assert.equal((await second.start()).state, 'ready');
  assert.equal((await second.natappAction('start')).natapp?.state, 'running');
  assert.equal((await second.stopInternal(true)).state, 'stopped');
  const originalForPort = fs.readFileSync(recordPath, 'utf8');
  const forgedForPort = JSON.parse(originalForPort); forgedForPort.creation = '134000000000000000';
  let nextPort = await freePort(); while (nextPort === port) nextPort = await freePort();
  const store = { port, localPort() { return this.port; }, setLocalPort(value) { this.port = value; } };
  fs.writeFileSync(recordPath, JSON.stringify(forgedForPort));
  try {
    await assert.rejects(second.changePort(nextPort, store), /NATAPP/);
    assert.equal(store.localPort(), port, 'unconfirmed NATAPP must block a port change');
    assert.equal(await countNatappProcesses(native), 1, 'unknown tunnel must remain untouched');
  } finally { fs.writeFileSync(recordPath, originalForPort); }
  const changed = await second.changePort(nextPort, store);
  assert.equal(changed.port, nextPort);
  assert.equal(changed.natapp?.state, 'stopped', 'port change must report the retained NATAPP stopped');
  assert.equal(store.localPort(), nextPort);
  assert.equal(await countNatappProcesses(native), 0, 'port change without a controller must stop the owned tunnel');
  console.log('PASS NATAPP controller: protected owner gate, private start/stop, reattach, retained-tunnel recovery, unknown-process protection, safe port changes and owned tunnel stop order');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (second) { await second.stop().catch(() => {}); second.close(); }
  if (first) { await first.stop().catch(() => {}); first.close(); }
  if (fs.existsSync(path.join(dataDir, 'controller.instance.json')) || fs.existsSync(path.join(dataDir, 'gateway.instance.lock')) || fs.existsSync(path.join(dataDir, 'natapp.instance.json'))) {
    console.error('Fixture instance unconfirmed; retained:', temp); process.exitCode = 1; return;
  }
  const actual = fs.realpathSync(temp), base = fs.realpathSync(os.tmpdir());
  if (path.dirname(actual).toLowerCase() !== base.toLowerCase() || !path.basename(actual).startsWith('hajimink-natapp-controller-')) throw new Error('Unexpected fixture');
  fs.rmSync(actual, { recursive: true, force: true });
});
