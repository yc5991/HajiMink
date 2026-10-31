import { expect, it, vi } from 'vitest';
import http from 'node:http';
// @ts-expect-error The desktop probe is shared directly with Electron.
import { probeConnection, probePublicGateway } from '../desktop/connection-probe.cjs';

const bootstrap = { mode: 'owner', authenticated: false, csrf: 'a'.repeat(64) };
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
const gatewayError = (code: string, status = 403) => jsonResponse({ error: { code, message: '请求无效' } }, status);

it('probes the actual loopback gateway login endpoint without credentials', async () => {
  let observed: { method?: string; url?: string; cookie?: string; authorization?: string } | undefined;
  const server = http.createServer((request, response) => {
    observed = { method: request.method, url: request.url, cookie: request.headers.cookie, authorization: request.headers.authorization };
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(bootstrap));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    expect(await probeConnection({ url: `http://127.0.0.1:${port}` })).toMatchObject({ state: 'identified' });
    expect(observed).toEqual({ method: 'GET', url: '/api/auth/bootstrap', cookie: undefined, authorization: undefined });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('never follows redirects and distinguishes restrictions, bad status and non-gateway pages', async () => {
  const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com' } }))
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockResolvedValueOnce(new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }))
    .mockResolvedValueOnce(jsonResponse({ ok: true }));
  expect((await probeConnection({ url: '203.0.113.10:8443' }, { fetchImpl })).state).toBe('restricted');
  expect(fetchImpl.mock.calls[0][0].href).toBe('https://203.0.113.10:8443/api/auth/bootstrap');
  expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit', headers: { accept: 'application/json' } });
  for (const state of ['restricted', 'unrecognized', 'unrecognized', 'unrecognized']) expect((await probeConnection({ url: 'https://example.com' }, { fetchImpl })).state).toBe(state);
});

it('checks an unsaved remote address without claiming gateway identity or protection', async () => {
  const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(bootstrap))
    .mockResolvedValueOnce(jsonResponse({ ...bootstrap, mode: 'local', authenticated: false }))
    .mockResolvedValueOnce(jsonResponse({ ...bootstrap, authenticated: true }))
    .mockResolvedValueOnce(jsonResponse({ ...bootstrap, mode: 'access' }));
  const options = { fetchImpl, publicDraft: true };
  expect(await probeConnection({ url: 'example.com' }, options)).toMatchObject({ state: 'identified', message: expect.stringContaining('尚未确认') });
  expect(await probeConnection({ url: 'example.com' }, options)).toMatchObject({ state: 'unsafe', message: expect.stringContaining('关闭转发') });
  expect(await probeConnection({ url: 'example.com' }, options)).toMatchObject({ state: 'unsafe' });
  expect(await probeConnection({ url: 'example.com' }, options)).toMatchObject({ state: 'restricted' });
  expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'manual', headers: { accept: 'application/json' } });
  expect(fetchImpl.mock.calls[0][1].headers).not.toHaveProperty('cookie');
  await expect(probeConnection({ url: 'http://127.0.0.1:3000' }, options)).rejects.toThrow(/HTTPS/);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});

it('turns gateway Host and mode errors into actionable but bounded connection guidance', async () => {
  const hostMismatch = vi.fn().mockResolvedValue(gatewayError('INVALID_HOST'));
  expect(await probeConnection({ url: 'https://example.com' }, { fetchImpl: hostMismatch })).toMatchObject({ state: 'restricted', message: expect.stringContaining('保留外部 Host') });
  const localOnly = vi.fn().mockResolvedValue(gatewayError('LOCAL_ONLY'));
  expect(await probePublicGateway({ url: 'https://example.com' }, managedGateway, { fetchImpl: localOnly })).toMatchObject({ state: 'restricted', message: expect.stringContaining('本机模式') });
  const login = vi.fn().mockResolvedValue(gatewayError('LOGIN_REQUIRED', 401));
  expect(await probePublicGateway({ url: 'https://example.com' }, managedGateway, { fetchImpl: login })).toMatchObject({ state: 'restricted', message: expect.stringContaining('需要登录') });
  const forged = vi.fn().mockResolvedValue(gatewayError('INVALID_HOST<script>'));
  expect(await probePublicGateway({ url: 'https://example.com' }, managedGateway, { fetchImpl: forged })).toMatchObject({ state: 'restricted', message: expect.stringContaining('入口要求登录') });
});

it('limits untrusted response size and does not expose server content', async () => {
  const huge = { ...bootstrap, serverText: 'x'.repeat(20000) };
  const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(huge));
  const result = await probeConnection({ url: 'https://example.com' }, { fetchImpl });
  expect(result.state).toBe('unrecognized'); expect(JSON.stringify(result)).not.toContain('xxxxxx');
});

