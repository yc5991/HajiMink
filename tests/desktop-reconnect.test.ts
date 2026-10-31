import { afterEach, expect, it, vi } from 'vitest';
import { CodexDesktopAdapter, LIMITED_DESKTOP, SUPPORTED_DESKTOP } from '../server/desktop-adapter';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store';
import { removeTempFixture } from './safe-temp';

it('invalidates desktop connection, capabilities, snapshots and catalog when the transport disconnects', () => {
  const adapter = new CodexDesktopAdapter(); const inner = adapter as any;
  adapter.status = { connected: true, compatible: true, accessMode: 'full', version: SUPPORTED_DESKTOP, supportedVersion: SUPPORTED_DESKTOP };
  inner.appToolsPipe = 'old-pipe'; inner.contextThreadId = 'old-thread'; inner.tools = [{ name: 'old-tool' }];
  inner.catalogAt = Date.now(); inner.projects = [{ id: 'old-project' }]; inner.threads = [{ id: 'old-thread' }];
  inner.states.set('old-thread', { owner: 'old-owner', state: {}, revision: 1, usedAt: Date.now() });
  inner.snapshotWaiters.set('old-thread', Promise.resolve());
  const timer = setTimeout(() => {}, 60000); timer.unref(); inner.dirtyTimers.set('old-thread', timer);
  try {
    adapter.ipc.emit('offline');
    expect(adapter.status).toMatchObject({ connected: false, compatible: false, accessMode: 'blocked' });
    expect(inner.appToolsPipe).toBeUndefined(); expect(inner.contextThreadId).toBeUndefined(); expect(inner.tools).toEqual([]);
    expect(inner.catalogAt).toBe(0); expect(inner.projects).toEqual([]); expect(inner.threads).toEqual([]);
    expect(inner.states.size).toBe(0); expect(inner.snapshotWaiters.size).toBe(0); expect(inner.dirtyTimers.size).toBe(0);
  } finally { adapter.close(); clearTimeout(timer); }
});


const tools = ['list_projects', 'list_threads', 'read_thread', 'create_thread', 'send_message_to_thread'].map(name => ({ name }));
function refreshFixture() {
  const adapter = new CodexDesktopAdapter(); const inner = adapter as any;
  const detect = vi.spyOn(inner, 'detectDesktopVersion').mockResolvedValue(LIMITED_DESKTOP);
  const pipes = vi.spyOn(inner, 'findToolPipes').mockReturnValue(['codex-app-tools-a']);
  const context = vi.spyOn(inner, 'readContextThreadId').mockReturnValue('fixture-thread');
  const native = vi.spyOn(inner, 'callNative').mockResolvedValue({ tools });
  vi.spyOn(adapter.ipc, 'connected', 'get').mockReturnValue(true);
  vi.spyOn(adapter.ipc, 'connect').mockResolvedValue();
  vi.spyOn(adapter.ipc, 'close').mockImplementation(() => {});
  return { adapter, inner, detect, pipes, context, native };
}
afterEach(() => vi.restoreAllMocks());

it('rechecks tools and context after a disconnected desktop reconnects at the same version', async () => {
  const { adapter, inner, native, context } = refreshFixture();
  try {
    await adapter.refreshConnection();
    expect(adapter.status).toMatchObject({ connected: true, accessMode: 'full', version: LIMITED_DESKTOP });
    expect(native).toHaveBeenCalledTimes(1); expect(context).toHaveBeenCalledTimes(1);
    adapter.ipc.emit('offline');
    expect(adapter.status.connected).toBe(false); expect(inner.tools).toEqual([]);
    await adapter.refreshConnection();
    expect(adapter.status).toMatchObject({ connected: true, accessMode: 'full' });
    expect(native).toHaveBeenCalledTimes(2); expect(context).toHaveBeenCalledTimes(2);
  } finally { adapter.close(); }
});

