import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { removeTempFixture } from './safe-temp';

const fakeFork = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ fork: fakeFork }));
import { spawnCodex } from '../server/cli-terminal';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  fakeFork.mockReset();
  for (const directory of directories.splice(0)) removeTempFixture(directory, 'hajimink-cli-buffer-');
});

it('buffers early output in order, preserves the limit and forwards later output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-cli-buffer-')); directories.push(dir);
  fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex'), 'fixture');
  vi.stubEnv('PATH', dir);
  const child = Object.assign(new EventEmitter(), {
    connected: true, exitCode: null, signalCode: null,
    send: vi.fn((_message: unknown, callback?: () => void) => callback?.()),
    disconnect: vi.fn(), kill: vi.fn()
  });
  fakeFork.mockReturnValue(child);

  const starting = spawnCodex(dir, 80, 24);
  const first = 'a'.repeat(1024 * 1024 - 2);
  child.emit('message', { type: 'output', data: first });
  child.emit('message', { type: 'output', data: 'xyz' });
  child.emit('message', { type: 'output', data: 'discarded' });
  child.emit('message', { type: 'started', pid: 42 });
  const terminal = await starting;
  const received: string[] = [];
  terminal.onData(value => received.push(value));
  child.emit('message', { type: 'output', data: 'live' });
  expect(received).toEqual([first, 'xyz', 'live']);
});
