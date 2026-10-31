'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { randomUUID, randomBytes } = require('node:crypto');
const { normalizeDesktopStatus } = require('./desktop-status.cjs');

const LOCAL_HOST = '127.0.0.1';
const MAX_LOG_LINES = 200;
class GatewayError extends Error {}
function safePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new GatewayError('本机网关端口无效');
  return port;
}
function localOrigin(port) { return `http://${LOCAL_HOST}:${port}`; }
function normalizeOwnerOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f\u007f\\]/.test(value)) throw new GatewayError('请输入有效的 HTTPS 网关地址');
  let url;
  try { url = new URL(value); } catch { throw new GatewayError('请输入有效的 HTTPS 网关地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new GatewayError('远程访问地址必须是没有账号、路径或参数的 HTTPS 地址');
  return url.origin;
}
// A local HTTP request with an explicit Host is needed for owner mode. Node's
// fetch may replace Host with the loopback address, so use http.request instead.
function localRequest(port, pathname, host, options = {}) {
  return new Promise(resolve => {
    let settled = false, total = 0; const chunks = [];
    const request = http.request({ hostname: LOCAL_HOST, port, path: pathname, method: 'GET', headers: host ? { host } : {}, agent: false, ...(options.signal ? { signal: options.signal } : {}) }, response => {
      response.on('data', chunk => {
        total += chunk.length;
        if (total > 8192) { response.destroy(); finish(null); }
        else chunks.push(chunk);
      });
      response.once('error', () => finish(null));
      response.once('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        finish({ status: response.statusCode, body });
      });
    });
    const timer = setTimeout(() => { request.destroy(); finish(null); }, 1500); timer.unref();
    function finish(value) { if (settled) return; settled = true; clearTimeout(timer); resolve(value); }
    request.once('error', () => finish(null)); request.end();
  });
}
async function readBootstrap(port, config = { mode: 'local' }, options = {}) {
  try {
    const host = config.mode === 'owner' ? new URL(normalizeOwnerOrigin(config.publicOrigin)).host : undefined;
    const response = await localRequest(port, '/api/auth/bootstrap', host, options);
    const body = response?.body;
    return response?.status === 200 && body && body.mode === config.mode && typeof body.configured === 'boolean' && typeof body.passwordEnabled === 'boolean' ? body : null;
  } catch { return null; }
}
async function readHealth(port, config = { mode: 'local' }) {
  try {
    if (config.mode === 'owner') {
      const origin = normalizeOwnerOrigin(config.publicOrigin);
      const bootstrap = await readBootstrap(port, { mode: 'owner', publicOrigin: origin });
      if (!bootstrap || (!bootstrap.configured && bootstrap.setupPending !== true)) return null;
      const response = await localRequest(port, '/api/session', new URL(origin).host);
      if (response?.status !== 401) return null;
      return { ok: true, mode: 'owner', publicOrigin: origin, ...(!bootstrap.configured ? { setupPending: true } : {}) };
    }
    if (config.mode !== 'local') return null;
    const response = await localRequest(port, '/api/health');
    return response?.status === 200 ? response.body : null;
  } catch { return null; }
}
async function writeGatewayConfig(file, config) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fsp.rename(temp, file);
  } finally { await fsp.rm(temp, { force: true }).catch(() => {}); }
}
// Bind the actual address instead of trusting an HTTP response. Release before
// spawn; the child's private ready message confirms it won that remaining race.
async function probePort(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', error => resolve(error.code === 'EADDRINUSE' || error.code === 'EACCES' ? 'occupied' : 'unavailable'));
    server.listen({ host: LOCAL_HOST, port, exclusive: true }, () => server.close(() => resolve('free')));
  });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const isAlive = child => !!child?.pid && child.exitCode === null && child.signalCode === null;

