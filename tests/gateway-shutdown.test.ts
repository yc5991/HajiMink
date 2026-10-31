import { expect, it } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as realDelay } from 'node:timers/promises';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { buildApp } from '../server/app';
import { removeTempFixture } from './safe-temp';

it('closes the owned gateway when a websocket peer ignores the close handshake', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  const adapter = Object.assign(new EventEmitter(), { status: { connected: false }, close() {} });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  let socket: net.Socket | undefined; let closing: Promise<unknown> | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as net.AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const session = await fetch(`${origin}/api/session`);
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nCookie: ${cookie}\r\n\r\n`);
    const [handshake] = await once(socket, 'data');
    expect(handshake.toString()).toMatch(/^HTTP\/1\.1 101 /);
    // This raw socket deliberately ignores websocket close frames.
    closing = app.close();
    const stopped = await Promise.race([closing.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2500))]);
    expect(stopped).toBe(true);
  } finally {
    socket?.destroy();
    await (closing || app.close());
    removeTempFixture(directory, 'agent-control-');
  }
}, 10000);

it('sends a normal close frame to a responsive websocket client', async () => {
  const { default: WebSocket } = await import('ws');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  const adapter = Object.assign(new EventEmitter(), { status: { connected: false }, close() {} });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  let socket: InstanceType<typeof WebSocket> | undefined; let closing: Promise<unknown> | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as net.AddressInfo).port; const origin = `http://127.0.0.1:${port}`;
    const session = await fetch(`${origin}/api/session`); const cookie = session.headers.get('set-cookie')!.split(';')[0];
    socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { headers: { origin, cookie } });
    await once(socket, 'open');
    const closed = once(socket, 'close'); closing = app.close();
    const [code] = await closed;
    expect(code).toBe(1001);
    await closing;
  } finally {
    socket?.terminate(); await (closing || app.close()); removeTempFixture(directory, 'agent-control-');
  }
}, 10000);

it('allows an in-flight HTTP request to complete during graceful gateway shutdown', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  let release!: () => void, notifyStart!: () => void; let adapterClosed = false;
  const started = new Promise<void>(resolve => { notifyStart = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const adapter = Object.assign(new EventEmitter(), { status: { connected: true, compatible: true }, close() { adapterClosed = true; }, catalog: async () => { notifyStart(); await held; return { projects: [], threads: [] }; } });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  let closing: Promise<unknown> | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as net.AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const session = await fetch(`${origin}/api/session`);
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const request = fetch(`${origin}/api/projects`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
    // Surface an unexpected early HTTP response instead of hanging while waiting for the handler.
    await Promise.race([started, request.then(response => { throw new Error(`Request ended before handler started: ${response.status}`); })]);
    closing = app.close();
    const endedEarly = await Promise.race([closing.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1200))]);
    expect(endedEarly).toBe(false); expect(adapterClosed).toBe(false);
    release(); expect((await request).status).toBe(200);
    const stopped = await Promise.race([closing.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2500))]);
    expect(stopped).toBe(true); expect(adapterClosed).toBe(true);
  } finally {
    release(); app.server.closeIdleConnections(); await (closing || app.close()); removeTempFixture(directory, 'agent-control-');
  }
}, 10000);



it('drains a response that started streaming before shutdown without keeping the gateway open', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  const adapter = Object.assign(new EventEmitter(), { status: { connected: false }, close() {} });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  const stream = new PassThrough(); let closing: Promise<unknown> | undefined;
  app.get('/fixture-stream', (_request, reply) => { reply.type('text/plain'); return stream; });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as net.AddressInfo).port;
    const request = fetch(`http://127.0.0.1:${port}/fixture-stream`, { signal: AbortSignal.timeout(5000) });
    stream.write('first');
    const response = await request; expect(response.status).toBe(200);
    closing = app.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    stream.end('last'); expect(await response.text()).toBe('firstlast');
    const stopped = await Promise.race([closing.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2500))]);
    expect(stopped).toBe(true);
  } finally {
    stream.destroy(); app.server.closeIdleConnections(); await (closing || app.close()); removeTempFixture(directory, 'agent-control-');
  }
}, 10000);


