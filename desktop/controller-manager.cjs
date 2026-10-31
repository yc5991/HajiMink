'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { isIP } = require('node:net');
const { probePort, localOrigin, readHealth, readBootstrap, normalizeOwnerOrigin, writeGatewayConfig } = require('./gateway-manager.cjs');
const { normalizeDesktopStatus } = require('./desktop-status.cjs');
const { requestPrivateControl } = require('./private-control.cjs');
const { sealControlSecret, openControlSecret } = require('./protected-credential.cjs');
const { inspectNativeProcess } = require('./native-helper.cjs');
const { NatappManager, readNatappSettings, saveNatappSettings } = require('./natapp-manager.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PIPE = /^hajimink-[0-9a-f]{32}$/;
const CONTROLLER_FILES = ['gateway-controller.cjs', 'gateway-manager.cjs', 'native-helper.cjs', 'desktop-status.cjs', 'natapp-manager.cjs'];
// Reserved, non-routable placeholder. It is used only while no public address is known.
const PENDING_PUBLIC_ORIGIN = 'https://hajimink-setup.invalid';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
class ControllerError extends Error {}
async function fileDigest(file) {
  const real = await fs.realpath(file);
  if (!/^[a-z]:\\/i.test(real)) throw new Error('non-local controller path');
  const stat = await fs.stat(real);
  if (!stat.isFile() || stat.size < 1 || stat.size > 256 * 1024 * 1024) throw new Error('invalid controller file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(real)) hash.update(chunk);
  return hash.digest('hex');
}
function normalizeNatapp(value) {
  const states = ['unconfigured', 'stopped', 'running', 'error', 'unconfirmed', 'configuration-error', 'unsupported'];
  if (!value || !states.includes(value.state) || typeof value.message !== 'string' || value.message.length > 200 || typeof value.managed !== 'boolean') return null;
  if (value.managed && (value.state !== 'running' || !Number.isSafeInteger(value.pid) || value.pid < 1)) return null;
  return { state: value.state, message: value.message, managed: value.managed, pid: value.managed ? value.pid : null };
}
class ControllerGatewayManager extends EventEmitter {
  constructor(options) {
    super();
    this.appRoot = path.resolve(options.appRoot); this.dataDir = path.resolve(options.dataDir);
    this.port = Number(options.port || 3000);
    if (!Number.isInteger(this.port) || this.port < 1024 || this.port > 65535) throw new ControllerError('本机网关端口无效');
    this.entryPath = path.resolve(options.entryPath || path.join(this.appRoot, 'dist-server', 'index.js'));
    this.nodePath = path.resolve(options.nodePath || process.execPath);
    this.nativePath = path.resolve(options.nativePath || path.join(this.appRoot, 'controller', 'PrivateControlPipe.exe'));
    this.controllerPath = path.resolve(options.controllerPath || path.join(this.appRoot, 'controller', 'gateway-controller.cjs'));
    this.runAsNode = options.runAsNode ?? !!process.versions.electron;
    this.platform = options.platform || process.platform;
    this.startTimeoutMs = options.startTimeoutMs || 30000;
    this.stopTimeoutMs = options.stopTimeoutMs || 5000;
    this.recordPath = path.join(this.dataDir, 'controller.instance.json');
    this.natappObserver = new NatappManager({ dataDir: this.dataDir, nativePath: this.nativePath, platform: this.platform, verifyGateway: async () => false });
    this.queue = Promise.resolve(); this.logs = []; this.closed = false; this.timer = undefined; this.pollEnabled = false; this.pollPending = false;
    this.state = { state: this.platform === 'win32' ? 'stopped' : 'unsupported', message: this.platform === 'win32' ? '本机网关未启动' : '本机 Agent 接入暂不支持此系统，请连接远程网关', port: this.port, origin: localOrigin(this.port), pid: null, managed: false, updatedAt: Date.now() };
  }
  snapshot() { return structuredClone(this.state); }
  emitState(next) {
    this.state = { ...this.state, ...next, updatedAt: Date.now() };
    if (next.state && next.state !== 'ready') this.state.desktop = null;
    this.emit('state', this.snapshot());
  }
  recordEvent(value) { this.logs.push(value); if (this.logs.length > 200) this.logs.shift(); this.emit('log', value); }
  enqueue(fn) { const result = this.queue.then(fn, fn); this.queue = result.then(() => {}, () => {}); return result; }
  start() { return this.enqueue(() => this.startInternal()); }
  startByUser(store) { return this.enqueue(async () => this.rememberStarted(await this.startInternal(), store)); }
  stopByUser(store) { return this.enqueue(() => this.stopByUserInternal(store)); }
  restartByUser(store) { return this.enqueue(async () => { const stopped = await this.stopInternal(); return stopped.state !== 'stopped' ? stopped : this.rememberStarted(await this.startInternal(), store); }); }
  startAccordingToPolicy(store) { return this.enqueue(() => this.restoreAccordingToPolicy(store)); }
  startForSelection(store) { return this.enqueue(() => { const saved = store.snapshot(); return saved.setup.gatewayManuallyStopped || saved.exitResume?.gateway === false ? this.attachOnlyInternal() : this.startInternal(); }); }
  startForAccount(store) { return this.enqueue(async () => {
    if (!store.snapshot().setup.gatewayManuallyStopped) return this.startInternal();
    const gateway = await this.attachOnlyInternal();
    if (gateway.state !== 'ready' || !gateway.managed) throw new ControllerError('本机网关已手动停止，请先启动网关再打开账户页面');
    return gateway;
  }); }
  refresh() { return this.enqueue(() => this.refreshInternal()); }
  streamTicket(expected) { return this.enqueue(() => this.streamTicketInternal(expected)); }
  localSession(expected) { return this.enqueue(() => this.localSessionInternal(expected)); }
  natappAction(action, store) { return this.enqueue(async () => { if (store && ['start', 'stop'].includes(action)) store.clearNatappResume(); this.emitState({ resumeError: null }); return this.natappActionInternal(action); }); }
  refreshNatapp() { return this.enqueue(() => this.refreshNatappInternal()); }
  configureNatapp(value, store) { return this.enqueue(async () => { if (store) store.clearNatappResume(); return this.configureNatappInternal(value); }); }
  inspectForExit() { return this.enqueue(async () => { try { return await this.inspectForExitInternal(); } catch (error) { return { error: error instanceof ControllerError ? error.message : '无法确认本机服务状态，请检查网关后重试' }; } }); }
  stopForExit(store, expected) { return this.enqueue(() => this.stopForExitInternal(store, expected)); }
  stop() { return this.enqueue(() => this.stopInternal()); }
  restart() { return this.enqueue(async () => { const stopped = await this.stopInternal(); return stopped.state !== 'stopped' ? stopped : this.startInternal(); }); }
  changePort(port, store) { return this.enqueue(() => this.changePortInternal(port, store)); }
  enableOwner(origin) { return this.enqueue(() => this.enableOwnerInternal(origin)); }
  beginPasskeySetup(origin) { return this.enqueue(() => this.beginPasskeySetupInternal(origin, 'passkey')); }
  prepareAwaitingOrigin() { return this.enqueue(() => this.prepareAwaitingOriginInternal()); }
  bindPendingOrigin(origin) { return this.enqueue(() => this.beginPasskeySetupInternal(origin, 'bind')); }
  async restoreAccordingToPolicy(store) {
    const saved = store.snapshot(), intent = saved.exitResume;
    if (!intent) return saved.setup.complete && !saved.setup.gatewayManuallyStopped ? this.startInternal() : this.attachOnlyInternal();
    if (!intent.gateway) {
      const result = await this.attachOnlyInternal();
      if (intent.natapp) this.emitState({ resumeError: 'NATAPP 未自动恢复：退出前网关未运行，请检查网关和隧道设置。' });
      return this.snapshot().resumeError ? this.snapshot() : result;
    }
    const result = await this.startInternal();
    if (result.state !== 'ready' || !result.managed) {
      this.emitState({ resumeError: '网关未能自动恢复，请检查网关状态后手动启动。' });
      return this.snapshot();
    }
    this.emitState({ resumeError: null });
    if (!intent.natapp) return this.snapshot();
    try {
      const settings = await readNatappSettings(this.dataDir);
      if (saved.setup.tunnelProvider !== 'natapp' || !settings || !samePath(settings.binaryPath, intent.natapp.binaryPath) || !samePath(settings.configPath, intent.natapp.configPath)) throw new ControllerError('原文件配置已变化或不可用');
      if (this.state.mode !== 'owner') throw new ControllerError('网关尚未启用登录保护');
      const restored = await this.natappActionInternal('start');
      if (restored.natapp?.state !== 'running' || !restored.natapp.managed) throw new ControllerError(restored.natapp?.message || '客户端未启动');
    } catch (error) {
      const detail = error instanceof ControllerError ? error.message : '请检查原客户端与配置文件';
      this.emitState({ resumeError: `NATAPP 未自动恢复：${detail}。请在网关设置中检查。` });
    }
    return this.snapshot();
  }
  async inspectForExitInternal() {
    if (this.platform !== 'win32') return { gateway: null, natapp: null };
    const record = await this.readRecord();
    let gateway = null;
    if (record) {
      const current = await this.attach(record);
      if (current.state !== 'ready' || !current.managed) throw new ControllerError('无法确认本机网关状态，请检查网关后重试');
      gateway = { instanceId: record.instanceId, controllerPid: record.controllerPid, controllerCreation: record.controllerCreation, gatewayPid: current.pid };
    } else if (await this.hasFile(path.join(this.dataDir, 'gateway.instance.lock'))) {
      throw new ControllerError('发现无法确认的网关实例记录；不会结束未知进程');
    }
    const tunnel = await this.natappObserver.refresh();
    if (tunnel.state === 'unconfirmed') throw new ControllerError('无法确认 NATAPP 进程身份；不会结束未知进程');
    const tunnelRecord = await this.natappObserver.readRecord();
    if (tunnelRecord && (tunnel.state !== 'running' || !tunnel.managed || tunnel.pid !== tunnelRecord.processId)) throw new ControllerError('无法确认 NATAPP 运行状态；不会结束未知进程');
    const natapp = tunnelRecord ? { instanceId: tunnelRecord.instanceId, pid: tunnelRecord.processId, creation: tunnelRecord.creation, binaryPath: tunnelRecord.binaryPath, configPath: tunnelRecord.configPath } : null;
    return { gateway, natapp };
  }
  async stopForExitInternal(store, expected) {
    if (this.platform !== 'win32') return { state: 'stopped' };
    try {
      const current = await this.inspectForExitInternal();
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new ControllerError('服务状态在确认期间发生变化，请重新退出');
      const previous = store.snapshot().exitResume;
      const pending = previous?.phase === 'pending' ? previous : null;
      const natapp = current.natapp ? { binaryPath: current.natapp.binaryPath, configPath: current.natapp.configPath } : pending?.natapp || null;
      const intent = { version: 1, phase: 'pending', gateway: !!current.gateway || !!pending?.gateway, natapp };
      try { store.setExitResume(intent); } catch { throw new ControllerError('无法保存服务恢复状态，请检查资料目录后重试'); }
      if (current.gateway) {
        const stopped = await this.stopInternal();
        if (stopped.state !== 'stopped') throw new ControllerError(stopped.message || '无法确认网关已停止');
      } else if (current.natapp) {
        const stopped = await this.natappObserver.stop(); this.emitState({ natapp: stopped });
        if (['running', 'unconfirmed'].includes(stopped.state)) throw new ControllerError('无法确认 NATAPP 已停止；不会结束未知进程');
      }
      const after = await this.inspectForExitInternal();
      if (after.gateway || after.natapp) throw new ControllerError('服务状态发生变化，未确认所有受管理服务已停止');
      try { store.setExitResume({ ...intent, phase: 'complete' }); } catch { throw new ControllerError('服务已停止，但无法保存最终恢复状态；请检查资料目录后重试'); }
      return { state: 'stopped' };
    } catch (error) {
      return { state: 'error', message: error instanceof ControllerError ? error.message : '无法确认或保存本机服务状态，请检查网关后重试' };
    }
  }
  async rememberStarted(gateway, store) {
    if (gateway.state !== 'ready' || !gateway.managed) return gateway;
    try { store.setGatewayManuallyStopped(false); }
    catch { return { ...gateway, preferenceError: true, message: '网关已启动，但无法保存启动状态；下次打开时可能不会自动启动，请检查资料目录' }; }
    return gateway;
  }
  async stopByUserInternal(store) {
    let saved = true;
    try { store.setGatewayManuallyStopped(true); } catch { saved = false; }
    let gateway = await this.stopInternal();
    if (gateway.failureCode === 'PREVIOUS_INSTALLATION') gateway = await this.stopPreviousInstallation();
    if (saved) return gateway;
    return { ...gateway, state: 'error', preferenceError: true, message: gateway.state === 'stopped' ? '网关已停止，但无法保存停止状态；下次打开时可能自动启动，请检查资料目录' : '无法保存停止状态，且网关停止未确认；请检查资料目录和网关状态' };
  }
  async attachOnlyInternal() {
    if (this.platform !== 'win32') return this.snapshot();
    try {
      const record = await this.readRecord();
      if (record) return await this.connectExisting(record);
      if (await this.hasFile(path.join(this.dataDir, 'gateway.instance.lock'))) throw new ControllerError('发现无法确认的网关实例记录，未启动或接管任何进程');
      this.pollEnabled = false;
      this.emitState({ state: 'stopped', message: '本机网关未启动', managed: false, pid: null, controllerPid: null });
    } catch (error) {
      this.emitState({ state: 'error', message: error instanceof ControllerError ? error.message : '后台控制器状态无法确认，未启动任何进程', managed: false, pid: null });
    }
    return this.snapshot();
  }
  async hasFile(file) {
    try { await fs.access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async changePortInternal(value, store) {
    if (this.platform !== 'win32') throw new ControllerError('当前系统不支持本机网关');
    const next = Number(value), previous = this.port;
    if (!Number.isInteger(next) || next < 1024 || next > 65535) throw new ControllerError('端口应为 1024 到 65535 之间的整数');
    if (!store || store.localPort() !== previous) throw new ControllerError('本机连接和网关端口不一致，请先检查配置');
    if (next === previous) return this.snapshot();
    const portState = await probePort(next);
    if (portState === 'occupied') throw new ControllerError(`端口 ${next} 已被其他程序占用，原网关未改变`);
    if (portState !== 'free') throw new ControllerError('无法检查新端口，原网关未改变');
    // readRecord and attach authenticate the exact controller before stop.
    const record = await this.readRecord();
    let wasRunning = false;
    if (record) {
      const current = await this.attach(record);
      if (current.state !== 'ready' || !current.managed) throw new ControllerError('无法确认原网关的运行状态，端口未改变');
      wasRunning = true;
      const stopped = await this.stopInternal();
      if (stopped.state !== 'stopped') throw new ControllerError('原网关未确认停止，端口未改变；不会强制结束进程');
    } else if (await this.hasFile(path.join(this.dataDir, 'gateway.instance.lock'))) {
      throw new ControllerError('发现无法确认的网关实例记录，端口未改变');
    } else {
      // An address transition can leave our tunnel running without its former
      // controller. Stop that verified instance before changing its target.
      const natapp = await this.natappObserver.stop();
      this.emitState({ natapp });
      if (['running', 'unconfirmed'].includes(natapp.state)) throw new ControllerError('无法确认 NATAPP 已停止，端口未改变');
    }
    try { store.setLocalPort(next); }
    catch {
      const resumed = wasRunning ? await this.startInternal() : null;
      throw new ControllerError(wasRunning && resumed?.state !== 'ready' ? '保存端口失败，原设置未改变，但原网关未能恢复，请检查网关状态' : '保存端口失败，原设置未改变');
    }
    this.port = next;
    this.emitState({ state: 'stopped', message: '端口已保存，本机网关未启动', port: next, origin: localOrigin(next), pid: null, controllerPid: null, managed: false });
    if (!wasRunning) return this.snapshot();
    const started = await this.startInternal();
    if (started.state === 'ready') return started;
    // A failed launch may leave an owned record or lock. Stop only after the
    // normal identity checks; otherwise retain the new configuration for review.
    let safeToRestore = false;
    try {
      const candidate = await this.readRecord();
      if (candidate) await this.stopInternal();
      safeToRestore = !(await this.hasFile(this.recordPath)) && !(await this.hasFile(path.join(this.dataDir, 'gateway.instance.lock')));
    } catch {}
    if (!safeToRestore) throw new ControllerError('新端口启动失败，无法确认后台实例是否退出；已保留新设置，未强制结束进程');
    try { store.setLocalPort(previous); }
    catch { throw new ControllerError('新端口启动失败，无法恢复原设置；请检查本机配置'); }
    this.port = previous;
    this.emitState({ state: 'stopped', message: '正在恢复原网关', port: previous, origin: localOrigin(previous), pid: null, controllerPid: null, managed: false });
    const restored = await this.startInternal();
    throw new ControllerError(restored.state === 'ready' ? '新端口启动失败，已恢复原端口和网关' : '新端口启动失败，已恢复原端口设置；原网关未能重新启动，请检查状态');
  }
  async enableOwnerInternal(value, preparingAddress = false) {
    if (this.platform !== 'win32') throw new ControllerError('当前系统不支持本机网关');
    let origin;
    try { origin = normalizeOwnerOrigin(value); } catch { throw new ControllerError('请输入不含路径或账号的 HTTPS 访问地址'); }
    if ((origin === PENDING_PUBLIC_ORIGIN) !== preparingAddress) throw new ControllerError('请填写服务商提供的真实 HTTPS 地址');
    const record = await this.readRecord();
    if (!record) throw new ControllerError('请先启动本机网关并设置密码');
    const current = await this.attach(record);
    const currentMode = current.mode || 'local';
    if (current.state !== 'ready' || !current.managed || !['local', 'owner'].includes(currentMode)) throw new ControllerError('请先确认网关已正常运行');
    if (preparingAddress && currentMode !== 'local') throw new ControllerError('当前网关已启用远程保护，请填写真实地址继续设置');
    const currentOrigin = currentMode === 'owner' ? normalizeOwnerOrigin(current.publicOrigin) : localOrigin(this.port);
    if (currentMode === 'owner' && currentOrigin === origin && !current.setupPending) return current;
    const bootstrap = await readBootstrap(this.port, currentMode === 'owner' ? { mode: 'owner', publicOrigin: currentOrigin } : { mode: 'local' });
    if (!bootstrap?.passwordEnabled) throw new ControllerError(currentMode === 'owner' ? '请先设置密码，避免更换域名后无法登录' : '请先在本机账户页面设置密码，再启用远程独立登录');
    const file = path.join(this.dataDir, 'config.json'); let config;
    try { config = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw new ControllerError('网关配置无法读取，未进行切换'); }
    if (config.mode !== currentMode || Number(config.port) !== this.port || config.publicOrigin !== currentOrigin) throw new ControllerError('网关配置不匹配，未进行切换');
    const stopped = await this.stopInternal(currentMode === 'owner' && current.natapp?.state === 'running');
    if (stopped.state !== 'stopped') throw new ControllerError('本机网关未确认停止，未进行切换');
    try { await writeGatewayConfig(file, { ...config, mode: 'owner', port: this.port, publicOrigin: origin }); }
    catch { throw new ControllerError('独立登录配置保存失败；网关已停止，请检查后再启动'); }
    this.emitState({ state: 'stopped', message: '正在启动受密码保护的网关', mode: 'owner', publicOrigin: origin, managed: false, pid: null, controllerPid: null });
    const started = await this.startInternal();
    if (started.state !== 'ready' || started.mode !== 'owner') throw new ControllerError('独立登录网关未能启动，已保留受保护配置；请检查状态后重试');
    return started;
  }
  async prepareAwaitingOriginInternal() {
    if (this.platform !== 'win32') throw new ControllerError('当前系统不支持本机网关');
    const record = await this.readRecord();
    if (!record) throw new ControllerError('请先启动本机网关');
    const current = await this.attach(record);
    if (current.state !== 'ready' || !current.managed || (current.mode || 'local') !== 'local') throw new ControllerError('请先确认本机网关已正常运行');
    const bootstrap = await readBootstrap(this.port, { mode: 'local' });
    if (!bootstrap) throw new ControllerError('无法确认现有登录状态，未进行切换');
    if (bootstrap.passwordEnabled) return this.enableOwnerInternal(PENDING_PUBLIC_ORIGIN, true);
    if (bootstrap.configured) throw new ControllerError('当前账户已有登录方式，请先设置密码后再开启受限保护');
    return this.beginPasskeySetupInternal(PENDING_PUBLIC_ORIGIN, 'prepare');
  }
  async beginPasskeySetupInternal(value, phase = 'passkey') {
    if (this.platform !== 'win32') throw new ControllerError('当前系统不支持本机网关');
    if (!['passkey', 'prepare', 'bind'].includes(phase)) throw new ControllerError('首次设置方式无效');
    let origin;
    try { origin = normalizeOwnerOrigin(value); } catch { throw new ControllerError('请输入不含路径或账号的 HTTPS 访问地址'); }
    if ((phase === 'prepare') !== (origin === PENDING_PUBLIC_ORIGIN)) throw new ControllerError('请填写服务商提供的真实 HTTPS 地址');
    const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    if (phase === 'passkey' && isIP(hostname)) throw new ControllerError('通行密钥需要最终 HTTPS 域名，请勿使用 IP 地址');
    const record = await this.readRecord();
    if (!record) throw new ControllerError('请先启动本机网关');
    const current = await this.attach(record);
    const currentMode = current.mode || 'local';
    if (current.state !== 'ready' || !current.managed || !['local', 'owner'].includes(currentMode)) throw new ControllerError('请先确认网关已正常运行');
    if (phase === 'prepare' && currentMode !== 'local') throw new ControllerError('当前网关已启用远程保护，请填写真实地址继续设置');
    if (phase === 'bind' && (currentMode !== 'owner' || !current.setupPending)) throw new ControllerError('请先启动受限的首次设置，再填写访问地址');
    const currentOrigin = currentMode === 'owner' ? normalizeOwnerOrigin(current.publicOrigin) : localOrigin(this.port);
    const bootstrap = await readBootstrap(this.port, currentMode === 'owner' ? { mode: 'owner', publicOrigin: currentOrigin } : { mode: 'local' });
    if (!bootstrap) throw new ControllerError('无法确认现有登录状态，未进行切换');
    if (bootstrap.configured) throw new ControllerError('已经设置过登录方式，请使用现有账户管理通行密钥');
    const file = path.join(this.dataDir, 'config.json'); let config;
    try { config = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw new ControllerError('网关配置无法读取，未进行切换'); }
    if (config.mode !== currentMode || Number(config.port) !== this.port || config.publicOrigin !== currentOrigin) throw new ControllerError('网关配置不匹配，未进行切换');
    const stopped = await this.stopInternal(currentMode === 'owner' && current.natapp?.state === 'running');
    if (stopped.state !== 'stopped') throw new ControllerError('本机网关未确认停止，未进行切换');
    // The plaintext is returned once to the trusted desktop shell. It is never
    // written to config, process arguments, environment, logs or the control pipe.
    const code = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const ownerSetup = { generation: randomUUID(), codeHash: createHash('sha256').update(code).digest('hex'), expiresAt };
    try { await writeGatewayConfig(file, { ...config, mode: 'owner', port: this.port, publicOrigin: origin, ownerSetup }); }
    catch { throw new ControllerError('首次设置配置保存失败；网关已停止，请检查后重试'); }
    this.emitState({ state: 'stopped', message: '正在启动受限的首次设置', mode: 'owner', publicOrigin: origin, setupPending: true, managed: false, pid: null, controllerPid: null });
    const started = await this.startInternal();
    if (started.state !== 'ready' || started.mode !== 'owner' || !started.setupPending) throw new ControllerError('首次设置网关未能启动，已保留受限配置；请检查状态后重新生成设置码');
    return { gateway: started, code, expiresAt };
  }
  async readRecord() {
    let value;
    try { value = JSON.parse(await fs.readFile(this.recordPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new ControllerError('本机控制器实例记录无法读取，请检查后重试'); }
    if (!value || value.version !== 1 || !UUID.test(value.instanceId) || !PIPE.test(value.pipeName) || value.port !== this.port || !samePath(value.dataDir, this.dataDir)) throw new ControllerError('本机控制器实例记录与当前配置不匹配，未接管任何进程');
    if (!samePath(value.entryPath, this.entryPath) || !samePath(value.nodePath, this.nodePath) || !samePath(value.controllerPath, this.controllerPath)) {
      const error = new ControllerError('发现旧版后台网关，请先停止网关再启动当前版本；无法确认身份时不会停止进程');
      if (this.previousInstallationRoot(value)) error.code = 'PREVIOUS_INSTALLATION';
      else error.message = '本机控制器实例记录与当前配置不匹配，未接管任何进程';
      throw error;
    }
    return value;
  }
  previousInstallationRoot(record) {
    if (this.platform !== 'win32' || this.runAsNode || !samePath(this.nodePath, path.join(this.appRoot, 'runtime', 'node.exe')) || !samePath(this.entryPath, path.join(this.appRoot, 'dist-server', 'index.js')) || !samePath(this.controllerPath, path.join(this.appRoot, 'controller', 'gateway-controller.cjs'))) return null;
    if (!['entryPath', 'nodePath', 'controllerPath'].every(key => typeof record[key] === 'string' && record[key].length <= 2048 && /^[a-z]:\\/i.test(record[key]) && path.isAbsolute(record[key]))) return null;
    const root = path.dirname(path.dirname(path.resolve(record.entryPath)));
    if (samePath(root, this.appRoot) || !samePath(record.entryPath, path.join(root, 'dist-server', 'index.js')) || !samePath(record.nodePath, path.join(root, 'runtime', 'node.exe')) || !samePath(record.controllerPath, path.join(root, 'controller', 'gateway-controller.cjs'))) return null;
    return root;
  }
  async stopPreviousInstallation() {
    let previous;
    try {
      const record = JSON.parse(await fs.readFile(this.recordPath, 'utf8'));
      if (!record || record.version !== 1 || !UUID.test(record.instanceId) || !PIPE.test(record.pipeName) || record.port !== this.port || !samePath(record.dataDir, this.dataDir)) throw new Error('invalid record');
      const root = this.previousInstallationRoot(record);
      if (!root) throw new Error('invalid installation');
      // Only the current trusted helper is executed; files from the old installation
      // are compared, never launched. Different controller versions require the old app.
      for (const name of [path.join('runtime', 'node.exe'), ...CONTROLLER_FILES.map(file => path.join('controller', file))]) {
        if (await fileDigest(path.join(this.appRoot, name)) !== await fileDigest(path.join(root, name))) throw new Error('different controller');
      }
      previous = new ControllerGatewayManager({ appRoot: root, dataDir: this.dataDir, port: this.port, nodePath: record.nodePath, nativePath: this.nativePath, runAsNode: false, platform: this.platform, stopTimeoutMs: this.stopTimeoutMs });
      const verifiedRecord = await previous.readRecord();
      if (!verifiedRecord || verifiedRecord.instanceId !== record.instanceId || verifiedRecord.controllerPid !== record.controllerPid || verifiedRecord.controllerCreation !== record.controllerCreation || verifiedRecord.pipeName !== record.pipeName) throw new Error('record changed');
      const status = await previous.attach(verifiedRecord);
      if (status.state !== 'ready' || !status.managed) throw new Error('gateway unconfirmed');
      const result = await previous.stop();
      if (result.state !== 'stopped') throw new Error('stop unconfirmed');
      this.pollEnabled = false;
      this.emitState({ ...result, failureCode: null });
      return this.snapshot();
    } catch {
      this.emitState({ state: 'error', managed: false, pid: null, failureCode: null, message: '无法确认旧版后台身份，请打开旧版停止网关；未结束未知进程' });
      return this.snapshot();
    } finally { previous?.close(); }
  }
  async removeUnstartedRecord(id, secretCreated) {
    try {
      const value = JSON.parse(await fs.readFile(this.recordPath, 'utf8'));
      if (value.instanceId !== id) return;
      await fs.unlink(this.recordPath);
      if (secretCreated) await fs.unlink(path.join(this.dataDir, 'controller-secrets', `${id.toLowerCase()}.dpapi`)).catch(() => {});
    } catch {}
  }
  async attach(record, action = 'status') {
    if (!Number.isSafeInteger(record.controllerPid) || record.controllerPid < 1 || typeof record.controllerCreation !== 'string' || !/^\d{15,22}$/.test(record.controllerCreation)) throw new ControllerError('后台控制器尚未完成初始化，或实例记录已失效');
    const processInfo = await inspectNativeProcess(this.nativePath, record.controllerPid, { kind: 'controller', entry: this.controllerPath }).catch(() => { throw new ControllerError('无法确认后台控制器进程身份，未接管任何进程'); });
    if (!samePath(processInfo.image, this.nodePath) || processInfo.creation !== record.controllerCreation) throw new ControllerError('后台控制器进程身份不匹配，未接管任何进程');
    const secret = await openControlSecret(this.nativePath, this.dataDir, record.instanceId).catch(() => { throw new ControllerError('无法读取当前用户的后台控制凭据'); });
    const expected = { instanceId: record.instanceId, dataDir: this.dataDir, entryPath: this.entryPath, nodePath: this.nodePath, controllerPath: this.controllerPath, port: this.port, processId: record.controllerPid, processCreation: record.controllerCreation };
    let response;
    try { response = await requestPrivateControl(`\\\\.\\pipe\\${record.pipeName}`, secret, expected, action, ['stop', 'stop-keep-natapp'].includes(action) || action.startsWith('natapp-') ? 45000 : 7000); }
    catch (cause) { const error = new ControllerError(action === 'stop' ? '后台控制器未确认停止；不会强制结束进程' : '无法验证后台控制器通信，未接管任何进程'); const known = ['本机控制通道不可用', '本机控制通道身份校验失败', '本机网关实例信息不匹配', '本机控制操作未完成', '本机控制通道结果校验失败']; error.code = `${known.includes(cause?.message) ? cause.message : 'other'}:${['connect', 'challenge', 'result'].includes(cause?.phase) ? cause.phase : 'unknown'}`; throw error; }
    let gateway = response.result.gateway;
    if (!gateway || !['stopped', 'starting', 'ready', 'stopping', 'error'].includes(gateway.state) || gateway.port !== this.port || gateway.origin !== localOrigin(this.port) || typeof gateway.managed !== 'boolean') throw new ControllerError('后台网关状态无效，未接管任何进程');
    gateway = { ...gateway, desktop: normalizeDesktopStatus(gateway.desktop), natapp: normalizeNatapp(response.result.natapp) };
    if (['status', 'diagnose-stream', 'local-session', 'natapp-start', 'natapp-stop'].includes(action) && gateway.state === 'ready') {
      if (!gateway.managed || !Number.isSafeInteger(gateway.pid) || gateway.pid !== response.identity.gatewayPid || typeof response.identity.gatewayCreation !== 'string') throw new ControllerError('后台网关实例身份不匹配');
      const info = await inspectNativeProcess(this.nativePath, gateway.pid, { kind: 'gateway', entry: this.entryPath, dataDir: this.dataDir }).catch(() => { throw new ControllerError('无法确认后台网关进程身份'); });
      if (!samePath(info.image, this.nodePath) || info.creation !== response.identity.gatewayCreation) throw new ControllerError('后台网关进程身份不匹配');
      const mode = gateway.mode || 'local';
      if (!['local', 'owner'].includes(mode)) throw new ControllerError('后台网关登录模式无效');
      const health = await readHealth(this.port, { mode, publicOrigin: gateway.publicOrigin });
      if (!health?.ok || health.mode !== mode) throw new ControllerError('后台网关身份或登录保护检查未通过');
      if (mode === 'owner') gateway = { ...gateway, setupPending: !!health.setupPending, message: health.setupPending ? '等待完成通行密钥首次设置' : '网关已启用独立登录' };
    }
    if (action === 'local-session') {
      const ticket = response.result.ticket;
      if (gateway.state !== 'ready' || gateway.mode !== 'owner' || !ticket || typeof ticket.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket.token) || !Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt <= Date.now() || ticket.expiresAt > Date.now() + 8 * 60 * 60 * 1000 + 5000) throw new ControllerError('无法准备本机登录，请停止旧版网关后重试');
      return { gateway, ticket };
    }
    if (action === 'diagnose-stream') {
      const ticket = response.result.ticket;
      if (gateway.state !== 'ready' || gateway.mode !== 'owner' || gateway.streamDiagnostic !== true || !ticket || typeof ticket.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket.token) || !Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt <= Date.now() || ticket.expiresAt > Date.now() + 25000) throw new ControllerError('无法准备实时连接检查');
      return { gateway, ticket };
    }
    return gateway;
  }
  async streamTicketInternal(expected) {
    if (!expected || this.state.state !== 'ready' || !this.state.managed || this.state.mode !== 'owner' || this.state.streamDiagnostic !== true) throw new ControllerError('当前网关不支持实时连接检查');
    const same = value => ['pid', 'port', 'mode', 'publicOrigin'].every(key => value?.[key] === expected[key]);
    if (!same(this.state) || this.state.controllerPid !== expected.controllerPid) throw new ControllerError('网关状态已变化');
    const record = await this.readRecord();
    if (!record || record.controllerPid !== expected.controllerPid) throw new ControllerError('网关状态已变化');
    const { gateway, ticket } = await this.attach(record, 'diagnose-stream');
    if (!same(gateway)) throw new ControllerError('网关状态已变化');
    return ticket;
  }
  async localSessionInternal(expected) {
    if (!expected || this.state.state !== 'ready' || !this.state.managed || this.state.mode !== 'owner') throw new ControllerError('请先启动本机网关');
    const same = value => ['pid', 'port', 'mode', 'publicOrigin'].every(key => value?.[key] === expected[key]);
    if (!same(this.state) || this.state.controllerPid !== expected.controllerPid) throw new ControllerError('网关状态已变化');
    const record = await this.readRecord();
    if (!record || record.controllerPid !== expected.controllerPid) throw new ControllerError('网关状态已变化');
    const { gateway, ticket } = await this.attach(record, 'local-session');
    if (!same(gateway)) throw new ControllerError('网关状态已变化');
    return ticket;
  }
  async natappActionInternal(action) {
    if (!['start', 'stop'].includes(action)) throw new ControllerError('NATAPP 操作无效');
    const record = await this.readRecord();
    if (action === 'stop' && !record) {
      const natapp = await this.natappObserver.stop(); this.emitState({ natapp }); return this.snapshot();
    }
    if (!record) throw new ControllerError('请先连接支持 NATAPP 管理的本机后台控制器');
    if (action === 'start' && (this.state.state !== 'ready' || !this.state.managed || this.state.mode !== 'owner' || !this.state.natapp)) throw new ControllerError('请先启用独立登录或受限首次设置');
    const gateway = await this.attach(record, `natapp-${action}`);
    if (!gateway.natapp) throw new ControllerError('后台控制器不支持 NATAPP 管理');
    this.emitState({ ...gateway, controllerPid: record.controllerPid });
    return this.snapshot();
  }
  async refreshNatappInternal() {
    const natapp = await this.natappObserver.refresh(); this.emitState({ natapp }); return this.snapshot();
  }
  async configureNatappInternal(value) {
    if (this.platform !== 'win32') throw new ControllerError('当前系统不支持本机 NATAPP 管理');
    const record = await this.readRecord();
    if (record) {
      const gateway = await this.attach(record);
      if (!gateway.natapp) throw new ControllerError('当前后台控制器不支持 NATAPP 管理，请先重启网关');
      if (['running', 'unconfirmed'].includes(gateway.natapp.state)) throw new ControllerError('请先停止并确认 HajiMink 管理的 NATAPP');
    }
    return saveNatappSettings(this.dataDir, value);
  }
  async waitForRecord(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await this.readRecord();
      if (value?.controllerPid && value?.controllerCreation) return value;
      await delay(100);
    }
    throw new ControllerError('后台控制器启动超时，请检查实例记录');
  }
  async connectExisting(record) {
    if (!record.controllerPid || !record.controllerCreation) record = await this.waitForRecord(Math.min(this.startTimeoutMs, 12000));
    const deadline = Date.now() + Math.min(this.startTimeoutMs, 15000);
    let last;
    while (Date.now() < deadline) {
      try {
        const gateway = await this.attach(record);
        this.emitState({ ...gateway, managed: true, message: gateway.state === 'ready' && !gateway.setupPending ? '本机后台网关已连接' : gateway.message, controllerPid: record.controllerPid });
        this.pollEnabled = true; this.ensurePolling();
        return this.snapshot();
      } catch (error) { last = error; await delay(250); }
    }
    throw last || new ControllerError('后台控制器连接超时');
  }
  ensurePolling() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      if (this.closed || !this.pollEnabled || this.pollPending) return;
      this.pollPending = true;
      void this.enqueue(() => this.refreshInternal()).finally(() => { this.pollPending = false; });
    }, 5000);
    this.timer.unref();
  }
  async refreshInternal() {
    if (!this.pollEnabled || this.closed) return this.snapshot();
    try {
      const record = await this.readRecord(); if (!record) throw new ControllerError('后台控制器实例记录不存在');
      const gateway = await this.attach(record);
      this.emitState({ ...gateway, managed: true, controllerPid: record.controllerPid });
    } catch (error) { this.emitState({ state: 'error', managed: false, pid: null, message: error instanceof ControllerError ? error.message : '后台控制器状态无法确认' }); }
    return this.snapshot();
  }
  async startInternal() {
    if (this.platform !== 'win32') return this.snapshot();
    this.emitState({ state: 'starting', message: '正在连接本机后台控制器', managed: false, pid: null });
    let id, launched = false, secretCreated = false;
    try {
      const existing = await this.readRecord();
      if (existing) return await this.connectExisting(existing);
      const portState = await probePort(this.port);
      if (portState === 'occupied') throw new ControllerError(`端口 ${this.port} 已被占用，无法确认现有进程身份；不会结束或自动连接该进程`);
      if (portState !== 'free') throw new ControllerError('无法检查本机网关端口');
      await fs.mkdir(this.dataDir, { recursive: true });
      id = randomUUID(); const secret = randomBytes(32).toString('base64url');
      const record = { version: 1, instanceId: id, pipeName: `hajimink-${randomBytes(16).toString('hex')}`, port: this.port, dataDir: this.dataDir, entryPath: this.entryPath, nodePath: this.nodePath, controllerPath: this.controllerPath, controllerPid: null, controllerCreation: null };
      try { await fs.writeFile(this.recordPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code === 'EEXIST') { const existing = await this.readRecord(); if (existing) return await this.connectExisting(existing); } throw error; }
      await sealControlSecret(this.nativePath, this.dataDir, id, secret); secretCreated = true;
      const env = { ...process.env, ELECTRON_NO_ATTACH_CONSOLE: '1' }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
      if (this.runAsNode) env.ELECTRON_RUN_AS_NODE = '1'; else delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(this.nodePath, [this.controllerPath], { cwd: this.appRoot, env, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      launched = !!child.pid;
      const started = new Promise((resolve, reject) => {
        const lines = readline.createInterface({ input: child.stdout });
        const timer = setTimeout(() => finish(new ControllerError('后台控制器启动超时，实例记录已保留')), this.startTimeoutMs + 12000);
        let done = false;
        const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); lines.close(); child.stdout.destroy(); child.stdin.destroy(); child.unref(); if (error) reject(error); else resolve(value); };
        child.once('error', () => finish(new ControllerError('无法启动后台控制器')));
        child.once('exit', () => finish(new ControllerError('后台控制器启动时退出')));
        lines.on('line', line => { let message; try { message = JSON.parse(line); } catch { return; } if (message.type === 'ready') finish(null, message); else if (message.type === 'error') { const error = new ControllerError('后台网关启动失败，请检查端口和运行环境'); error.phase = ['bootstrap', 'inspect-controller', 'record', 'gateway', 'bridge', 'inspect-gateway', 'bridge-spawn', 'bridge-ready'].includes(message.phase) ? message.phase : 'unknown'; finish(error); } });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(`${JSON.stringify({ ...record, appRoot: this.appRoot, nativePath: this.nativePath, runAsNode: this.runAsNode, secret, startTimeoutMs: this.startTimeoutMs, stopTimeoutMs: this.stopTimeoutMs })}\n`);
      await started;
      const readyRecord = await this.waitForRecord(5000);
      const result = await this.connectExisting(readyRecord);
      this.recordEvent('本机后台网关已启动');
      return result;
    } catch (error) {
      if (id && !launched) await this.removeUnstartedRecord(id, secretCreated);
      this.emitState({ state: 'error', managed: false, pid: null, failureStage: error?.phase || null, message: error instanceof ControllerError ? error.message : '本机后台网关启动失败，请检查运行环境' });
      this.recordEvent('本机后台网关启动失败');
      return this.snapshot();
    }
  }
  async stopInternal(keepNatapp = false) {
    if (this.platform !== 'win32') return this.snapshot();
    let record;
    try { record = await this.readRecord(); } catch (error) { this.emitState({ state: 'error', message: error instanceof ControllerError ? error.message : '后台控制器状态无法确认', failureCode: error?.code || null, managed: false, pid: null }); return this.snapshot(); }
    if (!record) {
      this.pollEnabled = false;
      const natapp = await this.natappObserver.stop();
      if (['running', 'unconfirmed'].includes(natapp.state)) { this.emitState({ state: 'error', message: '无法确认 NATAPP 已停止；未结束未知进程', managed: false, pid: null, natapp }); return this.snapshot(); }
      // Without the controller record, a gateway lock means the original
      // instance is still uncertain even when its port appears free.
      if (await this.hasFile(path.join(this.dataDir, 'gateway.instance.lock'))) { this.emitState({ state: 'error', message: '发现无法确认的网关实例记录；不会结束未知进程', managed: false, pid: null, natapp }); return this.snapshot(); }
      if (await probePort(this.port) !== 'free') this.emitState({ state: 'error', message: '端口仍被占用，无法确认进程身份；不会结束未知进程', managed: false, pid: null, natapp });
      else this.emitState({ state: 'stopped', message: '本机网关未启动', managed: false, pid: null, controllerPid: null, natapp });
      return this.snapshot();
    }
    this.emitState({ state: 'stopping', message: '正在停止本机后台网关', managed: true });
    try {
      const stopped = await this.attach(record, keepNatapp ? 'stop-keep-natapp' : 'stop');
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) { try { await fs.access(this.recordPath); } catch { break; } await delay(100); }
      try { await fs.access(this.recordPath); throw new ControllerError('后台停止请求已发送，但实例清理尚未确认'); } catch (error) { if (error instanceof ControllerError) throw error; }
      this.pollEnabled = false;
      this.emitState({ state: 'stopped', message: '本机网关已停止', managed: false, pid: null, controllerPid: null, natapp: stopped.natapp, failureCode: null });
      this.recordEvent('本机后台网关已停止');
    } catch (error) {
      this.emitState({ state: 'error', message: error instanceof ControllerError ? error.message : '后台网关停止失败；未强制结束进程', failureCode: error?.code || null, managed: false, pid: null });
      this.recordEvent('本机后台网关停止失败');
    }
    return this.snapshot();
  }
  async logsSnapshot() { return { lines: [...this.logs], state: this.snapshot() }; }
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); this.removeAllListeners(); }
}
module.exports = { ControllerGatewayManager, PENDING_PUBLIC_ORIGIN };
