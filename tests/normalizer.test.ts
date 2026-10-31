import { describe, it, expect } from 'vitest';
import { normalizeState, normalizeRequests, normalizeStored } from '../server/normalizer';
const turns = Array.from({ length: 25 }, (_, i) => ({ turnId: `t${i}`, status: i === 24 ? 'inProgress' : 'completed', turnStartedAtMs: i, params: { input: [{ type: 'text', text: `消息${i}` }], secret: 'not-for-browser' }, items: [{ type: 'agentMessage', id: `m${i}`, text: `答复${i}`, phase: 'final_answer' }, { type: 'reasoning', content: ['private thought'] }] }));
const state = { id: 'thread-1', title: '测试', latestModel: 'test-model', latestReasoningEffort: 'high', latestThreadSettings: { sandboxPolicy: { type: 'readOnly' }, developer_instructions: 'private instruction' }, turnHistory: { history: { entitiesByKey: Object.fromEntries(turns.map(t => [t.turnId, t])), islands: [{ entries: turns.map(t => ({ value: t.turnId })) }] } }, requests: [] };
describe('presentation normalization', () => {
  it('paginates canonical history while excluding private runtime metadata', () => {
    const view = normalizeState(state, 10, 20); expect(view.turns).toHaveLength(20); expect(view.olderCursor).toBe('t5'); expect(view.activeTurnId).toBe('t24');
    const text = JSON.stringify(view); expect(text).toContain('消息24'); expect(text).not.toMatch(/private thought|private instruction|not-for-browser/);
    const older = normalizeState(state, 10, 20, view.olderCursor!); expect(older.turns).toHaveLength(5); expect(older.olderCursor).toBeNull();
  });
  it('removes resolved requests and retains the turn identity for pending input', () => {
    const requests = normalizeRequests({ requests: [{ id: 8, completed: true }, { id: 9, method: 'item/tool/requestUserInput', params: { turnId: 't24', questions: [{ id: 'q1', question: '继续吗？' }] } }] });
    expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ id: '9', turnId: 't24', kind: 'input' });
  });
  it('extracts only user input from the desktop submission envelope', () => {
    const view = normalizeState({ id: 'test', turns: [{ turnId: 't1', items: [{ type: 'functionCallOutput', id: 'f1', name: 'create_thread', namespace: 'codex_app', output: '<codex_delegation><source_thread_id>private-id</source_thread_id><input>你好</input></codex_delegation>' }] }] }, 1);
    expect(view.turns[0].items).toEqual([{ id: 'f1', status: undefined, type: 'user', text: '你好' }]);
    expect(JSON.stringify(view)).not.toContain('private-id');
    const stored = normalizeStored({ thread: { id: 'test' }, turns: [{ id: 't1', items: [{ type: 'functionCallOutput', name: 'create_thread', namespace: 'codex_app', output: { text: '<codex_delegation><input>已保存的输入</input></codex_delegation>' } }] }] }, null);
    expect(stored.turns[0].items[0].text).toBe('已保存的输入');
  });
  it('surfaces asynchronous questions and clears them when the exact question is answered', () => {
    const id = JSON.stringify(['request_user_input_async', 'call-1', 0]);
    const turn = { turnId: 't1', status: 'inProgress', items: [{ type: 'agentMessage', id: 'call-1', questions: [{ title: '继续吗？', options: ['继续', '取消'] }] }] as any[] };
    expect(normalizeRequests({ turns: [turn] })[0].questions?.[0].id).toBe(id);
    turn.items.push({ type: 'steeringUserMessage', status: 'accepted', input: [{ type: 'text', text: `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: id, question: '继续吗？', answer: '继续' }])}</send_user_message_question_reply>` }] });
    expect(normalizeRequests({ turns: [turn] })).toHaveLength(0);
  });
  it('orders paginated stored turns chronologically and normalizes object statuses', () => {
    const view = normalizeStored({ thread: { id: 'old', status: { type: 'notLoaded' } }, page: { nextCursor: 'opaque' }, turns: [{ id: 'b', startedAt: 20 }, { id: 'a', startedAt: 10 }] }, null);
    expect(view.status).toBe('notLoaded'); expect(view.turns.map(t => t.id)).toEqual(['a', 'b']); expect(view.olderCursor).toBe('opaque');
  });
});