it('reports timeouts and certificate/network failures without bypassing HTTPS', async () => {
  const hangingFetch = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
  expect(await probeConnection({ url: 'example.com' }, { fetchImpl: hangingFetch, timeoutMs: 15 })).toMatchObject({ state: 'unreachable', message: expect.stringContaining('超时') });
  const failedFetch = vi.fn().mockRejectedValue(new Error('private cert details'));
  const result = await probeConnection({ url: 'example.com' }, { fetchImpl: failedFetch });
  expect(result).toMatchObject({ state: 'unreachable', message: expect.stringContaining('证书') });
  expect(JSON.stringify(result)).not.toContain('private cert details');
  await expect(probeConnection({ url: 'http://203.0.113.10' }, { fetchImpl: failedFetch })).rejects.toThrow(/HTTPS/);
});


it('times out when a server sends an incomplete JSON response', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"mode":');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const result = await probeConnection({ url: `http://127.0.0.1:${port}` }, { timeoutMs: 60 });
    expect(result).toMatchObject({ state: 'unreachable', message: expect.stringContaining('超时') });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

const managedGateway = { mode: 'owner', state: 'ready', managed: true, publicOrigin: 'https://example.com', port: 3000, pid: 42 };
const publicBootstrap = { ...bootstrap, configured: true, passwordEnabled: true, setupPending: false };
function publicResponses(first: unknown = publicBootstrap, statuses = [401, 401, 401]) {
  const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(first));
  for (const status of statuses) fetchImpl.mockResolvedValueOnce(new Response(null, { status }));
  return fetchImpl;
}
it('checks only the configured HTTPS origin, sends no credentials and confirms three unauthenticated denials', async () => {
  const fetchImpl = publicResponses();
  const readLocalBootstrap = vi.fn().mockResolvedValue(publicBootstrap);
  const result = await probePublicGateway({ url: 'example.com' }, managedGateway, { fetchImpl, readLocalBootstrap });
  expect(result).toMatchObject({ state: 'identified', message: expect.stringContaining('未登录') });
  expect(fetchImpl.mock.calls.map(([url]) => url.href)).toEqual(['https://example.com/api/auth/bootstrap', 'https://example.com/api/session', 'https://example.com/api/projects', 'https://example.com/api/threads']);
  for (const [, options] of fetchImpl.mock.calls) {
    expect(options).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'manual' });
    expect(options.headers).not.toHaveProperty('cookie'); expect(options.headers).not.toHaveProperty('authorization');
  }
  expect(JSON.stringify(result)).not.toContain(publicBootstrap.csrf);
  expect(readLocalBootstrap).toHaveBeenCalledOnce();
  expect(readLocalBootstrap.mock.calls[0][0]).toBe(3000);
  expect(readLocalBootstrap.mock.calls[0][1]).toEqual({ mode: 'owner', publicOrigin: 'https://example.com' });
  expect(readLocalBootstrap.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
});
it('reports pending setup separately and never labels an open business endpoint as protected', async () => {
  const pendingBody = { ...publicBootstrap, configured: false, setupPending: true };
  const pending = publicResponses(pendingBody), readLocalBootstrap = vi.fn().mockResolvedValue(pendingBody);
  expect(await probePublicGateway({ url: 'https://example.com' }, managedGateway, { fetchImpl: pending, readLocalBootstrap })).toMatchObject({ state: 'pending' });
  for (const statuses of [[200], [401, 200], [401, 401, 200]]) {
    const open = publicResponses(publicBootstrap, statuses);
    expect(await probePublicGateway({ url: 'https://example.com' }, managedGateway, { fetchImpl: open })).toMatchObject({ state: 'unsafe', message: expect.stringContaining('关闭转发') });
  }
  for (const body of [{ ...publicBootstrap, mode: 'local', authenticated: true }, { ...publicBootstrap, authenticated: true }]) {
    const fetchImpl = publicResponses(body);
    expect((await probePublicGateway({ url: 'https://example.com' }, managedGateway, { fetchImpl })).state).toBe('unsafe');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }
});
it('does not interpret redirects, external authentication or unexpected results as protection', async () => {
  for (const status of [302, 401, 403]) {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status }));
    expect((await probePublicGateway({ url: 'https://example.com' }, managedGateway, { fetchImpl })).state).toBe('restricted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }
  expect((await probePublicGateway({ url: 'https://example.com' }, managedGateway, { fetchImpl: publicResponses({ ...publicBootstrap, mode: 'access', authenticated: true }) })).state).toBe('restricted');
  expect((await probePublicGateway({ url: 'https://example.com' }, managedGateway, { fetchImpl: publicResponses(publicBootstrap, [401, 403]) })).state).toBe('unrecognized');
  expect((await probePublicGateway({ url: 'https://example.com' }, managedGateway, { fetchImpl: publicResponses({ ...publicBootstrap, configured: false, setupPending: false }) })).state).toBe('unrecognized');
  expect((await probePublicGateway({ url: 'https://example.com' }, managedGateway, { fetchImpl: publicResponses({ ...publicBootstrap, extra: 'x'.repeat(20000) }) })).state).toBe('unrecognized');
});
it('refuses mismatched origins and unmanaged, unready or local gateways before making a request', async () => {
  const fetchImpl = vi.fn();
  for (const [input, gateway] of [
    [{ url: 'https://other.example' }, managedGateway],
    [{ url: 'http://127.0.0.1:3000' }, managedGateway],
    [{ url: 'https://example.com' }, { ...managedGateway, managed: false }],
    [{ url: 'https://example.com' }, { ...managedGateway, state: 'error' }],
    [{ url: 'https://example.com' }, { ...managedGateway, mode: 'local' }],
    [{ url: 'https://user:secret@example.com' }, managedGateway],
  ] as const) await expect(probePublicGateway(input, gateway, { fetchImpl })).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('bounds the public diagnostic and never returns server error details', async () => {
  const hanging = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private timeout')))));
  expect(await probePublicGateway({ url: 'example.com' }, managedGateway, { fetchImpl: hanging, timeoutMs: 15 })).toMatchObject({ state: 'unreachable', message: expect.stringContaining('超时') });
  const rejected = vi.fn().mockRejectedValue(new Error('private certificate detail'));
  const result = await probePublicGateway({ url: 'example.com' }, managedGateway, { fetchImpl: rejected });
  expect(result.state).toBe('unreachable'); expect(JSON.stringify(result)).not.toContain('private certificate detail');
});

it('reports an incomplete JSON error response as a timeout rather than a confirmed restriction', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(403, { 'content-type': 'application/json' }); response.write('{"error":');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const local = await probeConnection({ url: `http://127.0.0.1:${port}` }, { timeoutMs: 60 });
    expect(local).toMatchObject({ state: 'unreachable', message: expect.stringContaining('超时') });
    const fetchImpl = (_url: unknown, options: RequestInit) => fetch(`http://127.0.0.1:${port}/`, options);
    const remote = await probePublicGateway({ url: 'https://example.com' }, managedGateway, { fetchImpl, timeoutMs: 60 });
    expect(remote).toMatchObject({ state: 'unreachable', message: expect.stringContaining('超时') });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


it('does not report success when the HTTPS entry responds as a different gateway instance', async () => {
  const fetchImpl = publicResponses();
  const readLocalBootstrap = vi.fn().mockResolvedValue({ ...publicBootstrap, csrf: 'b'.repeat(64) });
  const result = await probePublicGateway({ url: 'https://example.com' }, managedGateway, { fetchImpl, readLocalBootstrap });
  expect(result).toMatchObject({ state: 'mismatch', message: expect.stringContaining('不一致') });
  expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
  expect(JSON.stringify(result)).not.toContain('b'.repeat(64));
});


it('reports local verification failure and state changes without disclosing either response', async () => {
  for (const readLocalBootstrap of [
    vi.fn().mockRejectedValue(new Error('private local detail')),
    vi.fn().mockResolvedValue(null),
    vi.fn().mockResolvedValue({ ...publicBootstrap, csrf: 'bad' }),
    vi.fn().mockResolvedValue({ ...publicBootstrap, mode: 'local' }),
  ]) {
    const result = await probePublicGateway({ url: 'https://example.com' }, managedGateway, { fetchImpl: publicResponses(), readLocalBootstrap });
    expect(result).toMatchObject({ state: 'unrecognized', message: expect.stringContaining('本机网关') });
    expect(JSON.stringify(result)).not.toContain('private local detail');
  }
  const readLocalBootstrap = vi.fn().mockResolvedValue({ ...publicBootstrap, configured: false, setupPending: true });
  expect(await probePublicGateway({ url: 'https://example.com' }, managedGateway, { fetchImpl: publicResponses(), readLocalBootstrap })).toMatchObject({ state: 'mismatch' });
});

it('rejects invalid local ports before sending any diagnostic request', async () => {
  const fetchImpl = vi.fn(), readLocalBootstrap = vi.fn();
  for (const port of [0, -1, 65536, 3.5, '3000', undefined])
    await expect(probePublicGateway({ url: 'https://example.com' }, { ...managedGateway, port }, { fetchImpl, readLocalBootstrap })).rejects.toThrow(/端口/);
  expect(fetchImpl).not.toHaveBeenCalled(); expect(readLocalBootstrap).not.toHaveBeenCalled();
});


it('bounds an unresponsive local comparison and does not claim the remote is verified', async () => {
  const readLocalBootstrap = vi.fn((_port, _config, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('local timeout secret')))));
  const result = await probePublicGateway({ url: 'https://example.com' }, managedGateway, { fetchImpl: publicResponses(), readLocalBootstrap, timeoutMs: 30 });
  expect(result).toMatchObject({ state: 'unreachable', message: expect.stringContaining('超时') });
  expect(JSON.stringify(result)).not.toContain('local timeout secret');
});


it('compares the remote bootstrap to an actual local HTTP listener with the expected Host', async () => {
  let receivedHost = '', cookie: string | undefined, authorization: string | undefined;
  const local = http.createServer((request, response) => {
    receivedHost = String(request.headers.host || ''); cookie = request.headers.cookie; authorization = request.headers.authorization;
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(publicBootstrap));
  });
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
  try {
    const port = (local.address() as { port: number }).port;
    const result = await probePublicGateway({ url: 'https://example.com' }, { ...managedGateway, port }, { fetchImpl: publicResponses() });
    expect(result.state).toBe('identified'); expect(receivedHost).toBe('example.com'); expect(cookie).toBeUndefined(); expect(authorization).toBeUndefined();
  } finally { local.closeAllConnections(); await new Promise<void>(resolve => local.close(() => resolve())); }
});

