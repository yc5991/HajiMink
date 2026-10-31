'use strict';
const { selectDesktopPage, setGatewayEnabled } = require('./desktop-page-menu.cjs');
// A disposable HTTPS proxy, test profile and virtual authenticator exercise
// initialization without accessing any real credentials or public tunnel.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const { _electron: electron, chromium } = require('playwright');
const { waitForShellState } = require('./wait-shell-state.cjs');
const { ControllerGatewayManager, PENDING_PUBLIC_ORIGIN } = require('../desktop/controller-manager.cjs');
const root = path.resolve(__dirname, '..');
const stage = path.join(root, '.local', 'hajimink-stage');
const binary = process.env.HAJIMINK_DESKTOP_BINARY || require('electron');
const packaged = !!process.env.HAJIMINK_DESKTOP_BINARY;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-passkey-setup-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { freePort } = require('./test-network.cjs');
async function waitForPage(application, predicate) {
  for (let i = 0; i < 160; i++) { const page = application.context().pages().find(predicate); if (page) return page; await delay(125); }
  throw new Error('找不到隔离测试工作台页面');
}
function localStatus(port, url, host) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: url, headers: { host }, timeout: 3000 }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    request.once('timeout', () => request.destroy(new Error('timeout'))); request.once('error', reject);
  });
}
function createProxy(key, cert, localPort, upgraded) {
  const proxy = https.createServer({ key, cert }, (request, response) => {
    const upstream = http.request({ hostname: '127.0.0.1', port: localPort, method: request.method, path: request.url, headers: request.headers }, inner => { response.writeHead(inner.statusCode, inner.headers); inner.pipe(response); });
    upstream.once('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  proxy.on('upgrade', (request, client, head) => {
    const upstream = net.createConnection(localPort, '127.0.0.1');
    upgraded.add(client); upgraded.add(upstream);
    client.once('close', () => upgraded.delete(client)); upstream.once('close', () => upgraded.delete(upstream));
    upstream.once('connect', () => {
      const headers = []; for (let i = 0; i < request.rawHeaders.length; i += 2) headers.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    upstream.on('close', () => client.destroy()); client.on('close', () => upstream.destroy());
  });
  return proxy;
}
function testHttpsStatus(origin, pathname) {
  // The fixture certificate is trusted only for this isolated test.
  return new Promise((resolve, reject) => {
    const request = https.get(new URL(pathname, origin), { rejectUnauthorized: false, timeout: 3000 }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    request.once('timeout', () => request.destroy(new Error('fixture timeout'))); request.once('error', reject);
  });
}
async function quitDesktop(application) {
  const handle = application.process();
  const exited = new Promise(resolve => { if (handle.exitCode !== null) resolve(); else handle.once('exit', resolve); });
  await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); });
  await Promise.race([exited, delay(12000).then(() => { throw new Error('测试桌面退出超时'); })]);
  void application.close().catch(() => {});
}
async function runCase(name, usePasskey, key, cert, certFile, options = {}) {
  let application, shell, proxy, manager, browser, browserContext;
  const upgraded = new Set();
  const userData = path.join(temp, name);
  const localPort = await freePort(); let proxyPort; do { proxyPort = await freePort(); } while (proxyPort === localPort);
  const origin = `https://localhost:${proxyPort}`;
  const args = [...(packaged ? [] : ['.']), '--ignore-certificate-errors', `--hajimink-data-dir=${userData}`, `--hajimink-gateway-port=${localPort}`];
  const appRoot = packaged ? path.join(path.dirname(binary), 'resources', 'gateway') : stage;
  const nodePath = packaged ? path.join(appRoot, 'runtime', 'node.exe') : binary;
  manager = new ControllerGatewayManager({ appRoot, dataDir: path.join(userData, 'gateway'), port: localPort, nodePath, runAsNode: !packaged, startTimeoutMs: 15000 });
  try {
    application = await electron.launch({ executablePath: binary, args, cwd: root, env: { ...process.env, NODE_EXTRA_CA_CERTS: certFile }, timeout: 60000 });
    shell = await application.firstWindow();
    await selectDesktopPage(shell, 'gateway');
    await setGatewayEnabled(shell, true);
    await shell.waitForFunction(() => document.querySelector('#gateway-state-badge')?.textContent === '正常', null, { timeout: 45000 });
    await shell.selectOption('#gateway-provider', 'self-hosted'); await shell.locator('#gateway-remote-fields').waitFor({ state: 'visible' });
    await shell.selectOption('#gateway-auth-method', 'passkey');
    await shell.fill('#gateway-public-origin', origin);
    shell.once('dialog', dialog => dialog.accept()); await shell.click('#gateway-passkey-start');
    const newerDraft = 'https://different-gateway.example.test';
    if (usePasskey) {
      await shell.waitForFunction(() => document.querySelector('#gateway-passkey-start')?.disabled === true, null, { timeout: 5000 });
      await shell.fill('#gateway-public-origin', newerDraft);
    }
    try { await shell.locator('#gateway-setup-code-panel').waitFor({ state: 'visible', timeout: 60000 }); }
    catch (error) {
      const gateway = (await shell.evaluate(() => window.hajimink.state())).gateway;
      console.error('Setup fixture diagnostic:', JSON.stringify({ name, badge: await shell.locator('#gateway-state-badge').textContent(), feedback: await shell.locator('#gateway-owner-feedback').textContent(), mode: gateway?.mode, state: gateway?.state, message: gateway?.message }));
      throw error;
    }
    const firstCode = (await shell.locator('#gateway-setup-code').textContent()).trim();
    assert.match(firstCode, /^[A-Za-z0-9_-]{43}$/);
    assert.match(await shell.locator('#gateway-setup-code-origin').textContent(), new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    if (usePasskey) {
      assert.equal(await shell.locator('#gateway-public-origin').inputValue(), newerDraft, 'a newer draft must survive setup completion');
      assert.equal((await shell.evaluate(() => window.hajimink.state())).gateway.publicOrigin, origin, 'the setup code must bind the submitted address');
      await shell.click('#gateway-origin-reset');
      assert.equal(await shell.locator('#gateway-public-origin').inputValue(), origin);
      const actualGateway = (await shell.evaluate(() => window.hajimink.state())).gateway;
      await application.evaluate(({ BrowserWindow }, gateway) => BrowserWindow.getAllWindows()[0].webContents.send('shell:gateway', gateway), { ...actualGateway, publicOrigin: newerDraft });
      await shell.locator('#gateway-setup-code-panel').waitFor({ state: 'hidden' });
      assert.equal(await shell.locator('#gateway-setup-code').textContent(), '', 'a stale gateway identity must clear the visible code');
      assert.match(await shell.locator('#gateway-owner-feedback').textContent(), /设置码已隐藏/);
      await application.evaluate(({ BrowserWindow }, gateway) => BrowserWindow.getAllWindows()[0].webContents.send('shell:gateway', gateway), actualGateway);
      await shell.waitForFunction(expected => document.querySelector('#gateway-public-origin')?.value === expected, origin);
    }
    assert.equal(await shell.locator('#gateway-state-badge').textContent(), '待设置');
    assert.match(await shell.evaluate(async () => { try { await window.hajimink.completeSetup(); return ''; } catch (error) { return String(error.message); } }), /首次登录设置/);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(820, 600));
    const shellLayout = await shell.locator('#gateway').evaluate(element => ({ scrollWidth: element.scrollWidth, width: element.clientWidth }));
    assert.ok(shellLayout.scrollWidth <= shellLayout.width + 1, 'setup code must fit the minimum desktop window width');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 850));
    assert.equal(await localStatus(localPort, '/api/session', `localhost:${proxyPort}`), 401);
    assert.equal(await localStatus(localPort, '/api/projects', `localhost:${proxyPort}`), 401);
    assert.equal(fs.readFileSync(path.join(userData, 'gateway', 'config.json'), 'utf8').includes(firstCode), false);
    if (usePasskey) {
      // Restart during setup: the first code is never redisplayed, but the
      // pending gateway can be reattached and a fresh code issued locally.
      await quitDesktop(application); application = undefined; shell = undefined;
      application = await electron.launch({ executablePath: binary, args, cwd: root, env: { ...process.env, NODE_EXTRA_CA_CERTS: certFile }, timeout: 60000 });
      shell = await application.firstWindow(); await selectDesktopPage(shell, 'gateway');
      await shell.waitForFunction(() => document.querySelector('#gateway-state-badge')?.textContent === '待设置', null, { timeout: 45000 });
      assert.equal(await shell.locator('#gateway-setup-code-panel').isHidden(), true);
      await shell.locator('#gateway-remote-fields').waitFor({ state: 'visible' });
      shell.once('dialog', dialog => dialog.accept()); await shell.click('#gateway-passkey-start');
      await shell.locator('#gateway-setup-code-panel').waitFor({ state: 'visible', timeout: 60000 });
    }
    const code = (await shell.locator('#gateway-setup-code').textContent()).trim();
    if (usePasskey) assert.notEqual(firstCode, code, 'regeneration must invalidate the previous code');
    proxy = createProxy(key, cert, localPort, upgraded);
    await new Promise(resolve => proxy.listen(proxyPort, '127.0.0.1', resolve));
    await shell.click('#gateway-remote-test');
    await shell.locator('#gateway-remote-test-feedback').getByText(/已识别待设置页面/).waitFor({ timeout: 20000 });
    await shell.locator('#gateway-remote-test-feedback').getByText(/实时连接：一次双向检查通过/).waitFor({ timeout: 20000 });
    // Capture the OS handoff without opening the user's real browser profile.
    await application.evaluate(({ shell: systemShell }) => {
      globalThis.fixtureSetupUrls = [];
      systemShell.openExternal = async url => { globalThis.fixtureSetupUrls.push(url); };
    });
    assert.equal(await shell.locator('#gateway-open-setup').isEnabled(), true);
    const rejected = await shell.evaluate(async () => {
      try { await window.hajimink.gatewayOpenSetup({ url: 'https://unrelated.example' }); return false; } catch { return true; }
    });
    assert.equal(rejected, true, 'renderer-supplied destinations must not override the setup binding');
    await shell.fill('#gateway-public-origin', 'https://unsaved.example');
    await shell.click('#gateway-open-setup');
    await shell.locator('#gateway-open-setup-feedback').getByText(/不同.*恢复已保存地址/).waitFor();
    assert.deepEqual(await application.evaluate(() => globalThis.fixtureSetupUrls), []);
    await shell.click('#gateway-origin-reset');
    await shell.click('#gateway-open-setup');
    await shell.locator('#gateway-open-setup-feedback').getByText(/已在浏览器打开/).waitFor();
    const openedUrls = await application.evaluate(() => globalThis.fixtureSetupUrls);
    assert.deepEqual(openedUrls, [`${origin}/`]);
    assert.equal(openedUrls[0].includes(code), false, 'setup code must never be part of the URL');
    let remote;
    if (options.externalBrowser) {
      const launch = process.env.HAJIMINK_BROWSER ? { executablePath: process.env.HAJIMINK_BROWSER } : process.platform === 'win32' ? { channel: 'msedge' } : {};
      browser = await chromium.launch({ headless: true, ...launch });
      browserContext = await browser.newContext({ ignoreHTTPSErrors: true });
      remote = await browserContext.newPage(); await remote.goto(openedUrls[0]);
    } else {
      await selectDesktopPage(shell, 'workspace'); await shell.click('#reload');
      remote = await waitForPage(application, page => page.url().startsWith(origin));
    }
    await remote.getByRole('heading', { name: '首次设置登录方式' }).waitFor({ timeout: 20000 });
    assert.equal(await remote.evaluate(() => fetch('/api/preferences').then(response => response.status)), 401);
    assert.equal(await remote.evaluate(() => typeof window.hajimink), 'undefined');
    if (usePasskey) {
      await remote.getByLabel('本机一次性设置码').fill(firstCode); await remote.getByRole('button', { name: '验证设置码' }).click();
      await remote.getByRole('alert').filter({ hasText: '设置码无效' }).waitFor({ timeout: 10000 });
    }
    await remote.getByLabel('本机一次性设置码').fill(code); await remote.getByRole('button', { name: '验证设置码' }).click();
    await remote.getByRole('button', { name: '创建通行密钥' }).waitFor({ timeout: 10000 });
    if (!options.externalBrowser) await selectDesktopPage(shell, 'gateway');
    await shell.click('#gateway-open-setup');
    await shell.locator('#gateway-owner-feedback').getByText(/已使用或过期/).waitFor();
    assert.equal(await shell.locator('#gateway-setup-code-panel').isHidden(), true, 'used codes must be hidden instead of opened again');
    assert.deepEqual(await application.evaluate(() => globalThis.fixtureSetupUrls), [`${origin}/`]);
    if (!options.externalBrowser) await selectDesktopPage(shell, 'workspace');
    assert.equal(await remote.evaluate(() => fetch('/api/preferences').then(response => response.status)), 401, 'restricted setup session must not open the workspace');
    assert.equal(new URL(remote.url()).href.includes(code), false, 'setup code must never be in a URL');
    if (usePasskey) {
      const cdp = await (browserContext || application.context()).newCDPSession(remote); await cdp.send('WebAuthn.enable');
      const virtual = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
      const layout = await remote.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
      assert.ok(layout.scrollWidth <= layout.width + 1, 'setup page must not overflow horizontally');
      await remote.getByRole('button', { name: '创建通行密钥' }).click();
      await remote.locator('.workspace').waitFor({ timeout: 20000 });
      await remote.locator('.workspace[data-stream-state="online"]').waitFor({ timeout: 20000 });
      const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId: virtual.authenticatorId });
      assert.equal(creds.credentials.length, 1); assert.equal(creds.credentials[0].rpId, 'localhost');
      await remote.goto(`${origin}/account`); await remote.getByRole('button', { name: '退出当前设备' }).click();
      await remote.getByRole('button', { name: '使用通行密钥' }).click();
      await remote.locator('.workspace').waitFor({ timeout: 20000 });
      await remote.locator('.workspace[data-stream-state="online"]').waitFor({ timeout: 20000 });
    } else {
      await remote.getByRole('button', { name: '改用密码设置' }).click();
      await remote.getByLabel('新密码', { exact: true }).fill('fixture-only-password-2026');
      await remote.getByLabel('确认新密码', { exact: true }).fill('fixture-only-password-2026');
      await remote.getByRole('button', { name: '设置密码并登录' }).click();
      await remote.locator('.workspace').waitFor({ timeout: 20000 });
      await remote.locator('.workspace[data-stream-state="online"]').waitFor({ timeout: 20000 });
      await remote.goto(`${origin}/account`); await remote.getByRole('button', { name: '退出当前设备' }).click();
      await remote.getByLabel('密码', { exact: true }).fill('fixture-only-password-2026');
      await remote.getByRole('button', { name: '登录', exact: true }).click();
      await remote.locator('.workspace').waitFor({ timeout: 20000 });
      await remote.locator('.workspace[data-stream-state="online"]').waitFor({ timeout: 20000 });
    }
    await selectDesktopPage(shell, 'gateway');
    await shell.waitForFunction(() => document.querySelector('#gateway-auth-status')?.textContent?.includes('独立登录已启用'), null, { timeout: 30000 });
    assert.equal(await shell.locator('#gateway-setup-code-panel').isHidden(), true);
    assert.equal((await shell.evaluate(() => window.hajimink.state())).gateway.setupPending, false);
    assert.equal((await shell.evaluate(() => window.hajimink.state())).setup.complete, true);
    shell.once('dialog', dialog => dialog.accept()); await setGatewayEnabled(shell, false);
    await shell.waitForFunction(() => document.querySelector('#gateway-state-badge')?.textContent === '未启动', null, { timeout: 20000 });
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (shell) try { await Promise.race([shell.evaluate(() => window.hajimink.gatewayStop()), delay(10000)]); } catch {}
    if (application) try { await Promise.race([application.close(), delay(12000).then(() => { throw new Error('隔离测试窗口退出超时'); })]); } catch (error) { console.error(error.message); process.exitCode = 1; }
    if (manager) { try { await manager.stop(); } catch {} manager.close(); }
    for (const socket of upgraded) socket.destroy();
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  }
}
// A provider may reveal its address only after the tunnel starts. Keep the
// fixture proxy alive while the protected gateway is bound to its final address.
async function runLateAddressCase(name, options, key, cert, certFile) {
  let application, shell, proxy, manager;
  const upgraded = new Set();
  const userData = path.join(temp, name);
  const localPort = await freePort(); let proxyPort; do { proxyPort = await freePort(); } while (proxyPort === localPort);
  const origin = `https://${options.ip ? '127.0.0.1' : 'localhost'}:${proxyPort}`;
  const publicHost = new URL(origin).host;
  const args = [...(packaged ? [] : ['.']), '--ignore-certificate-errors', `--hajimink-data-dir=${userData}`, `--hajimink-gateway-port=${localPort}`];
  const appRoot = packaged ? path.join(path.dirname(binary), 'resources', 'gateway') : stage;
  const nodePath = packaged ? path.join(appRoot, 'runtime', 'node.exe') : binary;
  manager = new ControllerGatewayManager({ appRoot, dataDir: path.join(userData, 'gateway'), port: localPort, nodePath, runAsNode: !packaged, startTimeoutMs: 15000 });
  try {
    application = await electron.launch({ executablePath: binary, args, cwd: root, env: { ...process.env, NODE_EXTRA_CA_CERTS: certFile }, timeout: 60000 });
    shell = await application.firstWindow();
    await selectDesktopPage(shell, 'gateway');
    await setGatewayEnabled(shell, true);
    await shell.waitForFunction(() => document.querySelector('#gateway-state-badge')?.textContent === '正常', null, { timeout: 45000 });
    await shell.selectOption('#gateway-provider', 'self-hosted'); await shell.locator('#gateway-remote-fields').waitFor({ state: 'visible' });
    if (options.passwordFirst) {
      await shell.click('#gateway-account');
      const account = await waitForPage(application, page => page.url() === `http://127.0.0.1:${localPort}/account`);
      await account.getByRole('heading', { name: '设置本站登录' }).waitFor();
      await account.getByLabel('新密码', { exact: true }).fill('fixture-only-password-2026');
      await account.getByLabel('确认新密码', { exact: true }).fill('fixture-only-password-2026');
      await account.getByRole('button', { name: '保存密码' }).click();
      await account.getByRole('status').filter({ hasText: '密码已保存' }).waitFor({ timeout: 15000 });
      await selectDesktopPage(shell, 'gateway');
    }
    await shell.locator('.gateway-address-help summary').click(); shell.once('dialog', dialog => dialog.accept()); await shell.click('#gateway-no-address');
    let state = await waitForShellState(shell, value => value.gateway?.state === 'ready' && value.gateway?.awaitingPublicOrigin === true, { timeoutMs: 60000 });
    assert.equal(state.gateway.mode, 'owner');
    assert.equal(state.gateway.setupPending, !options.passwordFirst);
    assert.equal(await shell.locator('#gateway-public-origin').inputValue(), '');
    assert.equal(await shell.locator('#gateway-setup-code-panel').isHidden(), true);
    assert.equal(await shell.locator('#gateway-setup-code').textContent(), '');
    assert.equal(await shell.locator('#gateway-remote-test').isEnabled(), true);
    if (!options.passwordFirst) {
      await shell.selectOption('#gateway-auth-method', 'password');
      assert.equal(await shell.locator('#gateway-passkey-start').isVisible(), true, 'a pending setup must allow either login method');
      assert.equal((await shell.evaluate(() => window.hajimink.state())).gateway.awaitingPublicOrigin, true);
    }
    assert.match(await shell.evaluate(async () => { try { await window.hajimink.completeSetup(); return ''; } catch (error) { return String(error.message); } }), /真实 HTTPS 地址/);
    assert.match(await shell.evaluate(async () => { try { await window.hajimink.gatewayAccount(); return ''; } catch (error) { return String(error.message); } }), /真实 HTTPS 地址/);
    assert.equal(await localStatus(localPort, '/api/projects', publicHost), 403, 'unknown external Host must not expose business data');
    assert.equal(await localStatus(localPort, '/api/projects', new URL(PENDING_PUBLIC_ORIGIN).host), 401, 'even the reserved Host must require authentication');
    assert.equal(await application.evaluate(({ webContents }, origin) => webContents.getAllWebContents().some(w => !w.isDestroyed() && w.getURL().startsWith(origin)), PENDING_PUBLIC_ORIGIN), false, 'the reserved placeholder must never be opened');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(820, 600));
    const bounds = await shell.locator('#gateway').evaluate(element => ({ scrollWidth: element.scrollWidth, width: element.clientWidth }));
    assert.ok(bounds.scrollWidth <= bounds.width + 1, 'unknown-address guidance must fit the minimum window');
    await shell.locator('#gateway-safety').scrollIntoViewIfNeeded();
    const artifacts = path.join(stage, 'smoke-artifacts'); fs.mkdirSync(artifacts, { recursive: true });
    await shell.screenshot({ path: path.join(artifacts, `late-address-${name}.png`) });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1320, 850));

    // Reopening the desktop must recover the protected state without generating a usable code.
    await quitDesktop(application); application = undefined; shell = undefined;
    application = await electron.launch({ executablePath: binary, args, cwd: root, env: { ...process.env, NODE_EXTRA_CA_CERTS: certFile }, timeout: 60000 });
    shell = await application.firstWindow(); await selectDesktopPage(shell, 'gateway');
    await waitForShellState(shell, value => value.gateway?.state === 'ready' && value.gateway?.awaitingPublicOrigin === true, { timeoutMs: 45000 });
    assert.equal(await shell.locator('#gateway-public-origin').inputValue(), '');
    assert.equal(await shell.locator('#gateway-setup-code-panel').isHidden(), true);
    proxy = createProxy(key, cert, localPort, upgraded);
    await new Promise(resolve => proxy.listen(proxyPort, '127.0.0.1', resolve));
    assert.equal(await testHttpsStatus(origin, '/api/projects'), 403, 'the live fixture tunnel stays closed until its address is bound');
    // Bare server IPs are accepted as HTTPS addresses, including their port.
    await shell.fill('#gateway-public-origin', options.ip ? `127.0.0.1:${proxyPort}` : origin);
    let code;
    if (options.passwordFirst) {
      shell.once('dialog', dialog => dialog.accept()); await shell.click('#gateway-owner-enable');
      await shell.waitForFunction(() => document.querySelector('#gateway-auth-status')?.textContent?.includes('独立登录已启用'), null, { timeout: 60000 });
      assert.equal(await shell.locator('#gateway-setup-code-panel').isHidden(), true);
    } else {
      shell.once('dialog', dialog => dialog.accept()); await shell.click('#gateway-passkey-start');
      await shell.locator('#gateway-setup-code-panel').waitFor({ state: 'visible', timeout: 60000 });
      code = (await shell.locator('#gateway-setup-code').textContent()).trim();
      assert.match(code, /^[A-Za-z0-9_-]{43}$/);
      assert.ok((await shell.locator('#gateway-setup-code-origin').textContent()).includes(origin), 'the one-time code must identify the saved HTTPS address');
      if (options.ip) {
        await shell.selectOption('#gateway-auth-method', 'password');
        assert.equal((await shell.locator('#gateway-setup-code').textContent()).trim(), code, 'selecting password must not invalidate the displayed code');
      }
    }
    state = await shell.evaluate(() => window.hajimink.state());
    assert.equal(state.gateway.awaitingPublicOrigin, false);
    assert.equal(state.gateway.publicOrigin, origin);
    assert.equal(await shell.locator('#gateway-public-origin').inputValue(), origin, 'saved address should show its normalized HTTPS origin');
    assert.equal(await testHttpsStatus(origin, '/api/projects'), 401, 'the bound gateway must still reject anonymous business requests');
    assert.equal(await localStatus(localPort, '/api/projects', new URL(PENDING_PUBLIC_ORIGIN).host), 403, 'the placeholder must stop matching after binding');
    await shell.click('#gateway-remote-test');
    await shell.locator('#gateway-remote-test-feedback').getByText(options.passwordFirst ? /已识别独立登录页面/ : /已识别待设置页面/).waitFor({ timeout: 20000 });
    await shell.locator('#gateway-remote-test-feedback').getByText(/实时连接：一次双向检查通过/).waitFor({ timeout: 20000 });
    await selectDesktopPage(shell, 'workspace'); await shell.click('#reload');
    const remote = await waitForPage(application, page => page.url().startsWith(origin));
    if (options.passwordFirst) {
      await remote.getByRole('heading', { name: '登录你的工作台' }).waitFor({ timeout: 20000 });
      await remote.getByLabel('密码', { exact: true }).fill('fixture-only-password-2026');
      await remote.getByRole('button', { name: '登录', exact: true }).click();
    } else {
      await remote.getByRole('heading', { name: '首次设置登录方式' }).waitFor({ timeout: 20000 });
      await remote.getByLabel('本机一次性设置码').fill(code);
      await remote.getByRole('button', { name: '验证设置码' }).click();
      if (options.ip) {
        await remote.getByLabel('新密码', { exact: true }).waitFor({ timeout: 10000 });
        await remote.getByLabel('新密码', { exact: true }).fill('fixture-only-password-2026');
        await remote.getByLabel('确认新密码', { exact: true }).fill('fixture-only-password-2026');
        await remote.getByRole('button', { name: '设置密码并登录' }).click();
      } else {
        const cdp = await application.context().newCDPSession(remote); await cdp.send('WebAuthn.enable');
        await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
        await remote.getByRole('button', { name: '创建通行密钥' }).click();
      }
    }
    await remote.locator('.workspace[data-stream-state="online"]').waitFor({ timeout: 30000 });
    await selectDesktopPage(shell, 'gateway');
    await shell.waitForFunction(() => document.querySelector('#gateway-auth-status')?.textContent?.includes('独立登录已启用'), null, { timeout: 30000 });
    assert.equal((await shell.evaluate(() => window.hajimink.state())).setup.complete, true);
    shell.once('dialog', dialog => dialog.accept()); await setGatewayEnabled(shell, false);
    await shell.waitForFunction(() => document.querySelector('#gateway-state-badge')?.textContent === '未启动', null, { timeout: 20000 });
  } finally {
    if (shell) try { await Promise.race([shell.evaluate(() => window.hajimink.gatewayStop()), delay(10000)]); } catch {}
    if (application) try { await Promise.race([application.close(), delay(12000).then(() => { throw new Error('隔离测试窗口退出超时'); })]); } catch (error) { console.error(error.message); process.exitCode = 1; }
    if (manager) { try { await manager.stop(); } catch {} manager.close(); }
    for (const socket of upgraded) socket.destroy();
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  }
}
(async () => {
  const keyFile = path.join(temp, 'key.pem'), certFile = path.join(temp, 'cert.pem');
  const openssl = process.env.OPENSSL_BIN || 'C:/Program Files/Git/usr/bin/openssl.exe';
  const result = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
  assert.equal(result.status, 0, 'fixture TLS certificate generation');
  const key = fs.readFileSync(keyFile), cert = fs.readFileSync(certFile);
  const cases = {
    'virtual-passkey': () => runCase('virtual-passkey', true, key, cert, certFile),
    'password-fallback': () => runCase('password-fallback', false, key, cert, certFile, { externalBrowser: true }),
    'system-browser-passkey': () => runCase('system-browser-passkey', true, key, cert, certFile, { externalBrowser: true }),
    'late-domain-passkey': () => runLateAddressCase('late-domain-passkey', { ip: false, passwordFirst: false }, key, cert, certFile),
    'late-ip-password': () => runLateAddressCase('late-ip-password', { ip: true, passwordFirst: false }, key, cert, certFile),
    'late-domain-existing-password': () => runLateAddressCase('late-domain-existing-password', { ip: false, passwordFirst: true }, key, cert, certFile)
  };
  const filter = process.env.HAJIMINK_TEST_CASE;
  if (filter && !Object.hasOwn(cases, filter)) throw new Error('Unknown isolated setup case');
  for (const [name, run] of Object.entries(cases)) {
    if (filter && name !== filter) continue;
    await run(); console.log(JSON.stringify({ setupCase: name, status: 'passed' }));
  }
  console.log(JSON.stringify({ isolatedDesktop: packaged ? 'packaged' : 'development', scope: filter || 'all setup cases', realPublicTunnel: 'not tested', realAuthenticator: 'not tested' }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const name of ['virtual-passkey', 'password-fallback', 'system-browser-passkey', 'late-domain-passkey', 'late-ip-password', 'late-domain-existing-password']) {
    const dir = path.join(temp, name, 'gateway');
    if (fs.existsSync(path.join(dir, 'controller.instance.json')) || fs.existsSync(path.join(dir, 'gateway.instance.lock'))) { console.error('Unconfirmed fixture instance; retained:', temp); process.exitCode = 1; return; }
  }
  const resolved = fs.realpathSync(temp), base = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved).toLowerCase() !== base.toLowerCase() || !path.basename(resolved).startsWith('hajimink-passkey-setup-')) throw new Error('Unexpected test path');
  fs.rmSync(resolved, { recursive: true, force: true });
});