it('does not accept a stale tools response from a disconnected desktop', async () => {
  const { adapter, inner, native } = refreshFixture();
  let release!: (value: unknown) => void; let signal!: () => void;
  const waiting = new Promise<void>(resolve => { signal = resolve; });
  native.mockImplementationOnce(() => { signal(); return new Promise(resolve => { release = resolve; }); });
  try {
    const pending = adapter.refreshConnection(); await waiting;
    adapter.ipc.emit('offline'); release({ tools }); await pending;
    expect(adapter.status.connected).toBe(false); expect(inner.tools).toEqual([]);
    await adapter.refreshConnection();
    expect(adapter.status).toMatchObject({ connected: true, accessMode: 'full' });
    expect(native).toHaveBeenCalledTimes(2);
  } finally { adapter.close(); }
});

it('revalidates the tool list when the desktop tool bridge changes', async () => {
  const { adapter, pipes, native, context } = refreshFixture();
  try {
    await adapter.refreshConnection(); pipes.mockReturnValue(['codex-app-tools-b']);
    await adapter.refreshConnection();
    expect(adapter.status).toMatchObject({ connected: true, accessMode: 'full' });
    expect(native).toHaveBeenCalledTimes(2); expect(context).toHaveBeenCalledTimes(2);
    expect(String(native.mock.calls[1][0])).toContain('codex-app-tools-b');
  } finally { adapter.close(); }
});

it('does not guess a replacement when multiple unrecognized desktop bridges exist', async () => {
  const { adapter, pipes, native } = refreshFixture();
  try {
    await adapter.refreshConnection(); pipes.mockReturnValue(['codex-app-tools-b', 'codex-app-tools-c']);
    await adapter.refreshConnection();
    expect(adapter.status).toMatchObject({ connected: false, compatible: false, accessMode: 'blocked', reason: expect.stringContaining('多个桌面工具桥') });
    expect(native).toHaveBeenCalledTimes(1);
  } finally { adapter.close(); }
});

it('does not reopen the desktop after the adapter closes during version detection', async () => {
  const { adapter, detect, native } = refreshFixture();
  let release!: (value: string) => void; let signal!: () => void;
  const waiting = new Promise<void>(resolve => { signal = resolve; });
  detect.mockImplementationOnce(() => { signal(); return new Promise(resolve => { release = resolve; }); });
  const pending = adapter.start(); await waiting; adapter.close(); release(LIMITED_DESKTOP); await pending;
  expect(native).not.toHaveBeenCalled(); expect(adapter.status.connected).toBe(false);
});


it('does not accept a tool response arriving after a disconnect and reconnect', async () => {
  const { adapter, detect, native } = refreshFixture(); detect.mockResolvedValue(SUPPORTED_DESKTOP);
  let release!: (value: unknown) => void; let signal!: () => void;
  const waiting = new Promise<void>(resolve => { signal = resolve; });
  native.mockImplementation((...args: any[]) => { const method = args[1] as string;
    if (method === 'tools/list') return Promise.resolve({ tools });
    signal(); return new Promise(resolve => { release = resolve; });
  });
  try {
    await adapter.refreshConnection(); expect(adapter.status.accessMode).toBe('full');
    const pending = adapter.callTool('send_message_to_thread', { threadId: 'fixture-thread', prompt: 'fixture only' });
    await waiting; adapter.ipc.emit('offline'); await adapter.refreshConnection();
    expect(adapter.status.accessMode).toBe('full');
    release({ success: true, contentItems: [{ type: 'inputText', text: '{"accepted":true}' }] });
    await expect(pending).rejects.toMatchObject({ code: 'DESKTOP_OFFLINE', statusCode: 503 });
  } finally { adapter.close(); }
});