class GatewayManager extends EventEmitter {
  constructor(options) {
    super();
    this.appRoot = path.resolve(options.appRoot);
    this.dataDir = path.resolve(options.dataDir);
    this.port = safePort(options.port || 3000);
    this.entryPath = path.resolve(options.entryPath || path.join(this.appRoot, 'dist-server', 'index.js'));
    this.nodePath = options.nodePath || process.execPath;
    this.runAsNode = options.runAsNode ?? !!process.versions.electron;
    this.platform = options.platform || process.platform;
    this.startTimeoutMs = options.startTimeoutMs || 30000;
    this.stopTimeoutMs = options.stopTimeoutMs || 5000;
    this.configPath = path.join(this.dataDir, 'config.json');
    this.lockPath = path.join(this.dataDir, 'gateway.instance.lock');
    this.child = undefined;
    this.lockId = undefined;
    this.lockCleanup = undefined;
    this.stopping = false;
    this.queue = Promise.resolve();
    this.logs = [];
    this.state = { state: this.platform === 'win32' ? 'stopped' : 'unsupported', message: this.platform === 'win32' ? '本机网关未启动' : '本机 Agent 接入暂不支持此系统，请连接远程网关', port: this.port, origin: localOrigin(this.port), pid: null, managed: false, updatedAt: Date.now() };
  }
  snapshot() { return structuredClone(this.state); }
  emitState(next) {
    this.state = { ...this.state, ...next, updatedAt: Date.now() };
    // Never retain a successful desktop status after the owning gateway stops or fails.
    if (next.state && next.state !== 'ready') { this.state.desktop = null; this.state.streamDiagnostic = false; }
    this.emit('state', this.snapshot());
  }
  recordEvent(value) {
    // Only fixed lifecycle messages, never child output, request data or errors.
    this.logs.push(value);
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    this.emit('log', value);
  }
  async ensureConfig() {
    if (!fs.existsSync(this.entryPath)) throw new GatewayError('找不到隔离的网关构建，请先准备桌面运行环境');
    await fsp.mkdir(this.dataDir, { recursive: true });
    if (fs.existsSync(this.configPath)) {
      let config;
      try { config = JSON.parse(await fsp.readFile(this.configPath, 'utf8')); } catch { throw new GatewayError('本机网关配置文件无法读取'); }
      const savedPort = Number(config.port);
      if (!Number.isInteger(savedPort) || savedPort < 1024 || savedPort > 65535) throw new GatewayError('网关配置中的端口无效，未修改配置');
      let canonicalOrigin = config.publicOrigin;
      if (config.mode === 'local') {
        if (config.publicOrigin !== localOrigin(savedPort)) throw new GatewayError('本机网关配置不一致，未修改配置');
      } else if (config.mode === 'owner') {
        try { canonicalOrigin = normalizeOwnerOrigin(config.publicOrigin); } catch { throw new GatewayError('远程网关地址无效，未修改配置'); }
      } else throw new GatewayError('网关登录模式不受支持，未修改配置');
      // Reconcile only known local/owner modes while holding gateway.instance.lock.
      if (savedPort !== this.port || canonicalOrigin !== config.publicOrigin) {
        config = { ...config, port: this.port, publicOrigin: config.mode === 'local' ? localOrigin(this.port) : canonicalOrigin };
        await writeGatewayConfig(this.configPath, config);
      }
      return config;
    }
    const config = { mode: 'local', port: this.port, publicOrigin: localOrigin(this.port) };
    await writeGatewayConfig(this.configPath, config);
    return config;
  }
  async acquireLock() {
    const id = randomUUID();
    try { await fsp.writeFile(this.lockPath, JSON.stringify({ id }) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new GatewayError('此数据目录已有网关实例记录，暂不能安全接管；请先核查原进程');
      throw new GatewayError('无法为本机网关创建实例记录');
    }
    this.lockId = id;
    return id;
  }
  async releaseLock(id) {
    if (!id) return;
    try {
      const record = JSON.parse(await fsp.readFile(this.lockPath, 'utf8'));
      if (record.id === id) await fsp.unlink(this.lockPath);
    } catch {}
    if (this.lockId === id) this.lockId = undefined;
  }
  enqueue(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  start() { return this.enqueue(() => this.startInternal()); }
  stop() { return this.enqueue(() => this.stopInternal()); }
  restart() { return this.enqueue(async () => { const stopped = await this.stopInternal(); return stopped.managed || stopped.state === 'unsupported' ? stopped : this.startInternal(); }); }
  async startInternal() {
    if (this.platform !== 'win32') return this.snapshot();
    if (this.state.state === 'ready' && isAlive(this.child)) return this.snapshot();
    if (isAlive(this.child)) {
      this.emitState({ state: 'error', message: '本窗口启动的网关尚未停止，请先停止后再试', managed: true });
      return this.snapshot();
    }
    this.stopping = false;
    this.emitState({ state: 'starting', message: '正在启动本机网关', managed: false, pid: null });
    let lockId;
    try {
      const portState = await probePort(this.port);
      if (portState === 'occupied') throw new GatewayError(`端口 ${this.port} 已被占用，无法确认现有进程身份；不会结束或自动连接该进程`);
      if (portState !== 'free') throw new GatewayError('无法检查本机网关端口');
      await fsp.mkdir(this.dataDir, { recursive: true });
      lockId = await this.acquireLock();
      const config = await this.ensureConfig();
      const env = { ...process.env, AGENT_CONTROL_PORT: String(this.port), ELECTRON_NO_ATTACH_CONSOLE: '1' };
      delete env.NODE_OPTIONS; delete env.NODE_PATH;
      if (this.runAsNode) env.ELECTRON_RUN_AS_NODE = '1'; else delete env.ELECTRON_RUN_AS_NODE;
      this.lockCleanup = undefined;
      const child = spawn(this.nodePath, [this.entryPath, '--config', this.configPath, '--data-dir', this.dataDir], {
        cwd: this.appRoot, env, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      });
      this.child = child;
      // The child pipe belongs to this exact gateway process. No HTTP authentication
      // is bypassed and stale messages from a previous process are ignored.
      child.on('message', value => {
        if (this.child !== child || this.stopping || !['starting', 'ready'].includes(this.state.state) || value?.type !== 'hajimink:desktop-status') return;
        const desktop = normalizeDesktopStatus(value.desktop);
        if (JSON.stringify(this.state.desktop || null) !== JSON.stringify(desktop)) this.emitState({ desktop });
      });
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new GatewayError('网关启动超时，未确认本窗口启动的实例')), this.startTimeoutMs);
        const finish = (error, capabilities) => {
          clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError);
          if (error) reject(error); else resolve(capabilities);
        };
        const onMessage = value => { if (value?.type === 'hajimink:gateway-ready' && value.port === this.port && value.mode === config.mode) finish(null, { streamDiagnostic: value.streamDiagnostic === true }); };
        const onExit = () => finish(new GatewayError('本机网关进程在启动时退出'));
        const onError = () => finish(new GatewayError('无法启动本机网关进程'));
        child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError);
      });
      child.on('error', () => {}); // The startup promise records this without exposing OS messages.
      child.once('exit', () => {
        this.lockCleanup = this.releaseLock(lockId);
        if (this.child === child && !this.stopping && ['ready', 'error'].includes(this.state.state)) {
          this.recordEvent('本机网关进程意外退出');
          this.emitState({ state: 'error', message: '本机网关进程已退出', managed: false, pid: null });
        }
      });
      child.unref();
      child.channel?.unref();
      const capabilities = await ready;
      const health = await readHealth(this.port, config);
      if (!health?.ok || health.mode !== config.mode || child.exitCode !== null || child.signalCode !== null || !child.connected) throw new GatewayError('本机网关身份或健康检查未通过');
      this.recordEvent('本机网关已启动');
      this.emitState({ state: 'ready', message: config.mode === 'owner' ? (health.setupPending ? '等待完成通行密钥首次设置' : '网关已启用独立登录') : '本机网关已运行', managed: true, pid: child.pid, mode: config.mode, publicOrigin: config.publicOrigin, setupPending: !!health.setupPending, streamDiagnostic: config.mode === 'owner' && capabilities.streamDiagnostic });
      return this.snapshot();
    } catch (error) {
      if (isAlive(this.child)) await this.shutdownChild();
      const live = isAlive(this.child);
      if (!live) {
        if (this.child?.pid) await this.lockCleanup; else await this.releaseLock(lockId);
        this.child = undefined;
      }
      const message = error instanceof GatewayError ? error.message : '本机网关启动失败，请检查运行环境和数据目录';
      this.recordEvent('本机网关启动失败');
      this.emitState({ state: 'error', message: live ? `${message}；实例尚未退出，请检查后停止` : message, managed: live, pid: live ? this.child.pid : null });
      return this.snapshot();
    }
  }
  streamTicket() { return this.enqueue(() => this.streamTicketInternal()); }
  async streamTicketInternal() {
    const child = this.child;
    if (this.state.state !== 'ready' || !this.state.managed || this.state.mode !== 'owner' || !this.state.streamDiagnostic || !isAlive(child) || !child.connected) throw new GatewayError('网关不支持实时诊断');
    const requestId = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return; settled = true; clearTimeout(timer);
        child.off('message', onMessage); child.off('exit', onExit);
        if (value) resolve(value); else reject(new GatewayError('无法准备实时诊断'));
      };
      const onMessage = value => {
        if (value?.type !== 'hajimink:stream-diagnostic-result' || value.requestId !== requestId) return;
        if (this.child !== child || this.state.state !== 'ready' || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 25000) return finish();
        finish({ token: value.token, expiresAt: value.expiresAt });
      };
      const onExit = () => finish();
      const timer = setTimeout(() => finish(), 3000); timer.unref();
      child.on('message', onMessage); child.once('exit', onExit);
      try { child.send({ type: 'hajimink:stream-diagnostic', requestId }, error => { if (error) finish(); }); } catch { finish(); }
    });
  }
  localSession() { return this.enqueue(() => this.localSessionInternal()); }
  async localSessionInternal() {
    const child = this.child;
    if (this.state.state !== 'ready' || !this.state.managed || this.state.mode !== 'owner' || !isAlive(child) || !child.connected) throw new GatewayError('无法确认本机网关');
    const requestId = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = value => {
        if (settled) return; settled = true; clearTimeout(timer);
        child.off('message', onMessage); child.off('exit', onExit);
        if (value) resolve(value); else reject(new GatewayError('无法准备本机登录，请停止旧版网关后重试'));
      };
      const onMessage = value => {
        if (value?.type !== 'hajimink:local-session-result' || value.requestId !== requestId) return;
        if (this.child !== child || this.state.state !== 'ready' || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 8 * 60 * 60 * 1000 + 5000) return finish();
        finish({ token: value.token, expiresAt: value.expiresAt });
      };
      const onExit = () => finish();
      const timer = setTimeout(() => finish(), 3000); timer.unref();
      child.on('message', onMessage); child.once('exit', onExit);
      try { child.send({ type: 'hajimink:local-session', requestId }, error => { if (error) finish(); }); } catch { finish(); }
    });
  }
  async shutdownChild() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return true;
    if (!child.connected) return false;
    try { child.send({ type: 'hajimink:gateway-stop' }, () => {}); } catch { return false; }
    const deadline = Date.now() + this.stopTimeoutMs;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) await delay(50);
    return child.exitCode !== null || child.signalCode !== null;
  }
  async stopInternal() {
    if (this.platform !== 'win32') return this.snapshot();
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) {
      this.child = undefined;
      if (this.state.state === 'error') this.emitState({ managed: false, pid: null });
      else this.emitState({ state: 'stopped', message: '本机网关未启动', managed: false, pid: null });
      return this.snapshot();
    }
    this.stopping = true;
    this.emitState({ state: 'stopping', message: '正在停止本机网关', managed: true, pid: this.child.pid });
    const stopped = await this.shutdownChild();
    if (!stopped) {
      this.stopping = false;
      this.recordEvent('本机网关未响应停止请求');
      this.emitState({ state: 'error', message: '网关未响应停止请求；为保护其他进程，未强制结束，请检查后重试', managed: true });
      return this.snapshot();
    }
    await this.lockCleanup;
    this.child = undefined;
    this.stopping = false;
    this.recordEvent('本机网关已停止');
    this.emitState({ state: 'stopped', message: '本机网关已停止', managed: false, pid: null });
    return this.snapshot();
  }
  async logsSnapshot() { return { lines: [...this.logs], state: this.snapshot() }; }
  close() { this.removeAllListeners(); }
}
module.exports = { GatewayManager, localOrigin, readHealth, readBootstrap, normalizeOwnerOrigin, writeGatewayConfig, probePort };
