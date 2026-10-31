import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';
import type { OwnerAuth, OwnerSetupConfig } from './owner-auth.js';
import type { DeviceAuth } from './device-auth.js';
import type { StreamDiagnostic } from './stream-diagnostic.js';
export interface GatewayConfig { mode: 'local' | 'access' | 'owner'; port: number; publicOrigin: string; accessIssuer?: string; accessAudience?: string; allowedEmail?: string; dataDir: string; ownerSetup?: OwnerSetupConfig; }
export function validateConfig(config: GatewayConfig) {
  if (!['local', 'access', 'owner'].includes(config.mode)) throw new Error('mode 必须为 local、access 或 owner');
  if (config.mode === 'access') {
    if (!config.accessIssuer || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/?$/.test(config.accessIssuer) || !config.accessAudience || !config.allowedEmail) throw new Error('Access 模式需要真实的 accessIssuer、accessAudience 和 allowedEmail');
    if (new URL(config.publicOrigin).protocol !== 'https:') throw new Error('远程正式入口必须使用 HTTPS');
  }
  if (config.mode === 'owner' && new URL(config.publicOrigin).protocol !== 'https:') throw new Error('独立登录的正式入口必须使用 HTTPS');
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('端口无效');
}
export function isLocalHost(host: string) { return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host); }
export async function verifyAccess(token: string, config: GatewayConfig, keys?: JWTVerifyGetKey) {
  if (!token) throw new AppError('LOGIN_REQUIRED', '请先通过 Cloudflare Access 登录', 401);
  try {
    const issuer = config.accessIssuer!.replace(/\/$/, '');
    const { payload } = await jwtVerify(token, keys || createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)), { issuer, audience: config.accessAudience, algorithms: ['RS256'] });
    if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== config.allowedEmail!.toLowerCase()) throw new Error('Wrong owner');
    return payload;
  } catch { throw new AppError('ACCESS_DENIED', '身份令牌无效或该账户无权访问', 403); }
}
export function cookieValue(header: string | undefined, name: string) { return (header || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1); }
export function ownerCookieName(config: GatewayConfig) { return config.mode === 'local' ? 'ac_owner_dev' : '__Host-ac_owner'; }
export function deviceCookieName(config: GatewayConfig) { return config.mode === 'local' ? 'ac_device_dev' : '__Host-ac_device'; }
export function authNonceName(config: GatewayConfig) { return config.mode === 'local' ? 'ac_auth_nonce_dev' : '__Host-ac_auth_nonce'; }
export function ownerSetupCookieName() { return '__Host-ac_setup'; }
const publicAuthRoutes = new Set(['/api/auth/bootstrap', '/api/auth/password/login', '/api/auth/passkey/options', '/api/auth/passkey/login', '/api/auth/device/request', '/api/auth/device/poll', '/api/auth/device/exchange', '/api/auth/device/cancel', '/api/auth/setup/exchange', '/api/auth/setup/options', '/api/auth/setup/verify', '/api/auth/setup/password']);
const ownerOnlyRoutes = new Set(['/api/auth/password', '/api/auth/register/options', '/api/auth/register/verify', '/api/auth/logout-all', '/api/auth/device/lookup', '/api/auth/device/decide', '/api/auth/device/list', '/api/auth/device/revoke']);
const pendingSetupRoutes = new Set(['/api/auth/bootstrap', '/api/auth/setup/exchange', '/api/auth/setup/options', '/api/auth/setup/verify', '/api/auth/setup/password']);
const publicPages = new Set(['/', '/index.html', '/login', '/account', '/device', '/help', '/favicon.ico']);
export async function installSecurity(app: FastifyInstance, config: GatewayConfig, owner: OwnerAuth, devices: DeviceAuth, testKeys?: JWTVerifyGetKey, diagnostic?: StreamDiagnostic) {
  validateConfig(config);
  const csrf = randomBytes(32).toString('hex');
  const keys = testKeys || (config.mode === 'access' ? createRemoteJWKSet(new URL(`${config.accessIssuer!.replace(/\/$/, '')}/cdn-cgi/access/certs`)) : undefined);
  const equal = (value: unknown) => typeof value === 'string' && value.length === csrf.length && timingSafeEqual(Buffer.from(value), Buffer.from(csrf));
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host || '';
    const origin = request.headers.origin;
    const localSession = config.mode === 'owner' && host === `127.0.0.1:${config.port}` && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip) ? owner.session(cookieValue(request.headers.cookie, 'ac_owner_dev')) : undefined;
    const localDesktop = !!localSession;
    (request as any).localDesktop = localDesktop;
    const expected = config.mode === 'local' || localDesktop ? `http://${host}` : config.publicOrigin;
    if (config.mode === 'local') {
      if (!isLocalHost(host) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)) throw new AppError('LOCAL_ONLY', '当前服务仅允许本机访问', 403);
    } else {
      if (!localDesktop && host !== new URL(config.publicOrigin).host) throw new AppError('INVALID_HOST', '访问地址不匹配', 403);
      if (config.mode === 'access') {
        const access = await verifyAccess(String(request.headers['cf-access-jwt-assertion'] || ''), config, keys);
        (request as any).accessExpiresAt = typeof access.exp === 'number' ? access.exp * 1000 : 0;
      }
    }
    // This isolated upgrade accepts only an ephemeral ticket issued over the
    // authenticated local controller. It cannot reach /api/events or any data.
    if (request.url.split('?')[0] === '/api/diagnostics/stream') {
      if (config.mode !== 'owner' || request.url !== '/api/diagnostics/stream' || request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket' || origin !== expected) throw new AppError('ACCESS_DENIED', '诊断请求无效', 403);
      const release = diagnostic?.claim(request.headers['x-hajimink-diagnostic']);
      if (!release) throw new AppError('ACCESS_DENIED', '诊断请求无效', 403);
      // Invalid WebSocket handshakes can fail before the route handler runs.
      const releaseTimer = setTimeout(release, 6000); releaseTimer.unref();
      const finish = () => { clearTimeout(releaseTimer); release(); };
      request.raw.socket?.once('close', finish);
      (request as any).releaseStreamDiagnostic = finish;
      reply.header('Cache-Control', 'no-store');
      return;
    }
    const credentialReady = config.mode !== 'owner' || owner.configured || localDesktop;
    const session = localSession || (credentialReady ? owner.session(cookieValue(request.headers.cookie, ownerCookieName(config))) : undefined);
    const deviceSession = config.mode === 'owner' && credentialReady ? devices.session(cookieValue(request.headers.cookie, deviceCookieName(config))) : undefined;
    (request as any).ownerSession = session;
    (request as any).deviceSession = deviceSession;
    const route = request.url.split('?')[0];
    const publicStatic = publicPages.has(route) || /^\/assets\/[A-Za-z0-9_.-]+$/.test(route);
    if (config.mode === 'owner' && owner.setupPending && !localDesktop && route.startsWith('/api/auth/') && !pendingSetupRoutes.has(route)) throw new AppError('SETUP_REQUIRED', '请先完成首次登录设置', 401);
    if (config.mode === 'owner' && ownerOnlyRoutes.has(route) && !session) throw new AppError('LOGIN_REQUIRED', '请在浏览器中使用所有者账号登录', 401);
    if (config.mode === 'owner' && !publicAuthRoutes.has(route) && !publicStatic && !session && !deviceSession) throw new AppError('LOGIN_REQUIRED', '请先登录你的工作台', 401);
    if (origin && origin !== expected) throw new AppError('INVALID_ORIGIN', '请求来源不受信任', 403);
    const upgrade = request.headers.upgrade?.toLowerCase() === 'websocket';
    if (upgrade && origin !== expected) throw new AppError('INVALID_ORIGIN', '实时连接缺少可信来源', 403);
    if (route.startsWith('/api/auth/') && !['GET', 'HEAD'].includes(request.method) && origin !== expected) throw new AppError('INVALID_ORIGIN', '请从本站页面提交登录操作', 403);
    if (!['GET', 'HEAD'].includes(request.method) || upgrade) {
      const cookie = /(?:^|;\s*)ac_session=([a-f0-9]+)/.exec(request.headers.cookie || '')?.[1];
      if (!equal(cookie) || (!upgrade && !equal(request.headers['x-agent-control-csrf']))) throw new AppError('CSRF_REJECTED', '页面登录已更新，请刷新页面后重试', 403);
    }
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  });
  app.get('/api/session', async (request, reply) => {
    reply.header('Set-Cookie', `ac_session=${csrf}; HttpOnly; SameSite=Strict; Path=/${config.mode !== 'local' && !(request as any).localDesktop ? '; Secure' : ''}`);
    return { csrf, mode: config.mode };
  });
  return { csrf };
}
