'use strict';
// Only processes explicitly started by this controller can be managed. The
// selected INI file is never read, copied, or passed on the command line as data.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { inspectNativeProcess, stopOwnedTunnel, countNatappProcesses, isOriginalProcessGone } = require('./native-helper.cjs');
const SETTINGS = 'natapp-settings.json', RECORD = 'natapp.instance.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class NatappError extends Error {}
function localPath(value, kind) {
  if (typeof value !== 'string' || value.length > 1024 || !/^[a-z]:[\\/]/i.test(value) || /[\u0000-\u001f\u007f"]/.test(value) || !path.isAbsolute(value)) throw new NatappError('请选择本机磁盘上的 NATAPP 文件');
  const result = path.resolve(value);
  if (kind === 'binary' && path.basename(result).toLowerCase() !== 'natapp.exe') throw new NatappError('请选择从 NATAPP 官方获取的 natapp.exe');
  if (kind === 'config' && path.extname(result).toLowerCase() !== '.ini') throw new NatappError('请选择 NATAPP 的 .ini 配置文件');
  return result;
}
function validateSettings(value) {
  if (!value || value.version !== 1) throw new NatappError('NATAPP 配置记录无效，请重新选择文件');
  return { version: 1, binaryPath: localPath(value.binaryPath, 'binary'), configPath: localPath(value.configPath, 'config') };
}
async function selectedFile(value, kind) {
  const input = localPath(value, kind);
  const actual = localPath(await fs.realpath(input).catch(() => { throw new NatappError('所选文件不存在或无法访问'); }), kind);
  const info = await fs.stat(actual).catch(() => null);
  if (!info?.isFile()) throw new NatappError('请选择有效的 NATAPP 文件');
  return actual;
}
async function readNatappSettings(dataDir) {
  let value;
  try { value = JSON.parse(await fs.readFile(path.join(dataDir, SETTINGS), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new NatappError('NATAPP 配置记录无法读取'); }
  return validateSettings(value);
}
async function atomicWrite(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
}
async function saveNatappSettings(dataDir, input) {
  const binaryPath = await selectedFile(input?.binaryPath, 'binary');
  const configPath = await selectedFile(input?.configPath, 'config');
  await fs.mkdir(dataDir, { recursive: true });
  try { await fs.access(path.join(dataDir, RECORD)); throw new NatappError('请先停止并确认 HajiMink 管理的 NATAPP，再更改文件'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const settings = { version: 1, binaryPath, configPath };
  await atomicWrite(path.join(dataDir, SETTINGS), settings);
  return settings;
}
class NatappManager {
  constructor(options) {
    this.dataDir = path.resolve(options.dataDir); this.nativePath = path.resolve(options.nativePath);
    this.verifyGateway = options.verifyGateway; this.platform = options.platform || process.platform;
    this.spawnImpl = options.spawnImpl || spawn; this.inspect = options.inspect || inspectNativeProcess;
    this.stopProcess = options.stopProcess || stopOwnedTunnel; this.countProcesses = options.countProcesses || countNatappProcesses;
    this.originalGone = options.originalGone || isOriginalProcessGone;
    this.recordPath = path.join(this.dataDir, RECORD); this.child = null; this.queue = Promise.resolve(); this.stopping = false;
    this.state = { state: 'unconfigured', managed: false, pid: null, message: '选择 NATAPP 客户端和配置文件后，可由 HajiMink 启动。' };
  }
  snapshot() { return structuredClone(this.state); }
  set(state, message, managed = false, pid = null) { this.state = { state, message, managed, pid }; return this.snapshot(); }
  enqueue(fn) { const result = this.queue.then(fn, fn); this.queue = result.then(() => {}, () => {}); return result; }
  refresh() { return this.enqueue(() => this.refreshInternal()); }
  start() { return this.enqueue(() => this.startInternal()); }
  stop() { return this.enqueue(() => this.stopInternal()); }
  async readRecord() {
    let value;
    try { value = JSON.parse(await fs.readFile(this.recordPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new NatappError('NATAPP 实例记录无法读取，未接管其他进程'); }
    if (!value || value.version !== 1 || !UUID.test(value.instanceId) || !['starting', 'running'].includes(value.phase)) throw new NatappError('NATAPP 实例记录无效，未接管其他进程');
    const paths = validateSettings(value);
    if (value.processId !== null && (!Number.isSafeInteger(value.processId) || value.processId < 1)) throw new NatappError('NATAPP 实例记录无效，未接管其他进程');
    if (value.creation !== null && (typeof value.creation !== 'string' || !/^\d{15,22}$/.test(value.creation))) throw new NatappError('NATAPP 实例记录无效，未接管其他进程');
    if (value.phase === 'running' && (!value.processId || !value.creation)) throw new NatappError('NATAPP 实例记录无效，未接管其他进程');
    return { ...value, ...paths };
  }
  expected(record) { return { kind: 'natapp', binaryPath: record.binaryPath, configPath: record.configPath, creation: record.creation }; }
  async forget(instanceId) {
    try {
      const current = await this.readRecord();
      if (!current) return true;
      if (current.instanceId !== instanceId) return false;
      await fs.unlink(this.recordPath); return true;
    } catch { return false; }
  }
  async replaceRecord(record) {
    const current = await this.readRecord();
    if (!current || current.instanceId !== record.instanceId) throw new NatappError('NATAPP 实例记录已变化，未接管其他进程');
    await atomicWrite(this.recordPath, record);
  }
  async refreshInternal() {
    if (this.platform !== 'win32') return this.set('unsupported', '当前系统暂不支持本机 NATAPP 管理。');
    let record;
    try { record = await this.readRecord(); }
    catch (error) { return this.set('unconfirmed', error instanceof NatappError ? error.message : '无法确认 NATAPP 状态。'); }
    if (!record) {
      try { return await readNatappSettings(this.dataDir) ? this.set('stopped', 'HajiMink 启动的 NATAPP 未运行。') : this.set('unconfigured', '请选择 NATAPP 客户端和配置文件。'); }
      catch { return this.set('configuration-error', 'NATAPP 配置记录无效，请检查后重试。'); }
    }
    if (record.phase !== 'running' || !record.processId || !record.creation) return this.set('unconfirmed', 'NATAPP 启动状态尚未确认，请检查原进程；不会结束未知进程。');
    try {
      const actual = await this.inspect(this.nativePath, record.processId, this.expected(record));
      if (actual.creation !== record.creation || actual.image.toLowerCase() !== record.binaryPath.toLowerCase()) throw new Error('identity');
      return this.set('running', 'NATAPP 客户端运行中；请检查远程入口确认连接。', true, record.processId);
    } catch {
      if (this.child && this.child.pid === record.processId && this.child.exitCode !== null) {
        await this.forget(record.instanceId); this.child = null;
        return this.set('error', 'HajiMink 启动的 NATAPP 已退出，请检查客户端配置。');
      }
      // A missing/reused PID alone is not enough: do not discard the record
      // while any NATAPP process could still be using the user's tunnel.
      try {
        if (await this.originalGone(this.nativePath, record.processId, record.creation) && await this.countProcesses(this.nativePath) === 0 && await this.forget(record.instanceId)) {
          this.child = null;
          return this.set('stopped', '之前启动的 NATAPP 已退出，可以重新启动。');
        }
      } catch {}
      return this.set('unconfirmed', '无法确认 NATAPP 进程身份；不会接管或结束未知进程。');
    }
  }
  async startInternal() {
    if (this.platform !== 'win32') return this.set('unsupported', '当前系统暂不支持本机 NATAPP 管理。');
    let record, child;
    try {
      const existing = await this.readRecord();
      if (existing) {
        const current = await this.refreshInternal();
        if (current.state !== 'stopped') return current;
      }
      const settings = await readNatappSettings(this.dataDir);
      if (!settings) return this.set('unconfigured', '请先选择 NATAPP 客户端和配置文件。');
      const binaryPath = await selectedFile(settings.binaryPath, 'binary');
      const configPath = await selectedFile(settings.configPath, 'config');
      if (binaryPath.toLowerCase() !== settings.binaryPath.toLowerCase() || configPath.toLowerCase() !== settings.configPath.toLowerCase()) throw new NatappError('所选 NATAPP 文件位置已变化，请重新选择');
      if (!this.verifyGateway || !(await this.verifyGateway())) throw new NatappError('请先确认本机网关已开启独立登录或受限首次设置');
      if (await this.countProcesses(this.nativePath) > 0) throw new NatappError('检测到已有 NATAPP 进程；请自行管理该进程，或停止后再由 HajiMink 启动');
      record = { version: 1, instanceId: randomUUID(), phase: 'starting', binaryPath, configPath, processId: null, creation: null };
      await fs.writeFile(this.recordPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$|^ELECTRON_RUN_AS_NODE$/i.test(key)) delete env[key];
      child = this.spawnImpl(binaryPath, [`-config=${configPath}`, '-log=none'], { cwd: path.dirname(binaryPath), env, detached: true, windowsHide: true, stdio: 'ignore' });
      child.on('error', () => {}); this.child = child;
      child.once('exit', () => void this.enqueue(async () => {
        if (this.child !== child || this.stopping) return;
        await this.forget(record.instanceId); this.child = null;
        this.set('error', 'HajiMink 启动的 NATAPP 已退出，请检查客户端配置。');
      }));
      if (!child.pid) throw new NatappError('NATAPP 客户端未能启动');
      record.processId = child.pid; await this.replaceRecord(record);
      let identity; const deadline = Date.now() + 3000;
      do {
        if (child.exitCode !== null || child.signalCode !== null) break;
        identity = await this.inspect(this.nativePath, child.pid, this.expected(record)).catch(() => null);
        if (!identity) await delay(100);
      } while (!identity && Date.now() < deadline);
      if (!identity || identity.image.toLowerCase() !== binaryPath.toLowerCase()) throw new NatappError('无法确认新启动的 NATAPP 进程身份，已保留实例记录');
      record.creation = identity.creation; record.phase = 'running'; await this.replaceRecord(record);
      child.unref(); await delay(300);
      if (child.exitCode !== null || child.signalCode !== null) throw new NatappError('NATAPP 客户端已退出，请检查配置文件');
      return this.set('running', 'NATAPP 客户端运行中；请检查远程入口确认连接。', true, child.pid);
    } catch (error) {
      if (record && (!child?.pid || child.exitCode !== null || child.signalCode !== null)) { await this.forget(record.instanceId); if (this.child === child) this.child = null; }
      const remains = !!record && !!child?.pid && child.exitCode === null && child.signalCode === null;
      return this.set(remains ? 'unconfirmed' : 'error', error instanceof NatappError ? error.message : 'NATAPP 启动失败，请检查文件和配置。');
    }
  }
  async stopInternal() {
    if (this.platform !== 'win32') return this.set('unsupported', '当前系统暂不支持本机 NATAPP 管理。');
    let record;
    try { record = await this.readRecord(); }
    catch { return this.set('unconfirmed', 'NATAPP 实例记录无法确认；不会结束未知进程。'); }
    if (!record) return this.refreshInternal();
    if (record.phase !== 'running' || !record.processId || !record.creation) return this.set('unconfirmed', 'NATAPP 启动状态尚未确认；不会结束未知进程。');
    this.stopping = true;
    try {
      const actual = await this.inspect(this.nativePath, record.processId, this.expected(record));
      if (actual.creation !== record.creation || actual.image.toLowerCase() !== record.binaryPath.toLowerCase()) throw new Error('identity');
      await this.stopProcess(this.nativePath, record.processId, this.expected(record));
      this.child = null;
      if (!(await this.forget(record.instanceId))) return this.set('unconfirmed', 'NATAPP 已停止，但实例记录未能清理；请检查后重试。');
      return this.set('stopped', 'HajiMink 启动的 NATAPP 已停止。');
    } catch {
      const state = await this.refreshInternal();
      if (['stopped', 'error'].includes(state.state)) return state;
      return this.set('unconfirmed', '无法确认或停止本程序启动的 NATAPP；不会结束未知进程。');
    }
    finally { this.stopping = false; }
  }
}
module.exports = { NatappManager, readNatappSettings, saveNatappSettings, validateSettings, localPath, NatappError };
