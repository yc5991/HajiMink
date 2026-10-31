'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isIP } = require('node:net');
const { validateSettings } = require('./natapp-manager.cjs');
const { PROVIDERS, TUNNEL_PROVIDERS, providerGuide } = require('./providers.cjs');

function normalizeAddress(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length > 2048 || /[\s\u0000-\u001f\u007f\\]/.test(raw)) throw new Error('请输入有效的网关地址或服务器 IP');
  // Bare IPs and hostnames describe HTTPS gateways, not an automatically created tunnel.
  const candidate = isIP(raw) === 6 ? `https://[${raw}]` : /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try { url = new URL(candidate); } catch { throw new Error('请输入有效的网关地址或服务器 IP'); }
  const loopback = ['localhost', '127.0.0.1'].includes(url.hostname.toLowerCase());
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('地址不能包含账号、路径、查询参数或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('远程连接必须使用 HTTPS；只有本机地址可以使用 HTTP');
  return url.origin;
}

function normalizeConnection(input) {
  if (!input || typeof input !== 'object') throw new Error('请输入连接名称和地址');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('连接名称应为 1 至 40 个字符');
  const provider = input.provider === undefined ? 'other' : input.provider;
  if (typeof provider !== 'string' || !PROVIDERS.includes(provider)) throw new Error('请选择有效的连接方式');
  return { name, url: normalizeAddress(input.url), provider };
}

function allowedViewRequest(requestUrl, gatewayUrl) {
  try {
    const request = new URL(requestUrl); const gateway = new URL(gatewayUrl);
    if (request.protocol === 'data:') return true;
    if (request.protocol === 'blob:') return request.origin === gateway.origin;
    const equivalent = (gateway.protocol === 'https:' && request.protocol === 'wss:') || (gateway.protocol === 'http:' && request.protocol === 'ws:');
    return (request.protocol === gateway.protocol || equivalent) && request.host === gateway.host && !request.username && !request.password;
  } catch { return false; }
}

function normalizeExitResume(value) {
  if (value === null || value === undefined) return null;
  if (!value || value.version !== 1 || !['pending', 'complete'].includes(value.phase) || typeof value.gateway !== 'boolean') throw new Error('服务恢复记录无效，请检查连接配置');
  let natapp = null;
  if (value.natapp !== null) {
    const settings = validateSettings({ version: 1, ...value.natapp });
    natapp = { binaryPath: settings.binaryPath, configPath: settings.configPath };
  }
  return { version: 1, phase: value.phase, gateway: value.gateway, natapp };
}

