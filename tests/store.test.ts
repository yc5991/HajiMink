import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { removeTempFixture } from './safe-temp';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store';
import { AppError } from '../server/errors';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempFixture(dir, 'agent-control-test-'); });
function setup() { const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-control-test-')); dirs.push(dir); return { dir, store: new Store(dir) }; }
describe('durable operation protection', () => {
  it('executes a repeated operation once and rejects altered content', async () => {
    const { store } = setup(); let calls = 0; const id = randomUUID();
    await store.operation(id, 'send', 'thread1', { prompt: 'hello' }, async () => ({ accepted: ++calls }));
    await expect(store.operation(id, 'send', 'thread1', { prompt: 'hello' }, async () => (++calls))).resolves.toEqual({ accepted: 1 });
    await expect(store.operation(id, 'send', 'thread1', { prompt: 'changed' }, async () => ({}))).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(calls).toBe(1); store.close();
  });
  it('does not retry an uncertain action after restart', async () => {
    const { store, dir } = setup(); const id = randomUUID();
    await expect(store.operation(id, 'send', 'thread1', {}, async () => { throw new AppError('DESKTOP_TIMEOUT', 'timeout', 504); })).rejects.toThrow(); store.close();
    const reopened = new Store(dir); await expect(reopened.operation(id, 'send', 'thread1', {}, async () => ({}))).rejects.toMatchObject({ code: 'OPERATION_UNCONFIRMED' }); reopened.close();
  });
  it('allows only one client to decide the same pending approval', async () => {
    const { store } = setup(); await store.operation(randomUUID(), 'respond', 'thread:request9', {}, async () => ({ accepted: true }));
    await expect(store.operation(randomUUID(), 'respond', 'thread:request9', {}, async () => ({}))).rejects.toMatchObject({ code: 'STALE_REQUEST' }); store.close();
  });
});
