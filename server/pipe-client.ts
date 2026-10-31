import net, { type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { encodeFrame, FrameDecoder } from './framing.js';
import { AppError } from './errors.js';

// Only the pinned desktop adapter may select methods; browsers never send raw IPC.
export class IpcClient extends EventEmitter {
  private socket?: Socket;
  private clientId = 'initializing-client';
  private connecting?: Promise<void>;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  get connected() { return !!this.socket && !this.socket.destroyed && this.clientId !== 'initializing-client'; }
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    const opening = this.open(); this.connecting = opening;
    try { await opening; } finally { if (this.connecting === opening) this.connecting = undefined; }
  }
  private retire(socket: Socket) {
    if (this.socket !== socket) return;
    this.socket = undefined; this.clientId = 'initializing-client'; this.connecting = undefined;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new AppError('DESKTOP_OFFLINE', '桌面连接已断开', 503)); }
    this.pending.clear(); this.emit('offline');
  }
  private async open() {
    const socket = net.connect('\\\\.\\pipe\\codex-ipc');
    const decoder = new FrameDecoder();
    this.socket = socket; this.clientId = 'initializing-client';
    socket.on('data', chunk => {
      if (this.socket !== socket) return;
      try { for (const message of decoder.push(chunk)) { if (this.socket !== socket) break; this.receive(message); } }
      catch { socket.destroy(); }
    });
    socket.on('error', () => {});
    socket.on('close', () => this.retire(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer); socket.off('connect', onConnect); socket.off('error', onError); socket.off('close', onClose);
          if (error) reject(error); else resolve();
        };
        const onConnect = () => finish();
        const onError = () => finish(new AppError('DESKTOP_OFFLINE', '无法连接 Codex 桌面应用', 503));
        const onClose = () => finish(new AppError('DESKTOP_OFFLINE', '桌面连接已断开', 503));
        const timer = setTimeout(() => { socket.destroy(); finish(new AppError('DESKTOP_OFFLINE', 'Codex 桌面应用未运行', 503)); }, 4000);
        socket.once('connect', onConnect); socket.once('error', onError); socket.once('close', onClose);
      });
      if (this.socket !== socket || socket.destroyed) throw new AppError('DESKTOP_OFFLINE', '桌面连接已断开', 503);
      const response = await this.requestRaw('initialize', { clientType: 'agent-control' }, 0);
      if (this.socket !== socket || socket.destroyed) throw new AppError('DESKTOP_OFFLINE', '桌面连接已断开', 503);
      const id = response?.result?.clientId;
      if (typeof id !== 'string' || !id || id.length > 256 || id === 'initializing-client') throw new AppError('DESKTOP_PROTOCOL', '桌面连接初始化数据无效', 502);
      this.clientId = id; this.emit('online');
    } catch (error) {
      this.retire(socket); socket.destroy(); throw error;
    }
  }
  private receive(message: any) {
    if (message.type === 'response') {
      const entry = this.pending.get(message.requestId); if (!entry) return;
      clearTimeout(entry.timer); this.pending.delete(message.requestId);
      if (message.resultType === 'error') entry.reject(new AppError('DESKTOP_REQUEST_FAILED', `桌面端拒绝请求：${String(message.error).slice(0, 150)}`, 409));
      else entry.resolve(message);
    } else if (message.type === 'broadcast') this.emit('broadcast', message);
    else if (message.type === 'client-discovery-request') {
      // A viewer never claims thread ownership or handles requests for the desktop.
      this.write({ type: 'client-discovery-response', requestId: message.requestId, clientId: this.clientId, canHandle: false });
    }
  }
  private write(message: unknown) {
    if (!this.socket?.writable) throw new AppError('DESKTOP_OFFLINE', '桌面连接不可用', 503);
    this.socket.write(encodeFrame(message));
  }
  private requestRaw(method: string, params: unknown, version: number, targetClientId?: string, timeoutMs = 8000): Promise<any> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new AppError('DESKTOP_TIMEOUT', '桌面端未及时确认，请核实状态后再操作', 504)); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.write({ type: 'request', requestId, sourceClientId: this.clientId, version, method, params, targetClientId, timeoutMs }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  async request(method: string, params: unknown, version = 1, target?: string, timeoutMs?: number) {
    await this.connect(); return this.requestRaw(method, params, version, target, timeoutMs);
  }
  following(threadId: string, owner: string, following: boolean) {
    this.write({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: this.clientId, version: 1, targetClientIds: [owner], params: { conversationId: threadId, hostId: 'local', following } });
  }
  close() { const socket = this.socket; if (socket) { this.retire(socket); socket.destroy(); } }
}

export async function nativeRequest(pipePath: string, method: string, params?: unknown, timeoutMs = 30000): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath); const decoder = new FrameDecoder(8 * 1024 * 1024); let settled = false;
    const done = (error?: Error, value?: any) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => done(new AppError('DESKTOP_TIMEOUT', '操作仍待桌面确认，请勿重复提交', 504)), timeoutMs);
    socket.on('connect', () => { socket.write(encodeFrame({ id: 1, jsonrpc: '2.0', method, params }, 8 * 1024 * 1024)); });
    socket.on('data', chunk => {
      try { for (const message of decoder.push(chunk)) if (message.id === 1) message.error ? done(new AppError('DESKTOP_REQUEST_FAILED', message.error.message, 409)) : done(undefined, message.result); }
      catch { done(new AppError('DESKTOP_PROTOCOL', '桌面数据格式不兼容', 502)); }
    });
    socket.on('error', () => done(new AppError('DESKTOP_OFFLINE', '桌面工具桥不可用', 503)));
    socket.on('close', () => { if (!settled) done(new AppError('DESKTOP_OFFLINE', '桌面工具桥已断开', 503)); });
  });
}
