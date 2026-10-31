import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { PanelLeftOpen, Play, Square } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { initializeSession } from './api';

type TerminalState = 'idle' | 'connecting' | 'running' | 'ended' | 'error';
export type CliHeaderState = { title: string; status: string; action: 'start' | 'stop' };

export function CliTerminal({ visible, projectId, projectName, sidebarOpen, onOpenSidebar, mergedHeader, onHeaderChange, onHeaderAction }: { visible: boolean; projectId?: string; projectName?: string; sidebarOpen: boolean; onOpenSidebar: () => void; mergedHeader: boolean; onHeaderChange: (value: CliHeaderState) => void; onHeaderAction?: (callback: (action: 'start' | 'stop') => void) => () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const errorRef = useRef(false);
  const readyRef = useRef(false);
  const startingRef = useRef(false);
  const generationRef = useRef(0);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const [state, setState] = useState<TerminalState>('idle');
  const [message, setMessage] = useState('');
  const [runningProject, setRunningProject] = useState('');
  const actionRef = useRef<(action: 'start' | 'stop') => void>(() => {});

  const resize = useCallback(() => {
    if (!visibleRef.current || !fitRef.current || !terminalRef.current) return;
    try { fitRef.current.fit(); } catch { return; }
    const { cols, rows } = terminalRef.current;
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: 'resize', cols: Math.min(300, Math.max(20, cols)), rows: Math.min(100, Math.max(5, rows)) }));
  }, []);
  useEffect(() => {
    const host = hostRef.current; if (!host) return;
    const terminal = new Terminal({ cursorBlink: true, fontFamily: 'Consolas, "Cascadia Mono", monospace', fontSize: 13, scrollback: 3000, theme: { background: '#181b1d', foreground: '#e6e8e7', cursor: '#dce9df', selectionBackground: '#536a5a' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host);
    terminalRef.current = terminal; fitRef.current = fit;
    const data = terminal.onData(value => {
      const socket = socketRef.current; if (!readyRef.current || !socket || socket.readyState !== WebSocket.OPEN) return;
      const chars = Array.from(value);
      for (let index = 0; index < chars.length; index += 128) socket.send(JSON.stringify({ type: 'input', data: chars.slice(index, index + 128).join('') }));
    });
    const observer = new ResizeObserver(resize); observer.observe(host);
    return () => { generationRef.current++; readyRef.current = false; observer.disconnect(); data.dispose(); socketRef.current?.close(); socketRef.current = null; terminalRef.current = null; fitRef.current = null; terminal.dispose(); };
  }, [resize]);
  useEffect(() => { if (visible) { const frame = requestAnimationFrame(() => { resize(); if (state === 'running') terminalRef.current?.focus(); }); return () => cancelAnimationFrame(frame); } }, [visible, resize, state]);

  const start = async () => {
    if (startingRef.current || state === 'connecting' || (socketRef.current && socketRef.current.readyState < WebSocket.CLOSING)) return;
    startingRef.current = true;
    const generation = ++generationRef.current;
    errorRef.current = false; setState('connecting'); setMessage('');
    try {
      await initializeSession();
      if (generation !== generationRef.current) return;
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/cli`);
      socketRef.current = socket; setRunningProject(projectName || '用户目录');
      socket.onopen = () => {
        resize(); const terminal = terminalRef.current;
        socket.send(JSON.stringify({ type: 'start', ...(projectId ? { projectId } : {}), cols: Math.min(300, Math.max(20, terminal?.cols || 80)), rows: Math.min(100, Math.max(5, terminal?.rows || 24)) }));
      };
      socket.onmessage = event => { if (generation !== generationRef.current) return; try {
        const value = JSON.parse(event.data);
        if (value.type === 'started') { readyRef.current = true; setState('running'); terminalRef.current?.focus(); }
        if (value.type === 'output' && typeof value.data === 'string') terminalRef.current?.write(value.data);
        if (value.type === 'exit') { terminalRef.current?.writeln(`\r\n[Codex CLI 已退出：${value.code}]`); setState('ended'); }
        if (value.type === 'error') { errorRef.current = true; setMessage(value.message || '终端连接失败'); setState('error'); }
      } catch {} };
      socket.onerror = () => { if (generation !== generationRef.current) return; errorRef.current = true; setMessage('终端连接失败，请检查网关和网络'); setState('error'); };
      socket.onclose = () => { if (generation !== generationRef.current) return; readyRef.current = false; if (socketRef.current === socket) socketRef.current = null; if (!errorRef.current) setState('ended'); };
    } catch (error) { if (generation === generationRef.current) { errorRef.current = true; setMessage((error as Error).message); setState('error'); } }
    finally { startingRef.current = false; }
  };
  const stop = () => {
    if (state === 'running' && !window.confirm('结束终端会停止其中正在执行的 CLI 任务。确定结束？')) return;
    generationRef.current++; readyRef.current = false; socketRef.current?.close(); socketRef.current = null; setState('ended');
  };
  const action = state === 'running' || state === 'connecting' ? 'stop' : 'start';
  const title = state === 'running' ? runningProject : projectName || '用户目录';
  const status = message || ({ idle: '未启动', connecting: '连接中', running: '运行中', ended: '已结束', error: '连接失败' })[state];
  actionRef.current = requested => { if (requested !== action) return; if (requested === 'start') void start(); else stop(); };
  useEffect(() => { onHeaderChange({ title, status, action }); }, [onHeaderChange, title, status, action]);
  useEffect(() => {
    if (!visible || !onHeaderAction) return;
    return onHeaderAction(requested => actionRef.current(requested));
  }, [visible, onHeaderAction]);
  return <main className="cli-panel" hidden={!visible}>
    {!mergedHeader && <header className="cli-topbar">
      {!sidebarOpen && <button className="icon-button" aria-label="打开项目和会话" title="显示侧边栏" onClick={onOpenSidebar}><PanelLeftOpen size={19}/></button>}
      <div className="cli-title"><strong>Codex CLI</strong><span>{state === 'running' ? runningProject : projectName || '用户目录'}</span></div>
      <span className="cli-status" role="status">{message || ({ idle: '未启动', connecting: '连接中', running: '运行中', ended: '已结束', error: '连接失败' })[state]}</span>
      {state === 'running' || state === 'connecting' ? <button className="cli-action" title="结束终端" aria-label="结束终端" onClick={stop}><Square size={15}/></button> : <button className="cli-action" title="启动 Codex CLI" aria-label="启动 Codex CLI" onClick={() => void start()}><Play size={16}/></button>}
    </header>}
    <div className="cli-screen"><div className="cli-terminal" ref={hostRef} aria-label="Codex CLI 终端"/></div>
  </main>;
}
