import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream';
import type { Socket } from 'node:net';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load: (text: string, options: { schema: unknown }) => unknown; JSON_SCHEMA: unknown };
const upstreamCookieLifetime = 15 * 60 * 1000;
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export interface DshPreviewOptions { upstreamPort: number; port: number; credentialsPath: string }
function port(value: number, allowZero = false) { if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 65535) throw new Error('DSH 预览端口无效'); return value; }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** Use only DSH's browser-session grant; never expose or rewrite its credential vault. */
function browserSecret(credentialsPath: string) {
  let document: unknown;
  try { document = yaml.load(readFileSync(credentialsPath, 'utf8'), { schema: yaml.JSON_SCHEMA }); }
  catch { throw new Error('无法读取本机 DSH 网页认证记录'); }
  const records = object(document) && document.version === 1 && object(document.records) ? document.records : undefined;
  const record = records?.['client-connection/browser-session'];
  const payload = object(record) && record.kind === 'grant' && object(record.payload) ? record.payload : undefined;
  if (payload?.version !== 1 || typeof payload.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.secret)) throw new Error('DSH 网页认证记录版本不兼容，请先保持使用原桌面应用');
  const secret = Buffer.from(payload.secret, 'base64url');
  if (secret.length !== 32 || secret.toString('base64url') !== payload.secret) throw new Error('DSH 网页认证记录格式不兼容');
  return secret;
}

function cleanHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const blocked = new Set([...hopHeaders, ...(headers.connection || '').split(',').map(value => value.trim().toLowerCase())]);
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (blocked.has(name) || name === 'cookie' || name === 'set-cookie' || name === 'authorization' || name === 'host' || name === 'origin' || name === 'referer' || name === 'forwarded' || name.startsWith('x-forwarded-') || name.startsWith('cf-') || name === 'x-peer-token') continue;
    if (value !== undefined) result[name] = value;
  }
  return result;
}
function respond(response: ServerResponse, status: number, message: string) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(message);
}
function rejectUpgrade(socket: Duplex, status: number, message: string) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${message}`);
}

/** Standalone loopback proof; deliberately not registered on the public gateway. */
export async function startDshLocalPreview(options: DshPreviewOptions) {
  port(options.port, true); port(options.upstreamPort);
  const authority = `127.0.0.1:${options.upstreamPort}`;
  const origin = `http://${authority}`;
  const secret = browserSecret(options.credentialsPath);
  let cachedCookie = '', cookieIssuedAt = 0;
  const cookie = () => {
    const now = Date.now();
    if (!cachedCookie || now - cookieIssuedAt > upstreamCookieLifetime / 2) {
      const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + upstreamCookieLifetime })).toString('base64url');
      cachedCookie = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}=v1.${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
      cookieIssuedAt = now;
    }
    return cachedCookie;
  };
  try {
    // Fingerprint the web listener before sending it any local credential.
    const anonymous = await fetch(origin, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const text = await anonymous.text();
    if (anonymous.status !== 401 || text !== 'dsh web authentication required; reopen the URL printed by dsh web.\n') throw new Error('目标端口不是已识别的 DSH 网页入口');
    const authenticated = await fetch(origin, { headers: { cookie: cookie() }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const html = await authenticated.text();
    if (authenticated.status !== 200 || !html.includes('__DSH_BOOT__') || !html.includes('<title>DeepSeek Harness</title>')) throw new Error('无法使用当前本机认证记录连接 DSH');
  } catch (error) {
    secret.fill(0); cachedCookie = '';
    if (error instanceof Error && /目标端口|当前本机认证/.test(error.message)) throw error;
    throw new Error('DSH 网页入口无法连接，请检查桌面应用和上游端口');
  }

  let previewPort = options.port;
  const allowed = (request: IncomingMessage, upgrade = false) => {
    const host = request.headers.host;
    if (host !== `127.0.0.1:${previewPort}` && host !== `localhost:${previewPort}`) return false;
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')) return false;
    if (!request.url?.startsWith('/') || request.url.startsWith('//') || /[\r\n\\]/.test(request.url)) return false;
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    const expectedOrigin = `http://${host}`;
    if (request.headers.origin && request.headers.origin !== expectedOrigin) return false;
    if ((upgrade || !['GET', 'HEAD'].includes(request.method || '')) && request.headers.origin !== expectedOrigin) return false;
    return true;
  };
  const requestHeaders = (request: IncomingMessage, upgrade = false) => ({
    ...cleanHeaders(request.headers), host: authority, cookie: cookie(), origin,
    ...(request.headers.referer ? { referer: `${origin}/` } : {}),
    'sec-fetch-site': 'same-origin',
    ...(upgrade ? { connection: 'Upgrade', upgrade: 'websocket' } : {}),
  });
  const requests = new Set<http.ClientRequest>();
  const sockets = new Set<Duplex>();
  const trackSocket = (socket: Duplex) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  };
  const server = http.createServer((request, response) => {
    if (!allowed(request)) { request.resume(); respond(response, 403, '此 DSH 预览仅允许从本机页面访问'); return; }
    const upstream = http.request({ hostname: '127.0.0.1', port: options.upstreamPort, method: request.method, path: request.url, headers: requestHeaders(request) });
    requests.add(upstream); upstream.once('close', () => requests.delete(upstream));
    // A streaming response may stay open indefinitely; the deadline only covers response headers.
    const deadline = setTimeout(() => upstream.destroy(new Error('DSH response timeout')), 15000); deadline.unref();
    upstream.once('response', incoming => {
      clearTimeout(deadline);
      const headers = cleanHeaders(incoming.headers);
      headers['cache-control'] = 'no-store'; headers['referrer-policy'] = 'no-referrer';
      headers['x-content-type-options'] = 'nosniff'; headers['x-frame-options'] = 'SAMEORIGIN';
      const location = incoming.headers.location;
      if (location) {
        try { const next = new URL(location, origin); if (next.origin === origin) headers.location = `${next.pathname}${next.search}${next.hash}`; else delete headers.location; }
        catch { delete headers.location; }
      }
      if (response.destroyed) { incoming.destroy(); return; }
      response.writeHead(incoming.statusCode || 502, headers);
      pipeline(incoming, response, () => {});
    });
    upstream.once('error', () => { clearTimeout(deadline); respond(response, 502, 'DSH 暂时无法连接，请保持桌面应用运行；请求不会自动重发'); });
    request.once('aborted', () => upstream.destroy());
    response.once('close', () => { if (!response.writableFinished) upstream.destroy(); });
    pipeline(request, upstream, () => {});
  });
  server.on('connection', trackSocket);
  server.on('upgrade', (request, downstream, head) => {
    if (!allowed(request, true) || request.headers.upgrade?.toLowerCase() !== 'websocket') { rejectUpgrade(downstream, 403, 'Untrusted local preview origin'); return; }
    const upstream = http.request({ hostname: '127.0.0.1', port: options.upstreamPort, method: 'GET', path: request.url, headers: requestHeaders(request, true) });
    requests.add(upstream); upstream.once('close', () => requests.delete(upstream));
    const deadline = setTimeout(() => upstream.destroy(new Error('DSH upgrade timeout')), 10000); deadline.unref();
    downstream.once('close', () => upstream.destroy());
    upstream.once('upgrade', (incoming, socket: Socket, upstreamHead) => {
      clearTimeout(deadline); trackSocket(socket);
      if (downstream.destroyed) { socket.destroy(); return; }
      const headers = cleanHeaders(incoming.headers); headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
      downstream.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(headers).flatMap(([key, value]) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(item => `${key}: ${item}\r\n`)).join('')}\r\n`);
      if (upstreamHead.length) downstream.write(upstreamHead);
      if (head.length) socket.write(head);
      // Raw duplex forwarding preserves DSH mux frames, binary uploads and backpressure.
      downstream.pipe(socket); socket.pipe(downstream);
      socket.once('close', () => downstream.destroy()); downstream.once('close', () => socket.destroy());
    });
    upstream.once('response', incoming => { clearTimeout(deadline); incoming.resume(); rejectUpgrade(downstream, 502, 'DSH rejected the realtime connection'); });
    upstream.once('error', () => { clearTimeout(deadline); rejectUpgrade(downstream, 502, 'DSH realtime connection unavailable'); });
    upstream.end();
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  } catch { secret.fill(0); cachedCookie = ''; throw new Error('本地预览端口不可用，请选择另一个端口'); }
  const address = server.address(); if (address && typeof address !== 'string') previewPort = address.port;
  let closed: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${previewPort}/`, server,
    close() {
      return closed ||= new Promise<void>(resolve => {
        secret.fill(0); cachedCookie = '';
        server.close(() => resolve());
        for (const request of requests) request.destroy();
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}
