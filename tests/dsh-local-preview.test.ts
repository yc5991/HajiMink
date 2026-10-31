import http from 'node:http';
import { once } from 'node:events';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { startDshLocalPreview } from '../server/dsh-local-preview';
import { removeTempFixture } from './safe-temp';

async function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'hajimink-dsh-preview-'));
  const secret = randomBytes(32);
  const credential = `version: 1\nrefs:\n  EXAMPLE_API_KEY: upstream-only-placeholder\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: ${secret.toString('base64url')}\n`;
  const credentialsPath = path.join(directory, 'credentials.yaml'); writeFileSync(credentialsPath, credential);
  const observed: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  let authority = '';
  const valid = (request: http.IncomingMessage) => {
    const name = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`;
    const match = new RegExp(`${name}=v1\\.([^.]+)\\.([A-Za-z0-9_-]+)$`).exec(request.headers.cookie || '');
    if (!match || request.headers.host !== authority || createHmac('sha256', secret).update(match[1]).digest('base64url') !== match[2]) return false;
    const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString());
    return payload.authority === authority && payload.expiresAt > Date.now() && payload.expiresAt - payload.issuedAt === 15 * 60 * 1000;
  };
  const upstream = http.createServer(async (request, response) => {
    if (!valid(request)) { response.writeHead(401); response.end('dsh web authentication required; reopen the URL printed by dsh web.\n'); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    observed.push({ url: request.url || '', headers: request.headers, body: Buffer.concat(chunks).toString() });
    if (request.url === '/') { response.writeHead(200, { 'set-cookie': 'private-upstream-session=never-forward' }); response.end('<title>DeepSeek Harness</title><script>globalThis.__DSH_BOOT__={}</script>'); }
    else if (request.url === '/stream') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: first\n\n'); setTimeout(() => response.end('data: last\n\n'), 150); }
    else if (request.url === '/redirect') { response.writeHead(303, { location: `http://${authority}/settings` }); response.end(); }
    else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ body: Buffer.concat(chunks).toString(), origin: request.headers.origin })); }
  });
  const wss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (request, socket, head) => {
    if (!valid(request) || request.headers.origin !== `http://${authority}`) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, client => {
      client.send('ready'); client.on('message', (data, binary) => client.send(data, { binary }));
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as import('node:net').AddressInfo).port; authority = `127.0.0.1:${upstreamPort}`;
  const preview = await startDshLocalPreview({ port: 0, upstreamPort, credentialsPath });
  const origin = new URL(preview.url).origin;
  return { preview, origin, observed, credential, credentialsPath, upstreamPort, upstream, async close() {
    await preview.close(); for (const client of wss.clients) client.terminate(); wss.close();
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    removeTempFixture(directory, 'hajimink-dsh-preview-');
  } };
}

