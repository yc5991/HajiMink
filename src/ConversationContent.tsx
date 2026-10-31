import { isValidElement, memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Check, ChevronDown, Code2, Copy, FileDiff, Search, ShieldCheck, SquareTerminal } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { DisplayItem, PendingRequest } from '../shared/types';

export const statusLabels: Record<string, string> = { active: '正在执行', idle: '就绪', waiting: '等待你处理', inProgress: '进行中', completed: '已完成', failed: '失败', interrupted: '已停止', notLoaded: '历史会话' };

function CopyButton({ text, label, className = '' }: { text: string; label: string; className?: string }) {
  const [result, setResult] = useState(''); const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button className={className} aria-label={result || label} title={result || label} onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => setResult('已复制')).catch(() => setResult('复制失败，请长按选取')).finally(() => { clearTimeout(timer.current); timer.current = setTimeout(() => setResult(''), 2000); }); }}>{result === '已复制' ? <Check size={17}/> : <Copy size={17}/>}<span className={className === 'copy-button' ? 'sr-only' : ''} role="status">{result || label}</span></button>;
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const code = isValidElement<{ children?: ReactNode; className?: string }>(children) ? children.props : undefined;
  const text = typeof code?.children === 'string' ? code.children.replace(/\n$/, '') : '';
  const language = /language-([\w+-]+)/.exec(code?.className || '')?.[1] || '代码';
  return <div className="code-block"><div className="code-toolbar"><span>{language}</span><CopyButton text={text} label="复制代码" className="code-copy"/></div><pre tabIndex={0} aria-label={`${language}代码`}>{children}</pre></div>;
}
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: ({ children }) => <CodeBlock>{children}</CodeBlock>, a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ alt }) => <span className="image-note">[图片{alt ? `：${alt}` : ''}，请在桌面端查看]</span> }}>{text}</ReactMarkdown>;
});
export const Item = memo(function Item({ item, harnessName }: { item: DisplayItem; harnessName: string }) {
  if (item.type === 'command' || item.type === 'tool' || item.type === 'diff') return <details className={`activity ${item.type}`}>
    <summary>{item.type === 'diff' ? <FileDiff size={15}/> : <SquareTerminal size={15}/>}<span>{item.label || '执行记录'}</span><span className={`activity-state ${item.status || ''}`}>{statusLabels[item.status || ''] || item.status}</span><ChevronDown size={14}/></summary>
    <div className="activity-body">{item.text && <pre>{item.text}</pre>}{item.output && <pre className="output">{item.output}</pre>}{item.truncated && <p className="muted">输出较长，此处显示节选；完整输出请在桌面查看</p>}</div>
  </details>;
  if (item.type === 'notice') return <div className="notice-line"><Search size={13}/><span>{item.label} {item.text}</span></div>;
  return <div className={`message ${item.type}`}>
    {item.type === 'user' ? <div className="user-text">{item.label && <small>{item.label}</small>}{item.text}</div> : <>
      {item.type === 'assistant' && <div className="message-label"><Code2 size={15}/>{harnessName}{item.label && <span>{item.label}</span>}</div>}
      <div className="prose"><Markdown text={item.text}/></div>
      {item.type === 'assistant' && <CopyButton text={item.text} label="复制回复" className="copy-button"/>}
    </>}
  </div>;
});
export function RequestCard({ request, busy, onRespond }: { request: PendingRequest; busy: boolean; onRespond: (request: PendingRequest, body: any) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return <section className="request-card" aria-label={request.title}>
    <div className="request-heading"><ShieldCheck size={17}/><strong>{request.title}</strong><span>来自桌面会话</span></div>
    {request.detail && <pre>{request.detail}</pre>}
    {request.kind === 'input' ? <form onSubmit={e => { e.preventDefault(); onRespond(request, { answers: Object.fromEntries((request.questions || []).map(q => [q.id, [answers[q.id] || '']])) }); }}>
      {(request.questions || []).map(q => <fieldset key={q.id}><legend>{q.question}</legend>{q.options?.map(o => <label className="option" key={o.label}><input type="radio" name={`${request.id}:${q.id}`} value={o.label} checked={answers[q.id] === o.label} onChange={() => setAnswers(a => ({ ...a, [q.id]: o.label }))}/><span>{o.label}{o.description && <small>{o.description}</small>}</span></label>)}<input className="answer-input" aria-label={`${q.header || q.question} 自定义回答`} placeholder="输入回答" type={q.isSecret ? 'password' : 'text'} value={q.options?.some(o => o.label === answers[q.id]) ? '' : answers[q.id] || ''} onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))}/></fieldset>)}
      <button className="primary small" disabled={busy || (request.questions || []).some(q => !answers[q.id]?.trim())} type="submit">提交回答 <ArrowUp size={14}/></button>
    </form> : request.kind === 'unsupported' ? <p className="muted">该请求需要在 Windows 桌面应用内处理</p> : <div className="request-actions">
      {request.kind !== 'permissions' && <button className="primary small" disabled={busy} onClick={() => onRespond(request, { decision: 'accept' })}>允许本次</button>}
      <button className="secondary small" disabled={busy} onClick={() => onRespond(request, { decision: 'decline' })}>拒绝</button>
      {request.kind === 'permissions' && <span className="muted">扩大权限请在桌面端审阅</span>}
    </div>}
  </section>;
}
