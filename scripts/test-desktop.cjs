'use strict';
const { selectDesktopPage, selectDesktopConnection } = require('./desktop-page-menu.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { ConnectionStore, providerGuide } = require('../desktop/connections.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-desktop-smoke-'));
const servers = []; let application;
const binary = process.env.HAJIMINK_DESKTOP_BINARY || require('electron');
const appArgs = process.env.HAJIMINK_DESKTOP_BINARY ? [`--hajimink-data-dir=${temp}`] : ['.', `--hajimink-data-dir=${temp}`];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function serve(body, status = 200) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/auth/bootstrap' && status === 200) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ mode: 'owner', authenticated: false, csrf: 'a'.repeat(64) })); return; }
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function remoteContents(origin) {
  for (let i = 0; i < 100; i++) {
    const found = await application.evaluate(({ webContents }, origin) => webContents.getAllWebContents().some(w => !w.isDestroyed() && w.getURL().startsWith(origin)), origin);
    if (found) return;
    await delay(100);
  }
  throw new Error('测试网关页面未加载');
}
async function runRemote(origin, script) {
  return application.evaluate(async ({ webContents }, { origin, script }) => {
    const target = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().startsWith(origin));
    if (!target) throw new Error('找不到测试网关页面');
    return target.executeJavaScript(script);
  }, { origin, script });
}
(async () => {
  const origin = await serve('<!doctype html><title>HajiMink fixture</title><main id="fixture">测试网关</main>');
  const other = await serve('<!doctype html><title>Other origin</title>');
  const rejected = await serve('<!doctype html><title>Access denied</title>', 403);
  const store = new ConnectionStore(temp, 'linux'); store.add({ name: '测试网关甲', url: origin });
  const first = store.snapshot().selected;
  application = await electron.launch({ executablePath: binary, args: appArgs, cwd: path.resolve(__dirname, '..'), timeout: 60000 });
  const page = await application.firstWindow();
  // Keep only event types and source line numbers; connection data is never logged.
  await application.evaluate(({ app, BrowserWindow, ipcMain }) => {
    const events = globalThis.desktopMenuTestEvents = [];
    const record = event => { events.push(event); if (events.length > 120) events.shift(); };
    const observe = win => {
      const id = win.id;
      for (const name of ['show', 'focus', 'blur', 'resize', 'move', 'hide', 'minimize', 'closed']) win.on(name, () => record(`window:${id}:${name}`));
    };
    for (const win of BrowserWindow.getAllWindows()) observe(win);
    app.on('browser-window-created', (_event, win) => { record(`window:${win.id}:created`); observe(win); });
    for (const channel of ['shell:page-menu-dismiss', 'page-menu:choose', 'page-menu:close', 'workspace:page-menu-dismiss', 'workspace:ready']) ipcMain.on(channel, () => record(`ipc:${channel}`));
    const destroy = BrowserWindow.prototype.destroy;
    BrowserWindow.prototype.destroy = function (...args) {
      const stack = String(new Error().stack).split('\n').slice(1, 5).map(line => line.match(/(?:main\.cjs|node:electron\/[^:)]+):(\d+):\d+/)?.[0] || '').filter(Boolean);
      record(`window:${this.id}:destroy:${stack.join(',')}`);
      return destroy.apply(this, args);
    };
  });
  if (process.platform !== 'darwin') {
    await page.keyboard.press('Alt');
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible()), false, 'native menu must remain hidden, including after Alt');
  }
  await application.evaluate(({ shell }) => { shell.openExternal = async url => { globalThis.testGuideUrl = url; }; });
  await page.waitForFunction(() => !!document.querySelector('#connection-select')?.dataset.selected);
  assert.deepEqual(await page.locator('#provider option').evaluateAll(options => options.map(option => [option.value, option.textContent])), [['other', '其他已配置地址'], ['self-hosted', '自建服务器'], ['natapp', 'NATAPP'], ['sakurafrp', 'SakuraFrp'], ['tailscale', 'Tailscale'], ['cloudflare', 'Cloudflare Tunnel']]);
  assert.deepEqual(await page.locator('#gateway-provider option').evaluateAll(options => options.map(option => option.value)), ['', 'off', 'natapp', 'sakurafrp', 'tailscale', 'cloudflare', 'self-hosted']);
  const helpGuides = await page.locator('#help-content [data-help-provider]').evaluateAll(links => links.map(link => [link.dataset.helpProvider, link.href]));
  assert.equal(helpGuides.length, 6, 'all official help links should be present');
  for (const [provider, url] of helpGuides) assert.equal(url, providerGuide(provider), `help link differs from the provider whitelist: ${provider}`);
  await remoteContents(origin);
  assert.deepEqual(await runRemote(origin, '[typeof window.hajimink, typeof require]'), ['undefined', 'undefined'], 'remote page must not have a desktop bridge or Node');
  await selectDesktopPage(page, 'gateway');
  await page.locator('#gateway').waitFor({ state: 'visible' });
  assert.equal((await page.evaluate(() => window.hajimink.state())).sidebar.available, false, 'an unrelated gateway page must not be treated as a workbench sidebar');
  await page.click('[data-settings-section="logs"]');
  await page.locator('#logs').waitFor({ state: 'visible' });
  await page.click('#settings-back');
  // Simulate a storage failure only for this isolated test profile. No operation
  // may change the selected connection or discard its existing browser view.
  fs.unlinkSync(path.join(temp, 'connections.json'));
  fs.mkdirSync(path.join(temp, 'connections.json')); // Directory blocks atomic replacement on Windows.
  try {
    const rejected = await page.evaluate(async id => {
      const attempts = [
        () => window.hajimink.add({ name: 'not saved', url: 'https://example.test' }),
        () => window.hajimink.edit(id, { name: 'not saved', url: 'https://example.test' }),
        () => window.hajimink.remove(id),
        () => window.hajimink.select(id)
      ];
      const result = [];
      for (const attempt of attempts) { try { await attempt(); result.push(false); } catch { result.push(true); } }
      return result;
    }, first);
    assert.deepEqual(rejected, [true, true, true, true]);
    assert.equal((await page.evaluate(() => window.hajimink.state())).selected, first);
    assert.equal(await runRemote(origin, 'document.querySelector("#fixture")?.textContent'), '测试网关', 'failed save must keep the existing view');
  } finally {
    fs.rmdirSync(path.join(temp, 'connections.json'));
    fs.writeFileSync(path.join(temp, 'connections.json'), JSON.stringify(store.snapshot()), 'utf8');
  }
  await runRemote(origin, 'localStorage.setItem("connection-test", "first")');
  assert.equal(await runRemote(origin, 'window.open("https://example.com") === null'), true, 'popups must be denied');
  assert.equal(await runRemote(origin, `fetch(${JSON.stringify(other)}).then(() => false).catch(() => true)`), true, 'cross-origin requests must be denied');
  await runRemote(origin, `location.href=${JSON.stringify(other)}; true`); await delay(500); await remoteContents(origin);
  await selectDesktopPage(page, 'settings');
  await page.click('#add');
  await page.selectOption('#provider', 'tailscale'); await page.click('#provider-guide');
  assert.equal(await application.evaluate(() => globalThis.testGuideUrl), 'https://tailscale.com/docs/features/tailscale-funnel');
  await assert.rejects(page.evaluate(() => window.hajimink.providerGuide('https://attacker.example.com')));
  await page.selectOption('#provider', 'self-hosted');
  assert.equal(await page.locator('#provider-guide').isHidden(), true);
  await page.locator('#address-hint').getByText(/默认使用 HTTPS/).waitFor();
  await page.fill('#name', '测试网关乙'); await page.fill('#url', origin);
  await page.click('#test-connection'); await page.locator('#probe-status').getByText(/已识别网关登录接口/).waitFor();
  const setupScreenshot = path.resolve(__dirname, '../.local/hajimink-stage/smoke-artifacts/connection-setup.png');
  fs.mkdirSync(path.dirname(setupScreenshot), { recursive: true }); await page.screenshot({ path: setupScreenshot });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(820, 600));
  const layout = await page.locator('#connection-dialog').evaluate(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight }; });
  assert.ok(layout.left >= 0 && layout.right <= layout.width && layout.top >= 0 && layout.bottom <= layout.height, 'setup dialog must fit the minimum window');
  await page.click('#connection-form button[type=submit]');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 850));
  await page.waitForFunction(() => document.querySelector('#connection-select span')?.textContent === '测试网关乙');
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'connections.json'), 'utf8')).connections.find(item => item.name === '测试网关乙').provider, 'self-hosted');
  await remoteContents(origin);
  assert.equal(await runRemote(origin, 'localStorage.getItem("connection-test")'), null, 'same-origin connections must have separate browser storage');
  await selectDesktopPage(page, 'settings'); await page.click('#add');
  await page.fill('#name', '拒绝访问的测试网关'); await page.fill('#url', rejected); await page.click('#connection-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#connection-status').textContent.includes('HTTP 403'));
  await selectDesktopPage(page, 'settings');
  await page.getByRole('button', { name: '编辑 测试网关乙' }).click();
  await page.fill('#name', '测试网关乙已编辑'); await page.click('#connection-form button[type=submit]');
  await page.locator('#connection-list').getByText('测试网关乙已编辑', { exact: true }).waitFor();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除 拒绝访问的测试网关' }).click();
  await page.waitForFunction(() => document.querySelector('#connection-count').textContent === '2 个连接');
  await selectDesktopConnection(page, first); await remoteContents(origin);
  assert.equal(await runRemote(origin, 'localStorage.getItem("connection-test")'), 'first', 'switching back retains only this connection storage during the run');
  const hiddenToTray = await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]; win.close(); return !win.isVisible();
  });
  const instance = spawn(binary, appArgs, { cwd: path.resolve(__dirname, '..'), stdio: 'ignore', windowsHide: true });
  const exit = await Promise.race([new Promise(resolve => instance.once('exit', code => resolve(code))), delay(12000).then(() => 'timeout')]);
  assert.notEqual(exit, 'timeout', 'a second application instance should exit');
  assert.equal(exit, 0, 'second instance should exit normally');
  const count = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  assert.equal(count, 1, 'only one application window should exist');
  if (hiddenToTray) {
    for (let i = 0; i < 30; i++) { if (await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())) break; await delay(100); }
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true, 'a second launch should restore the window from the tray');
  }
  await selectDesktopPage(page, 'settings');
  const screenshot = path.resolve(__dirname, '../.local/hajimink-stage/smoke-artifacts/settings-current.png');
  fs.mkdirSync(path.dirname(screenshot), { recursive: true }); await page.screenshot({ path: screenshot });
  await application.close(); application = await electron.launch({ executablePath: binary, args: appArgs, cwd: path.resolve(__dirname, '..'), timeout: 60000 });
  const restoredPage = await application.firstWindow(); await remoteContents(origin);
  assert.equal(await runRemote(origin, 'localStorage.getItem("connection-test")'), null, 'temporary session data should not survive application exit');
  await selectDesktopPage(restoredPage, 'settings');
  for (const name of ['测试网关甲', '测试网关乙已编辑']) {
    restoredPage.once('dialog', dialog => dialog.accept());
    await restoredPage.getByRole('button', { name: `删除 ${name}` }).click();
  }
  await restoredPage.waitForFunction(() => document.querySelector('#connection-count')?.textContent === '0 个连接');
  assert.equal(await restoredPage.locator('#connection-select').isDisabled(), true, '没有连接时切换按钮应禁用');
  assert.equal(await restoredPage.locator('#connection-select span').textContent(), '尚未添加连接');
  console.log('PASS desktop shell: provider setup and connection probe, failed-save rollback, isolated browser contexts, memory-only data, bridge denial, popup and cross-origin blocking, connection switch and CRUD, HTTP error status, single instance' + (hiddenToTray ? ', tray restore' : ', minimize fallback'));
  console.log(`Screenshot: ${screenshot}`);
})().catch(async error => {
  if (application) {
    const events = await application.evaluate(() => globalThis.desktopMenuTestEvents).catch(() => undefined);
    if (events) console.error('Desktop menu event types:', JSON.stringify(events));
  }
  console.error(error); process.exitCode = 1;
}).finally(async () => {
  if (application) await application.close().catch(() => {});
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  const resolved = fs.realpathSync(temp); const safeRoot = fs.realpathSync(os.tmpdir());
  if (!resolved.startsWith(safeRoot + path.sep) || !path.basename(resolved).startsWith('hajimink-desktop-smoke-')) throw new Error('Unexpected test directory');
  fs.rmSync(resolved, { recursive: true, force: true });
});
