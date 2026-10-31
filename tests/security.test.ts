import { it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { removeTempFixture } from './safe-temp';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { buildApp } from '../server/app';
import { verifyAccess, validateConfig, type GatewayConfig } from '../server/security';
const base = { mode: 'local', port: 3000, publicOrigin: 'https://agent.example.com' } as const;
it('blocks DNS rebinding, cross-origin requests and missing CSRF credentials', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agent-control-security-'));
  const adapter = Object.assign(new EventEmitter(), { status: { connected: false }, close() {} });
  const { app } = await buildApp({ ...base, dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  try {
    expect((await app.inject({ url: '/api/session', headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/session', headers: { host: 'localhost:3000', origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/preferences', headers: { host: 'localhost:3000' }, payload: { theme: 'dark' } })).statusCode).toBe(403);
    const session = await app.inject({ url: '/api/session', headers: { host: 'localhost:3000' } });
    const csrf = session.json().csrf; const cookie = String(session.headers['set-cookie']).split(';')[0];
    expect((await app.inject({ method: 'POST', url: '/api/preferences', headers: { host: 'localhost:3000', cookie, 'x-agent-control-csrf': csrf }, payload: { theme: 'dark' } })).statusCode).toBe(200);
  } finally { await app.close(); removeTempFixture(directory, 'agent-control-'); }
});
it('requires a private local desktop session without weakening the public owner gateway', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agent-control-local-owner-'));
  const adapter = Object.assign(new EventEmitter(), { status: { connected: false }, close() {} });
  const initial = await buildApp({ ...base, dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  await initial.ownerAuth.setPassword('fixture-only-password-2026');
  await initial.app.close();
  const { app, ownerAuth } = await buildApp({ ...base, mode: 'owner', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  const host = '127.0.0.1:3000';
  try {
    const ticket = ownerAuth.issueSession();
    for (const cookie of ['', 'ac_owner_dev=invalid', `__Host-ac_owner=${ticket.token}`]) expect((await app.inject({ url: '/api/session', headers: { host, cookie } })).statusCode).toBe(403);
    const local = { host, cookie: `ac_owner_dev=${ticket.token}` };
    const bootstrap = await app.inject({ url: '/api/auth/bootstrap', headers: local });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toMatchObject({ mode: 'owner', authenticated: true, accountType: 'owner' });
    expect(String(bootstrap.headers['set-cookie'])).not.toContain('Secure');
    expect((await app.inject({ url: '/api/session', headers: { ...local, origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/session', remoteAddress: '203.0.113.17', headers: local })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/session', headers: { ...local, host: 'agent.example.com' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/preferences', headers: { host: 'agent.example.com' } })).statusCode).toBe(401);
    const csrf = bootstrap.json().csrf;
    const cookie = `${local.cookie}; ac_session=${csrf}`;
    expect((await app.inject({ method: 'POST', url: '/api/preferences', headers: { host, cookie, origin: `http://${host}`, 'x-agent-control-csrf': csrf }, payload: { theme: 'dark' } })).statusCode).toBe(200);
    await expect(app.injectWS('/api/events', { socket: { remoteAddress: '127.0.0.1' }, headers: { host, cookie, origin: 'https://evil.example' } } as any)).rejects.toThrow();
    const socket = await app.injectWS('/api/events', { socket: { remoteAddress: '127.0.0.1' }, headers: { host, cookie, origin: `http://${host}` } } as any);
    socket.terminate();
    ownerAuth.revoke(ownerAuth.session(ticket.token)!.hash);
    expect((await app.inject({ url: '/api/session', headers: local })).statusCode).toBe(403);
  } finally { await app.close(); removeTempFixture(directory, 'agent-control-'); }
});
it('allows only a privately issued local session while remote enrollment is pending', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agent-control-pending-local-'));
  const adapter = Object.assign(new EventEmitter(), { status: { connected: false }, close() {} });
  const ownerSetup = { generation: '11111111-1111-4111-8111-111111111111', codeHash: createHash('sha256').update('fixture').digest('hex'), expiresAt: Date.now() + 600000 };
  const { app, ownerAuth } = await buildApp({ ...base, mode: 'owner', dataDir: directory, ownerSetup }, { adapter: adapter as any, serveStatic: false });
  try {
    const local = { host: '127.0.0.1:3000', cookie: `ac_owner_dev=${ownerAuth.issueSession().token}` };
    const bootstrap = await app.inject({ url: '/api/auth/bootstrap', headers: local });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toMatchObject({ authenticated: true, setupPending: true });
    expect((await app.inject({ url: '/api/preferences', headers: local })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/preferences', headers: { host: 'agent.example.com' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/preferences', headers: { host: '127.0.0.1:3000' } })).statusCode).toBe(403);
  } finally { await app.close(); removeTempFixture(directory, 'agent-control-'); }
});
it('verifies issuer, audience, signature, expiry and exact owner email', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'test'; const keys = createLocalJWKSet({ keys: [jwk] });
  const config: GatewayConfig = { ...base, mode: 'access', dataDir: '.', accessIssuer: 'https://owner.cloudflareaccess.com', accessAudience: 'aud-owner', allowedEmail: 'owner@example.com' };
  const sign = (email: string, aud = 'aud-owner', expiry = '1h') => new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(config.accessIssuer!).setAudience(aud).setIssuedAt().setExpirationTime(expiry).sign(privateKey);
  await expect(verifyAccess(await sign('owner@example.com'), config, keys)).resolves.toMatchObject({ email: 'owner@example.com' });
  for (const token of ['', 'fake', await sign('other@example.com'), await sign('owner@example.com', 'wrong'), await sign('owner@example.com', 'aud-owner', '-1h')]) await expect(verifyAccess(token, config, keys)).rejects.toThrow();
  expect(() => validateConfig({ ...config, accessAudience: '' })).toThrow();
});
it('rejects unauthenticated requests on the actual Access gateway routes', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agent-control-access-'));
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'gateway';
  const config: GatewayConfig = { ...base, mode: 'access', dataDir: directory, accessIssuer: 'https://owner.cloudflareaccess.com', accessAudience: 'aud-owner', allowedEmail: 'owner@example.com' };
  const adapter = Object.assign(new EventEmitter(), { status: { connected: false }, close() {} });
  const { app } = await buildApp(config, { adapter: adapter as any, keys: createLocalJWKSet({ keys: [jwk] }), serveStatic: false });
  try {
    const headers = { host: 'agent.example.com' };
    for (const url of ['/api/health', '/api/session', '/api/projects']) expect((await app.inject({ url, headers })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/session', headers: { ...headers, 'cf-access-jwt-assertion': 'forged' } })).statusCode).toBe(403);
    const token = await new SignJWT({ email: 'owner@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'gateway' }).setIssuer(config.accessIssuer!).setAudience(config.accessAudience!).setExpirationTime('1h').sign(privateKey);
    expect((await app.inject({ url: '/api/session', headers: { ...headers, 'cf-access-jwt-assertion': token } })).statusCode).toBe(200);
  } finally { await app.close(); removeTempFixture(directory, 'agent-control-'); }
});
it('allows two subscribed clients and rejects WebSocket upgrades from an untrusted origin', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agent-control-ws-'));
  let view = { id: 'test-thread', revision: 1, turns: [], totalTurns: 0 };
  const adapter = Object.assign(new EventEmitter(), { status: { connected: true }, view: async () => view, viewCached: () => view, touch() {}, close() {} });
  const { app } = await buildApp({ ...base, dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  const sockets: any[] = [];
  try {
    await app.ready();
    const session = await app.inject({ url: '/api/session', headers: { host: 'localhost:3000' } });
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    await expect(app.injectWS('/api/events', { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3000', cookie, origin: 'https://evil.example' } } as any)).rejects.toThrow();
    for (let i = 0; i < 2; i++) {
      const socket = await app.injectWS('/api/events', { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3000', cookie, origin: 'http://localhost:3000' } } as any);
      sockets.push(socket);
      const received = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'subscribe', threadId: 'test-thread' }));
      const [message] = await received;
      expect(JSON.parse(message.toString()).thread.id).toBe('test-thread');
    }
    const received = sockets.map(socket => once(socket, 'message'));
    view = { ...view, revision: 2 };
    adapter.emit('thread', 'test-thread');
    for (const [message] of await Promise.all(received)) expect(JSON.parse(message.toString()).thread.revision).toBe(2);
  } finally { for (const socket of sockets) socket.terminate(); await app.close(); removeTempFixture(directory, 'agent-control-'); }
});
