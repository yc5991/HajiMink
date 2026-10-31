import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.js';

export interface CliTerminal {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): unknown;
  onExit(callback: (result: { exitCode: number }) => void): unknown;
}
export type CliSpawn = (cwd: string, cols: number, rows: number) => CliTerminal | Promise<CliTerminal>;

export function findCodexExecutable(): string {
  const windows = process.platform === 'win32';
  const name = windows ? 'codex.exe' : 'codex';
  const candidates = (process.env.PATH || '').split(path.delimiter).filter(Boolean).flatMap(dir =>
    windows ? [path.join(dir, name), path.join(dir, 'codex.cmd')] : [path.join(dir, name)]
  );
  if (windows) {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'codex.cmd'));
  }
  for (const candidate of candidates) {
    try { if (path.isAbsolute(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  throw new AppError('CLI_NOT_FOUND', '未找到 Codex CLI，请先在网关所在电脑安装并登录 Codex CLI', 409);
}

export const spawnCodex: CliSpawn = async (cwd, cols, rows) => {
  const executable = findCodexExecutable();
  const isCmd = process.platform === 'win32' && /\.cmd$/i.test(executable);
  const file = isCmd ? (process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')) : executable;
  const args = isCmd ? ['/d', '/s', '/c', `"${executable}"`] : [];
  const failed = () => new AppError('CLI_START_FAILED', 'Codex CLI 无法启动，请检查安装和工作目录', 409);
  const helper = fileURLToPath(new URL('./cli-pty-worker.cjs', import.meta.url));
  if (!fs.existsSync(helper)) throw failed();
  return new Promise<CliTerminal>((resolve, reject) => {
    let ready = false, ended = false, stopping = false;
    let dataHandler: ((data: string) => void) | undefined, exitHandler: ((result: { exitCode: number }) => void) | undefined;
    let exitResult: { exitCode: number } | undefined;
    const pending: string[] = []; let pendingLength = 0;
    let child: ReturnType<typeof fork>;
    try { child = fork(helper, [], { cwd, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env }); }
    catch { reject(failed()); return; }
    const send = (message: object) => { if (child.connected) { try { child.send(message, () => {}); } catch {} } };
    const stop = () => {
      if (stopping || ended) return;
      stopping = true; send({ type: 'stop' });
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 8000); timer.unref();
      child.once('exit', () => clearTimeout(timer));
    };
    const terminal: CliTerminal = {
      write: data => send({ type: 'input', data }), resize: (width, height) => send({ type: 'resize', cols: width, rows: height }), kill: stop,
      onData: callback => { dataHandler = callback; pendingLength = 0; for (const data of pending.splice(0)) callback(data); },
      onExit: callback => { exitHandler = callback; if (exitResult) callback(exitResult); }
    };
    const fail = () => { if (ready || ended) return; ended = true; clearTimeout(timer); if (child.connected) child.disconnect(); reject(failed()); };
    const finish = (code: number) => { if (exitResult) return; exitResult = { exitCode: code }; exitHandler?.(exitResult); };
    const timer = setTimeout(() => { fail(); if (child.exitCode === null && child.signalCode === null) child.kill(); }, 12000); timer.unref();
    child.on('error', fail);
    child.on('exit', code => { if (!ready) fail(); else finish(code ?? 1); ended = true; });
    child.on('message', value => {
      if (!value || typeof value !== 'object' || !('type' in value)) return;
      if (value.type === 'started' && !ready && !ended) { ready = true; clearTimeout(timer); resolve(terminal); }
      else if (value.type === 'output' && 'data' in value && typeof value.data === 'string') { if (dataHandler) dataHandler(value.data); else if (pendingLength < 1024 * 1024) { pending.push(value.data); pendingLength += value.data.length; } }
      else if (value.type === 'exit' && 'code' in value && typeof value.code === 'number') finish(value.code);
      else if (value.type === 'error' && !ready) fail();
    });
    send({ type: 'start', file, args, cwd, cols, rows });
  });
};
