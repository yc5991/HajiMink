import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { applyPatches, enablePatches, type Patch } from 'immer';
import { IpcClient, nativeRequest } from './pipe-client.js';
import { normalizeState, normalizeStored, rawTurns, normalizeRequests } from './normalizer.js';
import { AppError, messageOf } from './errors.js';
import type { DesktopStatus, ModelOption, Project, ThreadSummary, ThreadView } from '../shared/types.js';

enablePatches();
const exec = promisify(execFile);
// Packaged applications may run with an empty PATH. Use the Windows system path
// instead of relying on shell search, without invoking a command shell.
export function powershellExecutable(): string {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR;
  return process.platform === 'win32' && windowsRoot ? path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
}
export const SUPPORTED_DESKTOP = '26.1021.3705.0';
export const LIMITED_DESKTOP = '26.1023.6123.0';
export const SUPPORTED_DESKTOP_FAMILY = '26.x';
export function desktopAccess(version: string): 'full' | 'limited' | 'blocked' {
  return /^26(?:\.\d+){1,4}$/.test(version) ? 'full' : 'blocked';
}
type CachedState = { owner: string; revision: number; state: any; usedAt: number };
export class CodexDesktopAdapter extends EventEmitter {
  readonly ipc = new IpcClient();
  readonly codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  status: DesktopStatus = { connected: false, compatible: false, accessMode: 'blocked', version: null, supportedVersion: SUPPORTED_DESKTOP_FAMILY, reason: '正在连接桌面应用' };
  private states = new Map<string, CachedState>();
  private snapshotWaiters = new Map<string, Promise<void>>();
  private snapshotAborters = new Map<string, AbortController>();
  private connectionEpoch = 0;
  private closed = false;
  private dirtyTimers = new Map<string, NodeJS.Timeout>();
  private appToolsPipe?: string;
  private contextThreadId?: string;
  private tools: any[] = [];
  private threads: ThreadSummary[] = [];
  private projects: Project[] = [];
  private catalogAt = 0;
  private monitoring?: NodeJS.Timeout;
  private catalogLoading?: Promise<void>;
  private refreshing = false;