it('keeps older gateways and failed local ticket preparation separate from a failed stream', async () => {
  // @ts-expect-error Shared desktop module is CommonJS.
  const { completePublicDiagnostic } = await import('../desktop/connection-probe.cjs');
  const diagnose = vi.fn().mockResolvedValue(true);
  const html = { state: 'identified', message: '网页检查成功。' };
  expect(await completePublicDiagnostic(html, false, diagnose)).toMatchObject({ stream: 'unchecked', message: expect.stringContaining('本次未检查') });
  expect(diagnose).not.toHaveBeenCalled();
  expect(await completePublicDiagnostic(html, true, diagnose)).toMatchObject({ stream: 'passed', message: expect.stringContaining('双向检查通过') });
  expect(await completePublicDiagnostic(html, true, vi.fn().mockResolvedValue(false))).toMatchObject({ stream: 'failed', message: expect.stringContaining('请求头') });
  const privateError = 'diagnostic-private-token';
  const localFailure = await completePublicDiagnostic(html, true, vi.fn().mockRejectedValue(new Error(privateError)));
  expect(localFailure.stream).toBe('unchecked'); expect(JSON.stringify(localFailure)).not.toContain(privateError);
  const restricted = { state: 'restricted', message: '入口受限。' };
  expect(await completePublicDiagnostic(restricted, true, diagnose)).toEqual(restricted);
});

