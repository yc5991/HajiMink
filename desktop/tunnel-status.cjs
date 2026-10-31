'use strict';
// This model records only the latest user-initiated HTTPS entry check; it must
// not imply ownership of, or continuous connectivity to, a tunnel process.
const { EventEmitter } = require('node:events');
const { TUNNEL_PROVIDERS } = require('./connections.cjs');

const RESULTS = Object.freeze({
  identified: { state: 'reachable', message: '远程入口有响应；请核对地址并亲自登录验证。' },
  pending: { state: 'reachable', message: '远程入口有响应，正在等待首次登录设置。' },
  restricted: { state: 'restricted', message: '入口要求登录或拒绝访问，请查看下方检查结果。' },
  unsafe: { state: 'unsafe', message: '入口可能未受保护，请关闭转发并检查登录设置。' },
  mismatch: { state: 'error', message: '入口与本机网关的响应不一致，请查看下方检查结果。' },
  unrecognized: { state: 'error', message: '入口响应无法确认，请查看下方检查结果。' },
  unreachable: { state: 'error', message: '入口暂时无法连接，请查看下方检查结果。' },
  stale: { state: 'error', message: '检查期间配置发生变化，请重新检查。' }
});
function contextKey(provider, gateway) {
  return JSON.stringify([provider, gateway?.state, gateway?.managed, gateway?.pid, gateway?.controllerPid, gateway?.port, gateway?.mode, gateway?.publicOrigin, gateway?.setupPending, gateway?.awaitingPublicOrigin, gateway?.streamDiagnostic]);
}
function initialStatus(provider, gateway) {
  if (!provider) return { state: 'unconfigured', message: '请选择连接方式，再按教程配置远程入口。' };
  if (!gateway || gateway.state !== 'ready' || !gateway.managed) return { state: 'waiting', message: '请先启动本机网关，再检查远程入口。' };
  if (gateway.mode !== 'owner') return { state: 'needs-protection', message: '请先启用独立登录或受限首次设置。' };
  if (gateway.awaitingPublicOrigin) return { state: 'needs-address', message: '请先填写服务商提供的真实 HTTPS 地址。' };
  return { state: 'unchecked', message: '尚未检查远程入口；请先确认所选连接方式已运行。' };
}
class ExternalTunnelStatus extends EventEmitter {
  constructor(options = {}) {
    super(); this.now = options.now || Date.now; this.revision = 0; this.key = null; this.gateway = null;
    this.state = { provider: null, management: 'external', state: 'unconfigured', message: '请选择连接方式，再按教程配置远程入口。', checkedAt: null, stream: 'unchecked' };
  }
  snapshot() { return structuredClone(this.state); }
  emitStatus(next) { this.state = { ...this.state, ...next }; this.emit('state', this.snapshot()); }
  setContext(provider, gateway) {
    if (provider !== null && !TUNNEL_PROVIDERS.includes(provider)) throw new Error('连接方式无效');
    const key = contextKey(provider, gateway);
    if (key === this.key) return false;
    this.key = key; this.gateway = gateway ? { ...gateway } : null; this.revision++;
    this.emitStatus({ provider, management: 'external', ...initialStatus(provider, gateway), checkedAt: null, stream: 'unchecked' });
    return true;
  }
  begin() {
    const gateway = this.gateway;
    if (!gateway || gateway.state !== 'ready' || !gateway.managed || gateway.mode !== 'owner' || gateway.awaitingPublicOrigin || !gateway.publicOrigin) throw new Error('请先启动独立登录网关并填写真实 HTTPS 地址');
    const revision = ++this.revision;
    this.emitStatus({ state: 'checking', message: '正在检查远程入口和实时转发。', checkedAt: null, stream: 'unchecked' });
    return revision;
  }
  isCurrent(revision) { return revision === this.revision; }
  finish(revision, result) {
    if (!this.isCurrent(revision)) return false;
    let status = Object.hasOwn(RESULTS, result?.state) ? RESULTS[result.state] : RESULTS.unrecognized;
    const webpageConfirmed = ['identified', 'pending'].includes(result?.state);
    const stream = webpageConfirmed && ['passed', 'failed'].includes(result?.stream) ? result.stream : 'unchecked';
    if (webpageConfirmed) {
      status = stream === 'passed' ? { state: 'reachable', message: '网页入口有响应，一次实时双向检查通过。请核对地址并亲自登录。' }
        : stream === 'failed' ? { state: 'partial', message: '网页入口有响应，实时连接未通过检查。请查看下方检查结果。' }
        : { state: 'partial', message: '网页入口有响应，实时连接本次未检查。请登录后验证。' };
    }
    this.revision++;
    this.emitStatus({ ...status, stream, checkedAt: this.now() });
    return true;
  }
  close() { this.revision++; this.removeAllListeners(); }
}
module.exports = { ExternalTunnelStatus };
