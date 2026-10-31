import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { IpcClient } from '../server/pipe-client';
import { encodeFrame, FrameDecoder } from '../server/framing';

class FakeSocket extends EventEmitter {
  writable = true; destroyed = false; sent: any[] = [];
  write(value: Buffer) { this.sent.push(...new FrameDecoder().push(value)); return true; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.writable = false; queueMicrotask(() => this.emit('close')); } return this; }
  deliver(value: unknown) { this.emit('data', encodeFrame(value)); }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
  const sockets: FakeSocket[] = [];
  vi.spyOn(net, 'connect').mockImplementation((..._args: any[]) => {
    const socket = new FakeSocket(); sockets.push(socket); queueMicrotask(() => socket.emit('connect')); return socket as any;
  });
  return { sockets, client: new IpcClient() };
}
function initialized(socket: FakeSocket, clientId = 'fixture-client') {
  const request = socket.sent.find(value => value.method === 'initialize');
  if (!request) throw new Error('fixture handshake not sent');
  socket.deliver({ type: 'response', requestId: request.requestId, result: { clientId } });
}
afterEach(() => vi.restoreAllMocks());

it('allows a fresh connection immediately after a pending handshake is closed', async () => {
  const { sockets, client } = fixture();
  const first = client.connect(); const firstResult = first.catch(error => error);
  await flush(); expect(sockets[0].sent.some(value => value.method === 'initialize')).toBe(true);
  client.close();
  const second = client.connect(); const secondResult = second.catch(error => error);
  try {
    await flush();
    if (sockets[1]) initialized(sockets[1], 'replacement-client');
    await flush();
    expect(sockets).toHaveLength(2);
    expect(await firstResult).toMatchObject({ code: 'DESKTOP_OFFLINE' });
    expect(await secondResult).toBeUndefined();
    expect(client.connected).toBe(true);
  } finally { client.close(); await Promise.allSettled([first, second]); }
});

it('rejects a malformed initialization instead of reporting a connected desktop', async () => {
  const { sockets, client } = fixture(); const connection = client.connect();
  try {
    await flush(); const request = sockets[0].sent[0];
    sockets[0].deliver({ type: 'response', requestId: request.requestId, result: {} });
    await expect(connection).rejects.toMatchObject({ code: 'DESKTOP_PROTOCOL' });
    expect(client.connected).toBe(false);
  } finally { client.close(); }
});

it('ignores delayed broadcasts from an old socket after a new connection starts', async () => {
  const { sockets, client } = fixture(); const events: any[] = []; client.on('broadcast', value => events.push(value));
  try {
    const first = client.connect(); await flush(); initialized(sockets[0], 'old-client'); await first;
    client.close(); await flush();
    const second = client.connect(); await flush(); initialized(sockets[1], 'new-client'); await second;
    sockets[0].deliver({ type: 'broadcast', method: 'old-message', params: {} });
    sockets[1].deliver({ type: 'broadcast', method: 'new-message', params: {} });
    expect(events.map(event => event.method)).toEqual(['new-message']);
    expect(client.connected).toBe(true);
  } finally { client.close(); }
});

it('reports an in-flight request as unconfirmed when its socket closes', async () => {
  const { sockets, client } = fixture();
  try {
    const ready = client.connect(); await flush(); initialized(sockets[0]); await ready;
    const pending = client.request('fixture-write', { test: true }, 1);
    await flush(); expect(sockets[0].sent.some(value => value.method === 'fixture-write')).toBe(true);
    sockets[0].destroy();
    await expect(pending).rejects.toMatchObject({ code: 'DESKTOP_OFFLINE', statusCode: 503 });
    expect(client.connected).toBe(false);
  } finally { client.close(); }
});


it('destroys the underlying socket when initialization times out', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { sockets, client } = fixture();
  const outcome = client.connect().catch(error => error);
  try {
    await flush(); expect(sockets[0].sent.some(value => value.method === 'initialize')).toBe(true);
    await vi.advanceTimersByTimeAsync(8001);
    expect(await outcome).toMatchObject({ code: 'DESKTOP_TIMEOUT' });
    expect(sockets[0].destroyed).toBe(true); expect(client.connected).toBe(false);
  } finally { client.close(); vi.useRealTimers(); }
});


it('handshakes and handles a request over a real isolated local socket', async () => {
  const peers = new Set<net.Socket>();
  const server = net.createServer(socket => {
    peers.add(socket); socket.once('close', () => peers.delete(socket));
    const decoder = new FrameDecoder();
    socket.on('data', bytes => {
      for (const message of decoder.push(bytes)) {
        if (message.method === 'initialize') socket.write(encodeFrame({ type: 'response', requestId: message.requestId, result: { clientId: 'real-fixture-client' } }));
        if (message.method === 'fixture-read') socket.write(encodeFrame({ type: 'response', requestId: message.requestId, result: { value: 'fixture-only' } }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo; const connect = net.connect.bind(net);
  vi.spyOn(net, 'connect').mockImplementation((..._args: any[]) => connect(address.port, '127.0.0.1'));
  const client = new IpcClient();
  try {
    await client.connect(); expect(client.connected).toBe(true);
    await expect(client.request('fixture-read', {})).resolves.toMatchObject({ result: { value: 'fixture-only' } });
  } finally {
    client.close(); for (const socket of peers) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