class ConnectionStore {
  constructor(directory, platform = process.platform, localPort = 3000) {
    this.file = path.join(directory, 'connections.json');
    this.platform = platform;
    this.state = { version: 1, theme: 'system', selected: null, connections: [], setup: { complete: platform !== 'win32', tunnelProvider: null, gatewayManuallyStopped: false }, exitResume: null };
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw.version !== 1 || !Array.isArray(raw.connections) || raw.connections.length > 100) throw new Error('连接配置格式无效');
      if (raw.theme !== undefined && !['system', 'light', 'dark'].includes(raw.theme)) throw new Error('界面主题设置无效');
      this.state.theme = raw.theme || 'system';
      if (raw.setup !== undefined && (!raw.setup || typeof raw.setup.complete !== 'boolean' || (raw.setup.tunnelProvider !== undefined && raw.setup.tunnelProvider !== null && !TUNNEL_PROVIDERS.includes(raw.setup.tunnelProvider)) || (raw.setup.gatewayManuallyStopped !== undefined && typeof raw.setup.gatewayManuallyStopped !== 'boolean'))) throw new Error('首次设置状态无效');
      // Existing v1 profiles predate onboarding and keep their prior startup behavior.
      if (raw.setup?.remoteDisabled !== undefined && typeof raw.setup.remoteDisabled !== 'boolean') throw new Error('远程访问设置无效');
      this.state.setup = { complete: raw.setup === undefined ? true : raw.setup.complete, tunnelProvider: raw.setup?.tunnelProvider || null, gatewayManuallyStopped: raw.setup?.gatewayManuallyStopped ?? false, ...(raw.setup?.remoteDisabled ? { remoteDisabled: true } : {}) };
      this.state.exitResume = normalizeExitResume(raw.exitResume);
      const ids = new Set();
      this.state.connections = raw.connections.map(item => {
        if (typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/.test(item.id) || ids.has(item.id)) throw new Error('连接配置标识无效');
        ids.add(item.id);
        return { id: item.id, ...normalizeConnection(item), local: item.local === true };
      });
      if (raw.selected !== null && !ids.has(raw.selected)) throw new Error('连接配置选择无效');
      this.state.selected = raw.selected;
    } else if (platform === 'win32') {
      const port = Number(localPort);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本机连接端口无效');
      const local = { id: randomUUID(), ...normalizeConnection({ name: '本机', url: `http://127.0.0.1:${port}` }), local: true };
      this.state.connections.push(local);
      this.state.selected = local.id;
      this.save();
    }
  }
  snapshot() { return structuredClone(this.state); }
  setTheme(value) {
    if (!['system', 'light', 'dark'].includes(value)) throw new Error('界面主题设置无效');
    const previous = this.state.theme;
    if (previous === value) return this.snapshot();
    this.state.theme = value;
    try { this.save(); } catch (error) { this.state.theme = previous; throw error; }
    return this.snapshot();
  }
  localPort() {
    const locals = this.state.connections.filter(item => item.local);
    if (!locals.length) return null;
    if (locals.length !== 1) throw new Error('本机连接配置不唯一，请检查连接设置');
    const url = new URL(locals[0].url);
    const port = Number(url.port);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本机连接地址无效，请检查连接设置');
    return port;
  }
  setTunnelProvider(value) {
    if (value !== null && !TUNNEL_PROVIDERS.includes(value)) throw new Error('请选择有效的隧道方式');
    const previous = this.snapshot();
    if (this.state.setup.tunnelProvider !== value && this.state.exitResume) this.state.exitResume.natapp = null;
    this.state.setup.tunnelProvider = value;
    delete this.state.setup.remoteDisabled;
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    return this.snapshot();
  }
  disableRemote() {
    const previous = this.snapshot();
    this.state.setup.tunnelProvider = null;
    this.state.setup.remoteDisabled = true;
    if (this.state.exitResume) this.state.exitResume.natapp = null;
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    return this.snapshot();
  }
  setGatewayManuallyStopped(value) {
    if (typeof value !== 'boolean') throw new Error('本机网关停止状态无效');
    const previous = this.snapshot();
    if (previous.setup.gatewayManuallyStopped === value && !previous.exitResume) return previous;
    this.state.setup.gatewayManuallyStopped = value;
    this.state.exitResume = null;
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    return this.snapshot();
  }
  setExitResume(value) {
    const previous = this.snapshot();
    this.state.exitResume = normalizeExitResume(value);
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    return this.snapshot();
  }
  clearNatappResume() {
    if (!this.state.exitResume?.natapp) return this.snapshot();
    const previous = this.snapshot();
    this.state.exitResume.natapp = null;
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    return this.snapshot();
  }
  completeSetup() {
    if (this.state.setup.complete) return this.snapshot();
    this.state.setup.complete = true;
    try { this.save(); } catch (error) { this.state.setup.complete = false; throw error; }
    return this.snapshot();
  }
  setLocalPort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口应为 1024 到 65535 之间的整数');
    if (this.localPort() === null) throw new Error('请先创建本机连接');
    const local = this.state.connections.find(item => item.local);
    const previous = this.snapshot();
    local.url = normalizeAddress(`http://127.0.0.1:${port}`);
    this.state.exitResume = null;
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    return this.snapshot();
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, this.file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  add(input) {
    if (this.state.connections.length >= 100) throw new Error('连接数量已达上限');
    const connection = { id: randomUUID(), ...normalizeConnection(input), local: false };
    const previous = this.snapshot();
    this.state.connections.push(connection); this.state.selected = connection.id;
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    return this.snapshot();
  }
  edit(id, input) {
    const connection = this.state.connections.find(item => item.id === id);
    if (!connection) throw new Error('连接不存在');
    const normalized = normalizeConnection({ ...input, provider: input?.provider ?? connection.provider });
    if (connection.local && normalized.url !== connection.url) throw new Error('本机连接地址由网关端口决定，不能在这里修改');
    const previous = this.snapshot(); Object.assign(connection, normalized);
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    return this.snapshot();
  }
  remove(id) {
    const index = this.state.connections.findIndex(item => item.id === id);
    if (index < 0) throw new Error('连接不存在');
    const previous = this.snapshot(); this.state.connections.splice(index, 1);
    if (this.state.selected === id) this.state.selected = this.state.connections[0]?.id || null;
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    return this.snapshot();
  }
  select(id) {
    if (!this.state.connections.some(item => item.id === id)) throw new Error('连接不存在');
    const previous = this.state.selected; this.state.selected = id;
    try { this.save(); } catch (error) { this.state.selected = previous; throw error; }
    return this.snapshot();
  }
}
module.exports = { ConnectionStore, normalizeAddress, normalizeConnection, allowedViewRequest, providerGuide, PROVIDERS, TUNNEL_PROVIDERS };
