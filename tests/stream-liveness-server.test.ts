import { expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';
import { buildApp } from '../server/app';
import { removeTempFixture } from './safe-temp';

it('reclaims unresponsive owned sockets while preserving responsive or active streams', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-stream-liveness-'));
  const adapter = Object.assign(new EventEmitter(), { status: { connected: false, compatible: false }, close() {} });
  const original = globalThis.setInterval; let tick: (() => void) | undefined;
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === 25_000) tick = () => callback(...args);
    return original(callback, delay, ...args);
  }) as typeof setInterval);
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  const sockets: WebSocket[] = [];
  try {
    expect(tick).toBeTypeOf('function');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as net.AddressInfo).port, origin = `http://127.0.0.1:${port}`;
    const response = await fetch(`${origin}/api/session`), cookie = response.headers.get('set-cookie')!.split(';')[0];
    async function connect(autoPong: boolean) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { autoPong, headers: { origin, cookie } });
      sockets.push(socket); const greeting = once(socket, 'message'); await once(socket, 'open'); await greeting; return socket;
    }

    const stale = await connect(false);
    let ping = once(stale, 'ping'); tick!(); await ping;
    let closed = once(stale, 'close'); tick!(); expect((await closed)[0]).toBe(1006);

    const responsive = await connect(true);
    const serverSocket = [...app.websocketServer.clients].find(socket => socket.readyState === WebSocket.OPEN)!;
    expect(serverSocket).toBeDefined();
    let pong = once(serverSocket, 'pong'); tick!(); await pong;
    pong = once(serverSocket, 'pong'); tick!(); await pong;
    expect(responsive.readyState).toBe(WebSocket.OPEN);
    closed = once(responsive, 'close'); responsive.close(); await closed;

    // Some intermediaries can consume control frames; valid application traffic
    // still proves that the inbound stream is alive.
    const active = await connect(false);
    ping = once(active, 'ping'); tick!(); await ping;
    const reply = once(active, 'message'); active.send(JSON.stringify({ type: 'heartbeat-ping', nonce: 'a'.repeat(32) }));
    expect(JSON.parse((await reply)[0].toString())).toMatchObject({ type: 'heartbeat-pong', nonce: 'a'.repeat(32) });
    ping = once(active, 'ping'); tick!(); await ping;
    expect(active.readyState).toBe(WebSocket.OPEN);
    closed = once(active, 'close'); tick!(); expect((await closed)[0]).toBe(1006);
  } finally {
    for (const socket of sockets) socket.terminate();
    spy.mockRestore(); await app.close(); removeTempFixture(directory, 'agent-control-');
  }
});
