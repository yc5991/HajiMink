/** Exercises the workbench against a disposable gateway and fake desktop/terminal. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { buildApp } from '../server/app';
import { removeTempFixture } from '../tests/safe-temp';

const root = path.resolve(import.meta.dirname, '..');
const stage = path.join(root, '.local', 'hajimink-stage');
const artifacts = process.env.HAJIMINK_SMOKE_ARTIFACTS || path.join(stage, 'smoke-artifacts');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-workspace-ui-'));
let browser: Browser | undefined, gateway: Awaited<ReturnType<typeof buildApp>> | undefined;
const status = { connected: true, compatible: true, accessMode: 'full' as const, version: '26.1023.6123.0', supportedVersion: '26.x' };
const projects = [{ id: 'project-1', name: '测试项目', path: temp, hostId: 'local' }];
const threads = [{ id: 'thread-fixture-1', title: '测试会话', projectId: 'project-1', status: 'idle', updatedAt: Date.now() }, ...Array.from({ length: 40 }, (_, index) => ({ id: `thread-extra-${index}`, title: `测试记录 ${index}`, projectId: 'project-1', status: 'idle', updatedAt: Date.now() - index - 1 }))];
const longReply = `\`\`\`text\n${'fixture-code-'.repeat(80)}\n\`\`\`\n\n${Array.from({ length: 45 }, (_, index) => `测试回复 ${index}：${'这是一段用来检查长会话滚动的文字。'.repeat(4)}`).join('\n\n')}`;
const view = { id: 'thread-fixture-1', title: '测试会话', revision: 1, live: true, status: 'idle', model: 'model-a', effort: 'high', permissionLabel: 'test', turns: [{ id: 'turn-1', status: 'completed', startedAt: Date.now(), items: [{ id: 'item-1', type: 'assistant' as const, text: longReply }] }], totalTurns: 1, olderCursor: null, requests: [] };
const settings: Array<{ id: string; model: string; effort?: string }> = [];
const adapter = Object.assign(new EventEmitter(), {
  status, close() {}, touch() {},
  catalog: async () => ({ projects, threads }),
  models: () => [{ id: 'model-a', efforts: ['medium', 'high'] }, { id: 'model-b', efforts: ['low', 'high'] }, { id: 'model-c', efforts: [] }],
  view: async () => view, viewCached: () => view,
  settings: async (id: string, model: string, effort?: string) => { settings.push({ id, model, effort }); return { accepted: true }; },
});
const inputs: string[] = [];
let spawnedCwd = '', killed = 0;
const cliSpawn = (cwd: string) => {
  spawnedCwd = cwd;
  let output: (text: string) => void = () => {};
  return {
    onData(callback: (text: string) => void) { output = callback; queueMicrotask(() => output(`Fixture terminal ready\r\n${Array.from({ length: 180 }, (_, index) => `fixture-terminal-line-${index}`).join('\r\n')}\r\n`)); },
    onExit() {},
    write(value: string) { inputs.push(value); output(value); },
    resize() {}, kill() { killed++; },
  } as any;
};
async function noOverflow(page: Page) {
  const value = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(value.scrollWidth <= value.width + 1, `page overflowed: ${JSON.stringify(value)}`);
}
async function assertHiddenScrollbar(locator: Locator) {
  const style = await locator.evaluate(element => ({ width: getComputedStyle(element).scrollbarWidth, webkit: getComputedStyle(element, '::-webkit-scrollbar').display }));
  assert.deepEqual(style, { width: 'none', webkit: 'none' });
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Expected fixture action did not occur');
}
async function composerMetrics(page: Page) {
  return page.locator('.composer').evaluate(form => {
    const input = form.querySelector('textarea')!;
    const rect = form.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const buttonRect = form.querySelector('.send-button')!.getBoundingClientRect();
    return { height: rect.height, inputHeight: inputRect.height, scrollHeight: input.scrollHeight, clientHeight: input.clientHeight, maxHeight: parseFloat(getComputedStyle(input).maxHeight), buttonTop: buttonRect.top, inputBottom: inputRect.bottom };
  });
}
async function checkComposer(page: Page, mobile: boolean) {
  const input = page.getByLabel('消息输入框');
  await input.fill('');
  const empty = await composerMetrics(page);
  assert.ok(empty.height <= (mobile ? 120 : 96), `空白输入框应保持紧凑: ${JSON.stringify(empty)}`);
  assert.ok(mobile || empty.inputBottom <= empty.buttonTop + 1, '输入框和操作按钮不应重叠');
  await input.fill('第一行\n第二行\n第三行\n第四行');
  const multiline = await composerMetrics(page);
  assert.ok(multiline.inputHeight > empty.inputHeight + 25, `多行输入应自动展开: ${JSON.stringify(multiline)}`);
  assert.ok(multiline.scrollHeight <= multiline.clientHeight + 1, '未达到上限时文字不应被截断');
  await input.fill(Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行测试草稿`).join('\n'));
  const long = await composerMetrics(page);
  assert.ok(long.inputHeight <= long.maxHeight + 1, '长消息不应无限撑高输入框');
  assert.ok(long.scrollHeight > long.clientHeight, '达到上限后长消息应能滚动');
  await assertHiddenScrollbar(input);
  if (!mobile) {
    await input.evaluate(element => { element.scrollTop = 0; });
    await input.hover(); await page.mouse.wheel(0, 180);
    await page.waitForFunction(() => document.querySelector('.composer textarea')!.scrollTop > 0);
  }
  await input.fill('');
  const cleared = await composerMetrics(page);
  assert.ok(Math.abs(cleared.height - empty.height) <= 1, `清空后应恢复紧凑高度: ${JSON.stringify(cleared)}`);
}
async function main() {
  if (!fs.existsSync(path.join(stage, 'dist', 'index.html'))) throw new Error('请先构建隔离工作台');
  fs.mkdirSync(artifacts, { recursive: true });
  process.chdir(stage);
  gateway = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://localhost:3000', dataDir: path.join(temp, 'db') }, { adapter: adapter as any, cliSpawn });
  await gateway.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (gateway.app.server.address() as { port: number }).port;
  const launch = process.env.HAJIMINK_BROWSER ? { executablePath: process.env.HAJIMINK_BROWSER } : process.platform === 'win32' ? { channel: 'msedge' } : {};
  browser = await chromium.launch({ headless: true, ...launch });
  const desktop = await browser.newContext({ viewport: { width: 1320, height: 850 } });
  const page = await desktop.newPage(); await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('.workspace[data-stream-state="online"]').waitFor();
  await page.locator('.thread-row').first().click();
  await page.locator('.breadcrumb strong').getByText('测试会话').waitFor();
  assert.equal(await page.locator('.harness-rail').count(), 0);
  assert.equal(await page.locator('.search-field').count(), 0);
  assert.equal(await page.locator('.connection-banner').count(), 0);
  assert.equal(await page.getByRole('button', { name: '会话设置', exact: true }).count(), 0);
  await noOverflow(page);
  await assertHiddenScrollbar(page.locator('.thread-list'));
  await page.locator('.thread-list').hover(); await page.mouse.wheel(0, 260);
  await page.waitForFunction(() => document.querySelector('.thread-list')!.scrollTop > 0);
  const conversation = page.locator('.conversation-scroll');
  await assertHiddenScrollbar(conversation);
  assert.ok(await conversation.evaluate(element => element.scrollHeight > element.clientHeight));
  await conversation.evaluate(element => { element.scrollTop = 0; });
  await conversation.hover({ position: { x: 8, y: 20 } }); await page.mouse.wheel(0, 300);
  await page.waitForFunction(() => document.querySelector('.conversation-scroll')!.scrollTop > 0);
  await conversation.evaluate(element => { element.scrollTop = 0; }); await conversation.focus(); await page.keyboard.press('PageDown');
  await page.waitForFunction(() => document.querySelector('.conversation-scroll')!.scrollTop > 0);
  const code = page.locator('.code-block pre');
  await assertHiddenScrollbar(code);
  assert.ok(await code.evaluate(element => element.scrollWidth > element.clientWidth), '长代码应允许横向滚动');
  await code.focus(); await code.evaluate(element => { element.scrollLeft = 0; }); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('.code-block pre')!.scrollLeft > 0);
  await checkComposer(page, false);
  await page.screenshot({ path: path.join(artifacts, 'composer-desktop-empty.png') });
  await page.getByLabel('消息输入框').fill('中'.repeat(155));
  const wideComposer = await composerMetrics(page);
  await page.setViewportSize({ width: 1024, height: 850 });
  await page.waitForFunction(() => {
    const input = document.querySelector('.composer textarea') as HTMLTextAreaElement;
    return input.scrollHeight <= input.clientHeight + 1;
  });
  const narrowComposer = await composerMetrics(page);
  assert.ok(narrowComposer.inputHeight > wideComposer.inputHeight + 10, `窗口变窄后换行应带动输入框展开: ${JSON.stringify({ wideComposer, narrowComposer })}`);
  await page.setViewportSize({ width: 1320, height: 850 });
  await page.waitForFunction(previous => document.querySelector('.composer textarea')!.getBoundingClientRect().height < previous - 10, narrowComposer.inputHeight);
  await page.getByLabel('消息输入框').fill('');
  await page.screenshot({ path: path.join(artifacts, 'workspace-desktop.png') });
  await page.getByRole('button', { name: '搜索项目和会话' }).click();
  await page.getByRole('textbox', { name: '搜索项目和会话' }).fill('测试');
  const searchResults = page.locator('.search-results'); await assertHiddenScrollbar(searchResults);
  await searchResults.hover(); await page.mouse.wheel(0, 300);
  await page.waitForFunction(() => document.querySelector('.search-results')!.scrollTop > 0);
  await page.getByRole('textbox', { name: '搜索项目和会话' }).fill('测试会话');
  await page.locator('.search-dialog').getByText('测试会话', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'workspace-search.png') });
  await page.getByRole('button', { name: '关闭搜索' }).click();
  await page.getByRole('button', { name: '选择模型' }).click();
  await page.getByRole('menu', { name: '模型选择' }).waitFor();
  await assertHiddenScrollbar(page.locator('.model-menu'));
  await page.screenshot({ path: path.join(artifacts, 'workspace-model.png') });
  await page.getByRole('menuitemradio', { name: 'model-b' }).click();
  await waitFor(() => settings.length === 1);
  assert.deepEqual(settings[0], { id: 'thread-fixture-1', model: 'model-b', effort: 'high' });
  assert.equal(await page.locator('.sidebar').isVisible(), true, '切换模型不应收起侧边栏');
  await page.getByRole('button', { name: '选择模型' }).click();
  await page.locator('.model-menu button:not([disabled])').first().waitFor();
  await page.getByRole('menuitemradio', { name: 'low', exact: true }).click();
  await waitFor(() => settings.length === 2);
  assert.deepEqual(settings[1], { id: 'thread-fixture-1', model: 'model-b', effort: 'low' });
  await page.getByRole('button', { name: '选择模型' }).click();
  await page.locator('.model-menu button:not([disabled])').first().waitFor();
  await page.getByRole('menuitemradio', { name: 'model-c' }).click();
  await waitFor(() => settings.length === 3);
  assert.deepEqual(settings[2], { id: 'thread-fixture-1', model: 'model-c', effort: undefined });
  await page.getByRole('button', { name: '关闭导航' }).click();
  assert.equal(await page.locator('.sidebar').isVisible(), false);
  await page.getByRole('button', { name: '打开项目和会话' }).click();
  const preservedDraft = '第一行\n第二行\n第三行\n第四行';
  await page.getByLabel('消息输入框').fill(preservedDraft);
  await page.locator('.cli-entry').click();
  await page.locator('.thread-row').first().click();
  assert.equal(await page.getByLabel('消息输入框').inputValue(), preservedDraft, '切换终端不应丢失草稿');
  const restored = await composerMetrics(page);
  assert.ok(restored.scrollHeight <= restored.clientHeight + 1, '返回会话时草稿应完整显示');
  await page.getByLabel('消息输入框').fill('切换应用时保留的草稿');
  await page.locator('.cli-entry').click();
  await page.getByRole('button', { name: '启动 Codex CLI' }).click();
  await page.getByRole('status').getByText('运行中').waitFor();
  await page.locator('.xterm-rows').getByText('fixture-terminal-line-179', { exact: true }).waitFor();
  await assertHiddenScrollbar(page.locator('.xterm-viewport'));
  assert.equal(await page.locator('.xterm-scrollable-element > .scrollbar').first().evaluate(element => getComputedStyle(element).visibility), 'hidden');
  const terminalBefore = await page.locator('.xterm-rows').textContent();
  await page.locator('.xterm-screen').hover(); await page.mouse.wheel(0, -500);
  await page.waitForFunction(previous => document.querySelector('.xterm-rows')?.textContent !== previous, terminalBefore);
  await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('hello');
  await waitFor(() => inputs.join('').includes('hello'));
  assert.equal(spawnedCwd, temp);
  const helpOpened = desktop.waitForEvent('page');
  await page.getByRole('link', { name: '文档（新标签页）' }).click();
  const help = await helpOpened;
  await help.getByRole('heading', { name: '文档', exact: true }).waitFor();
  await help.getByRole('heading', { name: '自建服务器', exact: true }).waitFor();
  await noOverflow(help);
  await help.screenshot({ path: path.join(artifacts, 'documentation-web-desktop.png') });
  await help.close();
  assert.equal(killed, 0, '打开网页文档不能结束原标签页中的 CLI');
  await page.locator('.xterm-rows').getByText('hello').first().waitFor();
  await page.getByRole('button', { name: '切换到 DSH，接入准备中' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'DSH 接入准备中' }).waitFor();
  assert.equal(await page.locator('.workspace:visible').getByLabel('消息输入框').count(), 0);
  assert.equal(await page.locator('.workspace:visible').getByRole('button', { name: '新建会话' }).count(), 0);
  await page.keyboard.press('Control+k');
  assert.equal(await page.locator('.search-dialog:visible').count(), 0, '未接入的应用不应打开搜索');
  assert.equal(killed, 0, '切换应用不应结束运行中的 CLI');
  await page.emulateMedia({ colorScheme: 'light' });
  const codexMark = page.getByRole('button', { name: '切换到 Codex' }).locator('svg');
  await codexMark.waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(artifacts, 'workspace-dsh-desktop.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await codexMark.isVisible(), true, '深色主题中的 Codex 图标必须可见');
  await page.screenshot({ path: path.join(artifacts, 'workspace-dsh-dark.png') });
  await page.emulateMedia({ colorScheme: 'no-preference' });
  await page.getByRole('button', { name: '切换到 Codex' }).click();
  await page.locator('.xterm-rows').getByText('hello').first().waitFor();
  assert.equal(killed, 0, '切回 Codex 必须继续原终端');
  await page.locator('.thread-row').first().click();
  assert.equal(await page.getByLabel('消息输入框').inputValue(), '切换应用时保留的草稿');
  await page.locator('.cli-entry').click();
  await page.screenshot({ path: path.join(artifacts, 'workspace-terminal.png') });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '结束终端' }).click();
  await waitFor(() => killed === 1);
  await desktop.close();

  const mobile = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  const mobilePage = await mobile.newPage(); await mobilePage.goto(`http://127.0.0.1:${port}`);
  await mobilePage.locator('.workspace[data-stream-state="online"]').waitFor();
  await noOverflow(mobilePage);
  await checkComposer(mobilePage, true);
  await mobilePage.screenshot({ path: path.join(artifacts, 'composer-mobile-empty.png') });
  await mobilePage.screenshot({ path: path.join(artifacts, 'workspace-mobile.png') });
  assert.equal(await mobilePage.locator('.model-chip').count(), 1, '手机工作台应显示模型选择入口');
  assert.equal(await mobilePage.getByRole('button', { name: '会话设置', exact: true }).count(), 0);
  await mobilePage.getByRole('button', { name: '选择模型' }).click();
  await mobilePage.getByRole('menu', { name: '模型选择' }).waitFor();
  await mobilePage.keyboard.press('Escape');
  await mobilePage.getByRole('button', { name: '打开项目和会话' }).click();
  await mobilePage.getByRole('button', { name: '搜索项目和会话' }).click();
  await mobilePage.getByRole('textbox', { name: '搜索项目和会话' }).fill('测试');
  await noOverflow(mobilePage);
  await mobilePage.screenshot({ path: path.join(artifacts, 'workspace-search-mobile.png') });
  await mobilePage.getByRole('button', { name: '关闭搜索' }).click();
  await mobilePage.locator('.thread-row').first().click();
  await mobilePage.locator('.workspace:visible .sidebar').waitFor({ state: 'hidden' });
  const mobileConversation = mobilePage.locator('.conversation-scroll');
  await mobilePage.locator('.code-block pre').waitFor(); await assertHiddenScrollbar(mobileConversation);
  await mobileConversation.evaluate(element => { element.scrollTop = 0; });
  const box = await mobileConversation.boundingBox(); assert.ok(box);
  const touch = await mobile.newCDPSession(mobilePage);
  const x = box.x + box.width - 20, startY = box.y + box.height * .75;
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
  for (let step = 1; step <= 8; step++) { await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: startY - step * 28 }] }); await new Promise(resolve => setTimeout(resolve, 20)); }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await mobilePage.waitForFunction(() => document.querySelector('.conversation-scroll')!.scrollTop > 20);
  await touch.detach();
  await mobilePage.getByRole('button', { name: '打开项目和会话' }).click();
  await mobilePage.getByRole('button', { name: '切换到 DSH，接入准备中' }).click();
  await mobilePage.getByRole('heading', { name: 'DSH 接入准备中' }).waitFor();
  assert.equal(await mobilePage.locator('.workspace:visible').getByRole('button', { name: '新建会话' }).count(), 0);
  await noOverflow(mobilePage);
  await mobilePage.screenshot({ path: path.join(artifacts, 'workspace-dsh-mobile.png') });
  await mobilePage.getByRole('button', { name: '打开项目和会话' }).click();
  await mobilePage.getByRole('button', { name: '切换到 Codex' }).click();
  await mobilePage.getByRole('button', { name: '打开项目和会话' }).click();
  await mobilePage.locator('.cli-entry').click();
  await mobilePage.locator('.workspace:visible .sidebar').waitFor({ state: 'hidden' });
  await mobilePage.getByRole('button', { name: '启动 Codex CLI' }).waitFor();
  await noOverflow(mobilePage);
  await mobilePage.screenshot({ path: path.join(artifacts, 'workspace-terminal-mobile.png') });
  await mobilePage.getByRole('button', { name: '打开项目和会话' }).click();
  const mobileHelpOpened = mobile.waitForEvent('page');
  await mobilePage.getByRole('link', { name: '文档（新标签页）' }).click();
  const mobileHelp = await mobileHelpOpened;
  await mobileHelp.getByRole('heading', { name: '文档', exact: true }).waitFor();
  await noOverflow(mobileHelp);
  await mobileHelp.screenshot({ path: path.join(artifacts, 'documentation-web-mobile.png') });
  await mobileHelp.close();
  await mobile.close();
  console.log('PASS workspace: hidden scrollbars, wheel/keyboard/touch scrolling, terminal scrollback, compact composer and desktop/mobile interactions (fixtures only)');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close().catch(() => {});
  await gateway?.app.close().catch(() => {});
  process.chdir(root); removeTempFixture(temp, 'hajimink-workspace-ui-');
});
