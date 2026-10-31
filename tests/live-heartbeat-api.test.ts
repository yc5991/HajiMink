import { expect, it } from 'vitest';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';
import { buildApp } from '../server/app';
import { Store } from '../server/store';
import { OwnerAuth } from '../server/owner-auth';
import { LIVE_HEARTBEAT_PROTOCOL } from '../shared/live-heartbeat';
import { removeTempFixture } from './safe-temp';

const fixtureAdapter = () => Object.assign(new EventEmitter(), { status: { connected: false, compatible: false }, close() {} });

it('advertises and answers only bounded heartbeat messages on the authenticated event stream', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-heartbeat-'));
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: fixtureAdapter() as any, serveStatic: false });
  let socket: WebSocket | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as net.AddressInfo).port, origin = `http://127.0.0.1:${port}`;
    const response = await fetch(`${origin}/api/session`), cookie = response.headers.get('set-cookie')!.split(';')[0];
    socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { headers: { origin, cookie } });
    const greeting = once(socket, 'message'); await once(socket, 'open');
    expect(JSON.parse((await greeting)[0].toString())).toMatchObject({ type: 'desktop', harness: 'codex', heartbeat: LIVE_HEARTBEAT_PROTOCOL });
    let reply = once(socket, 'message'); socket.send(JSON.stringify({ type: 'heartbeat-ping', nonce: 'invalid' }));
    expect(JSON.parse((await reply)[0].toString())).toEqual({ type: 'error', message: '实时连接请求无效' });
    const nonce = 'a'.repeat(32); reply = once(socket, 'message'); socket.send(JSON.stringify({ type: 'heartbeat-ping', nonce }));
    expect(JSON.parse((await reply)[0].toString())).toEqual({ type: 'heartbeat-pong', harness: 'codex', nonce });
    const closed = once(socket, 'close'); socket.send(JSON.stringify({ type: 'heartbeat-ping', nonce: 'b'.repeat(32) }));
    expect((await closed)[0]).toBe(1008);
  } finally { socket?.terminate(); await app.close(); removeTempFixture(directory, 'agent-control-'); }
});

it('does not answer after an owner session expires or is removed without an event', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-heartbeat-'));
  const store = new Store(directory), owner = new OwnerAuth(store.db, 'https://fixture.example');
  await owner.setPassword('fixture-only-password-2026');
  const { app } = await buildApp({ mode: 'owner', port: 3000, publicOrigin: 'https://fixture.example', dataDir: directory }, { adapter: fixtureAdapter() as any, store, serveStatic: false });
  let socket: WebSocket | undefined;
  try {
    await app.ready(); const issued = owner.issueSession(), hash = owner.session(issued.token)!.hash;
    const bootstrap = await app.inject({ url: '/api/auth/bootstrap', headers: { host: 'fixture.example' } });
    const cookies = bootstrap.cookies.map(value => `${value.name}=${value.value}`).join('; ');
    const headers = { host: 'fixture.example', origin: 'https://fixture.example', cookie: `${cookies}; __Host-ac_owner=${issued.token}` };
    await expect(app.injectWS('/api/events', { headers: { ...headers, cookie: cookies } })).rejects.toThrow();
    socket = await app.injectWS('/api/events', { headers });
    // Simulate expiry/revocation without broadcasting an in-process revocation event.
    store.db.prepare('DELETE FROM owner_sessions WHERE hash=?').run(hash);
    const closed = once(socket!, 'close'); socket!.send(JSON.stringify({ type: 'heartbeat-ping', nonce: 'a'.repeat(32) }));
    expect((await closed)[0]).toBe(1008);
  } finally { socket?.terminate(); await app.close(); removeTempFixture(directory, 'agent-control-'); }
});
