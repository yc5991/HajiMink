import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
// @ts-expect-error The Electron entry is deliberately usable directly in Node as well.
import { ConnectionStore, normalizeConnection, allowedViewRequest, providerGuide } from '../desktop/connections.cjs';

const roots: string[] = [];
function fixture(platform = 'win32') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-test-')); roots.push(root);
  return { root, store: new ConnectionStore(root, platform) };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const resolved = fs.realpathSync(root);
    const temp = fs.realpathSync(os.tmpdir());
    if (!resolved.startsWith(temp + path.sep) || !path.basename(resolved).startsWith('hajimink-test-')) throw new Error('Unexpected test path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
it('accepts HTTPS or genuine loopback and rejects addresses with credentials or extra components', () => {
  expect(normalizeConnection({ name: ' 主机 ', url: 'https://example.com/' })).toEqual({ name: '主机', url: 'https://example.com', provider: 'other' });
  expect(normalizeConnection({ name: '本机', url: 'http://127.0.0.1:3000' }).url).toBe('http://127.0.0.1:3000');
  for (const url of ['http://example.com', 'http://127.0.0.1.example.com', 'file:///etc/passwd', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/?token=secret', 'https://example.com/#secret']) {
    expect(() => normalizeConnection({ name: 'x', url })).toThrow();
  }
});
it('creates independent connection identifiers, persists only non-secret settings and removes only the chosen record', () => {
  const { root, store } = fixture(); const first = store.snapshot().connections[0];
  const added = store.add({ name: '远程', url: 'https://example.com' }); const second = added.connections[1];
  expect(first.id).not.toBe(second.id); expect(added.selected).toBe(second.id);
  store.edit(second.id, { name: '另一个名称', url: 'https://example.com' });
  const text = fs.readFileSync(path.join(root, 'connections.json'), 'utf8');
  expect(text).not.toMatch(/token|password|cookie/i);
  const reloaded = new ConnectionStore(root, 'win32');
  expect(reloaded.snapshot().connections).toHaveLength(2);
  expect(reloaded.remove(second.id).connections).toEqual([first]);
  expect(reloaded.snapshot().selected).toBe(first.id);
});
it('starts without an implicit local connection on non-Windows platforms and fails closed on corrupt settings', () => {
  const { root, store } = fixture('linux'); expect(store.snapshot().connections).toEqual([]);
  fs.writeFileSync(path.join(root, 'connections.json'), '{"version":1,"connections":[{"id":"../../bad","name":"x","url":"https://example.com"}]}');
  expect(() => new ConnectionStore(root, 'linux')).toThrow();
});
it('allows only the selected origin and its websocket, blocking subresource requests to other hosts and local services', () => {
  for (const url of ['https://example.com/api', 'wss://example.com/api/events', 'data:image/png;base64,AA==', 'blob:https://example.com/123']) expect(allowedViewRequest(url, 'https://example.com')).toBe(true);
  for (const url of ['http://example.com/', 'https://example.com:444/', 'https://other.example/', 'http://127.0.0.1:3000/', 'file:///secret', 'javascript:alert(1)', 'blob:https://other.example/123']) expect(allowedViewRequest(url, 'https://example.com')).toBe(false);
});

it('keeps the managed local address fixed when editing its label', () => {
  const { store } = fixture();
  const local = store.snapshot().connections[0];
  expect(() => store.edit(local.id, { name: 'Changed', url: 'https://example.com' })).toThrow();
  expect(store.edit(local.id, { name: 'My machine', url: local.url }).connections[0]).toMatchObject({ name: 'My machine', url: local.url, local: true });
});


it('accepts a bare server IP, host or HTTPS tunnel address without weakening remote transport', () => {
  for (const [input, expected] of [
    ['203.0.113.10', 'https://203.0.113.10'],
    ['203.0.113.10:8443', 'https://203.0.113.10:8443'],
    ['gateway.example.com:8443', 'https://gateway.example.com:8443'],
    ['2001:db8::1', 'https://[2001:db8::1]'],
    ['[2001:db8::1]:8443', 'https://[2001:db8::1]:8443'],
    ['https://gateway.example.com', 'https://gateway.example.com'],
  ]) expect(normalizeConnection({ name: '服务器', url: input, provider: 'self-hosted' })).toEqual({ name: '服务器', url: expected, provider: 'self-hosted' });
  for (const url of ['http://203.0.113.10:8080', 'ftp://example.com', 'https://user@example.com', 'example.com/path', 'example.com/?secret=x', 'example.com#frag', 'https://example.com\\evil', 'example.com\n.evil', '']) {
    expect(() => normalizeConnection({ name: '服务器', url })).toThrow();
  }
  expect(() => normalizeConnection({ name: '服务器', url: 'example.com', provider: 'untrusted' })).toThrow();
});

it('loads older v1 records and persists a selected provider without any service credentials', () => {
  const { root } = fixture('linux');
  const id = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(root, 'connections.json'), JSON.stringify({ version: 1, selected: id, connections: [{ id, name: '旧连接', url: 'https://example.com', local: false }] }));
  const store = new ConnectionStore(root, 'linux');
  expect(store.snapshot().connections[0]).toMatchObject({ id, provider: 'other' });
  const saved = store.edit(id, { name: '自建', url: '203.0.113.10:8443', provider: 'self-hosted' });
  expect(saved.connections[0]).toMatchObject({ id, url: 'https://203.0.113.10:8443', provider: 'self-hosted' });
  const reloaded = new ConnectionStore(root, 'linux');
  expect(reloaded.snapshot().connections[0]).toMatchObject({ id, provider: 'self-hosted' });
  reloaded.edit(id, { name: '保留方式', url: 'https://example.com' });
  expect(reloaded.snapshot().connections[0].provider).toBe('self-hosted');
  expect(fs.readFileSync(path.join(root, 'connections.json'), 'utf8')).not.toMatch(/token|password|cookie/i);
});


it('opens only fixed HTTPS documentation for supported providers', () => {
  expect(providerGuide('natapp')).toBe('https://natapp.cn/article/natapp_newbie');
  expect(providerGuide('sakurafrp')).toBe('https://doc.natfrp.com/app/http.html');
  expect(providerGuide('tailscale')).toBe('https://tailscale.com/docs/features/tailscale-funnel');
  expect(providerGuide('tailscale-serve')).toBe('https://tailscale.com/kb/1242/tailscale-serve');
  expect(() => normalizeConnection({ name: '错误类型', url: 'example.com', provider: 'tailscale-serve' })).toThrow();
  expect(providerGuide('cloudflare')).toBe('https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/');
  for (const value of ['self-hosted', 'other', 'https://attacker.example.com', '__proto__', 'constructor', null]) expect(() => providerGuide(value)).toThrow();
});

it('persists the desktop theme, migrates older profiles and rolls back a failed save', () => {
  const { root, store } = fixture();
  expect(store.snapshot().theme).toBe('system');
  expect(store.setTheme('dark').theme).toBe('dark');
  expect(new ConnectionStore(root, 'win32').snapshot().theme).toBe('dark');
  for (const value of ['light', 'system']) {
    store.setTheme(value);
    expect(new ConnectionStore(root, 'win32').snapshot().theme).toBe(value);
  }
  for (const value of ['blue', '', null, true]) expect(() => store.setTheme(value)).toThrow('界面主题设置无效');
  const disk = fs.readFileSync(path.join(root, 'connections.json'), 'utf8');
  const spy = vi.spyOn(store, 'save').mockImplementation(() => { throw new Error('fixture disk failure'); });
  try {
    expect(() => store.setTheme('dark')).toThrow('fixture disk failure');
    expect(store.snapshot().theme).toBe('system');
    expect(fs.readFileSync(path.join(root, 'connections.json'), 'utf8')).toBe(disk);
  } finally { spy.mockRestore(); }
  const old = JSON.parse(disk);
  delete old.theme; fs.writeFileSync(path.join(root, 'connections.json'), JSON.stringify(old));
  expect(new ConnectionStore(root, 'win32').snapshot().theme).toBe('system');
  old.theme = 'blue'; fs.writeFileSync(path.join(root, 'connections.json'), JSON.stringify(old));
  expect(() => new ConnectionStore(root, 'win32')).toThrow('界面主题设置无效');
});

it('persists the selected tunnel provider across restart and rolls back a failed save', () => {
  const { root, store } = fixture();
  expect(store.snapshot().setup.tunnelProvider).toBeNull();
  expect(store.setTunnelProvider('tailscale').setup.tunnelProvider).toBe('tailscale');
  expect(new ConnectionStore(root, 'win32').snapshot().setup.tunnelProvider).toBe('tailscale');
  for (const provider of ['natapp', 'sakurafrp', 'tailscale', 'cloudflare', 'self-hosted']) {
    store.setTunnelProvider(provider);
    expect(new ConnectionStore(root, 'win32').snapshot().setup.tunnelProvider).toBe(provider);
  }
  expect(() => store.setTunnelProvider('invalid')).toThrow();
  const before = store.snapshot().setup.tunnelProvider;
  vi.spyOn(store, 'save').mockImplementation(() => { throw new Error('disk full'); });
  expect(() => store.setTunnelProvider('cloudflare')).toThrow('disk full');
  expect(store.snapshot().setup.tunnelProvider).toBe(before);
});

it('persists first-run completion while preserving existing profile behavior', () => {
  const { root, store } = fixture();
  expect(store.snapshot().setup.complete).toBe(false);
  store.completeSetup(); expect(new ConnectionStore(root, 'win32').snapshot().setup.complete).toBe(true);
  const data = JSON.parse(fs.readFileSync(path.join(root, 'connections.json'), 'utf8'));
  delete data.setup; fs.writeFileSync(path.join(root, 'connections.json'), JSON.stringify(data));
  expect(new ConnectionStore(root, 'win32').snapshot().setup.complete).toBe(true);
});



it('persists an explicit manual-stop preference, migrates old profiles and rolls back save failure', () => {
  const { root, store } = fixture();
  expect(store.snapshot().setup.gatewayManuallyStopped).toBe(false);
  store.completeSetup();
  store.setGatewayManuallyStopped(true);
  expect(new ConnectionStore(root, 'win32').snapshot().setup.gatewayManuallyStopped).toBe(true);
  expect(() => store.setGatewayManuallyStopped('stopped')).toThrow();
  const disk = fs.readFileSync(path.join(root, 'connections.json'), 'utf8');
  const spy = vi.spyOn(store, 'save').mockImplementation(() => { throw new Error('fixture disk failure'); });
  try {
    expect(() => store.setGatewayManuallyStopped(false)).toThrow('fixture disk failure');
    expect(store.snapshot().setup.gatewayManuallyStopped).toBe(true);
    expect(fs.readFileSync(path.join(root, 'connections.json'), 'utf8')).toBe(disk);
  } finally { spy.mockRestore(); }
  store.setGatewayManuallyStopped(false);
  expect(new ConnectionStore(root, 'win32').snapshot().setup.gatewayManuallyStopped).toBe(false);
  const old = JSON.parse(fs.readFileSync(path.join(root, 'connections.json'), 'utf8'));
  delete old.setup.gatewayManuallyStopped;
  fs.writeFileSync(path.join(root, 'connections.json'), JSON.stringify(old));
  expect(new ConnectionStore(root, 'win32').snapshot().setup.gatewayManuallyStopped).toBe(false);
  old.setup.gatewayManuallyStopped = 'false';
  fs.writeFileSync(path.join(root, 'connections.json'), JSON.stringify(old));
  expect(() => new ConnectionStore(root, 'win32')).toThrow('首次设置状态无效');
});

it('keeps in-memory and on-disk connection state unchanged when any save fails', () => {
  const { root, store } = fixture();
  const local = store.snapshot().connections[0];
  const second = store.add({ name: 'remote', url: 'https://example.com' }).connections[1];
  const previous = store.snapshot();
  const disk = fs.readFileSync(path.join(root, 'connections.json'), 'utf8');
  const spy = vi.spyOn(store, 'save').mockImplementation(() => { throw new Error('fixture disk failure'); });
  try {
    for (const operation of [
      () => store.add({ name: 'new', url: 'https://new.example.com' }),
      () => store.edit(second.id, { name: 'changed', url: 'https://changed.example.com' }),
      () => store.remove(second.id),
      () => store.remove(local.id),
      () => store.select(local.id)
    ]) {
      expect(operation).toThrow('fixture disk failure');
      expect(store.snapshot()).toEqual(previous);
      expect(fs.readFileSync(path.join(root, 'connections.json'), 'utf8')).toBe(disk);
      expect(new ConnectionStore(root, 'win32').snapshot()).toEqual(previous);
    }
  } finally { spy.mockRestore(); }
});