for (const action of ['send', 'interrupt', 'settings', 'respond'] as const) {
  it(`does not report a stale ${action} operation as confirmed after reconnection`, async () => {
    const { adapter, detect } = refreshFixture(); detect.mockResolvedValue(SUPPORTED_DESKTOP);
    let release!: (value: unknown) => void; let signal!: () => void;
    const waiting = new Promise<void>(resolve => { signal = resolve; });
    const state = { id: 'fixture-thread', turns: [{ turnId: 'turn-1', status: 'inProgress' }], requests: [{ id: 42, method: 'item/commandExecution/requestApproval', params: { turnId: 'turn-1', command: 'fixture' } }], latestThreadSettings: { model: 'fixture-model', effort: 'high', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' }, collaborationMode: { settings: { model: 'fixture-model', reasoning_effort: 'high' } } } };
    vi.spyOn(adapter, 'requireThread').mockResolvedValue(undefined);
    vi.spyOn(adapter, 'ensureLive').mockResolvedValue({ owner: 'fixture-owner', revision: 1, usedAt: Date.now(), state });
    vi.spyOn(adapter, 'models').mockReturnValue([{ id: 'fixture-model', efforts: ['high'] }]);
    vi.spyOn(adapter.ipc, 'request').mockImplementation(() => { signal(); return new Promise(resolve => { release = resolve; }); });
    try {
      await adapter.refreshConnection();
      const pending = action === 'send' ? adapter.send('fixture-thread', 'fixture-only')
        : action === 'interrupt' ? adapter.interrupt('fixture-thread', 'turn-1')
        : action === 'settings' ? adapter.settings('fixture-thread', 'fixture-model', 'high')
        : adapter.respond('fixture-thread', '42', 'turn-1', { decision: 'decline' });
      await waiting; adapter.ipc.emit('offline'); await adapter.refreshConnection();
      release({ result: { applied: true } });
      await expect(pending).rejects.toMatchObject({ code: 'DESKTOP_OFFLINE', statusCode: 503 });
    } finally { adapter.close(); }
  });
}

it('keeps a newer catalog load registered when an older one finishes', async () => {
  const { adapter, inner, detect } = refreshFixture(); detect.mockResolvedValue(SUPPORTED_DESKTOP);
  let first!: () => void, second!: () => void;
  vi.spyOn(inner, 'loadCatalog').mockImplementationOnce(() => new Promise<void>(resolve => { first = resolve; }))
    .mockImplementationOnce(() => new Promise<void>(resolve => { second = resolve; }));
  try {
    await adapter.refreshConnection(); const old = adapter.catalog(true);
    adapter.ipc.emit('offline'); await adapter.refreshConnection(); const current = adapter.catalog(true);
    first(); await old;
    expect(inner.catalogLoading).toBeDefined();
    second(); await current;
    expect(inner.catalogLoading).toBeUndefined();
  } finally { adapter.close(); }
});

it('cancels an old snapshot and preserves the new snapshot after a reconnect', async () => {
  const { adapter, inner } = refreshFixture();
  let owner = 'old-owner';
  vi.spyOn(adapter.ipc, 'request').mockImplementation(async () => ({ handledByClientId: owner } as any));
  vi.spyOn(adapter.ipc, 'following').mockImplementation(() => {});
  try {
    await adapter.refreshConnection(); const old = adapter.ensureLive('fixture-thread');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    adapter.ipc.emit('offline'); await adapter.refreshConnection(); owner = 'new-owner';
    const current = adapter.ensureLive('fixture-thread');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    inner.onBroadcast({ method: 'thread-stream-state-changed', version: 11, sourceClientId: 'new-owner', params: { hostId: 'local', conversationId: 'fixture-thread', change: { type: 'snapshot', revision: 2, conversationState: { title: 'new-snapshot' } } } });
    expect(await old).toBeUndefined();
    expect(await current).toMatchObject({ owner: 'new-owner', revision: 2, state: { title: 'new-snapshot' } });
    expect(inner.states.get('fixture-thread')).toMatchObject({ owner: 'new-owner', revision: 2 });
  } finally { adapter.close(); }
});


it('does not send an operation prepared for an earlier connection', async () => {
  const { adapter, detect } = refreshFixture(); detect.mockResolvedValue(SUPPORTED_DESKTOP);
  let release!: () => void; let signal!: () => void;
  const waiting = new Promise<void>(resolve => { signal = resolve; });
  vi.spyOn(adapter, 'requireThread').mockImplementation(() => { signal(); return new Promise(resolve => { release = resolve; }); });
  const request = vi.spyOn(adapter.ipc, 'request').mockResolvedValue({ result: { applied: true } } as any);
  try {
    await adapter.refreshConnection(); const pending = adapter.send('fixture-thread', 'fixture-only');
    await waiting; adapter.ipc.emit('offline'); await adapter.refreshConnection(); release();
    await expect(pending).rejects.toMatchObject({ code: 'DESKTOP_OFFLINE' });
    expect(request).not.toHaveBeenCalled();
  } finally { adapter.close(); }
});

it('retains a confirmed send when only the subsequent state refresh fails', async () => {
  const { adapter, detect } = refreshFixture(); detect.mockResolvedValue(SUPPORTED_DESKTOP);
  const state = { id: 'fixture-thread', turns: [], latestModel: 'fixture-model', latestReasoningEffort: 'high' };
  vi.spyOn(adapter, 'requireThread').mockResolvedValue(undefined);
  vi.spyOn(adapter, 'ensureLive').mockResolvedValueOnce({ owner: 'fixture-owner', revision: 1, usedAt: Date.now(), state }).mockRejectedValueOnce(new Error('fixture refresh failed'));
  vi.spyOn(adapter.ipc, 'request').mockResolvedValue({ result: { applied: true } } as any);
  try {
    await adapter.refreshConnection();
    await expect(adapter.send('fixture-thread', 'fixture-only')).resolves.toEqual({ accepted: true, threadId: 'fixture-thread' });
  } finally { adapter.close(); }
});

it('retains a confirmed creation when only the subsequent catalog refresh fails', async () => {
  const { adapter, detect, native } = refreshFixture(); detect.mockResolvedValue(SUPPORTED_DESKTOP);
  native.mockImplementation((...args: any[]) => args[1] === 'tools/list' ? Promise.resolve({ tools }) : Promise.resolve({ success: true, contentItems: [{ type: 'inputText', text: '{"threadId":"fixture-created"}' }] }));
  vi.spyOn(adapter, 'catalog').mockResolvedValueOnce({ projects: [], threads: [] }).mockRejectedValueOnce(new Error('fixture refresh failed'));
  try {
    await adapter.refreshConnection();
    await expect(adapter.create('fixture-only')).resolves.toEqual({ accepted: true, threadId: 'fixture-created' });
  } finally { adapter.close(); }
});

it('cleans up a snapshot waiter when the follow request fails', async () => {
  const { adapter, inner } = refreshFixture();
  vi.spyOn(adapter.ipc, 'request').mockResolvedValue({ handledByClientId: 'fixture-owner' } as any);
  vi.spyOn(adapter.ipc, 'following').mockImplementation(() => { throw new Error('fixture offline'); });
  try {
    await adapter.refreshConnection();
    await expect(adapter.ensureLive('fixture-thread')).resolves.toBeUndefined();
    expect(inner.snapshotWaiters.size).toBe(0); expect(inner.snapshotAborters.size).toBe(0); expect(inner.states.size).toBe(0);
  } finally { adapter.close(); }
});


it('records a disconnected in-flight write as unknown and does not retry it', async () => {
  const { adapter, detect, native } = refreshFixture(); detect.mockResolvedValue(SUPPORTED_DESKTOP);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agent-control-reconnect-')); const store = new Store(directory);
  let release!: (value: unknown) => void; let signal!: () => void; let submitted = 0;
  const waiting = new Promise<void>(resolve => { signal = resolve; });
  native.mockImplementation((...args: any[]) => {
    if (args[1] === 'tools/list') return Promise.resolve({ tools });
    submitted++; signal(); return new Promise(resolve => { release = resolve; });
  });
  try {
    await adapter.refreshConnection(); const id = randomUUID(), payload = { prompt: 'fixture-only' };
    const run = () => adapter.callTool('send_message_to_thread', { threadId: 'fixture-thread', ...payload });
    const pending = store.operation(id, 'send', 'fixture-thread', payload, run);
    await waiting; adapter.ipc.emit('offline'); await adapter.refreshConnection();
    release({ success: true, contentItems: [{ type: 'inputText', text: '{"accepted":true}' }] });
    await expect(pending).rejects.toMatchObject({ code: 'DESKTOP_OFFLINE' });
    expect(store.db.prepare('SELECT state FROM operations WHERE id=?').get(id)).toMatchObject({ state: 'unknown' });
    await expect(store.operation(id, 'send', 'fixture-thread', payload, run)).rejects.toMatchObject({ code: 'OPERATION_UNCONFIRMED' });
    expect(submitted).toBe(1);
  } finally { adapter.close(); store.close(); removeTempFixture(directory, 'agent-control-reconnect-'); }
});


it('cancels and unfollows a pending snapshot when its desktop owner disconnects', async () => {
  const { adapter, inner } = refreshFixture();
  vi.spyOn(adapter.ipc, 'request').mockResolvedValue({ handledByClientId: 'fixture-owner' } as any);
  const follow = vi.spyOn(adapter.ipc, 'following').mockImplementation(() => {});
  try {
    await adapter.refreshConnection(); const pending = adapter.ensureLive('fixture-thread');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    inner.onBroadcast({ method: 'client-status-changed', params: { status: 'disconnected', clientId: 'fixture-owner' } });
    await expect(pending).resolves.toBeUndefined();
    expect(follow.mock.calls).toEqual([['fixture-thread', 'fixture-owner', true], ['fixture-thread', 'fixture-owner', false]]);
    expect(inner.states.size).toBe(0); expect(inner.snapshotWaiters.size).toBe(0);
  } finally { adapter.close(); }
});


it('does not overwrite a new catalog with a delayed result from the previous connection', async () => {
  const { adapter, inner, native } = refreshFixture();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agent-control-reconnect-catalog-'));
  const db = new DatabaseSync(path.join(directory, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,name TEXT,title TEXT,cwd TEXT,updated_at INTEGER,source TEXT,is_pinned INTEGER,project_id TEXT,agent_role TEXT,archived INTEGER)'); db.close();
  inner.codexHome = directory;
  let phase = 'old', release!: (value: string) => void, signal!: () => void;
  const waiting = new Promise<void>(resolve => { signal = resolve; });
  const originalRead = fsp.readFile.bind(fsp);
  vi.spyOn(fsp, 'readFile').mockImplementation((...args: any[]) => {
    if (String(args[0]) !== path.join(directory, '.codex-global-state.json')) return (originalRead as any)(...args);
    if (phase === 'old') { signal(); return new Promise(resolve => { release = resolve; }) as any; }
    return Promise.resolve('{}') as any;
  });
  native.mockImplementation((...args: any[]) => {
    if (args[1] === 'tools/list') return Promise.resolve({ tools });
    const tool = args[2].tool;
    const value = tool === 'list_projects' ? { projects: [{ projectKind: 'local', hostId: 'local', projectId: phase, label: phase }] } : { threads: [], pinnedThreads: [] };
    return Promise.resolve({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
  });
  try {
    await adapter.refreshConnection(); const previous = adapter.catalog(true); const previousResult = previous.catch(error => error);
    await waiting; adapter.ipc.emit('offline'); phase = 'new'; await adapter.refreshConnection();
    const current = await adapter.catalog(true); expect(current.projects).toMatchObject([{ id: 'new', name: 'new' }]);
    release('{}'); expect(await previousResult).toMatchObject({ code: 'DESKTOP_OFFLINE' });
    expect(inner.projects).toMatchObject([{ id: 'new', name: 'new' }]);
  } finally { adapter.close(); vi.restoreAllMocks(); removeTempFixture(directory, 'agent-control-reconnect-catalog-'); }
});

it('keeps other operations available when the desktop lacks its create tool', async () => {
  const { adapter, native } = refreshFixture();
  native.mockResolvedValue({ tools: tools.filter(tool => tool.name !== 'create_thread') });
  try {
    await adapter.refreshConnection();
    expect(adapter.status).toMatchObject({ connected: true, compatible: true, accessMode: 'full', version: LIMITED_DESKTOP });
    await expect(adapter.callTool('create_thread', { prompt: 'fixture' })).rejects.toMatchObject({ code: 'DESKTOP_UNSUPPORTED_ACTION' });
  } finally { adapter.close(); }
});
