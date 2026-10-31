'use strict';
// Disposable profiles, gateway ports and a fake NATAPP executable only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { selectDesktopPage, setGatewayEnabled } = require('./desktop-page-menu.cjs');
const { ConnectionStore } = require('../desktop/connections.cjs');
const { ControllerGatewayManager } = require('../desktop/controller-manager.cjs');
const { countNatappProcesses } = require('../desktop/native-helper.cjs');
const { waitForShellState } = require('./wait-shell-state.cjs');
if (process.platform !== 'win32') throw new Error('Windows required');
const root = path.resolve(__dirname, '..'), stage = path.join(root, '.local', 'hajimink-stage');
const binary = process.env.HAJIMINK_DESKTOP_BINARY || require('electron'), packaged = !!process.env.HAJIMINK_DESKTOP_BINARY;
const appRoot = packaged ? path.join(path.dirname(binary), 'resources', 'gateway') : stage;
const native = path.join(appRoot, 'controller', 'PrivateControlPipe.exe');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-exit-ui-'));
const data = path.join(temp, '用户资料'), remoteData = path.join(temp, '远程资料'), files = path.join(temp, '模拟客户端');
const exe = path.join(files, 'natapp.exe'), config = path.join(files, 'fixture.ini');
let app, page, manager, server, port, backedUp = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { freePort } = require('./test-network.cjs');
async function launch(profile, value) { app = await electron.launch({ executablePath: binary, args: [...(packaged ? [] : ['.']), `--hajimink-data-dir=${profile}`, `--hajimink-gateway-port=${value}`], cwd: root, timeout: 60000 }); page = await app.firstWindow(); }
async function health() { try { return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }
async function answer(response) { await app.evaluate(({ dialog }, value) => { dialog.showMessageBox = async (_win, options) => { globalThis.fixtureDialog = options; globalThis.fixtureDialogCount = (globalThis.fixtureDialogCount || 0) + 1; return { response: value }; }; }, response); }
async function exitFromSettings() {
  await selectDesktopPage(page, 'about');
  const processHandle = app.process();
  const exited = new Promise(resolve => processHandle.once('exit', resolve));
  await page.click('#settings-exit');
  let timer;
  const code = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('退出超时')), 45000); })]).finally(() => clearTimeout(timer));
  assert.equal(code, 0); app = undefined; page = undefined;
}
(async () => {
  fs.mkdirSync(files, { recursive: true }); fs.writeFileSync(config, '[default]\nauthtoken=fixture-only\n');
  const csc = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', `/out:${exe}`, path.join(root, 'scripts', 'fixtures', 'FakeNatapp.cs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stdout || compiled.stderr);
  assert.equal(await countNatappProcesses(native), 0, '测试不能与其他 NATAPP 进程同时运行');
  port = await freePort();
  manager = new ControllerGatewayManager({ appRoot, dataDir: path.join(data, 'gateway'), port, nodePath: packaged ? path.join(appRoot, 'runtime', 'node.exe') : binary, runAsNode: !packaged, startTimeoutMs: 15000 });
  await launch(data, port);
  await selectDesktopPage(page, 'workspace');
  await page.locator('#fallback-title').getByText('本机网关未连接').waitFor();
  await page.click('#fallback-settings');
  await page.locator('#gateway').waitFor({ state: 'visible' });
  await setGatewayEnabled(page, true);
  await waitForShellState(page, value => value.gateway?.state === 'ready' && value.gateway.managed, { timeoutMs: 45000 });
  assert.equal(await health(), true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false, '关闭窗口收起到托盘');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());

  await selectDesktopPage(page, 'about'); await answer(0);
  await page.click('#settings-exit');
  await waitForShellState(page, value => value.exit?.phase === 'idle');
  assert.equal(await health(), true, '取消退出不得停止网关');
  const confirmation = await app.evaluate(() => globalThis.fixtureDialog);
  assert.match(confirmation.detail, /CLI/); assert.match(confirmation.detail, /Codex.*任务不会停止/);
  const connections = path.join(data, 'connections.json'), backup = path.join(data, 'fixture-connections-backup.json');
  fs.renameSync(connections, backup); fs.mkdirSync(connections); backedUp = true;
  await answer(1); await page.click('#settings-exit');
  const failed = await waitForShellState(page, value => value.exit?.phase === 'failed', { timeoutMs: 30000 });
  assert.match(failed.exit.message, /无法保存/); assert.equal(await health(), true, '无法保存恢复记录时不得停止服务');
  fs.rmdirSync(connections); fs.renameSync(backup, connections); backedUp = false;
  await exitFromSettings(); assert.equal(await health(), false);
  assert.equal(JSON.parse(fs.readFileSync(connections, 'utf8')).exitResume.gateway, true);

  await launch(data, port);
  await waitForShellState(page, value => value.gateway?.state === 'ready' && value.gateway.managed, { timeoutMs: 45000 });
  assert.equal(await health(), true, '重新打开时恢复之前运行的网关');
  await selectDesktopPage(page, 'gateway');
  await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: [options.title.includes('客户端') ? paths.exe : paths.config] }); }, { exe, config });
  await page.selectOption('#gateway-provider', 'natapp');
  await page.locator('#natapp-manager-card summary').click();
  await page.click('#natapp-select-binary'); await page.click('#natapp-select-config'); await page.click('#natapp-save');
  await page.locator('#natapp-feedback').getByText(/已保存/).waitFor();
  await page.locator('.gateway-address-help summary').click(); page.once('dialog', dialog => dialog.accept()); await page.click('#gateway-no-address');
  await waitForShellState(page, value => value.gateway?.state === 'ready' && value.gateway.awaitingPublicOrigin === true, { timeoutMs: 45000 });
  page.once('dialog', dialog => dialog.accept()); await page.click('#natapp-start');
  await waitForShellState(page, value => value.gateway?.natapp?.state === 'running', { timeoutMs: 30000 });
  assert.equal(await countNatappProcesses(native), 1);
  await answer(1); await exitFromSettings();
  assert.equal(await countNatappProcesses(native), 0); assert.equal(await health(), false);
  const saved = JSON.parse(fs.readFileSync(connections, 'utf8'));
  assert.equal(saved.exitResume.natapp.binaryPath.toLowerCase(), exe.toLowerCase());
  assert.equal(JSON.stringify(saved).includes('fixture-only'), false);

  await launch(data, port);
  const restored = await waitForShellState(page, value => value.gateway?.state === 'ready' && value.gateway?.natapp?.state === 'running', { timeoutMs: 60000 });
  assert.equal(restored.gateway.mode, 'owner'); assert.equal(await countNatappProcesses(native), 1);
  await selectDesktopPage(page, 'gateway');
  await page.locator('#natapp-manager-card summary').click();
  page.once('dialog', dialog => dialog.accept()); await page.click('#natapp-stop');
  await waitForShellState(page, value => value.gateway?.natapp?.state === 'stopped', { timeoutMs: 30000 });
  page.once('dialog', dialog => dialog.accept()); await setGatewayEnabled(page, false);
  await waitForShellState(page, value => value.gateway?.state === 'stopped' && value.setup.gatewayManuallyStopped, { timeoutMs: 30000 });
  await answer(0); await exitFromSettings();
  await launch(data, port); await delay(1500);
  assert.equal(await health(), false); assert.equal(await countNatappProcesses(native), 0);
  assert.equal((await page.evaluate(() => window.hajimink.state())).setup.gatewayManuallyStopped, true);
  await exitFromSettings();

  // An unreachable remote origin shows an actionable fallback; a real HTTP
  // login/authorization response remains visible rather than being covered.
  const remotePort = await freePort(), remoteStore = new ConnectionStore(remoteData, 'linux');
  remoteStore.add({ name: '模拟远程', url: `http://127.0.0.1:${remotePort}` });
  await launch(remoteData, await freePort());
  await waitForShellState(page, value => value.status?.state === 'error', { timeoutMs: 30000 });
  await page.locator('#fallback-title').getByText('远程网关未连接').waitFor();
  assert.equal(await page.locator('#fallback-retry').isVisible(), true);
  server = http.createServer((_req, res) => { res.writeHead(401, { 'content-type': 'text/html' }); res.end('<!doctype html><main id="fixture-login">Fixture login</main>'); });
  await new Promise(resolve => server.listen(remotePort, '127.0.0.1', resolve));
  await page.click('#fallback-retry');
  await waitForShellState(page, value => /HTTP 401/.test(value.status?.message || ''), { timeoutMs: 30000 });
  const loaded = await app.evaluate(({ BrowserWindow }) => {
    const child = BrowserWindow.getAllWindows()[0].contentView.children.find(item => item.webContents?.getURL().startsWith('http://127.0.0.1:'));
    return child && { visible: child.getVisible(), url: child.webContents.getURL() };
  });
  assert.equal(loaded.visible, true, 'HTTP 登录页应保持可见');
  await exitFromSettings();
  console.log(JSON.stringify({ desktop: packaged ? 'packaged' : 'development', windowClose: 'tray', cancel: 'passed', saveFailure: 'passed', gatewayRestore: 'passed', natappRestore: 'fake client passed', manualStop: 'passed', connectionFallback: 'passed', httpLoginVisibility: 'passed' }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  const connections = path.join(data, 'connections.json'), backup = path.join(data, 'fixture-connections-backup.json');
  if (backedUp) { try { fs.rmdirSync(connections); fs.renameSync(backup, connections); } catch { process.exitCode = 1; } }
  if (app) { try { await Promise.race([app.close(), delay(12000)]); } catch {} }
  if (manager) { try { await manager.stop(); } catch {} manager.close(); }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (['controller.instance.json', 'gateway.instance.lock', 'natapp.instance.json'].some(name => fs.existsSync(path.join(data, 'gateway', name)))) { console.error('测试实例未确认停止，保留资料：', temp); process.exitCode = 1; return; }
  const actual = fs.realpathSync(temp), base = fs.realpathSync(os.tmpdir());
  if (path.dirname(actual).toLowerCase() !== base.toLowerCase() || !path.basename(actual).startsWith('hajimink-exit-ui-')) throw Error('Unexpected fixture path');
  fs.rmSync(actual, { recursive: true, force: true });
});
