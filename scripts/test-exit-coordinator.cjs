'use strict';
const assert = require('node:assert/strict');
const { ExitCoordinator, buildTrayTemplate } = require('../desktop/exit-coordinator.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  let confirms = 0, stops = 0, quits = 0, releaseConfirm, releaseStop;
  const events = [];
  const coordinator = new ExitCoordinator({
    inspect: async () => ({ gateway: { instanceId: 'fixture' }, natapp: null }),
    confirm: () => { confirms++; return new Promise(resolve => { releaseConfirm = resolve; }); },
    stop: () => { stops++; return new Promise(resolve => { releaseStop = resolve; }); },
    quit: () => { quits++; }, notify: status => events.push(status.phase)
  });
  const canceled = coordinator.request(), duplicate = coordinator.request();
  assert.strictEqual(canceled, duplicate); assert.equal(coordinator.busy, true);
  await tick(); assert.equal(confirms, 1); releaseConfirm(false);
  assert.equal((await canceled).outcome, 'canceled'); assert.equal(stops, 0); assert.equal(quits, 0);
  const failed = coordinator.request(); await tick(); releaseConfirm(true); await tick();
  assert.equal(coordinator.snapshot().phase, 'stopping');
  releaseStop({ state: 'error', message: '无法确认 NATAPP 已停止' });
  assert.equal((await failed).outcome, 'failed'); assert.equal(quits, 0); assert.match(coordinator.snapshot().message, /NATAPP/);
  const success = coordinator.request(); await tick(); releaseConfirm(true); await tick();
  assert.strictEqual(coordinator.request(), success); releaseStop({ state: 'stopped' });
  assert.equal((await success).outcome, 'quitting'); assert.equal(quits, 1);
  assert.equal((await coordinator.request()).outcome, 'quitting');
  assert.deepEqual(events, ['inspecting', 'confirming', 'idle', 'inspecting', 'confirming', 'stopping', 'failed', 'inspecting', 'confirming', 'stopping', 'quitting']);

  let noServiceConfirm = 0, noServiceQuit = 0;
  const empty = new ExitCoordinator({ inspect: async () => ({ gateway: null, natapp: null }), confirm: async () => { noServiceConfirm++; return false; }, stop: async () => ({ state: 'stopped' }), quit: () => { noServiceQuit++; } });
  assert.equal((await empty.request()).outcome, 'quitting'); assert.equal(noServiceConfirm, 0); assert.equal(noServiceQuit, 1);
  const unconfirmed = new ExitCoordinator({ inspect: async () => ({ error: '无法确认 NATAPP 进程身份' }), confirm: async () => { throw Error('unexpected'); }, stop: async () => { throw Error('unexpected'); }, quit: () => { throw Error('unexpected'); } });
  assert.equal((await unconfirmed.request()).outcome, 'failed'); assert.match(unconfirmed.snapshot().message, /NATAPP/);
  const thrown = new ExitCoordinator({ inspect: async () => { throw Error('sensitive fixture'); }, confirm: async () => true, stop: async () => ({ state: 'stopped' }), quit: () => {} });
  assert.equal((await thrown.request()).outcome, 'failed'); assert.doesNotMatch(thrown.snapshot().message, /sensitive/);
  const called = [];
  const menu = buildTrayTemplate({ busy: false, showWindow: () => called.push('show'), requestExit: () => called.push('exit') });
  assert.deepEqual(menu.map(item => item.label).filter(Boolean), ['打开工作台', '退出软件']);
  menu[0].click(); menu[2].click(); assert.deepEqual(called, ['show', 'exit']);
  assert.equal(buildTrayTemplate({ busy: true })[2].enabled, false);
  console.log('PASS exit coordinator: cancellation, no-service direct exit, identity errors, failed stop, coalescing and tray');
})().catch(error => { console.error(error); process.exitCode = 1; });
