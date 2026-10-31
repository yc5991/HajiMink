import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
// @ts-expect-error Electron modules are intentionally CommonJS.
import { readHealth, readBootstrap, normalizeOwnerOrigin } from '../desktop/gateway-manager.cjs';
// @ts-expect-error Electron shell helper is CommonJS.
import { ControllerGatewayManager, PENDING_PUBLIC_ORIGIN } from '../desktop/controller-manager.cjs';

const servers: http.Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(bootstrap: unknown, sessionStatus: number) {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(`${request.url} ${request.headers.host}`);
    if (request.url === '/api/auth/bootstrap') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(bootstrap)); }
    else { response.writeHead(sessionStatus); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  return { port: (server.address() as AddressInfo).port, seen };
}
it('requires both a configured owner endpoint and an unauthenticated 401 before declaring owner mode healthy', async () => {
  const f = await fixture({ mode: 'owner', configured: true, passwordEnabled: true }, 401);
  const config = { mode: 'owner', publicOrigin: 'https://gateway.example.com:8443' };
  expect(await readHealth(f.port, config)).toEqual({ ok: true, mode: 'owner', publicOrigin: config.publicOrigin });
  expect(f.seen).toEqual(['/api/auth/bootstrap gateway.example.com:8443', '/api/session gateway.example.com:8443']);
  expect((await readBootstrap(f.port, config)).passwordEnabled).toBe(true);
});
it('fails closed for an unprotected business endpoint or unconfigured owner', async () => {
  for (const [bootstrap, status] of [
    [{ mode: 'owner', configured: true, passwordEnabled: true }, 200],
    [{ mode: 'owner', configured: false, passwordEnabled: false }, 401],
    [{ mode: 'local', configured: true, passwordEnabled: true }, 401],
  ] as const) {
    const f = await fixture(bootstrap, status);
    expect(await readHealth(f.port, { mode: 'owner', publicOrigin: 'https://example.com' })).toBeNull();
  }
});
it('accepts only a clean HTTPS origin for an owner gateway', () => {
  expect(normalizeOwnerOrigin('https://gateway.example.com:8443/')).toBe('https://gateway.example.com:8443');
  for (const value of ['http://example.com', 'https://user@example.com', 'https://example.com/path', 'https://example.com/?token=x', 'https://example.com#fragment', 'https://example.com\\evil', '']) expect(() => normalizeOwnerOrigin(value)).toThrow();
});

