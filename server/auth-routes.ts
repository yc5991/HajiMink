import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';
import { AppError } from './errors.js';
import { OwnerAuth, type OwnerSession } from './owner-auth.js';
import { authNonceName, cookieValue, deviceCookieName, ownerCookieName, ownerSetupCookieName, type GatewayConfig } from './security.js';
import { DeviceAuth, type DeviceSession } from './device-auth.js';

const password = z.string().min(1).max(1024);
const credential = z.object({ id: z.string().min(1).max(4096), rawId: z.string().min(1).max(4096), type: z.literal('public-key'), response: z.object({}).passthrough(), clientExtensionResults: z.record(z.string(), z.unknown()).default({}) }).passthrough();
const challengeId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export async function installAuthRoutes(app: FastifyInstance, config: GatewayConfig, owner: OwnerAuth, devices: DeviceAuth, csrf: string) {
  const localDesktop = (request: FastifyRequest) => (request as any).localDesktop === true;
  const secureFor = (request: FastifyRequest) => config.mode !== 'local' && !localDesktop(request) ? '; Secure' : '';
  const localConfig = { ...config, mode: 'local' as const };
  const cookieConfig = (request: FastifyRequest) => localDesktop(request) ? localConfig : config;
  const sessionOf = (request: FastifyRequest) => (request as any).ownerSession as OwnerSession | undefined;
  const deviceOf = (request: FastifyRequest) => (request as any).deviceSession as DeviceSession | undefined;
  const binding = (request: FastifyRequest) => {
    const value = cookieValue(request.headers.cookie, authNonceName(cookieConfig(request)));
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new AppError('AUTH_PAGE_EXPIRED', '登录页面已过期，请刷新后重试', 409);
    return value;
  };
  // Provider-supplied client-IP headers are untrusted unless a future adapter
  // authenticates their source. A shared limiter is safer than spoofable limits.
  const client = (request: FastifyRequest) => request.ip;
  const setSession = (request: FastifyRequest, reply: FastifyReply, issued: ReturnType<OwnerAuth['issueSession']>, clearSetup = false) => {
    const cookie = `${ownerCookieName(cookieConfig(request))}=${issued.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${issued.maxAge}${secureFor(request)}`;
    reply.header('Set-Cookie', clearSetup ? [cookie, `${ownerSetupCookieName()}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure`] : cookie);
    return { authenticated: true, expiresAt: issued.expiresAt };
  };
  const requireEnrollment = (request: FastifyRequest) => {
    if (config.mode !== 'owner') return; // Access or local development is the initial enrollment authority.
    const session = sessionOf(request);
    if (!session || Date.now() - session.createdAt > 5 * 60 * 1000) throw new AppError('REAUTHENTICATE', '请重新登录后再管理登录方式', 401);
  };
  const rotate = (request: FastifyRequest) => { const session = sessionOf(request); if (session) owner.revoke(session.hash); };
  const issueChangedSession = (revision: number, sessionHash?: string) => {
    try { return sessionHash ? owner.issueSessionAfterEnrollment(revision, sessionHash) : owner.issueSessionAtRevision(revision); }
    catch (error) {
      if (error instanceof AppError && ['AUTH_CHANGED', 'REAUTHENTICATE'].includes(error.code)) throw new AppError('AUTH_CHANGED', '登录状态已更改，登录方式可能已更新，请重新登录确认', 401);
      throw error;
    }
  };
  app.get('/api/auth/bootstrap', async (request, reply) => {
    let nonce = cookieValue(request.headers.cookie, authNonceName(cookieConfig(request)));
    if (!nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) nonce = randomBytes(32).toString('base64url');
    reply.header('Set-Cookie', [
      `ac_session=${csrf}; Path=/; HttpOnly; SameSite=Strict${secureFor(request)}`,
      `${authNonceName(cookieConfig(request))}=${nonce}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600${secureFor(request)}`,
    ]);
    const setup = config.mode === 'owner' ? owner.setupStatus(cookieValue(request.headers.cookie, ownerSetupCookieName()), nonce) : { setupPending: false, setupCodeAvailable: false, setupSession: false };
    return { csrf, mode: config.mode, authenticated: config.mode !== 'owner' || !!sessionOf(request) || !!deviceOf(request), accountType: sessionOf(request) ? 'owner' : deviceOf(request) ? 'device' : null, ...owner.summary(), ...setup };
  });
  app.post('/api/auth/password/login', async (request, reply) => {
    const body = z.object({ password, remember: z.boolean().default(false) }).strict().parse(request.body);
    const issued = await owner.loginPassword(body.password, client(request), body.remember);
    rotate(request); return setSession(request, reply, issued);
  });
  app.post('/api/auth/password', async (request, reply) => {
    requireEnrollment(request);
    const body = z.object({ password: password.min(12) }).strict().parse(request.body);
    const revision = await owner.setPassword(body.password, config.mode === 'owner' ? sessionOf(request)!.hash : undefined);
    return setSession(request, reply, issueChangedSession(revision));
  });
  const requireSetup = (request: FastifyRequest) => {
    if (config.mode !== 'owner' || !owner.setupSession(cookieValue(request.headers.cookie, ownerSetupCookieName()), binding(request)))
      throw new AppError('SETUP_EXPIRED', '首次设置已过期，请在本机重新生成设置码', 409);
  };
  app.post('/api/auth/setup/exchange', async (request, reply) => {
    if (config.mode !== 'owner') throw new AppError('SETUP_UNAVAILABLE', '当前网关不能使用首次设置码', 404);
    const body = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(request.body);
    const issued = owner.exchangeSetupCode(body.code, binding(request), client(request));
    reply.header('Set-Cookie', `${ownerSetupCookieName()}=${issued.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${issued.maxAge}; Secure`);
    return { ok: true, expiresAt: issued.expiresAt };
  });
  app.post('/api/auth/setup/password', async (request, reply) => {
    requireSetup(request);
    const body = z.object({ password: password.min(12) }).strict().parse(request.body);
    const revision = await owner.setInitialPassword(body.password, binding(request), cookieValue(request.headers.cookie, ownerSetupCookieName()));
    return setSession(request, reply, issueChangedSession(revision), true);
  });
  app.post('/api/auth/setup/options', async request => { requireSetup(request); return owner.registrationOptions(binding(request), 'setup-register'); });
  app.post('/api/auth/setup/verify', async (request, reply) => {
    requireSetup(request);
    const body = z.object({ challengeId, credential }).strict().parse(request.body);
    const revision = await owner.registerInitialPasskey(body.challengeId, body.credential as unknown as RegistrationResponseJSON, binding(request), cookieValue(request.headers.cookie, ownerSetupCookieName()));
    return setSession(request, reply, issueChangedSession(revision), true);
  });
  app.post('/api/auth/passkey/options', async request => owner.authenticationOptions(binding(request), client(request)));
  app.post('/api/auth/passkey/login', async (request, reply) => {
    const body = z.object({ challengeId, credential, remember: z.boolean().default(false) }).strict().parse(request.body);
    const issued = await owner.loginPasskey(body.challengeId, body.credential as unknown as AuthenticationResponseJSON, binding(request), body.remember);
    rotate(request); return setSession(request, reply, issued);
  });
  app.post('/api/auth/register/options', async request => { requireEnrollment(request); return owner.registrationOptions(binding(request)); });
  app.post('/api/auth/register/verify', async (request, reply) => {
    requireEnrollment(request);
    const body = z.object({ challengeId, credential }).strict().parse(request.body);
    const session = sessionOf(request);
    const revision = await owner.registerPasskey(body.challengeId, body.credential as unknown as RegistrationResponseJSON, binding(request), config.mode === 'owner' ? session!.hash : undefined);
    if (config.mode === 'owner') return setSession(request, reply, issueChangedSession(revision, session!.hash));
    rotate(request); return setSession(request, reply, issueChangedSession(revision));
  });
  app.post('/api/auth/logout', async (request, reply) => {
    rotate(request);
    const device = deviceOf(request); if (device) devices.revoke(device.id);
    reply.header('Set-Cookie', [`${ownerCookieName(cookieConfig(request))}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureFor(request)}`, `${deviceCookieName(cookieConfig(request))}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureFor(request)}`]);
    return { ok: true };
  });
  app.post('/api/auth/logout-all', async (request, reply) => {
    requireEnrollment(request); owner.revokeAll();
    reply.header('Set-Cookie', [`${ownerCookieName(cookieConfig(request))}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureFor(request)}`, `${deviceCookieName(cookieConfig(request))}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureFor(request)}`]);
    return { ok: true };
  });
  const requireDeviceFeature = () => { if (config.mode !== 'owner') throw new AppError('DEVICE_UNAVAILABLE', '此网关暂不支持设备授权', 404); };
  const requestId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
  app.post('/api/auth/device/request', async request => {
    requireDeviceFeature(); const body = z.object({ name: z.string().min(1).max(60) }).strict().parse(request.body);
    return devices.create(body.name, client(request));
  });
  app.post('/api/auth/device/poll', async request => {
    requireDeviceFeature(); const body = z.object({ requestId }).strict().parse(request.body); return devices.status(body.requestId);
  });
  app.post('/api/auth/device/exchange', async request => {
    requireDeviceFeature(); const body = z.object({ requestId }).strict().parse(request.body); return devices.exchange(body.requestId);
  });
  app.post('/api/auth/device/cancel', async request => {
    requireDeviceFeature(); const body = z.object({ requestId }).strict().parse(request.body); return devices.cancel(body.requestId);
  });
  app.post('/api/auth/device/lookup', async request => {
    requireDeviceFeature(); requireEnrollment(request); const body = z.object({ code: z.string().min(1).max(20) }).strict().parse(request.body); return devices.lookup(body.code, client(request));
  });
  app.post('/api/auth/device/decide', async request => {
    requireDeviceFeature(); requireEnrollment(request); const body = z.object({ approvalTicket: requestId, approve: z.boolean(), remember: z.boolean().default(false) }).strict().parse(request.body);
    return devices.decide(body.approvalTicket, body.approve, body.remember);
  });
  app.get('/api/auth/device/list', async request => { requireDeviceFeature(); requireEnrollment(request); return { devices: devices.list() }; });
  app.post('/api/auth/device/revoke', async request => {
    requireDeviceFeature(); requireEnrollment(request); const body = z.object({ id: z.string().uuid() }).strict().parse(request.body); return devices.revoke(body.id);
  });
}
