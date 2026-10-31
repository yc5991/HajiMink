'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConnectionStore } = require('../desktop/connections.cjs');
const { ControllerGatewayManager } = require('../desktop/controller-manager.cjs');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-exit-recovery-'));
const data = path.join(temp, 'profile'), gatewayDir = path.join(data, 'gateway');
const binaryPath = path.join(temp, 'natapp.exe'), configPath = path.join(temp, 'fixture.ini');
const tunnelRecord = { instanceId: 'tunnel-fixture', processId: 42, creation: '123456789012345', binaryPath, configPath };
let gatewayRunning = true, tunnelRunning = true, invalid = false, stopCalls = 0, tunnelStarts = 0, partial = false;
const manager = new ControllerGatewayManager({ appRoot: path.resolve(__dirname, '..'), dataDir: gatewayDir, port: 31415, platform: 'win32' });
const store = new ConnectionStore(data, 'win32', 31415);
manager.readRecord = async () => gatewayRunning ? { instanceId: 'gateway-fixture', controllerPid: 22, controllerCreation: '123456789012345' } : null;
manager.hasFile = async () => false;
manager.attach = async () => ({ state: 'ready', managed: true, pid: 23, mode: 'owner' });
manager.natappObserver = {
  refresh: async () => invalid ? { state: 'unconfirmed', managed: false } : tunnelRunning ? { state: 'running', managed: true, pid: 42 } : { state: 'stopped', managed: false },
  readRecord: async () => tunnelRunning ? tunnelRecord : null,
  stop: async () => { tunnelRunning = false; return { state: 'stopped', managed: false }; }
};
manager.stopInternal = async () => { stopCalls++; tunnelRunning = false; if (partial) return { state: 'error', message: 'fixture stop failure' }; gatewayRunning = false; return { state: 'stopped' }; };
manager.startInternal = async () => { gatewayRunning = true; manager.emitState({ state: 'ready', managed: true, pid: 23, controllerPid: 22, mode: 'owner', natapp: { state: tunnelRunning ? 'running' : 'stopped', managed: tunnelRunning, pid: tunnelRunning ? 42 : null } }); return manager.snapshot(); };
manager.natappActionInternal = async action => { if (action === 'start') { tunnelStarts++; tunnelRunning = true; } else tunnelRunning = false; manager.emitState({ natapp: { state: tunnelRunning ? 'running' : 'stopped', managed: tunnelRunning, pid: tunnelRunning ? 42 : null } }); return manager.snapshot(); };

(async () => {
  fs.mkdirSync(gatewayDir, { recursive: true });
  fs.writeFileSync(path.join(gatewayDir, 'natapp-settings.json'), JSON.stringify({ version: 1, binaryPath, configPath }));
  store.setTunnelProvider('natapp');
  const expected = await manager.inspectForExit();
  assert.ok(expected.gateway && expected.natapp);
  const save = store.save; store.save = () => { throw Error('fixture disk error'); };
  assert.match((await manager.stopForExit(store, expected)).message, /无法保存/);
  assert.equal(stopCalls, 0); assert.equal(gatewayRunning, true); assert.equal(tunnelRunning, true); assert.equal(store.snapshot().exitResume, null);
  store.save = save;
  const changed = structuredClone(expected); changed.gateway.controllerPid++;
  assert.match((await manager.stopForExit(store, changed)).message, /状态.*变化/); assert.equal(stopCalls, 0);
  invalid = true; assert.match((await manager.inspectForExit()).error, /NATAPP/); invalid = false;
  partial = true;
  assert.equal((await manager.stopForExit(store, expected)).state, 'error');
  assert.equal(store.snapshot().exitResume.phase, 'pending'); assert.equal(store.snapshot().exitResume.natapp.configPath, configPath);
  assert.equal(gatewayRunning, true); assert.equal(tunnelRunning, false);
  partial = false;
  assert.equal((await manager.stopForExit(store, await manager.inspectForExit())).state, 'stopped');
  assert.equal(store.snapshot().exitResume.phase, 'complete'); assert.ok(store.snapshot().exitResume.natapp, 'retry must retain partially stopped tunnel');
  const persisted = new ConnectionStore(data, 'win32', 31415);
  assert.equal(persisted.snapshot().exitResume.gateway, true);
  await manager.startAccordingToPolicy(persisted);
  assert.equal(gatewayRunning, true); assert.equal(tunnelRunning, true); assert.equal(tunnelStarts, 1);
  gatewayRunning = false; tunnelRunning = false;
  fs.writeFileSync(path.join(gatewayDir, 'natapp-settings.json'), JSON.stringify({ version: 1, binaryPath, configPath: path.join(temp, 'changed.ini') }));
  const changedConfig = await manager.startAccordingToPolicy(persisted);
  assert.match(changedConfig.resumeError, /原文件配置已变化/); assert.equal(tunnelStarts, 1);
  fs.writeFileSync(path.join(gatewayDir, 'natapp-settings.json'), JSON.stringify({ version: 1, binaryPath, configPath }));
  const originalStart = manager.startInternal;
  manager.startInternal = async () => { const ready = await originalStart(); manager.emitState({ mode: 'local' }); return { ...ready, mode: 'local' }; };
  const unprotected = await manager.startAccordingToPolicy(persisted);
  assert.match(unprotected.resumeError, /尚未启用登录保护/); assert.equal(tunnelStarts, 1);
  manager.startInternal = originalStart;
  await manager.startAccordingToPolicy(persisted); assert.equal(tunnelStarts, 2);
  await manager.natappAction('stop', persisted);
  assert.equal(persisted.snapshot().exitResume.natapp, null);
  assert.equal((await manager.stopForExit(persisted, await manager.inspectForExit())).state, 'stopped');
  await manager.startAccordingToPolicy(new ConnectionStore(data, 'win32', 31415));
  assert.equal(gatewayRunning, true); assert.equal(tunnelStarts, 2, 'manually stopped NATAPP stays stopped');

  persisted.setExitResume({ version: 1, phase: 'complete', gateway: true, natapp: { binaryPath, configPath } });
  persisted.setTunnelProvider('tailscale');
  assert.equal(persisted.snapshot().exitResume.natapp, null, 'changing provider clears tunnel recovery');
  persisted.setGatewayManuallyStopped(true); gatewayRunning = false;
  assert.equal(persisted.snapshot().exitResume, null);
  assert.equal((await manager.startAccordingToPolicy(persisted)).state, 'stopped');
  assert.equal(gatewayRunning, false, 'manually stopped gateway stays stopped');
  persisted.setExitResume({ version: 1, phase: 'complete', gateway: false, natapp: null });
  persisted.setGatewayManuallyStopped(false);
  persisted.setExitResume({ version: 1, phase: 'complete', gateway: false, natapp: null });
  await manager.startForSelection(persisted); assert.equal(gatewayRunning, false, 'a stopped gateway is not started by selecting it');
  const old = persisted.snapshot(); delete old.exitResume; fs.writeFileSync(persisted.file, JSON.stringify(old));
  assert.equal(new ConnectionStore(data, 'win32', 31415).snapshot().exitResume, null, 'old profiles remain readable');
  console.log('PASS exit recovery: save failure, identity changes, partial stop, recovery, manual stops, provider changes and old profiles');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  manager.close();
  const resolved = fs.realpathSync(temp), base = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved).toLowerCase() !== base.toLowerCase() || !path.basename(resolved).startsWith('hajimink-exit-recovery-')) throw Error('Unexpected fixture path');
  fs.rmSync(resolved, { recursive: true, force: true });
});
