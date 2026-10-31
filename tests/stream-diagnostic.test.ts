import { expect, it } from 'vitest';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { StreamDiagnostic } from '../server/stream-diagnostic';
import { buildApp } from '../server/app';
import { Store } from '../server/store';
import { OwnerAuth } from '../server/owner-auth';
import { removeTempFixture } from './safe-temp';

const adapter = () => Object.assign(new EventEmitter(), { status: { connected: false, compatible: false }, close() {} });
const origin = 'https://fixture.example';
const baseHeaders = { host: 'fixture.example', origin };

it('uses a short-lived, one-use ticket and bounds active diagnostics', () => {
  let now = 1000;
  const model = new StreamDiagnostic(() => now);
  const first = model.issue();
  expect(first.expiresAt).toBe(21000);
  expect(model.claim('x'.repeat(43))).toBeUndefined();
  const release = model.claim(first.token);
  expect(release).toBeTypeOf('function');
  expect(model.claim(first.token)).toBeUndefined();
  expect(() => model.issue()).toThrow();
  release!(); release!();
  expect(model.claim(first.token)).toBeUndefined();
  const replaced = model.issue(); const latest = model.issue();
  expect(model.claim(replaced.token)).toBeUndefined();
  now = latest.expiresAt;
  expect(model.claim(latest.token)).toBeUndefined();
  const cleared = model.issue(); model.clear(); expect(model.claim(cleared.token)).toBeUndefined();
});

it('allows only a bounded diagnostic upgrade and keeps all business interfaces protected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-stream-diagnostic-'));
  const store = new Store(dir); await new OwnerAuth(store.db, origin).setPassword('fixture-only-password-2026');
  const { app, streamDiagnostic } = await buildApp({ mode: 'owner', port: 3000, publicOrigin: origin, dataDir: dir }, { adapter: adapter() as any, store, serveStatic: false });
  const sockets: any[] = [];
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const connect = (route: string, headers: Record<string, string>) => new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${route}`, { headers });
      socket.once('open', () => resolve(socket)); socket.once('error', reject);
    });
    const first = streamDiagnostic.issue();
    const good = { ...baseHeaders, 'x-hajimink-diagnostic': first.token };
    for (const headers of [baseHeaders, { ...good, host: 'wrong.example' }, { ...good, origin: 'https://wrong.example' }, { ...good, 'x-hajimink-diagnostic': 'x'.repeat(43) }]) {
      await expect(connect('/api/diagnostics/stream', headers)).rejects.toThrow();
    }
    // A plain request, query parameter, or credential presented to a business
    // route must not consume the ticket or grant access.
    for (const url of ['/api/diagnostics/stream', '/api/session', '/api/projects', '/api/threads']) {
      const response = await app.inject({ method: 'GET', url, headers: good });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain(first.token);
    }
    await expect(connect('/api/events', good)).rejects.toThrow();
    await expect(connect('/api/diagnostics/stream?token=bad', good)).rejects.toThrow();
    const socket = await connect('/api/diagnostics/stream', good); sockets.push(socket);
    await expect(connect('/api/diagnostics/stream', good)).rejects.toThrow();
    expect(() => streamDiagnostic.issue()).toThrow();
    const reply = once(socket, 'message'); const closed = once(socket, 'close');
    socket.send(JSON.stringify({ type: 'ping', nonce: 'a'.repeat(32) }));
    expect(JSON.parse((await reply)[0].toString())).toEqual({ type: 'pong', nonce: 'a'.repeat(32) });
    await closed;
    await expect(connect('/api/diagnostics/stream', good)).rejects.toThrow();
    const second = streamDiagnostic.issue();
    const invalid = await connect('/api/diagnostics/stream', { ...baseHeaders, 'x-hajimink-diagnostic': second.token }); sockets.push(invalid);
    const invalidClose = once(invalid, 'close'); invalid.send(JSON.stringify({ type: 'ping', nonce: 'b'.repeat(32), extra: 'do not echo' }));
    expect((await invalidClose)[0]).toBe(1008);
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.close(); removeTempFixture(dir, 'hajimink-stream-diagnostic-');
  }
});
