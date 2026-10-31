import type { DisplayTurn, DisplayItem, PendingRequest, ThreadView } from '../shared/types.js';

export const TEXT_LIMIT = 40000;
const clip = (value: unknown, max = TEXT_LIMIT): string => typeof value === 'string' ? value.slice(0, max) : '';
export function inputText(input: any): string {
  if (typeof input === 'string') return clip(input);
  return Array.isArray(input) ? input.filter(x => x?.type === 'text' || x?.type === 'inputText').map(x => clip(x.text)).join('\n') : '';
}
function displayInput(text: string) {
  const match = /<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/.exec(text);
  if (match) try { const answers = JSON.parse(match[1]); return (Array.isArray(answers) ? answers : [answers]).map((a: any) => `${clip(a.question, 1000)}\n${clip(a.answer, 6000)}`).join('\n\n'); } catch {}
  return text;
}
export function rawTurns(state: any): any[] {
  const history = state?.turnHistory?.history;
  if (history?.entitiesByKey && Array.isArray(history.islands)) {
    const seen = new Set<string>();
    return history.islands.flatMap((island: any) => island.entries || []).map((entry: any) => history.entitiesByKey[entry.value]).filter((turn: any) => {
      if (!turn || !turn.params || seen.has(turn.turnId || turn.params.clientUserMessageId)) return false;
      seen.add(turn.turnId || turn.params.clientUserMessageId); return true;
    });
  }
  return state?.turns || [];
}
function toolText(result: any) {
  const content = result?.content || result?.contentItems;
  return Array.isArray(content) ? content.filter((x: any) => typeof x?.text === 'string').map((x: any) => clip(x.text, 12000)).join('\n').slice(0, TEXT_LIMIT) : '';
}
export function displayTurn(turn: any, index = 0): DisplayTurn {
  const id = String(turn.turnId || turn.id || `turn-${index}`);
  const items: DisplayItem[] = [];
  const rawItems = Array.isArray(turn.items) ? turn.items : [];
  const hasUser = rawItems.some((x: any) => x.type === 'userMessage');
  if (!hasUser && inputText(turn.params?.input)) items.push({ id: `${id}:input`, type: 'user', text: displayInput(inputText(turn.params.input)) });
  for (const [i, item] of rawItems.entries()) {
    const base = { id: String(item.id ?? `${id}:${i}`), status: item.status };
    switch (item.type) {
      case 'userMessage': items.push({ ...base, type: 'user', text: displayInput(inputText(item.content)) }); break;
      case 'functionCallOutput': {
        // Desktop tool submissions store user input in the native delegation envelope.
        if (item.namespace === 'codex_app' && ['create_thread', 'send_message_to_thread'].includes(item.name)) {
          const output = typeof item.output === 'string' ? item.output : item.output?.text;
          const text = /<input>([\s\S]*)<\/input>/.exec(output || '')?.[1];
          if (text) items.push({ ...base, type: 'user', text: displayInput(clip(text)) });
        }
        break;
      }
      case 'steeringUserMessage': items.push({ ...base, type: 'user', text: displayInput(inputText(item.input)), label: '补充要求' }); break;
      case 'agentMessage': items.push({ ...base, type: item.phase === 'commentary' ? 'progress' : 'assistant', text: clip(item.text) }); break;
      case 'plan': items.push({ ...base, type: 'assistant', text: clip(item.text), label: '实施计划' }); break;
      case 'commandExecution': items.push({ ...base, type: 'command', label: '执行命令', text: clip(item.command, 6000), output: clip(item.aggregatedOutput, 12000), truncated: (item.aggregatedOutput?.length || 0) > 12000 }); break;
      case 'mcpToolCall': items.push({ ...base, type: 'tool', label: `${item.server} / ${item.tool}`, text: item.error ? clip(typeof item.error === 'string' ? item.error : item.error.message) : '', output: toolText(item.result) }); break;
      case 'fileChange': items.push({ ...base, type: 'diff', label: '文件变更', text: (item.changes || []).map((c: any) => `${c.path || ''}\n${clip(c.diff, 16000)}`).join('\n').slice(0, TEXT_LIMIT) }); break;
      case 'error': items.push({ ...base, type: 'error', text: clip(item.message) }); break;
      case 'webSearch': items.push({ ...base, type: 'notice', label: '检索资料', text: clip(item.query, 500) }); break;
      // Reasoning, prompts, tool arguments, credentials and private runtime metadata are not presentation data.
    }
  }
  if (turn.diff && !items.some(x => x.type === 'diff')) items.push({ id: `${id}:diff`, type: 'diff', label: '本轮变更', text: clip(turn.diff) });
  return { id, status: turn.status || 'completed', startedAt: turn.turnStartedAtMs || 0, items };
}
export function normalizeRequests(state: any): PendingRequest[] {
  const pending: PendingRequest[] = (state?.requests || []).filter((r: any) => !r.completed).map((r: any) => {
    const params = r.params || {}; const method = r.method || '';
    const kind: PendingRequest['kind'] = method.includes('commandExecution') || method === 'execCommandApproval' ? 'command' : method.includes('fileChange') || method === 'applyPatchApproval' ? 'file' : method.includes('permissions') ? 'permissions' : method.includes('requestUserInput') ? 'input' : method.includes('elicitation') ? 'elicitation' : 'unsupported';
    return { id: String(r.id), turnId: String(params.turnId || params.turn_id || ''), kind, title: { command: '批准执行命令', file: '批准文件修改', permissions: '权限申请', input: '需要你的回答', elicitation: '工具需要确认', unsupported: '请在桌面端处理' }[kind], detail: clip(params.command || params.reason || params.message || (kind === 'file' ? JSON.stringify(params.changes || {}) : ''), 8000), questions: kind === 'input' ? (params.questions || []).map((q: any) => ({ id: q.id, header: q.header, question: q.question, options: q.options, isOther: q.isOther, isSecret: q.isSecret })) : undefined, decisions: params.availableDecisions?.filter((d: any) => typeof d === 'string') };
  });
  for (const turn of rawTurns(state)) {
    if (turn.status !== 'inProgress') continue;
    const answered = new Set<string>();
    for (const item of turn.items || []) {
      const text = item.type === 'userMessage' ? inputText(item.content) : item.type === 'steeringUserMessage' && item.status === 'accepted' ? inputText(item.input) : '';
      const match = /<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/.exec(text);
      if (match) try { const answers = JSON.parse(match[1]); for (const answer of Array.isArray(answers) ? answers : [answers]) answered.add(answer.questionItemId); } catch {}
    }
    for (const item of turn.items || []) if (item.type === 'agentMessage' && item.questions?.length) {
      const questions = item.questions.map((q: any, index: number) => ({ id: JSON.stringify(['request_user_input_async', item.id, index]), question: q.title, options: q.options?.map((label: string) => ({ label })) })).filter((q: any) => !answered.has(q.id));
      if (questions.length) pending.push({ id: `async:${item.id}`, turnId: turn.turnId, kind: 'input', title: '需要你的回答', detail: '', questions });
    }
  }
  return pending;
}
export function normalizeState(state: any, revision: number, limit = 20, before?: string): ThreadView {
  const allTurns = rawTurns(state); const endIndex = before ? allTurns.findIndex(t => String(t.turnId || t.id) === before) : allTurns.length;
  const end = endIndex < 0 ? 0 : endIndex; const start = Math.max(0, end - limit);
  const turns = allTurns.slice(start, end).map(displayTurn);
  const active = [...allTurns].reverse().find(t => t.status === 'inProgress' || t.status === 'running');
  const requests = normalizeRequests(state);
  return { id: state.id, title: state.title || state.fallbackSearchTitle || '未命名会话', cwd: state.cwd, revision, live: true, status: requests.length ? 'waiting' : state.threadRuntimeStatus?.type === 'active' || active ? 'active' : 'idle', activeTurnId: active?.turnId, model: state.latestCollaborationMode?.settings?.model || state.latestModel, effort: state.latestReasoningEffort || state.latestThreadSettings?.effort, permissionLabel: state.latestThreadSettings?.sandboxPolicy?.type || '沿用桌面', turns, totalTurns: allTurns.length, olderCursor: start > 0 ? turns[0]?.id || null : null, requests };
}
export function normalizeStored(response: any, _cursor: string | null): ThreadView {
  const thread = response.thread || {}; const raw = [...(response.turns || [])].sort((a: any, b: any) => (a.startedAt || 0) - (b.startedAt || 0));
  const status = typeof thread.status === 'string' ? thread.status : thread.status?.type || 'idle';
  return { id: thread.id, title: thread.title || '未命名会话', cwd: thread.cwd, revision: 0, live: false, status, permissionLabel: '沿用桌面', turns: raw.map((turn: any, i: number) => displayTurn({ ...turn, turnStartedAtMs: (turn.startedAt || 0) * 1000, params: { input: turn.userInput || turn.input }, items: turn.items || [] }, i)), totalTurns: raw.length, olderCursor: response.page?.nextCursor || response.nextCursor || null, requests: [] };
}
