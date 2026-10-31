import { EventEmitter, once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { removeTempFixture } from './safe-temp';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../server/app';
import { HarnessRegistry, fullCapabilities, type HarnessAdapter } from '../server/harness';
import type { DesktopStatus, ThreadView } from '../shared/types';
import { withHarness } from '../shared/harness-url';

function fake(name: string) {
  const status: DesktopStatus = { connected: true, compatible: true, version: 'test', supportedVersion: 'test' };
  const view: ThreadView = { id: 'same-native-thread', title: name, revision: 1, live: true, status: 'idle', permissionLabel: 'test', turns: [], totalTurns: 0, olderCursor: null, requests: [] };
  return Object.assign(new EventEmitter(), {
    status, start: vi.fn(async () => {}), close: vi.fn(), touch: vi.fn(),
    catalog: vi.fn(async () => ({ projects: [{ id: 'same-project', name, hostId: 'local' }], threads: [{ id: view.id, title: name, projectId: 'same-project', status: 'idle', updatedAt: 1 }] })),
    models: () => [{ id: name, efforts: ['high'] }], view: vi.fn(async () => view), viewCached: vi.fn(() => view),
    create: vi.fn(async () => ({ threadId: view.id })), send: vi.fn(async () => ({ sent: name })), interrupt: vi.fn(async () => ({ stopped: name })),
    settings: vi.fn(async () => ({ model: name })), respond: vi.fn(async () => ({ answered: name })),
  });
}
async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-control-harness-'));
  const codex = fake('Codex'); const second = fake('Second');
  const registry = new HarnessRegistry().register('codex', 'Codex', codex, fullCapabilities).register('second', 'Second', second, fullCapabilities).plan('dsh', 'DSH', '接入准备中');
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://localhost:3000', dataDir: directory }, { registry, serveStatic: false });
  const session = await app.inject({ url: '/api/session', headers: { host: 'localhost:3000' } });
  const headers = { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: String(session.headers['set-cookie']).split(';')[0], 'x-agent-control-csrf': session.json().csrf };
  return { app, headers, codex, second, close: async () => { await app.close(); removeTempFixture(directory, 'agent-control-harness-'); } };
}
it('selects native catalogs and history without changing native IDs or falling back from an unknown adapter', async () => {
  const f = await fixture();
  try {
    const list = (await f.app.inject({ url: '/api/harnesses', headers: f.headers })).json().harnesses;
    expect(list.find((h: any) => h.id === 'dsh')).toMatchObject({ state: 'planned', capabilities: { send: false }, status: { connected: false } });
    expect((await f.app.inject({ url: '/api/projects?harness=second', headers: f.headers })).json().projects[0].name).toBe('Second');
    expect((await f.app.inject({ url: '/api/threads/same-native-thread?harness=second', headers: f.headers })).json().thread).toMatchObject({ id: 'same-native-thread', title: 'Second' });
    expect((await f.app.inject({ url: '/api/threads/same-native-thread', headers: f.headers })).json().thread.title).toBe('Codex');
    expect((await f.app.inject({ url: '/api/projects?harness=typo', headers: f.headers })).statusCode).toBe(404);
    expect((await f.app.inject({ url: '/api/projects?harness=dsh', headers: f.headers })).statusCode).toBe(409);
    expect(f.codex.catalog).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
it('routes every write to the selected adapter and keeps operation deduplication separate for identical native IDs', async () => {
  const f = await fixture();
  try {
    const op = randomUUID();
    const send = (harness: string, operationId = op) => f.app.inject({ method: 'POST', url: withHarness('/api/threads/same-native-thread/messages', harness), headers: f.headers, payload: { operationId, prompt: 'test' } });
    expect((await send('second')).json()).toEqual({ sent: 'Second' });
    expect((await send('second')).statusCode).toBe(200); expect(f.second.send).toHaveBeenCalledTimes(1);
    // Reusing an operation ID for another adapter is a conflict, never another execution.
    expect((await send('codex')).statusCode).toBe(409); expect(f.codex.send).not.toHaveBeenCalled();
    expect((await send('codex', randomUUID())).statusCode).toBe(200);
    for (const [route, body, method] of [
      ['/api/threads', { prompt: 'test', projectId: 'same-project' }, 'create'],
      ['/api/threads/same-native-thread/interrupt', { expectedTurnId: 'same-turn' }, 'interrupt'],
      ['/api/threads/same-native-thread/settings', { model: 'Second' }, 'settings'],
      ['/api/threads/same-native-thread/requests/same-request', { turnId: 'same-turn', decision: 'decline' }, 'respond'],
    ] as const) {
      expect((await f.app.inject({ method: 'POST', url: withHarness(route, 'second'), headers: f.headers, payload: { operationId: randomUUID(), ...body } })).statusCode).toBe(200);
      expect(f.second[method]).toHaveBeenCalledTimes(1); expect(f.codex[method]).not.toHaveBeenCalled();
    }
    expect(f.second.settings).toHaveBeenCalledWith('same-native-thread', 'Second', undefined);
  } finally { await f.close(); }
});
it('isolates project and conversation preferences while sharing the theme', async () => {
  const f = await fixture();
  try {
    for (const harness of ['codex', 'second']) await f.app.inject({ method: 'POST', url: withHarness('/api/preferences', harness), headers: f.headers, payload: { selectedThread: `${harness}-thread`, selectedProject: `${harness}-project`, theme: 'dark' } });
    for (const harness of ['codex', 'second']) expect((await f.app.inject({ url: withHarness('/api/preferences', harness), headers: f.headers })).json()).toEqual({ selectedThread: `${harness}-thread`, selectedProject: `${harness}-project`, theme: 'dark' });
  } finally { await f.close(); }
});
it('isolates realtime updates even when two adapters have the same native conversation ID', async () => {
  const f = await fixture(); const sockets: any[] = [];
  try {
    await f.app.ready();
    for (const harness of ['codex', 'second']) {
      const socket = await f.app.injectWS(withHarness('/api/events', harness), { socket: { remoteAddress: '127.0.0.1' }, headers: f.headers } as any); sockets.push(socket);
      const received = once(socket, 'message'); socket.send(JSON.stringify({ type: 'subscribe', threadId: 'same-native-thread', limit: harness === 'second' ? 7 : 20 }));
      expect(JSON.parse((await received)[0].toString()).harness).toBe(harness);
    }
    const wrong: any[] = []; sockets[0].on('message', (value: any) => wrong.push(value));
    const received = once(sockets[1], 'message'); f.second.emit('thread', 'same-native-thread');
    expect(JSON.parse((await received)[0].toString()).thread.title).toBe('Second');
    expect(wrong).toHaveLength(0);
    expect(f.second.view).toHaveBeenCalledWith('same-native-thread', 7);
    expect(f.second.viewCached).toHaveBeenCalledWith('same-native-thread', 7);
  } finally { sockets.forEach(socket => socket.terminate()); await f.close(); }
});
it('rejects unadvertised capabilities and duplicate adapter IDs', () => {
  const registry = new HarnessRegistry().register('codex', 'Codex', fake('Codex') as HarnessAdapter, { ...fullCapabilities, send: false });
  expect(() => registry.require('codex', 'send')).toThrow('不支持');
  expect(() => registry.plan('codex', 'duplicate', 'test')).toThrow('duplicate');
  expect(withHarness('/api/threads?cursor=earlier', 'second')).toBe('/api/threads?cursor=earlier&harness=second');
});

it('advertises and enforces read-only mode on every desktop write route while retaining reads', async () => {
  const f = await fixture();
  try {
    f.codex.status = { connected: true, compatible: false, accessMode: 'read-only', version: '26.1023.6123.0', supportedVersion: '26.1021.3705.0', reason: '仅支持查看' };
    const info = (await f.app.inject({ url: '/api/harnesses', headers: f.headers })).json().harnesses.find((item: any) => item.id === 'codex');
    expect(info.capabilities).toEqual({ read: true, create: false, send: false, interrupt: false, settings: false, respond: false });
    expect((await f.app.inject({ url: '/api/projects', headers: f.headers })).statusCode).toBe(200);
    for (const [route, body, method] of [
      ['/api/threads', { prompt: 'test' }, 'create'],
      ['/api/threads/same-native-thread/messages', { prompt: 'test' }, 'send'],
      ['/api/threads/same-native-thread/interrupt', { expectedTurnId: 'same-turn' }, 'interrupt'],
      ['/api/threads/same-native-thread/settings', { model: 'model-a' }, 'settings'],
      ['/api/threads/same-native-thread/requests/same-request', { turnId: 'same-turn', decision: 'decline' }, 'respond'],
    ] as const) {
      const result = await f.app.inject({ method: 'POST', url: route, headers: f.headers, payload: { operationId: randomUUID(), ...body } });
      expect(result.statusCode).toBe(409);
      expect(result.json().error.code).toBe('DESKTOP_READ_ONLY');
      expect(f.codex[method]).not.toHaveBeenCalled();
    }
    f.codex.status = { connected: true, compatible: true, accessMode: 'full', version: 'test', supportedVersion: 'test' };
    expect((await f.app.inject({ url: '/api/harnesses', headers: f.headers })).json().harnesses.find((item: any) => item.id === 'codex').capabilities.send).toBe(true);
  } finally { await f.close(); }
});

it('exposes only verified operations in limited mode and rejects settings and approvals at the gateway', async () => {
  const f = await fixture();
  try {
    f.codex.status = { connected: true, compatible: true, accessMode: 'limited', version: '26.1023.6123.0', supportedVersion: '26.1021.3705.0' };
    const info = (await f.app.inject({ url: '/api/harnesses', headers: f.headers })).json().harnesses.find((item: any) => item.id === 'codex');
    expect(info.capabilities).toEqual({ read: true, create: true, send: true, interrupt: true, settings: false, respond: false });
    for (const [route, body] of [
      ['/api/threads/same-native-thread/settings', { model: 'fixture' }],
      ['/api/threads/same-native-thread/requests/same-request', { turnId: 'same-turn', decision: 'decline' }],
    ] as const) {
      const result = await f.app.inject({ method: 'POST', url: route, headers: f.headers, payload: { operationId: randomUUID(), ...body } });
      expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe('DESKTOP_UNVERIFIED');
    }
    expect(f.codex.settings).not.toHaveBeenCalled(); expect(f.codex.respond).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
