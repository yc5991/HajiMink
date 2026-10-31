import { EventEmitter, once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../server/app';
import { Store } from '../server/store';
import { OwnerAuth } from '../server/owner-auth';
import { removeTempFixture } from './safe-temp';

function terminal() {
  let onData: (value: string) => void = () => {};
  let onExit: (value: { exitCode: number }) => void = () => {};
  return {
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: (callback: typeof onData) => { onData = callback; },
    onExit: (callback: typeof onExit) => { onExit = callback; },
    output: (value: string) => onData(value), exit: (exitCode: number) => onExit({ exitCode })
  };
}

async function fixture(mode: 'local' | 'owner' | 'access' = 'local') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hajimink-cli-test-'));
  const origin = mode === 'local' ? 'http://localhost:3000' : 'https://agent.example.com';
  const host = mode === 'local' ? 'localhost:3000' : 'agent.example.com';
  const store = new Store(dir);
  if (mode === 'owner') { new OwnerAuth(store.db, origin); store.db.prepare('INSERT INTO owner_passkeys VALUES(?,?,?,?,?)').run('fixture-key', Buffer.from('public'), 0, '[]', Date.now()); }
  const cwd = path.resolve(os.tmpdir(), 'hajimink-project-fixture');
  const adapter = Object.assign(new EventEmitter(), { status: { connected: true }, catalog: vi.fn(async () => ({ projects: [{ id: 'project-1', hostId: 'local', name: 'Project', path: cwd }], threads: [] })), models: () => [], close() {} });
  const fake = terminal(); const cliSpawn = vi.fn(() => fake as any);
  const accessConfig = mode === 'access' ? { accessIssuer: 'https://owner.cloudflareaccess.com', accessAudience: 'aud', allowedEmail: 'owner@example.com' } : undefined;
  let accessToken: string | undefined, keys: ReturnType<typeof createLocalJWKSet> | undefined;
  if (accessConfig) {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey); jwk.kid = 'fixture'; keys = createLocalJWKSet({ keys: [jwk] });
    accessToken = await new SignJWT({ email: accessConfig.allowedEmail }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer(accessConfig.accessIssuer).setAudience(accessConfig.accessAudience).setExpirationTime(Math.floor(Date.now() / 1000) + 3).sign(privateKey);
  }
  const result = await buildApp({ mode, port: 3000, publicOrigin: origin, dataDir: dir, ...accessConfig }, { store, adapter: adapter as any, cliSpawn, keys, serveStatic: false });
  const owner = mode === 'owner' ? result.ownerAuth.issueSession() : undefined;
  const accessHeaders = accessToken ? { 'cf-access-jwt-assertion': accessToken } : {};
  const bootstrap = await result.app.inject({ url: mode === 'owner' ? '/api/auth/bootstrap' : '/api/session', headers: { host, ...accessHeaders } });
  const bootstrapCookie = bootstrap.cookies.map(value => `${value.name}=${value.value}`).join('; ');
  const cookie = bootstrapCookie + (owner ? `; __Host-ac_owner=${owner.token}` : '');
  const headers = { host, origin, cookie, ...accessHeaders };
  await result.app.listen({ host: '127.0.0.1', port: 0 });
  const address = result.app.server.address() as AddressInfo;
  const connect = async (extra: Record<string, string> = {}) => { const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/cli`, { headers: { ...headers, ...extra } }); await once(socket, 'open'); return socket; };
  return { ...result, adapter, fake, cliSpawn, connect, cwd, owner, bootstrapCookie, close: async () => { await result.app.close(); removeTempFixture(dir, 'hajimink-cli-test-'); } };
}

it('requires same-origin and the session cookie before opening a terminal', async () => {
  const f = await fixture();
  try {
    await expect(f.connect({ origin: 'https://evil.example' })).rejects.toThrow();
    await expect(f.connect({ cookie: '' })).rejects.toThrow();
    expect(f.cliSpawn).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('runs only a selected catalog project and forwards terminal input, output and size', async () => {
  const f = await fixture(); let socket: any;
  try {
    socket = await f.connect();
    const started = once(socket, 'message'); socket.send(JSON.stringify({ type: 'start', projectId: 'project-1', cols: 80, rows: 24 }));
    expect(JSON.parse((await started)[0].toString())).toEqual({ type: 'started' });
    expect(f.cliSpawn).toHaveBeenCalledWith(f.cwd, 80, 24);
    const output = once(socket, 'message'); f.fake.output('hello\u001b[31m');
    expect(JSON.parse((await output)[0].toString())).toEqual({ type: 'output', data: 'hello\u001b[31m' });
    socket.send(JSON.stringify({ type: 'input', data: 'test\r' }));
    socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    await vi.waitFor(() => { expect(f.fake.write).toHaveBeenCalledWith('test\r'); expect(f.fake.resize).toHaveBeenCalledWith(100, 30); });
    const closed = once(socket, 'close'); socket.close(); await closed;
    await vi.waitFor(() => expect(f.fake.kill).toHaveBeenCalledTimes(1));
  } finally { socket?.terminate(); await f.close(); }
});

it('rejects unlisted project paths and never spawns a process', async () => {
  const f = await fixture(); let socket: any;
  try {
    socket = await f.connect();
    const error = once(socket, 'message'); socket.send(JSON.stringify({ type: 'start', projectId: '../../other', cols: 80, rows: 24 }));
    expect(JSON.parse((await error)[0].toString())).toMatchObject({ type: 'error', message: '找不到本机项目目录' });
    expect(f.cliSpawn).not.toHaveBeenCalled();
  } finally { socket?.terminate(); await f.close(); }
});

it('does not launch after the browser disconnects while the project lookup is pending', async () => {
  const f = await fixture(); let socket: any, release!: (value: any) => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  f.adapter.catalog.mockImplementationOnce(() => { started(); return new Promise(resolve => { release = resolve; }); });
  try {
    socket = await f.connect(); socket.send(JSON.stringify({ type: 'start', projectId: 'project-1', cols: 80, rows: 24 }));
    await waiting; const closed = once(socket, 'close'); socket.close(); await closed;
    release({ projects: [{ id: 'project-1', hostId: 'local', path: f.cwd }], threads: [] });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.cliSpawn).not.toHaveBeenCalled();
  } finally { socket?.terminate(); await f.close(); }
});

it('stops a terminal whose asynchronous startup completes after the browser disconnects', async () => {
  const f = await fixture(); let socket: WebSocket | undefined, release!: (value: any) => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  f.cliSpawn.mockImplementationOnce(() => { started(); return new Promise(resolve => { release = resolve; }) as any; });
  try {
    socket = await f.connect(); socket.send(JSON.stringify({ type: 'start', cols: 80, rows: 24 }));
    await waiting; const closed = once(socket, 'close'); socket.close(); await closed;
    release(f.fake);
    await vi.waitFor(() => expect(f.fake.kill).toHaveBeenCalledTimes(1));
  } finally { socket?.terminate(); await f.close(); }
});

it('terminates the terminal immediately when its owner session is revoked', async () => {
  const f = await fixture('owner'); let socket: any;
  try {
    socket = await f.connect(); const started = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'start', cols: 80, rows: 24 })); await started;
    expect(f.cliSpawn).toHaveBeenCalledWith(os.homedir(), 80, 24);
    const closed = once(socket, 'close'); f.ownerAuth.revoke(f.ownerAuth.session(f.owner!.token)!.hash);
    expect(f.fake.kill).toHaveBeenCalledTimes(1); await closed;
  } finally { socket?.terminate(); await f.close(); }
});

it('terminates the terminal immediately when its device authorization is revoked', async () => {
  const f = await fixture('owner'); let socket: WebSocket | undefined;
  try {
    const requested = f.devices.create('测试设备', 'fixture');
    f.devices.decide(f.devices.lookup(requested.userCode, 'fixture-owner').approvalTicket, true);
    const device = f.devices.exchange(requested.requestId);
    socket = await f.connect({ cookie: `${f.bootstrapCookie}; __Host-ac_device=${device.token}` });
    const started = once(socket, 'message'); socket.send(JSON.stringify({ type: 'start', cols: 80, rows: 24 })); await started;
    const closed = once(socket, 'close'); f.devices.revoke(device.deviceId);
    expect(f.fake.kill).toHaveBeenCalledTimes(1); await closed;
  } finally { socket?.terminate(); await f.close(); }
});

it('terminates an active terminal when its Access token expires', async () => {
  const f = await fixture('access'); let socket: WebSocket | undefined;
  try {
    socket = await f.connect();
    const started = once(socket, 'message'); socket.send(JSON.stringify({ type: 'start', cols: 80, rows: 24 })); await started;
    await once(socket, 'close');
    expect(f.fake.kill).toHaveBeenCalledTimes(1);
  } finally { socket?.terminate(); await f.close(); }
}, 10000);

it('limits simultaneous terminals and accepts a new connection after one closes', async () => {
  const f = await fixture(); const sockets: WebSocket[] = [];
  try {
    for (let i = 0; i < 4; i++) sockets.push(await f.connect());
    const rejected = await f.connect(); sockets.push(rejected);
    expect((await once(rejected, 'close'))[0]).toBe(1013);
    const closed = once(sockets[0], 'close'); sockets[0].close(); await closed;
    const replacement = await f.connect(); sockets.push(replacement);
    const started = once(replacement, 'message'); replacement.send(JSON.stringify({ type: 'start', cols: 80, rows: 24 }));
    expect(JSON.parse((await started)[0].toString())).toEqual({ type: 'started' });
  } finally { for (const socket of sockets) socket.terminate(); await f.close(); }
});
