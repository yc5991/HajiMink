'use strict';
const { selectDesktopPage } = require('./desktop-page-menu.cjs');
// Check old-to-new startup using a disposable profile, without touching the user's gateway.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { ConnectionStore } = require('../desktop/connections.cjs');
const { ControllerGatewayManager } = require('../desktop/controller-manager.cjs');
const { waitForShellState } = require('./wait-shell-state.cjs');
const root = path.resolve(__dirname, '..');
const previous = process.env.HAJIMINK_PREVIOUS_BINARY;
const next = process.env.HAJIMINK_DESKTOP_BINARY;
if (!previous || !next) throw new Error('请提供旧版和新版的桌面程序路径');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-upgrade-'));
let application, port;
const gatewayData = path.join(temp, 'gateway');
const oldRoot = path.join(path.dirname(previous), 'resources', 'gateway');
const newRoot = path.join(path.dirname(next), 'resources', 'gateway');
const { freePort } = require('./test-network.cjs');
async function launch(binary, port) {
  application = await electron.launch({ executablePath: binary, args: [`--hajimink-data-dir=${temp}`, `--hajimink-gateway-port=${port}`], cwd: root, timeout: 60000 });
  const page = await application.firstWindow();
  await page.waitForFunction(async () => !!(await window.hajimink.state()).selected);
  const state = await page.evaluate(() => window.hajimink.state());
  return { page, state };
}
async function closeDesktopKeepingGateway() {
  const current = application, child = current.process();
  const exited = new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  // Simulate an interrupted desktop process; normal user exit now stops managed services.
  await current.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); });
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('桌面退出超时')), 12000))]);
  application = undefined;
  void current.close().catch(() => {});
}
(async () => {
  port = await freePort(); let unused; do { unused = await freePort(); } while (unused === port);
  assert.notEqual(path.resolve(oldRoot).toLowerCase(), path.resolve(newRoot).toLowerCase(), 'the upgrade test needs different build paths');
  const store = new ConnectionStore(temp, 'win32', port);
  store.completeSetup(); store.setGatewayManuallyStopped(true);
  store.add({ name: '资料迁移测试', url: `http://127.0.0.1:${unused}` });
  const original = store.snapshot();
  const old = await launch(previous, port);
  assert.deepEqual(old.state.connections, original.connections);
  assert.equal(old.state.selected, original.selected);
  assert.equal(old.state.setup.gatewayManuallyStopped, true);
  await application.close(); application = undefined;
  const updated = await launch(next, port);
  assert.deepEqual(updated.state.connections, original.connections);
  assert.equal(updated.state.selected, original.selected);
  assert.equal(updated.state.setup.gatewayManuallyStopped, true);
  assert.equal(updated.state.gateway.port, port);
  assert.notEqual(updated.state.gateway.state, 'ready');
  await selectDesktopPage(updated.page, 'gateway');
  await updated.page.locator('#gateway').waitFor({ state: 'visible' });
  assert.equal(await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false), false);
  await application.close(); application = undefined;

  // Leave a real old-version controller running, then open the new version.
  new ConnectionStore(temp, 'win32', port).setGatewayManuallyStopped(false);
  const runningOld = await launch(previous, port);
  const oldGateway = (await waitForShellState(runningOld.page, value => value.gateway.state === 'ready', { timeoutMs: 60000 })).gateway;
  const recordPath = path.join(gatewayData, 'controller.instance.json');
  const originalRecord = fs.readFileSync(recordPath);
  const record = JSON.parse(originalRecord);
  assert.ok(oldGateway.managed && oldGateway.pid && record.controllerPid && record.controllerCreation, 'old gateway must be fully initialized');
  assert.equal(path.resolve(record.entryPath).toLowerCase(), path.join(oldRoot, 'dist-server', 'index.js').toLowerCase());
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
  await closeDesktopKeepingGateway(runningOld.page);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);

  const runningNew = await launch(next, port);
  await waitForShellState(runningNew.page, value => value.gateway.state === 'error', { timeoutMs: 60000 });
  assert.match((await runningNew.page.evaluate(() => window.hajimink.state())).gateway.message, /旧版后台网关/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200, 'opening the new build must not stop the old gateway');
  assert.equal(JSON.parse(fs.readFileSync(recordPath)).controllerPid, record.controllerPid);

  try {
    const forged = { ...record, controllerCreation: String(BigInt(record.controllerCreation) + 1n) };
    fs.writeFileSync(recordPath, JSON.stringify(forged));
    const refused = await runningNew.page.evaluate(() => window.hajimink.gatewayStop());
    assert.equal(refused.gateway.state, 'error');
    assert.match(refused.gateway.message, /无法确认旧版后台身份/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200, 'a forged process identity must not stop the gateway');

    const changedRoot = path.join(temp, 'changed-installation');
    fs.mkdirSync(path.join(changedRoot, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(changedRoot, 'controller'), { recursive: true });
    fs.copyFileSync(path.join(oldRoot, 'runtime', 'node.exe'), path.join(changedRoot, 'runtime', 'node.exe'));
    for (const file of ['gateway-controller.cjs', 'gateway-manager.cjs', 'native-helper.cjs', 'desktop-status.cjs', 'natapp-manager.cjs']) fs.copyFileSync(path.join(oldRoot, 'controller', file), path.join(changedRoot, 'controller', file));
    fs.appendFileSync(path.join(changedRoot, 'controller', 'gateway-controller.cjs'), '\n// modified test fixture\n');
    fs.writeFileSync(recordPath, JSON.stringify({ ...record, entryPath: path.join(changedRoot, 'dist-server', 'index.js'), nodePath: path.join(changedRoot, 'runtime', 'node.exe'), controllerPath: path.join(changedRoot, 'controller', 'gateway-controller.cjs') }));
    const changed = await runningNew.page.evaluate(() => window.hajimink.gatewayStop());
    assert.equal(changed.gateway.state, 'error');
    assert.match(changed.gateway.message, /无法确认旧版后台身份/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200, 'different controller files must not be trusted');
  } finally { fs.writeFileSync(recordPath, originalRecord); }

  const stopped = await runningNew.page.evaluate(() => window.hajimink.gatewayStop());
  assert.equal(stopped.gateway.state, 'stopped');
  const result = await runningNew.page.evaluate(() => window.hajimink.quit());
  assert.equal(result.outcome, 'quitting');
  await application.close(); application = undefined;
  assert.equal(fs.existsSync(recordPath), false);
  assert.equal(await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false), false);
  assert.equal(new ConnectionStore(temp, 'win32', port).snapshot().setup.gatewayManuallyStopped, true);

  const restarted = await launch(next, port);
  assert.notEqual(restarted.state.gateway.state, 'ready');
  const newGateway = await restarted.page.evaluate(() => window.hajimink.gatewayStart());
  assert.equal(newGateway.gateway.state, 'ready', JSON.stringify(newGateway.gateway));
  assert.notEqual(newGateway.gateway.pid, oldGateway.pid);
  assert.equal(path.resolve(JSON.parse(fs.readFileSync(recordPath)).entryPath).toLowerCase(), path.join(newRoot, 'dist-server', 'index.js').toLowerCase());
  assert.equal((await restarted.page.evaluate(() => window.hajimink.gatewayStop())).gateway.state, 'stopped');
  console.log('PASS upgrade: profile preserved; old gateway remains until verified manual stop; mismatched identity and controller files are rejected; exit and new-version startup succeed (disposable profile)');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (application) await application.close().catch(() => {});
  if (port && fs.existsSync(path.join(gatewayData, 'controller.instance.json'))) {
    const record = JSON.parse(fs.readFileSync(path.join(gatewayData, 'controller.instance.json'), 'utf8'));
    const currentRoot = [oldRoot, newRoot].find(dir => path.resolve(record.entryPath).toLowerCase() === path.join(dir, 'dist-server', 'index.js').toLowerCase());
    if (currentRoot) {
      const manager = new ControllerGatewayManager({ appRoot: currentRoot, dataDir: gatewayData, port, nodePath: path.join(currentRoot, 'runtime', 'node.exe'), runAsNode: false });
      try { await manager.stop(); } finally { manager.close(); }
    }
  }
  if (fs.existsSync(path.join(gatewayData, 'controller.instance.json')) || fs.existsSync(path.join(gatewayData, 'gateway.instance.lock'))) {
    console.error('测试后台未确认停止，保留隔离资料：', temp); process.exitCode = 1; return;
  }
  const actual = fs.realpathSync(temp), parent = fs.realpathSync(os.tmpdir());
  if (path.dirname(actual).toLowerCase() !== parent.toLowerCase() || !path.basename(actual).startsWith('hajimink-upgrade-')) throw new Error('Unexpected test directory');
  fs.rmSync(actual, { recursive: true, force: true });
});