it('does not hang if an authenticated WebSocket upgrade finishes while shutdown is waiting', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  const adapter = Object.assign(new EventEmitter(), { status: { connected: false }, close() {} });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  let release!: () => void, notifyStart!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { notifyStart = resolve; });
  app.addHook('onRequest', async request => { if (request.headers.upgrade?.toLowerCase() === 'websocket') { notifyStart(); await held; } });
  let socket: net.Socket | undefined, closing: Promise<unknown> | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as net.AddressInfo).port, origin = `http://127.0.0.1:${port}`;
    const response = await fetch(`${origin}/api/session`), cookie = response.headers.get('set-cookie')!.split(';')[0];
    socket = net.connect(port, '127.0.0.1'); await once(socket, 'connect');
    socket.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nCookie: ${cookie}\r\n\r\n`);
    await started; closing = app.close();
    await realDelay(100); release();
    const stopped = await Promise.race([closing.then(() => true), realDelay(2500, false)]);
    expect(stopped).toBe(true);
  } finally { release(); socket?.destroy(); app.server.closeIdleConnections(); await (closing || app.close()); removeTempFixture(directory, 'agent-control-'); }
}, 10000);


it('drains an incomplete HTTP request without allowing it to pin shutdown', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  const adapter = Object.assign(new EventEmitter(), { status: { connected: false }, close() {} });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  let received!: () => void; const started = new Promise<void>(resolve => { received = resolve; });
  let socket: net.Socket | undefined, closing: Promise<unknown> | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 }); const port = (app.server.address() as net.AddressInfo).port;
    app.server.on('request', request => { if (request.url === '/api/health') received(); });
    socket = net.connect(port, '127.0.0.1'); await once(socket, 'connect');
    socket.write(`POST /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
    await started; closing = app.close();
    const stopped = await Promise.race([closing.then(() => true), realDelay(2500, false)]);
    expect(stopped).toBe(true);
  } finally { socket?.destroy(); app.server.closeIdleConnections(); await (closing || app.close()); removeTempFixture(directory, 'agent-control-'); }
}, 10000);


it('does not let a stalled read-only catalog request pin gateway shutdown', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  let release!: () => void, notify!: () => void, closed = false;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { notify = resolve; });
  const adapter = Object.assign(new EventEmitter(), { status: { connected: true, compatible: true }, close() { closed = true; }, catalog: async () => { notify(); await held; return { projects: [], threads: [] }; } });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  let closing: Promise<unknown> | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 }); const port = (app.server.address() as net.AddressInfo).port;
    const request = fetch(`http://127.0.0.1:${port}/api/projects`, { signal: AbortSignal.timeout(6000) }).then(() => false, () => true);
    await started; closing = app.close();
    const stopped = await Promise.race([closing.then(() => true), realDelay(3500, false)]);
    expect(stopped).toBe(true); expect(await request).toBe(true); expect(closed).toBe(true);
  } finally { release(); app.server.closeIdleConnections(); await (closing || app.close()); removeTempFixture(directory, 'agent-control-'); }
}, 10000);

it('continues waiting for an in-flight write instead of terminating its connection', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  let release!: () => void, notify!: () => void, closed = false, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { notify = resolve; });
  const adapter = Object.assign(new EventEmitter(), { status: { connected: true, compatible: true }, close() { closed = true; }, create: async () => { calls++; notify(); await held; return { threadId: 'fixture-thread' }; } });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  let closing: Promise<unknown> | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 }); const port = (app.server.address() as net.AddressInfo).port, origin = `http://127.0.0.1:${port}`;
    const session = await fetch(`${origin}/api/session`), cookie = session.headers.get('set-cookie')!.split(';')[0], csrf = (await session.json()).csrf;
    const request = fetch(`${origin}/api/threads`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', 'x-agent-control-csrf': csrf }, body: JSON.stringify({ operationId: randomUUID(), prompt: 'fixture-only' }), signal: AbortSignal.timeout(8000) });
    await Promise.race([started, request.then(response => { throw new Error(`Write ended before handler: ${response.status}`); })]); closing = app.close();
    const endedEarly = await Promise.race([closing.then(() => true), realDelay(2500, false)]);
    expect(endedEarly).toBe(false); expect(closed).toBe(false); expect(calls).toBe(1);
    release(); expect((await request).status).toBe(200); await closing; expect(closed).toBe(true);
  } finally { release(); app.server.closeIdleConnections(); await (closing || app.close()); removeTempFixture(directory, 'agent-control-'); }
}, 10000);


