'use strict';
const { selectDesktopPage, selectDesktopConnection, setGatewayEnabled } = require('./desktop-page-menu.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { _electron: electron } = require('playwright');
const { waitForShellState } = require('./wait-shell-state.cjs');
const { ControllerGatewayManager } = require('../desktop/controller-manager.cjs');
const root = path.resolve(__dirname, '..');
const stage = path.join(root, '.local', 'hajimink-stage');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-ui-controller-'));
const userData = path.join(temp, '测试 用户数据');
const binary = process.env.HAJIMINK_DESKTOP_BINARY || require('electron');
const packaged = !!process.env.HAJIMINK_DESKTOP_BINARY;
let application, page, port, initialPort, cleanupManager, remoteFixture, occupiedFixture;
const stalledSockets = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { freePort } = require('./test-network.cjs');
function args() { return [...(packaged ? [] : ['.']), `--hajimink-data-dir=${userData}`, `--hajimink-gateway-port=${initialPort}`]; }
async function launch() { application = await electron.launch({ executablePath: binary, args: args(), cwd: root, env: { ...process.env, PATH: '' }, timeout: 60000 }); page = await application.firstWindow({ timeout: 20000 }); await selectDesktopPage(page, 'gateway'); }
async function waitReady() {
  await page.waitForFunction(() => ['正常', '故障'].includes(document.querySelector('#gateway-state-badge')?.textContent), null, { timeout: 45000 });
  const badge = await page.locator('#gateway-state-badge').textContent();
  assert.equal(badge, '正常', `desktop gateway failed: ${await page.locator('#gateway-state-message').textContent()}`);
  return page.evaluate(() => window.hajimink.state());
}
async function closeDesktop() {
  const current = application; const processHandle = current.process();
  const exited = new Promise(resolve => { if (processHandle.exitCode !== null) resolve(); else processHandle.once('exit', resolve); });
  await current.evaluate(({ app }) => { setTimeout(() => app.quit(), 100); return true; });
  await Promise.race([exited, delay(12000).then(() => { throw new Error('桌面进程退出超时'); })]);
  application = undefined; page = undefined;
  void current.close().catch(() => {});
}
async function health() { try { return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1200) })).ok; } catch { return false; } }
(async () => {
  port = await freePort(); initialPort = port;
  const appRoot = packaged ? path.join(path.dirname(binary), 'resources', 'gateway') : stage;
  const nodePath = packaged ? path.join(appRoot, 'runtime', 'node.exe') : binary;
  cleanupManager = new ControllerGatewayManager({ appRoot, dataDir: path.join(userData, 'gateway'), port, nodePath, runAsNode: !packaged, startTimeoutMs: 15000 });
  await launch(); await selectDesktopPage(page, 'gateway');
  assert.equal(await health(), false, 'fresh setup must wait for the user before starting');
  assert.equal(await page.locator('#desktop-state-badge').textContent(), '未检测');
  assert.equal(await page.locator('#tunnel-status-badge').textContent(), '未选择');
  assert.equal(await page.locator('#gateway-provider').inputValue(), '');
  assert.equal(await page.locator('#gateway-remote-fields').isHidden(), true);
  assert.equal(await page.getByRole('button', { name: '网关文档' }).count(), 0);
  await selectDesktopPage(page, 'documentation');
  await page.locator('#help-local').getByRole('heading', { name: '本机网关' }).waitFor();
  assert.equal(await health(), false, 'documentation must be available without starting the gateway');
  await selectDesktopPage(page, 'gateway');
  const originalGateway = (await page.evaluate(() => window.hajimink.state())).gateway;
  const showFixture = async gateway => application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('shell:gateway', value), gateway);
  const mockGateway = { ...originalGateway, state: 'ready', managed: true };
  const readOnly = { connected: true, compatible: false, accessMode: 'read-only', version: '26.1023.6123.0' };
  await showFixture({ ...mockGateway, desktop: readOnly });
  await page.waitForFunction(() => document.querySelector('#desktop-state-badge')?.textContent === '仅查看');
  assert.equal(await page.locator('#desktop-state-version').textContent(), readOnly.version);
  assert.match(await page.locator('#desktop-state-detail').textContent(), /尚未验证/);
  await selectDesktopPage(page, 'logs');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(820, 600));
  await page.locator('#desktop-state-badge').scrollIntoViewIfNeeded();
  const bounds = await page.locator('#logs').evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, 'desktop status must fit the smallest desktop window');
  const artifacts = path.join(stage, 'smoke-artifacts'); fs.mkdirSync(artifacts, { recursive: true });
  await page.emulateMedia({ colorScheme: 'light' }); await page.screenshot({ path: path.join(artifacts, 'desktop-status-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: path.join(artifacts, 'desktop-status-dark.png') });
  await page.emulateMedia({ colorScheme: 'no-preference' });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 850));
  await showFixture({ ...mockGateway, desktop: { connected: false, compatible: false, accessMode: 'blocked', version: readOnly.version, reason: `桌面版本 ${readOnly.version} 尚未通过兼容验证，暂时无法连接` } });
  await page.waitForFunction(() => document.querySelector('#desktop-state-badge')?.textContent === '未连接');
  assert.match(await page.locator('#desktop-state-detail').textContent(), /尚未通过兼容验证/);
  await showFixture({ ...mockGateway, desktop: { connected: true, compatible: true, accessMode: 'limited', version: readOnly.version } });
  await page.waitForFunction(() => document.querySelector('#desktop-state-badge')?.textContent === '部分可用');
  assert.match(await page.locator('#desktop-state-detail').textContent(), /审批请在 Codex/);
  await showFixture({ ...mockGateway, desktop: { connected: true, compatible: true, accessMode: 'full', version: '26.1021.3705.0' } });
  await page.waitForFunction(() => document.querySelector('#desktop-state-badge')?.textContent === '已连接');
  await showFixture({ ...mockGateway, desktop: null });
  await page.waitForFunction(() => document.querySelector('#desktop-state-badge')?.textContent === '等待状态');
  await showFixture({ ...originalGateway, state: 'stopped', desktop: readOnly });
  await page.waitForFunction(() => document.querySelector('#desktop-state-badge')?.textContent === '未检测');
  assert.equal(await page.locator('#desktop-state-version').textContent(), '未检测到', 'stale status must not survive gateway stop');
  await showFixture(originalGateway);
  await selectDesktopPage(page, 'gateway'); await setGatewayEnabled(page, true); const first = await waitReady();
  await waitForShellState(page, value => !!value.gateway?.desktop);
  assert.equal(first.gateway.managed, true); assert.ok(first.gateway.pid); assert.ok(first.gateway.controllerPid);
  assert.equal(await health(), true);
  await application.evaluate(({ shell }) => { shell.openExternal = async url => { globalThis.testGatewayGuide = url; }; });
  await page.selectOption('#gateway-provider', 'tailscale'); await waitForShellState(page, value => value.setup?.tunnelProvider === 'tailscale');
  await page.waitForFunction(() => document.querySelector('#tunnel-status-badge')?.textContent === '待保护');
  assert.equal(await page.locator('#tunnel-status-provider').textContent(), 'Tailscale');
  await page.selectOption('#gateway-provider', 'sakurafrp'); await waitForShellState(page, value => value.setup?.tunnelProvider === 'sakurafrp');
  await page.selectOption('#gateway-provider', 'self-hosted');
  await waitForShellState(page, value => value.setup?.tunnelProvider === 'self-hosted');
  assert.ok((await page.locator('#gateway-safety-detail').textContent()).includes('请勿公开网关'));
  await selectDesktopPage(page, 'documentation');
  await page.locator('#help-tunnels').getByText(/服务器上的/).waitFor();
  await page.locator('#help-tunnels').getByText(/不会自动创建隧道/).waitFor();
  await page.locator('#help-tunnels').getByText(/本地服务为 HTTP/).waitFor();
  await page.locator('#help-tunnels [data-help-provider="sakurafrp"]').click();
  assert.equal(await application.evaluate(() => globalThis.testGatewayGuide), 'https://doc.natfrp.com/app/http.html');
  await selectDesktopPage(page, 'gateway');
  assert.equal((await page.evaluate(() => window.hajimink.state())).setup.tunnelProvider, 'self-hosted');
  occupiedFixture = net.createServer(); await new Promise(resolve => occupiedFixture.listen(0, '127.0.0.1', resolve));
  const occupiedPort = occupiedFixture.address().port;
  await page.fill('#gateway-port-input', String(occupiedPort)); page.once('dialog', dialog => dialog.accept()); await page.click('#gateway-port-save');
  await page.locator('#gateway-port-feedback').getByText(/已被其他程序占用/).waitFor({ timeout: 12000 });
  assert.equal((await page.evaluate(() => window.hajimink.state())).gateway.pid, first.gateway.pid);
  assert.equal(await health(), true, 'an occupied target must not stop the original gateway');
  await new Promise(resolve => occupiedFixture.close(resolve)); occupiedFixture = undefined;
  let next = await freePort(); while (next === port) next = await freePort();
  await page.fill('#gateway-port-input', String(next)); page.once('dialog', dialog => dialog.accept()); await page.click('#gateway-port-save');
  try { await page.locator('#gateway-port-feedback').getByText(/已切换到端口/).waitFor({ timeout: 60000 }); } catch (error) { console.error('Port-change debug:', JSON.stringify({ feedback: await page.locator('#gateway-port-feedback').textContent(), badge: await page.locator('#gateway-state-badge').textContent(), message: await page.locator('#gateway-state-message').textContent(), state: await page.evaluate(() => window.hajimink.state()) })); throw error; }
  const changed = await page.evaluate(() => window.hajimink.state());
  assert.equal(changed.gateway.state, 'ready'); assert.equal(changed.gateway.port, next);
  assert.equal(changed.connections.find(item => item.local).url, `http://127.0.0.1:${next}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'gateway', 'config.json'), 'utf8')).port, next);
  assert.equal(await health(), false, 'the old owned gateway should no longer be listening');
  port = next; cleanupManager.port = next;
  assert.equal(await health(), true, 'the replacement gateway should be running on the new port');
  const shot = path.join(stage, 'smoke-artifacts', 'gateway-port-settings.png'); fs.mkdirSync(path.dirname(shot), { recursive: true }); await page.screenshot({ path: shot });
  remoteFixture = http.createServer((_request, response) => { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end('<!doctype html><title>Independent remote fixture</title>'); });
  await new Promise(resolve => remoteFixture.listen(0, '127.0.0.1', resolve));
  await selectDesktopPage(page, 'settings'); await page.click('#add');
  await page.fill('#name', '第二个隔离连接'); await page.fill('#url', `http://127.0.0.1:${remoteFixture.address().port}`); await page.click('#connection-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#connection-select span')?.textContent === '第二个隔离连接');
  assert.equal(await health(), true, 'switching connections must not stop the local gateway');
  const localId = first.connections.find(item => item.local).id; await selectDesktopConnection(page, localId);
  remoteFixture.closeAllConnections(); await new Promise(resolve => remoteFixture.close(resolve)); remoteFixture = undefined;
  await closeDesktop();
  assert.equal(await health(), true, 'gateway must survive the desktop app process exiting');
  await launch(); const second = await waitReady();
  assert.equal(second.gateway.pid, changed.gateway.pid); assert.equal(second.gateway.controllerPid, changed.gateway.controllerPid);
  assert.equal(second.gateway.port, port, 'saved port must override the initial startup port on relaunch');
  assert.equal(second.gateway.managed, true, 'new UI must authenticate and reattach');
  assert.equal(second.setup.tunnelProvider, 'self-hosted');
  assert.equal(await page.locator('#gateway-provider').inputValue(), 'self-hosted');
  assert.equal((await page.evaluate(() => window.hajimink.state())).setup.complete, true);
  // Leave two fixture connections idle or mid-header to exercise the actual
  // desktop -> private controller -> gateway shutdown path.
  for (let i = 0; i < 2; i++) {
    const socket = net.connect(port, '127.0.0.1'); stalledSockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.on('error', reject); });
  }
  stalledSockets[1].write(`POST /api/threads HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
  await delay(150);
  await selectDesktopPage(page, 'gateway'); page.once('dialog', dialog => dialog.accept()); await setGatewayEnabled(page, false);
  await page.waitForFunction(() => document.querySelector('#gateway-state-badge')?.textContent === '未启动', null, { timeout: 20000 });
  assert.equal(await health(), false);
  assert.equal(fs.existsSync(path.join(userData, 'gateway', 'controller.instance.json')), false);
  console.log(JSON.stringify({ desktop: packaged ? 'packaged' : 'development', parentProcessExit: 'passed', gatewayContinues: 'passed', authenticatedReattach: 'passed', gatewaySurvivesConnectionSwitch: 'passed', identityPreserved: 'passed', stopFromNewWindow: 'passed', stalledHeadersDoNotBlockStop: 'passed', unicodeUserData: 'passed', portChange: 'passed', tunnelProviderPersistence: 'passed', occupiedPortProtection: 'passed', gatewayProviderGuide: 'passed', port }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const socket of stalledSockets) socket.destroy();
  if (page) { try { await Promise.race([page.evaluate(() => window.hajimink.gatewayStop()), delay(10000)]); } catch {} }
  if (application) { try { await Promise.race([application.close(), delay(10000)]); } catch {} }
  if (cleanupManager) { try { const record = JSON.parse(fs.readFileSync(path.join(userData, 'gateway', 'controller.instance.json'), 'utf8')); cleanupManager.port = record.port; } catch {} try { await cleanupManager.stop(); } catch {} cleanupManager.close(); }
  if (occupiedFixture) await new Promise(resolve => occupiedFixture.close(resolve));
  if (remoteFixture) { remoteFixture.closeAllConnections(); await new Promise(resolve => remoteFixture.close(resolve)); }
  const record = path.join(userData, 'gateway', 'controller.instance.json');
  if (fs.existsSync(record) || (port && await health())) { console.error('测试后台仍有实例记录或端口响应，保留临时目录：', temp); process.exitCode = 1; return; }
  const resolved = fs.realpathSync(temp), safeRoot = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved).toLowerCase() !== safeRoot.toLowerCase() || !path.basename(resolved).startsWith('hajimink-ui-controller-')) throw new Error('Unexpected test directory');
  fs.rmSync(resolved, { recursive: true, force: true });
});
