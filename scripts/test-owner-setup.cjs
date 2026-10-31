'use strict';
const { selectDesktopPage, setGatewayEnabled } = require('./desktop-page-menu.cjs');
// End-to-end setup uses a disposable local HTTPS reverse proxy, test password and virtual authenticator.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { waitForShellState } = require('./wait-shell-state.cjs');
const { ControllerGatewayManager } = require('../desktop/controller-manager.cjs');
const { readBootstrap } = require('../desktop/gateway-manager.cjs');
const { ConnectionStore } = require('../desktop/connections.cjs');
const root = path.resolve(__dirname, '..');
const stage = path.join(root, '.local', 'hajimink-stage');
const binary = process.env.HAJIMINK_DESKTOP_BINARY || require('electron');
const packaged = !!process.env.HAJIMINK_DESKTOP_BINARY;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-owner-setup-'));
const userData = path.join(temp, '测试账号');
const password = 'fixture-only-password-2026';
let application, shellPage, certApplication, proxy, manager, localPort, proxyPort;
let holdBootstrap = false, heldBootstrap, spoofBootstrap = false, spoofCsrf;
let streamMode = 'forward', streamRequests = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { freePort } = require('./test-network.cjs');
async function waitForPage(predicate) {
  for (let i = 0; i < 160; i++) { const page = application.context().pages().find(predicate); if (page) return page; await delay(125); }
  throw new Error('找不到隔离测试工作台页面');
}
function localStatus(port, url, host) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: url, headers: { host }, timeout: 3000 }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    request.once('timeout', () => request.destroy(new Error('timeout'))); request.once('error', reject);
  });
}
(async () => {
  localPort = await freePort(); do { proxyPort = await freePort(); } while (proxyPort === localPort);
  const origin = `https://localhost:${proxyPort}`;
  const key = path.join(temp, 'fixture-key.pem'), cert = path.join(temp, 'fixture-cert.pem');
  const openssl = process.env.OPENSSL_BIN || 'C:/Program Files/Git/usr/bin/openssl.exe';
  const result = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { windowsHide: true, stdio: 'ignore' });
  assert.equal(result.status, 0, 'fixture TLS certificate generation');
  const args = [...(packaged ? [] : ['.']), '--ignore-certificate-errors', `--hajimink-data-dir=${userData}`, `--hajimink-gateway-port=${localPort}`];
  const appRoot = packaged ? path.join(path.dirname(binary), 'resources', 'gateway') : stage;
  const nodePath = packaged ? path.join(appRoot, 'runtime', 'node.exe') : binary;
  manager = new ControllerGatewayManager({ appRoot, dataDir: path.join(userData, 'gateway'), port: localPort, nodePath, runAsNode: !packaged, startTimeoutMs: 15000 });
  application = await electron.launch({ executablePath: binary, args, cwd: root, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, timeout: 60000 });
  shellPage = await application.firstWindow();
  await selectDesktopPage(shellPage, 'gateway');
  assert.equal(await shellPage.locator('#gateway-remote-fields').isHidden(), true);
  assert.equal(await shellPage.locator('#gateway-state-badge').textContent(), '未启动');
  assert.equal(await shellPage.locator('#tunnel-status-badge').textContent(), '未选择');
  assert.equal(await shellPage.locator('#gateway-provider').inputValue(), '');
  await shellPage.selectOption('#gateway-provider', 'self-hosted');
  await waitForShellState(shellPage, value => value.setup?.tunnelProvider === 'self-hosted');
  await shellPage.locator('#gateway-remote-fields').waitFor({ state: 'visible' });
  await shellPage.waitForFunction(() => document.querySelector('#tunnel-status-badge')?.textContent === '等待网关');
  let draftMode = 'owner';
  proxy = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ mode: draftMode, authenticated: false, csrf: 'a'.repeat(64) }));
  });
  await new Promise(resolve => proxy.listen(proxyPort, '127.0.0.1', resolve));
  await shellPage.fill('#gateway-public-origin', origin); await shellPage.click('#gateway-remote-test');
  await shellPage.locator('#gateway-remote-test-feedback').getByText(/尚未确认/).waitFor({ timeout: 12000 });
  assert.equal((await shellPage.evaluate(() => window.hajimink.state())).tunnel.state, 'waiting');
  draftMode = 'local'; await shellPage.click('#gateway-remote-test');
  await shellPage.locator('#gateway-remote-test-feedback').getByText(/立即关闭转发/).waitFor({ timeout: 12000 });
  proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); proxy = undefined;
  assert.equal(await localStatus(localPort, '/api/health', `127.0.0.1:${localPort}`).catch(() => 0), 0, 'choosing guidance must not start the gateway');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(820, 600));
  const layout = await shellPage.locator('#gateway').evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1, 'first-run gateway page must not overflow horizontally at the minimum window size');
  const screenshot = path.join(stage, 'smoke-artifacts', 'first-run-gateway.png'); fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  await shellPage.locator('#gateway-remote-fields').scrollIntoViewIfNeeded();
  await shellPage.emulateMedia({ colorScheme: 'light' }); await shellPage.screenshot({ path: screenshot });
  await shellPage.emulateMedia({ colorScheme: 'dark' }); await shellPage.screenshot({ path: path.join(stage, 'smoke-artifacts', 'first-run-remote-dark.png') });
  await shellPage.emulateMedia({ colorScheme: 'no-preference' });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 850));
  let selectedPort; do { selectedPort = await freePort(); } while (selectedPort === localPort || selectedPort === proxyPort);
  await shellPage.fill('#gateway-port-input', String(selectedPort)); await shellPage.click('#gateway-port-save');
  await shellPage.locator('#gateway-port-feedback').getByText(/已保存端口/).waitFor();
  localPort = selectedPort; manager.port = selectedPort;
  await setGatewayEnabled(shellPage, true);
  await shellPage.waitForFunction(() => document.querySelector('#gateway-state-badge')?.textContent === '正常', null, { timeout: 45000 });
  await shellPage.waitForFunction(() => document.querySelector('#tunnel-status-badge')?.textContent === '待保护');
  await shellPage.selectOption('#gateway-auth-method', 'passkey');
  assert.equal(await shellPage.locator('#gateway-passkey-start').evaluate(element => element.classList.contains('primary')), true);
  assert.equal(await shellPage.locator('#gateway-owner-enable').isHidden(), true);
  await shellPage.selectOption('#gateway-auth-method', 'password');
  const before = await shellPage.evaluate(() => window.hajimink.state());
  await shellPage.fill('#gateway-public-origin', origin); shellPage.once('dialog', dialog => dialog.accept()); await shellPage.click('#gateway-owner-enable');
  await shellPage.locator('#gateway-owner-feedback').getByText(/请先在本机账户页面设置密码/).waitFor({ timeout: 15000 });
  assert.equal((await shellPage.evaluate(() => window.hajimink.state())).gateway.pid, before.gateway.pid, 'missing password must not stop the local gateway');
  await shellPage.click('#gateway-account');
  const localPage = await waitForPage(page => page.url() === `http://127.0.0.1:${localPort}/account`);
  await localPage.getByRole('heading', { name: '设置本站登录' }).waitFor();
  assert.match(await localPage.locator('.account-intro').textContent(), /本机模式不会要求密码/);
  assert.equal(await localPage.getByRole('button', { name: '添加通行密钥' }).isDisabled(), true, 'IP-bound registration must not be advertised');
  await localPage.getByLabel('新密码', { exact: true }).fill(password); await localPage.getByLabel('确认新密码', { exact: true }).fill(password);
  await localPage.getByRole('button', { name: '保存密码' }).click(); await localPage.getByRole('status').filter({ hasText: '密码已保存' }).waitFor({ timeout: 15000 });
  await selectDesktopPage(shellPage, 'gateway'); await shellPage.locator('#gateway-remote-fields').waitFor({ state: 'visible' }); await shellPage.fill('#gateway-public-origin', origin);
  shellPage.once('dialog', dialog => dialog.accept()); await shellPage.click('#gateway-owner-enable');
  try { await shellPage.waitForFunction(() => document.querySelector('#gateway-auth-status')?.textContent?.includes('独立登录已启用'), null, { timeout: 60000 }); }
  catch (error) {
    const diagnostics = await Promise.race([shellPage.evaluate(async () => {
      const state = await window.hajimink.state(); const gateway = state.gateway || {};
      return { authStatus: document.querySelector('#gateway-auth-status')?.textContent, feedback: document.querySelector('#gateway-owner-feedback')?.textContent,
        badge: document.querySelector('#gateway-state-badge')?.textContent, gateway: { state: gateway.state, mode: gateway.mode, managed: gateway.managed, message: gateway.message, failureCode: gateway.failureCode, failureStage: gateway.failureStage } };
    }).catch(() => ({ error: 'test window unavailable' })), delay(5000).then(() => ({ error: 'test diagnostic timed out' }))]);
    console.error('Owner-switch diagnostics:', JSON.stringify(diagnostics)); throw error;
  }
  await shellPage.waitForFunction(() => document.querySelector('#gateway-owner-enable')?.disabled === false, null, { timeout: 30000 });
  const enabled = await shellPage.evaluate(() => window.hajimink.state());
  assert.equal(enabled.gateway.mode, 'owner'); assert.equal(enabled.gateway.publicOrigin, origin);
  await waitForShellState(shellPage, value => !!value.gateway?.desktop);
  const ownerDesktop = (await shellPage.evaluate(() => window.hajimink.state())).gateway.desktop;
  assert.equal(typeof ownerDesktop.connected, 'boolean', 'private controller must expose only the local status summary');
  assert.equal(await localStatus(localPort, '/api/health', `localhost:${proxyPort}`), 401, 'owner-mode desktop status must not be exposed over anonymous HTTP');
  assert.equal(await localStatus(localPort, '/api/session', `localhost:${proxyPort}`), 401, 'owner mode must block unauthenticated business requests');
  assert.equal(await localStatus(localPort, '/api/auth/bootstrap', `localhost:${proxyPort}`), 200);
  await shellPage.waitForFunction(() => document.querySelector('#tunnel-status-badge')?.textContent === '未检查');
  // An explicit edit equal to the old saved address must survive a later
  // status change, rather than being silently replaced by the new address.
  await shellPage.fill('#gateway-public-origin', ''); await shellPage.fill('#gateway-public-origin', origin);
  await shellPage.locator('#gateway-port-title').click();
  await application.evaluate(({ BrowserWindow }, gateway) => BrowserWindow.getAllWindows()[0].webContents.send('shell:gateway', gateway), { ...enabled.gateway, publicOrigin: 'https://changed.example.test' });
  await shellPage.locator('#gateway-origin-draft').getByText(/尚未保存/).waitFor();
  assert.equal(await shellPage.locator('#gateway-public-origin').inputValue(), origin);
  await application.evaluate(({ BrowserWindow }, gateway) => BrowserWindow.getAllWindows()[0].webContents.send('shell:gateway', gateway), enabled.gateway);
  await shellPage.locator('#gateway-origin-draft').waitFor({ state: 'hidden' });
  // A draft different from the configured origin must never silently turn
  // into a probe of the old origin when focus or gateway status changes.
  const unsavedOrigin = `https://127.0.0.1:${proxyPort}`;
  await shellPage.fill('#gateway-public-origin', unsavedOrigin);
  await shellPage.locator('#gateway-port-title').click();
  await application.evaluate(({ BrowserWindow }, gateway) => BrowserWindow.getAllWindows()[0].webContents.send('shell:gateway', gateway), enabled.gateway);
  await shellPage.locator('#gateway-origin-draft').getByText(/尚未保存/).waitFor();
  assert.equal(await shellPage.locator('#gateway-owner-feedback').textContent(), '', 'old save feedback must not describe a new draft');
  assert.equal(await shellPage.locator('#gateway-public-origin').inputValue(), unsavedOrigin, 'a status update must preserve the unsaved address');
  assert.equal(await shellPage.locator('#tunnel-status-origin').textContent(), origin);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(820, 600));
  await shellPage.locator('#gateway-owner-form').scrollIntoViewIfNeeded();
  const draftLayout = await shellPage.locator('#gateway').evaluate(element => ({ scrollWidth: element.scrollWidth, width: element.clientWidth }));
  assert.ok(draftLayout.scrollWidth <= draftLayout.width + 1, 'address draft guidance must fit the minimum window');
  await shellPage.emulateMedia({ colorScheme: 'light' }); await shellPage.screenshot({ path: path.join(stage, 'smoke-artifacts', 'origin-draft-light.png') });
  await shellPage.emulateMedia({ colorScheme: 'dark' }); await shellPage.screenshot({ path: path.join(stage, 'smoke-artifacts', 'origin-draft-dark.png') });
  await shellPage.emulateMedia({ colorScheme: 'no-preference' });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 850));
  await application.evaluate(() => {
    globalThis.fixtureOriginFetch = globalThis.fetch; globalThis.fixtureOriginFetchCount = 0;
    globalThis.fetch = (...args) => { globalThis.fixtureOriginFetchCount++; return globalThis.fixtureOriginFetch(...args); };
  });
  try {
    await shellPage.click('#gateway-remote-test');
    await shellPage.locator('#gateway-remote-test-feedback').getByText(/无法连接/).waitFor({ timeout: 12000 });
    assert.equal(await application.evaluate(() => globalThis.fixtureOriginFetchCount), 1, 'an unsaved address may be checked once without using the saved origin');
    assert.equal(await shellPage.locator('#gateway-public-origin').inputValue(), unsavedOrigin, 'probing must preserve the unsaved address');
    assert.equal((await shellPage.evaluate(() => window.hajimink.state())).gateway.publicOrigin, origin, 'probing must not change the saved gateway origin');
    assert.equal(await shellPage.locator('#tunnel-status-badge').textContent(), '未检查', 'invalid input must not change the saved entry status');
    assert.equal(await shellPage.locator('#tunnel-status-time').textContent(), '尚未检查');
  } finally {
    await application.evaluate(() => { globalThis.fetch = globalThis.fixtureOriginFetch; delete globalThis.fixtureOriginFetch; delete globalThis.fixtureOriginFetchCount; });
  }
  await shellPage.click('#gateway-origin-reset');
  assert.equal(await shellPage.locator('#gateway-public-origin').inputValue(), origin);
  assert.equal(await shellPage.locator('#gateway-origin-draft').isHidden(), true);
  await shellPage.click('#gateway-remote-test');
  await shellPage.waitForFunction(() => document.querySelector('#tunnel-status-badge')?.textContent === '检查未通过', null, { timeout: 20000 });
  assert.match(await shellPage.locator('#tunnel-status-detail').textContent(), /无法连接/);
  proxy = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
    if (holdBootstrap && request.url === '/api/auth/bootstrap') { heldBootstrap = response; request.resume(); return; }
    if (spoofBootstrap && request.url === '/api/auth/bootstrap') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ mode: 'owner', authenticated: false, csrf: spoofCsrf, configured: true, setupPending: false })); request.resume(); return;
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: localPort, method: request.method, path: request.url, headers: request.headers }, inner => { response.writeHead(inner.statusCode, inner.headers); inner.pipe(response); });
    upstream.once('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  proxy.on('upgrade', (request, downstream, head) => {
    streamRequests.push({ path: request.url, ticket: !!request.headers['x-hajimink-diagnostic'], cookie: !!request.headers.cookie, authorization: !!request.headers.authorization });
    downstream.on('error', () => {});
    if (streamMode === 'block') { downstream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const mode = streamMode;
    const upstream = net.connect(localPort, '127.0.0.1');
    upstream.on('error', () => downstream.destroy()); downstream.on('close', () => upstream.destroy()); upstream.on('close', () => downstream.destroy());
    upstream.once('connect', () => {
      let headers = '';
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        if (mode === 'strip' && request.rawHeaders[i].toLowerCase() === 'x-hajimink-diagnostic') continue;
        headers += `${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`;
      }
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${headers}\r\n`);
      if (head.length) upstream.write(head);
      if (mode === 'block-outgoing') downstream.resume(); else downstream.pipe(upstream);
    });
    if (mode === 'block-incoming') {
      // Forward the initial upgrade response but discard later WebSocket frames.
      upstream.once('data', data => { downstream.write(data); upstream.resume(); });
    } else upstream.pipe(downstream);
  });
  await new Promise(resolve => proxy.listen(proxyPort, '127.0.0.1', resolve));
  // A different but plausible owner-mode gateway must not look like this one.
  const localBootstrap = await readBootstrap(localPort, { mode: 'owner', publicOrigin: origin });
  assert.match(localBootstrap?.csrf || '', /^[a-f0-9]{64}$/);
  spoofCsrf = localBootstrap.csrf === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64); spoofBootstrap = true;
  await shellPage.click('#gateway-remote-test');
  try { await shellPage.locator('#gateway-remote-test-feedback').getByText(/响应不一致/).waitFor({ timeout: 20000 }); }
  catch (error) { console.error('Entry-check diagnostics:', JSON.stringify({ feedback: await shellPage.locator('#gateway-remote-test-feedback').textContent(), badge: await shellPage.locator('#tunnel-status-badge').textContent(), detail: await shellPage.locator('#tunnel-status-detail').textContent() })); throw error; }
  await shellPage.waitForFunction(() => document.querySelector('#tunnel-status-badge')?.textContent === '检查未通过');
  assert.match(await shellPage.locator('#tunnel-status-detail').textContent(), /不一致/);
  const shown = JSON.stringify({ feedback: await shellPage.locator('#gateway-remote-test-feedback').textContent(), tunnel: (await shellPage.evaluate(() => window.hajimink.state())).tunnel });
  assert.equal(shown.includes(localBootstrap.csrf), false); assert.equal(shown.includes(spoofCsrf), false);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(820, 600));
  await shellPage.locator('#gateway-remote-test-feedback').scrollIntoViewIfNeeded();
  const mismatchLayout = await shellPage.locator('#gateway').evaluate(element => ({ scrollWidth: element.scrollWidth, width: element.clientWidth }));
  assert.ok(mismatchLayout.scrollWidth <= mismatchLayout.width + 1, 'entry mismatch guidance must fit the minimum window');
  await shellPage.emulateMedia({ colorScheme: 'light' }); await shellPage.screenshot({ path: path.join(stage, 'smoke-artifacts', 'entry-mismatch-light.png') });
  await shellPage.emulateMedia({ colorScheme: 'dark' }); await shellPage.screenshot({ path: path.join(stage, 'smoke-artifacts', 'entry-mismatch-dark.png') });
  await shellPage.emulateMedia({ colorScheme: 'no-preference' });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 850));
  spoofBootstrap = false;
  for (const mode of ['block', 'strip', 'block-outgoing', 'block-incoming']) {
    streamMode = mode; await shellPage.click('#gateway-remote-test');
    try { await shellPage.locator('#gateway-remote-test-feedback').getByText(/实时连接：未通过检查/).waitFor({ timeout: 25000 }); }
    catch (error) {
      const current = await shellPage.evaluate(() => window.hajimink.state());
      console.error('Realtime diagnostic fixture:', JSON.stringify({ mode, feedback: await shellPage.locator('#gateway-remote-test-feedback').textContent(), tunnel: current.tunnel, gateway: { state: current.gateway?.state, streamDiagnostic: current.gateway?.streamDiagnostic }, requests: streamRequests }));
      throw error;
    }
    await shellPage.waitForFunction(() => document.querySelector('#tunnel-status-badge')?.textContent === '实时待确认');
    assert.equal(await shellPage.locator('#tunnel-status-stream').textContent(), '未通过检查');
    // Allow the previous single-use socket to close before the next attempt.
    await delay(1200);
  }
  streamMode = 'forward';
  await shellPage.click('#gateway-remote-test');
  await shellPage.locator('#gateway-remote-test-feedback').getByText(/实时连接：一次双向检查通过/).waitFor({ timeout: 20000 });
  await shellPage.waitForFunction(() => document.querySelector('#tunnel-status-badge')?.textContent === '入口有响应');
  assert.equal(await shellPage.locator('#tunnel-status-stream').textContent(), '一次双向检查通过');
  assert.ok(streamRequests.length >= 5);
  for (const request of streamRequests) assert.deepEqual(request, { path: '/api/diagnostics/stream', ticket: true, cookie: false, authorization: false });
  assert.equal(await shellPage.locator('#tunnel-status-provider').textContent(), '自建服务器');
  assert.notEqual(await shellPage.locator('#tunnel-status-time').textContent(), '尚未检查');
  assert.match(await shellPage.locator('.status-boundary').textContent(), /不代表隧道进程的实时状态/);
  const successfulEntry = (await shellPage.evaluate(() => window.hajimink.state())).tunnel;
  await shellPage.fill('#gateway-public-origin', unsavedOrigin);
  await shellPage.click('#gateway-remote-test');
  await shellPage.locator('#gateway-remote-test-feedback').getByText(/无法连接/).waitFor({ timeout: 12000 });
  const afterInvalidEntry = (await shellPage.evaluate(() => window.hajimink.state())).tunnel;
  assert.equal(afterInvalidEntry.state, successfulEntry.state, 'an unsaved address must preserve the previous saved-entry result');
  assert.equal(afterInvalidEntry.checkedAt, successfulEntry.checkedAt, 'an unsaved address must not change the previous check time');
  assert.equal(await shellPage.locator('#tunnel-status-origin').textContent(), origin);
  assert.equal(await shellPage.locator('#gateway-public-origin').inputValue(), unsavedOrigin);
  await shellPage.click('#gateway-origin-reset');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(820, 600));
  await selectDesktopPage(shellPage, 'logs');
  await shellPage.locator('#tunnel-status-badge').scrollIntoViewIfNeeded();
  const tunnelLayout = await shellPage.locator('#logs').evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  assert.ok(tunnelLayout.scrollWidth <= tunnelLayout.clientWidth + 1, 'remote entry status must not overflow the minimum window');
  await shellPage.emulateMedia({ colorScheme: 'light' }); await shellPage.screenshot({ path: path.join(stage, 'smoke-artifacts', 'remote-entry-status-light.png') });
  await shellPage.emulateMedia({ colorScheme: 'dark' }); await shellPage.screenshot({ path: path.join(stage, 'smoke-artifacts', 'remote-entry-status-dark.png') });
  await shellPage.emulateMedia({ colorScheme: 'no-preference' });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 850));
  await selectDesktopPage(shellPage, 'gateway');
  holdBootstrap = true; await shellPage.click('#gateway-remote-test');
  await shellPage.waitForFunction(() => document.querySelector('#tunnel-status-badge')?.textContent === '检查中');
  for (let i = 0; i < 100 && !heldBootstrap; i++) await delay(50);
  assert.ok(heldBootstrap, 'fixture should hold the in-flight entry check');
  await shellPage.selectOption('#gateway-provider', 'tailscale');
  await waitForShellState(shellPage, value => value.setup?.tunnelProvider === 'tailscale');
  await shellPage.waitForFunction(() => document.querySelector('#tunnel-status-badge')?.textContent === '未检查');
  holdBootstrap = false; heldBootstrap.writeHead(503); heldBootstrap.end(); heldBootstrap = undefined;
  await shellPage.waitForFunction(() => !document.querySelector('#gateway-remote-test')?.disabled, null, { timeout: 20000 });
  assert.equal(await shellPage.locator('#tunnel-status-badge').textContent(), '未检查', 'a late response must not overwrite the newly selected provider');
  assert.equal(await shellPage.locator('#gateway-remote-test-feedback').textContent(), '');
  await shellPage.selectOption('#gateway-provider', 'self-hosted');
  await waitForShellState(shellPage, value => value.setup?.tunnelProvider === 'self-hosted');
  // Change provider while an actual WebSocket probe is waiting: its late
  // response must not be presented as the new provider's result.
  streamMode = 'block-outgoing'; const countBeforeChange = streamRequests.length;
  await shellPage.click('#gateway-remote-test');
  for (let i = 0; i < 200 && streamRequests.length === countBeforeChange; i++) await delay(50);
  assert.ok(streamRequests.length > countBeforeChange, 'fixture stream probe must start');
  await shellPage.selectOption('#gateway-provider', 'tailscale');
  await waitForShellState(shellPage, value => value.setup?.tunnelProvider === 'tailscale');
  await shellPage.waitForFunction(() => !document.querySelector('#gateway-remote-test')?.disabled, null, { timeout: 20000 });
  assert.equal(await shellPage.locator('#tunnel-status-badge').textContent(), '未检查');
  assert.equal(await shellPage.locator('#tunnel-status-stream').textContent(), '未检查');
  assert.equal(await shellPage.locator('#gateway-remote-test-feedback').textContent(), '');
  streamMode = 'forward'; await shellPage.selectOption('#gateway-provider', 'self-hosted');
  await waitForShellState(shellPage, value => value.setup?.tunnelProvider === 'self-hosted');
  await shellPage.evaluate(url => window.hajimink.add({ name: '隔离远程测试', url }), origin);
  await selectDesktopPage(shellPage, 'workspace'); await shellPage.click('#reload');
  const remotePage = await waitForPage(page => page.url().startsWith(origin));
  await remotePage.getByRole('heading', { name: '登录你的工作台' }).waitFor({ timeout: 20000 });
  assert.equal(await remotePage.evaluate(() => typeof window.hajimink), 'undefined', 'remote view must not receive the desktop bridge');
  await remotePage.getByLabel('密码', { exact: true }).fill('incorrect-test-password'); await remotePage.getByRole('button', { name: '登录', exact: true }).click();
  await remotePage.getByRole('alert').filter({ hasText: '密码不正确' }).waitFor({ timeout: 15000 });
  assert.equal(await remotePage.evaluate(() => fetch('/api/preferences').then(response => response.status)), 401);
  await remotePage.getByLabel('密码', { exact: true }).fill(password); await remotePage.getByRole('button', { name: '登录', exact: true }).click();
  await remotePage.locator('.workspace').waitFor({ timeout: 20000 });
  assert.equal(await remotePage.evaluate(() => fetch('/api/preferences').then(response => response.status)), 200);
  await remotePage.goto(`${origin}/account`); await remotePage.getByRole('heading', { name: '管理登录方式' }).waitFor();
  const selection = await application.evaluate(async ({ session, webContents, dialog }, args) => {
    const target = webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().startsWith(args.origin));
    const channel = session.fromPartition(`hajimink-${args.id}`), original = dialog.showMessageBox; let prompts = 0;
    dialog.showMessageBox = async (_window, options) => { prompts++; return { response: 1, checkboxChecked: false }; };
    try {
      const details = { frame: target.mainFrame, relyingPartyId: 'localhost', accounts: [{ credentialId: 'fixture-a', name: 'A' }, { credentialId: 'fixture-b', name: 'B' }] };
      const chosen = await new Promise(resolve => channel.emit('select-webauthn-account', {}, details, value => resolve(value || null)));
      const rejected = await new Promise(resolve => channel.emit('select-webauthn-account', {}, { ...details, frame: { url: args.origin } }, value => resolve(value || null)));
      return { correctChoice: chosen === 'fixture-b', forgedFrameRejected: rejected === null, prompts };
    } finally { dialog.showMessageBox = original; }
  }, { origin, id: (await shellPage.evaluate(() => window.hajimink.state())).selected });
  assert.deepEqual(selection, { correctChoice: true, forgedFrameRejected: true, prompts: 1 });
  const cdp = await application.context().newCDPSession(remotePage); await cdp.send('WebAuthn.enable');
  const virtual = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  await remotePage.getByRole('button', { name: '添加通行密钥' }).click();
  await remotePage.getByRole('status').filter({ hasText: '通行密钥已添加' }).waitFor({ timeout: 15000 });
  const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId: virtual.authenticatorId });
  assert.equal(creds.credentials.length, 1); assert.equal(creds.credentials[0].rpId, 'localhost');
  await remotePage.getByRole('button', { name: '退出当前设备' }).click();
  await remotePage.getByRole('button', { name: '使用通行密钥' }).click();
  try { await remotePage.locator('.workspace').waitFor({ timeout: 15000 }); }
  catch (error) { console.error('Passkey UI:', JSON.stringify({ errors: await remotePage.locator('.auth-error').allTextContents(), pathname: new URL(remotePage.url()).pathname })); throw error; }
  assert.equal(await remotePage.evaluate(() => fetch('/api/preferences').then(response => response.status)), 200);
  await selectDesktopPage(shellPage, 'gateway');
  await shellPage.evaluate(id => window.hajimink.select(id), enabled.connections.find(item => item.local).id);
  const changedOrigin = 'https://gateway.example.test';
  await shellPage.fill('#gateway-public-origin', changedOrigin); shellPage.once('dialog', dialog => dialog.accept()); await shellPage.click('#gateway-owner-enable');
  await shellPage.waitForFunction(() => document.querySelector('#gateway-owner-enable')?.disabled === true, null, { timeout: 5000 });
  // Editing back to the previously saved address must still remain a draft
  // once the earlier operation commits a different address.
  const laterDraft = origin;
  await shellPage.fill('#gateway-public-origin', laterDraft);
  await shellPage.waitForFunction(() => document.querySelector('#gateway-auth-status')?.textContent?.includes('gateway.example.test'), null, { timeout: 60000 });
  await shellPage.waitForFunction(() => document.querySelector('#gateway-owner-enable')?.disabled === false, null, { timeout: 15000 });
  assert.equal(await shellPage.locator('#gateway-public-origin').inputValue(), laterDraft, 'a newer edit must survive an earlier save');
  assert.equal(await shellPage.locator('#tunnel-status-origin').textContent(), changedOrigin, 'status must identify the saved address');
  await shellPage.locator('#gateway-origin-draft').getByText(/尚未保存/).waitFor();
  assert.match(await shellPage.locator('#gateway-owner-feedback').textContent(), /先前提交的地址已保存.*当前输入的地址尚未保存/);
  assert.equal(await localStatus(localPort, '/api/session', 'gateway.example.test'), 401);
  assert.equal(await localStatus(localPort, '/api/session', `localhost:${proxyPort}`), 403, 'the old public host must no longer be accepted');
  await shellPage.fill('#gateway-public-origin', origin); shellPage.once('dialog', dialog => dialog.accept()); await shellPage.click('#gateway-owner-enable');
  await shellPage.waitForFunction(() => document.querySelector('#gateway-auth-status')?.textContent?.includes('localhost'), null, { timeout: 60000 });
  assert.equal(await localStatus(localPort, '/api/session', `localhost:${proxyPort}`), 401);
  let next; do { next = await freePort(); } while (next === localPort || next === proxyPort);
  await shellPage.fill('#gateway-port-input', String(next)); shellPage.once('dialog', dialog => dialog.accept()); await shellPage.click('#gateway-port-save');
  await shellPage.locator('#gateway-port-feedback').getByText(/已切换到端口/).waitFor({ timeout: 60000 });
  const changed = await shellPage.evaluate(() => window.hajimink.state());
  assert.equal(changed.gateway.mode, 'owner'); assert.equal(changed.gateway.publicOrigin, origin); assert.equal(changed.gateway.port, next);
  const oldPort = localPort; localPort = next; manager.port = next;
  await assert.rejects(localStatus(oldPort, '/api/session', `localhost:${proxyPort}`));
  assert.equal(await localStatus(localPort, '/api/session', `localhost:${proxyPort}`), 401);
  assert.equal((await shellPage.evaluate(() => window.hajimink.state())).setup.complete, true);
  // Older owner profiles may have no recorded tunnel provider.
  await shellPage.selectOption('#gateway-provider', '');
  await waitForShellState(shellPage, value => value.setup?.tunnelProvider === null);
  assert.equal(await shellPage.locator('#gateway-remote-fields').isVisible(), true);
  const closing = application, handle = closing.process();
  const exited = new Promise(resolve => { if (handle.exitCode !== null) resolve(); else handle.once('exit', resolve); });
  await closing.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); });
  await Promise.race([exited, delay(12000).then(() => { throw new Error('desktop exit timeout'); })]);
  application = undefined; shellPage = undefined; void closing.close().catch(() => {});
  assert.equal(await localStatus(localPort, '/api/session', `localhost:${proxyPort}`), 401, 'owner gateway remains protected after desktop exit');
  application = await electron.launch({ executablePath: binary, args, cwd: root, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, timeout: 60000 });
  shellPage = await application.firstWindow(); await selectDesktopPage(shellPage, 'gateway');
  await shellPage.waitForFunction(() => document.querySelector('#gateway-state-badge')?.textContent === '正常', null, { timeout: 45000 });
  const reattached = await shellPage.evaluate(() => window.hajimink.state());
  assert.equal(reattached.gateway.pid, changed.gateway.pid); assert.equal(reattached.gateway.mode, 'owner');
  assert.equal(reattached.gateway.port, localPort); assert.equal(reattached.gateway.publicOrigin, origin); assert.equal(reattached.setup.complete, true);
  assert.equal(reattached.setup.tunnelProvider, null);
  assert.equal(await shellPage.locator('#gateway-remote-fields').isVisible(), true, 'an existing owner profile must retain access to its settings without a provider');
  assert.equal(await shellPage.locator('#gateway-public-origin').inputValue(), origin);
  assert.equal(await shellPage.locator('#gateway-owner-enable').isVisible(), true);
  await shellPage.selectOption('#gateway-provider', 'self-hosted');
  await waitForShellState(shellPage, value => value.setup?.tunnelProvider === 'self-hosted');
  const reopenedStatus = await waitForShellState(shellPage, value => value.tunnel?.state === 'unchecked');
  assert.equal(reopenedStatus.tunnel.provider, 'self-hosted'); assert.equal(reopenedStatus.tunnel.checkedAt, null);
  await selectDesktopPage(shellPage, 'workspace');
  const reopened = await waitForPage(page => page.url().startsWith(`http://127.0.0.1:${localPort}/`));
  await reopened.locator('.workspace').waitFor({ timeout: 20000 });
  await selectDesktopPage(shellPage, 'gateway');
  shellPage.once('dialog', dialog => dialog.accept()); await setGatewayEnabled(shellPage, false);
  await shellPage.waitForFunction(() => document.querySelector('#gateway-state-badge')?.textContent === '未启动', null, { timeout: 20000 });
  const certData = path.join(temp, 'untrusted-certificate-client'); const certStore = new ConnectionStore(certData, 'linux'); certStore.add({ name: 'TLS test', url: `https://127.0.0.1:${proxyPort}` });
  const certArgs = [...(packaged ? [] : ['.']), `--hajimink-data-dir=${certData}`];
  certApplication = await electron.launch({ executablePath: binary, args: certArgs, cwd: root, env: { ...process.env, NODE_EXTRA_CA_CERTS: '' }, timeout: 60000 });
  const certShell = await certApplication.firstWindow();
  try { await certShell.waitForFunction(() => document.querySelector('#connection-status')?.classList.contains('error'), null, { timeout: 20000 }); }
  catch (error) { console.error('Certificate probe:', JSON.stringify({ status: await certShell.locator('#connection-status').textContent(), css: await certShell.locator('#connection-status').getAttribute('class'), views: await certApplication.evaluate(async ({ webContents }) => { const values = []; for (const w of webContents.getAllWebContents().filter(w => !w.isDestroyed())) values.push({ url: w.getURL(), title: w.getTitle(), text: w.getURL().startsWith('https:') ? await w.executeJavaScript('document.body?.innerText?.slice(0,200)').catch(() => '') : '' }); return values; }) })); throw error; }
  assert.match(await certShell.locator('#connection-status').textContent(), /证书无效或不受信任/);
  await certApplication.close(); certApplication = undefined;
  await setGatewayEnabled(shellPage, true);
  await shellPage.waitForFunction(() => document.querySelector('#gateway-state-badge')?.textContent === '正常', null, { timeout: 45000 });
  proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); proxy = undefined;
  await selectDesktopPage(shellPage, 'workspace'); await shellPage.click('#reload');
  const offlineLocal = await waitForPage(page => page.url().startsWith(`http://127.0.0.1:${localPort}/`));
  await offlineLocal.locator('.workspace').waitFor({ timeout: 20000 });
  assert.equal(await offlineLocal.evaluate(() => fetch('/api/preferences').then(response => response.status)), 200);
  assert.equal(await localStatus(localPort, '/api/session', `localhost:${proxyPort}`), 401, 'public origin remains protected without a tunnel');
  await selectDesktopPage(shellPage, 'gateway');
  await application.evaluate(({ dialog }) => { globalThis.fixtureOriginalDialog = dialog.showMessageBox; dialog.showMessageBox = async () => ({ response: 0 }); });
  await shellPage.selectOption('#gateway-provider', 'off');
  await shellPage.waitForFunction(() => !document.querySelector('#gateway-provider').disabled);
  assert.equal((await shellPage.evaluate(() => window.hajimink.state())).setup.tunnelProvider, 'self-hosted', 'cancel must preserve the provider');
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await shellPage.selectOption('#gateway-provider', 'off');
  await waitForShellState(shellPage, value => value.setup?.remoteDisabled === true);
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = globalThis.fixtureOriginalDialog; delete globalThis.fixtureOriginalDialog; });
  assert.equal(await shellPage.locator('#gateway-remote-fields').isHidden(), true);
  const disabled = await shellPage.evaluate(() => window.hajimink.state());
  assert.equal(disabled.gateway.mode, 'owner'); assert.equal(disabled.gateway.publicOrigin, origin);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'gateway', 'config.json'), 'utf8')).mode, 'owner');
  await shellPage.reload();
  await shellPage.waitForFunction(() => document.querySelector('#gateway-provider').value === 'off');
  await selectDesktopPage(shellPage, 'workspace'); await shellPage.click('#reload');
  const afterDisable = await waitForPage(page => page.url().startsWith(`http://127.0.0.1:${localPort}/`));
  await afterDisable.locator('.workspace').waitFor({ timeout: 20000 });
  console.log(JSON.stringify({ isolatedDesktop: packaged ? 'packaged' : 'development', localWithoutTunnel: 'passed', disableRemoteCancelAndPersistence: 'passed', passwordSwitchRequiresExistingPassword: 'passed', remoteEntryCheck: 'passed', streamForwardAndBlock: 'passed', streamStaleResult: 'passed', unsavedOriginSafety: 'passed', newerDraftPreserved: 'passed', misroutedGatewayDetection: 'passed', ownerModeProtection: 'passed', wrongPasswordRejected: 'passed', httpsPasswordLogin: 'passed', httpsVirtualPasskey: 'passed', passkeySelection: 'passed', ownerOriginChange: 'passed', ownerPortChange: 'passed', ownerReattach: 'passed', ownerWithoutProvider: 'passed', onboardingPersistence: 'passed', untrustedCertificateRejected: 'passed', remoteBridgeDenied: 'passed', realPublicTunnel: 'not tested' }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (shellPage) try { await Promise.race([shellPage.evaluate(() => window.hajimink.gatewayStop()), delay(10000)]); } catch {}
  if (manager) { try { const record = JSON.parse(fs.readFileSync(path.join(userData, 'gateway', 'controller.instance.json'), 'utf8')); manager.port = record.port; } catch {} try { await manager.stop(); } catch {} manager.close(); }
  if (certApplication) try { await certApplication.close(); } catch {}
  let appStillRunning = false;
  if (application) {
    const child = application.process();
    try { await Promise.race([application.close(), delay(12000).then(() => { throw new Error('隔离测试窗口退出超时'); })]); }
    catch (error) {
      console.error(error.message); process.exitCode = 1;
      // This handle belongs to the application launched by this test, not an arbitrary process.
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]); }
      appStillRunning = child.exitCode === null && child.signalCode === null;
    }
  }
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  const record = path.join(userData, 'gateway', 'controller.instance.json'), lock = path.join(userData, 'gateway', 'gateway.instance.lock');
  if (appStillRunning || fs.existsSync(record) || fs.existsSync(lock)) { console.error('Unconfirmed fixture instance; retained:', temp); process.exitCode = 1; return; }
  const resolved = fs.realpathSync(temp), base = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved).toLowerCase() !== base.toLowerCase() || !path.basename(resolved).startsWith('hajimink-owner-setup-')) throw new Error('Unexpected test path');
  fs.rmSync(resolved, { recursive: true, force: true });
});
