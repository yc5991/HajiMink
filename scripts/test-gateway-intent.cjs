'use strict';
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { ControllerGatewayManager } = require('../desktop/controller-manager.cjs');
function makeStore({ stopped = false, complete = true } = {}) {
  return { state: { setup: { complete, gatewayManuallyStopped: stopped } }, fail: false, history: [], snapshot() { return structuredClone(this.state); }, setGatewayManuallyStopped(value) { this.history.push(value); if (this.fail) throw new Error('disk failure'); this.state.setup.gatewayManuallyStopped = value; } };
}
function makeManager() {
  const manager = new ControllerGatewayManager({ appRoot: path.resolve(__dirname, '..'), dataDir: path.join(os.tmpdir(), 'hajimink-intent-unit-never-created'), port: 31415, platform: 'win32' });
  manager.startCalls = 0; manager.stopCalls = 0;
  manager.startInternal = async () => { manager.startCalls++; return { state: 'ready', managed: true, pid: 123, message: 'ready' }; };
  manager.stopInternal = async () => { manager.stopCalls++; return { state: 'stopped', managed: false, message: 'stopped' }; };
  manager.readRecord = async () => null; manager.hasFile = async () => false;
  return manager;
}
(async () => {
  const manager = makeManager(); const store = makeStore({ stopped: true });
  assert.equal((await manager.startAccordingToPolicy(store)).state, 'stopped');
  assert.equal((await manager.startForSelection(store)).state, 'stopped');
  await assert.rejects(manager.startForAccount(store), /手动停止/);
  assert.equal(manager.startCalls, 0, 'implicit entry points must not launch a manually stopped gateway');
  manager.readRecord = async () => ({ instanceId: 'fixture' });
  manager.connectExisting = async () => ({ state: 'ready', managed: true, pid: 456 });
  assert.equal((await manager.startAccordingToPolicy(store)).pid, 456, 'a verified running controller should still be attached');
  assert.equal((await manager.startForAccount(store)).pid, 456);
  assert.equal(manager.startCalls, 0);
  manager.readRecord = async () => { throw new Error('record unavailable'); };
  assert.equal((await manager.startAccordingToPolicy(store)).state, 'error', 'unreadable record must not start a replacement');
  assert.equal(manager.startCalls, 0);
  manager.readRecord = async () => null; manager.hasFile = async () => true;
  assert.equal((await manager.startAccordingToPolicy(store)).state, 'error', 'orphan lock must not start a replacement');
  manager.hasFile = async () => false;
  assert.equal((await manager.startByUser(store)).state, 'ready');
  assert.equal(store.snapshot().setup.gatewayManuallyStopped, false);
  assert.equal((await manager.stopByUser(store)).state, 'stopped');
  assert.equal(store.snapshot().setup.gatewayManuallyStopped, true);

  // Queue lifecycle and preference writes together: the last explicit action wins.
  const beginStart = manager.startByUser(store), thenStop = manager.stopByUser(store);
  await Promise.all([beginStart, thenStop]); assert.equal(store.snapshot().setup.gatewayManuallyStopped, true);
  const beginStop = manager.stopByUser(store), thenStart = manager.startByUser(store);
  await Promise.all([beginStop, thenStart]); assert.equal(store.snapshot().setup.gatewayManuallyStopped, false);

  store.state.setup.gatewayManuallyStopped = true; store.fail = true;
  const startsBefore = manager.startCalls;
  const startedWithoutSave = await manager.startByUser(store);
  assert.equal(startedWithoutSave.state, 'ready'); assert.equal(startedWithoutSave.preferenceError, true);
  assert.match(startedWithoutSave.message, /网关已启动.*无法保存/); assert.equal(manager.startCalls, startsBefore + 1);
  assert.equal(store.snapshot().setup.gatewayManuallyStopped, true, 'failed save must preserve the previous safe preference');
  store.state.setup.gatewayManuallyStopped = false;
  const stopsBefore = manager.stopCalls;
  const stoppedWithoutSave = await manager.stopByUser(store);
  assert.equal(stoppedWithoutSave.state, 'error'); assert.equal(stoppedWithoutSave.preferenceError, true);
  assert.match(stoppedWithoutSave.message, /网关已停止.*可能自动启动/);
  assert.equal(manager.stopCalls, stopsBefore + 1, 'a preference failure must not prevent an immediate stop attempt');
  store.fail = false; store.state.setup.gatewayManuallyStopped = true;
  manager.startInternal = async () => ({ state: 'error', managed: false, message: 'fixture failure' });
  assert.equal((await manager.startByUser(store)).state, 'error');
  assert.equal(store.snapshot().setup.gatewayManuallyStopped, true, 'failed start must not clear manual stop');
  manager.stopInternal = async () => ({ state: 'error', managed: false });
  assert.equal((await manager.restartByUser(store)).state, 'error');
  assert.equal(store.snapshot().setup.gatewayManuallyStopped, true);

  const fresh = makeManager(), freshStore = makeStore({ complete: false });
  assert.equal((await fresh.startAccordingToPolicy(freshStore)).state, 'stopped'); assert.equal(fresh.startCalls, 0);
  freshStore.state.setup.complete = true;
  assert.equal((await fresh.startAccordingToPolicy(freshStore)).state, 'ready'); assert.equal(fresh.startCalls, 1);
  manager.close(); fresh.close();
  console.log('PASS gateway intent: manual-stop persistence, implicit-start blocking, safe reattach, serialized user actions and save-failure handling');
})().catch(error => { console.error(error); process.exitCode = 1; });
