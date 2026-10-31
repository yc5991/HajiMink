'use strict';
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const codePattern = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
class DeviceTransport {
  constructor(origin, fetchImpl = fetch) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('设备授权只支持所选的 HTTPS 网关');
    this.origin = origin; this.fetch = fetchImpl; this.cookie = ''; this.csrf = '';
  }
  async request(path, payload, signal, extraCookie = '') {
    let response;
    try {
      response = await this.fetch(`${this.origin}${path}`, { method: payload === undefined ? 'GET' : 'POST', redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000), headers: { ...(this.cookie || extraCookie ? { cookie: [this.cookie, extraCookie].filter(Boolean).join('; ') } : {}), ...(payload === undefined ? {} : { origin: this.origin, 'content-type': 'application/json', 'x-agent-control-csrf': this.csrf }) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    } catch { throw new Error('连接网关失败，请检查网络后重试'); }
    if (!response.ok) throw new Error(response.status === 404 ? '网关尚不支持设备授权，或当前登录方式不支持此功能' : `网关未完成请求（HTTP ${response.status}）`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 65536) throw new Error('网关返回的数据过大');
    const reader = response.body?.getReader(); const parts = []; let size = 0;
    if (reader) for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 65536) { await reader.cancel(); throw new Error('网关返回的数据过大'); } parts.push(Buffer.from(part.value)); }
    let data;
    try { data = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new Error('网关返回的数据无效'); }
    return { data, response };
  }
  async bootstrap(signal) {
    const { data, response } = await this.request('/api/auth/bootstrap', undefined, signal);
    if (data.mode !== 'owner' || !/^[a-f0-9]{64}$/.test(data.csrf)) throw new Error('这个网关未启用支持设备授权的独立登录模式');
    const raw = response.headers.getSetCookie();
    const session = raw.map(value => /^ac_session=([a-f0-9]{64});/i.exec(value)?.[1]).find(Boolean);
    const nonce = raw.map(value => /^__Host-ac_auth_nonce=([A-Za-z0-9_-]{43});/.exec(value)?.[1]).find(Boolean);
    if (!session || session !== data.csrf || !nonce) throw new Error('网关登录初始化失败，请检查地址');
    this.csrf = data.csrf; this.cookie = `ac_session=${session}; __Host-ac_auth_nonce=${nonce}`;
  }
  async post(path, payload, signal, extraCookie = '') { return (await this.request(path, payload, signal, extraCookie)).data; }
}
class DeviceFlow {
  constructor({ openBrowser, onState, onGranted, fetchImpl = fetch, now = () => Date.now() }) { this.openBrowser = openBrowser; this.onState = onState; this.onGranted = onGranted; this.fetchImpl = fetchImpl; this.now = now; this.active = null; }
  update(job, state, message, extra = {}) { this.onState({ connectionId: job.item.id, state, message, ...extra }); }
  valid(job) { return this.active === job && !job.controller.signal.aborted; }
  cancel() {
    const job = this.active; if (!job) return;
    this.active = null; clearTimeout(job.timer); job.controller.abort();
    if (job.requestId) void job.transport.post('/api/auth/device/cancel', { requestId: job.requestId }).catch(() => {});
    this.update(job, 'canceled', job.exchanging ? '已取消；授权可能刚刚完成，请在账户页检查并撤销不需要的设备' : '已取消设备授权');
  }
  async start(item) {
    if (!item || item.local || new URL(item.url).protocol !== 'https:') throw new Error('请选择使用 HTTPS 的远程网关');
    this.cancel();
    const job = { item: { ...item }, controller: new AbortController(), transport: new DeviceTransport(item.url, this.fetchImpl), requestId: null, timer: null, expiresAt: 0, interval: 2000 };
    this.active = job; this.update(job, 'requesting', '正在向网关申请连接');
    try {
      await job.transport.bootstrap(job.controller.signal);
      const result = await job.transport.post('/api/auth/device/request', { name: `HajiMink · ${item.name}`.slice(0, 60) }, job.controller.signal);
      if (!tokenPattern.test(result.requestId) || !codePattern.test(result.userCode) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= this.now() || result.expiresAt > this.now() + 6 * 60 * 1000 || result.intervalSeconds !== 2) throw new Error('网关返回的连接请求无效');
      job.requestId = result.requestId; job.expiresAt = result.expiresAt;
      if (!this.valid(job)) { void job.transport.post('/api/auth/device/cancel', { requestId: job.requestId }).catch(() => {}); return; }
      await this.openBrowser(new URL('/device', item.url).href);
      if (!this.valid(job)) return;
      this.update(job, 'pending', '请在打开的系统浏览器中登录并确认设备', { userCode: result.userCode, expiresAt: result.expiresAt });
      job.timer = setTimeout(() => void this.poll(job), job.interval + 100);
    } catch (error) {
      if (this.valid(job)) { this.active = null; if (job.requestId) void job.transport.post('/api/auth/device/cancel', { requestId: job.requestId }).catch(() => {}); this.update(job, 'error', error instanceof Error ? error.message : '设备授权未完成'); }
    }
  }
  async poll(job) {
    if (!this.valid(job)) return;
    if (this.now() >= job.expiresAt) { this.active = null; this.update(job, 'expired', '确认码已过期，请重新申请'); return; }
    try {
      const data = await job.transport.post('/api/auth/device/poll', { requestId: job.requestId }, job.controller.signal);
      if (!this.valid(job)) return;
      if (data.state === 'denied') { this.active = null; this.update(job, 'denied', '浏览器中已拒绝此连接'); return; }
      if (data.state === 'approved') {
        // Never retry an uncertain exchange: it is intentionally one-time.
        job.exchanging = true;
        // Let an in-flight exchange finish after cancellation so a returned token can be revoked.
        const grant = await job.transport.post('/api/auth/device/exchange', { requestId: job.requestId });
        if (!tokenPattern.test(grant.token) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= this.now() || grant.expiresAt > this.now() + 8 * 24 * 60 * 60 * 1000) throw new Error('网关返回的设备凭据无效');
        let saved = false;
        try { if (this.valid(job)) saved = await this.onGranted(job.item, grant, () => this.valid(job)); }
        finally { if (!saved) void job.transport.post('/api/auth/logout', {}, undefined, `__Host-ac_device=${grant.token}`).catch(() => {}); }
        if (!this.valid(job)) return;
        if (!saved) throw new Error('设备授权未完成，请重新申请');
        this.active = null; this.update(job, 'approved', saved === 'protected' ? '已连接，设备凭据受系统保护' : '已连接；系统安全存储不可用，退出应用后需重新授权'); return;
      }
      if (data.state !== 'pending') throw new Error('网关返回了未知的授权状态');
      job.timer = setTimeout(() => void this.poll(job), job.interval + 100);
    } catch (error) {
      if (!this.valid(job)) return;
      this.active = null;
      // Any failed exchange can have succeeded at the server. Do not claim it did not.
      this.update(job, 'error', '连接结果未确认，请返回桌面重新申请；如已授权，可在账户页撤销旧设备');
    }
  }
}
module.exports = { DeviceTransport, DeviceFlow };
