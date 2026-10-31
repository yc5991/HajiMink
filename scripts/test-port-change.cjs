'use strict';
// Real controller tests use only test-owned processes, temporary directories and random loopback ports.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { ConnectionStore } = require('../desktop/connections.cjs');
const { ControllerGatewayManager } = require('../desktop/controller-manager.cjs');
const root = path.resolve(__dirname, '..');
const stage = path.join(root, '.local', 'hajimink-stage');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-port-live-'));
const managers = [], servers = [], dirs = [];
const { freePort } = require('./test-network.cjs');
async function distinctPort(...used) { let result; do { result = await freePort(); } while (used.includes(result)); return result; }
async function listen(port = 0) {
  const server = net.createServer(); await new Promise(resolve => server.listen(port, '127.0.0.1', resolve)); servers.push(server); return server;
}
async function responds(port) { try { return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }
function fixture(name, port) {
  const userData = path.join(temp, name); fs.mkdirSync(userData); dirs.push(userData);
  const store = new ConnectionStore(userData, 'win32', port);
  const manager = new ControllerGatewayManager({ appRoot: stage, dataDir: path.join(userData, 'gateway'), port, nodePath: process.execPath, runAsNode: false, startTimeoutMs: 15000 }); managers.push(manager);
  return { userData, store, manager };
}
(async () => {
  if (!fs.existsSync(path.join(stage, 'controller', 'PrivateControlPipe.exe'))) throw new Error('Build the isolated desktop fixture first');
  const old = await freePort(), desired = await distinctPort(old), f = fixture('正常切换', old);
  const [started, changed] = await Promise.all([f.manager.start(), f.manager.changePort(desired, f.store)]);
  assert.equal(started.state, 'ready'); assert.equal(changed.state, 'ready'); assert.equal(changed.port, desired);
  assert.equal(await responds(old), false); assert.equal(await responds(desired), true);
  assert.equal(f.store.localPort(), desired);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.userData, 'gateway', 'config.json'), 'utf8')).port, desired);
  const resumed = new ControllerGatewayManager({ appRoot: stage, dataDir: path.join(f.userData, 'gateway'), port: new ConnectionStore(f.userData, 'win32', old).localPort(), nodePath: process.execPath, runAsNode: false }); managers.push(resumed);
  const reattached = await resumed.start(); assert.equal(reattached.pid, changed.pid); assert.equal(reattached.port, desired);
  const occupied = await listen(); const busy = occupied.address().port;
  await assert.rejects(f.manager.changePort(busy, f.store), /已被其他程序占用/);
  assert.equal((await resumed.start()).pid, changed.pid); assert.equal(await responds(desired), true);
  assert.equal(occupied.listening, true, 'foreign target listener must stay alive');
  const raced = await distinctPort(old, desired, busy); let injected;
  const startOriginal = f.manager.startInternal.bind(f.manager);
  f.manager.startInternal = async () => {
    if (f.manager.port === raced && !injected) injected = await listen(raced);
    return startOriginal();
  };
  await assert.rejects(f.manager.changePort(raced, f.store), /已恢复原端口和网关/);
  assert.equal(f.store.localPort(), desired); assert.equal(f.manager.port, desired);
  assert.equal(await responds(desired), true); assert.equal(injected.listening, true, 'new foreign listener must remain alive');
  const newOld = await listen(); const foreignPort = newOld.address().port;
  const otherPort = await distinctPort(foreignPort, desired, raced); const g = fixture('被占用的旧端口', foreignPort);
  assert.equal((await g.manager.start()).state, 'error');
  const saved = await g.manager.changePort(otherPort, g.store); assert.equal(saved.state, 'stopped');
  assert.equal(newOld.listening, true, 'unknown original listener must remain alive');
  assert.equal((await g.manager.start()).state, 'ready'); assert.equal(await responds(otherPort), true);
  assert.equal((await g.manager.stop()).state, 'stopped');
  assert.equal((await f.manager.stop()).state, 'stopped');
  console.log(JSON.stringify({ realControllerPortChange: 'passed', serialStartAndChange: 'passed', authenticatedReattach: 'passed', occupiedPortPreservesProcess: 'passed', raceRollback: 'passed', oldUnknownPortPreserved: 'passed', configurationPersistence: 'passed' }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  let unsafe = false;
  for (const manager of managers) { try { await manager.stop(); } catch {} manager.close(); }
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  for (const dir of dirs) if (fs.existsSync(path.join(dir, 'gateway', 'controller.instance.json')) || fs.existsSync(path.join(dir, 'gateway', 'gateway.instance.lock'))) unsafe = true;
  if (unsafe) { console.error('Unconfirmed test instance; retaining fixture:', temp); process.exitCode = 1; return; }
  const resolved = fs.realpathSync(temp), safeRoot = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved).toLowerCase() !== safeRoot.toLowerCase() || !path.basename(resolved).startsWith('hajimink-port-live-')) throw new Error('Unexpected test directory');
  fs.rmSync(resolved, { recursive: true, force: true });
});
