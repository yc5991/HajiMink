/** Real owner-mode gateway behind disposable HTTPS; no production data or Agent writes. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium, _electron as electron, type Browser, type ElectronApplication } from 'playwright';
import { createRequire } from 'node:module';
import { Store } from '../server/store';
import { OwnerAuth } from '../server/owner-auth';
import { buildApp } from '../server/app';
import { removeTempFixture } from '../tests/safe-temp';

const root = path.resolve(import.meta.dirname, '..');
const stage = path.join(root, '.local', 'hajimink-stage');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-device-ui-'));
const password = 'fixture-only-password-2026';
const require = createRequire(import.meta.url);
const { selectDesktopPage, selectDesktopConnection } = require('./desktop-page-menu.cjs');
let browser: Browser | undefined;
let desktop: ElectronApplication | undefined;
let gateway: Awaited<ReturnType<typeof buildApp>> | undefined;
let proxy: https.Server | undefined;
let backendPort = 0;

async function main() {
  if (!fs.existsSync(path.join(stage, 'dist', 'index.html'))) throw new Error('请先在独立目录构建界面：npx vite build --outDir .local/hajimink-stage/dist');
  const openssl = process.env.OPENSSL_BIN || (process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/usr/bin/openssl.exe') ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
  const key = path.join(temp, 'fixture-key.pem'), cert = path.join(temp, 'fixture-cert.pem');
  const generated = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
  if (generated.status !== 0) throw new Error('生成临时测试证书失败，请检查 OpenSSL');
  proxy = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const upstream = http.request({ host: '127.0.0.1', port: backendPort, method: req.method, path: req.url, headers: req.headers }, response => {
      res.writeHead(response.statusCode || 502, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as { port: number }).port;
  const origin = `https://127.0.0.1:${port}`, host = `127.0.0.1:${port}`;
  const store = new Store(path.join(temp, 'db'));
  const enrollment = new OwnerAuth(store.db, origin); await enrollment.setPassword(password);
  const adapter = Object.assign(new EventEmitter(), { status: { connected: false }, catalog: async () => ({ projects: [], threads: [] }), models: () => [], close() {} });
  process.chdir(stage);
  gateway = await buildApp({ mode: 'owner', port, publicOrigin: origin, dataDir: path.join(temp, 'db') }, { store, adapter: adapter as any });
  await gateway.app.listen({ port: 0, host: '127.0.0.1' });
  backendPort = (gateway.app.server.address() as { port: number }).port;
  // The generated fixture certificate is not trusted in this process. Production checks must not ignore it.
  const { probeConnection } = require('../desktop/connection-probe.cjs');
  assert.equal((await probeConnection({ url: origin })).state, 'unreachable', 'untrusted HTTPS certificates must be rejected');
  const boot = await gateway.app.inject({ url: '/api/auth/bootstrap', headers: { host } });
  const cookie = boot.cookies.map(value => `${value.name}=${value.value}`).join('; ');
  const headers = { host, origin, cookie, 'x-agent-control-csrf': boot.json().csrf };
  async function post(url: string, payload: Record<string, unknown>) {
    const response = await gateway!.app.inject({ method: 'POST', url, headers, payload });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`); return response.json();
  }
  const launch = process.env.HAJIMINK_BROWSER ? { executablePath: process.env.HAJIMINK_BROWSER } : process.platform === 'win32' ? { channel: 'msedge' } : {};
  browser = await chromium.launch({ headless: true, ...launch });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 780 } });
  const page = await context.newPage();
  const requested = await post('/api/auth/device/request', { name: '测试电脑甲' });
  await page.goto(`${origin}/device`);
  await page.getByRole('heading', { name: '登录你的工作台' }).waitFor();
  await page.getByRole('link', { name: '文档', exact: true }).click();
  await page.getByRole('heading', { name: '文档', exact: true }).waitFor();
  await page.getByRole('heading', { name: '密码与通行密钥', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'login documentation must fit mobile screens');
  await page.goto(`${origin}/device`);
  await page.getByRole('heading', { name: '登录你的工作台' }).waitFor();
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '授权桌面设备' }).waitFor();
  await page.getByLabel('确认码', { exact: true }).fill(requested.userCode);
  await page.getByRole('button', { name: '查找设备' }).click();
  await page.getByText('测试电脑甲', { exact: true }).waitFor();
  assert.equal(await page.getByText(requested.userCode, { exact: true }).count(), 1);
  const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(metrics.scrollWidth <= metrics.width, 'mobile authorization page must not overflow horizontally');
  fs.mkdirSync(path.join(stage, 'smoke-artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(stage, 'smoke-artifacts', 'device-authorization-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '允许连接' }).click();
  await page.getByRole('heading', { name: '已允许连接' }).waitFor();
  assert.equal((await post('/api/auth/device/poll', { requestId: requested.requestId })).state, 'approved');
  const issued = await post('/api/auth/device/exchange', { requestId: requested.requestId });
  await page.goto(`${origin}/account`);
  await page.getByRole('heading', { name: '已授权的桌面设备' }).waitFor();
  await page.getByText('测试电脑甲', { exact: true }).waitFor();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '撤销 测试电脑甲 的授权' }).click();
  await page.getByText('暂无已授权的桌面设备。').waitFor();
  assert.equal(gateway.devices.session(issued.token), undefined);

  const rejected = await post('/api/auth/device/request', { name: '测试电脑乙' });
  await page.goto(`${origin}/device`); await page.getByLabel('确认码', { exact: true }).fill(rejected.userCode);
  await page.getByRole('button', { name: '查找设备' }).click();
  await page.getByRole('button', { name: '拒绝连接' }).click();
  await page.getByRole('heading', { name: '已拒绝连接' }).waitFor();
  assert.equal((await post('/api/auth/device/poll', { requestId: rejected.requestId })).state, 'denied');

  const deviceRequest = gateway.devices.create('受限设备', 'fixture');
  gateway.devices.decide(gateway.devices.lookup(deviceRequest.userCode, 'owner').approvalTicket, true);
  const device = gateway.devices.exchange(deviceRequest.requestId);
  const deviceContext = await browser.newContext({ ignoreHTTPSErrors: true });
  await deviceContext.addCookies([{ name: '__Host-ac_device', value: device.token, url: origin, secure: true, httpOnly: true, sameSite: 'Strict' }]);
  const devicePage = await deviceContext.newPage(); await devicePage.goto(`${origin}/account`);
  await devicePage.getByRole('heading', { name: '桌面设备已连接' }).waitFor();
  assert.equal(await devicePage.getByText('管理登录方式', { exact: true }).count(), 0);
  await devicePage.goto(`${origin}/device`);
  await devicePage.getByText('设备账号不能批准其他设备，请使用所有者账号登录。').waitFor();
  assert.equal(await devicePage.getByRole('button', { name: '查找设备' }).count(), 0);

  // Reauthentication must not silently discard the intended destination.
  store.db.prepare('UPDATE owner_sessions SET created_at=?').run(Date.now() - 301000);
  const fresh = await post('/api/auth/device/request', { name: '重新验证测试' });
  await page.goto(`${origin}/device`); await page.getByLabel('确认码', { exact: true }).fill(fresh.userCode);
  await page.getByRole('button', { name: '查找设备' }).click();
  await page.getByRole('link', { name: '重新验证所有者身份' }).click();
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '授权桌面设备' }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/device');
  // Drive the actual Electron shell against the same disposable HTTPS gateway.
  // openExternal is intercepted so the test never launches a real user browser.
  const { ConnectionStore } = require('../desktop/connections.cjs');
  const desktopDir = path.join(temp, 'desktop-data');
  const connections = new ConnectionStore(desktopDir, 'linux');
  connections.add({ name: '测试网关', url: origin });
  const connectionId = connections.snapshot().selected;
  const packagedBinary = process.env.HAJIMINK_DESKTOP_BINARY;
  const desktopArgs = [...(packagedBinary ? [] : ['.']), '--ignore-certificate-errors', `--hajimink-data-dir=${desktopDir}`];
  const desktopOptions = { executablePath: packagedBinary || require('electron') as string, args: desktopArgs, cwd: root, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert } as Record<string, string>, timeout: 60000 };
  desktop = await electron.launch(desktopOptions);
  await desktop.evaluate(({ shell }) => { (shell as any).openExternal = async (url: string) => { (globalThis as any).testExternalUrl = url; }; });
  let shellPage = await desktop.firstWindow();
  await shellPage.locator('#authorize').waitFor({ state: 'visible' });
  await shellPage.locator('#authorize').click();
  await shellPage.locator('#authorization-code').waitFor({ state: 'visible', timeout: 20000 });
  const code = (await shellPage.locator('#authorization-code').textContent())!.trim();
  const viewVisible = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.some(child => child.getVisible()));
  assert.equal(viewVisible, false, 'the remote view must not obscure the authorization dialog');
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(await desktop.evaluate(() => (globalThis as any).testExternalUrl), `${origin}/device`);
  await page.goto(`${origin}/device`); await page.getByLabel('确认码', { exact: true }).fill(code);
  await page.getByRole('button', { name: '查找设备' }).click();
  await page.getByText('HajiMink · 测试网关', { exact: true }).waitFor();
  await page.getByRole('button', { name: '允许连接' }).click();
  await shellPage.getByText('已连接，设备凭据受系统保护', { exact: true }).waitFor({ timeout: 20000 });
  const cookieState = await desktop.evaluate(async ({ session }, { connectionId, origin }) => {
    const cookies = await session.fromPartition(`hajimink-${connectionId}`).cookies.get({ url: origin, name: '__Host-ac_device' });
    return cookies.map(value => ({ value: value.value, httpOnly: value.httpOnly, secure: value.secure, sameSite: value.sameSite }));
  }, { connectionId, origin });
  assert.equal(cookieState.length, 1); assert.equal(cookieState[0].httpOnly, true); assert.equal(cookieState[0].secure, true); assert.equal(cookieState[0].sameSite, 'strict');
  const secret = cookieState[0].value;
  const encrypted = fs.readFileSync(path.join(desktopDir, 'device-credentials', `${connectionId}.bin`));
  assert.equal(encrypted.includes(Buffer.from(secret)), false, 'device token must not be saved as plaintext');
  assert.equal(fs.readFileSync(path.join(desktopDir, 'connections.json'), 'utf8').includes(secret), false);
  assert.equal((await shellPage.locator('body').innerText()).includes(secret), false, 'desktop renderer must not receive a token');
  const remoteBoundary = await desktop.evaluate(async ({ webContents }, origin) => {
    const content = webContents.getAllWebContents().find(value => !value.isDestroyed() && value.getURL().startsWith(origin));
    return content && await content.executeJavaScript('[typeof window.hajimink, typeof require, document.cookie]');
  }, origin);
  assert.deepEqual(remoteBoundary?.slice(0, 2), ['undefined', 'undefined']);
  assert.equal(remoteBoundary?.[2].includes(secret), false, 'HttpOnly token must not be visible to remote JavaScript');
  await desktop.close(); desktop = undefined;
  desktop = await electron.launch(desktopOptions); shellPage = await desktop.firstWindow();
  await shellPage.locator('#authorize').waitFor({ state: 'visible' });
  let restored = false;
  for (let i = 0; i < 80; i++) {
    restored = await desktop.evaluate(async ({ session }, { connectionId, origin }) => (await session.fromPartition(`hajimink-${connectionId}`).cookies.get({ url: origin, name: '__Host-ac_device' })).length === 1, { connectionId, origin });
    if (restored) break; await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(restored, true, 'protected credential must restore after desktop restart');
  // A second connection to the same origin has a separate session and no grant.
  await desktop.evaluate(({ shell }) => { (shell as any).openExternal = async (url: string) => { (globalThis as any).testExternalUrl = url; }; });
  await selectDesktopPage(shellPage, 'settings');
  await shellPage.locator('#add').click(); await shellPage.locator('#name').fill('隔离的第二连接');
  await shellPage.locator('#provider').selectOption('self-hosted');
  await shellPage.locator('#url').fill(`127.0.0.1:${port}`);
  await shellPage.locator('#test-connection').click();
  await shellPage.locator('#probe-status').getByText(/已识别网关登录接口/).waitFor({ timeout: 10000 });
  await shellPage.locator('#connection-form button[type=submit]').click();
  await shellPage.waitForFunction(() => document.querySelector('#connection-select span')?.textContent === '隔离的第二连接');
  const secondId = await shellPage.locator('#connection-select').getAttribute('data-selected');
  assert.ok(secondId);
  assert.notEqual(secondId, connectionId);
  const secondSaved = JSON.parse(fs.readFileSync(path.join(desktopDir, 'connections.json'), 'utf8')).connections.find((item: { id: string }) => item.id === secondId);
  assert.equal(secondSaved.url, origin); assert.equal(secondSaved.provider, 'self-hosted');
  const otherCookies = await desktop.evaluate(async ({ session }, { secondId, origin }) => (await session.fromPartition(`hajimink-${secondId}`).cookies.get({ url: origin, name: '__Host-ac_device' })).length, { secondId, origin });
  assert.equal(otherCookies, 0, 'same-origin connections must not share device cookies');
  await shellPage.locator('#authorize').click(); await shellPage.locator('#authorization-code').waitFor({ state: 'visible', timeout: 20000 });
  assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM device_requests WHERE device_name=?').get('HajiMink · 隔离的第二连接') as any).count, 1);
  await shellPage.locator('#authorization-close').click();
  let canceled = false;
  for (let i = 0; i < 50; i++) {
    canceled = (store.db.prepare('SELECT COUNT(*) AS count FROM device_requests WHERE device_name=?').get('HajiMink · 隔离的第二连接') as any).count === 0;
    if (canceled) break; await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(canceled, true, 'cancel must invalidate the pending server request');
  await selectDesktopConnection(shellPage, connectionId);
  await page.goto(`${origin}/account`); await page.getByText('HajiMink · 测试网关', { exact: true }).waitFor();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '撤销 HajiMink · 测试网关 的授权' }).click();
  await page.getByText('HajiMink · 测试网关', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(gateway.devices.session(secret), undefined);
  const stillAuthenticated = await desktop.evaluate(async ({ webContents }, origin) => {
    const content = webContents.getAllWebContents().find(value => !value.isDestroyed() && value.getURL().startsWith(origin));
    return content && await content.executeJavaScript(`fetch('/api/auth/bootstrap').then(response => response.json()).then(value => value.authenticated)`);
  }, origin);
  assert.equal(stillAuthenticated, false, 'revoked token must no longer authenticate the desktop session');
  console.log('PASS device UI and Electron: self-hosted IP setup with real HTTPS probe, real HTTPS owner login, approval/denial, restricted device account, reauthentication, mobile layout, system-browser flow, protected token restoration, separate sessions, cancellation and revocation');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await desktop?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (proxy) proxy.closeAllConnections();
  await gateway?.app.close().catch(() => {});
  if (proxy) await new Promise<void>(resolve => proxy!.close(() => resolve()));
  process.chdir(root);
  removeTempFixture(temp, 'hajimink-device-ui-');
});
