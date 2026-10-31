import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronRight, Circle, CircleHelp, Code2, Command, Folder, Layers, MessageSquare, Moon, PanelLeftClose, PanelLeftOpen, Pin, RefreshCw, Search, Settings, Sparkles, Square, SquarePen, SquareTerminal, Sun, UserRound, WifiOff, X } from 'lucide-react';
import type { HarnessInfo, DesktopStatus, DisplayTurn, ModelOption, PendingRequest, Project, ThreadSummary, ThreadView } from '../shared/types';
import { api as requestApi, ApiError, initializeSession } from './api';
import { mergeView } from '../shared/merge-view';
import { useDialog, useMedia, useMobile } from './mobile';
import { withHarness } from '../shared/harness-url';
import { applyTheme } from './theme';
import { isDesktopGreeting } from './live-protocol';
import { LiveHeartbeat, supportsLiveHeartbeat } from './live-heartbeat';
import { CliTerminal, type CliHeaderState } from './CliTerminal';
import { Item, RequestCard, statusLabels } from './ConversationContent';

type WorkspaceHeader = { kind: 'conversation' | 'cli'; name: string; title: string; status: string; dark: boolean; action?: 'start' | 'stop'; searchAvailable?: boolean };

type DesktopWorkspaceBridge = {
  ready: () => void;
  sidebarOpen: (value: boolean) => void;
  showWorkspace: () => void;
  showSettings?: () => void;
  onSurface: (callback: (value: { sidebarOnly: boolean; sidebarOpen: boolean }) => void) => () => void;
  onTheme?: (callback: (value: { theme: string; dark: boolean }) => void) => () => void;
  onSearch?: (callback: () => void) => () => void;
  setHeader?: (value: WorkspaceHeader) => void;
  onHeaderAction?: (callback: (action: 'start' | 'stop') => void) => () => void;
};
declare global { interface Window { hajiminkWorkspace?: DesktopWorkspaceBridge } }