it('keeps protected owner configuration instead of reverting to local mode after an owner startup failure', async () => {
  const f = await fixture({ mode: 'local', configured: true, passwordEnabled: true }, 200);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-owner-failure-'));
  try {
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ mode: 'local', port: f.port, publicOrigin: `http://127.0.0.1:${f.port}` }));
    const manager = new ControllerGatewayManager({ appRoot: root, dataDir: root, port: f.port, platform: 'win32' });
    vi.spyOn(manager, 'readRecord').mockResolvedValue({});
    vi.spyOn(manager, 'attach').mockResolvedValue({ state: 'ready', managed: true, mode: 'local' });
    vi.spyOn(manager, 'stopInternal').mockResolvedValue({ state: 'stopped' });
    const start = vi.spyOn(manager, 'startInternal').mockResolvedValue({ state: 'error' });
    await expect(manager.enableOwner('https://gateway.example.com')).rejects.toThrow('已保留受保护配置');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ mode: 'owner', publicOrigin: 'https://gateway.example.com' });
    expect(start).toHaveBeenCalledTimes(1); manager.close();
  } finally {
    const resolved = fs.realpathSync(root), base = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== base.toLowerCase() || !path.basename(resolved).startsWith('hajimink-owner-failure-')) throw new Error('Unexpected fixture path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

it('distinguishes restricted initialization from an already protected owner gateway', async () => {
  const pending = await fixture({ mode: 'owner', configured: false, passwordEnabled: false, setupPending: true }, 401);
  expect(await readHealth(pending.port, { mode: 'owner', publicOrigin: 'https://gateway.example.com' })).toEqual({ ok: true, mode: 'owner', publicOrigin: 'https://gateway.example.com', setupPending: true });
  const open = await fixture({ mode: 'owner', configured: false, passwordEnabled: false, setupPending: true }, 200);
  expect(await readHealth(open.port, { mode: 'owner', publicOrigin: 'https://gateway.example.com' })).toBeNull();
});

it('creates a one-time setup code only after verifying the owned unconfigured gateway, and stores only its digest', async () => {
  const f = await fixture({ mode: 'local', configured: false, passwordEnabled: false }, 200);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-owner-failure-'));
  try {
    const file = path.join(root, 'config.json');
    const before = { mode: 'local', port: f.port, publicOrigin: `http://127.0.0.1:${f.port}`, extra: 'kept' };
    fs.writeFileSync(file, JSON.stringify(before));
    const manager = new ControllerGatewayManager({ appRoot: root, dataDir: root, port: f.port, platform: 'win32' });
    vi.spyOn(manager, 'readRecord').mockResolvedValue({});
    vi.spyOn(manager, 'attach').mockResolvedValue({ state: 'ready', managed: true, mode: 'local' });
    const stop = vi.spyOn(manager, 'stopInternal').mockResolvedValue({ state: 'stopped', managed: false });
    vi.spyOn(manager, 'startInternal').mockResolvedValue({ state: 'ready', managed: true, mode: 'owner', setupPending: true });
    await expect(manager.beginPasskeySetup('https://203.0.113.5')).rejects.toThrow('需要最终 HTTPS 域名');
    expect(stop).not.toHaveBeenCalled();
    const result = await manager.beginPasskeySetup('https://gateway.example.com');
    const text = fs.readFileSync(file, 'utf8'); const saved = JSON.parse(text);
    expect(result.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(text).not.toContain(result.code);
    expect(saved).toMatchObject({ mode: 'owner', port: f.port, publicOrigin: 'https://gateway.example.com', extra: 'kept', ownerSetup: { codeHash: createHash('sha256').update(result.code).digest('hex'), expiresAt: result.expiresAt } });
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
    manager.close();
  } finally {
    const resolved = fs.realpathSync(root), base = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== base.toLowerCase() || !path.basename(resolved).startsWith('hajimink-owner-failure-')) throw new Error('Unexpected fixture path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

it('does not stop or replace an already configured owner when starting passkey setup', async () => {
  const f = await fixture({ mode: 'local', configured: true, passwordEnabled: true }, 200);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-owner-failure-'));
  try {
    const manager = new ControllerGatewayManager({ appRoot: root, dataDir: root, port: f.port, platform: 'win32' });
    vi.spyOn(manager, 'readRecord').mockResolvedValue({}); vi.spyOn(manager, 'attach').mockResolvedValue({ state: 'ready', managed: true, mode: 'local' });
    const stop = vi.spyOn(manager, 'stopInternal');
    await expect(manager.beginPasskeySetup('https://gateway.example.com')).rejects.toThrow('已经设置过登录方式');
    expect(stop).not.toHaveBeenCalled(); manager.close();
  } finally {
    const resolved = fs.realpathSync(root), base = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== base.toLowerCase() || !path.basename(resolved).startsWith('hajimink-owner-failure-')) throw new Error('Unexpected fixture path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

it('prepares an unknown public address without replacing existing credentials or touching an unowned gateway', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-owner-failure-'));
  try {
    for (const passwordEnabled of [false, true]) {
      const f = await fixture({ mode: 'local', configured: passwordEnabled, passwordEnabled }, 200);
      const manager = new ControllerGatewayManager({ appRoot: root, dataDir: root, port: f.port, platform: 'win32' });
      vi.spyOn(manager, 'readRecord').mockResolvedValue({});
      const attach = vi.spyOn(manager, 'attach').mockResolvedValue({ state: 'ready', managed: true, mode: 'local' });
      const pending = vi.spyOn(manager, 'beginPasskeySetupInternal').mockResolvedValue({ gateway: {}, code: 'fixture', expiresAt: 1 });
      const owner = vi.spyOn(manager, 'enableOwnerInternal').mockResolvedValue({ state: 'ready' });
      await manager.prepareAwaitingOrigin();
      if (passwordEnabled) {
        expect(owner).toHaveBeenCalledWith(PENDING_PUBLIC_ORIGIN, true);
        expect(pending).not.toHaveBeenCalled();
      } else {
        expect(pending).toHaveBeenCalledWith(PENDING_PUBLIC_ORIGIN, 'prepare');
        expect(owner).not.toHaveBeenCalled();
      }
      attach.mockResolvedValue({ state: 'ready', managed: false, mode: 'local' });
      await expect(manager.prepareAwaitingOrigin()).rejects.toThrow('请先确认本机网关');
      manager.close();
    }
  } finally {
    const resolved = fs.realpathSync(root), base = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== base.toLowerCase() || !path.basename(resolved).startsWith('hajimink-owner-failure-')) throw new Error('Unexpected fixture path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

it('binds a pending protected setup to a real HTTPS IP without exposing its new setup code', async () => {
  const f = await fixture({ mode: 'owner', configured: false, passwordEnabled: false, setupPending: true }, 401);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-owner-failure-'));
  try {
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ mode: 'owner', port: f.port, publicOrigin: PENDING_PUBLIC_ORIGIN, extra: 'preserved' }));
    const manager = new ControllerGatewayManager({ appRoot: root, dataDir: root, port: f.port, platform: 'win32' });
    vi.spyOn(manager, 'readRecord').mockResolvedValue({});
    const attach = vi.spyOn(manager, 'attach').mockResolvedValue({ state: 'ready', managed: true, mode: 'owner', publicOrigin: PENDING_PUBLIC_ORIGIN, setupPending: true });
    const stop = vi.spyOn(manager, 'stopInternal').mockResolvedValue({ state: 'stopped', managed: false });
    vi.spyOn(manager, 'startInternal').mockResolvedValue({ state: 'ready', managed: true, mode: 'owner', setupPending: true });
    await expect(manager.bindPendingOrigin(PENDING_PUBLIC_ORIGIN)).rejects.toThrow('真实 HTTPS 地址');
    await expect(manager.beginPasskeySetup(PENDING_PUBLIC_ORIGIN)).rejects.toThrow('真实 HTTPS 地址');
    await expect(manager.enableOwner(PENDING_PUBLIC_ORIGIN)).rejects.toThrow('真实 HTTPS 地址');
    attach.mockResolvedValueOnce({ state: 'ready', managed: true, mode: 'local' });
    await expect(manager.bindPendingOrigin('https://203.0.113.5:8443')).rejects.toThrow('受限的首次设置');
    expect(stop).not.toHaveBeenCalled();
    const result = await manager.bindPendingOrigin('https://203.0.113.5:8443');
    const text = fs.readFileSync(file, 'utf8'); const saved = JSON.parse(text);
    expect(result.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(text).not.toContain(result.code);
    expect(saved).toMatchObject({ mode: 'owner', publicOrigin: 'https://203.0.113.5:8443', extra: 'preserved', ownerSetup: { codeHash: createHash('sha256').update(result.code).digest('hex') } });
    expect(f.seen).toContain('/api/auth/bootstrap hajimink-setup.invalid');
    manager.close();
  } finally {
    const resolved = fs.realpathSync(root), base = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== base.toLowerCase() || !path.basename(resolved).startsWith('hajimink-owner-failure-')) throw new Error('Unexpected fixture path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});


it('cancels an unfinished local bootstrap request without returning partial data', async () => {
  let started!: () => void; const received = new Promise<void>(resolve => { started = resolve; });
  const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"mode":'); started(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  const port = (server.address() as AddressInfo).port, config = { mode: 'owner', publicOrigin: 'https://gateway.example.com' };
  const controller = new AbortController(); const pending = readBootstrap(port, config, { signal: controller.signal });
  await received; controller.abort();
  expect(await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('timed out'), 700))])).toBeNull();
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  expect(await readBootstrap(port, config, { signal: alreadyAborted.signal })).toBeNull();
});