  constructor() {
    super();
    this.ipc.on('broadcast', m => this.onBroadcast(m));
    this.ipc.on('offline', () => {
      this.invalidateCaches();
      if (!this.closed && this.status.connected) this.updateStatus({ ...this.status, connected: false, compatible: false, accessMode: 'blocked', reason: 'Codex 桌面连接已断开' });
    });
  }
  private invalidateCaches() {
    this.connectionEpoch++;
    this.appToolsPipe = undefined; this.contextThreadId = undefined; this.tools = [];
    this.catalogAt = 0; this.projects = []; this.threads = []; this.catalogLoading = undefined;
    this.states.clear(); this.snapshotWaiters.clear();
    for (const controller of this.snapshotAborters.values()) controller.abort();
    this.snapshotAborters.clear();
    for (const timer of this.dirtyTimers.values()) clearTimeout(timer);
    this.dirtyTimers.clear();
  }
  private async detectDesktopVersion(): Promise<string | null> {
    const { stdout } = await exec(powershellExecutable(), ['-NoProfile', '-NonInteractive', '-Command', "Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path"], { windowsHide: true, timeout: 12000 });
    return /OpenAI\.Codex_([\d.]+)_/.exec(stdout)?.[1] || null;
  }
  private findToolPipes(): string[] { return fs.readdirSync('\\\\.\\pipe\\').filter(name => name.startsWith('codex-app-tools-')); }
  private readContextThreadId(): string | undefined {
    // Metadata only; never migrate or write the Codex database.
    const db = new DatabaseSync(path.join(this.codexHome, 'state_5.sqlite'), { readOnly: true });
    try { return (db.prepare('SELECT id FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT 1').get() as any)?.id; }
    finally { db.close(); }
  }
  private callNative(pipe: string, method: string, params?: unknown, timeoutMs?: number) { return nativeRequest(pipe, method, params, timeoutMs); }
  private assertConnectionEpoch(epoch: number, pipe?: string) {
    if (this.closed || this.connectionEpoch !== epoch || !this.ipc.connected || (pipe !== undefined && this.appToolsPipe !== pipe))
      throw new AppError('DESKTOP_OFFLINE', '桌面连接已变更，请核实状态后再操作', 503);
  }
  async start() {
    await this.refreshConnection();
    if (this.closed || this.monitoring) return;
    this.monitoring = setInterval(() => { void this.refreshConnection(); this.evict(); }, 10000);
    this.monitoring.unref();
  }
  private updateStatus(status: DesktopStatus) {
    if (JSON.stringify(status) !== JSON.stringify(this.status)) { this.status = status; this.emit('desktop', status); }
  }
  async refreshConnection() {
    if (this.refreshing || this.closed) return;
    this.refreshing = true;
    try {
      const version = await this.detectDesktopVersion();
      if (this.closed) return;
      if (!version) throw new AppError('DESKTOP_OFFLINE', '请在 Windows 上打开 Codex 桌面应用', 503);
      if (this.status.version !== version) {
        this.updateStatus({ connected: false, compatible: false, accessMode: 'blocked', version, supportedVersion: SUPPORTED_DESKTOP_FAMILY, reason: '正在检查桌面版本' });
        this.invalidateCaches(); this.ipc.close();
      }
      const accessMode = desktopAccess(version);
      if (accessMode === 'blocked') {
        this.invalidateCaches(); this.ipc.close();
        this.updateStatus({ connected: false, compatible: false, accessMode, version, supportedVersion: SUPPORTED_DESKTOP_FAMILY, reason: `桌面版本 ${version} 尚未通过兼容验证，暂时无法连接` }); return;
      }
      const candidates = this.findToolPipes();
      if (!candidates.length) throw new AppError('DESKTOP_OFFLINE', '等待桌面工具桥就绪', 503);
      const candidate = this.appToolsPipe?.split('\\').pop();
      if (!candidate || !candidates.includes(candidate)) {
        if (candidates.length > 1) throw new AppError('AMBIGUOUS_DESKTOP', '检测到多个桌面工具桥，请关闭多余实例后重试', 503);
        if (candidate) {
          this.updateStatus({ ...this.status, connected: false, compatible: false, accessMode: 'blocked', reason: '正在检查桌面版本' });
          this.invalidateCaches();
        }
        this.appToolsPipe = `\\\\.\\pipe\\${candidates[0]}`;
      }
      const pipe = this.appToolsPipe!, epoch = this.connectionEpoch;
      if (!this.contextThreadId) this.contextThreadId = this.readContextThreadId();
      if (!this.contextThreadId) throw new AppError('NO_DESKTOP_THREAD', '请先在桌面端建立一个本机会话', 503);
      await this.ipc.connect(); this.assertConnectionEpoch(epoch, pipe);
      if (!this.tools.length) {
        const result = await this.callNative(pipe, 'tools/list', { threadStartKind: 'all' });
        this.assertConnectionEpoch(epoch, pipe);
        if (!Array.isArray(result?.tools) || !['list_projects', 'list_threads', 'read_thread'].every(name => result.tools.some((tool: any) => tool?.name === name))) {
          throw new AppError('DESKTOP_PROTOCOL', '桌面只读接口不完整，暂时无法连接', 503);
        }
        this.tools = result.tools;
      }
      this.assertConnectionEpoch(epoch, pipe);
      this.updateStatus({ connected: true, compatible: true, accessMode, version, supportedVersion: SUPPORTED_DESKTOP_FAMILY });
    } catch (error) {
      if (!this.closed) {
        const reason = messageOf(error);
        this.invalidateCaches(); this.ipc.close();
        this.updateStatus({ ...this.status, connected: false, compatible: false, accessMode: 'blocked', reason });
      }
    } finally { this.refreshing = false; }
  }
  assertReady() {
    if (!this.status.connected || (!this.status.compatible && this.status.accessMode !== 'read-only')) throw new AppError('DESKTOP_OFFLINE', this.status.reason || '桌面应用不可用', 503);
  }
  private assertWritable(action: 'create' | 'send' | 'interrupt' | 'settings' | 'respond') {
    this.assertReady();
    if (!this.status.compatible || this.status.accessMode === 'read-only') throw new AppError('DESKTOP_READ_ONLY', this.status.reason || '当前桌面版本仅支持查看', 409);
    if (this.status.accessMode === 'limited' && (action === 'settings' || action === 'respond')) throw new AppError('DESKTOP_UNVERIFIED', '此版本的设置和审批尚未验证，请在 Codex 桌面处理', 409);
  }
  private assertLimitedSend(state: any, model?: string, thinking?: string) {
    if (this.status.accessMode !== 'limited') return;
    if (!state) throw new AppError('DESKTOP_REQUIRED', '请先在 Codex 桌面打开该会话，再返回发送', 409);
    if (rawTurns(state).some(turn => turn.status === 'inProgress' || turn.status === 'running')) throw new AppError('DESKTOP_UNVERIFIED', '当前版本暂不支持执行中追加消息，请等待完成或在 Codex 中处理', 409);
    if ((model && model !== state.latestModel) || (thinking && thinking !== state.latestReasoningEffort)) throw new AppError('DESKTOP_UNVERIFIED', '此版本暂不支持修改模型或思考强度，请在 Codex 中设置', 409);
  }
  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
    this.assertReady();
    if (!['list_projects', 'list_threads', 'read_thread', 'create_thread', 'send_message_to_thread'].includes(name)) throw new AppError('FORBIDDEN_ACTION', '未开放此桌面动作', 403);
    if (this.tools.length && !this.tools.some(tool => tool?.name === name)) throw new AppError('DESKTOP_UNSUPPORTED_ACTION', '当前 Codex 桌面未提供此接口，请在桌面中操作', 409);
    if (name === 'create_thread') {
      this.assertWritable('create');
      if (this.status.accessMode === 'limited') {
        const target = args.target as any;
        if (target?.type !== 'project' || target?.environment?.type !== 'local' || typeof target?.projectId !== 'string' || !target.projectId || args.model !== undefined || args.thinking !== undefined) throw new AppError('DESKTOP_UNVERIFIED', '当前版本请先选择已有项目，使用桌面默认模型创建会话', 409);
      }
    }
    if (name === 'send_message_to_thread') {
      this.assertWritable('send');
      if (this.status.accessMode === 'limited') throw new AppError('DESKTOP_REQUIRED', '请先在 Codex 桌面打开该会话，再返回发送', 409);
    }
    const pipe = this.appToolsPipe, epoch = this.connectionEpoch;
    if (!pipe) throw new AppError('DESKTOP_OFFLINE', '桌面连接不可用', 503);
    const response = await this.callNative(pipe, 'tools/call', { callerSource: 'codex', namespace: 'codex_app', tool: name, arguments: args, hostId: 'local', threadId: this.contextThreadId, turnId: `agent-control-${randomUUID()}`, callId: randomUUID() }, timeoutMs);
    // A write may have reached the old desktop; surface an unknown outcome instead
    // of accepting its late response or automatically retrying on the new one.
    this.assertConnectionEpoch(epoch, pipe); this.assertReady();
    const text = (response.contentItems || []).filter((x: any) => x.type === 'inputText').map((x: any) => x.text).join('\n');
    if (!response.success) throw new AppError('DESKTOP_ACTION_FAILED', text.slice(0, 600) || '桌面端未接受操作', 409);
    try { return JSON.parse(text); } catch { return { message: text }; }
  }
  async catalog(force = false) {
    this.assertReady();
    if (!force && Date.now() - this.catalogAt < 5000) return { projects: this.projects, threads: this.threads };
    if (!this.catalogLoading) {
      const loading = this.loadCatalog().finally(() => { if (this.catalogLoading === loading) this.catalogLoading = undefined; });
      this.catalogLoading = loading;
    }
    await this.catalogLoading; return { projects: this.projects, threads: this.threads };
  }
  private async loadCatalog() {
    const epoch = this.connectionEpoch;
    const [projects, threads] = await Promise.all([this.callTool('list_projects', {}), this.callTool('list_threads', { limit: 50 })]);
    const nextProjects: Project[] = (projects.projects || []).filter((p: any) => p.projectKind === 'local' && p.hostId === 'local').map((p: any) => ({ id: p.projectId, name: p.label, path: p.path, hostId: p.hostId }));
    const all = [...(threads.pinnedThreads || []).map((t: any) => ({ ...t, pinned: true })), ...(threads.threads || [])];
    const recent: ThreadSummary[] = all.filter((t: any) => t.kind === 'codex' && t.hostId === 'local').map((t: any) => ({ id: t.id, title: t.title || '未命名会话', projectId: t.projectId || null, cwd: t.cwd, status: t.status, updatedAt: t.updatedAt, pinned: t.pinned }));
    // The desktop tool limits recents to 50. Read only metadata for the older local catalog.
    const globalState = JSON.parse(await fsp.readFile(path.join(this.codexHome, '.codex-global-state.json'), 'utf8'));
    const mapping = globalState['app-server-project-id-by-legacy-project-id-by-host']?.[`local:${this.codexHome}`] || {};
    const legacyById = Object.fromEntries(Object.entries(mapping).map(([legacy, native]) => [String(native), legacy]));
    const db = new DatabaseSync(path.join(this.codexHome, 'state_5.sqlite'), { readOnly: true });
    let stored: ThreadSummary[];
    try {
      stored = (db.prepare('SELECT id,name,title,cwd,updated_at,source,is_pinned,project_id,agent_role FROM threads WHERE archived=0 ORDER BY updated_at DESC').all() as any[])
        .filter(row => /^(?:\\\\\?\\)?[a-z]:[\\/]/i.test(row.cwd || '') && !row.agent_role && row.source !== 'exec' && !/subagent/i.test(String(row.source)))
        .map(row => ({ id: row.id, title: row.name || row.title || '未命名会话', projectId: globalState['thread-project-assignments']?.[row.id]?.projectId || legacyById[row.project_id] || null, cwd: row.cwd.replace(/^\\\\\?\\/, ''), status: 'idle', updatedAt: row.updated_at, pinned: !!row.is_pinned }));
    } finally { db.close(); }
    const byId = new Map(stored.map(t => [t.id, t]));
    for (const thread of recent) byId.set(thread.id, thread);
    this.assertConnectionEpoch(epoch); this.assertReady();
    this.projects = nextProjects;
    this.threads = [...byId.values()].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
    this.catalogAt = Date.now();
  }
  async requireThread(id: string) {
    const { threads } = await this.catalog();
    if (!threads.some(t => t.id === id)) { const fresh = await this.catalog(true); if (!fresh.threads.some(t => t.id === id)) throw new AppError('THREAD_NOT_FOUND', '本机会话不存在或未接入', 404); }
  }
  private async owner(id: string) {
    const response = await this.ipc.request('thread-owner-discovery', { hostId: 'local', conversationId: id });
    return response.handledByClientId as string;
  }
  async ensureLive(id: string): Promise<CachedState | undefined> {
    this.assertReady();
    const cached = this.states.get(id);
    if (cached?.state) { cached.usedAt = Date.now(); return cached; }
    if (this.snapshotWaiters.has(id)) { await this.snapshotWaiters.get(id); return this.states.get(id); }
    const epoch = this.connectionEpoch;
    const wait = (async () => {
      let owner: string;
      try { owner = await this.owner(id); } catch { return; }
      if (!owner || this.closed || epoch !== this.connectionEpoch || !this.status.connected) return;
      const entry: CachedState = { owner, state: undefined, revision: 0, usedAt: Date.now() };
      this.states.set(id, entry);
      const controller = new AbortController(); this.snapshotAborters.set(id, controller);
      const timer = setTimeout(() => controller.abort(), 6000); timer.unref();
      const arrived = once(this, `snapshot:${id}`, { signal: controller.signal });
      let following = false;
      try { this.ipc.following(id, owner, true); following = true; await arrived; }
      catch {
        controller.abort(); await arrived.catch(() => {});
        if (following && epoch === this.connectionEpoch && this.ipc.connected) { try { this.ipc.following(id, owner, false); } catch {} }
        if (this.states.get(id) === entry) this.states.delete(id);
      } finally {
        clearTimeout(timer);
        if (this.snapshotAborters.get(id) === controller) this.snapshotAborters.delete(id);
      }
    })();
    this.snapshotWaiters.set(id, wait);
    try { await wait; } finally { if (this.snapshotWaiters.get(id) === wait) this.snapshotWaiters.delete(id); }
    return epoch === this.connectionEpoch ? this.states.get(id) : undefined;
  }
  private onBroadcast(message: any) {
    if (message.method === 'client-status-changed' && message.params?.status === 'disconnected') {
      for (const [id, cached] of this.states) if (cached.owner === message.params.clientId) { this.snapshotAborters.get(id)?.abort(); this.states.delete(id); this.emit('invalidated', id); }
      return;
    }
    if (message.method !== 'thread-stream-state-changed' || message.params?.hostId !== 'local' || message.version !== 11) return;
    const id = message.params.conversationId; const cached = this.states.get(id);
    if (!cached || cached.owner !== message.sourceClientId) return;
    const change = message.params.change;
    if (change.type === 'snapshot') {
      cached.state = change.conversationState; cached.revision = change.revision; this.emit(`snapshot:${id}`);
    } else if (change.type === 'patches') {
      if (cached.revision !== change.baseRevision) { this.requestSnapshot(id, cached); return; }
      try { cached.state = applyPatches(cached.state, change.patches as Patch[]); cached.revision = change.revision; }
      catch { this.requestSnapshot(id, cached); return; }
    } else return;
    if (!this.dirtyTimers.has(id)) this.dirtyTimers.set(id, setTimeout(() => { this.dirtyTimers.delete(id); this.emit('thread', id); }, 120));
  }
  private requestSnapshot(id: string, cached: CachedState) {
    cached.revision = -1;
    try { this.ipc.following(id, cached.owner, false); this.ipc.following(id, cached.owner, true); } catch { this.states.delete(id); }
  }
  async view(id: string, limit = 20, cursor?: string): Promise<ThreadView> {
    await this.requireThread(id);
    const cached = await this.ensureLive(id);
    if (cached?.state) return { ...normalizeState(cached.state, cached.revision, limit, cursor), epoch: createHash('sha256').update(cached.owner).digest('hex').slice(0, 16) };
    const stored = await this.callTool('read_thread', { threadId: id, hostId: 'local', turnLimit: Math.min(limit, 10), includeOutputs: true, maxOutputCharsPerItem: 16000, ...(cursor ? { cursor } : {}) });
    return normalizeStored(stored, null);
  }
  viewCached(id: string, limit = 20) { const cached = this.states.get(id); return cached?.state ? { ...normalizeState(cached.state, cached.revision, limit), epoch: createHash('sha256').update(cached.owner).digest('hex').slice(0, 16) } : undefined; }
  async send(id: string, prompt: string, model?: string, thinking?: string) {
    this.assertWritable('send'); const epoch = this.connectionEpoch;
    await this.requireThread(id);
    this.assertWritable('send'); this.assertConnectionEpoch(epoch);
    const cached = await this.ensureLive(id);
    this.assertWritable('send'); this.assertConnectionEpoch(epoch); this.assertLimitedSend(cached?.state, model, thinking);
    if (cached?.state) {
      if ((model && model !== cached.state.latestModel) || (thinking && thinking !== cached.state.latestReasoningEffort)) await this.settings(id, model || cached.state.latestModel, thinking || cached.state.latestReasoningEffort);
      const clientUserMessageId = randomUUID();
      const input = [{ type: 'text', text: prompt, text_elements: [] }];
      const restoreMessage = { id: clientUserMessageId, text: prompt, cwd: cached.state.cwd, createdAt: Date.now(), context: { prompt, addedFiles: [], fileAttachments: [], ideContext: null, imageAttachments: [], workspaceRoots: [cached.state.cwd || this.codexHome] } };
      const active = rawTurns(cached.state).some(t => t.status === 'inProgress' || t.status === 'running');
      this.assertWritable('send'); this.assertConnectionEpoch(epoch); this.assertLimitedSend(cached.state, model, thinking);
      if (active) await this.ipc.request('thread-follower-steer-turn', { conversationId: id, input, restoreMessage, clientUserMessageId }, 1, cached.owner, 30000);
      else await this.ipc.request('thread-follower-start-turn', { conversationId: id, turnStart: { request: { threadId: id, input, clientUserMessageId }, context: { restoreMessage } } }, 2, cached.owner, 30000);
      this.assertConnectionEpoch(epoch);
    } else await this.callTool('send_message_to_thread', { threadId: id, hostId: 'local', prompt, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) }, 45000);
    // The desktop already confirmed the operation. A subsequent refresh failure
    // must not turn that confirmed acceptance into an unknown submission.
    this.catalogAt = 0; this.states.delete(id); await this.ensureLive(id).catch(() => undefined);
    return { accepted: true, threadId: id };
  }
  async create(prompt: string, projectId?: string, model?: string, thinking?: string) {
    this.assertWritable('create'); const epoch = this.connectionEpoch;
    if (this.status.accessMode === 'limited' && (!projectId || model || thinking)) throw new AppError('DESKTOP_UNVERIFIED', '当前版本请先选择已有项目，使用桌面默认模型创建会话', 409);
    const { projects } = await this.catalog();
    this.assertWritable('create'); this.assertConnectionEpoch(epoch);
    if (projectId && !projects.some(p => p.id === projectId)) throw new AppError('PROJECT_NOT_FOUND', '请选择已有本机项目', 404);
    const result = await this.callTool('create_thread', { prompt, target: projectId ? { type: 'project', projectId, environment: { type: 'local' } } : { type: 'projectless' }, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) }, 45000);
    this.catalogAt = 0;
    const threadId = result.threadId || result.id;
    if (!threadId) return { pending: true, clientThreadId: result.clientThreadId, message: '桌面正在准备新会话，请刷新列表查看' };
    try { await this.catalog(true); await this.ensureLive(threadId); this.emit('catalog'); } catch { /* Creation was already confirmed; later refresh is optional. */ }
    return { threadId, accepted: true };
  }
  async interrupt(id: string, expectedTurnId: string) {
    this.assertWritable('interrupt'); const epoch = this.connectionEpoch;
    await this.requireThread(id); this.assertWritable('interrupt'); this.assertConnectionEpoch(epoch);
    const cached = await this.ensureLive(id);
    this.assertWritable('interrupt'); this.assertConnectionEpoch(epoch);
    if (!cached) throw new AppError('NO_LIVE_OWNER', '请先在桌面打开该会话', 409);
    const active = [...rawTurns(cached.state)].reverse().find(t => t.status === 'inProgress' || t.status === 'running');
    if (!active || active.turnId !== expectedTurnId) throw new AppError('STALE_TURN', '该轮执行已结束或发生变化', 409);
    this.assertWritable('interrupt'); this.assertConnectionEpoch(epoch);
    await this.ipc.request('thread-follower-interrupt-turn', { conversationId: id, mode: 'user-stop', expectedTurnId }, 4, cached.owner, 30000);
    this.assertConnectionEpoch(epoch); return { accepted: true };
  }
  async settings(id: string, model: string, effort?: string) {
    this.assertWritable('settings'); const epoch = this.connectionEpoch;
    await this.requireThread(id); this.assertWritable('settings'); this.assertConnectionEpoch(epoch);
    const cached = await this.ensureLive(id);
    this.assertWritable('settings'); this.assertConnectionEpoch(epoch);
    if (!cached) throw new AppError('NO_LIVE_OWNER', '请先在桌面打开该会话，或发送时选择模型', 409);
    if (!cached.state.latestThreadSettings || typeof cached.state.latestThreadSettings !== 'object') throw new AppError('DESKTOP_REQUIRED', '尚未读到完整桌面设置，请在桌面打开会话后重试', 409);
    const settings = structuredClone(cached.state.latestThreadSettings);
    effort ??= settings.effort || settings.collaborationMode?.settings?.reasoning_effort;
    const models = this.models(); if (!models.some(m => m.id === model && effort && m.efforts.includes(effort))) throw new AppError('INVALID_MODEL', '不支持所选模型和思考强度');
    settings.model = model; settings.effort = effort;
    if (settings.collaborationMode?.settings) { settings.collaborationMode.settings.model = model; settings.collaborationMode.settings.reasoning_effort = effort; }
    this.assertWritable('settings'); this.assertConnectionEpoch(epoch);
    const result = await this.ipc.request('thread-follower-update-thread-settings', { conversationId: id, threadSettings: settings }, 2, cached.owner, 30000);
    this.assertConnectionEpoch(epoch);
    if (result.result?.applied === false) throw new AppError('SETTINGS_NOT_APPLIED', '桌面端未应用设置，请刷新后重试', 409);
    return { accepted: true };
  }
  async respond(id: string, requestId: string, turnId: string, response: any) {
    this.assertWritable('respond'); const epoch = this.connectionEpoch;
    await this.requireThread(id); this.assertWritable('respond'); this.assertConnectionEpoch(epoch);
    const cached = await this.ensureLive(id);
    this.assertWritable('respond'); this.assertConnectionEpoch(epoch);
    if (!cached) throw new AppError('NO_LIVE_OWNER', '会话暂未连接', 409);
    const requests = normalizeRequests(cached.state);
    const request = requests.find(r => r.id === requestId && r.turnId === turnId);
    if (!request) throw new AppError('STALE_REQUEST', '此请求已被处理或已失效', 409);
    if (requestId.startsWith('async:')) {
      const answers = (request.questions || []).map(q => {
        const value = response.answers?.[q.id];
        if (!Array.isArray(value) || !value.length || value.some((v: any) => typeof v !== 'string' || v.length > 6000)) throw new AppError('INVALID_RESPONSE', '请填写所有问题');
        return { questionItemId: q.id, question: q.question, answer: value.join('\n') };
      });
      this.assertWritable('respond'); this.assertConnectionEpoch(epoch);
      await this.send(id, `<send_user_message_question_reply>\n${JSON.stringify(answers)}\n</send_user_message_question_reply>`);
      return { accepted: true };
    }
    const raw = (cached.state.requests || []).find((r: any) => String(r.id) === requestId);
    const params: any = { conversationId: id, requestId: raw.id };
    let method = '';
    if (request.kind === 'command' || request.kind === 'file') {
      if (!['accept', 'decline', 'cancel'].includes(response.decision)) throw new AppError('INVALID_RESPONSE', '请选择允许、拒绝或取消');
      if (request.decisions?.length && !request.decisions.includes(response.decision)) throw new AppError('INVALID_RESPONSE', '该审批不支持此选择');
      method = request.kind === 'command' ? 'thread-follower-command-approval-decision' : 'thread-follower-file-approval-decision'; params.decision = response.decision;
    } else if (request.kind === 'input') {
      method = 'thread-follower-submit-user-input'; const answers: Record<string, { answers: string[] }> = {};
      for (const q of request.questions || []) { const value = response.answers?.[q.id]; if (!Array.isArray(value) || !value.length || value.some((v: any) => typeof v !== 'string' || v.length > 6000)) throw new AppError('INVALID_RESPONSE', '请填写所有问题'); answers[q.id] = { answers: value }; }
      params.response = { answers };
    } else if (request.kind === 'permissions') {
      // The first release supports declining privilege expansion, keeping the desktop permission boundary intact.
      if (response.decision !== 'decline') throw new AppError('DESKTOP_REQUIRED', '权限扩展请在桌面端审阅；网页可拒绝此请求', 409);
      method = 'thread-follower-permissions-request-approval-response'; params.response = { permissions: {}, scope: 'turn' };
    } else if (request.kind === 'elicitation') {
      if (!['accept', 'decline', 'cancel'].includes(response.decision)) throw new AppError('INVALID_RESPONSE', '无效的确认选项');
      if (response.decision === 'accept' && raw.params?.requestedSchema) throw new AppError('DESKTOP_REQUIRED', '此工具表单请在桌面端填写', 409);
      method = 'thread-follower-submit-mcp-server-elicitation-response'; params.response = { action: response.decision, content: null };
    } else throw new AppError('DESKTOP_REQUIRED', '此请求请在桌面端处理', 409);
    this.assertWritable('respond'); this.assertConnectionEpoch(epoch);
    await this.ipc.request(method, params, 1, cached.owner, 30000);
    this.assertConnectionEpoch(epoch); return { accepted: true };
  }
  models(): ModelOption[] {
    const description: string = this.tools.find(t => t.name === 'send_message_to_thread')?.inputSchema?.properties?.model?.description || '';
    const pairs = [...description.matchAll(/(gpt-[\w.-]+)\s*\([^)]*?supported reasoning efforts:\s*([^)]+)\)/g)];
    return pairs.map(m => ({ id: m[1], efforts: m[2].split(',').map(x => x.trim()).filter(Boolean) }));
  }
  private evict() {
    for (const [id, cached] of this.states) if (Date.now() - cached.usedAt > 5 * 60000) {
      try { if (this.ipc.connected) this.ipc.following(id, cached.owner, false); } catch {}
      this.states.delete(id);
    }
  }
  touch(id: string) { const state = this.states.get(id); if (state) state.usedAt = Date.now(); }
  close() { this.closed = true; clearInterval(this.monitoring); this.invalidateCaches(); this.ipc.close(); }
}
