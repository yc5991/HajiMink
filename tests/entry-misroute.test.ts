import { expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { buildApp } from '../server/app';
import { Store } from '../server/store';
import { OwnerAuth } from '../server/owner-auth';
import { removeTempFixture } from './safe-temp';
// @ts-expect-error The desktop probe is shared directly with Electron.
import { probePublicGateway } from '../desktop/connection-probe.cjs';

it('detects a reverse proxy directed at a different real owner-mode gateway', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-entry-match-'));
  const publicOrigin = 'https://gateway.example.test:8443', host = new URL(publicOrigin).host;
  const adapter = () => Object.assign(new EventEmitter(), { status: { connected: false }, close() {} });
  const instances: Awaited<ReturnType<typeof buildApp>>[] = [];
  let proxy: http.Server | undefined, targetPort = 0;
  const seen: Array<{ cookie?: string; authorization?: string }> = [];
  async function createInstance(name: string) {
    const dataDir = path.join(directory, name), store = new Store(dataDir);
    await new OwnerAuth(store.db, publicOrigin).setPassword('fixture-only-password-2026');
    const instance = await buildApp({ mode: 'owner', port: 8443, publicOrigin, dataDir }, { store, adapter: adapter() as any, serveStatic: false });
    instances.push(instance); await instance.app.listen({ host: '127.0.0.1', port: 0 }); return instance;
  }
  try {
    const local = await createInstance('local'), other = await createInstance('other');
    const portOf = (instance: typeof local) => (instance.app.server.address() as net.AddressInfo).port;
    proxy = http.createServer((request, response) => {
      seen.push({ cookie: request.headers.cookie, authorization: request.headers.authorization });
      const upstream = http.request({ hostname: '127.0.0.1', port: targetPort, path: request.url, method: request.method, headers: { ...request.headers, host } }, result => { response.writeHead(result.statusCode || 502, result.headers); result.pipe(response); });
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); }); request.pipe(upstream);
    });
    await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as net.AddressInfo).port;
    const fetchImpl = (url: URL, options: RequestInit) => fetch(`http://127.0.0.1:${proxyPort}${url.pathname}${url.search}`, options);
    const gateway = { mode: 'owner', state: 'ready', managed: true, publicOrigin, port: portOf(local), pid: 42 };
    targetPort = portOf(local);
    expect(await probePublicGateway({ url: publicOrigin }, gateway, { fetchImpl })).toMatchObject({ state: 'identified' });
    targetPort = portOf(other);
    expect(await probePublicGateway({ url: publicOrigin }, gateway, { fetchImpl })).toMatchObject({ state: 'mismatch' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(item => !item.cookie && !item.authorization)).toBe(true);
  } finally {
    proxy?.closeAllConnections(); if (proxy) await new Promise<void>(resolve => proxy!.close(() => resolve()));
    for (const instance of instances) await instance.app.close();
    removeTempFixture(directory, 'agent-control-');
  }
}, 15000);
