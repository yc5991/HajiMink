'use strict';
// Probe only an explicitly entered origin. Never send login credentials or follow redirects.
const { normalizeAddress } = require('./connections.cjs');
const { timingSafeEqual, randomBytes } = require('node:crypto');
const { readBootstrap } = require('./gateway-manager.cjs');
const MAX_BODY_BYTES = 16 * 1024;

async function readSmallJson(response) {
  const type = response.headers.get('content-type') || '';
  const length = response.headers.get('content-length');
  if (!/^application\/json\b/i.test(type) || (length && Number(length) > MAX_BODY_BYTES) || !response.body) return null;
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) return null;
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return null; }
  finally { reader.cancel().catch(() => {}); }
}

async function probeConnection(input, options = {}) {
  const origin = normalizeAddress(input?.url);
  if (options.publicDraft && new URL(origin).protocol !== 'https:') throw new Error('远程入口检查需要 HTTPS 地址');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs || 5000);
  try {
    const fetchImpl = options.fetchImpl || fetch;
    const response = await fetchImpl(new URL('/api/auth/bootstrap', origin), {
      method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal, headers: { accept: 'application/json' }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) return { state: 'restricted', message: '服务器要求跳转或额外登录，请先在系统浏览器中检查。' };
    if (response.status === 401 || response.status === 403) {
      const body = await readSmallJson(response);
      if (timedOut) return { state: 'unreachable', message: '连接超时，请检查地址、端口和网络。' };
      return { state: 'restricted', message: blockedMessage(body, '服务需要额外登录或拒绝访问，请先在系统浏览器中检查。') };
    }
    if (response.status !== 200) return { state: 'unrecognized', message: `服务器返回 HTTP ${response.status}，请检查网关和隧道状态。` };
    const body = await readSmallJson(response);
    if (timedOut) return { state: 'unreachable', message: '连接超时，请检查地址、端口和网络。' };
    if (body && ['local', 'owner', 'access'].includes(body.mode) && typeof body.authenticated === 'boolean' && typeof body.csrf === 'string' && body.csrf.length >= 16 && body.csrf.length <= 256) {
      if (options.publicDraft) {
        if (body.mode === 'local' || (body.mode === 'owner' && body.authenticated)) return { state: 'unsafe', message: '入口可能未受登录保护，请立即关闭转发并检查网关设置。' };
        if (body.mode === 'access') return { state: 'restricted', message: '入口使用外部登录保护，请在浏览器中确认访问策略。' };
        return { state: 'identified', message: '入口有响应；尚未确认它属于本机网关或受正确保护。保存地址并启用登录后可再次检测。' };
      }
      return { state: 'identified', message: '已识别网关登录接口。请核对地址，并在连接后完成登录或设备授权。' };
    }
    return { state: 'unrecognized', message: '服务器已响应，但未识别到网关登录接口，请检查地址。' };
  } catch {
    return { state: 'unreachable', message: timedOut ? '连接超时，请检查地址、端口和网络。' : '无法连接，请检查地址、端口和 HTTPS 证书。' };
  } finally { clearTimeout(timer); controller.abort(); }
}
// Explicitly initiated by the owner after configuring their own public origin.
// This is an anonymous, same-origin reachability check, not server identity verification.
function publicProbeTarget(input, gateway) {
  const target = normalizeAddress(input?.url);
  if (new URL(target).protocol !== 'https:') throw new Error('远程入口检查需要 HTTPS 地址');
  if (!gateway || gateway.mode !== 'owner' || gateway.state !== 'ready' || !gateway.managed || !gateway.publicOrigin) throw new Error('请先启动并确认独立登录网关');
  if (!Number.isInteger(gateway.port) || gateway.port < 1024 || gateway.port > 65535) throw new Error('本机网关端口无效，请检查网关状态');
  if (target !== normalizeAddress(gateway.publicOrigin)) throw new Error('地址与当前网关配置不一致，请先保存访问地址');
  return target;
}
function discard(response) { try { response?.body?.cancel().catch(() => {}); } catch {} }
function safeGatewayErrorCode(body) {
  const code = body?.error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,48}$/.test(code) ? code : null;
}
function blockedMessage(body, fallback) {
  switch (safeGatewayErrorCode(body)) {
    case 'INVALID_HOST': return '入口提示访问地址不匹配。请检查最终 HTTPS 地址、服务商绑定域名，以及转发是否保留外部 Host。';
    case 'LOCAL_ONLY': return '入口提示网关处于本机模式。请检查登录设置，启用独立登录后再开放隧道。';
    case 'LOGIN_REQUIRED':
    case 'ACCESS_DENIED': return '入口提示需要登录或访问被拒绝。请在系统浏览器中核对登录和服务商访问策略。';
    default: return fallback;
  }
}
async function probePublicGateway(input, gateway, options = {}) {
  const origin = publicProbeTarget(input, gateway);
  const controller = new AbortController(); let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs || 8000);
  const fetchImpl = options.fetchImpl || fetch;
  const get = pathname => fetchImpl(new URL(pathname, origin), { method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal, headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
  try {
    const response = await get('/api/auth/bootstrap');
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      discard(response); return { state: 'restricted', message: '入口要求额外登录或跳转。请在浏览器检查服务商登录、域名和隧道设置。' };
    }
    if ([401, 403].includes(response.status)) {
      const body = await readSmallJson(response);
      if (timedOut) return { state: 'unreachable', message: '检查超时，请确认隧道已启动并连接网络。' };
      return { state: 'restricted', message: blockedMessage(body, '入口要求登录或拒绝访问。请检查服务商登录、域名和隧道设置。') };
    }
    if (response.status !== 200) { const status = response.status; discard(response); return { state: 'unrecognized', message: `入口返回 HTTP ${status}，请检查地址和隧道状态。` }; }
    const body = await readSmallJson(response);
    if (timedOut) return { state: 'unreachable', message: '检查超时，请确认隧道已启动并连接网络。' };
    if (!body || !['local', 'owner', 'access'].includes(body.mode) || typeof body.authenticated !== 'boolean' || typeof body.csrf !== 'string' || body.csrf.length < 16 || body.csrf.length > 256)
      return { state: 'unrecognized', message: '入口已响应，但未识别到网关登录接口。请检查地址及服务商配置。' };
    if (body.mode === 'local' || (body.mode === 'owner' && body.authenticated))
      return { state: 'unsafe', message: '入口返回了未受预期登录限制的状态。请立即关闭转发，并检查网关模式与访问保护。' };
    if (body.mode !== 'owner') return { state: 'restricted', message: '入口使用外部登录保护，匿名检查无法确认其策略；请在浏览器核对登录流程。' };
    if (typeof body.configured !== 'boolean' || typeof body.setupPending !== 'boolean' || (!body.configured && body.setupPending !== true))
      return { state: 'unrecognized', message: '入口登录状态不完整，请检查网关配置。' };
    for (const pathname of ['/api/session', '/api/projects', '/api/threads']) {
      const business = await get(pathname); const status = business.status; discard(business);
      if (status >= 200 && status < 300) return { state: 'unsafe', message: '未登录请求收到了业务接口的成功响应。请立即关闭转发并检查登录保护。' };
      if (status !== 401) return { state: 'unrecognized', message: `业务接口返回 HTTP ${status}，无法确认登录限制；请检查转发和登录配置。` };
    }
    // Compare ephemeral bootstrap values with the authenticated manager's own
    // loopback gateway. This catches common misroutes, not a malicious relay:
    // both responses are public and neither proves ownership of the origin.
    if (!/^[a-f0-9]{64}$/.test(body.csrf)) return { state: 'unrecognized', message: '入口响应不完整，请检查访问地址和网关版本。' };
    let local;
    try {
      // readBootstrap uses a bounded loopback HTTP request with the explicitly
      // configured Host. Node fetch can silently replace that Host header.
      local = await (options.readLocalBootstrap || readBootstrap)(gateway.port, { mode: 'owner', publicOrigin: origin }, { signal: controller.signal });
    } catch {
      if (timedOut) return { state: 'unreachable', message: '检查超时，请确认隧道已启动并连接网络。' };
      return { state: 'unrecognized', message: '无法读取本机网关状态，请检查网关后重试。' };
    }
    if (timedOut) return { state: 'unreachable', message: '检查超时，请确认隧道已启动并连接网络。' };
    if (!local || local.mode !== 'owner' || local.authenticated !== false || typeof local.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(local.csrf) || typeof local.configured !== 'boolean' || typeof local.setupPending !== 'boolean')
      return { state: 'unrecognized', message: '无法确认本机网关状态，请检查网关后重试。' };
    if (!timingSafeEqual(Buffer.from(body.csrf, 'hex'), Buffer.from(local.csrf, 'hex')) || local.configured !== body.configured || local.setupPending !== body.setupPending)
      return { state: 'mismatch', message: '远程入口与本机网关的响应不一致。请检查访问地址、隧道目标和网关状态。' };
    return body.setupPending && !body.configured
      ? { state: 'pending', message: '已识别待设置页面，远程与本机响应一致，未登录的项目和会话接口返回拒绝。请核对地址并继续完成首次登录设置。' }
      : { state: 'identified', message: '已识别独立登录页面，远程与本机响应一致，未登录的项目和会话接口返回拒绝。请核对地址后尝试登录。' };
  } catch {
    return { state: 'unreachable', message: timedOut ? '检查超时，请确认隧道已启动并连接网络。' : '无法完成检查，请确认地址、隧道和 HTTPS 证书。' };
  } finally { clearTimeout(timer); controller.abort(); }
}
// Uses an isolated one-use diagnostic ticket, never login cookies or business
// credentials. The header can be removed by an intermediary, so failure is
// reported as unconfirmed rather than proof that all WebSocket traffic fails.
async function probePublicStream(origin, ticket, options = {}) {
  origin = normalizeAddress(origin);
  if (new URL(origin).protocol !== 'https:' || !ticket || typeof ticket.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket.token) || !Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt <= Date.now()) return false;
  const WebSocket = options.WebSocket || require('ws');
  const nonce = randomBytes(16).toString('hex');
  return new Promise(resolve => {
    let socket, settled = false;
    const timer = setTimeout(() => finish(false), options.timeoutMs || 5000);
    function finish(ok) {
      if (settled) return; settled = true; clearTimeout(timer);
      try { socket?.terminate(); } catch {}
      resolve(ok);
    }
    try {
      const url = new URL('/api/diagnostics/stream', origin); url.protocol = 'wss:';
      socket = new WebSocket(url, { headers: { origin, 'x-hajimink-diagnostic': ticket.token }, handshakeTimeout: options.timeoutMs || 5000, followRedirects: false, perMessageDeflate: false, maxPayload: 1024 });
      socket.on('error', () => finish(false));
      socket.once('close', () => finish(false));
      socket.once('open', () => { try { socket.send(JSON.stringify({ type: 'ping', nonce })); } catch { finish(false); } });
      socket.once('message', (data, binary) => {
        try {
          if (binary || data.length > 128) return finish(false);
          const message = JSON.parse(data.toString());
          finish(!!message && Object.keys(message).sort().join(',') === 'nonce,type' && message.type === 'pong' && message.nonce === nonce);
        } catch { finish(false); }
      });
    } catch { finish(false); }
  });
}
async function completePublicDiagnostic(result, supported, diagnose) {
  if (!['identified', 'pending'].includes(result?.state)) return result;
  let stream = 'unchecked';
  if (supported === true) {
    try { stream = await diagnose() ? 'passed' : 'failed'; } catch { stream = 'unchecked'; }
  }
  const detail = stream === 'passed' ? '实时连接：一次双向检查通过。' : stream === 'failed' ? '实时连接：未通过检查。请确认 WebSocket 转发及服务商是否保留诊断请求头，再登录验证。' : '实时连接：本次未检查，请登录后验证；如网关版本较旧，可重启更新后的网关。';
  return { ...result, stream, message: `${result.message} ${detail}` };
}
module.exports = { probeConnection, probePublicGateway, probePublicStream, completePublicDiagnostic, publicProbeTarget, readSmallJson };
