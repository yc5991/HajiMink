import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { removeTempFixture } from './safe-temp';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { Store } from '../server/store';
import { OwnerAuth } from '../server/owner-auth';
import { buildApp } from '../server/app';
import type { GatewayConfig } from '../server/security';

const password = 'owner-test-only-passphrase!';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) removeTempFixture(directory, 'agent-control-owner-'); });
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agent-control-owner-')); directories.push(directory);
  const store = new Store(directory); let clock = Date.now();
  return { store, directory, owner: new OwnerAuth(store.db, 'https://agent.example.com', () => clock), advance: (ms: number) => { clock += ms; } };
}
const config = (directory: string): GatewayConfig => ({ mode: 'owner', port: 3000, publicOrigin: 'https://agent.example.com', dataDir: directory });
const adapter = () => Object.assign(new EventEmitter(), { status: { connected: true }, catalog: async () => ({ projects: [], threads: [] }), models: () => [], close() {} });
// A software authenticator exercises real WebAuthn signatures without enrolling a person's device.
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest();
const encode = (value: Uint8Array) => Buffer.from(value).toString('base64url');
function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }); const credentialId = randomBytes(32);
  const id = encode(credentialId);
  const cose = isoCBOR.encode(new Map<any, any>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))]]));
  const clientData = (type: string, challenge: string, origin: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    register(challenge: string, origin: string, rpID: string) {
      const length = Buffer.alloc(2); length.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([digest(rpID), Buffer.from([0x45]), Buffer.alloc(4 + 16), length, credentialId, cose]);
      const attestation = isoCBOR.encode(new Map<any, any>([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]));
      return { id, rawId: id, type: 'public-key' as const, clientExtensionResults: {}, response: { clientDataJSON: encode(clientData('webauthn.create', challenge, origin)), attestationObject: encode(attestation), transports: ['internal' as const] } };
    },
    assertion(challenge: string, origin: string, rpID: string, counter = 1, flags = 0x05, wrongKey = false) {
      const count = Buffer.alloc(4); count.writeUInt32BE(counter);
      const authData = Buffer.concat([digest(rpID), Buffer.from([flags]), count]);
      const client = clientData('webauthn.get', challenge, origin);
      const key = wrongKey ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey : privateKey;
      return { id, rawId: id, type: 'public-key' as const, clientExtensionResults: {}, response: { authenticatorData: encode(authData), clientDataJSON: encode(client), signature: encode(sign('sha256', Buffer.concat([authData, digest(client)]), key)) } };
    },
  };
}
it('verifies real passkey registration and signatures, and rejects wrong origin, RP, verification, key and replay', async () => {
  const { owner, store } = fixture(); const device = authenticator(); const binding = 'software-browser';
  try {
    const registration = await owner.registrationOptions(binding);
    await owner.registerPasskey(registration.challengeId, device.register(registration.options.challenge, owner.origin, owner.rpID), binding);
    expect(owner.summary()).toEqual({ configured: true, passwordEnabled: false, passkeyCount: 1 });
    const login = await owner.authenticationOptions(binding, 'client');
    const response = device.assertion(login.options.challenge, owner.origin, owner.rpID);
    const issued = await owner.loginPasskey(login.challengeId, response, binding, false);
    expect(owner.session(issued.token)).toBeDefined(); expect(owner.passkeys()[0].counter).toBe(1);
    await expect(owner.loginPasskey(login.challengeId, response, binding, false)).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });
    for (const [origin, rpID, counter, flags, wrongKey] of [
      ['https://evil.example', owner.rpID, 2, 0x05, false],
      [owner.origin, 'evil.example', 2, 0x05, false],
      [owner.origin, owner.rpID, 2, 0x01, false],
      [owner.origin, owner.rpID, 2, 0x05, true],
      [owner.origin, owner.rpID, 1, 0x05, false],
    ] as const) {
      const attempt = await owner.authenticationOptions(binding, 'client');
      await expect(owner.loginPasskey(attempt.challengeId, device.assertion(attempt.options.challenge, origin, rpID, counter, flags, wrongKey), binding, false)).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
    }
    expect(owner.passkeys()[0].counter).toBe(1);
  } finally { store.close(); }
});
it('stores salted password hashes and opaque session hashes without saving passwords or session tokens', async () => {
  const { owner, store } = fixture();
  try {
    await expect(owner.setPassword('            ')).rejects.toMatchObject({ code: 'PASSWORD_POLICY' });
    await owner.setPassword(password);
    const record = store.db.prepare('SELECT * FROM owner_identity').get() as any;
    expect(JSON.stringify(record)).not.toContain(password); expect(record.password_hash).toHaveLength(86);
    await expect(owner.loginPassword('wrong', 'client', false)).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
    const issued = await owner.loginPassword(password, 'client', false);
    expect(owner.session(issued.token)).toBeDefined();
    expect(JSON.stringify(store.db.prepare('SELECT * FROM owner_sessions').all())).not.toContain(issued.token);
    expect(store.db.prepare('SELECT * FROM operations').all()).toHaveLength(0);
  } finally { store.close(); }
});
it('expires sessions, preserves them across restart and revokes them when the password changes', async () => {
  const { owner, store, advance } = fixture();
  try {
    await owner.setPassword(password);
    const short = owner.issueSession(false); const remembered = owner.issueSession(true);
    expect(short.maxAge).toBe(8 * 3600); expect(remembered.maxAge).toBe(7 * 24 * 3600);
    expect(new OwnerAuth(store.db, owner.origin).session(short.token)).toBeDefined();
    advance(8 * 3600 * 1000 + 1);
    expect(owner.session(short.token)).toBeUndefined(); expect(owner.session(remembered.token)).toBeDefined();
    await owner.setPassword('a-different-test-passphrase!');
    expect(owner.session(remembered.token)).toBeUndefined();
  } finally { store.close(); }
});
it('limits password guesses and resets the rate window after its expiry', async () => {
  const { owner, store, advance } = fixture();
  try {
    await owner.setPassword(password);
    for (let index = 0; index < 10; index++) await expect(owner.loginPassword('wrong', 'client', false)).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
    await expect(owner.loginPassword(password, 'client', false)).rejects.toMatchObject({ code: 'LOGIN_RATE_LIMIT' });
    advance(15 * 60 * 1000 + 1);
    await expect(owner.loginPassword(password, 'client', false)).resolves.toHaveProperty('token');
  } finally { store.close(); }
});
it('requires passkey user verification and binds single-use challenges to the same browser', async () => {
  const { owner, store, advance } = fixture();
  try {
    const register = await owner.registrationOptions('browser-one');
    expect(register.options.rp.id).toBe('agent.example.com');
    expect(register.options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    const auth = await owner.authenticationOptions('browser-one', 'client');
    expect(auth.options.userVerification).toBe('required');
    const forged = { id: 'unregistered', rawId: 'unregistered', type: 'public-key', response: {}, clientExtensionResults: {} } as any;
    await expect(owner.loginPasskey(auth.challengeId, forged, 'browser-two', false)).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });
    await expect(owner.loginPasskey(auth.challengeId, forged, 'browser-one', false)).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
    await expect(owner.loginPasskey(auth.challengeId, forged, 'browser-one', false)).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });
    const expired = await owner.authenticationOptions('browser-one', 'client'); advance(5 * 60 * 1000 + 1);
    await expect(owner.loginPasskey(expired.challengeId, forged, 'browser-one', false)).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });
  } finally { store.close(); }
});
it('refuses to launch the public owner mode before a credential has been enrolled', async () => {
  const { store, directory } = fixture();
  await expect(buildApp(config(directory), { store, adapter: adapter() as any, serveStatic: false })).rejects.toThrow('设置密码或通行密钥');
});
it('protects all business routes, rejects forged headers and cookies, and requires login CSRF and origin checks', async () => {
  const { store, owner, directory } = fixture(); await owner.setPassword(password);
  const { app } = await buildApp(config(directory), { store, adapter: adapter() as any, serveStatic: false });
  try {
    const host = { host: 'agent.example.com' };
    for (const url of ['/api/projects', '/api/threads', '/api/health', '/api%2fprojects', '//api/projects', '/assets/../api/projects']) expect((await app.inject({ url, headers: host })).statusCode).toBe(401);
    expect((await app.inject({ url: '/help', headers: host })).statusCode).toBe(404); // Public page, with static serving disabled in this fixture.
    expect((await app.inject({ url: '/help/private', headers: host })).statusCode).toBe(401);
    for (const headers of [{ ...host, 'cf-access-jwt-assertion': 'forged' }, { ...host, cookie: '__Host-ac_owner=forged' }]) expect((await app.inject({ url: '/api/projects', headers })).statusCode).toBe(401);
    const bootstrap = await app.inject({ url: '/api/auth/bootstrap', headers: host });
    expect(bootstrap.statusCode).toBe(200); expect(bootstrap.json()).toMatchObject({ mode: 'owner', authenticated: false });
    const cookie = bootstrap.cookies.map(value => `${value.name}=${value.value}`).join('; ');
    const headers = { ...host, origin: 'https://agent.example.com', cookie, 'x-agent-control-csrf': bootstrap.json().csrf };
    expect((await app.inject({ method: 'POST', url: '/api/auth/password', headers, payload: { password: 'attacker-test-passphrase' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/password/login', headers: host, payload: { password } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/password/login', headers: { ...headers, origin: 'https://evil.example' }, payload: { password } })).statusCode).toBe(403);
    const login = await app.inject({ method: 'POST', url: '/api/auth/password/login', headers, payload: { password } });
    expect(login.statusCode).toBe(200); expect(String(login.headers['set-cookie'])).toMatch(/__Host-ac_owner=.*HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
    const authenticated = { ...headers, cookie: `${cookie}; ${login.cookies.map(value => `${value.name}=${value.value}`).join('; ')}` };
    expect((await app.inject({ url: '/api/projects', headers: authenticated })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: authenticated, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/projects', headers: authenticated })).statusCode).toBe(401);
  } finally { await app.close(); }
});
it('closes an authenticated WebSocket immediately when its login session is revoked', async () => {
  const { store, owner, directory } = fixture(); await owner.setPassword(password);
  const { app } = await buildApp(config(directory), { store, adapter: adapter() as any, serveStatic: false });
  let socket: any;
  try {
    await app.ready(); const issued = owner.issueSession();
    const bootstrap = await app.inject({ url: '/api/auth/bootstrap', headers: { host: 'agent.example.com' } });
    const cookies = bootstrap.cookies.map(value => `${value.name}=${value.value}`).join('; ');
    socket = await app.injectWS('/api/events', { headers: { host: 'agent.example.com', origin: 'https://agent.example.com', cookie: `${cookies}; __Host-ac_owner=${issued.token}` } });
    const closed = once(socket, 'close');
    // The gateway has its own OwnerAuth instance over this same database.
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { host: 'agent.example.com', origin: 'https://agent.example.com', cookie: `${cookies}; __Host-ac_owner=${issued.token}`, 'x-agent-control-csrf': bootstrap.json().csrf }, payload: {} });
    expect(logout.statusCode).toBe(200);
    const [code] = await closed; expect(code).toBe(1008);
  } finally { socket?.terminate(); await app.close(); }
});

function setupDescriptor(code: string, expiresAt = Date.now() + 10 * 60 * 1000) {
  return { generation: '11111111-1111-4111-8111-111111111111', codeHash: createHash('sha256').update(code).digest('hex'), expiresAt };
}
function cookieHeader(cookies: Array<{ name: string; value: string }>) { return cookies.map(value => `${value.name}=${value.value}`).join('; '); }

it('keeps setup codes single use and browser bound across restart, expiry and local regeneration', () => {
  const { store, owner, advance } = fixture();
  try {
    const code = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url');
    const other = randomBytes(32).toString('base64url'), descriptor = setupDescriptor(code);
    expect(owner.prepareSetup(descriptor)).toBe(true);
    const issued = owner.exchangeSetupCode(code, nonce, 'client');
    expect(owner.setupSession(issued.token, nonce)).toBe(true);
    expect(owner.setupSession(issued.token, other)).toBe(false);
    expect(() => owner.exchangeSetupCode(code, nonce, 'client')).toThrow();
    const reloaded = new OwnerAuth(store.db, owner.origin, () => Date.now());
    expect(reloaded.prepareSetup(descriptor)).toBe(true);
    expect(reloaded.setupSession(issued.token, nonce)).toBe(true);
    expect(() => reloaded.exchangeSetupCode(code, nonce, 'client')).toThrow();
    expect(JSON.stringify(store.db.prepare('SELECT * FROM owner_setup').get())).not.toContain(code);
    expect(JSON.stringify(store.db.prepare('SELECT * FROM owner_setup').get())).not.toContain(issued.token);
    advance(5 * 60 * 1000 + 1); expect(owner.setupSession(issued.token, nonce)).toBe(false);
    const nextCode = randomBytes(32).toString('base64url');
    const next = { ...setupDescriptor(nextCode, Date.now() + 12 * 60 * 1000), generation: '22222222-2222-4222-8222-222222222222' };
    expect(owner.prepareSetup(next)).toBe(true);
    expect(owner.setupSession(issued.token, nonce)).toBe(false);
    expect(() => owner.exchangeSetupCode(code, nonce, 'client')).toThrow();
    expect(owner.exchangeSetupCode(nextCode, nonce, 'client').token).toHaveLength(43);
  } finally { store.close(); }
});

it('keeps an unconfigured owner gateway locked until a setup session registers a verified passkey', async () => {
  const { store, directory } = fixture();
  const code = randomBytes(32).toString('base64url');
  const { app, ownerAuth } = await buildApp({ ...config(directory), ownerSetup: setupDescriptor(code) }, { store, adapter: adapter() as any, serveStatic: false });
  const host = { host: 'agent.example.com' };
  try {
    for (const url of ['/api/projects', '/api/threads', '/api/health', '/api/session', '/api/events']) expect((await app.inject({ url, headers: host })).statusCode).toBe(401);
    const bootstrap = await app.inject({ url: '/api/auth/bootstrap', headers: host });
    expect(bootstrap.json()).toMatchObject({ mode: 'owner', configured: false, authenticated: false, setupPending: true, setupCodeAvailable: true, setupSession: false });
    const cookies = cookieHeader(bootstrap.cookies);
    const headers = { ...host, origin: 'https://agent.example.com', cookie: cookies, 'x-agent-control-csrf': bootstrap.json().csrf };
    expect((await app.inject({ method: 'POST', url: '/api/auth/setup/exchange', headers: { ...headers, host: 'evil.example' }, payload: { code } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/setup/exchange', headers: { ...headers, origin: 'https://evil.example' }, payload: { code } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/setup/exchange', headers: { ...headers, 'x-agent-control-csrf': 'wrong' }, payload: { code } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/setup/options', headers, payload: {} })).statusCode).toBe(409);
    const exchanged = await app.inject({ method: 'POST', url: '/api/auth/setup/exchange', headers, payload: { code } });
    expect(exchanged.statusCode).toBe(200);
    expect(String(exchanged.headers['set-cookie'])).toMatch(/__Host-ac_setup=.*HttpOnly; SameSite=Strict; Max-Age=\d+; Secure/);
    expect((await app.inject({ method: 'POST', url: '/api/auth/setup/exchange', headers, payload: { code } })).statusCode).toBe(409);
    const setupCookies = `${cookies}; ${cookieHeader(exchanged.cookies)}`;
    const setupHeaders = { ...headers, cookie: setupCookies };
    expect((await app.inject({ url: '/api/auth/bootstrap', headers: { ...host, cookie: setupCookies } })).json()).toMatchObject({ authenticated: false, setupSession: true, setupCodeAvailable: false });
    for (const url of ['/api/projects', '/api/threads', '/api/health', '/api/session', '/api/events']) expect((await app.inject({ url, headers: setupHeaders })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/register/options', headers: setupHeaders, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/password', headers: setupHeaders, payload: { password } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/device/request', headers: setupHeaders, payload: { name: 'test device' } })).statusCode).toBe(401);
    await expect(app.injectWS('/api/events', { headers: setupHeaders })).rejects.toThrow();
    const wrongBinding = setupCookies.replace(/__Host-ac_auth_nonce=[^;]+/, `__Host-ac_auth_nonce=${randomBytes(32).toString('base64url')}`);
    expect((await app.inject({ method: 'POST', url: '/api/auth/setup/options', headers: { ...headers, cookie: wrongBinding }, payload: {} })).statusCode).toBe(409);
    const options = await app.inject({ method: 'POST', url: '/api/auth/setup/options', headers: setupHeaders, payload: {} });
    expect(options.statusCode).toBe(200); expect(options.json().options.rp.id).toBe('agent.example.com');
    const device = authenticator();
    const bad = device.register(options.json().options.challenge, 'https://evil.example', ownerAuth.rpID);
    expect((await app.inject({ method: 'POST', url: '/api/auth/setup/verify', headers: setupHeaders, payload: { challengeId: options.json().challengeId, credential: bad } })).statusCode).toBe(400);
    expect(ownerAuth.configured).toBe(false);
    const next = await app.inject({ method: 'POST', url: '/api/auth/setup/options', headers: setupHeaders, payload: {} });
    const credential = device.register(next.json().options.challenge, ownerAuth.origin, ownerAuth.rpID);
    const verified = await app.inject({ method: 'POST', url: '/api/auth/setup/verify', headers: setupHeaders, payload: { challengeId: next.json().challengeId, credential } });
    expect(verified.statusCode).toBe(200);
    expect(String(verified.headers['set-cookie'])).toMatch(/__Host-ac_owner=.*HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
    expect(String(verified.headers['set-cookie'])).toMatch(/__Host-ac_setup=;.*Max-Age=0; Secure/);
    expect(ownerAuth.summary()).toEqual({ configured: true, passwordEnabled: false, passkeyCount: 1 });
    const loginCookie = verified.cookies.find(cookie => cookie.name === '__Host-ac_owner');
    expect(loginCookie).toBeDefined();
    expect((await app.inject({ url: '/api/projects', headers: { ...host, cookie: `${cookies}; __Host-ac_owner=${loginCookie!.value}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/setup/options', headers: setupHeaders, payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/auth/setup/exchange', headers, payload: { code } })).statusCode).toBe(409);
  } finally { await app.close(); }
});

it('accepts at most one initial credential when registration attempts race', async () => {
  const { store, directory } = fixture(); const code = randomBytes(32).toString('base64url');
  const { app, ownerAuth } = await buildApp({ ...config(directory), ownerSetup: setupDescriptor(code) }, { store, adapter: adapter() as any, serveStatic: false });
  try {
    const bootstrap = await app.inject({ url: '/api/auth/bootstrap', headers: { host: 'agent.example.com' } });
    const headers = { host: 'agent.example.com', origin: 'https://agent.example.com', cookie: cookieHeader(bootstrap.cookies), 'x-agent-control-csrf': bootstrap.json().csrf };
    const exchanged = await app.inject({ method: 'POST', url: '/api/auth/setup/exchange', headers, payload: { code } });
    const setupHeaders = { ...headers, cookie: `${headers.cookie}; ${cookieHeader(exchanged.cookies)}` };
    const options = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/auth/setup/options', headers: setupHeaders, payload: {} })));
    const attempts = options.map(item => {
      const value = item.json(); const credential = authenticator().register(value.options.challenge, ownerAuth.origin, ownerAuth.rpID);
      return app.inject({ method: 'POST', url: '/api/auth/setup/verify', headers: setupHeaders, payload: { challengeId: value.challengeId, credential } });
    });
    const results = await Promise.all(attempts);
    expect(results.map(value => value.statusCode).sort()).toEqual([200, 409]);
    expect(ownerAuth.summary()).toEqual({ configured: true, passwordEnabled: false, passkeyCount: 1 });
  } finally { await app.close(); }
});

it('never lets a setup descriptor replace an existing owner password', async () => {
  const { store, owner, directory } = fixture(); await owner.setPassword(password);
  const code = randomBytes(32).toString('base64url');
  const { app, ownerAuth } = await buildApp({ ...config(directory), ownerSetup: setupDescriptor(code) }, { store, adapter: adapter() as any, serveStatic: false });
  try {
    const boot = await app.inject({ url: '/api/auth/bootstrap', headers: { host: 'agent.example.com' } });
    expect(boot.json()).toMatchObject({ configured: true, setupPending: false });
    const headers = { host: 'agent.example.com', origin: 'https://agent.example.com', cookie: cookieHeader(boot.cookies), 'x-agent-control-csrf': boot.json().csrf };
    expect((await app.inject({ method: 'POST', url: '/api/auth/setup/exchange', headers, payload: { code } })).statusCode).toBe(409);
    await expect(ownerAuth.loginPassword(password, 'client', false)).resolves.toHaveProperty('token');
  } finally { await app.close(); }
});

it('limits setup guesses and rejects expired setup codes', () => {
  const { owner, store, advance } = fixture();
  try {
    const code = randomBytes(32).toString('base64url'), binding = randomBytes(32).toString('base64url');
    expect(owner.prepareSetup(setupDescriptor(code))).toBe(true);
    for (let i = 0; i < 8; i++) expect(() => owner.exchangeSetupCode(randomBytes(32).toString('base64url'), binding, 'client')).toThrow();
    expect(() => owner.exchangeSetupCode(code, binding, 'client')).toThrow('尝试过于频繁');
    advance(10 * 60 * 1000 + 1000);
    expect(() => owner.exchangeSetupCode(code, binding, 'another-client')).toThrow('已过期');
  } finally { store.close(); }
});

it('allows a password fallback through the restricted setup session without exposing business APIs', async () => {
  const { store, directory } = fixture(); const code = randomBytes(32).toString('base64url');
  const { app, ownerAuth } = await buildApp({ ...config(directory), ownerSetup: setupDescriptor(code) }, { store, adapter: adapter() as any, serveStatic: false });
  try {
    const boot = await app.inject({ url: '/api/auth/bootstrap', headers: { host: 'agent.example.com' } });
    const headers = { host: 'agent.example.com', origin: 'https://agent.example.com', cookie: cookieHeader(boot.cookies), 'x-agent-control-csrf': boot.json().csrf };
    expect((await app.inject({ method: 'POST', url: '/api/auth/setup/password', headers, payload: { password } })).statusCode).toBe(409);
    const exchanged = await app.inject({ method: 'POST', url: '/api/auth/setup/exchange', headers, payload: { code } });
    const setupHeaders = { ...headers, cookie: `${headers.cookie}; ${cookieHeader(exchanged.cookies)}` };
    expect((await app.inject({ url: '/api/projects', headers: setupHeaders })).statusCode).toBe(401);
    const result = await app.inject({ method: 'POST', url: '/api/auth/setup/password', headers: setupHeaders, payload: { password } });
    expect(result.statusCode).toBe(200); expect(ownerAuth.summary()).toEqual({ configured: true, passwordEnabled: true, passkeyCount: 0 });
    expect((await app.inject({ method: 'POST', url: '/api/auth/setup/password', headers: setupHeaders, payload: { password: 'replacement-test-password' } })).statusCode).toBe(409);
    await expect(ownerAuth.loginPassword(password, 'client', false)).resolves.toHaveProperty('token');
  } finally { await app.close(); }
});

it('accepts at most one initial password or passkey in a mixed concurrent race', async () => {
  const { store, directory } = fixture(); const code = randomBytes(32).toString('base64url');
  const { app, ownerAuth } = await buildApp({ ...config(directory), ownerSetup: setupDescriptor(code) }, { store, adapter: adapter() as any, serveStatic: false });
  try {
    const boot = await app.inject({ url: '/api/auth/bootstrap', headers: { host: 'agent.example.com' } });
    const headers = { host: 'agent.example.com', origin: 'https://agent.example.com', cookie: cookieHeader(boot.cookies), 'x-agent-control-csrf': boot.json().csrf };
    const exchanged = await app.inject({ method: 'POST', url: '/api/auth/setup/exchange', headers, payload: { code } });
    const setupHeaders = { ...headers, cookie: `${headers.cookie}; ${cookieHeader(exchanged.cookies)}` };
    const opts = (await app.inject({ method: 'POST', url: '/api/auth/setup/options', headers: setupHeaders, payload: {} })).json();
    const credential = authenticator().register(opts.options.challenge, ownerAuth.origin, ownerAuth.rpID);
    const results = await Promise.all([
      app.inject({ method: 'POST', url: '/api/auth/setup/password', headers: setupHeaders, payload: { password } }),
      app.inject({ method: 'POST', url: '/api/auth/setup/verify', headers: setupHeaders, payload: { challengeId: opts.challengeId, credential } }),
    ]);
    expect(results.map(value => value.statusCode).sort()).toEqual([200, 409]);
    const summary = ownerAuth.summary(); expect(summary.configured).toBe(true); expect(Number(summary.passwordEnabled) + summary.passkeyCount).toBe(1);
  } finally { await app.close(); }
});

it('consumes a setup code atomically when two exchanges arrive together', async () => {
  const { store, directory } = fixture(); const code = randomBytes(32).toString('base64url');
  const { app } = await buildApp({ ...config(directory), ownerSetup: setupDescriptor(code) }, { store, adapter: adapter() as any, serveStatic: false });
  try {
    const boot = await app.inject({ url: '/api/auth/bootstrap', headers: { host: 'agent.example.com' } });
    const headers = { host: 'agent.example.com', origin: 'https://agent.example.com', cookie: cookieHeader(boot.cookies), 'x-agent-control-csrf': boot.json().csrf };
    const results = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/auth/setup/exchange', headers, payload: { code } })));
    expect(results.map(value => value.statusCode).sort()).toEqual([200, 409]);
    expect(results.filter(value => value.cookies.some(cookie => cookie.name === '__Host-ac_setup'))).toHaveLength(1);
  } finally { await app.close(); }
});


it('rejects a password login that completes after another owner changes the password', async () => {
  const { owner, store, directory } = fixture(); const foreignStore = new Store(directory); const replacement = 'new-fixture-passphrase-2026';
  let release!: () => void; let signal!: () => void;
  const waiting = new Promise<void>(resolve => { signal = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await owner.setPassword(password);
    const other = new OwnerAuth(foreignStore.db, owner.origin);
    const original = (owner as any).passwordHash.bind(owner);
    vi.spyOn(owner as any, 'passwordHash').mockImplementation(async (...args: any[]) => { const [value, salt] = args as [string, string];
      const hashed = await original(value, salt);
      if (value === password) { signal(); await gate; }
      return hashed;
    });
    const pending = owner.loginPassword(password, 'fixture-client', false);
    await waiting;
    await other.setPassword(replacement);
    release();
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_CHANGED' });
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM owner_sessions').get()).toMatchObject({ count: 0 });
  } finally { release(); vi.restoreAllMocks(); foreignStore.close(); store.close(); }
});

it('rejects a passkey login that completes after all sessions are revoked', async () => {
  const { owner, store } = fixture(); const device = authenticator(); const binding = 'fixture-browser';
  try {
    const registration = await owner.registrationOptions(binding);
    await owner.registerPasskey(registration.challengeId, device.register(registration.options.challenge, owner.origin, owner.rpID), binding);
    const login = await owner.authenticationOptions(binding, 'fixture-client');
    const pending = owner.loginPasskey(login.challengeId, device.assertion(login.options.challenge, owner.origin, owner.rpID), binding, false);
    new OwnerAuth(store.db, owner.origin).revokeAll();
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_CHANGED' });
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM owner_sessions').get()).toMatchObject({ count: 0 });
  } finally { store.close(); }
});


it('rejects a password change when its owner session is revoked during hashing', async () => {
  const { owner, store } = fixture(); const replacement = 'replacement-fixture-password';
  let release!: () => void; let signal!: () => void;
  const waiting = new Promise<void>(resolve => { signal = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await owner.setPassword(password);
    const session = owner.session(owner.issueSession().token)!;
    const original = (owner as any).passwordHash.bind(owner);
    vi.spyOn(owner as any, 'passwordHash').mockImplementation(async (...args: any[]) => { const [value, salt] = args as [string, string];
      const hashed = await original(value, salt);
      if (value === replacement) { signal(); await gate; }
      return hashed;
    });
    const pending = owner.setPassword(replacement, session.hash);
    await waiting; owner.revoke(session.hash); release();
    await expect(pending).rejects.toMatchObject({ code: 'REAUTHENTICATE' });
    await expect(owner.loginPassword(password, 'owner-fixture', false)).resolves.toHaveProperty('token');
    await expect(owner.loginPassword(replacement, 'other-fixture', false)).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
  } finally { release(); vi.restoreAllMocks(); store.close(); }
});

it('rejects a passkey enrollment when its owner session is revoked before verification finishes', async () => {
  const { owner, store } = fixture(); const device = authenticator(); const binding = 'fixture-browser';
  try {
    const session = owner.session(owner.issueSession().token)!;
    const registration = await owner.registrationOptions(binding);
    const pending = owner.registerPasskey(registration.challengeId, device.register(registration.options.challenge, owner.origin, owner.rpID), binding, session.hash);
    owner.revoke(session.hash);
    await expect(pending).rejects.toMatchObject({ code: 'REAUTHENTICATE' });
    expect(owner.passkeys()).toHaveLength(0);
  } finally { store.close(); }
});

it('rechecks the actual HTTP owner session before an in-flight password update commits', async () => {
  const { store, owner, directory } = fixture(); await owner.setPassword(password);
  const { app, ownerAuth } = await buildApp(config(directory), { store, adapter: adapter() as any, serveStatic: false });
  let release!: () => void; let signal!: () => void;
  const waiting = new Promise<void>(resolve => { signal = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const issued = ownerAuth.issueSession(); const session = ownerAuth.session(issued.token)!;
    const bootstrap = await app.inject({ url: '/api/auth/bootstrap', headers: { host: 'agent.example.com' } });
    const cookies = bootstrap.cookies.map(value => `${value.name}=${value.value}`).join('; ');
    const headers = { host: 'agent.example.com', origin: 'https://agent.example.com', cookie: `${cookies}; __Host-ac_owner=${issued.token}`, 'x-agent-control-csrf': bootstrap.json().csrf };
    const replacement = 'route-fixture-new-password';
    const original = (ownerAuth as any).passwordHash.bind(ownerAuth);
    vi.spyOn(ownerAuth as any, 'passwordHash').mockImplementation(async (...args: any[]) => { const [value, salt] = args as [string, string];
      const hashed = await original(value, salt);
      if (value === replacement) { signal(); await gate; }
      return hashed;
    });
    const pending = app.inject({ method: 'POST', url: '/api/auth/password', headers, payload: { password: replacement } });
    await waiting; ownerAuth.revoke(session.hash); release();
    const result = await pending;
    expect(result.statusCode).toBe(401); expect(result.json().error.code).toBe('REAUTHENTICATE');
    await expect(ownerAuth.loginPassword(password, 'fixture-after', false)).resolves.toHaveProperty('token');
  } finally { release(); vi.restoreAllMocks(); await app.close(); }
});

it('rechecks the actual HTTP owner session before a passkey enrollment commits', async () => {
  const { store, owner, directory } = fixture(); await owner.setPassword(password);
  const { app, ownerAuth } = await buildApp(config(directory), { store, adapter: adapter() as any, serveStatic: false });
  let release!: () => void; let signal!: () => void;
  const waiting = new Promise<void>(resolve => { signal = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const issued = ownerAuth.issueSession(); const session = ownerAuth.session(issued.token)!;
    const bootstrap = await app.inject({ url: '/api/auth/bootstrap', headers: { host: 'agent.example.com' } });
    const nonce = bootstrap.cookies.find(value => value.name === '__Host-ac_auth_nonce')!.value;
    const cookies = bootstrap.cookies.map(value => `${value.name}=${value.value}`).join('; ');
    const headers = { host: 'agent.example.com', origin: 'https://agent.example.com', cookie: `${cookies}; __Host-ac_owner=${issued.token}`, 'x-agent-control-csrf': bootstrap.json().csrf };
    const registration = await ownerAuth.registrationOptions(nonce); const device = authenticator();
    const original = (ownerAuth as any).verifiedRegistration.bind(ownerAuth);
    vi.spyOn(ownerAuth as any, 'verifiedRegistration').mockImplementation(async (...args: any[]) => { const value = await original(...args); signal(); await gate; return value; });
    const pending = app.inject({ method: 'POST', url: '/api/auth/register/verify', headers, payload: { challengeId: registration.challengeId, credential: device.register(registration.options.challenge, ownerAuth.origin, ownerAuth.rpID) } });
    await waiting; ownerAuth.revoke(session.hash); release();
    const result = await pending;
    expect(result.statusCode).toBe(401); expect(result.json().error.code).toBe('REAUTHENTICATE');
    expect(ownerAuth.passkeys()).toHaveLength(0);
  } finally { release(); vi.restoreAllMocks(); await app.close(); }
});

it('does not allow concurrent password changes to overwrite the first committed change', async () => {
  const { owner, store } = fixture(); let release!: () => void; let signal!: () => void;
  const waiting = new Promise<void>(resolve => { signal = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const first = 'first-fixture-new-password', second = 'second-fixture-new-password';
  try {
    await owner.setPassword(password);
    const other = new OwnerAuth(store.db, owner.origin);
    const original = (owner as any).passwordHash.bind(owner);
    vi.spyOn(owner as any, 'passwordHash').mockImplementation(async (...args: any[]) => { const [value, salt] = args as [string, string]; const hashed = await original(value, salt); if (value === first) { signal(); await gate; } return hashed; });
    const pending = owner.setPassword(first);
    await waiting; await other.setPassword(second); release();
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_CHANGED' });
    await expect(other.loginPassword(second, 'fixture', false)).resolves.toHaveProperty('token');
    await expect(other.loginPassword(first, 'fixture-2', false)).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
  } finally { release(); vi.restoreAllMocks(); store.close(); }
});

it('does not allow concurrent assertions to regress a passkey counter', async () => {
  const { owner, store } = fixture(); const device = authenticator(); const binding = 'fixture-browser';
  try {
    const registration = await owner.registrationOptions(binding);
    await owner.registerPasskey(registration.challengeId, device.register(registration.options.challenge, owner.origin, owner.rpID), binding);
    const a = await owner.authenticationOptions(binding, 'client-a');
    const b = await owner.authenticationOptions(binding, 'client-b');
    const results = await Promise.allSettled([
      owner.loginPasskey(a.challengeId, device.assertion(a.options.challenge, owner.origin, owner.rpID, 1), binding, false),
      owner.loginPasskey(b.challengeId, device.assertion(b.options.challenge, owner.origin, owner.rpID, 2), binding, false),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'AUTH_CHANGED' });
    expect([1, 2]).toContain(owner.passkeys()[0].counter);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM owner_sessions').get()).toMatchObject({ count: 1 });
  } finally { store.close(); }
});

it('enforces the ten passkey limit at commit even for parallel registrations', async () => {
  const { owner, store } = fixture(); const binding = 'fixture-browser';
  try {
    for (let i = 0; i < 9; i++) {
      const device = authenticator(); const registration = await owner.registrationOptions(binding);
      await owner.registerPasskey(registration.challengeId, device.register(registration.options.challenge, owner.origin, owner.rpID), binding);
    }
    const a = authenticator(), b = authenticator();
    const first = await owner.registrationOptions(binding), second = await owner.registrationOptions(binding);
    const results = await Promise.allSettled([
      owner.registerPasskey(first.challengeId, a.register(first.options.challenge, owner.origin, owner.rpID), binding),
      owner.registerPasskey(second.challengeId, b.register(second.options.challenge, owner.origin, owner.rpID), binding),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'PASSKEY_LIMIT' });
    expect(owner.passkeys()).toHaveLength(10);
  } finally { store.close(); }
});

it('adds revision state to existing owner data without changing passwords or sessions', async () => {
  const { owner, store } = fixture();
  try {
    await owner.setPassword(password); const issued = owner.issueSession();
    const before = store.db.prepare('SELECT * FROM owner_identity').get();
    store.db.exec('DROP TABLE owner_security_state');
    const upgraded = new OwnerAuth(store.db, owner.origin);
    expect(store.db.prepare('SELECT * FROM owner_identity').get()).toEqual(before);
    expect(upgraded.session(issued.token)).toBeDefined();
    await expect(upgraded.loginPassword(password, 'fixture', false)).resolves.toHaveProperty('token');
  } finally { store.close(); }
});

it('rolls back the revision if session revocation cannot commit', () => {
  const { owner, store } = fixture();
  try {
    const issued = owner.issueSession();
    const before = store.db.prepare('SELECT auth_revision FROM owner_security_state').get();
    store.db.exec("CREATE TRIGGER test_refuse_revoke BEFORE DELETE ON owner_sessions BEGIN SELECT RAISE(ABORT, 'test'); END");
    expect(() => owner.revokeAll()).toThrow();
    expect(store.db.prepare('SELECT auth_revision FROM owner_security_state').get()).toEqual(before);
    expect(owner.session(issued.token)).toBeDefined();
  } finally { store.close(); }
});


it('does not issue a session after a committed password change is followed by logout-all', async () => {
  const { store, owner, directory } = fixture(); await owner.setPassword(password);
  const { app, ownerAuth } = await buildApp(config(directory), { store, adapter: adapter() as any, serveStatic: false });
  let release!: () => void; let signal!: () => void;
  const waiting = new Promise<void>(resolve => { signal = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const issued = ownerAuth.issueSession();
    const bootstrap = await app.inject({ url: '/api/auth/bootstrap', headers: { host: 'agent.example.com' } });
    const cookies = bootstrap.cookies.map(value => `${value.name}=${value.value}`).join('; ');
    const headers = { host: 'agent.example.com', origin: 'https://agent.example.com', cookie: `${cookies}; __Host-ac_owner=${issued.token}`, 'x-agent-control-csrf': bootstrap.json().csrf };
    const original = ownerAuth.setPassword.bind(ownerAuth);
    vi.spyOn(ownerAuth, 'setPassword').mockImplementation(async (...args) => { const revision = await original(...args); signal(); await gate; return revision; });
    const replacement = 'committed-fixture-new-password';
    const pending = app.inject({ method: 'POST', url: '/api/auth/password', headers, payload: { password: replacement } });
    await waiting; ownerAuth.revokeAll(); release();
    const response = await pending;
    expect(response.statusCode).toBe(401); expect(response.json().error).toMatchObject({ code: 'AUTH_CHANGED', message: expect.stringContaining('可能已更新') });
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM owner_sessions').get()).toMatchObject({ count: 0 });
    await expect(ownerAuth.loginPassword(replacement, 'fixture-after', false)).resolves.toHaveProperty('token');
  } finally { release(); vi.restoreAllMocks(); await app.close(); }
});

it('does not rotate a revoked session after a passkey enrollment already committed', async () => {
  const { store, owner, directory } = fixture(); await owner.setPassword(password);
  const { app, ownerAuth } = await buildApp(config(directory), { store, adapter: adapter() as any, serveStatic: false });
  let release!: () => void; let signal!: () => void;
  const waiting = new Promise<void>(resolve => { signal = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const issued = ownerAuth.issueSession(); const session = ownerAuth.session(issued.token)!;
    const bootstrap = await app.inject({ url: '/api/auth/bootstrap', headers: { host: 'agent.example.com' } });
    const nonce = bootstrap.cookies.find(value => value.name === '__Host-ac_auth_nonce')!.value;
    const cookies = bootstrap.cookies.map(value => `${value.name}=${value.value}`).join('; ');
    const headers = { host: 'agent.example.com', origin: 'https://agent.example.com', cookie: `${cookies}; __Host-ac_owner=${issued.token}`, 'x-agent-control-csrf': bootstrap.json().csrf };
    const registration = await ownerAuth.registrationOptions(nonce); const device = authenticator();
    const original = ownerAuth.registerPasskey.bind(ownerAuth);
    vi.spyOn(ownerAuth, 'registerPasskey').mockImplementation(async (...args) => { const revision = await original(...args); signal(); await gate; return revision; });
    const pending = app.inject({ method: 'POST', url: '/api/auth/register/verify', headers, payload: { challengeId: registration.challengeId, credential: device.register(registration.options.challenge, ownerAuth.origin, ownerAuth.rpID) } });
    await waiting; ownerAuth.revoke(session.hash); release();
    const response = await pending;
    expect(response.statusCode).toBe(401); expect(response.json().error).toMatchObject({ code: 'AUTH_CHANGED', message: expect.stringContaining('可能已更新') });
    expect(ownerAuth.passkeys()).toHaveLength(1);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM owner_sessions').get()).toMatchObject({ count: 0 });
  } finally { release(); vi.restoreAllMocks(); await app.close(); }
});


it('refuses first-setup session issuance after the setup revision is revoked', async () => {
  const { owner, store } = fixture();
  try {
    const code = randomBytes(32).toString('base64url'), binding = randomBytes(32).toString('base64url');
    expect(owner.prepareSetup(setupDescriptor(code))).toBe(true);
    const setup = owner.exchangeSetupCode(code, binding, 'fixture');
    const revision = await owner.setInitialPassword('fixture-initial-password', binding, setup.token);
    owner.revokeAll();
    expect(() => owner.issueSessionAtRevision(revision)).toThrowError(expect.objectContaining({ code: 'AUTH_CHANGED' }));
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM owner_sessions').get()).toMatchObject({ count: 0 });
    await expect(owner.loginPassword('fixture-initial-password', 'fixture-after', false)).resolves.toHaveProperty('token');
  } finally { store.close(); }
});
