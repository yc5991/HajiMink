import { afterEach, expect, it } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store';
import { OwnerAuth } from '../server/owner-auth';
import { buildApp } from '../server/app';
import { removeTempFixture } from './safe-temp';

const fixtures: Array<{ app: Awaited<ReturnType<typeof buildApp>>['app']; dir: string }> = [];
afterEach(async () => { for (const value of fixtures.splice(0)) { await value.app.close(); removeTempFixture(value.dir, 'hajimink-device-api-'); } });
async function fixture(mode: 'owner' | 'local' | 'access' = 'owner') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hajimink-device-api-'));
  const store = new Store(dir); const origin = mode === 'local' ? 'http://localhost:3000' : 'https://agent.example.com';
  const enrollment = new OwnerAuth(store.db, origin);
  // A fake enrolled public key makes owner mode available; signature checks are covered separately.
  store.db.prepare('INSERT INTO owner_passkeys VALUES(?,?,?,?,?)').run('fixture-key', Buffer.from('public'), 0, '[]', Date.now());
  expect(enrollment.configured).toBe(true);
  const adapter = Object.assign(new EventEmitter(), { status: { connected: false }, catalog: async () => ({ projects: [], threads: [] }), models: () => [], close() {} });
  const config = { mode, port: 3000, publicOrigin: origin, dataDir: dir, ...(mode === 'access' ? { accessIssuer: 'https://owner.cloudflareaccess.com', accessAudience: 'aud', allowedEmail: 'owner@example.com' } : {}) } as const;
  const result = await buildApp(config, { store, adapter: adapter as any, serveStatic: false });
  fixtures.push({ app: result.app, dir });
  const host = mode === 'local' ? 'localhost:3000' : 'agent.example.com';
  const boot = await result.app.inject({ url: '/api/auth/bootstrap', headers: { host } });
  const cookie = boot.cookies.map(value => `${value.name}=${value.value}`).join('; ');
  const base = { host, origin, cookie, 'x-agent-control-csrf': boot.json().csrf };
  const owner = result.ownerAuth.issueSession();
  const ownerHeaders = { ...base, cookie: `${cookie}; __Host-ac_owner=${owner.token}` };
  return { ...result, base, ownerHeaders, owner, cookie, host, origin };
}
async function request(app: Awaited<ReturnType<typeof buildApp>>['app'], headers: Record<string, string>, url: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url, headers, payload });
}
it('requires same-origin CSRF for anonymous device requests and restricts approval to a recent owner browser session', async () => {
  const f = await fixture();
  expect((await request(f.app, { ...f.base, origin: 'https://evil.example' }, '/api/auth/device/request', { name: '电脑' })).statusCode).toBe(403);
  expect((await request(f.app, { ...f.base, origin: '' }, '/api/auth/device/request', { name: '电脑' })).statusCode).toBe(403);
  expect((await request(f.app, { ...f.base, 'x-agent-control-csrf': 'wrong' }, '/api/auth/device/request', { name: '电脑' })).statusCode).toBe(403);
  const started = await request(f.app, f.base, '/api/auth/device/request', { name: '桌面电脑' });
  expect(started.statusCode).toBe(200); const data = started.json();
  expect(started.headers['cache-control']).toBe('no-store'); expect(data.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect((await request(f.app, f.base, '/api/auth/device/lookup', { code: data.userCode })).statusCode).toBe(401);
  expect((await request(f.app, f.base, '/api/auth/device/exchange', { requestId: data.requestId })).statusCode).toBe(409);
  f.store.db.prepare('UPDATE owner_sessions SET created_at=? WHERE hash=?').run(Date.now() - 301000, f.ownerAuth.session(f.owner.token)!.hash);
  const stale = await request(f.app, f.ownerHeaders, '/api/auth/device/lookup', { code: data.userCode });
  expect(stale.statusCode).toBe(401); expect(stale.json().error.code).toBe('REAUTHENTICATE');
  const fresh = f.ownerAuth.issueSession(); const recent = { ...f.base, cookie: `${f.cookie}; __Host-ac_owner=${fresh.token}` };
  const details = await request(f.app, recent, '/api/auth/device/lookup', { code: data.userCode });
  expect(details.statusCode).toBe(200); expect(details.json().deviceName).toBe('桌面电脑');
  expect((await request(f.app, f.base, '/api/auth/device/decide', { approvalTicket: details.json().approvalTicket, approve: true })).statusCode).toBe(401);
  expect((await request(f.app, recent, '/api/auth/device/decide', { approvalTicket: details.json().approvalTicket, approve: true, remember: false })).statusCode).toBe(200);
  expect((await request(f.app, recent, '/api/auth/device/decide', { approvalTicket: details.json().approvalTicket, approve: true })).statusCode).toBe(409);
});
it('permits an authorized device to use the workbench but not owner administration, and closes its WebSocket on revocation', async () => {
  const f = await fixture();
  const started = (await request(f.app, f.base, '/api/auth/device/request', { name: '远程电脑' })).json();
  const detail = (await request(f.app, f.ownerHeaders, '/api/auth/device/lookup', { code: started.userCode })).json();
  expect((await request(f.app, f.ownerHeaders, '/api/auth/device/decide', { approvalTicket: detail.approvalTicket, approve: true })).statusCode).toBe(200);
  expect((await request(f.app, f.base, '/api/auth/device/poll', { requestId: started.requestId })).json().state).toBe('approved');
  const redemption = await request(f.app, f.base, '/api/auth/device/exchange', { requestId: started.requestId }); expect(redemption.statusCode).toBe(200);
  const issued = redemption.json(); expect(redemption.headers['cache-control']).toBe('no-store');
  expect((await request(f.app, f.base, '/api/auth/device/exchange', { requestId: started.requestId })).statusCode).toBe(409);
  const deviceHeaders = { ...f.base, cookie: `${f.cookie}; __Host-ac_device=${issued.token}` };
  expect((await f.app.inject({ url: '/api/projects', headers: deviceHeaders })).statusCode).toBe(200);
  const boot = await f.app.inject({ url: '/api/auth/bootstrap', headers: deviceHeaders });
  expect(boot.json()).toMatchObject({ authenticated: true, accountType: 'device' });
  for (const url of ['/api/auth/device/list', '/api/auth/register/options', '/api/auth/password', '/api/auth/logout-all']) {
    const response = await f.app.inject({ method: url.endsWith('/list') ? 'GET' : 'POST', url, headers: deviceHeaders, payload: url.endsWith('/list') ? undefined : {} });
    expect(response.statusCode, url).toBe(401);
  }
  const listed = await f.app.inject({ url: '/api/auth/device/list', headers: f.ownerHeaders });
  expect(listed.statusCode).toBe(200); expect(listed.json().devices).toEqual([expect.objectContaining({ id: issued.deviceId, name: '远程电脑' })]);
  expect(JSON.stringify(listed.json())).not.toContain(issued.token);
  await f.app.ready();
  const socket = await f.app.injectWS('/api/events', { headers: deviceHeaders });
  try {
    const closed = once(socket, 'close');
    expect((await request(f.app, f.ownerHeaders, '/api/auth/device/revoke', { id: issued.deviceId })).statusCode).toBe(200);
    expect((await closed)[0]).toBe(1008);
    expect((await f.app.inject({ url: '/api/projects', headers: deviceHeaders })).statusCode).toBe(401);
  } finally { socket.terminate(); }
});
it('logout all revokes both browser and device credentials and invalidates pending authorizations', async () => {
  const f = await fixture();
  const issued = (() => { const r = f.devices.create('设备', 'c'); f.devices.decide(f.devices.lookup(r.userCode, 'o').approvalTicket, true); return f.devices.exchange(r.requestId); })();
  const pending = f.devices.create('待批准', 'c');
  await f.app.ready();
  const socket = await f.app.injectWS('/api/events', { headers: { ...f.base, cookie: `${f.cookie}; __Host-ac_device=${issued.token}` } });
  try {
    const closed = once(socket, 'close');
    expect((await request(f.app, f.ownerHeaders, '/api/auth/logout-all', {})).statusCode).toBe(200);
    expect((await closed)[0]).toBe(1008);
    expect(f.devices.session(issued.token)).toBeUndefined();
    expect(() => f.devices.status(pending.requestId)).toThrowError(expect.objectContaining({ code: 'DEVICE_REQUEST_EXPIRED' }));
  } finally { socket.terminate(); }
});
it('refuses device authorization in local mode and cannot authenticate with a forged device cookie', async () => {
  const local = await fixture('local');
  expect((await request(local.app, local.base, '/api/auth/device/request', { name: '设备' })).statusCode).toBe(404);
  const f = await fixture();
  const forged = { ...f.base, cookie: `${f.cookie}; __Host-ac_device=${'x'.repeat(43)}` };
  expect((await f.app.inject({ url: '/api/projects', headers: forged })).statusCode).toBe(401);
  expect((await f.app.inject({ url: '/api/auth/device/list', headers: forged })).statusCode).toBe(401);
});

it('does not let a forged Cloudflare IP header bypass device request rate limits', async () => {
  const f = await fixture();
  for (let i = 0; i < 20; i++) {
    const response = await request(f.app, { ...f.base, 'cf-connecting-ip': `198.51.100.${i + 1}` }, '/api/auth/device/request', { name: `测试设备 ${i}` });
    expect(response.statusCode).toBe(200);
  }
  const limited = await request(f.app, { ...f.base, 'cf-connecting-ip': '203.0.113.5' }, '/api/auth/device/request', { name: '超限设备' });
  expect(limited.statusCode).toBe(429); expect(limited.json().error.code).toBe('DEVICE_RATE_LIMIT');
});
it('does not let a forged Cloudflare IP header bypass password rate limits', async () => {
  const f = await fixture();
  for (let i = 0; i < 10; i++) {
    const response = await request(f.app, { ...f.base, 'cf-connecting-ip': `198.51.100.${i + 1}` }, '/api/auth/password/login', { password: 'fixture-incorrect-password' });
    expect(response.statusCode).toBe(401);
  }
  const limited = await request(f.app, { ...f.base, 'cf-connecting-ip': '203.0.113.5' }, '/api/auth/password/login', { password: 'fixture-incorrect-password' });
  expect(limited.statusCode).toBe(429); expect(limited.json().error.code).toBe('LOGIN_RATE_LIMIT');
});