export { Markdown } from './ConversationContent';
function relativeTime(value: number) {
  const timestamp = value < 1_000_000_000_000 ? value * 1000 : value;
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)} 天`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(timestamp);
}
function readDraft(key: string) { try { return localStorage.getItem(`ac:draft:${key}`) || ''; } catch { return ''; } }
function saveDraft(key: string, text: string) { try { text ? localStorage.setItem(`ac:draft:${key}`, text) : localStorage.removeItem(`ac:draft:${key}`); } catch {} }
export function App() {
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [selectedHarness, setHarness] = useState(() => { try { return new URLSearchParams(location.search).get('harness') || localStorage.getItem('ac:harness') || 'codex'; } catch { return 'codex'; } });
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState(''); const [attempt, retry] = useState(0);
  useEffect(() => { let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const load = async () => { try { const value = await requestApi('/api/harnesses'); if (!disposed) { setHarnesses(value.harnesses); setError(''); } } catch (error) { if (!disposed) { setError((error as Error).message); timer = setTimeout(() => void load(), 5000); } } };
    void load(); return () => { disposed = true; clearTimeout(timer); };
  }, [attempt]);
  const refreshHarnesses = useCallback(async () => { try { const value = await requestApi('/api/harnesses'); setHarnesses(value.harnesses); } catch {} }, []);
  const harness = harnesses.find(item => item.id === selectedHarness) || harnesses.find(item => item.id === 'codex');
  const choose = (id: string) => { setVisited(current => new Set([...current, harness?.id || selectedHarness, id])); setHarness(id); try { localStorage.setItem('ac:harness', id); } catch {} };
  if (!harness) return <main className="auth-screen auth-loading" aria-busy={!error}><Command size={30}/><p role={error ? 'alert' : 'status'}>{error || '正在连接你的 Agent 工作台…'}</p>{error && <button className="secondary" onClick={() => retry(value => value + 1)}>重新连接</button>}</main>;
  return <>{harnesses.filter(item => item.id === harness.id || visited.has(item.id)).map(item => <div key={item.id} hidden={item.id !== harness.id}><Workspace active={item.id === harness.id} harness={item} harnesses={harnesses} chooseHarness={choose} refreshHarnesses={refreshHarnesses}/></div>)}</>;
}
function Workspace({ active: workspaceActive, harness, harnesses, chooseHarness, refreshHarnesses }: { active: boolean; harness: HarnessInfo; harnesses: HarnessInfo[]; chooseHarness: (id: string) => void; refreshHarnesses: () => Promise<void> }) {
  const api = useCallback((url: string, body?: unknown) => requestApi(withHarness(url, harness.id), body), [harness.id]);
  const desktopBridge = window.hajiminkWorkspace;
  const mobileViewport = useMobile();
  const isMobile = mobileViewport && !desktopBridge;
  const pageLimit = isMobile ? 10 : 20;
  const pageLimitRef = useRef(pageLimit); pageLimitRef.current = pageLimit;
  const [desktop, setDesktop] = useState<DesktopStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [view, setView] = useState<ThreadView | null>(null);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [cliVisible, setCliVisible] = useState(false);
  const [cliMounted, setCliMounted] = useState(false);
  const [cliHeader, setCliHeader] = useState<CliHeaderState>({ title: '用户目录', status: '未启动', action: 'start' });
  const [draft, setDraft] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [effort, setEffort] = useState('');
  const [theme, setTheme] = useState('system');
  const [desktopDark, setDesktopDark] = useState<boolean | null>(null);
  const prefersDark = useMedia('(prefers-color-scheme: dark)');
  const effectivePrefersDark = desktopBridge && desktopDark !== null ? desktopDark : prefersDark;
  const darkTheme = theme === 'dark' || (theme === 'system' && effectivePrefersDark);
  const [sidebarOpen, setSidebarOpen] = useState(() => !!desktopBridge || !window.matchMedia('(max-width: 1023px)').matches);
  const [sidebarOnly, setSidebarOnly] = useState(false);
  const sidebarOnlyRef = useRef(false);
  const sidebarOpenRef = useRef(sidebarOpen); sidebarOpenRef.current = sidebarOpen;
  const [projectsOpen, setProjectsOpen] = useState(() => !window.matchMedia('(max-width: 1023px)').matches);
  const [ready, setReady] = useState(false);
  const [streamState, setStreamState] = useState<'connecting' | 'online' | 'reconnecting'>('connecting');
  const [streamRetry, retryStream] = useState(0);
  const streamOnline = streamState === 'online';
  const [loading, setLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [unknown, setUnknown] = useState(false);
  const [showBottom, setShowBottom] = useState(false);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const streamedUpdates = useRef(0);
  const viewSelection = useRef<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stayBottom = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLDialogElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const prependRef = useRef<{ height: number; top: number } | null>(null);
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  const changeSidebar = useCallback((open: boolean) => { sidebarOpenRef.current = open; setSidebarOpen(open); desktopBridge?.sidebarOpen(open); }, [desktopBridge]);
  const closeSidebar = useCallback(() => changeSidebar(false), [changeSidebar]);
  const closeSearch = useCallback(() => { searchRef.current?.close(); setSearchOpen(false); setSearch(''); }, []);
  const showWorkspace = () => desktopBridge?.showWorkspace();
  useEffect(() => {
    if (!desktopBridge || !workspaceActive) return;
    const unsubscribeSurface = desktopBridge.onSurface(value => {
      if (value.sidebarOnly && !sidebarOnlyRef.current) { searchRef.current?.close(); setSearchOpen(false); setSearch(''); setModelOpen(false); }
      sidebarOnlyRef.current = value.sidebarOnly; setSidebarOnly(value.sidebarOnly); sidebarOpenRef.current = value.sidebarOpen; setSidebarOpen(value.sidebarOpen);
    });
    const unsubscribeTheme = desktopBridge.onTheme?.(value => {
      setDesktopDark(value.dark);
      if (['system', 'light', 'dark'].includes(value.theme)) setTheme(value.theme);
    });
    const unsubscribeSearch = desktopBridge.onSearch?.(() => { if (harness.state !== 'planned') setSearchOpen(true); });
    desktopBridge.ready();
    return () => { unsubscribeSurface(); unsubscribeTheme?.(); unsubscribeSearch?.(); };
  }, [desktopBridge, workspaceActive, harness.state]);
  useEffect(() => { if (!workspaceActive) { searchRef.current?.close(); setSearchOpen(false); setModelOpen(false); } }, [workspaceActive]);
  useDialog(workspaceActive && isMobile && sidebarOpen && !searchOpen, sidebarRef, mainRef, menuRef, closeSidebar);
  useEffect(() => { if (searchOpen) { if (!searchRef.current?.open) searchRef.current?.showModal(); searchInputRef.current?.focus(); } }, [searchOpen]);
  useEffect(() => {
    if (!workspaceActive) return;
    const shortcut = (event: KeyboardEvent) => {
      if (event.isComposing || searchOpen) return;
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 's') { event.preventDefault(); changeSidebar(!sidebarOpenRef.current); }
      if (harness.state !== 'planned' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); desktopBridge?.showWorkspace(); setSearchOpen(true); }
    };
    document.addEventListener('keydown', shortcut); return () => document.removeEventListener('keydown', shortcut);
  }, [changeSidebar, desktopBridge, harness.state, searchOpen, workspaceActive]);
  useEffect(() => {
    if (!modelOpen) return;
    const dismiss = (event: MouseEvent) => { if (!modelRef.current?.contains(event.target as Node)) setModelOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setModelOpen(false); };
    document.addEventListener('mousedown', dismiss); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', dismiss); document.removeEventListener('keydown', escape); };
  }, [modelOpen]);
  const actionLock = useRef(false);
  const nativeDraftKey = selected || `new:${project || 'unassigned'}`;
  const draftKey = harness.id === 'codex' ? nativeDraftKey : `harness:${harness.id}:${nativeDraftKey}`;
  const draftKeyRef = useRef(draftKey); draftKeyRef.current = draftKey;

  const refreshCatalog = useCallback(async (force = false) => {
    const [p, t, m] = await Promise.all([api('/api/projects'), api(`/api/threads${force ? '?refresh=true' : ''}`), api('/api/models')]);
    setProjects(p.projects); setThreads(t.threads); setModels(m.models);
  }, [api]);
  useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const initialize = async () => { try {
      await initializeSession(); const [status, preferences] = await Promise.all([api('/api/harnesses'), api('/api/preferences')]);
      if (disposed) return;
      setDesktop(status.desktop); if (!desktopBridge) setTheme(preferences.theme || 'system'); setProject(preferences.selectedProject || null); setSelected(preferences.selectedThread || null); setReady(true);
      if (status.desktop.connected) await refreshCatalog();
    } catch (e) { if (!disposed) { setError((e as Error).message); timer = setTimeout(() => void initialize(), 5000); } } };
    void initialize();
    return () => { disposed = true; clearTimeout(timer); };
  }, [refreshCatalog]);
  useEffect(() => { if (workspaceActive) applyTheme(theme, effectivePrefersDark); }, [theme, effectivePrefersDark, workspaceActive]);
  useEffect(() => { if (ready && workspaceActive) { try { localStorage.setItem('ac:theme', theme); } catch {} void api('/api/preferences', { theme }).catch(() => {}); } }, [theme, ready, workspaceActive]);
  useEffect(() => {
    if (!ready || harness.state === 'planned') return;
    let disposed = false, generation = 0, attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined, watchdog: ReturnType<typeof setTimeout> | undefined;
    let current: WebSocket | null = null, preparation: AbortController | undefined, heartbeat: LiveHeartbeat | undefined;
    const release = () => {
      heartbeat?.stop(); heartbeat = undefined;
      clearTimeout(watchdog); watchdog = undefined; preparation?.abort(); preparation = undefined;
      const socket = current; current = null;
      if (socketRef.current === socket) socketRef.current = null;
      if (socket && socket.readyState < WebSocket.CLOSING) { try { socket.close(); } catch {} }
    };
    const connect = async () => {
      if (disposed) return;
      const attempt = ++generation; const valid = () => !disposed && generation === attempt;
      preparation = new AbortController();
      const fail = () => {
        if (!valid()) return;
        generation++; release(); setStreamState('reconnecting');
        const delay = Math.min(1000 * 2 ** Math.min(attempts++, 4), 15000);
        timer = setTimeout(() => void connect(), delay);
      };
      // A transport can open but never deliver the gateway's first status event.
      watchdog = setTimeout(fail, 10000);
      try {
        await initializeSession({ signal: preparation.signal });
        if (!valid()) return;
        const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${withHarness('/api/events', harness.id)}`);
        current = socket; let greeted = false, online = false;
        const markOnline = () => {
          if (!valid() || current !== socket || online) return;
          try {
            if (socket.readyState !== WebSocket.OPEN) throw new Error('Realtime socket is closed');
            if (selectedRef.current) socket.send(JSON.stringify({ type: 'subscribe', threadId: selectedRef.current, limit: pageLimitRef.current }));
          } catch { fail(); return; }
          online = true; socketRef.current = socket; attempts = 0;
          setStreamState('online'); setError(value => value === '网络连接中断，请检查网络或稍后重试' ? '' : value);
        };
        socket.onmessage = event => { if (!valid() || current !== socket) return; try {
          const message = JSON.parse(event.data);
          if (message.harness && message.harness !== harness.id) return;
          if (!greeted) {
            if (!isDesktopGreeting(message, harness.id)) return;
            greeted = true; clearTimeout(watchdog); watchdog = undefined;
            if (supportsLiveHeartbeat(message)) {
              heartbeat = new LiveHeartbeat({
                send: nonce => { if (socket.readyState !== WebSocket.OPEN) throw new Error('Realtime socket is closed'); socket.send(JSON.stringify({ type: 'heartbeat-ping', nonce })); },
                onHealthy: markOnline,
                onFailure: fail
              });
              heartbeat.start();
            } else markOnline(); // Legacy gateways do not advertise the optional protocol.
            if (!valid() || current !== socket) return;
          }
          if (message.type === 'heartbeat-pong' && message.harness === harness.id) heartbeat?.receive(message);
          if (message.type === 'desktop' && isDesktopGreeting(message, harness.id)) { setDesktop(message.desktop); void refreshHarnesses(); if (message.desktop.connected) void refreshCatalog().catch(() => {}); }
          if (message.type === 'catalog') void refreshCatalog(true).catch(() => {});
          if (message.type === 'thread' && message.thread?.id === selectedRef.current) { streamedUpdates.current++; setView(v => mergeView(v, message.thread)); setLoading(false); }
          if (message.type === 'error') { setError(message.message); setLoading(false); }
        } catch {} };
        socket.onerror = fail; socket.onclose = fail;
      } catch (error) { if (valid()) { setError((error as Error).message); fail(); } }
    };
    setStreamState('connecting'); void connect();
    const interval = setInterval(() => { void refreshCatalog().catch(() => {}); }, 15000);
    return () => { disposed = true; generation++; clearTimeout(timer); clearInterval(interval); release(); };
  }, [ready, refreshCatalog, refreshHarnesses, streamRetry]);
  useEffect(() => {
    setDraft(readDraft(draftKey));
    try { setUnknown(!!sessionStorage.getItem(`ac:unknown:${draftKey}`)); } catch {}
  }, [draftKey]);
  useEffect(() => {
    if (!ready || !workspaceActive) return;
    if (viewSelection.current !== selected) { viewSelection.current = selected; setView(null); setError(''); setSelectedModel(''); setEffort(''); stayBottom.current = true; setShowBottom(false); }
    void api('/api/preferences', { selectedThread: selected, selectedProject: project }).catch(() => {});
    if (!selected || !desktop?.connected) { setLoading(false); if (!selected && socketRef.current?.readyState === 1) socketRef.current.send(JSON.stringify({ type: 'unsubscribe' })); return; }
    setLoading(true); let disposed = false; const before = streamedUpdates.current;
    void api(`/api/threads/${encodeURIComponent(selected)}?limit=${pageLimit}`).then(value => { if (!disposed) { if (before === streamedUpdates.current) setView(v => mergeView(v, value.thread)); setLoading(false); } }).catch(e => { if (!disposed && before === streamedUpdates.current) { setError(e.message); setLoading(false); } });
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: 'subscribe', threadId: selected, limit: pageLimit }));
    return () => { disposed = true; };
  }, [selected, ready, desktop?.connected, pageLimit, workspaceActive]);
  useEffect(() => {
    if (view) { setSelectedModel(view.model || ''); setEffort(view.effort || ''); }
  }, [view?.id, view?.model, view?.effort]);
  useLayoutEffect(() => {
    const element = scrollRef.current; if (!element) return;
    if (prependRef.current) { element.scrollTop = prependRef.current.top + element.scrollHeight - prependRef.current.height; prependRef.current = null; }
    else if (stayBottom.current) element.scrollTop = element.scrollHeight;
  }, [view, loading]);
  const resizeComposer = useCallback(() => {
    const element = textareaRef.current;
    if (!element || !element.getClientRects().length) return;
    element.style.height = '';
    if (!element.value) return;
    element.style.height = '0px';
    element.style.height = `${element.scrollHeight}px`;
  }, []);
  useLayoutEffect(resizeComposer, [draft, mobileViewport, cliVisible, sidebarOnly, resizeComposer]);
  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    let width = -1;
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry.contentRect.width;
      if (nextWidth > 0 && nextWidth !== width) { width = nextWidth; resizeComposer(); }
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, [resizeComposer]);
  useEffect(() => {
    const scroll = scrollRef.current; const composer = composerRef.current;
    if (!scroll || !composer) return;
    const observer = new ResizeObserver(() => {
      mainRef.current?.style.setProperty('--composer-height', `${composer.getBoundingClientRect().height}px`);
      if (stayBottom.current && !prependRef.current) scroll.scrollTop = scroll.scrollHeight;
    });
    observer.observe(scroll); observer.observe(composer); if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3000); return () => clearTimeout(timer); }, [toast]);

  const runAction = async (work: () => Promise<any>) => {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true); setError('');
    try { return await work(); }
    catch (e) { setError((e as Error).message); throw e; }
    finally { actionLock.current = false; setBusy(false); }
  };
  const submit = async (event?: FormEvent) => {
    event?.preventDefault(); if (!draft.trim() || busy || unknown || !canAct) return;
    const prompt = draft.trim(); const key = draftKey; const current = selected;
    const body = { operationId: crypto.randomUUID(), prompt, ...(!limited && selectedModel ? { model: selectedModel } : {}), ...(!limited && effort ? { thinking: effort } : {}) };
    // Preserve the in-flight identity before HTTP so a page refresh cannot silently resubmit.
    sessionStorage.setItem(`ac:unknown:${key}`, JSON.stringify({ operationId: body.operationId, at: Date.now() }));
    try {
      const result = await runAction(() => api(current ? `/api/threads/${current}/messages` : '/api/threads', current ? body : { ...body, ...(project && project !== 'unassigned' ? { projectId: project } : {}) }));
      if (!result) return;
      sessionStorage.removeItem(`ac:unknown:${key}`);
      saveDraft(key, ''); if (draftKeyRef.current === key) setDraft('');
      stayBottom.current = true;
      void refreshCatalog(true).catch(() => {});
      if (!current && result.threadId) setSelected(result.threadId);
      else if (current && socketRef.current?.readyState === 1) socketRef.current.send(JSON.stringify({ type: 'subscribe', threadId: current, limit: pageLimit }));
      if (result.pending) setToast(result.message);
    } catch (e) {
      if (e instanceof ApiError && (!e.status || e.status >= 500 || e.code === 'OPERATION_UNCONFIRMED')) {
        sessionStorage.setItem(`ac:unknown:${key}`, JSON.stringify({ operationId: body.operationId, at: Date.now() }));
        if (draftKeyRef.current === key) setUnknown(true);
      } else sessionStorage.removeItem(`ac:unknown:${key}`);
    }
  };
  const chooseThread = (id: string) => { showWorkspace(); setSelected(id); setCliVisible(false); if (isMobile) changeSidebar(false); };
  const newThread = () => { showWorkspace(); setSelected(null); setCliVisible(false); if (isMobile) changeSidebar(false); if (!isMobile) requestAnimationFrame(() => textareaRef.current?.focus()); };
  const respond = (request: PendingRequest, body: any) => { if (selected) void runAction(() => api(`/api/threads/${selected}/requests/${encodeURIComponent(request.id)}`, { operationId: crypto.randomUUID(), turnId: request.turnId, ...body })).then(() => setToast('已提交给桌面会话')).catch(() => {}); };
  const loadOlder = async () => {
    if (!selected || !view?.olderCursor || olderLoading) return;
    const id = selected; setOlderLoading(true); stayBottom.current = false;
    try { const value = await api(`/api/threads/${id}?cursor=${encodeURIComponent(view.olderCursor)}`); if (selectedRef.current === id) { prependRef.current = { height: scrollRef.current?.scrollHeight || 0, top: scrollRef.current?.scrollTop || 0 }; setView(v => v ? { ...v, turns: [...value.thread.turns.filter((t: DisplayTurn) => !v.turns.some(x => x.id === t.id)), ...v.turns], olderCursor: value.thread.olderCursor } : value.thread); } }
    catch (e) { setError((e as Error).message); } finally { setOlderLoading(false); }
  };
  const visibleThreads = threads.filter(t => !project || (project === 'unassigned' ? !t.projectId : t.projectId === project));
  const searchText = search.trim().toLowerCase();
  const matchingProjects = searchText ? projects.filter(item => item.name.toLowerCase().includes(searchText)) : [];
  const matchingThreads = searchText ? threads.filter(item => item.title.toLowerCase().includes(searchText)) : threads.slice(0, 10);
  const currentProject = projects.find(p => p.id === project);
  const currentSummary = threads.find(t => t.id === selected);
  const cliProject = currentProject || projects.find(p => p.id === currentSummary?.projectId);
  const currentModel = models.find(m => m.id === selectedModel);
  const efforts = currentModel?.efforts || (effort ? [effort] : []);
  const canOperate = !!desktop?.connected && !!desktop?.compatible && streamOnline && ready;
  const limited = desktop?.accessMode === 'limited';
  const active = view?.status === 'active' || view?.status === 'waiting';
  const limitedReason = !limited ? '' : !selected && !currentProject ? '请先选择已有项目，再新建会话' : selected && loading ? '正在读取会话，请稍等' : selected && !view?.live ? '请先在 Codex 桌面打开该会话，再返回发送' : selected && active ? '请等待本轮结束，或先停止；执行中追加消息请在 Codex 中处理' : '';
  const canAct = canOperate && (selected ? harness.capabilities.send : harness.capabilities.create) && !limitedReason;
  const mergedHeader = !!desktopBridge?.setHeader && !!desktopBridge.onHeaderAction;
  const conversationTitle = harness.state === 'planned' ? '接入准备中' : selected ? view?.title || currentSummary?.title || '载入会话' : '新建会话';
  const conversationStatus = view ? statusLabels[view.status] || view.status : '';
  useEffect(() => {
    if (!workspaceActive || !mergedHeader || sidebarOnly) return;
    desktopBridge?.setHeader?.(cliVisible
      ? { kind: 'cli', name: 'Codex CLI', ...cliHeader, dark: darkTheme }
      : { kind: 'conversation', name: harness.name, title: conversationTitle, status: conversationStatus, dark: darkTheme, searchAvailable: harness.state !== 'planned' });
  }, [workspaceActive, mergedHeader, desktopBridge, sidebarOnly, cliVisible, cliHeader, harness.name, harness.state, conversationTitle, conversationStatus, darkTheme]);

  const selectModel = (model: string, nextEffort: string) => {
    setSelectedModel(model); setEffort(nextEffort); setModelOpen(false);
    if (selected && view?.live && canOperate && harness.capabilities.settings && model && (nextEffort || !models.find(item => item.id === model)?.efforts.length)) {
      void runAction(() => api(`/api/threads/${selected}/settings`, { operationId: crypto.randomUUID(), model, ...(nextEffort ? { effort: nextEffort } : {}) })).then(() => setToast('模型已同步')).catch(() => {});
    }
  };
  const checkDesktop = () => { void api('/api/harnesses').then(value => setDesktop(value.desktop)).catch(error => setError((error as Error).message)); };
  return <div className={`workspace${desktopBridge ? ' desktop-shell' : ''}${sidebarOnly ? ' sidebar-only' : ''}`} data-stream-state={streamState}>
    {sidebarOpen && isMobile && <button className="drawer-backdrop" aria-label="收起侧栏" tabIndex={-1} onClick={closeSidebar}/>}
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} ref={sidebarRef} id={`workspace-sidebar-${harness.id}`} role={isMobile ? 'dialog' : undefined} aria-modal={isMobile && sidebarOpen ? true : undefined} aria-label="项目和会话" tabIndex={-1}
      onTouchStart={event => { const point = event.touches[0]; touchRef.current = { x: point.clientX, y: point.clientY }; }}
      onTouchEnd={event => { const point = event.changedTouches[0]; if (isMobile && point && touchRef.current && point.clientX - touchRef.current.x < -70 && Math.abs(point.clientY - touchRef.current.y) < 60) closeSidebar(); touchRef.current = null; }}>
      <div className="sidebar-heading"><div className="agent-identity" role="group" aria-label="切换 Agent 软件">{harnesses.map(item => <button key={item.id} type="button" className={`harness-icon ${item.id === harness.id ? 'selected' : ''}`} aria-label={`切换到 ${item.name}${item.state === 'planned' ? '，接入准备中' : ''}`} aria-pressed={item.id === harness.id} title={`${item.name}${item.state === 'planned' ? ' · 接入准备中' : ''}`} onClick={() => { if (isMobile) closeSidebar(); chooseHarness(item.id); }}>{item.id === 'dsh' ? <Sparkles size={23}/> : <Command size={23}/>}</button>)}</div>{!desktopBridge && <div className="sidebar-tools"><button className="icon-button" data-dialog-close aria-label="关闭导航" title="隐藏侧边栏" onClick={closeSidebar}><PanelLeftClose size={18}/></button></div>}</div>
      <div className="sidebar-content">
      {harness.state !== 'planned' && <>
      <div className="sidebar-primary-actions">
        <button className="new-thread" disabled={!canOperate || !harness.capabilities.create} onClick={newThread}><SquarePen size={17}/><span>新建会话</span><span className="key-hint">＋</span></button>
        {!desktopBridge && <button className="sidebar-search" ref={searchButtonRef} aria-label="搜索项目和会话" title="搜索项目和会话（Ctrl K）" onClick={() => { showWorkspace(); setSearchOpen(true); }}><Search size={16}/><span>搜索</span><kbd>Ctrl K</kbd></button>}
        {harness.id === 'codex' && <button className={`cli-entry ${cliVisible ? 'selected' : ''}`} onClick={() => { showWorkspace(); setCliMounted(true); setCliVisible(true); if (isMobile) changeSidebar(false); }}><SquareTerminal size={17}/><span>Codex CLI</span><span className="cli-badge">终端</span></button>}
      </div>
      {isMobile && <button className="mobile-project-picker" aria-expanded={projectsOpen} onClick={() => setProjectsOpen(current => !current)}><Folder size={17}/><span>{currentProject?.name || (project === 'unassigned' ? '未分类会话' : '全部项目')}</span><ChevronDown size={17}/></button>}
      {!isMobile && <button className="section-caption projects-toggle" aria-expanded={projectsOpen} onClick={() => setProjectsOpen(current => !current)}><span><ChevronRight size={12} className={projectsOpen ? 'expanded' : ''}/>项目</span><small>{projects.length}</small></button>}
      {projectsOpen && <>
        <div className="project-list">
          <button className={`project-row ${!project ? 'selected' : ''}`} onClick={() => { showWorkspace(); setProject(null); setSelected(null); setCliVisible(false); if (isMobile) setProjectsOpen(false); }}><Layers size={15}/><span>全部会话</span><small>{threads.length}</small></button>
          {projects.map(item => <button key={item.id} className={`project-row ${project === item.id ? 'selected' : ''}`} title={item.path} onClick={() => { showWorkspace(); setProject(item.id); setSelected(null); setCliVisible(false); if (isMobile) setProjectsOpen(false); }}><Folder size={15}/><span>{item.name}</span><small>{threads.filter(thread => thread.projectId === item.id).length || ''}</small></button>)}
          <button className={`project-row ${project === 'unassigned' ? 'selected' : ''}`} onClick={() => { showWorkspace(); setProject('unassigned'); setSelected(null); setCliVisible(false); if (isMobile) setProjectsOpen(false); }}><MessageSquare size={15}/><span>未分类会话</span><small>{threads.filter(thread => !thread.projectId).length}</small></button>
        </div>
      </>}
      <div className="section-caption conversations-caption"><span>{currentProject?.name || '最近会话'}</span><button className="icon-button" aria-label="刷新会话列表" title="刷新会话列表" onClick={() => void refreshCatalog(true).catch(error => setError(error.message))}><RefreshCw size={14}/></button></div>
      <div className="thread-list">{visibleThreads.map(thread => <button key={thread.id} className={`thread-row ${selected === thread.id && !cliVisible ? 'selected' : ''}`} title={thread.title} onClick={() => chooseThread(thread.id)}><span className={`thread-dot ${thread.status === 'active' ? 'working' : ''}`}/><span className="thread-copy"><span>{thread.title}</span>{!project && thread.projectId && <small>{projects.find(item => item.id === thread.projectId)?.name || '项目会话'}</small>}</span>{thread.pinned ? <Pin className="pinned-mark" size={12}/> : <span className="thread-time">{relativeTime(thread.updatedAt)}</span>}</button>)}{!visibleThreads.length && <div className="empty-list">{desktop?.connected ? '这个项目还没有会话' : '连接桌面后显示会话'}</div>}</div>
      </>}
      </div>{desktopBridge ? <div className="sidebar-footer desktop-sidebar-actions"><a className="account-link" href="/account" aria-label="账户" title="账户" onClick={showWorkspace}><UserRound size={17}/><span>账户</span></a><button className="settings-link" aria-label="设置" title="设置" onClick={() => desktopBridge.showSettings?.()}><Settings size={17}/><span>设置</span></button></div> : <div className="sidebar-footer"><span className={`status-light ${desktop?.connected ? 'online' : ''}`}/><div><strong>{harness.state === 'planned' ? '接入准备中' : desktop?.connected ? (desktop.accessMode === 'read-only' ? 'Windows 已连接 · 只读' : desktop.accessMode === 'limited' ? 'Windows 已连接 · 部分可用' : 'Windows 已连接') : '等待桌面连接'}</strong><small>{harness.state === 'planned' ? '尚未接入' : desktop?.version ? `${harness.name} ${desktop.version}` : '本地桌面工作空间'}</small></div><button className="footer-theme" aria-label="切换明暗主题" title="切换明暗主题" onClick={() => setTheme(darkTheme ? 'light' : 'dark')}>{darkTheme ? <Sun size={17}/> : <Moon size={17}/>}</button><a className="account-link" href="/help" target="_blank" rel="noopener noreferrer" aria-label="文档（新标签页）" title="文档（新标签页）"><CircleHelp size={18}/></a><a className="account-link" href="/account" aria-label="登录与账户" title="登录与账户" onClick={showWorkspace}><UserRound size={18}/></a></div>}
    </aside>
    <main className={`main-panel ${selected ? '' : 'is-empty'} ${sidebarOpen ? 'sidebar-visible' : ''}`} ref={mainRef} hidden={cliVisible}>
      {!mergedHeader && <header className="topbar"><button className="icon-button menu-button" ref={menuRef} aria-label="打开项目和会话" title="显示侧边栏" aria-controls={`workspace-sidebar-${harness.id}`} aria-expanded={sidebarOpen} onClick={() => { textareaRef.current?.blur(); changeSidebar(true); }}><PanelLeftOpen size={21}/></button>
        {isMobile ? <div className="mobile-model"><span>{harness.name}{active && <i className="working"/>}</span><small>{harness.state === 'planned' ? '接入准备中' : selected ? view?.title || currentSummary?.title || '正在载入' : currentProject?.name || '新会话'}</small></div> : <div className="breadcrumb"><span>{cliProject?.name || harness.name}</span><ChevronRight size={13}/><strong title={view?.title || currentSummary?.title}>{conversationTitle}</strong></div>}
        <div className="topbar-right">{!isMobile && view && <span className={`state-pill ${view.status}`}><span/>{conversationStatus}</span>}{isMobile && harness.state !== 'planned' && <button className="mobile-new" aria-label="新建会话" disabled={!canOperate || !harness.capabilities.create} onClick={newThread}><SquarePen size={23}/></button>}</div>
      </header>}
      {harness.state === 'planned' ? <section className="harness-planned-view" role="status"><Sparkles size={48} aria-hidden="true"/><h2>{harness.name} 接入准备中</h2></section> : <>
      {(!desktop?.connected || !streamOnline || !desktop?.compatible || limited) && ready && <div className="connection-banner" role="status"><WifiOff size={16}/><span>{streamState === 'reconnecting' ? `实时同步未连接，正在重试。请检查网络、${location.protocol === 'https:' ? 'HTTPS 地址' : '网关地址'}，并确认隧道支持实时消息转发（WebSocket）；草稿已保留` : !desktop?.connected ? `${desktop?.reason || 'Codex 桌面尚未连接'}。请在运行网关的电脑上打开 Codex 桌面` : !streamOnline ? '正在连接实时同步…' : desktop.reason || '当前仅支持查看，操作请在桌面端完成'}</span>{streamState === 'reconnecting' ? <button type="button" className="stream-retry" aria-label="立即重试实时连接" onClick={() => retryStream(value => value + 1)}>立即重试</button> : !desktop?.connected && <button type="button" className="stream-retry" onClick={checkDesktop}>检查状态</button>}</div>}
      <div className="conversation-scroll" ref={scrollRef} role="region" aria-label="聊天记录" tabIndex={0} onScroll={() => { const element = scrollRef.current; if (element) { stayBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72; setShowBottom(!stayBottom.current); } }}>
        <div className="conversation-content">
          {!selected && <section className="welcome"><div className="welcome-icon"><Sparkles size={27}/></div><span className="eyebrow">{harness.name} · 工作台</span><h2>{isMobile ? '有什么想做的？' : '今天想完成什么？'}</h2><div className="welcome-context"><Folder size={14}/><span>{currentProject?.name || '未分类会话'}</span></div>{threads.length > 0 && <div className="recent-cards recent-section"><div className="recent-heading"><span>最近工作</span><small>{visibleThreads.length} 个会话</small></div>{visibleThreads.slice(0, 3).map(thread => <button key={thread.id} onClick={() => chooseThread(thread.id)}><MessageSquare size={16}/><span className="recent-copy"><strong>{thread.title}</strong><small>{projects.find(item => item.id === thread.projectId)?.name || '未分类会话'} · {relativeTime(thread.updatedAt)}</small></span><ArrowUpRight size={15}/></button>)}</div>}</section>}
          {selected && loading && !view && <div className="loading-state"><div className="spinner"/><p>正在读取桌面会话…</p></div>}
          {view && <>{view.olderCursor && <button className="load-older" disabled={olderLoading} onClick={() => void loadOlder()}>{olderLoading ? '正在加载…' : '加载更早的消息'}</button>}{!view.live && <div className="history-note"><Circle size={11}/>{desktop?.accessMode === 'read-only' ? '显示已保存历史，更多操作请在 Codex 中进行' : limited ? '显示已保存历史，请先在 Codex 桌面打开会话后发送' : '显示已保存历史，发送消息后连接执行状态'}</div>}{view.turns.map(turn => <section className="turn" key={turn.id}>{turn.items.map(item => <Item key={item.id} item={item} harnessName={harness.name}/>)}{turn.status === 'inProgress' && <div className="thinking-line"><span className="thinking-dot"/>{harness.name} 正在处理</div>}</section>)}{view.turns.length === 0 && !loading && <div className="empty-conversation"><MessageSquare size={25}/><p>会话已连接，发送消息继续</p></div>}</>}
        </div>
      </div>
      {showBottom && <button className="jump-bottom" aria-label="滚动到最新消息" onClick={() => { stayBottom.current = true; scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }}><ArrowDown size={20}/></button>}
      <div className="composer-area" ref={composerRef}>
        <div className="composer-container">
          <div className="requests-stack">{view?.requests.map(request => <RequestCard key={request.id} request={request} busy={busy || !canOperate || !harness.capabilities.respond} onRespond={respond}/>)}</div>
          {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={() => setError('')}><X size={17}/></button></div>}
          {unknown && <div className="unknown-banner"><strong>上次提交的结果待核实</strong><span>请先在会话中确认是否已收到消息，避免重复执行</span><button onClick={() => { sessionStorage.removeItem(`ac:unknown:${draftKey}`); setUnknown(false); }}>我已核实，解除提交保护</button></div>}
          {limitedReason && <div className="compatibility-note" role="status">{limitedReason}</div>}
          <form className={`composer ${busy ? 'sending' : ''}`} onSubmit={event => void submit(event)}>
            <textarea ref={textareaRef} aria-label="消息输入框" value={draft} onChange={event => { setDraft(event.target.value); saveDraft(draftKey, event.target.value); }} placeholder={isMobile ? '发送消息…' : selected ? '继续这段会话，或补充你的要求…' : `描述你希望 ${harness.name} 完成的工作…`} rows={1} maxLength={32000} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !isMobile && !window.matchMedia('(pointer: coarse)').matches) { event.preventDefault(); void submit(); } }}/>
            <div className="composer-bottom"><div className="composer-context" title={cliProject?.path || '未分类会话'}><Folder size={13}/><span>{cliProject?.name || '未分类'}</span></div><div className="model-picker" ref={modelRef}><button className="model-chip" type="button" aria-label="选择模型" aria-haspopup="menu" aria-expanded={modelOpen} onClick={() => setModelOpen(value => !value)}><Code2 size={14}/><span>{selectedModel || '桌面默认模型'}</span>{effort && <small>{effort}</small>}<ChevronDown size={12}/></button>{modelOpen && <div className="model-menu" role="menu" aria-label="模型选择"><div className="model-menu-label">选择模型</div><button type="button" role="menuitemradio" aria-checked={!selectedModel} disabled={limited || busy} onClick={() => selectModel('', '')}><span>桌面默认模型</span>{!selectedModel && <Check size={17}/>}</button>{models.map(model => <button type="button" key={model.id} role="menuitemradio" aria-checked={selectedModel === model.id} disabled={limited || busy} onClick={() => selectModel(model.id, model.efforts.includes(effort) ? effort : model.efforts.includes('high') ? 'high' : model.efforts[0] || '')}><span>{model.id}</span>{selectedModel === model.id && <Check size={17}/>}</button>)}{selectedModel && efforts.length > 0 && <><div className="model-menu-label effort-label">思考强度</div>{efforts.map(value => <button type="button" key={value} role="menuitemradio" aria-checked={effort === value} disabled={limited || busy} onClick={() => selectModel(selectedModel, value)}><span>{value}</span>{effort === value && <Check size={17}/>}</button>)}</>}</div>}</div><div className="composer-actions">{active && harness.capabilities.interrupt && view?.activeTurnId && <button type="button" className="stop-button" aria-label="停止当前执行" title="停止当前执行" disabled={busy || !canOperate} onClick={() => void runAction(() => api(`/api/threads/${selected}/interrupt`, { operationId: crypto.randomUUID(), expectedTurnId: view.activeTurnId })).then(() => setToast('已请求停止当前执行')).catch(() => {})}><Square size={14} fill="currentColor"/></button>}<button className="send-button" type="submit" aria-label={selected ? '发送消息' : '创建会话并发送'} disabled={!canAct || !draft.trim() || busy || unknown}>{busy ? <span className="button-spinner"/> : <ArrowUp size={20}/>}</button></div></div>
          </form>
        </div>
      </div>
      </>}
      {toast && <div className="toast" role="status"><CheckCheck size={16}/>{toast}</div>}
    </main>
    {cliMounted && <CliTerminal visible={workspaceActive && cliVisible && !sidebarOnly} projectId={cliProject?.id} projectName={cliProject?.name} sidebarOpen={sidebarOpen} onOpenSidebar={() => changeSidebar(true)} mergedHeader={mergedHeader} onHeaderChange={setCliHeader} onHeaderAction={desktopBridge?.onHeaderAction}/>}
    {searchOpen && createPortal(<dialog className="search-dialog" ref={searchRef} aria-label="搜索项目和会话" onCancel={event => { event.preventDefault(); closeSearch(); }} onClick={event => { if (event.target === event.currentTarget) closeSearch(); }}><div className="search-dialog-input"><Search size={20}/><input ref={searchInputRef} aria-label="搜索项目和会话" placeholder="搜索项目和会话" value={search} onChange={event => setSearch(event.target.value)}/><button className="icon-button" aria-label="关闭搜索" title="关闭搜索" onClick={closeSearch}><X size={19}/></button></div><div className="search-results">{matchingProjects.length > 0 && <><div className="search-result-label">项目</div>{matchingProjects.map(item => <button key={item.id} className="search-result" onClick={() => { setProject(item.id); setSelected(null); setCliVisible(false); closeSearch(); if (isMobile) changeSidebar(false); }}><Folder size={17}/><span>{item.name}</span></button>)}</>}<div className="search-result-label">{searchText ? '会话' : '最近会话'}</div>{matchingThreads.map(thread => <button key={thread.id} className="search-result" onClick={() => { setProject(thread.projectId); chooseThread(thread.id); closeSearch(); }}><MessageSquare size={17}/><span>{thread.title}</span></button>)}{searchText && !matchingProjects.length && !matchingThreads.length && <div className="empty-list">没有匹配的项目或会话</div>}</div></dialog>, document.body)}
  </div>;
}
