import { EventEmitter } from 'node:events';
import type { DesktopStatus, HarnessCapabilities, HarnessInfo, ModelOption, Project, ThreadSummary, ThreadView } from '../shared/types.js';
import { AppError } from './errors.js';

/** Adapters normalize their own protocol; the gateway never forwards arbitrary native actions. */
export interface HarnessAdapter extends EventEmitter {
  status: DesktopStatus;
  start(): Promise<void>;
  close(): void;
  catalog(force?: boolean): Promise<{ projects: Project[]; threads: ThreadSummary[] }>;
  models(): ModelOption[];
  view(id: string, limit?: number, cursor?: string): Promise<ThreadView>;
  viewCached(id: string, limit?: number): ThreadView | undefined;
  touch(id: string): void;
  create(prompt: string, projectId?: string, model?: string, thinking?: string): Promise<unknown>;
  send(id: string, prompt: string, model?: string, thinking?: string): Promise<unknown>;
  interrupt(id: string, expectedTurnId: string): Promise<unknown>;
  settings(id: string, model: string, effort?: string): Promise<unknown>;
  respond(id: string, requestId: string, turnId: string, response: any): Promise<unknown>;
}
export const fullCapabilities: HarnessCapabilities = { read: true, create: true, send: true, interrupt: true, settings: true, respond: true };
const noCapabilities: HarnessCapabilities = { read: false, create: false, send: false, interrupt: false, settings: false, respond: false };
export class HarnessRegistry {
  private entries = new Map<string, { name: string; adapter?: HarnessAdapter; capabilities: HarnessCapabilities; reason?: string }>();
  register(id: string, name: string, adapter: HarnessAdapter, capabilities: HarnessCapabilities) {
    this.add(id, { name, adapter, capabilities }); return this;
  }
  plan(id: string, name: string, reason: string) { this.add(id, { name, capabilities: noCapabilities, reason }); return this; }
  private add(id: string, entry: { name: string; adapter?: HarnessAdapter; capabilities: HarnessCapabilities; reason?: string }) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(id) || this.entries.has(id)) throw new Error(`Invalid or duplicate harness: ${id}`);
    this.entries.set(id, entry);
  }
  private capabilities(entry: { adapter?: HarnessAdapter; capabilities: HarnessCapabilities }): HarnessCapabilities {
    if (entry.adapter?.status.accessMode === 'read-only') return { ...noCapabilities, read: entry.capabilities.read };
    if (entry.adapter?.status.accessMode === 'limited') return { ...entry.capabilities, settings: false, respond: false };
    return { ...entry.capabilities };
  }
  list(): HarnessInfo[] {
    return [...this.entries].map(([id, entry]) => ({ id, name: entry.name, state: entry.adapter ? 'available' : 'planned', capabilities: this.capabilities(entry), status: entry.adapter?.status || { connected: false, compatible: false, version: null, supportedVersion: '', reason: entry.reason } }));
  }
  info(id: string) {
    const info = this.list().find(entry => entry.id === id);
    if (!info) throw new AppError('UNKNOWN_HARNESS', '找不到这个 Agent 软件', 404);
    return info;
  }
  require(id = 'codex', capability: keyof HarnessCapabilities = 'read') {
    const entry = this.entries.get(id);
    if (!entry) throw new AppError('UNKNOWN_HARNESS', '找不到这个 Agent 软件', 404);
    if (!entry.adapter) throw new AppError('HARNESS_NOT_READY', entry.reason || '这个软件尚未接入', 409);
    if (!this.capabilities(entry)[capability]) {
      if (entry.adapter.status.accessMode === 'read-only' && capability !== 'read') throw new AppError('DESKTOP_READ_ONLY', entry.adapter.status.reason || '当前桌面版本仅支持查看', 409);
      if (entry.adapter.status.accessMode === 'limited' && (capability === 'settings' || capability === 'respond')) throw new AppError('DESKTOP_UNVERIFIED', '此版本的设置和审批尚未验证，请在 Codex 桌面处理', 409);
      throw new AppError('UNSUPPORTED_CAPABILITY', '这个软件尚不支持此操作', 409);
    }
    return entry.adapter;
  }
  available() { return [...this.entries].flatMap(([id, entry]) => entry.adapter ? [{ id, adapter: entry.adapter }] : []); }
  async start() { await Promise.all(this.available().map(({ adapter }) => adapter.start())); }
  close() { for (const { adapter } of this.available()) adapter.close(); }
}
// Keep existing Codex operation identities valid; isolate every future adapter's native IDs.
export const operationEntity = (harness: string, nativeId: string) => harness === 'codex' ? nativeId : `${harness}:${nativeId}`;