it('sends the stream ticket only in a bounded HTTPS websocket handshake and never returns it', async () => {
  const { EventEmitter } = await import('node:events');
  // @ts-expect-error Shared desktop module is CommonJS.
  const { probePublicStream } = await import('../desktop/connection-probe.cjs');
  let target = '', headers: Record<string, string> = {}, terminated = false;
  const ticket = { token: 'a'.repeat(43), expiresAt: Date.now() + 10000 };
  class FixtureSocket extends EventEmitter {
    constructor(url: URL, options: any) {
      super(); target = url.toString(); headers = options.headers;
      expect(options.followRedirects).toBe(false); expect(options.perMessageDeflate).toBe(false); expect(options.maxPayload).toBe(1024);
      process.nextTick(() => this.emit('open'));
    }
    send(raw: string) { const { nonce } = JSON.parse(raw); process.nextTick(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'pong', nonce })), false)); }
    terminate() { terminated = true; }
  }
  expect(await probePublicStream('https://example.com', ticket, { WebSocket: FixtureSocket })).toBe(true);
  expect(target).toBe('wss://example.com/api/diagnostics/stream');
  expect(headers).toEqual({ origin: 'https://example.com', 'x-hajimink-diagnostic': ticket.token });
  expect(terminated).toBe(true);
  expect(await probePublicStream('https://example.com', { ...ticket, expiresAt: Date.now() - 1 }, { WebSocket: FixtureSocket })).toBe(false);
  expect(await probePublicStream('https://example.com', { ...ticket, token: 'invalid' }, { WebSocket: FixtureSocket })).toBe(false);
  class StalledSocket extends EventEmitter { terminate() {} }
  expect(await probePublicStream('https://example.com', ticket, { WebSocket: StalledSocket, timeoutMs: 20 })).toBe(false);
});
