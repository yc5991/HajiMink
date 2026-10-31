import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import type { WebSocket } from 'ws';
import { LIVE_HEARTBEAT_MIN_INTERVAL_MS, LIVE_HEARTBEAT_NONCE, LIVE_HEARTBEAT_PROTOCOL } from '../shared/live-heartbeat.js';
import type { FastifyRequest } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { HarnessRegistry, fullCapabilities, operationEntity, type HarnessAdapter } from './harness.js';
import type { HarnessCapabilities } from '../shared/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { JWTVerifyGetKey } from 'jose';
import { installSecurity, type GatewayConfig } from './security.js';
import { StreamDiagnostic } from './stream-diagnostic.js';
import { CodexDesktopAdapter } from './desktop-adapter.js';
import { Store } from './store.js';
import { AppError } from './errors.js';
import { OwnerAuth } from './owner-auth.js';
import { DeviceAuth } from './device-auth.js';
import { installAuthRoutes } from './auth-routes.js';
import { spawnCodex, type CliSpawn } from './cli-terminal.js';

const operationId = z.string().uuid();
const settingsSchema = z.object({ operationId, model: z.string().min(1).max(100), effort: z.string().min(1).max(30).optional() }).strict();
const promptSchema = z.object({ operationId, prompt: z.string().trim().min(1).max(32000), model: z.string().min(1).max(100).optional(), thinking: z.string().min(1).max(30).optional() }).strict();
const threadId = z.string().regex(/^[a-zA-Z0-9_-]{8,150}$/);

