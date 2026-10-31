import path from 'node:path';
import { it, expect, vi } from 'vitest';
import { CodexDesktopAdapter, desktopAccess, powershellExecutable, LIMITED_DESKTOP, SUPPORTED_DESKTOP } from '../server/desktop-adapter';

const READ_ONLY_DESKTOP = '26.0.0.0';

function fixture(requests: any[] = []) {
  const adapter = new CodexDesktopAdapter();
  adapter.status = { connected: true, compatible: true, accessMode: 'full', version: SUPPORTED_DESKTOP, supportedVersion: SUPPORTED_DESKTOP };
  const state = { id: 'test-thread', turns: [{ turnId: 'turn-1', status: 'inProgress' }], requests, latestThreadSettings: { model: 'model-a', effort: 'high', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' }, collaborationMode: { settings: { model: 'model-a', reasoning_effort: 'high' } } } };
  vi.spyOn(adapter.ipc, 'connected', 'get').mockReturnValue(true);
  vi.spyOn(adapter, 'requireThread').mockResolvedValue(undefined);
  vi.spyOn(adapter, 'ensureLive').mockResolvedValue({ owner: 'desktop-owner', revision: 1, usedAt: Date.now(), state });
  vi.spyOn(adapter, 'models').mockReturnValue([{ id: 'model-a', efforts: ['medium', 'high'] }]);
  const rpc = vi.spyOn(adapter.ipc, 'request').mockResolvedValue({ result: { applied: true } } as any);
  return { adapter, state, rpc };
}
it('changes model settings while preserving original execution permissions', async () => {
  const { adapter, state, rpc } = fixture();
  await adapter.settings('test-thread', 'model-a', 'medium');
  const settings = (rpc.mock.calls[0][1] as any).threadSettings;
  expect(settings).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' }, effort: 'medium', collaborationMode: { settings: { reasoning_effort: 'medium' } } });
  expect(state.latestThreadSettings.effort).toBe('high');
  await expect(adapter.settings('test-thread', 'unlisted-model', 'high')).rejects.toMatchObject({ code: 'INVALID_MODEL' });
  delete (state as any).latestThreadSettings;
  await expect(adapter.settings('test-thread', 'model-a', 'high')).rejects.toMatchObject({ code: 'DESKTOP_REQUIRED' });
  expect(rpc).toHaveBeenCalledTimes(1);
  adapter.close();
});
it('binds stop and approvals to the exact turn and rejects expired requests', async () => {
  const { adapter, rpc } = fixture([{ id: 42, method: 'item/commandExecution/requestApproval', params: { turnId: 'turn-1', command: 'test' } }]);
  await expect(adapter.interrupt('test-thread', 'old-turn')).rejects.toMatchObject({ code: 'STALE_TURN' });
  await expect(adapter.respond('test-thread', '42', 'old-turn', { decision: 'accept' })).rejects.toMatchObject({ code: 'STALE_REQUEST' });
  expect(rpc).not.toHaveBeenCalled();
  await adapter.interrupt('test-thread', 'turn-1');
  expect(rpc.mock.calls[0]).toMatchObject(['thread-follower-interrupt-turn', { expectedTurnId: 'turn-1' }, 4, 'desktop-owner', 30000]);
  await adapter.respond('test-thread', '42', 'turn-1', { decision: 'decline' });
  expect(rpc.mock.calls[1]).toMatchObject(['thread-follower-command-approval-decision', { requestId: 42, decision: 'decline' }, 1, 'desktop-owner', 30000]);
  adapter.close();
});
it('preserves the desktop effort when only the model setting is submitted', async () => {
  const { adapter, rpc } = fixture();
  await adapter.settings('test-thread', 'model-a');
  expect((rpc.mock.calls[0][1] as any).threadSettings).toMatchObject({ model: 'model-a', effort: 'high', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } });
  adapter.close();
});
it('routes file, input, permission decline and tool responses through their own actions', async () => {
  for (const [method, response, expected] of [
    ['item/fileChange/requestApproval', { decision: 'accept' }, 'thread-follower-file-approval-decision'],
    ['item/tool/requestUserInput', { answers: { q: ['yes'] } }, 'thread-follower-submit-user-input'],
    ['item/permissions/requestApproval', { decision: 'decline' }, 'thread-follower-permissions-request-approval-response'],
    ['mcpServer/elicitation/request', { decision: 'decline' }, 'thread-follower-submit-mcp-server-elicitation-response'],
  ] as const) {
    const { adapter, rpc } = fixture([{ id: 'req', method, params: { turnId: 'turn-1', questions: [{ id: 'q', question: 'Continue?' }] } }]);
    await adapter.respond('test-thread', 'req', 'turn-1', response);
    expect(rpc.mock.calls[0][0]).toBe(expected);
    adapter.close();
  }
});
it('requests a fresh snapshot after an incremental revision gap', () => {
  const adapter = new CodexDesktopAdapter();
  const internal = adapter as any;
  internal.states.set('thread', { owner: 'owner', revision: 5, state: { id: 'thread' } });
  const follow = vi.spyOn(adapter.ipc, 'following').mockImplementation(() => {});
  internal.onBroadcast({ method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner', params: { hostId: 'local', conversationId: 'thread', change: { type: 'patches', baseRevision: 7, revision: 8, patches: [] } } });
  expect(follow.mock.calls).toEqual([['thread', 'owner', false], ['thread', 'owner', true]]);
  expect(internal.states.get('thread').revision).toBe(-1);
  adapter.close();
});

it('tries the existing protocol for 26.x desktop versions and rejects other families', () => {
  expect(desktopAccess(SUPPORTED_DESKTOP)).toBe('full');
  for (const version of [LIMITED_DESKTOP, '26.0.0.0', '26.1023.6123.1', '26.1023.6122.0']) expect(desktopAccess(version)).toBe('full');
  for (const version of ['', '26', '26evil.1', '26.1-beta', '260.1', '27.0.0.0', '99.0.0.0']) expect(desktopAccess(version)).toBe('blocked');
});

it('blocks every native write path in read-only mode, including direct tool calls', async () => {
  const { adapter, rpc } = fixture();
  adapter.status = { connected: true, compatible: false, accessMode: 'read-only', version: READ_ONLY_DESKTOP, supportedVersion: SUPPORTED_DESKTOP };
  expect(() => adapter.assertReady()).not.toThrow();
  for (const action of [
    () => adapter.send('test-thread', 'test'),
    () => adapter.create('test'),
    () => adapter.interrupt('test-thread', 'turn-1'),
    () => adapter.settings('test-thread', 'model-a', 'high'),
    () => adapter.respond('test-thread', '42', 'turn-1', { decision: 'accept' }),
    () => adapter.callTool('create_thread', {}),
    () => adapter.callTool('send_message_to_thread', {}),
  ]) await expect(action()).rejects.toMatchObject({ code: 'DESKTOP_READ_ONLY', statusCode: 409 });
  expect(rpc).not.toHaveBeenCalled();
  expect(adapter.requireThread).not.toHaveBeenCalled();
  adapter.close();
});

it('rechecks the write boundary when the version changes while a request is waiting', async () => {
  for (const action of ['send', 'interrupt', 'settings', 'respond'] as const) {
    const { adapter, state, rpc } = fixture([{ id: 42, method: 'item/commandExecution/requestApproval', params: { turnId: 'turn-1' } }]);
    vi.mocked(adapter.ensureLive).mockImplementation(async () => {
      adapter.status = { connected: true, compatible: false, accessMode: 'read-only', version: READ_ONLY_DESKTOP, supportedVersion: SUPPORTED_DESKTOP };
      return { owner: 'desktop-owner', revision: 1, usedAt: Date.now(), state };
    });
    const pending = action === 'send' ? adapter.send('test-thread', 'test')
      : action === 'interrupt' ? adapter.interrupt('test-thread', 'turn-1')
      : action === 'settings' ? adapter.settings('test-thread', 'model-a', 'high')
      : adapter.respond('test-thread', '42', 'turn-1', { decision: 'accept' });
    await expect(pending).rejects.toMatchObject({ code: 'DESKTOP_READ_ONLY' });
    expect(rpc).not.toHaveBeenCalled();
    adapter.close();
  }
});

it('locates the system PowerShell independently of PATH on Windows', () => {
  if (process.platform !== 'win32') return;
  const previous = process.env.PATH;
  try {
    process.env.PATH = '';
    expect(powershellExecutable()).toBe(path.join(process.env.SystemRoot || process.env.WINDIR!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  } finally { process.env.PATH = previous; }
});

it('limits the new desktop version to the verified idle-message and stop paths', async () => {
  const { adapter, state, rpc } = fixture();
  adapter.status = { connected: true, compatible: true, accessMode: 'limited', version: LIMITED_DESKTOP, supportedVersion: SUPPORTED_DESKTOP };
  try {
    for (const action of [
      () => adapter.settings('test-thread', 'model-a', 'high'),
      () => adapter.respond('test-thread', '42', 'turn-1', { decision: 'accept' }),
      () => adapter.send('test-thread', 'fixture'),
    ]) await expect(action()).rejects.toMatchObject({ code: 'DESKTOP_UNVERIFIED', statusCode: 409 });
    await expect(adapter.callTool('send_message_to_thread', { threadId: 'test-thread', prompt: 'fixture' })).rejects.toMatchObject({ code: 'DESKTOP_REQUIRED' });
    expect(rpc).not.toHaveBeenCalled();
    state.turns = []; (state as any).latestModel = 'model-a'; (state as any).latestReasoningEffort = 'high';
    await expect(adapter.send('test-thread', 'fixture', 'other', 'high')).rejects.toMatchObject({ code: 'DESKTOP_UNVERIFIED' });
    await expect(adapter.send('test-thread', 'fixture', 'model-a', 'medium')).rejects.toMatchObject({ code: 'DESKTOP_UNVERIFIED' });
    await expect(adapter.send('test-thread', 'fixture', 'model-a', 'high')).resolves.toMatchObject({ accepted: true });
    expect(rpc.mock.calls[0][0]).toBe('thread-follower-start-turn');
    state.turns = [{ turnId: 'turn-1', status: 'inProgress' }];
    await expect(adapter.interrupt('test-thread', 'turn-1')).resolves.toMatchObject({ accepted: true });
    expect(rpc.mock.calls[1]).toMatchObject(['thread-follower-interrupt-turn', { conversationId: 'test-thread', expectedTurnId: 'turn-1' }, 4, 'desktop-owner', 30000]);
  } finally { adapter.close(); }
});

it('requires a live snapshot before sending through the partially verified desktop', async () => {
  const { adapter, rpc } = fixture();
  adapter.status = { connected: true, compatible: true, accessMode: 'limited', version: LIMITED_DESKTOP, supportedVersion: SUPPORTED_DESKTOP };
  vi.mocked(adapter.ensureLive).mockResolvedValue(undefined);
  try {
    await expect(adapter.send('test-thread', 'fixture')).rejects.toMatchObject({ code: 'DESKTOP_REQUIRED' });
    expect(rpc).not.toHaveBeenCalled();
  } finally { adapter.close(); }
});

it('requires an existing project and default model when creating on the partially verified desktop', async () => {
  const { adapter, rpc } = fixture(); const inner = adapter as any;
  adapter.status = { connected: true, compatible: true, accessMode: 'limited', version: LIMITED_DESKTOP, supportedVersion: SUPPORTED_DESKTOP };
  inner.appToolsPipe = 'fixture-pipe';
  vi.spyOn(adapter, 'catalog').mockResolvedValue({ projects: [{ id: 'project', name: 'Fixture', hostId: 'local' }], threads: [] });
  const native = vi.spyOn(inner, 'callNative').mockResolvedValue({ success: true, contentItems: [{ type: 'inputText', text: '{"threadId":"created-fixture"}' }] });
  try {
    await expect(adapter.create('fixture')).rejects.toMatchObject({ code: 'DESKTOP_UNVERIFIED' });
    await expect(adapter.create('fixture', 'project', 'model-a')).rejects.toMatchObject({ code: 'DESKTOP_UNVERIFIED' });
    await expect(adapter.callTool('create_thread', { prompt: 'fixture', target: { type: 'projectless' } })).rejects.toMatchObject({ code: 'DESKTOP_UNVERIFIED' });
    expect(native).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
    await expect(adapter.create('fixture', 'project')).resolves.toMatchObject({ threadId: 'created-fixture', accepted: true });
    expect(native).toHaveBeenCalledTimes(1);
    expect(native.mock.calls[0][2]).toMatchObject({ tool: 'create_thread', arguments: { prompt: 'fixture', target: { type: 'project', projectId: 'project', environment: { type: 'local' } } } });
  } finally { adapter.close(); }
});

it('rechecks limited-mode restrictions if the desktop changes while a write is waiting', async () => {
  for (const action of ['send', 'settings', 'respond'] as const) {
    const { adapter, state, rpc } = fixture([{ id: 42, method: 'item/commandExecution/requestApproval', params: { turnId: 'turn-1' } }]);
    vi.mocked(adapter.ensureLive).mockImplementation(async () => {
      adapter.status = { connected: true, compatible: true, accessMode: 'limited', version: LIMITED_DESKTOP, supportedVersion: SUPPORTED_DESKTOP };
      return { owner: 'desktop-owner', revision: 1, usedAt: Date.now(), state };
    });
    try {
      const pending = action === 'send' ? adapter.send('test-thread', 'fixture') : action === 'settings' ? adapter.settings('test-thread', 'model-a', 'high') : adapter.respond('test-thread', '42', 'turn-1', { decision: 'accept' });
      await expect(pending).rejects.toMatchObject({ code: 'DESKTOP_UNVERIFIED' }); expect(rpc).not.toHaveBeenCalled();
    } finally { adapter.close(); }
  }
});