it('preserves a pipelined write sharing a connection with a stalled read', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  let releaseRead!: () => void, releaseWrite!: () => void, notifyRead!: () => void, notifyWrite!: () => void, adapterClosed = false, writes = 0;
  const readHeld = new Promise<void>(resolve => { releaseRead = resolve; }), writeHeld = new Promise<void>(resolve => { releaseWrite = resolve; });
  const readStarted = new Promise<void>(resolve => { notifyRead = resolve; }), writeStarted = new Promise<void>(resolve => { notifyWrite = resolve; });
  const adapter = Object.assign(new EventEmitter(), { status: { connected: true, compatible: true }, close() { adapterClosed = true; },
    catalog: async () => { notifyRead(); await readHeld; return { projects: [], threads: [] }; },
    create: async () => { writes++; notifyWrite(); await writeHeld; return { threadId: 'fixture-thread' }; } });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  let socket: net.Socket | undefined, closing: Promise<unknown> | undefined, received = '';
  try {
    await app.listen({ host: '127.0.0.1', port: 0 }); const port = (app.server.address() as net.AddressInfo).port, origin = `http://127.0.0.1:${port}`;
    const session = await fetch(`${origin}/api/session`), cookie = session.headers.get('set-cookie')!.split(';')[0], csrf = (await session.json()).csrf;
    const body = JSON.stringify({ operationId: randomUUID(), prompt: 'fixture-only' });
    socket = net.connect(port, '127.0.0.1'); socket.on('data', data => { received += data.toString(); }); await once(socket, 'connect');
    const ended = once(socket, 'close');
    socket.write(`GET /api/projects HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\n\r\nPOST /api/threads HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nX-Agent-Control-Csrf: ${csrf}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    await Promise.race([Promise.all([readStarted, writeStarted]), realDelay(3000).then(() => { throw new Error('Pipeline did not reach both handlers'); })]);
    closing = app.close(); await realDelay(2400);
    expect(socket.destroyed).toBe(false); expect(adapterClosed).toBe(false); expect(writes).toBe(1);
    releaseRead(); releaseWrite(); await closing; await ended;
    expect((received.match(/HTTP\/1\.1 200/g) || []).length).toBe(2);
    expect(received).toContain('fixture-thread');
  } finally { releaseRead(); releaseWrite(); socket?.destroy(); app.server.closeIdleConnections(); await (closing || app.close()); removeTempFixture(directory, 'agent-control-'); }
}, 12000);

it('preserves a running pipelined write when a later upload is incomplete during shutdown', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  let releaseWrite!: () => void, notifyWrite!: () => void, notifyPartial!: () => void, adapterClosed = false, writes = 0;
  const writeHeld = new Promise<void>(resolve => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>(resolve => { notifyWrite = resolve; });
  const partialStarted = new Promise<void>(resolve => { notifyPartial = resolve; });
  const adapter = Object.assign(new EventEmitter(), { status: { connected: true, compatible: true }, close() { adapterClosed = true; },
    create: async () => { writes++; notifyWrite(); await writeHeld; return { threadId: 'fixture-thread' }; } });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  let socket: net.Socket | undefined, closing: Promise<unknown> | undefined, received = '';
  try {
    await app.listen({ host: '127.0.0.1', port: 0 }); const port = (app.server.address() as net.AddressInfo).port, origin = `http://127.0.0.1:${port}`;
    const session = await fetch(`${origin}/api/session`), cookie = session.headers.get('set-cookie')!.split(';')[0], csrf = (await session.json()).csrf;
    const body = JSON.stringify({ operationId: randomUUID(), prompt: 'fixture-only' });
    app.server.on('request', request => { if (request.headers['x-fixture-partial'] === 'yes') notifyPartial(); });
    socket = net.connect(port, '127.0.0.1'); socket.on('data', data => { received += data.toString(); }); socket.on('error', () => {}); await once(socket, 'connect');
    const ended = once(socket, 'close');
    socket.write(`POST /api/threads HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nX-Agent-Control-Csrf: ${csrf}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}POST /api/threads HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nX-Agent-Control-Csrf: ${csrf}\r\nX-Fixture-Partial: yes\r\nContent-Length: 100\r\n\r\n{`);
    await Promise.race([Promise.all([writeStarted, partialStarted]), realDelay(3000).then(() => { throw new Error('Pipeline did not reach both requests'); })]);
    closing = app.close(); await realDelay(2400);
    expect(socket.destroyed).toBe(false); expect(adapterClosed).toBe(false); expect(writes).toBe(1);
    releaseWrite();
    const stopped = await Promise.race([closing.then(() => true), realDelay(3000, false)]);
    expect(stopped).toBe(true); await ended;
    expect((received.match(/HTTP\/1\.1 200/g) || []).length).toBe(1);
    expect(received).toContain('fixture-thread'); expect(writes).toBe(1);
  } finally { releaseWrite(); socket?.destroy(); app.server.closeIdleConnections(); await (closing || app.close()); removeTempFixture(directory, 'agent-control-'); }
}, 12000);

