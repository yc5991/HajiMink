/** Tests the desktop Dock, settings center and preserved workbench using disposable fixtures. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { buildApp } from '../server/app';
import { removeTempFixture } from '../tests/safe-temp';

const require = createRequire(import.meta.url);
const { openDesktopConnectionMenu, selectDesktopConnection } = require('./desktop-page-menu.cjs');
const { ConnectionStore } = require('../desktop/connections.cjs');
const root = path.resolve(import.meta.dirname, '..');
const stage = path.join(root, '.local', 'hajimink-stage');
const artifacts = process.env.HAJIMINK_SMOKE_ARTIFACTS || path.join(stage, 'smoke-artifacts');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-sidebar-ui-'));
const status = { connected: true, compatible: true, accessMode: 'full' as const, version: '26.1023.6123.0', supportedVersion: '26.x' };
const projects = [{ id: 'project-1', name: '测试项目', path: temp, hostId: 'local' }];
const threads = [{ id: 'thread-1', title: '测试会话', projectId: 'project-1', status: 'idle', updatedAt: Date.now() }];
const view = { id: 'thread-1', title: '测试会话', revision: 1, live: true, status: 'idle', turns: [], totalTurns: 0, olderCursor: null, requests: [] };
const adapter = Object.assign(new EventEmitter(), {
  status, close() {}, touch() {}, catalog: async () => ({ projects, threads }), models: () => [],
  view: async () => view, viewCached: () => view,
});
let spawned = 0, killed = 0;
const cliSpawn = () => {
  spawned++;
  return { onData(callback: (text: string) => void) { queueMicrotask(() => callback('Fixture terminal ready\r\n')); }, onExit() {}, write() {}, resize() {}, kill() { killed++; } } as any;
};
let app: ElectronApplication | undefined;
let gateway: Awaited<ReturnType<typeof buildApp>> | undefined;

async function waitFor(predicate: () => Promise<boolean>, message: string) {
  for (let index = 0; index < 150; index++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(message);
}
async function pressClosingKey(menu: Page, key: string) {
  try { await menu.keyboard.press(key); }
  catch (error) { if (!menu.isClosed()) throw error; }
}
async function remote(origin: string, script: string) {
  return app!.evaluate(async ({ webContents }, value) => {
    const target = webContents.getAllWebContents().find(item => !item.isDestroyed() && item.getURL().startsWith(value.origin));
    return target ? target.executeJavaScript(value.script) : null;
  }, { origin, script });
}
async function viewState(origin: string) {
  return app!.evaluate(({ BrowserWindow }, origin) => {
    const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL() === 'hajimink://app/index.html')!;
    const child = win.contentView.children.find(item => 'webContents' in item && (item as any).webContents.getURL().startsWith(origin)) as any;
    return child ? { id: child.webContents.id, visible: child.getVisible(), bounds: child.getBounds() } : null;
  }, origin);
}
async function captureShell(name: string) {
  const data = await app!.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL() === 'hajimink://app/index.html')!;
    return (await win.capturePage()).toPNG().toString('base64');
  });
  fs.writeFileSync(path.join(artifacts, name), Buffer.from(data, 'base64'));
}
async function capture(name: string, origin: string) {
  const images = await app!.evaluate(async ({ BrowserWindow }, origin) => {
    const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL() === 'hajimink://app/index.html')!;
    const child = win.contentView.children.find(item => 'webContents' in item && (item as any).webContents.getURL().startsWith(origin)) as any;
    if (!child?.getVisible()) throw new Error('截图时工作台视图不可见');
    return { shell: (await win.capturePage()).toPNG().toString('base64'), child: (await child.webContents.capturePage()).toPNG().toString('base64'), bounds: child.getBounds(), size: win.getContentSize() };
  }, origin);
  const script = `(async () => {
    const data = ${JSON.stringify(images)};
    const load = value => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = 'data:image/png;base64,' + value; });
    const [base, child] = await Promise.all([load(data.shell), load(data.child)]);
    const canvas = document.createElement('canvas'); canvas.width = base.width; canvas.height = base.height;
    const context = canvas.getContext('2d'); context.drawImage(base, 0, 0);
    context.drawImage(child, data.bounds.x * base.width / data.size[0], data.bounds.y * base.height / data.size[1], data.bounds.width * base.width / data.size[0], data.bounds.height * base.height / data.size[1]);
    return canvas.toDataURL('image/png').split(',')[1];
  })()`;
  const data = await remote(origin, script);
  fs.writeFileSync(path.join(artifacts, name), Buffer.from(data, 'base64'));
}
async function captureMenu(name: string, origin: string) {
  const images = await app!.evaluate(async ({ BrowserWindow }, origin) => {
    const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL() === 'hajimink://app/index.html')!;
    const popup = BrowserWindow.getAllWindows().find(item => item !== win && item.webContents.getURL().startsWith('hajimink://app/page-menu.html?'));
    const child = win.contentView.children.find(item => 'webContents' in item && (item as any).webContents.getURL().startsWith(origin)) as any;
    if (!popup?.isVisible() || !child?.getVisible()) throw new Error('截图时菜单或工作台视图不可见');
    return { shell: (await win.capturePage()).toPNG().toString('base64'), child: (await child.webContents.capturePage()).toPNG().toString('base64'), popup: (await popup.capturePage()).toPNG().toString('base64'), bounds: child.getBounds(), popupBounds: popup.getContentBounds(), windowBounds: win.getContentBounds(), size: win.getContentSize() };
  }, origin);
  const script = `(async () => {
    const data = ${JSON.stringify(images)};
    const load = value => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = 'data:image/png;base64,' + value; });
    const [base, child, popup] = await Promise.all([load(data.shell), load(data.child), load(data.popup)]);
    const canvas = document.createElement('canvas'); canvas.width = base.width; canvas.height = base.height;
    const context = canvas.getContext('2d'); const scale = base.width / data.size[0]; context.drawImage(base, 0, 0);
    context.drawImage(child, data.bounds.x * scale, data.bounds.y * scale, data.bounds.width * scale, data.bounds.height * scale);
    context.drawImage(popup, (data.popupBounds.x - data.windowBounds.x) * scale, (data.popupBounds.y - data.windowBounds.y) * scale, data.popupBounds.width * scale, data.popupBounds.height * scale);
    return canvas.toDataURL('image/png').split(',')[1];
  })()`;
  const data = await remote(origin, script);
  fs.writeFileSync(path.join(artifacts, name), Buffer.from(data, 'base64'));
}
async function selectSettingsSection(shell: Page, section: string) {
  const ids: Record<string, string> = { interface: 'settings-interface', connections: 'settings-connections', gateway: 'gateway', documentation: 'settings-documentation', logs: 'logs', about: 'settings-about' };
  await shell.locator(`[data-settings-section="${section}"]`).click();
  await shell.locator(`#${ids[section]}`).waitFor({ state: 'visible' });
  await shell.waitForFunction(value => document.querySelector(`[data-settings-section="${value}"]`)?.getAttribute('aria-current') === 'page', section);
}
async function showSettings(workbench: Page, shell: Page, section = 'interface') {
  await workbench.getByRole('button', { name: '设置', exact: true }).click();
  await shell.locator('#settings').waitFor({ state: 'visible' });
  await selectSettingsSection(shell, section);
}
async function showWorkspace(shell: Page, origin: string) {
  await shell.locator('#dock-brand').click();
  await shell.waitForFunction(() => document.body.dataset.page === 'workspace');
  await waitFor(async () => (await viewState(origin))?.visible === true, '工作台未恢复显示');
}
async function setTheme(shell: Page, origin: string, theme: string) {
  await shell.locator(`input[name="theme"][value="${theme}"]`).check();
  await waitFor(async () => await app!.evaluate(({ nativeTheme }) => nativeTheme.themeSource) === theme, `原生主题未切换为 ${theme}`);
  if (theme !== 'system') {
    const dark = theme === 'dark';
    await waitFor(async () => await app!.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors) === dark, '原生窗口明暗未同步');
    await waitFor(async () => await shell.evaluate(value => document.documentElement.dataset.theme === value, theme), '外壳主题未同步');
    await waitFor(async () => await remote(origin, 'document.documentElement.dataset.theme') === theme, '工作台主题未同步');
  }
}

async function main() {
  assert.ok(fs.existsSync(path.join(stage, 'dist', 'index.html')), '请先构建隔离工作台');
  fs.mkdirSync(artifacts, { recursive: true });
  process.chdir(stage);
  gateway = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://localhost:3000', dataDir: path.join(temp, 'db') }, { adapter: adapter as any, cliSpawn });
  await gateway.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (gateway.app.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const store = new ConnectionStore(temp, 'linux'); store.add({ name: '测试连接', url: origin });
  const firstConnection = store.snapshot().selected;
  store.add({ name: '<b>超长连接名称</b>'.repeat(2), url: origin });
  const secondConnection = store.snapshot().selected;
  for (let index = 0; index < 12; index++) store.add({ name: `测试连接 ${index + 3}`, url: origin });
  store.select(firstConnection);
  const binary = process.env.HAJIMINK_DESKTOP_BINARY || require('electron');
  const args = process.env.HAJIMINK_DESKTOP_BINARY ? [`--hajimink-data-dir=${temp}`] : ['.', `--hajimink-data-dir=${temp}`];
  app = await electron.launch({ executablePath: binary, args, cwd: root, timeout: 60000 });
  const shell = await app.firstWindow();
  await waitFor(async () => !!(await shell.evaluate(() => (window as any).hajimink.state())).sidebar.available, '工作台侧边栏未就绪');
  await waitFor(async () => await remote(origin, '!!document.querySelector(".thread-row")') === true, '测试会话未显示');
  await waitFor(async () => app!.context().pages().some(item => item.url().startsWith(origin)), '找不到工作台测试页面');
  const workbench = app.context().pages().find(item => item.url().startsWith(origin))!;
  const original = await viewState(origin); assert.ok(original?.visible);
  assert.deepEqual(await remote(origin, '[typeof window.hajimink, typeof require, Object.keys(window.hajiminkWorkspace).sort().join(",")]'), ['undefined', 'undefined', 'onHeaderAction,onSearch,onSurface,onTheme,ready,setHeader,showSettings,showWorkspace,sidebarOpen']);
  await shell.locator('#workspace-header-title').getByText('新建会话').waitFor();
  assert.equal(await workbench.locator('.main-panel .topbar').count(), 0, '桌面工作台不应保留第二行顶部栏');
  assert.equal(await workbench.getByRole('button', { name: '关闭导航', exact: true }).count(), 0);
  assert.equal(await workbench.getByRole('button', { name: '切换明暗主题', exact: true }).count(), 0);
  assert.equal(await workbench.locator('.sidebar-search').count(), 0, '桌面搜索应只在 Dock 中显示');
  assert.equal(await shell.locator('#page-switcher-trigger').count(), 0);
  const dockOrder = await shell.evaluate(() => ['dock-brand', 'shell-sidebar-open', 'dock-search', 'connection-select'].map(id => document.getElementById(id)!.getBoundingClientRect().left));
  assert.ok(dockOrder.every((value, index) => index === 0 || dockOrder[index - 1] < value), `Dock 顺序错误: ${dockOrder}`);
  assert.equal(await shell.locator('.topbar').evaluate(element => element.getBoundingClientRect().height), 40);

  await showSettings(workbench, shell, 'interface');
  assert.equal((await viewState(origin))?.visible, false, '设置页应完全隐藏工作台');
  assert.equal((await viewState(origin))?.id, original.id, '打开设置不能重建工作台');
  assert.equal(await shell.locator('[data-settings-section]').count(), 6);
  await setTheme(shell, origin, 'light');
  await captureShell('settings-interface-light.png');
  await showWorkspace(shell, origin);
  assert.equal(await remote(origin, 'getComputedStyle(document.querySelector(".new-thread")).backgroundColor'), 'rgba(0, 0, 0, 0)', '新建会话应保持透明底');
  await capture('merged-workspace-light.png', origin);

  const messageInput = workbench.getByLabel('消息输入框');
  const emptyComposerHeight = await workbench.locator('.composer').evaluate(element => element.getBoundingClientRect().height);
  assert.ok(emptyComposerHeight <= 96, `桌面空白输入框过高: ${emptyComposerHeight}`);
  await messageInput.fill('第一行\n第二行\n第三行\n第四行');
  const expandedComposerHeight = await workbench.locator('.composer').evaluate(element => element.getBoundingClientRect().height);
  assert.ok(expandedComposerHeight > emptyComposerHeight + 25, '桌面多行输入应自动展开');
  await messageInput.fill('');
  assert.ok(Math.abs(await workbench.locator('.composer').evaluate(element => element.getBoundingClientRect().height) - emptyComposerHeight) <= 1, '桌面清空后应恢复紧凑高度');

  let connectionMenu = await openDesktopConnectionMenu(shell);
  assert.equal(await shell.locator('#connection-select').getAttribute('aria-expanded'), 'true');
  assert.equal(await connectionMenu.getByRole('menu', { name: '选择工作台连接' }).count(), 1);
  assert.equal(await connectionMenu.locator('[role="menuitemradio"]').count(), 14);
  assert.equal(await connectionMenu.locator('[aria-checked="true"]').getAttribute('data-connection'), firstConnection);
  assert.equal(await connectionMenu.locator('b').count(), 0, '连接名必须作为纯文本显示');
  const menuData = await connectionMenu.evaluate(() => (window as any).hajiminkPageMenu.data());
  assert.deepEqual(Object.keys(menuData.items[0]).sort(), ['id', 'local', 'name'], '菜单不应接收网关地址或凭据');
  const menuMetrics = await connectionMenu.locator('.menu-items').evaluate((element: HTMLElement) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, width: getComputedStyle(element).scrollbarWidth, webkit: getComputedStyle(element, '::-webkit-scrollbar').display }));
  assert.ok(menuMetrics.scrollHeight > menuMetrics.clientHeight, '大量连接应限制菜单高度');
  assert.equal(menuMetrics.width, 'none'); assert.equal(menuMetrics.webkit, 'none');
  await captureMenu('connection-menu-workspace-light.png', origin);
  await connectionMenu.locator('.menu-items').hover(); await connectionMenu.mouse.wheel(0, 320);
  await connectionMenu.waitForFunction(() => document.querySelector('.menu-items')!.scrollTop > 0);
  await connectionMenu.keyboard.press('Home');
  assert.equal(await connectionMenu.evaluate(() => (document.activeElement as HTMLElement)?.dataset.connection), firstConnection);
  await connectionMenu.keyboard.press('ArrowDown');
  assert.equal(await connectionMenu.evaluate(() => (document.activeElement as HTMLElement)?.dataset.connection), secondConnection);
  await pressClosingKey(connectionMenu, 'Escape');
  await shell.waitForFunction(() => document.querySelector('#connection-select')?.getAttribute('aria-expanded') === 'false');
  assert.equal(await shell.evaluate(() => document.activeElement?.id), 'connection-select', 'Escape 后焦点应返回连接按钮');
  await shell.keyboard.press('ArrowDown');
  await waitFor(async () => app!.context().pages().some(item => item.url().startsWith('hajimink://app/page-menu.html?')), '键盘无法打开连接菜单');
  connectionMenu = app.context().pages().find(item => item.url().startsWith('hajimink://app/page-menu.html?'))!;
  await connectionMenu.locator('[role="menu"]').waitFor();
  await pressClosingKey(connectionMenu, 'Tab');
  await shell.waitForFunction(() => document.querySelector('#connection-select')?.getAttribute('aria-expanded') === 'false');
  assert.equal(await shell.evaluate(() => document.activeElement?.id), 'reload', 'Tab 应进入连接按钮之后的可见控件');
  connectionMenu = await openDesktopConnectionMenu(shell);
  await workbench.locator('.sidebar').click({ position: { x: 245, y: 300 } });
  await shell.waitForFunction(() => document.querySelector('#connection-select')?.getAttribute('aria-expanded') === 'false');
  assert.equal(connectionMenu.isClosed(), true, '点击工作台应关闭连接菜单');

  await shell.locator('#dock-search').click();
  await waitFor(async () => await remote(origin, 'document.querySelector(".search-dialog")?.open') === true, 'Dock 搜索未打开');
  await workbench.getByRole('button', { name: '关闭搜索' }).click();
  await workbench.locator('.thread-row').first().click();
  await shell.locator('#workspace-header-title').getByText('测试会话').waitFor();

  await showSettings(workbench, shell, 'connections');
  await shell.locator('#add').click();
  await shell.locator('#connection-dialog').waitFor({ state: 'visible' });
  assert.equal((await viewState(origin))?.visible, false);
  await shell.locator('#cancel').click();
  await selectSettingsSection(shell, 'gateway');
  await shell.locator('#gateway-toggle').waitFor({ state: 'attached' });
  assert.equal(await shell.getByRole('button', { name: '网关文档' }).count(), 0);
  assert.equal(await shell.locator('#gateway .gateway-setting').count(), 2);
  assert.equal(await shell.locator('#gateway #gateway-state-badge').count(), 0);
  await shell.selectOption('#gateway-provider', 'self-hosted');
  await shell.locator('#gateway-remote-fields').waitFor({ state: 'visible' });
  await shell.fill('#gateway-public-origin', 'https://gateway.example.test');
  await captureShell('settings-gateway-remote-light.png');
  await selectSettingsSection(shell, 'documentation');
  await shell.getByRole('heading', { name: '本机网关', exact: true }).waitFor();
  assert.equal(await shell.locator('#settings-documentation').isVisible(), true);
  assert.equal(await shell.locator('#help-content h2').count(), 6);
  await shell.getByRole('link', { name: '本机网关', exact: true }).click();
  assert.equal(await shell.evaluate(() => document.activeElement?.id), 'help-local', '文档入口应将键盘焦点移至目标内容');
  await shell.getByRole('link', { name: '隧道服务', exact: true }).click();
  await shell.getByRole('heading', { name: '隧道服务', exact: true }).waitFor();
  assert.equal(await shell.evaluate(() => document.activeElement?.id), 'help-tunnels', '目录导航应将键盘焦点移至目标内容');
  await captureShell('settings-documentation-light.png');
  await selectSettingsSection(shell, 'logs');
  await shell.waitForFunction(() => !document.querySelector('#logs-output')?.textContent?.includes('正在读取'));
  await selectSettingsSection(shell, 'about');
  await shell.locator('#version').waitFor({ state: 'visible' });
  await showWorkspace(shell, origin);
  assert.equal((await viewState(origin))?.id, original.id);
  await shell.locator('#workspace-header-title').getByText('测试会话').waitFor();
  assert.equal(await remote(origin, 'document.querySelector(".thread-row.selected")?.textContent.includes("测试会话")'), true, '设置往返未保留会话');
  assert.ok(await workbench.locator('.composer').evaluate(element => element.getBoundingClientRect().height) <= 96, '设置往返后输入框应保持紧凑');

  await workbench.locator('.cli-entry').click();
  await shell.getByRole('button', { name: '启动 Codex CLI' }).waitFor();
  assert.equal(await shell.locator('#workspace-cli-start').isVisible(), true);
  assert.equal(await shell.locator('#workspace-cli-stop').isVisible(), false);
  assert.equal(await workbench.locator('.cli-topbar').count(), 0, 'CLI 不应保留第二行顶部栏');
  await shell.getByRole('button', { name: '启动 Codex CLI' }).click();
  await waitFor(async () => spawned === 1, 'CLI 未启动');
  await workbench.getByRole('button', { name: '切换到 DSH，接入准备中' }).click();
  await workbench.getByRole('heading', { name: 'DSH 接入准备中' }).waitFor();
  await shell.locator('#workspace-header-title').getByText('接入准备中').waitFor();
  assert.equal(await shell.locator('#workspace-cli-action').isHidden(), true);
  assert.equal(await shell.locator('#dock-search').isHidden(), true);
  assert.equal(killed, 0, '切换 DSH 不应结束 CLI');
  await capture('desktop-dsh-light.png', origin);
  await workbench.getByRole('button', { name: '切换到 Codex' }).click();
  await shell.getByRole('button', { name: '结束终端' }).waitFor();
  assert.equal(await shell.locator('#dock-search').isVisible(), true);
  assert.equal(killed, 0, '切回后应保留原终端');
  await showSettings(workbench, shell, 'gateway');
  assert.equal(killed, 0, '打开设置不能结束 CLI');
  await selectSettingsSection(shell, 'documentation');
  assert.equal(killed, 0, '打开文档不能结束 CLI');
  assert.equal((await viewState(origin))?.id, original.id);
  await showWorkspace(shell, origin);
  await shell.getByRole('button', { name: '结束终端' }).waitFor();
  assert.equal(await shell.locator('#workspace-cli-stop').isVisible(), true);

  await shell.locator('#shell-sidebar-open').click();
  await shell.waitForFunction(() => document.querySelector('#shell-sidebar-open')?.getAttribute('aria-expanded') === 'false');
  await waitFor(async () => await remote(origin, 'getComputedStyle(document.querySelector(".sidebar")).display') === 'none', 'Dock 无法收起侧边栏');
  assert.equal((await viewState(origin))?.visible, true, '收起侧边栏不应隐藏整个工作台');
  await shell.locator('#shell-sidebar-open').click();
  await workbench.locator('.workspace:visible .sidebar.open').waitFor();
  assert.equal((await viewState(origin))?.id, original.id);

  await showSettings(workbench, shell, 'interface');
  await setTheme(shell, origin, 'dark');
  await selectSettingsSection(shell, 'gateway');
  await captureShell('settings-gateway-dark.png');
  assert.equal(await shell.locator('#gateway-public-origin').inputValue(), 'https://gateway.example.test', '切换设置页和主题应保留地址草稿');
  await captureShell('settings-gateway-remote-dark.png');
  await selectSettingsSection(shell, 'documentation');
  await captureShell('settings-documentation-dark.png');
  await showWorkspace(shell, origin);
  assert.equal(await remote(origin, 'getComputedStyle(document.querySelector(".new-thread")).backgroundColor'), 'rgba(0, 0, 0, 0)', '深色新建会话也应保持透明底');
  await capture('merged-workspace-dark.png', origin);
  connectionMenu = await openDesktopConnectionMenu(shell);
  assert.equal(await connectionMenu.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await captureMenu('connection-menu-workspace-dark.png', origin);
  await pressClosingKey(connectionMenu, 'Escape');
  await shell.waitForFunction(() => document.querySelector('#connection-select')?.getAttribute('aria-expanded') === 'false');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(820, 600));
  await waitFor(async () => await shell.evaluate(() => innerWidth) === 820, '窗口未切换到最小尺寸');
  assert.equal(await remote(origin, 'Math.round(document.querySelector(".sidebar").getBoundingClientRect().width)'), 256);
  await remote(origin, `window.hajiminkWorkspace.setHeader({ kind: 'cli', name: 'Codex CLI', title: '一个非常长的项目名称'.repeat(20), status: '运行中', action: 'stop', dark: true })`);
  await shell.waitForFunction(() => document.querySelector('#workspace-header-title')?.textContent?.startsWith('一个非常长的项目名称'));
  await shell.evaluate(() => { (document.querySelector('#authorize') as HTMLButtonElement).hidden = false; (document.querySelector('#connection-status span') as HTMLElement).textContent = '很长的连接状态提示需要截断'.repeat(4); });
  const toolbarLayout = await shell.evaluate(() => {
    const ids = ['dock-brand', 'shell-sidebar-open', 'dock-search', 'connection-select', 'workspace-header-title', 'workspace-header-state', 'workspace-cli-action', 'connection-status', 'authorize', 'reload'];
    return ids.map(id => ({ id, element: document.getElementById(id)! })).filter(item => item.element.getClientRects().length).map(({ id, element }) => { const rect = element.getBoundingClientRect(); return { id, left: rect.left, right: rect.right, width: rect.width }; });
  });
  for (let index = 1; index < toolbarLayout.length; index++) assert.ok(toolbarLayout[index - 1].right <= toolbarLayout[index].left + 1, `Dock 控件重叠: ${JSON.stringify(toolbarLayout)}`);
  assert.ok(toolbarLayout.find(item => item.id === 'workspace-header-title')!.width >= 20, '会话标题没有足够的显示空间');
  const safeRight = process.platform === 'win32' ? 682 : 820;
  assert.ok(toolbarLayout.at(-1)!.right <= safeRight, `Dock 未避开原生窗口按钮: ${JSON.stringify(toolbarLayout)}`);
  await shell.evaluate(() => { (document.querySelector('#authorize') as HTMLButtonElement).hidden = true; });
  await capture('sidebar-workspace-min.png', origin);
  await showSettings(workbench, shell, 'gateway');
  assert.equal(await shell.locator('.settings-layout').evaluate(element => getComputedStyle(element).flexDirection), 'column', '窄窗口设置导航应转为顶部页签');
  const gatewayBounds = await shell.locator('#gateway').evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
  assert.ok(gatewayBounds.scrollWidth <= gatewayBounds.width + 1, '窄窗口远程设置不应横向溢出');
  await captureShell('settings-gateway-min-dark.png');
  await selectSettingsSection(shell, 'documentation');
  const documentationBounds = await shell.locator('#settings-documentation').evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
  assert.ok(documentationBounds.scrollWidth <= documentationBounds.width + 1, '窄窗口文档不应横向溢出');
  await captureShell('settings-documentation-min-dark.png');
  await showWorkspace(shell, origin);
  workbench.once('dialog', dialog => void dialog.accept());
  await shell.getByRole('button', { name: '结束终端' }).click();
  await waitFor(async () => killed === 1, 'Dock 停止按钮未结束测试终端');
  await workbench.locator('.thread-row').first().click();
  const narrowHeight = await workbench.locator('.composer').evaluate(element => element.getBoundingClientRect().height);
  assert.ok(narrowHeight <= 120, `窄窗口输入框过高: ${narrowHeight}`);
  await messageInput.fill('第一行\n第二行\n第三行\n第四行');
  assert.ok(await messageInput.evaluate(element => element.scrollHeight <= element.clientHeight + 1), '窄窗口的多行草稿不应被截断');
  await messageInput.fill('');
  await capture('composer-desktop-shell-narrow.png', origin);

  await selectDesktopConnection(shell, secondConnection);
  await waitFor(async () => (await viewState(origin))?.id !== original.id && !!(await viewState(origin))?.visible, '切换连接后工作区未重新加载');
  await new Promise(resolve => setTimeout(resolve, 350));
  await selectDesktopConnection(shell, firstConnection);
  await waitFor(async () => (await shell.evaluate(() => (window as any).hajimink.state())).selected === firstConnection, '无法切回原连接');
  assert.equal(new ConnectionStore(temp, 'linux').snapshot().theme, 'dark', '主题未持久化到桌面配置');
  console.log('PASS desktop Dock/settings: global native theme, six settings sections, shared documentation, preserved session and CLI, Dock search/sidebar, connection menu and minimum window (fixtures only)');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await app?.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) if (win.webContents.getURL().startsWith('hajimink://app/page-menu.html?')) win.destroy(); }).catch(() => {});
  await app?.close().catch(() => {});
  await gateway?.app.close().catch(() => {});
  process.chdir(root); removeTempFixture(temp, 'hajimink-sidebar-ui-');
});
