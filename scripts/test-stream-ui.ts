/** Browser-level realtime checks use a disposable local gateway and fake adapter only. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { WebSocketServer } from 'ws';
import { buildApp } from '../server/app';
import { LIVE_HEARTBEAT_INTERVAL_MS, LIVE_HEARTBEAT_PROTOCOL, LIVE_HEARTBEAT_TIMEOUT_MS } from '../shared/live-heartbeat';
import { removeTempFixture } from '../tests/safe-temp';

const root = path.resolve(import.meta.dirname, '..');
const stage = process.env.HAJIMINK_STREAM_ASSET_ROOT ? path.resolve(process.env.HAJIMINK_STREAM_ASSET_ROOT) : path.join(root, '.local', 'hajimink-stage');
const artifacts = path.join(root, '.local', 'hajimink-stage', 'smoke-artifacts');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-stream-ui-'));
let browser: Browser | undefined, gateway: Awaited<ReturnType<typeof buildApp>> | undefined, proxy: http.Server | undefined;
let upstreamPort = 0, mode: 'blocked' | 'wrong-greeting' | 'legacy' | 'unanswered' | 'forward' = 'blocked', fakeConnections = 0, legacyPings = 0, unansweredPings = 0;
const sockets = new Set<Duplex>();
const clients = new Set<Duplex>();
const upstreams = new Set<Duplex>();
let browserToGatewayBytes = 0;
const fakeWebSockets = new WebSocketServer({ noServer: true });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function track(socket: Duplex) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }
const actions: string[] = [];
const status = { connected: true, compatible: true, accessMode: 'full' as const, version: 'fixture', supportedVersion: 'fixture' };
const adapter = Object.assign(new EventEmitter(), {
  status, close() {}, touch() {},
  catalog: async () => ({ projects: [], threads: [] }), models: () => [],
  view: async () => { throw new Error('no fixture conversation'); }, viewCached: () => undefined,
  create: async () => { actions.push('create'); return {}; }, send: async () => { actions.push('send'); return {}; },
  interrupt: async () => { actions.push('interrupt'); return {}; }, settings: async () => { actions.push('settings'); return {}; }, respond: async () => { actions.push('respond'); return {}; },
});
async function main() {
  if (!fs.existsSync(path.join(stage, 'dist', 'index.html'))) throw new Error('请先构建隔离工作台');
  proxy = http.createServer((request, response) => {
    const upstream = http.request({ host: '127.0.0.1', port: upstreamPort, method: request.method, path: request.url, headers: request.headers }, result => { response.writeHead(result.statusCode || 502, result.headers); result.pipe(response); });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  proxy.on('upgrade', (request, client, head) => {
    track(client); clients.add(client); client.once('close', () => clients.delete(client));
    client.on('data', data => { browserToGatewayBytes += data.length; });
    if (mode === 'blocked') { client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    if (mode === 'wrong-greeting' || mode === 'legacy' || mode === 'unanswered') {
      const legacy = mode === 'legacy', unanswered = mode === 'unanswered';
      fakeWebSockets.handleUpgrade(request, client, head, socket => {
        fakeConnections++;
        socket.send(JSON.stringify({ type: 'desktop', harness: legacy || unanswered ? 'codex' : 'other', desktop: status, ...(unanswered ? { heartbeat: LIVE_HEARTBEAT_PROTOCOL } : {}) }));
        socket.on('message', data => { try { if (JSON.parse(data.toString())?.type === 'heartbeat-ping') { if (legacy) legacyPings++; if (unanswered) unansweredPings++; } } catch {} });
      });
      return;
    }
    const upstream = net.createConnection(upstreamPort, '127.0.0.1'); track(upstream); upstreams.add(upstream); upstream.once('close', () => upstreams.delete(upstream));
    upstream.once('connect', () => {
      const headers: string[] = [];
      for (let i = 0; i < request.rawHeaders.length; i += 2) headers.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    upstream.on('close', () => client.destroy()); client.on('close', () => upstream.destroy());
  });
  await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as net.AddressInfo).port;
  const origin = `http://127.0.0.1:${proxyPort}`;
  process.chdir(stage);
  gateway = await buildApp({ mode: 'local', port: proxyPort, publicOrigin: origin, dataDir: path.join(temp, 'db') }, { adapter: adapter as any });
  await gateway.app.listen({ port: 0, host: '127.0.0.1' });
  upstreamPort = (gateway.app.server.address() as net.AddressInfo).port;
  const launch = process.env.HAJIMINK_BROWSER ? { executablePath: process.env.HAJIMINK_BROWSER } : process.platform === 'win32' ? { channel: 'msedge' } : {};
  browser = await chromium.launch({ headless: true, ...launch });
  const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
  const page = await context.newPage(); await page.goto(origin);
  const banner = page.locator('.connection-banner');
  await banner.getByText(/实时同步未连接/).waitFor({ timeout: 20000 });
  assert.match((await banner.textContent()) || '', /WebSocket/);
  assert.equal(await page.locator('.send-button').isDisabled(), true);
  const draft = '隔离测试草稿，不会发送';
  await page.getByLabel('消息输入框').fill(draft);
  mode = 'wrong-greeting';
  await page.getByRole('button', { name: '立即重试实时连接' }).click();
  for (let i = 0; i < 100 && !fakeConnections; i++) await delay(50);
  assert.ok(fakeConnections, 'the proxy should have accepted the fake WebSocket');
  await banner.getByText(/正在连接实时同步/).waitFor({ timeout: 3000 });
  assert.equal(await page.locator('.send-button').isDisabled(), true, 'transport open without the right greeting must not enable actions');
  await banner.getByText(/实时同步未连接/).waitFor({ timeout: 16000 });
  assert.equal(await page.getByLabel('消息输入框').inputValue(), draft);
  const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(layout.scrollWidth <= layout.width + 1, 'the failure banner must fit a narrow viewport');
  fs.mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'stream-retry-mobile.png') });
  mode = 'forward'; await page.getByRole('button', { name: '立即重试实时连接' }).click();
  await banner.waitFor({ state: 'hidden', timeout: 15000 });
  assert.equal(await page.locator('.send-button').isEnabled(), true, 'a valid gateway greeting enables supported actions');
  assert.equal(await page.getByLabel('消息输入框').inputValue(), draft);
  mode = 'blocked'; for (const socket of [...sockets]) socket.destroy();
  await banner.getByText(/实时同步未连接/).waitFor({ timeout: 15000 });
  assert.equal(await page.locator('.send-button').isDisabled(), true);
  assert.equal(await page.getByLabel('消息输入框').inputValue(), draft);
  mode = 'forward'; await page.getByRole('button', { name: '立即重试实时连接' }).click();
  await banner.waitFor({ state: 'hidden', timeout: 15000 });
  assert.equal(await page.locator('.send-button').isEnabled(), true);
  assert.equal(await page.getByLabel('消息输入框').inputValue(), draft);
  assert.deepEqual(actions, [], 'reconnect must never send or repeat an Agent action');
  await context.close();

  // A legacy server does not advertise the optional heartbeat. Its existing
  // live stream must keep working; the new client must not send unknown messages.
  mode = 'legacy';
  const legacyContext = await browser.newContext({ viewport: { width: 360, height: 780 } });
  const legacyPage = await legacyContext.newPage(); await legacyPage.clock.install(); await legacyPage.goto(origin);
  await legacyPage.locator('.workspace[data-stream-state="online"]').waitFor({ timeout: 15000 });
  await legacyPage.getByLabel('消息输入框').fill(draft);
  await legacyPage.clock.fastForward(90_000);
  assert.equal(await legacyPage.locator('.send-button').isEnabled(), true, 'legacy gateways must remain usable');
  assert.equal(legacyPings, 0, 'client must not send the new heartbeat to a legacy gateway');
  await legacyContext.close();

  // A greeting alone must not enable work when a new server advertises a
  // heartbeat but never acknowledges the client's first challenge.
  mode = 'unanswered';
  const pendingContext = await browser.newContext({ viewport: { width: 360, height: 780 } });
  const pendingPage = await pendingContext.newPage(); await pendingPage.clock.install(); await pendingPage.goto(origin);
  await pendingPage.locator('.workspace').waitFor(); await pendingPage.getByLabel('消息输入框').fill(draft);
  for (let i = 0; i < 100 && !unansweredPings; i++) await delay(50);
  assert.ok(unansweredPings, 'the initial liveness challenge should reach the proxy');
  assert.notEqual(await pendingPage.locator('.workspace').getAttribute('data-stream-state'), 'online');
  assert.equal(await pendingPage.locator('.send-button').isDisabled(), true);
  await pendingPage.clock.fastForward(LIVE_HEARTBEAT_TIMEOUT_MS + 1);
  await pendingPage.locator('.connection-banner').getByText(/实时同步未连接/).waitFor({ timeout: 6000 });
  assert.equal(await pendingPage.getByLabel('消息输入框').inputValue(), draft);
  await pendingContext.close();

  // Drop only browser-to-gateway WebSocket traffic while leaving TCP open and
  // HTTP working. This models a half-open tunnel without touching real networks.
  mode = 'forward';
  const halfContext = await browser.newContext({ viewport: { width: 360, height: 780 } });
  const halfPage = await halfContext.newPage(); await halfPage.clock.install(); await halfPage.goto(origin);
  await halfPage.locator('.workspace[data-stream-state="online"]').waitFor({ timeout: 15000 });
  await halfPage.getByLabel('消息输入框').fill(draft);
  assert.ok(clients.size > 0, 'an actual proxied socket is needed for the half-open check');
  for (const socket of clients) socket.pause();
  await halfPage.clock.fastForward(LIVE_HEARTBEAT_INTERVAL_MS);
  await delay(150); // Let the real TCP proxy run while the browser clock is held.
  await halfPage.clock.fastForward(LIVE_HEARTBEAT_TIMEOUT_MS + 1);
  await halfPage.locator('.connection-banner').getByText(/实时同步未连接/).waitFor({ timeout: 6000 });
  assert.equal(await halfPage.locator('.send-button').isDisabled(), true, 'a half-open connection must not allow writes');
  assert.equal(await halfPage.getByLabel('消息输入框').inputValue(), draft);
  assert.equal((await halfPage.request.get(`${origin}/api/harnesses`)).status(), 200, 'HTTP must remain available during the simulated WebSocket failure');
  for (const socket of clients) socket.resume();
  await halfPage.getByRole('button', { name: '立即重试实时连接' }).click();
  await halfPage.locator('.workspace[data-stream-state="online"]').waitFor({ timeout: 15000 });
  assert.equal(await halfPage.getByLabel('消息输入框').inputValue(), draft);

  // Now allow requests to reach the gateway but silently suppress its replies.
  // The real wait keeps the server's anti-flood clock independent of fake time.
  await delay(1200);
  assert.ok(upstreams.size > 0, 'an upstream socket is needed for the reverse-direction check');
  for (const socket of upstreams) socket.pause();
  const bytesBefore = browserToGatewayBytes;
  await halfPage.clock.fastForward(LIVE_HEARTBEAT_INTERVAL_MS);
  for (let i = 0; i < 30 && browserToGatewayBytes === bytesBefore; i++) await delay(50);
  assert.ok(browserToGatewayBytes > bytesBefore, 'heartbeat bytes must reach the proxy before simulating a missing reply');
  await delay(150);
  await halfPage.clock.fastForward(LIVE_HEARTBEAT_TIMEOUT_MS + 1);
  await halfPage.locator('.connection-banner').getByText(/实时同步未连接/).waitFor({ timeout: 6000 });
  assert.equal(await halfPage.locator('.send-button').isDisabled(), true);
  assert.equal(await halfPage.getByLabel('消息输入框').inputValue(), draft);
  for (const socket of upstreams) socket.resume();
  await halfPage.getByRole('button', { name: '立即重试实时连接' }).click();
  await halfPage.locator('.workspace[data-stream-state="online"]').waitFor({ timeout: 15000 });
  assert.equal(await halfPage.getByLabel('消息输入框').inputValue(), draft);
  assert.deepEqual(actions, [], 'heartbeat failure and recovery must not send any Agent action');
  await halfContext.close();
  console.log(JSON.stringify({ assetSource: process.env.HAJIMINK_STREAM_ASSET_ROOT ? 'packaged-assets' : 'development', httpWorksWebSocketBlocked: 'passed', wrongGreetingRejected: 'passed', watchdogAndManualRetry: 'passed', validGatewayGreeting: 'passed', reconnectAfterDrop: 'passed', legacyGateway: 'passed', initialChallengeRequired: 'passed', halfOpenBothDirections: 'passed', halfOpenRecovery: 'passed', draftPreserved: 'passed', agentWrites: 0, mobileLayout: 'passed', realTunnel: 'not tested' }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close().catch(() => {});
  for (const socket of [...sockets]) socket.destroy();
  for (const socket of fakeWebSockets.clients) socket.terminate();
  fakeWebSockets.close();
  proxy?.closeAllConnections();
  await gateway?.app.close().catch(() => {});
  if (proxy) await new Promise<void>(resolve => proxy!.close(() => resolve()));
  process.chdir(root);
  removeTempFixture(temp, 'hajimink-stream-ui-');
});
