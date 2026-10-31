'use strict';
// Isolated Tunnel lifecycle prototype. Not connected to the desktop UI or
// production Tunnel; formal gateway identity and migration remain required.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const { probePort } = require('./gateway-manager.cjs');
const { inspectNativeProcess, stopOwnedTunnel } = require('./native-helper.cjs');
const exec = promisify(execFile);
const HOST = '127.0.0.1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class TunnelError extends Error {}
function safePort(value) { const port = Number(value); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new TunnelError('Tunnel 状态端口无效'); return port; }
function origin(port) { return `http://${HOST}:${port}`; }
async function readReady(port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${origin(port)}/ready`, { signal: AbortSignal.timeout(1200) });
    if (response.status !== 200) return null;
    const body = await response.json();
    return { status: response.status, readyConnections: Number(body.readyConnections || 0), body };
  } catch { return null; }
}
async function freeOrOccupied(port) { return probePort(port); }
function alive(child) { return !!child?.pid && child.exitCode === null && child.signalCode === null; }
function isFile(pathname) { try { return fs.statSync(pathname).isFile(); } catch { return false; } }
class TunnelManager extends EventEmitter {
  constructor(options) {
    super();
    this.dataDir = path.resolve(options.dataDir);
    this.nativePath = path.resolve(options.nativePath || path.join(this.dataDir, 'controller', 'PrivateControlPipe.exe'));
    this.binaryPath = path.resolve(options.binaryPath || path.join(this.dataDir, 'bin', 'cloudflared.exe'));
    this.tokenPath = path.resolve(options.tokenPath || path.join(this.dataDir, 'tunnel-token'));
    this.configPath = path.resolve(options.configPath || path.join(this.dataDir, 'config.json'));
    this.recordPath = path.resolve(options.recordPath || path.join(this.dataDir, 'tunnel.instance.json'));
    this.metricsPort = safePort(options.metricsPort || 20241);
    this.gatewayPort = safePort(options.gatewayPort || 3000);
    this.requireFormalConfig = options.requireFormalConfig !== false;
    this.verifyGateway = options.verifyGateway || (async config => {
      const response = await this.fetchImpl(`http://${HOST}:${this.gatewayPort}/api/session`, { headers: { Host: new URL(config.publicOrigin).host }, signal: AbortSignal.timeout(1500) });
      return response.status === 401;
    });
    this.platform = options.platform || process.platform;
    this.protocol = options.protocol || 'http2';
    this.startTimeoutMs = options.startTimeoutMs || 30000;
    this.stopTimeoutMs = options.stopTimeoutMs || 5000;
    this.commandPrefix = Array.isArray(options.commandPrefix) ? [...options.commandPrefix] : [];
    this.spawnImpl = options.spawnImpl || ((file, args, spawnOptions) => spawn(file, args, spawnOptions));
    this.stopImpl = options.stopProcess || ((file, pid, expected) => stopOwnedTunnel(file, pid, expected));
    this.inspectImpl = options.inspectProcess || ((file, pid, expected) => inspectNativeProcess(file, pid, expected));
    if (this.commandPrefix.length && (!options.spawnImpl || !options.stopProcess || !options.inspectProcess)) throw new TunnelError('测试前缀仅可与隔离测试进程一起使用');
    this.fetchImpl = options.fetchImpl || fetch;
    this.secureTokenImpl = options.secureToken || (async () => this.secureToken());
    this.child = undefined; this.stopping = false; this.queue = Promise.resolve(); this.logs = []; this.lastStartIdentity = undefined;
    const configured = this.isConfigured();
    this.state = { state: this.platform === 'win32' ? (configured ? 'stopped' : 'unconfigured') : 'unsupported', message: this.platform === 'win32' ? (configured ? 'Tunnel 未启动' : 'Tunnel 尚未配置') : '此系统暂不支持本机 Tunnel 管理', metricsOrigin: origin(this.metricsPort), metricsPort: this.metricsPort, pid: null, managed: false, readyConnections: 0, updatedAt: Date.now() };
  }
  isConfigured() { return isFile(this.binaryPath) && isFile(this.tokenPath) && (!this.requireFormalConfig || isFile(this.configPath)); }
  snapshot() { return structuredClone(this.state); }
  emitState(next) { this.state = { ...this.state, ...next, updatedAt: Date.now() }; this.emit('state', this.snapshot()); }
  event(value) { this.logs.push(value); if (this.logs.length > 200) this.logs.shift(); this.emit('log', value); }
  enqueue(fn) { const result = this.queue.then(fn, fn); this.queue = result.then(() => {}, () => {}); return result; }
  start() { return this.enqueue(() => this.startInternal()); }
  stop() { return this.enqueue(() => this.stopInternal()); }
  restart() { return this.enqueue(async () => { const stopped = await this.stopInternal(); return stopped.state === 'stopped' || stopped.state === 'unconfigured' ? this.startInternal() : stopped; }); }
  async secureToken() {
    if (this.platform !== 'win32') return;
    const { stdout } = await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 4096 });
    const sid = stdout.match(/S-1-\d(?:-\d+)+/i)?.[0]; if (!sid) throw new TunnelError('无法确认当前 Windows 用户');
    await exec('icacls.exe', [this.tokenPath, '/inheritance:r', '/grant:r', `*${sid}:(R)`, '*S-1-5-18:(F)'], { windowsHide: true, maxBuffer: 4096 });
  }
  async formalConfig() {
    if (!this.requireFormalConfig) return null;
    let config; try { config = JSON.parse(await fsp.readFile(this.configPath, 'utf8')); } catch { throw new TunnelError('Tunnel 正式网关配置无法读取'); }
    if (!['access', 'owner'].includes(config.mode) || typeof config.publicOrigin !== 'string' || new URL(config.publicOrigin).protocol !== 'https:' || Number(config.port) !== this.gatewayPort) throw new TunnelError('Tunnel 正式网关配置不完整');
    if (config.mode === 'access' && (!config.accessIssuer || !config.accessAudience || !config.allowedEmail)) throw new TunnelError('Cloudflare Access 配置不完整');
    return config;
  }
  async ensureConfig() {
    if (this.platform !== 'win32') throw new TunnelError('此系统暂不支持本机 Tunnel 管理');
    if (!isFile(this.binaryPath)) throw new TunnelError('尚未安装 cloudflared.exe');
    if (!isFile(this.tokenPath)) throw new TunnelError('尚未配置 Tunnel Token 文件');
    const stat = await fsp.stat(this.tokenPath); if (stat.size < 32 || stat.size > 4096) throw new TunnelError('Tunnel Token 文件大小无效');
    const config = await this.formalConfig();
    if (this.requireFormalConfig && !(await this.verifyGateway(config).catch(() => false))) throw new TunnelError('正式网关身份验证未生效，已阻止启动 Tunnel');
    await this.secureTokenImpl();
  }
  args() { return ['tunnel', '--protocol', this.protocol, '--no-autoupdate', 'run', '--metrics', `${HOST}:${this.metricsPort}`, '--token-file', this.tokenPath]; }
  async readRecord() {
    try {
      const record = JSON.parse(await fsp.readFile(this.recordPath, 'utf8'));
      if (record.version !== 1 || !Number.isSafeInteger(record.processId) || record.processId < 1 || typeof record.creation !== 'string' || !/^\d{15,22}$/.test(record.creation) || path.resolve(record.binaryPath || '') !== this.binaryPath || path.resolve(record.tokenPath || '') !== this.tokenPath || Number(record.metricsPort) !== this.metricsPort || record.protocol !== this.protocol) throw new TunnelError('Tunnel 实例记录无效，未接管任何进程');
      return record;
    } catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof TunnelError) throw error; throw new TunnelError('Tunnel 实例记录无法读取'); }
  }
  async inspect(record) {
    return this.inspectImpl(this.nativePath, record.processId, { kind: 'tunnel', binaryPath: this.binaryPath, tokenPath: this.tokenPath, metricsAddress: `${HOST}:${this.metricsPort}`, protocol: this.protocol, commandPrefix: this.commandPrefix });
  }
  async attach(record) {
    const info = await this.inspect(record).catch(() => { throw new TunnelError('无法确认 Tunnel 进程身份，未接管任何进程'); });
    if (path.resolve(info.image).toLowerCase() !== this.binaryPath.toLowerCase() || info.creation !== record.creation || info.argsMatched === false) throw new TunnelError('Tunnel 进程启动参数不匹配，未接管任何进程');
    const ready = await readReady(this.metricsPort, this.fetchImpl);
    if (!ready) throw new TunnelError('Tunnel 监控端点未响应');
    const state = ready.readyConnections > 0 ? 'connected' : 'starting';
    this.emitState({ state, message: state === 'connected' ? 'Tunnel 已连接' : 'Tunnel 连接中', pid: record.processId, managed: true, readyConnections: ready.readyConnections });
    return this.snapshot();
  }
  async waitReady(record) {
    const deadline = Date.now() + this.startTimeoutMs; let last;
    while (Date.now() < deadline) {
      try { const result = await this.attach(record); if (result.state === 'connected') return result; } catch (error) { last = error; }
      await delay(300);
    }
    throw last || new TunnelError('Tunnel 连接超时，请检查网络和 Cloudflare 配置');
  }
  async startInternal() {
    if (this.platform !== 'win32') return this.snapshot();
    if (!this.isConfigured()) { this.emitState({ state: 'unconfigured', message: 'Tunnel 尚未配置', managed: false, pid: null, readyConnections: 0 }); return this.snapshot(); }
    this.emitState({ state: 'starting', message: '正在启动 Tunnel', managed: false, pid: null, readyConnections: 0 });
    let created = false;
    try {
      const existing = await this.readRecord(); if (existing) return await this.attach(existing);
      if (await freeOrOccupied(this.metricsPort) !== 'free') throw new TunnelError(`Tunnel 监控端口 ${this.metricsPort} 已被占用，未接管未知进程`);
      await this.ensureConfig(); await fsp.mkdir(this.dataDir, { recursive: true });
      const record = { version: 1, processId: null, binaryPath: this.binaryPath, tokenPath: this.tokenPath, metricsPort: this.metricsPort, protocol: this.protocol, startedAt: new Date().toISOString() };
      await fsp.writeFile(this.recordPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); created = true;
      const childEnv = { ...process.env };
      for (const key of Object.keys(childEnv)) if (/^TUNNEL_/i.test(key)) delete childEnv[key];
      const child = this.spawnImpl(this.binaryPath, [...this.commandPrefix, ...this.args()], { cwd: this.dataDir, env: childEnv, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('error', () => {});
      this.child = child; if (!child.pid) throw new TunnelError('Tunnel 进程未返回进程标识');
      const identity = await this.inspectImpl(this.nativePath, child.pid, { kind: 'tunnel', binaryPath: this.binaryPath, tokenPath: this.tokenPath, metricsAddress: `${HOST}:${this.metricsPort}`, protocol: this.protocol, commandPrefix: this.commandPrefix });
      if (!identity || path.resolve(identity.image).toLowerCase() !== this.binaryPath.toLowerCase() || !/^\d{15,22}$/.test(identity.creation || '')) throw new TunnelError('无法确认新启动的 Tunnel 进程身份');
      this.lastStartIdentity = { pid: child.pid, creation: identity.creation };
      record.processId = child.pid; record.creation = identity.creation; await fsp.writeFile(this.recordPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      child.once('exit', () => { if (!this.stopping && this.state.managed) { this.event('Tunnel 进程意外退出'); this.emitState({ state: 'error', message: 'Tunnel 进程已退出', managed: false, pid: null }); } });
      child.unref();
      const result = await this.waitReady(record); this.event('Tunnel 已连接'); return result;
    } catch (error) {
      let stopped = !created || !alive(this.child);
      if (created && !stopped && this.lastStartIdentity) {
        this.stopping = true;
        try { await this.stopImpl(this.nativePath, this.lastStartIdentity.pid, { kind: 'tunnel', binaryPath: this.binaryPath, tokenPath: this.tokenPath, metricsAddress: `${HOST}:${this.metricsPort}`, protocol: this.protocol, commandPrefix: this.commandPrefix, creation: this.lastStartIdentity.creation }); stopped = true; } catch {}
      }
      if (created && stopped) { await fsp.rm(this.recordPath, { force: true }).catch(() => {}); this.child = undefined; this.lastStartIdentity = undefined; }
      this.stopping = false;
      this.emitState({ state: this.isConfigured() ? 'error' : 'unconfigured', message: error instanceof TunnelError ? error.message : 'Tunnel 启动失败', managed: created && !stopped, pid: created && !stopped ? this.child?.pid || null : null, readyConnections: 0 }); this.event('Tunnel 启动失败'); return this.snapshot();
    }
  }
  async stopInternal() {
    if (this.platform !== 'win32') return this.snapshot();
    let record;
    try { record = await this.readRecord(); } catch (error) { this.emitState({ state: 'error', message: error.message, managed: false, pid: null }); return this.snapshot(); }
    if (!record) {
      if (!this.isConfigured()) { this.emitState({ state: 'unconfigured', message: 'Tunnel 尚未配置', managed: false, pid: null, readyConnections: 0 }); return this.snapshot(); }
      if (await freeOrOccupied(this.metricsPort) !== 'free') { this.emitState({ state: 'error', message: `Tunnel 监控端口 ${this.metricsPort} 仍被占用，未结束未知进程`, managed: false, pid: null, readyConnections: 0 }); return this.snapshot(); }
      this.emitState({ state: this.isConfigured() ? 'stopped' : 'unconfigured', message: this.isConfigured() ? 'Tunnel 未启动' : 'Tunnel 尚未配置', managed: false, pid: null, readyConnections: 0 }); return this.snapshot();
    }
    this.stopping = true; this.emitState({ state: 'stopping', message: '正在停止 Tunnel', managed: true, pid: record.processId });
    try {
      const info = await this.inspect(record);
      if (info.creation !== record.creation || path.resolve(info.image).toLowerCase() !== this.binaryPath.toLowerCase()) throw new TunnelError('Tunnel 进程身份不匹配，未停止未知进程');
      await this.stopImpl(this.nativePath, record.processId, { kind: 'tunnel', binaryPath: this.binaryPath, tokenPath: this.tokenPath, metricsAddress: `${HOST}:${this.metricsPort}`, protocol: this.protocol, commandPrefix: this.commandPrefix, creation: record.creation });
      await fsp.rm(this.recordPath, { force: true }); this.child = undefined; this.lastStartIdentity = undefined; this.stopping = false; this.event('Tunnel 已停止'); this.emitState({ state: this.isConfigured() ? 'stopped' : 'unconfigured', message: this.isConfigured() ? 'Tunnel 未启动' : 'Tunnel 尚未配置', managed: false, pid: null, readyConnections: 0 });
    } catch (error) { this.stopping = false; this.emitState({ state: 'error', message: error instanceof TunnelError ? error.message : 'Tunnel 停止失败；未强制结束', managed: true, pid: record.processId }); this.event('Tunnel 停止失败'); }
    return this.snapshot();
  }
  refresh() { return this.enqueue(async () => {
    if (this.platform !== 'win32') return this.snapshot();
    if (!this.isConfigured()) { this.emitState({ state: 'unconfigured', message: 'Tunnel 尚未配置', managed: false, pid: null, readyConnections: 0 }); return this.snapshot(); }
    const record = await this.readRecord();
    if (!record) { this.emitState({ state: 'stopped', message: 'Tunnel 未启动', managed: false, pid: null, readyConnections: 0 }); return this.snapshot(); }
    try { return await this.attach(record); } catch (error) { this.emitState({ state: 'error', message: error instanceof TunnelError ? error.message : 'Tunnel 状态无法确认', managed: false, pid: null, readyConnections: 0 }); return this.snapshot(); }
  }); }
  async logsSnapshot() { return { lines: [...this.logs], state: this.snapshot() }; }
  close() { this.removeAllListeners(); }
}
module.exports = { TunnelManager, readReady, origin };
