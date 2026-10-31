import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { removeTempFixture } from './safe-temp';
// @ts-expect-error These modules are also used directly by Electron's main process.
import { DeviceCredentials } from '../desktop/device-credentials.cjs';
// @ts-expect-error These modules are also used directly by Electron's main process.
import { DeviceFlow, DeviceTransport } from '../desktop/device-flow.cjs';
const roots: string[] = [];
const sampleToken = 'A'.repeat(43);
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-credential-test-')); roots.push(root); return root; }
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) removeTempFixture(root, 'hajimink-credential-test-'); });
const storage = (backend = 'gnome_libsecret', available = true) => ({
  getSelectedStorageBackend: () => backend,
  isAsyncEncryptionAvailable: async () => available,
  encryptStringAsync: async (value: string) => Buffer.from(Buffer.from(value).toString('base64')),

  decryptStringAsync: async (buffer: Buffer) => ({ result: Buffer.from(buffer.toString('utf8'), 'base64').toString('utf8'), shouldReEncrypt: false }),
});
it('uses only protected storage, scopes credentials to connection and origin, and removes them', async () => {
  const root = fixture(), id = randomUUID(), item = { id, url: 'https://example.test' };
  const store = new DeviceCredentials(root, storage(), 'win32');
  expect(await store.save(item, { token: sampleToken, expiresAt: Date.now() + 30000 })).toBe('protected');
  const bytes = fs.readFileSync(path.join(root, 'device-credentials', `${id}.bin`));
  expect(bytes.toString()).not.toContain(sampleToken);
  const reopened = new DeviceCredentials(root, storage(), 'win32');
  expect((await reopened.get(item)).token).toBe(sampleToken);
  expect(await reopened.get({ ...item, url: 'https://another.test' })).toBeUndefined();
  await reopened.remove(id);
  expect(await new DeviceCredentials(root, storage(), 'win32').get(item)).toBeUndefined();
  expect(() => reopened.file('../elsewhere')).toThrow();
});
it('never persists on Linux basic/unknown backends or unavailable encryption', async () => {
  for (const fake of [storage('basic_text'), storage('unknown'), storage('gnome_libsecret', false)]) {
    const root = fixture(), item = { id: randomUUID(), url: 'https://example.test' };
    const store = new DeviceCredentials(root, fake, 'linux');
    expect(await store.save(item, { token: sampleToken, expiresAt: Date.now() + 30000 })).toBe('memory');
    expect((await store.get(item)).token).toBe(sampleToken);
    expect(await new DeviceCredentials(root, fake, 'linux').get(item)).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'device-credentials'))).toBe(false);
  }
});
it('rejects non-HTTPS and non-origin gateway URLs', () => {
  for (const url of ['http://localhost:3000', 'https://example.test/path', 'https://x:password@example.test', 'https://example.test?x=1']) expect(() => new DeviceTransport(url)).toThrow();
});
it('opens only the chosen gateway browser page, exchanges once, and exposes no secret to state updates', async () => {
  vi.useFakeTimers(); const updates: any[] = [], calls: any[] = [];
  const requestId = 'R'.repeat(43), csrf = 'a'.repeat(64), nonce = 'N'.repeat(43);
  const fetchImpl = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init }); const route = new URL(url).pathname;
    if (route === '/api/auth/bootstrap') { const headers = new Headers(); headers.append('set-cookie', `ac_session=${csrf}; Path=/; Secure`); headers.append('set-cookie', `__Host-ac_auth_nonce=${nonce}; Path=/; Secure`); return new Response(JSON.stringify({ mode: 'owner', csrf }), { headers }); }
    expect(init.headers.origin).toBe('https://example.test'); expect(init.headers['x-agent-control-csrf']).toBe(csrf);
    if (route.endsWith('/request')) return Response.json({ requestId, userCode: 'ABCD-2345', expiresAt: Date.now() + 300000, intervalSeconds: 2 });
    if (route.endsWith('/poll')) return Response.json({ state: 'approved' });
    if (route.endsWith('/exchange')) return Response.json({ token: sampleToken, expiresAt: Date.now() + 30000 });
    throw new Error('unexpected endpoint');
  });
  const openBrowser = vi.fn().mockResolvedValue(undefined), onGranted = vi.fn().mockResolvedValue('protected');
  const flow = new DeviceFlow({ openBrowser, onGranted, onState: (value: any) => updates.push(value), fetchImpl });
  await flow.start({ id: randomUUID(), name: 'Test', local: false, url: 'https://example.test' });
  expect(openBrowser).toHaveBeenCalledWith('https://example.test/device');
  expect(updates.at(-1)).toMatchObject({ state: 'pending', userCode: 'ABCD-2345' });
  await flow.poll(flow.active);
  expect(updates.at(-1)).toMatchObject({ state: 'approved' });
  expect(onGranted).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(updates)).not.toContain(requestId); expect(JSON.stringify(updates)).not.toContain(sampleToken);
  expect(calls.filter(value => value.url.endsWith('/exchange'))).toHaveLength(1);
});
it('cancels a pending request and does not grant it after cancellation', async () => {
  vi.useFakeTimers(); const updates: any[] = [], csrf = 'a'.repeat(64), nonce = 'N'.repeat(43), requestId = 'R'.repeat(43);
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith('/bootstrap')) { const headers = new Headers(); headers.append('set-cookie', `ac_session=${csrf}; Path=/`); headers.append('set-cookie', `__Host-ac_auth_nonce=${nonce}; Path=/`); return new Response(JSON.stringify({ mode: 'owner', csrf }), { headers }); }
    if (url.endsWith('/request')) return Response.json({ requestId, userCode: 'ABCD-2345', expiresAt: Date.now() + 300000, intervalSeconds: 2 });
    return Response.json({ ok: true });
  });
  const onGranted = vi.fn(), flow = new DeviceFlow({ openBrowser: vi.fn(), onGranted, onState: (value: any) => updates.push(value), fetchImpl });
  await flow.start({ id: randomUUID(), name: 'Test', local: false, url: 'https://example.test' });
  const job = flow.active; flow.cancel(); await flow.poll(job);
  expect(updates.at(-1).state).toBe('canceled'); expect(onGranted).not.toHaveBeenCalled();
  expect(fetchImpl.mock.calls.some(([url]) => url.endsWith('/cancel'))).toBe(true);
});
it('revokes a token returned after cancellation races with an in-flight exchange', async () => {
  vi.useFakeTimers(); const updates: any[] = [], calls: string[] = [], csrf = 'a'.repeat(64), nonce = 'N'.repeat(43), requestId = 'R'.repeat(43);
  let finishExchange!: (response: Response) => void;
  const exchange = new Promise<Response>(resolve => { finishExchange = resolve; });
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.endsWith('/bootstrap')) { const headers = new Headers(); headers.append('set-cookie', `ac_session=${csrf}; Path=/`); headers.append('set-cookie', `__Host-ac_auth_nonce=${nonce}; Path=/`); return new Response(JSON.stringify({ mode: 'owner', csrf }), { headers }); }
    if (url.endsWith('/request')) return Response.json({ requestId, userCode: 'ABCD-2345', expiresAt: Date.now() + 300000, intervalSeconds: 2 });
    if (url.endsWith('/poll')) return Response.json({ state: 'approved' });
    if (url.endsWith('/exchange')) return exchange;
    return Response.json({ ok: true });
  });
  const onGranted = vi.fn(), flow = new DeviceFlow({ openBrowser: vi.fn(), onGranted, onState: (value: any) => updates.push(value), fetchImpl });
  await flow.start({ id: randomUUID(), name: 'Test', local: false, url: 'https://example.test' });
  const job = flow.active, polling = flow.poll(job);
  for (let i = 0; i < 50 && !job.exchanging; i++) await Promise.resolve();
  expect(job.exchanging).toBe(true); flow.cancel();
  expect(updates.at(-1).message).toContain('检查');
  finishExchange(Response.json({ token: sampleToken, expiresAt: Date.now() + 30000 })); await polling;
  expect(onGranted).not.toHaveBeenCalled();
  expect(calls.some(url => url.endsWith('/api/auth/logout'))).toBe(true);
});
