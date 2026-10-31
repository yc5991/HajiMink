import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
// @ts-expect-error CommonJS desktop modules are also used directly by Electron.
import { ConnectionStore } from '../desktop/connections.cjs';
// @ts-expect-error CommonJS desktop modules are also used directly by Electron.
import { ControllerGatewayManager } from '../desktop/controller-manager.cjs';
// @ts-expect-error CommonJS desktop modules are also used directly by Electron.
import { GatewayManager } from '../desktop/gateway-manager.cjs';

const roots: string[] = [];
const listeners: net.Server[] = [];
async function port() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return value;
}
async function portExcept(excluded: number) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = await port();
    if (candidate !== excluded) return candidate;
  }
  throw new Error('Could not obtain a different fixture port');
}
function fixture(p: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-port-test-')); roots.push(root);
  const store = new ConnectionStore(root, 'win32', p);
  const manager = new ControllerGatewayManager({ appRoot: root, dataDir: path.join(root, 'gateway'), port: p, platform: 'win32' });
  return { root, store, manager };
}
afterEach(async () => {
  for (const server of listeners.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) {
    const resolved = fs.realpathSync(root), temp = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== temp.toLowerCase() || !path.basename(resolved).startsWith('hajimink-port-test-')) throw new Error('Unexpected fixture path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

it('persists one canonical local port without touching other connection settings and restores memory on save failure', async () => {
  const old = await port(), next = await portExcept(old); const { root, store } = fixture(old);
  const original = store.snapshot().connections[0];
  store.add({ name: '远程', url: 'https://example.com' });
  store.setLocalPort(next);
  expect(store.localPort()).toBe(next);
  const reloaded = new ConnectionStore(root, 'win32', old);
  expect(reloaded.localPort()).toBe(next);
  expect(reloaded.snapshot().connections[0]).toMatchObject({ id: original.id, local: true, url: `http://127.0.0.1:${next}` });
  expect(reloaded.snapshot().connections[1]).toMatchObject({ name: '远程', url: 'https://example.com' });
  vi.spyOn(store, 'save').mockImplementation(() => { throw new Error('disk full'); });
  expect(() => store.setLocalPort(old)).toThrow();
  expect(store.localPort()).toBe(next);
  for (const bad of [0, 80, 1023, 65536, 1234.5, 'not-a-port']) expect(() => store.setLocalPort(bad)).toThrow();
});

it('does not touch a running controller when the requested port is already occupied', async () => {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); listeners.push(server);
  const busy = (server.address() as net.AddressInfo).port;
  const { store, manager } = fixture(await port());
  const read = vi.spyOn(manager, 'readRecord');
  const before = store.localPort();
  await expect(manager.changePort(busy, store)).rejects.toThrow('已被其他程序占用');
  expect(store.localPort()).toBe(before); expect(read).not.toHaveBeenCalled(); manager.close();
});

it('refuses a port change if a gateway lock cannot be identified', async () => {
  const { store, manager } = fixture(await port());
  vi.spyOn(manager, 'readRecord').mockResolvedValue(null);
  vi.spyOn(manager, 'hasFile').mockResolvedValue(true);
  const before = store.localPort();
  await expect(manager.changePort(await portExcept(before), store)).rejects.toThrow('无法确认');
  expect(store.localPort()).toBe(before); manager.close();
});

it('restores the old port and owned gateway if the new launch fails after a verified stop', async () => {
  const old = await port(), next = await portExcept(old); const { store, manager } = fixture(old);
  vi.spyOn(manager, 'readRecord').mockResolvedValueOnce({}).mockResolvedValue(null);
  vi.spyOn(manager, 'attach').mockResolvedValue({ state: 'ready', managed: true });
  vi.spyOn(manager, 'stopInternal').mockResolvedValue({ state: 'stopped', managed: false });
  vi.spyOn(manager, 'hasFile').mockResolvedValue(false);
  const start = vi.spyOn(manager, 'startInternal').mockImplementation(async () => ({ state: manager.port === next ? 'error' : 'ready' }));
  await expect(manager.changePort(next, store)).rejects.toThrow('已恢复原端口和网关');
  expect(store.localPort()).toBe(old); expect(manager.port).toBe(old);
  expect(start).toHaveBeenCalledTimes(2); manager.close();
});

it('never removes or rolls back past an unconfirmed new instance', async () => {
  const old = await port(), next = await portExcept(old); const { store, manager } = fixture(old);
  vi.spyOn(manager, 'readRecord').mockResolvedValueOnce({}).mockRejectedValue(new Error('unconfirmed'));
  vi.spyOn(manager, 'attach').mockResolvedValue({ state: 'ready', managed: true });
  const stop = vi.spyOn(manager, 'stopInternal').mockResolvedValue({ state: 'stopped', managed: false });
  vi.spyOn(manager, 'startInternal').mockResolvedValue({ state: 'error' });
  await expect(manager.changePort(next, store)).rejects.toThrow('无法确认后台实例是否退出');
  expect(store.localPort()).toBe(next); expect(manager.port).toBe(next);
  expect(stop).toHaveBeenCalledTimes(1); manager.close();
});

it('reconciles only a safe local or owner config and preserves unrelated settings', async () => {
  const old = await port(), next = await portExcept(old); const { root } = fixture(old);
  const dataDir = path.join(root, 'gateway'); fs.mkdirSync(dataDir);
  const entry = path.join(root, 'entry.js'); fs.writeFileSync(entry, '');
  const config = path.join(dataDir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ mode: 'local', port: old, publicOrigin: `http://127.0.0.1:${old}`, extra: 'preserved' }));
  const manager = new GatewayManager({ appRoot: root, dataDir, entryPath: entry, port: next });
  await manager.ensureConfig();
  expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({ mode: 'local', port: next, publicOrigin: `http://127.0.0.1:${next}`, extra: 'preserved' });
  fs.writeFileSync(config, JSON.stringify({ mode: 'owner', port: old, publicOrigin: 'https://example.com', extra: 'preserved' }));
  await manager.ensureConfig();
  expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({ mode: 'owner', port: next, publicOrigin: 'https://example.com', extra: 'preserved' });
  fs.writeFileSync(config, JSON.stringify({ mode: 'owner', port: next, publicOrigin: 'https://example.com/' }));
  await manager.ensureConfig();
  expect(JSON.parse(fs.readFileSync(config, 'utf8')).publicOrigin).toBe('https://example.com');
  for (const invalid of [
    { mode: 'access', port: old, publicOrigin: 'https://example.com' },
    { mode: 'owner', port: old, publicOrigin: 'http://example.com' },
    { mode: 'owner', port: old, publicOrigin: 'https://user:secret@example.com' },
  ]) {
    const text = JSON.stringify(invalid); fs.writeFileSync(config, text);
    await expect(manager.ensureConfig()).rejects.toThrow('未修改配置');
    expect(fs.readFileSync(config, 'utf8')).toBe(text);
  }
  manager.close();
});
