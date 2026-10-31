'use strict';
const { selectDesktopPage } = require('./desktop-page-menu.cjs');
// Read-only integration: the disposable gateway connects to the existing desktop but never sends, modifies or interrupts a conversation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { ConnectionStore } = require('../desktop/connections.cjs');
const root = path.resolve(__dirname, '..');
const stage = path.join(root, '.local', 'hajimink-stage');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-gateway-test-'));
const requireReadOnly = process.argv.includes('--require-read-only');
const requireLimited = process.argv.includes('--require-limited');
const requireConnected = process.argv.includes('--require-connected') || requireReadOnly || requireLimited;
const testThread = process.env.HAJIMINK_READONLY_THREAD_ID;
const expectedText = process.env.HAJIMINK_READONLY_EXPECT_TEXT;
let app, gateway;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { freePort } = require('./test-network.cjs');
(async () => {
  if (!fs.existsSync(path.join(stage, 'dist', 'index.html')) || !fs.existsSync(path.join(stage, 'dist-server', 'index.js'))) throw new Error('请先运行 npm run build:desktop:fixture');
  const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
  const config = path.join(temp, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ mode: 'local', port, publicOrigin: origin }));
  gateway = spawn(process.execPath, [path.join(stage, 'dist-server', 'index.js'), '--config', config, '--data-dir', path.join(temp, 'gateway')], { cwd: stage, windowsHide: true, stdio: 'ignore' });
  let health;
  for (let i = 0; i < 120; i++) {
    if (gateway.exitCode !== null) throw new Error(`测试网关提前退出，退出码 ${gateway.exitCode}`);
    try { const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { health = await response.json(); break; } } catch {}
    await delay(250);
  }
  assert.ok(health?.ok, 'test gateway should start');
  if (requireConnected) assert.equal(health.desktop.connected, true, `real Codex connection required: ${health.desktop.reason || 'not connected'}`);
  if (requireReadOnly) assert.equal(health.desktop.accessMode, 'read-only', 'the real desktop must be connected in read-only mode');
  if (requireLimited) assert.equal(health.desktop.accessMode, 'limited', 'the real desktop must be connected in limited mode');
  if (testThread) assert.equal(health.desktop.connected, true, 'a selected real test conversation requires a connected desktop');
  const isReadOnly = health.desktop.connected && health.desktop.accessMode === 'read-only';
  const isLimited = health.desktop.connected && health.desktop.accessMode === 'limited';
  let expectedThreads = 0, expectedTitle;
  if (health.desktop.connected) {
    const catalog = await fetch(`${origin}/api/threads`, { signal: AbortSignal.timeout(30000) });
    assert.equal(catalog.status, 200, 'the read-only conversation catalog should be available');
    const threads = (await catalog.json()).threads;
    expectedThreads = threads.length;
    if (testThread) {
      const entry = threads.find(item => item.id === testThread);
      assert.ok(entry, 'the explicitly selected test conversation must appear in the real catalog');
      expectedTitle = entry.title;
      const read = await fetch(`${origin}/api/threads/${encodeURIComponent(testThread)}`, { signal: AbortSignal.timeout(30000) });
      assert.equal(read.status, 200, 'the selected conversation should be readable');
      const value = (await read.json()).thread;
      assert.equal(value.id, testThread); assert.equal(value.live, true, 'the selected real conversation must yield a live snapshot');
      assert.ok(Array.isArray(value.turns), 'the normalized conversation should contain a turns array');
    }
    if (isReadOnly) {
      const sessionResponse = await fetch(`${origin}/api/session`); const csrf = (await sessionResponse.json()).csrf;
      const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
      const id = require('node:crypto').randomUUID();
      const response = await fetch(`${origin}/api/threads/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'origin': origin, 'cookie': cookie, 'x-agent-control-csrf': csrf }, body: JSON.stringify({ operationId: require('node:crypto').randomUUID(), prompt: 'compatibility guard probe' }) });
      assert.equal(response.status, 409, 'writes must be rejected for this version');
      assert.equal((await response.json()).error.code, 'DESKTOP_READ_ONLY');
    }
    if (isLimited) {
      const sessionResponse = await fetch(`${origin}/api/session`); const csrf = (await sessionResponse.json()).csrf;
      const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
      const id = require('node:crypto').randomUUID();
      for (const [route, body] of [[`/api/threads/${id}/settings`, { model: 'fixture' }], [`/api/threads/${id}/requests/fixture-request`, { turnId: 'fixture-turn', decision: 'decline' }]]) {
        const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie, 'x-agent-control-csrf': csrf }, body: JSON.stringify({ operationId: require('node:crypto').randomUUID(), ...body }) });
        assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'DESKTOP_UNVERIFIED');
      }
    }
  }
  const uiData = path.join(temp, 'ui'); const store = new ConnectionStore(uiData, 'linux'); store.add({ name: '隔离测试网关', url: origin });
  app = await electron.launch({ executablePath: require('electron'), args: ['.', `--hajimink-data-dir=${uiData}`], cwd: root, timeout: 60000 });
  const page = await app.firstWindow(); await page.waitForFunction(() => !!document.querySelector('#connection-select')?.dataset.selected);
  let result;
  for (let i = 0; i < 100; i++) {
    result = await app.evaluate(async ({ webContents }, origin) => {
      const content = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().startsWith(origin));
      if (!content) return null;
      return content.executeJavaScript(`({hasWorkspace:!!document.querySelector('.workspace'),hasSidebar:!!document.querySelector('.sidebar'), connected:document.querySelector('.sidebar-footer strong')?.textContent?.startsWith('Windows 已连接'), readOnly:document.querySelector('.sidebar-footer strong')?.textContent?.includes('只读'), limited:document.querySelector('.sidebar-footer strong')?.textContent?.includes('部分可用'), threads:document.querySelectorAll('.thread-row').length, banner:!!document.querySelector('.connection-banner'), bannerText:document.querySelector('.connection-banner')?.textContent || '', newDisabled:document.querySelector('.new-thread')?.disabled, sendDisabled:document.querySelector('.send-button')?.disabled})`);
    }, origin).catch(() => null);
    if (result?.hasWorkspace && (!health.desktop.connected || (result.connected && (isReadOnly ? result.readOnly && result.banner && result.bannerText.includes('仅支持查看') && result.newDisabled && result.sendDisabled : isLimited ? result.limited && result.banner && result.bannerText.includes('项目内新建') && !result.newDisabled && result.sendDisabled : !result.banner) && (expectedThreads === 0 || result.threads > 0)))) break;
    await delay(200);
  }
  assert.ok(result?.hasWorkspace && result?.hasSidebar, 'existing React workbench should load in the desktop view');
  if (health.desktop.connected) {
    assert.ok(result.connected, 'workbench should establish its live connection to the real desktop adapter');
    if (isReadOnly) assert.ok(result.readOnly && result.banner && result.bannerText.includes('仅支持查看') && result.newDisabled && result.sendDisabled, 'read-only state must be visible and write controls disabled');
    else if (isLimited) assert.ok(result.limited && result.banner && result.bannerText.includes('项目内新建') && !result.newDisabled && result.sendDisabled, 'limited mode must explain the remaining restrictions');
    else assert.ok(!result.banner, 'the full-access connection should not show a warning');
    if (expectedThreads > 0) assert.ok(result.threads > 0, 'workbench should render the read-only catalog');
    if (expectedTitle) {
      const clicked = await app.evaluate(async ({ webContents }, args) => {
        const content = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().startsWith(args.origin));
        return content.executeJavaScript(`(() => { const row = [...document.querySelectorAll('.thread-row')].find(x => x.textContent.includes(${JSON.stringify(args.title)})); if (!row) return false; row.click(); return true; })()`);
      }, { origin, title: expectedTitle });
      assert.equal(clicked, true, 'the selected test conversation should be clickable in the workspace');
      let rendered = false;
      for (let i = 0; i < 80; i++) {
        rendered = await app.evaluate(async ({ webContents }, origin) => {
          const content = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().startsWith(origin));
          return content.executeJavaScript(`!!document.querySelector('.conversation-content .turn') && !document.querySelector('.loading-state')`);
        }, origin);
        if (rendered) break; await delay(250);
      }
      assert.ok(rendered, 'real conversation content should render in the isolated UI');
      if (expectedText) {
        const textRendered = await app.evaluate(async ({ webContents }, args) => {
          const content = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().startsWith(args.origin));
          return content.executeJavaScript(`document.querySelector('.conversation-content')?.textContent.includes(${JSON.stringify(args.text)}) || false`);
        }, { origin, text: expectedText });
        assert.equal(textRendered, true, 'known text from the selected conversation must be visible');
      }
    }
  }
  await selectDesktopPage(page, 'settings'); await selectDesktopPage(page, 'workspace');
  const afterSwitch = await app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().some(w => !w.isDestroyed() && w.getURL().startsWith(origin)), origin);
  assert.equal(afterSwitch, true, 'switching shell pages must keep the workbench connected');
  console.log(JSON.stringify({ fixtureGateway: 'passed', sharedReactWorkbench: 'passed', realAgentReadOnlyConnection: health.desktop.connected ? 'passed' : 'not connected', liveConnection: result.connected && (isReadOnly ? result.readOnly && result.banner : isLimited ? result.limited && result.banner : !result.banner) ? 'passed' : 'not verified', readOnlyMode: isReadOnly ? 'passed' : 'not checked', limitedMode: isLimited ? 'passed' : 'not checked', selectedRealThread: testThread ? 'passed' : 'not checked', visibleThreadCount: result.threads, apiThreadCount: expectedThreads, writeActions: 0 }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close().catch(() => {});
  if (gateway && gateway.exitCode === null) { gateway.kill(); await Promise.race([new Promise(resolve => gateway.once('exit', resolve)), delay(3000)]); }
  const resolved = fs.realpathSync(temp), tempRoot = fs.realpathSync(os.tmpdir());
  if (!resolved.startsWith(tempRoot + path.sep) || !path.basename(resolved).startsWith('hajimink-gateway-test-')) throw new Error('Unexpected test directory');
  fs.rmSync(resolved, { recursive: true, force: true });
});