it('drains a stalled catalog request sharing a socket with an incomplete upload', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  let releaseRead!: () => void, notifyRead!: () => void, notifyPartial!: () => void;
  const readHeld = new Promise<void>(resolve => { releaseRead = resolve; });
  const readStarted = new Promise<void>(resolve => { notifyRead = resolve; });
  const partialStarted = new Promise<void>(resolve => { notifyPartial = resolve; });
  const adapter = Object.assign(new EventEmitter(), { status: { connected: true, compatible: true }, close() {},
    catalog: async () => { notifyRead(); await readHeld; return { projects: [], threads: [] }; } });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  let socket: net.Socket | undefined, closing: Promise<unknown> | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 }); const port = (app.server.address() as net.AddressInfo).port, origin = `http://127.0.0.1:${port}`;
    const session = await fetch(`${origin}/api/session`), cookie = session.headers.get('set-cookie')!.split(';')[0];
    app.server.on('request', request => { if (request.headers['x-fixture-partial'] === 'yes') notifyPartial(); });
    socket = net.connect(port, '127.0.0.1'); socket.on('error', () => {}); await once(socket, 'connect');
    socket.write(`GET /api/projects HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\n\r\nPOST /api/threads HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Fixture-Partial: yes\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
    await Promise.race([Promise.all([readStarted, partialStarted]), realDelay(3000).then(() => { throw new Error('Pipeline did not reach both requests'); })]);
    closing = app.close();
    expect(await Promise.race([closing.then(() => true), realDelay(3500, false)])).toBe(true);
  } finally { releaseRead(); socket?.destroy(); app.server.closeIdleConnections(); await (closing || app.close()); removeTempFixture(directory, 'agent-control-'); }
}, 10000);

it('preserves a streaming response sharing a socket with an incomplete upload', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  const adapter = Object.assign(new EventEmitter(), { status: { connected: false }, close() {} });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  const stream = new PassThrough(); let notifyPartial!: () => void, notifyChunk!: () => void;
  const partialStarted = new Promise<void>(resolve => { notifyPartial = resolve; });
  const chunkReceived = new Promise<void>(resolve => { notifyChunk = resolve; });
  app.get('/fixture-stream', (_request, reply) => { reply.type('text/plain'); return stream; });
  let socket: net.Socket | undefined, closing: Promise<unknown> | undefined, received = '';
  try {
    await app.listen({ host: '127.0.0.1', port: 0 }); const port = (app.server.address() as net.AddressInfo).port;
    app.server.on('request', request => { if (request.headers['x-fixture-partial'] === 'yes') notifyPartial(); });
    socket = net.connect(port, '127.0.0.1'); socket.on('data', data => { received += data.toString(); if (received.includes('first')) notifyChunk(); }); socket.on('error', () => {}); await once(socket, 'connect');
    const ended = once(socket, 'close');
    socket.write(`GET /fixture-stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\nPOST /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Fixture-Partial: yes\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
    stream.write('first'); await Promise.race([Promise.all([chunkReceived, partialStarted]), realDelay(3000).then(() => { throw new Error('Pipeline did not begin streaming'); })]);
    closing = app.close(); await realDelay(2400); expect(socket.destroyed).toBe(false);
    stream.end('last');
    expect(await Promise.race([closing.then(() => true), realDelay(3000, false)])).toBe(true); await ended;
    expect(received).toContain('first'); expect(received).toContain('last');
  } finally { stream.destroy(); socket?.destroy(); app.server.closeIdleConnections(); await (closing || app.close()); removeTempFixture(directory, 'agent-control-'); }
}, 12000);