export async function buildApp(config: GatewayConfig, options: { adapter?: HarnessAdapter; registry?: HarnessRegistry; store?: Store; keys?: JWTVerifyGetKey; serveStatic?: boolean; cliSpawn?: CliSpawn } = {}) {
  const adapter = options.adapter || options.registry?.require('codex') || new CodexDesktopAdapter();
  const registry = options.registry || new HarnessRegistry().register('codex', 'Codex', adapter, fullCapabilities).plan('dsh', 'DSH', 'DeepSeek Harness 接入准备中');
  const harnessId = (request: FastifyRequest) => z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).parse((request.query as any)?.harness || 'codex');
  const selectedAdapter = (request: FastifyRequest, capability: keyof HarnessCapabilities = 'read') => registry.require(harnessId(request), capability);
  const entity = (request: FastifyRequest, id: string) => operationEntity(harnessId(request), id);
  const store = options.store || new Store(config.dataDir);
  const app = Fastify({ logger: false, bodyLimit: 160 * 1024, trustProxy: false });
  let shuttingDown = false, readDrainExpired = false;
  let readDrainTimer: NodeJS.Timeout | undefined;
  const incompleteBodies = new Set<IncomingMessage>();
  const activeHttp = new Map<ServerResponse, IncomingMessage>();
  const connections = new Set<Socket>();
  const upgradedConnections = new Set<Socket>();
  // A TCP connection can exist before Node has parsed enough headers to emit
  // a request. Track those sockets as well as normal requests during shutdown.
  app.server.on('connection', socket => {
    connections.add(socket);
    socket.once('close', () => { connections.delete(socket); upgradedConnections.delete(socket); });
    if (shuttingDown) setImmediate(drainShutdown);
  });
  app.server.on('upgrade', (_request, socket) => {
    if (connections.has(socket as Socket)) upgradedConnections.add(socket as Socket);
  });
  const cancelableRead = (request: IncomingMessage) => {
    const pathname = (request.url || '').split('?')[0];
    return (request.method === 'GET' || request.method === 'HEAD') && (pathname === '/api/projects' || pathname === '/api/threads' || /^\/api\/threads\/[a-zA-Z0-9_-]{8,150}$/.test(pathname));
  };
  const drainIncompleteBodies = () => {
    if (!shuttingDown) return;
    for (const request of incompleteBodies) {
      if (request.complete || request.destroyed) continue;
      // request.destroy() closes the whole socket, not just this upload. Keep
      // earlier writes and started responses on that socket until they finish.
      const protectedResponse = [...activeHttp].some(([response, candidate]) => {
        if (candidate.socket !== request.socket) return false;
        // A later pipelined response may have generated headers but still be
        // queued without a socket; no bytes have reached the client yet.
        if (candidate === request) return !!response.socket && (response.headersSent || response.writableEnded);
        return !readDrainExpired || !cancelableRead(candidate) || response.headersSent || response.writableEnded;
      });
      // Finish writing any already-completed response before closing the
      // connection; immediately destroying the request can discard it.
      if (!protectedResponse) request.socket.destroySoon();
    }
  };
  const drainStalledReads = () => {
    if (!shuttingDown || !readDrainExpired) return;
    for (const [response, request] of activeHttp) {
      if (!cancelableRead(request) || response.headersSent || response.writableEnded || response.destroyed) continue;
      // A pipelined response can still be queued without an assigned socket.
      // Wait for the earlier response to finish before attempting to drain it.
      if (!response.socket) continue;
      // Never destroy a connection carrying an unfinished mutation or another
      // unclassified request, including an HTTP/1.1 pipelined request.
      if ([...activeHttp].some(([other, candidate]) => other !== response && candidate.socket === request.socket && !cancelableRead(candidate))) continue;
      response.destroy();
    }
  };
  const drainUnclaimedConnections = () => {
    if (!shuttingDown) return;
    for (const socket of connections) {
      if (socket.destroyed) continue;
      // Let websocket close handshakes and in-progress upgrades finish first.
      // After the existing read grace period, an unfinished upgrade may be
      // closed, but never while this socket also carries an active response.
      if (upgradedConnections.has(socket) && !readDrainExpired) continue;
      if ([...activeHttp].some(([, request]) => request.socket === socket)) continue;
      // No dispatched HTTP response remains on this connection. Flush any
      // buffered bytes before closing an idle or incomplete-header socket.
      socket.destroySoon();
    }
  };
  const drainShutdown = () => { drainIncompleteBodies(); drainStalledReads(); drainUnclaimedConnections(); };
  // A partially uploaded request has not reached a route or dispatched an
  // Agent operation. End only those uploads on shutdown; preserve requests
  // whose bodies have arrived and responses already being produced.
  app.server.on('request', (request, response) => {
    activeHttp.set(response, request);
    const forgetResponse = () => {
      activeHttp.delete(response); response.off('finish', forgetResponse); response.off('close', forgetResponse);
      if (shuttingDown) setImmediate(drainShutdown);
    };
    response.once('finish', forgetResponse); response.once('close', forgetResponse);
    if (response.writableFinished || response.destroyed) forgetResponse();
    if (request.complete) return;
    incompleteBodies.add(request);
    const forget = () => { incompleteBodies.delete(request); request.off('end', forget); request.off('close', forget); };
    request.once('end', forget); request.once('close', forget);
    if (shuttingDown && !request.complete) setImmediate(drainShutdown);
  });
  // Responses still in flight when shutdown begins may otherwise leave their
  // keep-alive connections open long after the gateway has stopped accepting work.
  app.addHook('onSend', async (request, reply, payload) => {
    // A connection can carry multiple pipelined responses. Closing after the
    // first one would silently discard a later, already-dispatched write.
    const otherResponses = [...activeHttp].some(([other, candidate]) => other !== reply.raw && candidate.socket === request.raw.socket);
    if (shuttingDown && !otherResponses) reply.header('Connection', 'close');
    return payload;
  });
  app.addHook('onResponse', async () => {
    if (shuttingDown) setImmediate(() => app.server.closeIdleConnections());
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '提交内容不符合要求，请检查输入' } });
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    const code = (error as any).statusCode || 500;
    reply.code(code).send({ error: { code: 'REQUEST_FAILED', message: code >= 500 ? '服务暂时无法完成请求，请查看诊断状态' : '请求无效' } });
  });
  const ownerAuth = new OwnerAuth(store.db, config.publicOrigin);
  if (config.mode === 'owner' && !ownerAuth.configured && !ownerAuth.prepareSetup(config.ownerSetup)) { store.close(); throw new Error('请先设置密码或通行密钥，或从桌面端开启受限的首次设置'); }
  const devices = new DeviceAuth(store.db);
  const streamDiagnostic = new StreamDiagnostic();
  const { csrf } = await installSecurity(app, config, ownerAuth, devices, options.keys, streamDiagnostic);
  await installAuthRoutes(app, config, ownerAuth, devices, csrf);
  await app.register(websocket, {
    options: { maxPayload: 2048 },
    // A peer may disappear without acknowledging the close frame. Give active
    // subscriptions a brief graceful close, then terminate only those sockets;
    // never kill another process or force-close in-flight HTTP operations here.
    preClose(done) {
      shuttingDown = true;
      drainShutdown();
      readDrainTimer = setTimeout(() => { readDrainExpired = true; drainShutdown(); }, 2000); readDrainTimer.unref();
      const server = this.websocketServer;
      let finished = false;
      const finish = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); done(error); };
      for (const socket of server.clients) {
        try { socket.close(1001, '网关正在停止'); } catch { socket.terminate(); }
      }
      const timer = setTimeout(() => { for (const socket of server.clients) socket.terminate(); }, 1000);
      timer.unref();
      try { server.close(finish); } catch (error) { finish(error instanceof Error ? error : new Error('实时连接关闭失败')); }
    }
  });
  type ClientAuth = { ownerSessionHash?: string; deviceSessionHash?: string; accessExpiresAt?: number };
  type StreamClient = ClientAuth & { thread?: string; harness: string; pageLimit: number; alive: boolean; lastHeartbeatAt?: number };
  type CliClient = ClientAuth & { alive: boolean; starting: boolean; terminal?: Awaited<ReturnType<CliSpawn>> };
  const clients = new Map<WebSocket, StreamClient>();
  const terminals = new Map<WebSocket, CliClient>();
  const sessionStillValid = (client: ClientAuth) => config.mode !== 'owner' || !!((client.ownerSessionHash && ownerAuth.validSessionHash(client.ownerSessionHash)) || (client.deviceSessionHash && devices.validSessionHash(client.deviceSessionHash)));
  const cliSessionStillValid = (client: ClientAuth) => sessionStillValid(client) && (config.mode !== 'access' || (!!client.accessExpiresAt && Date.now() < client.accessExpiresAt));
  const revokeTerminal = (socket: WebSocket, client: CliClient) => { try { client.terminal?.kill(); } catch {} client.terminal = undefined; socket.terminate(); };
  const onRevoked = (hash?: string) => {
    if (!hash) devices.revokeAll();
    for (const [socket, client] of clients) if (!hash || client.ownerSessionHash === hash) socket.close(1008, '请重新登录');
    for (const [socket, client] of terminals) if (!hash || client.ownerSessionHash === hash) revokeTerminal(socket, client);
  };
  const onDeviceRevoked = (hash?: string) => {
    for (const [socket, client] of clients) if (client.deviceSessionHash && (!hash || client.deviceSessionHash === hash)) socket.close(1008, '设备授权已失效');
    for (const [socket, client] of terminals) if (client.deviceSessionHash && (!hash || client.deviceSessionHash === hash)) revokeTerminal(socket, client);
  };
  ownerAuth.on('revoked', onRevoked); devices.on('revoked', onDeviceRevoked);
  const emit = (socket: WebSocket, value: unknown) => {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(1013, '请重新连接'); return; }
    socket.send(JSON.stringify(value));
  };
  const cleanup: (() => void)[] = [];
  const refreshing = new Set<string>();
  const refreshSubscription = async (harness: string, id: string) => {
    const adapter = registry.require(harness); const key = JSON.stringify([harness, id]);
    if (!adapter.status.connected || refreshing.has(key)) return;
    refreshing.add(key);
    try {
      const limits = new Set([...clients.values()].filter(c => c.harness === harness && c.thread === id).map(c => c.pageLimit));
      for (const limit of limits) {
        const view = await adapter.view(id, limit);
        for (const [socket, client] of clients) if (client.harness === harness && client.thread === id && client.pageLimit === limit) emit(socket, { type: 'thread', harness, thread: view });
      }
    }
    catch {} finally { refreshing.delete(key); }
  };
  for (const { id: harness, adapter } of registry.available()) {
    const broadcast = (value: unknown) => { for (const [socket, client] of clients) if (client.harness === harness) emit(socket, value); };
    const onDesktop = (status: unknown) => broadcast({ type: 'desktop', harness, desktop: status });
    const onThread = (id: string) => {
      const windows = new Map<number, ReturnType<HarnessAdapter['viewCached']>>();
      for (const [socket, client] of clients) {
        if (client.harness !== harness || client.thread !== id) continue;
        if (!windows.has(client.pageLimit)) windows.set(client.pageLimit, adapter.viewCached(id, client.pageLimit));
        const view = windows.get(client.pageLimit);
        if (view) { adapter.touch(id); emit(socket, { type: 'thread', harness, thread: view }); }
      }
    };
    const onCatalog = () => broadcast({ type: 'catalog', harness });
    const onInvalidated = (id: string) => { void refreshSubscription(harness, id); };
    adapter.on('desktop', onDesktop); adapter.on('thread', onThread); adapter.on('catalog', onCatalog); adapter.on('invalidated', onInvalidated);
    cleanup.push(() => { adapter.off('desktop', onDesktop); adapter.off('thread', onThread); adapter.off('catalog', onCatalog); adapter.off('invalidated', onInvalidated); });
  }
  const subscriptionRefresh = setInterval(() => {
    for (const { thread, harness } of clients.values()) if (thread && !registry.require(harness).viewCached(thread)) void refreshSubscription(harness, thread);
  }, 5000); subscriptionRefresh.unref();
  app.get('/api/health', async () => ({ ok: true, mode: config.mode, desktop: adapter.status }));
  app.get('/api/harnesses', async request => ({ harnesses: registry.list(), desktop: registry.info(harnessId(request)).status }));
  app.get('/api/projects', async request => ({ projects: (await selectedAdapter(request).catalog()).projects }));
  app.get('/api/threads', async request => {
    const q = z.object({ project: z.string().optional(), search: z.string().max(200).optional(), refresh: z.enum(['true', 'false']).optional() }).parse(request.query);
    let threads = (await selectedAdapter(request).catalog(q.refresh === 'true')).threads;
    if (q.project) threads = threads.filter(t => q.project === 'unassigned' ? !t.projectId : t.projectId === q.project);
    if (q.search) threads = threads.filter(t => t.title.toLowerCase().includes(q.search!.toLowerCase()));
    return { threads };
  });
  app.get('/api/models', async request => ({ models: selectedAdapter(request).models() }));
  app.get('/api/threads/:id', async request => {
    const id = threadId.parse((request.params as any).id);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(40).default(20), cursor: z.string().max(300).optional() }).parse(request.query);
    return { thread: await selectedAdapter(request).view(id, q.limit, q.cursor) };
  });
  app.post('/api/threads', async request => {
    const body = promptSchema.extend({ projectId: z.string().max(150).optional() }).parse(request.body);
    const adapter = selectedAdapter(request, 'create');
    return store.operation(body.operationId, 'create', entity(request, body.projectId || 'unassigned'), body, () => adapter.create(body.prompt, body.projectId, body.model, body.thinking));
  });
  app.post('/api/threads/:id/messages', async request => {
    const id = threadId.parse((request.params as any).id); const body = promptSchema.parse(request.body);
    const adapter = selectedAdapter(request, 'send');
    return store.operation(body.operationId, 'send', entity(request, id), body, () => adapter.send(id, body.prompt, body.model, body.thinking));
  });
  app.post('/api/threads/:id/interrupt', async request => {
    const id = threadId.parse((request.params as any).id);
    const body = z.object({ operationId, expectedTurnId: z.string().min(1).max(150) }).strict().parse(request.body);
    const adapter = selectedAdapter(request, 'interrupt');
    return store.operation(body.operationId, 'interrupt', entity(request, id), body, () => adapter.interrupt(id, body.expectedTurnId));
  });
  app.post('/api/threads/:id/settings', async request => {
    const id = threadId.parse((request.params as any).id); const body = settingsSchema.parse(request.body);
    const adapter = selectedAdapter(request, 'settings');
    return store.operation(body.operationId, 'settings', entity(request, id), body, () => adapter.settings(id, body.model, body.effort));
  });
  app.post('/api/threads/:id/requests/:requestId', async request => {
    const id = threadId.parse((request.params as any).id);
    const rid = z.string().min(1).max(200).parse((request.params as any).requestId);
    const body = z.object({ operationId, turnId: z.string().min(1).max(150), decision: z.enum(['accept', 'decline', 'cancel']).optional(), answers: z.record(z.string().max(150), z.array(z.string().max(6000)).min(1).max(20)).optional() }).strict().parse(request.body);
    const adapter = selectedAdapter(request, 'respond');
    return store.operation(body.operationId, 'respond', entity(request, `${id}:${rid}`), body, () => adapter.respond(id, rid, body.turnId, body));
  });
  app.get('/api/preferences', async request => { registry.info(harnessId(request)); return store.getPreferences(harnessId(request)); });
  app.post('/api/preferences', async request => { const body = z.object({ selectedThread: threadId.nullable().optional(), selectedProject: z.string().max(150).nullable().optional(), theme: z.enum(['system', 'dark', 'light']).optional() }).strict().parse(request.body); registry.info(harnessId(request)); store.setPreferences(body, harnessId(request)); return { ok: true }; });
  app.get('/api/diagnostics/stream', { websocket: true }, (socket, request) => {
    const release = (request as any).releaseStreamDiagnostic as (() => void) | undefined;
    const timer = setTimeout(() => socket.terminate(), 5000); timer.unref();
    const done = () => { clearTimeout(timer); release?.(); };
    socket.once('close', done); socket.on('error', () => { done(); socket.terminate(); });
    socket.once('message', (data, binary) => {
      try {
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        if (binary || bytes.length > 128) throw new Error('invalid diagnostic');
        const input = JSON.parse(bytes.toString('utf8'));
        if (!input || Object.keys(input).sort().join(',') !== 'nonce,type' || input.type !== 'ping' || typeof input.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(input.nonce)) throw new Error('invalid diagnostic');
        socket.send(JSON.stringify({ type: 'pong', nonce: input.nonce }), error => { if (error) socket.terminate(); else socket.close(1000); });
      } catch { socket.close(1008); }
    });
  });
  app.get('/api/events', { websocket: true }, (socket, request) => {
    const harness = harnessId(request); let adapter: HarnessAdapter;
    try { adapter = selectedAdapter(request); } catch { socket.close(1008, '这个软件尚未接入'); return; }
    clients.set(socket, { harness, pageLimit: 20, alive: true, ownerSessionHash: (request as any).ownerSession?.hash, deviceSessionHash: (request as any).ownerSession ? undefined : (request as any).deviceSession?.hash, accessExpiresAt: (request as any).accessExpiresAt }); emit(socket, { type: 'desktop', harness, desktop: adapter.status, heartbeat: LIVE_HEARTBEAT_PROTOCOL });
    socket.on('message', async data => {
      try {
        const client = clients.get(socket); if (!client) return;
        if (!sessionStillValid(client)) { socket.close(1008, '请重新登录'); return; }
        const input = JSON.parse(data.toString());
        if (input?.type === 'heartbeat-ping') {
          const message = z.object({ type: z.literal('heartbeat-ping'), nonce: z.string().regex(LIVE_HEARTBEAT_NONCE) }).strict().parse(input);
          const now = performance.now();
          if (client.lastHeartbeatAt !== undefined && now - client.lastHeartbeatAt < LIVE_HEARTBEAT_MIN_INTERVAL_MS) { socket.close(1008, '实时连接请求过于频繁'); return; }
          client.lastHeartbeatAt = now; client.alive = true;
          emit(socket, { type: 'heartbeat-pong', harness, nonce: message.nonce }); return;
        }
        if (input?.type === 'unsubscribe') { client.alive = true; client.thread = undefined; return; }
        const message = z.object({ type: z.literal('subscribe'), threadId, limit: z.number().int().min(1).max(40).default(20) }).strict().parse(input);
        client.alive = true; client.thread = message.threadId; client.pageLimit = message.limit;
        const view = await adapter.view(message.threadId, message.limit); if (client.thread === message.threadId && client.pageLimit === message.limit) emit(socket, { type: 'thread', harness, thread: view });
      } catch (error) { emit(socket, { type: 'error', message: error instanceof AppError ? error.message : '实时连接请求无效' }); }
    });
    socket.on('close', () => clients.delete(socket)); socket.on('error', () => clients.delete(socket));
    socket.on('pong', () => { const client = clients.get(socket); if (client) { client.alive = true; if (client.thread) adapter.touch(client.thread); } });
  });
  app.get('/api/cli', { websocket: true }, (socket, request) => {
    if (terminals.size >= 4) { socket.close(1013, '终端数量已达上限'); return; }
    const client: CliClient = { alive: true, starting: false, ownerSessionHash: (request as any).ownerSession?.hash, deviceSessionHash: (request as any).ownerSession ? undefined : (request as any).deviceSession?.hash, accessExpiresAt: (request as any).accessExpiresAt };
    terminals.set(socket, client);
    const startTimer = setTimeout(() => { if (!client.terminal) socket.close(1008, '终端启动超时'); }, 30000); startTimer.unref();
    const accessTimer = config.mode === 'access' ? setTimeout(() => { if (!cliSessionStillValid(client)) revokeTerminal(socket, client); }, Math.max(1, Math.min(2147483647, (client.accessExpiresAt || 0) - Date.now()))) : undefined;
    accessTimer?.unref();
    const dispose = () => { clearTimeout(startTimer); clearTimeout(accessTimer); terminals.delete(socket); try { client.terminal?.kill(); } catch {} client.terminal = undefined; };
    socket.once('close', dispose); socket.on('error', () => { dispose(); socket.terminate(); });
    socket.on('pong', () => { client.alive = true; });
    socket.on('message', async (data, binary) => {
      try {
        if (binary || !cliSessionStillValid(client)) { revokeTerminal(socket, client); return; }
        const input = JSON.parse(data.toString()); client.alive = true;
        if (input?.type === 'start') {
          const value = z.object({ type: z.literal('start'), projectId: z.string().max(150).optional(), cols: z.number().int().min(20).max(300), rows: z.number().int().min(5).max(100) }).strict().parse(input);
          if (client.starting || client.terminal) throw new AppError('CLI_ALREADY_STARTED', '终端已启动', 409);
          client.starting = true;
          let cwd = os.homedir();
          if (value.projectId) {
            const projects = (await adapter.catalog()).projects;
            const project = projects.find(item => item.id === value.projectId && item.hostId === 'local');
            if (!project?.path || !path.isAbsolute(project.path)) throw new AppError('PROJECT_NOT_FOUND', '找不到本机项目目录', 404);
            cwd = project.path;
          }
          if (socket.readyState !== 1 || !terminals.has(socket) || !cliSessionStillValid(client)) return;
          const terminal = await (options.cliSpawn || spawnCodex)(cwd, value.cols, value.rows);
          if (socket.readyState !== 1 || !terminals.has(socket) || !cliSessionStillValid(client)) { terminal.kill(); return; }
          client.terminal = terminal; clearTimeout(startTimer);
          terminal.onData(output => emit(socket, { type: 'output', data: output }));
          terminal.onExit(result => { client.terminal = undefined; emit(socket, { type: 'exit', code: result.exitCode }); socket.close(1000, '终端已退出'); });
          emit(socket, { type: 'started' });
        } else if (input?.type === 'input') {
          const value = z.object({ type: z.literal('input'), data: z.string().max(1024) }).strict().parse(input);
          if (!client.terminal) throw new AppError('CLI_NOT_STARTED', '终端尚未启动', 409);
          client.terminal.write(value.data);
        } else if (input?.type === 'resize') {
          const value = z.object({ type: z.literal('resize'), cols: z.number().int().min(20).max(300), rows: z.number().int().min(5).max(100) }).strict().parse(input);
          client.terminal?.resize(value.cols, value.rows);
        } else throw new Error('invalid terminal message');
      } catch (error) {
        emit(socket, { type: 'error', message: error instanceof AppError ? error.message : '终端请求无效，请重新连接' });
        socket.close(1008, '终端请求失败');
      }
    });
  });
  const heartbeat = setInterval(() => { for (const [socket, client] of clients) {
    if (!sessionStillValid(client)) socket.close(1008, '请重新登录');
    else if (socket.readyState === 1) {
      // This is a connection owned by this gateway, never an OS process.
      // Application traffic also proves the inbound side works when an
      // intermediary handles WebSocket control frames itself.
      try {
        if (!client.alive) { socket.terminate(); continue; }
        client.alive = false; socket.ping();
      } catch { try { socket.terminate(); } catch {} }
    }
  }
    for (const [socket, client] of terminals) {
      if (!cliSessionStillValid(client)) revokeTerminal(socket, client);
      else if (socket.readyState === 1) {
        try { if (!client.alive) { socket.terminate(); continue; } client.alive = false; socket.ping(); } catch { socket.terminate(); }
      }
    }
  }, 25000); heartbeat.unref();
  const publicDir = path.resolve('dist');
  if (options.serveStatic !== false && fs.existsSync(publicDir)) {
    await app.register(staticFiles, { root: publicDir, prefix: '/', index: 'index.html' });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } }) : reply.sendFile('index.html'));
  }
  app.addHook('onClose', async () => { streamDiagnostic.clear(); clearTimeout(readDrainTimer); clearInterval(heartbeat); clearInterval(subscriptionRefresh); for (const socket of clients.keys()) socket.close(); ownerAuth.off('revoked', onRevoked); devices.off('revoked', onDeviceRevoked); for (const dispose of cleanup) dispose(); registry.close(); store.close(); });
  return { app, adapter, registry, store, ownerAuth, devices, streamDiagnostic };
}
