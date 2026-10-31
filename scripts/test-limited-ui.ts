/** Browser checks for partially verified Codex capabilities; all Agent actions are fake. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { buildApp } from '../server/app';
import type { ThreadView } from '../shared/types';
import { removeTempFixture } from '../tests/safe-temp';

const root = path.resolve(import.meta.dirname, '..');
const stage = process.env.HAJIMINK_LIMITED_ASSET_ROOT ? path.resolve(process.env.HAJIMINK_LIMITED_ASSET_ROOT) : path.join(root, '.local', 'hajimink-stage');
const artifacts = path.join(root, '.local', 'hajimink-stage', 'smoke-artifacts');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-limited-ui-'));
let browser: Browser | undefined, gateway: Awaited<ReturnType<typeof buildApp>> | undefined;
let mode: 'idle' | 'active' | 'history' = 'idle', revision = 1;
const actions: { name: string; args: unknown[] }[] = [];
function view(): ThreadView {
  return { id: 'fixture-thread', title: '测试会话', epoch: 'fixture-owner', revision, live: mode !== 'history', status: mode === 'active' ? 'waiting' : 'idle', ...(mode === 'active' ? { activeTurnId: 'fixture-turn' } : {}), model: 'fixture-model', effort: 'high', permissionLabel: 'readOnly', turns: [{ id: 'fixture-turn', status: mode === 'active' ? 'inProgress' : 'completed', startedAt: 1, items: [{ id: 'item', type: 'assistant', text: '测试内容' }] }], totalTurns: 1, olderCursor: null, requests: mode === 'active' ? [{ id: 'fixture-request', turnId: 'fixture-turn', kind: 'command', title: '批准执行命令', detail: '测试操作' }] : [] };
}
const adapter = Object.assign(new EventEmitter(), {
  status: { connected: true, compatible: true, accessMode: 'limited' as const, version: '26.1023.6123.0', supportedVersion: '26.1021.3705.0', reason: '支持项目内新建、空闲会话发送和停止；追加消息、模型设置和审批请在 Codex 中处理' },
  close() {}, touch() {}, models: () => [{ id: 'fixture-model', efforts: ['high'] }],
  catalog: async () => ({ projects: [{ id: 'project-1', name: '项目 A', path: 'D:/fixture', hostId: 'local' }], threads: [{ id: 'fixture-thread', title: '测试会话', projectId: 'project-1', status: 'idle', updatedAt: 1 }] }),
  view: async () => view(), viewCached: () => view(),
  create: async (...args: unknown[]) => { actions.push({ name: 'create', args }); return { accepted: true, threadId: 'fixture-thread' }; },
  send: async (...args: unknown[]) => { actions.push({ name: 'send', args }); return { accepted: true, threadId: 'fixture-thread' }; },
  interrupt: async (...args: unknown[]) => { actions.push({ name: 'interrupt', args }); return { accepted: true }; },
  settings: async (...args: unknown[]) => { actions.push({ name: 'settings', args }); return {}; }, respond: async (...args: unknown[]) => { actions.push({ name: 'respond', args }); return {}; },
});
async function openSidebar(page: Page, mobile: boolean) { if (mobile) await page.getByRole('button', { name: '打开项目和会话' }).click(); }
async function selectProject(page: Page, mobile: boolean) {
  await openSidebar(page, mobile);
  if (mobile) await page.locator('.mobile-project-picker').click();
  await page.locator('.project-row').filter({ hasText: '项目 A' }).click();
  if (mobile) await page.getByRole('button', { name: '关闭导航' }).click();
}
async function selectThread(page: Page, mobile: boolean) { await openSidebar(page, mobile); await page.locator('.thread-row').filter({ hasText: '测试会话' }).click(); }
async function checkViewport(width: number, height: number, dark: boolean) {
  const mobile = width < 600; mode = 'idle'; revision++;
  gateway!.store.setPreferences({ selectedThread: null, selectedProject: null });
  const context = await browser!.newContext({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light' });
  const page = await context.newPage(); const address = gateway!.app.server.address() as net.AddressInfo;
  await page.goto(`http://127.0.0.1:${address.port}`); await page.locator('.workspace[data-stream-state="online"]').waitFor({ timeout: 15000 });
  await page.locator('.connection-banner').getByText(/项目内新建/).waitFor();
  await page.getByLabel('消息输入框').fill('测试草稿，不会发送');
  assert.equal(await page.locator('.send-button').isDisabled(), true);
  await page.locator('.compatibility-note').getByText('请先选择已有项目，再新建会话').waitFor();
  await selectProject(page, mobile); await page.locator('.compatibility-note').waitFor({ state: 'hidden' });
  await page.waitForTimeout(150); // Let the per-project draft selection settle before typing.
  await page.getByLabel('消息输入框').fill('测试草稿，不会发送');
  try { await page.locator('.send-button:not([disabled])').waitFor({ timeout: 10000 }); } catch (error) { console.error('limited-ui diagnostic', width, await page.evaluate(() => ({ draft: (document.querySelector('textarea') as HTMLTextAreaElement)?.value, note: document.querySelector('.compatibility-note')?.textContent, banner: document.querySelector('.connection-banner')?.textContent, error: document.querySelector('.error-banner')?.textContent, send: (document.querySelector('.send-button') as HTMLButtonElement)?.disabled, selectedProject: document.querySelector('.project-row.selected')?.textContent, sidebarOpen: document.querySelector('.sidebar')?.className }))); throw error; }
  assert.equal(await page.locator('.send-button').isEnabled(), true, 'a selected project should allow a new draft');
  await selectThread(page, mobile);
  await page.locator('.conversation-content').getByText('测试内容').waitFor({ timeout: 10000 });
  await page.getByLabel('消息输入框').fill('测试草稿，不会发送');
  await page.locator('.send-button:not([disabled])').waitFor({ timeout: 10000 });
  assert.equal(await page.locator('.send-button').isEnabled(), true, 'a live idle conversation should accept a draft');
  assert.equal(await page.getByRole('button', { name: '会话设置', exact: true }).count(), 0);
  await page.getByRole('button', { name: '选择模型' }).click();
  assert.equal(await page.getByRole('menuitemradio', { name: 'fixture-model' }).isDisabled(), true);
  assert.equal(await page.getByRole('menuitemradio', { name: 'high' }).isDisabled(), true);
  await page.locator('.connection-banner').getByText(/模型设置和审批请在 Codex 中处理/).waitFor();
  await page.keyboard.press('Escape');
  mode = 'active'; revision++; adapter.emit('thread', 'fixture-thread');
  await page.locator('.stop-button').waitFor({ timeout: 10000 });
  assert.equal(await page.locator('.stop-button').isEnabled(), true);
  assert.equal(await page.locator('.send-button').isDisabled(), true, 'active turns must not accept unverified steering');
  await page.locator('.compatibility-note').getByText(/执行中追加消息/).waitFor();
  assert.equal(await page.getByRole('button', { name: '允许本次' }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '拒绝', exact: true }).isDisabled(), true);
  const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(layout.scrollWidth <= layout.width + 1, 'compatibility guidance must not cause horizontal overflow');
  fs.mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, `limited-${mobile ? 'mobile' : 'desktop'}-${dark ? 'dark' : 'light'}.png`) });
  assert.deepEqual(actions, [], 'interface checks must never submit Agent actions');
  await context.close();
  // Saved-only conversations remain readable but cannot use the unverified fallback send path.
  mode = 'history'; revision++; gateway!.store.setPreferences({ selectedThread: 'fixture-thread', selectedProject: 'project-1' });
  const historyContext = await browser!.newContext({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light' });
  const historyPage = await historyContext.newPage(); await historyPage.goto(`http://127.0.0.1:${address.port}`);
  await historyPage.locator('.history-note').getByText(/请先在 Codex 桌面打开会话/).waitFor({ timeout: 15000 });
  await historyPage.getByLabel('消息输入框').fill('保留草稿');
  await historyPage.locator('.compatibility-note').getByText(/请先在 Codex 桌面打开该会话/).waitFor();
  assert.equal(await historyPage.locator('.send-button').isDisabled(), true);
  await historyContext.close();
}
// Exercise the complete UI -> gateway -> fake adapter path. No real Codex actions are used.
async function checkFakeActions() {
  mode = 'idle'; revision++; actions.length = 0;
  gateway!.store.setPreferences({ selectedThread: null, selectedProject: null });
  const context = await browser!.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage(); const address = gateway!.app.server.address() as net.AddressInfo;
  await page.goto(`http://127.0.0.1:${address.port}`); await page.locator('.workspace[data-stream-state="online"]').waitFor({ timeout: 15000 });
  await selectProject(page, false);
  await page.waitForTimeout(150);
  await page.getByLabel('消息输入框').fill('模拟创建');
  await page.locator('.send-button:not([disabled])').waitFor();
  const [created] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/threads' && r.request().method() === 'POST'),
    page.locator('.send-button').click(),
  ]);
  assert.equal(created.status(), 200); assert.equal((await created.json()).accepted, true);
  await page.locator('.conversation-content').getByText('测试内容').waitFor({ timeout: 10000 });
  assert.deepEqual(actions, [{ name: 'create', args: ['模拟创建', 'project-1', undefined, undefined] }]);

  await page.getByLabel('消息输入框').fill('模拟发送');
  await page.locator('.send-button:not([disabled])').waitFor({ timeout: 10000 });
  const [sent] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/threads/fixture-thread/messages' && r.request().method() === 'POST'),
    page.locator('.send-button').click(),
  ]);
  assert.equal(sent.status(), 200); assert.equal((await sent.json()).accepted, true);
  assert.deepEqual(actions[1], { name: 'send', args: ['fixture-thread', '模拟发送', undefined, undefined] });

  mode = 'active'; revision++; adapter.emit('thread', 'fixture-thread');
  await page.locator('.stop-button:not([disabled])').waitFor({ timeout: 10000 });
  const [stopped] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/threads/fixture-thread/interrupt' && r.request().method() === 'POST'),
    page.locator('.stop-button').click(),
  ]);
  assert.equal(stopped.status(), 200); assert.equal((await stopped.json()).accepted, true);
  assert.deepEqual(actions, [
    { name: 'create', args: ['模拟创建', 'project-1', undefined, undefined] },
    { name: 'send', args: ['fixture-thread', '模拟发送', undefined, undefined] },
    { name: 'interrupt', args: ['fixture-thread', 'fixture-turn'] },
  ]);
  await context.close();
}
async function main() {
  if (!fs.existsSync(path.join(stage, 'dist', 'index.html'))) throw new Error('请先构建隔离工作台');
  process.chdir(stage);
  gateway = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: path.join(temp, 'gateway') }, { adapter: adapter as any });
  await gateway.app.listen({ host: '127.0.0.1', port: 0 });
  const launch = process.env.HAJIMINK_BROWSER ? { executablePath: process.env.HAJIMINK_BROWSER } : process.platform === 'win32' ? { channel: 'msedge' } : {};
  browser = await chromium.launch({ headless: true, ...launch });
  await checkViewport(1200, 800, false); await checkViewport(360, 780, true);
  await checkFakeActions();
  console.log(JSON.stringify({ fakeAdapterOnly: true, projectRequired: 'passed', idleSend: 'passed', activeSteerBlocked: 'passed', savedOnlySendBlocked: 'passed', stopAvailable: 'passed', settingsAndApprovalsBlocked: 'passed', desktopAndMobileLayout: 'passed', fakeCreateSendAndStopThroughUi: 'passed', actualCodexWrites: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close().catch(() => {}); await gateway?.app.close().catch(() => {}); process.chdir(root); removeTempFixture(temp, 'hajimink-limited-ui-'); });