it('protects a running write from a partial upload arriving after shutdown begins', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  let releaseWrite!: () => void, notifyWrite!: () => void, notifyPartial!: () => void, writes = 0;
  const writeHeld = new Promise<void>(resolve => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>(resolve => { notifyWrite = resolve; });
  const partialStarted = new Promise<void>(resolve => { notifyPartial = resolve; });
  const adapter = Object.assign(new EventEmitter(), { status: { connected: true, compatible: true }, close() {},
    create: async () => { writes++; notifyWrite(); await writeHeld; return { threadId: 'fixture-thread' }; } });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  let socket: net.Socket | undefined, closing: Promise<unknown> | undefined, received = '';
  try {
    await app.listen({ host: '127.0.0.1', port: 0 }); const port = (app.server.address() as net.AddressInfo).port, origin = `http://127.0.0.1:${port}`;
    const session = await fetch(`${origin}/api/session`), cookie = session.headers.get('set-cookie')!.split(';')[0], csrf = (await session.json()).csrf;
    const body = JSON.stringify({ operationId: randomUUID(), prompt: 'fixture-only' });
    app.server.on('request', request => { if (request.headers['x-fixture-partial'] === 'yes') notifyPartial(); });
    socket = net.connect(port, '127.0.0.1'); socket.on('data', data => { received += data.toString(); }); socket.on('error', () => {}); await once(socket, 'connect');
    const ended = once(socket, 'close');
    socket.write(`POST /api/threads HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nX-Agent-Control-Csrf: ${csrf}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await Promise.race([writeStarted, realDelay(3000).then(() => { throw new Error('Write did not reach handler'); })]);
    closing = app.close();
    socket.write(`POST /api/threads HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nX-Agent-Control-Csrf: ${csrf}\r\nX-Fixture-Partial: yes\r\nContent-Length: 100\r\n\r\n{`);
    await Promise.race([partialStarted, realDelay(3000).then(() => { throw new Error('Later upload did not reach the server'); })]);
    await realDelay(2400); expect(socket.destroyed).toBe(false); expect(writes).toBe(1);
    releaseWrite();
    expect(await Promise.race([closing.then(() => true), realDelay(3000, false)])).toBe(true); await ended;
    expect(received).toContain('HTTP/1.1 200'); expect(received).toContain('fixture-thread'); expect(writes).toBe(1);
  } finally { releaseWrite(); socket?.destroy(); app.server.closeIdleConnections(); await (closing || app.close()); removeTempFixture(directory, 'agent-control-'); }
}, 12000);

it('does not destroy a streaming catalog response when another catalog read on the socket is stalled', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  let releaseRead!: () => void, notifyRead!: () => void, notifyChunk!: () => void, streamingResponse: import('node:http').ServerResponse | undefined;
  const readHeld = new Promise<void>(resolve => { releaseRead = resolve; });
  const readStarted = new Promise<void>(resolve => { notifyRead = resolve; });
  const chunkReceived = new Promise<void>(resolve => { notifyChunk = resolve; });
  const adapter = Object.assign(new EventEmitter(), { status: { connected: true, compatible: true }, close() {},
    catalog: async () => { notifyRead(); await readHeld; return { projects: [], threads: [] }; } });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  app.addHook('onRequest', (request, reply, done) => {
    if (request.headers['x-fixture-stream'] === 'yes') {
      reply.hijack(); streamingResponse = reply.raw; reply.raw.writeHead(200, { 'content-type': 'text/plain' }); reply.raw.write('first');
    }
    done();
  });
  let socket: net.Socket | undefined, closing: Promise<unknown> | undefined, received = '';
  try {
    await app.listen({ host: '127.0.0.1', port: 0 }); const port = (app.server.address() as net.AddressInfo).port, origin = `http://127.0.0.1:${port}`;
    const session = await fetch(`${origin}/api/session`), cookie = session.headers.get('set-cookie')!.split(';')[0];
    socket = net.connect(port, '127.0.0.1'); socket.on('data', data => { received += data.toString(); if (received.includes('first')) notifyChunk(); }); socket.on('error', () => {}); await once(socket, 'connect');
    const ended = once(socket, 'close');
    socket.write(`GET /api/threads HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\nX-Fixture-Stream: yes\r\n\r\nGET /api/projects HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`);
    await Promise.race([Promise.all([chunkReceived, readStarted]), realDelay(3000).then(() => { throw new Error('Catalog pipeline did not reach both handlers'); })]);
    closing = app.close(); await realDelay(2400); expect(socket.destroyed).toBe(false);
    streamingResponse!.end('last');
    expect(await Promise.race([closing.then(() => true), realDelay(3000, false)])).toBe(true); await ended;
    expect(received).toContain('first'); expect(received).toContain('last');
  } finally { releaseRead(); streamingResponse?.destroy(); socket?.destroy(); app.server.closeIdleConnections(); await (closing || app.close()); removeTempFixture(directory, 'agent-control-'); }
}, 12000);


it.each(['no data', 'partial headers'] as const)('does not let an unfinished request header pin shutdown: %s', async variant => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  const adapter = Object.assign(new EventEmitter(), { status: { connected: false }, close() {} });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  let socket: net.Socket | undefined, closing: Promise<unknown> | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as net.AddressInfo).port;
    const accepted = once(app.server, 'connection');
    socket = net.connect(port, '127.0.0.1'); socket.on('error', () => {});
    const [serverSocket] = await accepted as [net.Socket];
    if (variant === 'partial headers') {
      const received = once(serverSocket, 'data');
      socket.write(`POST /api/threads HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 100\r\n`);
      await received;
    }
    closing = app.close();
    expect(await Promise.race([closing.then(() => true), realDelay(2500, false)])).toBe(true);
  } finally { socket?.destroy(); app.server.closeIdleConnections(); await (closing || app.close()); removeTempFixture(directory, 'agent-control-shutdown-'); }
}, 10000);


