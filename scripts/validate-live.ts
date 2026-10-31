import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const base = process.env.AGENT_CONTROL_TEST_URL || 'http://127.0.0.1:3000';
const threadId = process.argv[2];
if (!threadId) throw new Error('请传入专用测试会话的 ID');
const session = await fetch(`${base}/api/session`); const { csrf } = await session.json() as any;
const cookie = session.headers.get('set-cookie')!.split(';')[0];
async function api(route: string, body?: any) {
  const response = await fetch(`${base}${route}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json', 'X-Agent-Control-Csrf': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json() as any; if (!response.ok) throw new Error(`${response.status}: ${value.error?.message}`); return value;
}
const route = `/api/threads/${threadId}`;
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: (view: any) => boolean, timeout = 40000) { const started = Date.now(); let view; while (Date.now() - started < timeout) { view = (await api(route)).thread; if (check(view)) return view; await pause(800); } throw new Error(`等待状态超时：${view?.status}`); }
const results: Record<string, unknown> = { threadId, at: new Date().toISOString() };

try {
  const initial = (await api(route)).thread;
  if (!initial.live) throw new Error('请先在桌面打开专用测试会话，并保持空闲');
  await until(v => v.status === 'idle');
  const before = (await api(route)).thread;
  const marker = `DEDUPE_${randomUUID().slice(0, 8)}`;
  const operation = { operationId: randomUUID(), prompt: `这是重复提交保护联调。请只回复 ${marker}，不要使用任何工具。` };
  await api(`${route}/messages`, operation); await api(`${route}/messages`, operation);
  const after = await until(v => v.status === 'idle' && v.turns.some((t: any) => t.items.some((i: any) => i.type === 'assistant' && i.text.includes(marker))));
  if (after.totalTurns !== before.totalTurns + 1) throw new Error('重复请求产生了额外轮次');
  results.deduplicatedSend = true; console.log('PASS 重复发送只执行一轮');

  const original = { model: after.model, effort: after.effort };
  const changed = original.effort === 'medium' ? 'high' : 'medium';
  await api(`${route}/settings`, { operationId: randomUUID(), model: original.model, effort: changed });
  await until(v => v.effort === changed, 10000);
  await api(`${route}/settings`, { operationId: randomUUID(), ...original });
  await until(v => v.effort === original.effort, 10000); results.modelSettings = true; console.log('PASS 思考强度与桌面双向同步，已恢复原值');

  await api(`${route}/messages`, { operationId: randomUUID(), prompt: '进行停止按钮联调：请执行一次仅等待 45 秒的命令，不读取或修改任何文件，不进行网络操作，等待结束后回复 WAIT_FINISHED。' });
  const running = await until(v => v.activeTurnId && v.turns.some((t: any) => t.items.some((i: any) => (i.type === 'command' || i.type === 'tool') && i.status !== 'completed')), 40000);
  await api(`${route}/interrupt`, { operationId: randomUUID(), expectedTurnId: running.activeTurnId });
  await until(v => v.status === 'idle', 15000); results.stop = true; console.log('PASS 网页停止原桌面正在执行的任务');

  await api(`${route}/messages`, { operationId: randomUUID(), prompt: '交互表单联调：请使用可用的 request_user_input 或 request_user_input_async 工具向我提出一个单选问题：是否继续联调？给出“继续”和“取消”两个选项，等待我的回答，再仅回复“FORM_OK”。不要调用命令或文件工具。' });
  const requested = await until(v => v.requests.some((r: any) => r.kind === 'input'), 45000);
  const request = requested.requests.find((r: any) => r.kind === 'input');
  results.pendingInput = { requestId: request.id, questions: request.questions.length };
  console.log(`READY 输入表单：${request.id}，等待网页验证`);
} catch (error) { results.failure = (error as Error).message; process.exitCode = 1; console.log(`FAIL ${(error as Error).message}`); }
finally { fs.mkdirSync('.local', { recursive: true }); fs.writeFileSync(path.join('.local', 'live-validation.json'), JSON.stringify(results, null, 2)); }
