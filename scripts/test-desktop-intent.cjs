'use strict';
const { selectDesktopPage, selectDesktopConnection, setGatewayEnabled } = require('./desktop-page-menu.cjs');
// Only disposable profiles, ports and a local fixture server are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { _electron: electron } = require('playwright');
const { ControllerGatewayManager } = require('../desktop/controller-manager.cjs');
const { waitForShellState } = require('./wait-shell-state.cjs');
if (process.platform !== 'win32') throw new Error('Windows required');
const root = path.resolve(__dirname, '..'), stage = path.join(root, '.local', 'hajimink-stage');
const binary = process.env.HAJIMINK_DESKTOP_BINARY || require('electron'), packaged = !!process.env.HAJIMINK_DESKTOP_BINARY;
const appRoot = packaged ? path.join(path.dirname(binary), 'resources', 'gateway') : stage;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-intent-ui-'));
const data = path.join(temp, '测试 资料'), connections = path.join(data, 'connections.json'), backup = path.join(data, 'connections.fixture-backup.json');
let application, page, port, cleanup, remote, replacedConnections = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { freePort } = require('./test-network.cjs');
async function launch() { application = await electron.launch({ executablePath: binary, args: [...(packaged ? [] : ['.']), `--hajimink-data-dir=${data}`, `--hajimink-gateway-port=${port}`], cwd: root, timeout: 60000 }); page = await application.firstWindow(); }
async function health() { try { return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(900) })).ok; } catch { return false; } }
async function exitDesktop() {
  const current = application, proc = current.process();
  const exited = new Promise(resolve => { if (proc.exitCode !== null || proc.signalCode !== null) resolve(proc.exitCode); else proc.once('exit', resolve); });
  await current.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); });
  let timer; const code = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test desktop exit timed out')), 15000); })]).finally(() => clearTimeout(timer));
  assert.equal(code, 0); application = undefined; page = undefined; void current.close().catch(() => {});
}
async function waitStopped() { return waitForShellState(page, value => value.gateway?.state === 'stopped' && value.setup?.gatewayManuallyStopped === true, { timeoutMs: 30000 }); }
async function waitReady() { return waitForShellState(page, value => value.gateway?.state === 'ready' && value.gateway.managed, { timeoutMs: 45000 }); }
(async () => {
  port = await freePort();
  cleanup = new ControllerGatewayManager({ appRoot, dataDir: path.join(data, 'gateway'), port, nodePath: packaged ? path.join(appRoot, 'runtime', 'node.exe') : binary, runAsNode: !packaged, startTimeoutMs: 15000 });
  await launch(); await selectDesktopPage(page, 'gateway');
  await setGatewayEnabled(page, true); const initial = await waitReady();
  await waitForShellState(page, value => value.setup?.complete === true);
  assert.equal((await page.evaluate(() => window.hajimink.state())).setup.gatewayManuallyStopped, false);
  await exitDesktop(); assert.equal(await health(), true, 'desktop-only exit must keep the gateway running');

  // Model an earlier stop request that could not be confirmed: the saved
  // preference says stopped but its verified controller is still running.
  const fixtureState = JSON.parse(fs.readFileSync(connections, 'utf8')); fixtureState.setup.gatewayManuallyStopped = true;
  fs.writeFileSync(connections, JSON.stringify(fixtureState));
  await launch(); await selectDesktopPage(page, 'gateway');
  const reattached = await waitReady();
  assert.equal(reattached.gateway.pid, initial.gateway.pid, 'a still-running owned gateway must be reattached, not replaced');
  assert.equal(reattached.setup.gatewayManuallyStopped, true);
  assert.match(await page.locator('#gateway-manual-stop-note').textContent(), /仍在运行/);
  page.once('dialog', dialog => dialog.accept()); await setGatewayEnabled(page, false); await waitStopped();
  assert.equal(await health(), false);
  assert.equal(JSON.parse(fs.readFileSync(connections, 'utf8')).setup.gatewayManuallyStopped, true);
  await exitDesktop();

  await launch(); await selectDesktopPage(page, 'gateway'); await waitStopped();
  await delay(1500); assert.equal(await health(), false, 'reopening after a manual stop must not start a gateway');
  assert.equal(fs.existsSync(path.join(data, 'gateway', 'controller.instance.json')), false);
  assert.match(await page.locator('#gateway-manual-stop-note').textContent(), /不会自动启动/);
  assert.equal(await page.locator('#gateway-process').textContent(), '未接管');
  await selectDesktopPage(page, 'logs');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(820, 600));
  await page.locator('#gateway-manual-stop-note').scrollIntoViewIfNeeded();
  const layout = await page.locator('#gateway-manual-stop-note').evaluate(note => {
    const card = note.closest('.diagnostic-row'), details = card.querySelector('dl');
    const noteBox = note.getBoundingClientRect(), cardBox = card.getBoundingClientRect(), detailsBox = details.getBoundingClientRect();
    return { fitsWidth: note.scrollWidth <= note.clientWidth + 1, insideCard: noteBox.left >= cardBox.left && noteBox.right <= cardBox.right && noteBox.bottom <= cardBox.bottom, beforeDetails: noteBox.bottom <= detailsBox.top };
  });
  assert.deepEqual(layout, { fitsWidth: true, insideCard: true, beforeDetails: true }, 'manual-stop note must fit without overlapping gateway details');
  const artifacts = path.join(stage, 'smoke-artifacts'); fs.mkdirSync(artifacts, { recursive: true });
  await page.emulateMedia({ colorScheme: 'light' }); await page.screenshot({ path: path.join(artifacts, 'manual-stop-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: path.join(artifacts, 'manual-stop-dark.png') });
  await page.emulateMedia({ colorScheme: 'no-preference' });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 850));
  await selectDesktopPage(page, 'gateway');
  assert.equal(await page.locator('#gateway-account').isDisabled(), true);
  const account = await page.evaluate(async () => { try { await window.hajimink.gatewayAccount(); return 'unexpected'; } catch (error) { return String(error.message); } });
  assert.match(account, /手动停止/); assert.equal(await health(), false);

  remote = http.createServer((_req, res) => res.end('<!doctype html><title>remote fixture</title>'));
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  await selectDesktopPage(page, 'settings'); await page.click('#add');
  await page.fill('#name', '隔离远程连接'); await page.fill('#url', `http://127.0.0.1:${remote.address().port}`); await page.click('#connection-form button[type=submit]');
  await waitForShellState(page, value => value.connections.find(item => item.id === value.selected)?.name === '隔离远程连接');
  const localId = (await page.evaluate(() => window.hajimink.state())).connections.find(item => item.local).id;
  await selectDesktopConnection(page, localId);
  await waitForShellState(page, value => value.selected === localId && value.gateway?.state === 'stopped');
  await delay(500); assert.equal(await health(), false, 'selecting the local connection must not restart a manually stopped gateway');
  await selectDesktopPage(page, 'gateway'); await setGatewayEnabled(page, true);
  const restarted = await waitReady(); assert.equal(restarted.setup.gatewayManuallyStopped, false);
  assert.equal(JSON.parse(fs.readFileSync(connections, 'utf8')).setup.gatewayManuallyStopped, false);

  // A storage failure must still stop the gateway, but it must warn that the
  // stop preference could not be saved. This changes only the fixture profile.
  fs.renameSync(connections, backup); fs.mkdirSync(connections); replacedConnections = true;
  try {
    page.once('dialog', dialog => dialog.accept()); await setGatewayEnabled(page, false);
    await page.locator('#toast').getByText(/网关已停止，但无法保存停止状态/).waitFor({ timeout: 30000 });
    await waitForShellState(page, value => value.gateway?.state === 'stopped', { timeoutMs: 30000 });
    assert.equal(await health(), false, 'save failure must not prevent immediate gateway stop');
    assert.equal((await page.evaluate(() => window.hajimink.state())).setup.gatewayManuallyStopped, false);
  } finally {
    fs.rmdirSync(connections); fs.renameSync(backup, connections); replacedConnections = false;
  }
  await selectDesktopPage(page, 'logs'); await page.locator('#gateway-keep-stopped').waitFor();
  page.once('dialog', dialog => dialog.accept()); await page.click('#gateway-keep-stopped'); await waitStopped();
  assert.equal(JSON.parse(fs.readFileSync(connections, 'utf8')).setup.gatewayManuallyStopped, true);

  await application.evaluate(({ dialog }) => { globalThis.fixtureOriginalMessageBox = dialog.showMessageBox; dialog.showMessageBox = async () => ({ response: 1 }); });
  await selectDesktopPage(page, 'gateway'); await setGatewayEnabled(page, true); await waitReady();
  fs.renameSync(connections, backup); fs.mkdirSync(connections); replacedConnections = true;
  try {
    await selectDesktopPage(page, 'about'); await page.click('#settings-exit');
    const failed = await waitForShellState(page, value => value.exit?.phase === 'failed', { timeoutMs: 30000 });
    assert.match(failed.exit.message, /无法保存服务恢复状态/);
    assert.equal(application.process().exitCode, null, 'save failure must leave the desktop open');
    assert.equal(await health(), true, 'exit save failure must leave the gateway running');
  } finally {
    fs.rmdirSync(connections); fs.renameSync(backup, connections); replacedConnections = false;
  }
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = globalThis.fixtureOriginalMessageBox; });
  await selectDesktopPage(page, 'gateway');
  page.once('dialog', dialog => dialog.accept()); await setGatewayEnabled(page, false); await waitStopped();
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  const proc = application.process(); const exited = new Promise(resolve => proc.once('exit', resolve));
  await selectDesktopPage(page, 'about'); await page.click('#settings-exit');
  let timer; assert.equal(await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stop-and-quit timed out')), 20000); })]).finally(() => clearTimeout(timer)), 0);
  application = undefined; page = undefined;
  await launch(); await selectDesktopPage(page, 'gateway'); await waitStopped();
  await delay(1000); assert.equal(await health(), false, 'stop-and-quit must remain stopped on the next desktop launch');
  await setGatewayEnabled(page, true); const final = await waitReady(); assert.equal(final.setup.gatewayManuallyStopped, false);
  page.once('dialog', dialog => dialog.accept()); await setGatewayEnabled(page, false); await waitStopped();
  await exitDesktop();
  console.log(JSON.stringify({ desktop: packaged ? 'packaged' : 'development', reattachWithoutRestart: 'passed', manualStopPersists: 'passed', localSelectionDoesNotRestart: 'passed', accountDoesNotRestart: 'passed', explicitStartClearsStop: 'passed', manualStopSaveFailureWarns: 'passed', saveRetry: 'passed', exitSaveFailureKeepsGateway: 'passed', manualStopSurvivesExit: 'passed', realCodexWrites: 'not performed' }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (replacedConnections) { try { fs.rmdirSync(connections); fs.renameSync(backup, connections); } catch { console.error('Fixture connection data retained:', temp); process.exitCode = 1; } }
  if (application) { try { await Promise.race([application.close(), delay(12000)]); } catch {} }
  if (cleanup) { try { await cleanup.stop(); } catch {} cleanup.close(); }
  if (remote) { remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); }
  const gateway = path.join(data, 'gateway');
  if (['controller.instance.json', 'gateway.instance.lock', 'natapp.instance.json'].some(name => fs.existsSync(path.join(gateway, name)))) { console.error('Fixture instance unconfirmed; retained:', temp); process.exitCode = 1; return; }
  const resolved = fs.realpathSync(temp), base = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved).toLowerCase() !== base.toLowerCase() || !path.basename(resolved).startsWith('hajimink-intent-ui-')) throw new Error('Unexpected fixture path');
  fs.rmSync(resolved, { recursive: true, force: true });
});