it('does not discard a running write when a later request header is incomplete', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  let release!: () => void, notify!: () => void, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { notify = resolve; });
  const adapter = Object.assign(new EventEmitter(), { status: { connected: true, compatible: true }, close() {},
    create: async () => { calls++; notify(); await held; return { threadId: 'fixture-thread' }; } });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  let socket: net.Socket | undefined, closing: Promise<unknown> | undefined, received = '';
  try {
    await app.listen({ host: '127.0.0.1', port: 0 }); const port = (app.server.address() as net.AddressInfo).port, origin = `http://127.0.0.1:${port}`;
    const session = await fetch(`${origin}/api/session`), cookie = session.headers.get('set-cookie')!.split(';')[0], csrf = (await session.json()).csrf;
    const body = JSON.stringify({ operationId: randomUUID(), prompt: 'fixture-only' });
    const accepted = once(app.server, 'connection');
    socket = net.connect(port, '127.0.0.1'); socket.on('data', chunk => { received += chunk.toString(); }); socket.on('error', () => {});
    const [serverSocket] = await accepted as [net.Socket]; const ended = once(socket, 'close');
    socket.write(`POST /api/threads HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nX-Agent-Control-Csrf: ${csrf}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await Promise.race([started, realDelay(3000).then(() => { throw new Error('Write did not reach handler'); })]);
    const partial = once(serverSocket, 'data');
    socket.write(`POST /api/threads HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`); await partial;
    closing = app.close(); await realDelay(2500); expect(socket.destroyed).toBe(false); expect(calls).toBe(1);
    release(); expect(await Promise.race([closing.then(() => true), realDelay(3000, false)])).toBe(true); await ended;
    expect(received).toContain('HTTP/1.1 200'); expect(received).toContain('fixture-thread'); expect(calls).toBe(1);
  } finally { release(); socket?.destroy(); app.server.closeIdleConnections(); await (closing || app.close()); removeTempFixture(directory, 'agent-control-shutdown-'); }
}, 12000);

it('does not let a stalled WebSocket handshake pin shutdown', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-shutdown-'));
  const adapter = Object.assign(new EventEmitter(), { status: { connected: false }, close() {} });
  const { app } = await buildApp({ mode: 'local', port: 3000, publicOrigin: 'http://127.0.0.1:3000', dataDir: directory }, { adapter: adapter as any, serveStatic: false });
  let release!: () => void, notify!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { notify = resolve; });
  app.addHook('onRequest', async request => { if (request.headers.upgrade?.toLowerCase() === 'websocket') { notify(); await held; } });
  let socket: net.Socket | undefined, closing: Promise<unknown> | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 }); const port = (app.server.address() as net.AddressInfo).port, origin = `http://127.0.0.1:${port}`;
    const session = await fetch(`${origin}/api/session`), cookie = session.headers.get('set-cookie')!.split(';')[0];
    socket = net.connect(port, '127.0.0.1'); socket.on('error', () => {}); await once(socket, 'connect');
    socket.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nCookie: ${cookie}\r\n\r\n`);
    await Promise.race([started, realDelay(3000).then(() => { throw new Error('Upgrade did not reach hook'); })]);
    closing = app.close();
    expect(await Promise.race([closing.then(() => true), realDelay(3500, false)])).toBe(true);
  } finally { release(); socket?.destroy(); app.server.closeIdleConnections(); await (closing || app.close()); removeTempFixture(directory, 'agent-control-shutdown-'); }
}, 10000);