it('reuses the original UI and grant without exposing cookies or rewriting credentials', async () => {
  const f = await fixture(); try {
    const response = await fetch(f.preview.url, { headers: { cookie: 'ac_owner=private-user-session', authorization: 'Bearer never-forward' } });
    expect(response.status).toBe(200); expect(await response.text()).toContain('DeepSeek Harness');
    expect(response.headers.get('set-cookie')).toBeNull(); expect(response.headers.get('cache-control')).toBe('no-store');
    const last = f.observed.at(-1)!; expect(last.headers.cookie).not.toContain('ac_owner'); expect(last.headers.authorization).toBeUndefined();
    expect(readFileSync(f.credentialsPath, 'utf8')).toBe(f.credential);
  } finally { await f.close(); }
});
it('rejects foreign hosts, cross-origin posts and websocket origins before forwarding', async () => {
  const f = await fixture(); try {
    const before = f.observed.length;
    const untrustedHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.get(f.preview.url, { headers: { host: 'outside.example.test' } }, response => { response.resume(); resolve(response.statusCode); });
      request.once('error', reject);
    });
    expect(untrustedHost).toBe(403);
    const attempts: RequestInit[] = [
      { headers: { origin: 'https://outside.example.test' } },
      { headers: { 'sec-fetch-site': 'cross-site' } },
      { method: 'POST', body: 'side-effect', headers: {} },
      { method: 'POST', body: 'side-effect', headers: { origin: 'https://outside.example.test' } },
    ];
    for (const init of attempts) expect((await fetch(f.preview.url, init)).status, JSON.stringify(init)).toBe(403);
    const ws = new WebSocket(f.preview.url.replace('http:', 'ws:') + 'api/remote.mux', { origin: 'https://outside.example.test' });
    const rejected = once(ws, 'unexpected-response'); ws.on('error', () => {});
    const [, response] = await rejected; expect(response.statusCode).toBe(403); response.resume(); ws.terminate();
    expect(f.observed).toHaveLength(before);
  } finally { await f.close(); }
});
it('forwards a same-origin action once with its body and upstream identity intact', async () => {
  const f = await fixture(); try {
    const response = await fetch(`${f.origin}/api/example`, { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json', 'x-peer-token': 'never-forward' }, body: '{"prompt":"fixture-only"}' });
    expect(response.status).toBe(200); expect((await response.json()).body).toBe('{"prompt":"fixture-only"}');
    const calls = f.observed.filter(item => item.url === '/api/example'); expect(calls).toHaveLength(1);
    expect(calls[0].headers.origin).toBe(`http://127.0.0.1:${f.upstreamPort}`); expect(calls[0].headers['x-peer-token']).toBeUndefined();
    const redirected = await fetch(`${f.origin}/redirect`, { redirect: 'manual' }); expect(redirected.headers.get('location')).toBe('/settings');
  } finally { await f.close(); }
});
it('streams the first output chunk without waiting for response completion', async () => {
  const f = await fixture(); try {
    const response = await fetch(`${f.origin}/stream`); const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: last\n\n');
    expect((await reader.read()).done).toBe(true);
  } finally { await f.close(); }
});
it('preserves the realtime handshake and both text and binary frames', async () => {
  const f = await fixture(); try {
    const ws = new WebSocket(`${f.origin.replace('http:', 'ws:')}/api/remote.mux`, { origin: f.origin });
    const ready = once(ws, 'message'); expect((await ready)[0].toString()).toBe('ready');
    const text = once(ws, 'message'); ws.send('follow-fixture'); expect((await text)[0].toString()).toBe('follow-fixture');
    const binary = once(ws, 'message'); ws.send(Buffer.from([1, 2, 255]));
    const [bytes, isBinary] = await binary; expect(isBinary).toBe(true); expect([...bytes]).toEqual([1, 2, 255]);
    const closed = once(ws, 'close'); ws.close(); await closed;
  } finally { await f.close(); }
});
it('fails closed on an unknown credential format without touching the original file', async () => {
  const f = await fixture(); try {
    const incompatible = f.credential.replace('version: 1', 'version: 99'); writeFileSync(f.credentialsPath, incompatible);
    await expect(startDshLocalPreview({ port: 0, upstreamPort: f.upstreamPort, credentialsPath: f.credentialsPath })).rejects.toThrow('不兼容');
    expect(readFileSync(f.credentialsPath, 'utf8')).toBe(incompatible);
  } finally { await f.close(); }
});
it('reports an upstream disconnect without reconnecting or replaying an action', async () => {
  const f = await fixture(); try {
    const before = f.observed.length;
    f.upstream.closeAllConnections(); await new Promise<void>(resolve => f.upstream.close(() => resolve()));
    const response = await fetch(`${f.origin}/api/example`, { method: 'POST', headers: { origin: f.origin }, body: 'one-attempt' });
    expect(response.status).toBe(502); expect(await response.text()).toContain('不会自动重发');
    expect(f.observed.length).toBe(before);
  } finally { await f.close(); }
});
