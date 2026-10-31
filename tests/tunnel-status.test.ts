import { expect, it, vi } from 'vitest';
// @ts-expect-error Shared desktop state is CommonJS for Electron.
import { ExternalTunnelStatus } from '../desktop/tunnel-status.cjs';

const ready = { state: 'ready', managed: true, pid: 42, controllerPid: 41, port: 3500, mode: 'owner', publicOrigin: 'https://private.example.test', setupPending: false, awaitingPublicOrigin: false };

it('distinguishes external entry checks from tunnel process management', () => {
  const model = new ExternalTunnelStatus({ now: () => 12345 });
  model.setContext(null, ready);
  expect(model.snapshot()).toMatchObject({ provider: null, management: 'external', state: 'unconfigured', checkedAt: null });
  model.setContext('natapp', { ...ready, state: 'stopped', managed: false });
  expect(model.snapshot().state).toBe('waiting');
  model.setContext('natapp', { ...ready, mode: 'local' });
  expect(model.snapshot().state).toBe('needs-protection');
  model.setContext('natapp', { ...ready, awaitingPublicOrigin: true });
  expect(model.snapshot().state).toBe('needs-address');
  model.setContext('natapp', ready);
  expect(model.snapshot()).toMatchObject({ state: 'unchecked', management: 'external' });
  const revision = model.begin();
  expect(model.snapshot().state).toBe('checking');
  expect(model.finish(revision, { state: 'identified', stream: 'passed', message: 'untrusted-secret' })).toBe(true);
  expect(model.snapshot()).toMatchObject({ state: 'reachable', checkedAt: 12345, provider: 'natapp' });
  expect(JSON.stringify(model.snapshot())).not.toContain('untrusted-secret');
  expect(JSON.stringify(model.snapshot())).not.toContain('private.example.test');
  expect(model.finish(revision, { state: 'unsafe' })).toBe(false);
  model.close();
});

it('rejects unavailable gateways and ignores late results after configuration changes', () => {
  const model = new ExternalTunnelStatus();
  model.setContext('tailscale', { ...ready, mode: 'local' });
  expect(() => model.begin()).toThrow(/独立登录/);
  model.setContext('tailscale', { ...ready, awaitingPublicOrigin: true });
  expect(() => model.begin()).toThrow(/真实 HTTPS/);
  model.setContext('tailscale', ready);
  const pending = model.begin();
  model.setContext('self-hosted', ready);
  expect(model.finish(pending, { state: 'identified' })).toBe(false);
  expect(model.snapshot()).toMatchObject({ provider: 'self-hosted', state: 'unchecked', checkedAt: null });
  const second = model.begin();
  model.setContext('self-hosted', { ...ready, port: 3600 });
  expect(model.finish(second, { state: 'unsafe' })).toBe(false);
  expect(model.snapshot().state).toBe('unchecked');
  expect(() => model.setContext('__proto__', ready)).toThrow(/连接方式/);
  model.close();
});

it('preserves a check through unrelated desktop status changes and maps only known result states', () => {
  const model = new ExternalTunnelStatus({ now: () => 77 });
  const onState = vi.fn(); model.on('state', onState);
  model.setContext('sakurafrp', ready);
  const pending = model.begin();
  expect(model.setContext('sakurafrp', { ...ready, desktop: { version: '26.1023.6123.0' }, updatedAt: 99 })).toBe(false);
  expect(model.finish(pending, { state: 'pending', stream: 'passed' })).toBe(true);
  expect(model.snapshot()).toMatchObject({ state: 'reachable', checkedAt: 77 });
  for (const [input, output] of [['restricted', 'restricted'], ['unsafe', 'unsafe'], ['mismatch', 'error'], ['unrecognized', 'error'], ['unreachable', 'error'], ['unknown-secret', 'error']] as const) {
    const revision = model.begin();
    expect(model.finish(revision, { state: input, message: 'private-body' })).toBe(true);
    expect(model.snapshot().state).toBe(output);
    expect(JSON.stringify(model.snapshot())).not.toMatch(/private-body|unknown-secret/);
  }
  const old = model.begin();
  const latest = model.begin();
  expect(model.finish(old, { state: 'identified' })).toBe(false);
  expect(model.finish(latest, { state: 'restricted' })).toBe(true);
  model.setContext('sakurafrp', { ...ready, state: 'stopped', managed: false });
  expect(model.snapshot()).toMatchObject({ state: 'waiting', checkedAt: null });
  expect(onState).toHaveBeenCalled();
  model.close();
});


it('reports webpage and realtime results independently and clears them on configuration changes', () => {
  const model = new ExternalTunnelStatus(); model.setContext('natapp', ready);
  for (const [stream, state] of [['passed', 'reachable'], ['failed', 'partial'], ['unchecked', 'partial']] as const) {
    const revision = model.begin(); expect(model.finish(revision, { state: 'identified', stream })).toBe(true);
    expect(model.snapshot()).toMatchObject({ state, stream });
  }
  const rejected = model.begin(); model.finish(rejected, { state: 'unsafe', stream: 'passed' });
  expect(model.snapshot()).toMatchObject({ state: 'unsafe', stream: 'unchecked' });
  model.setContext('natapp', { ...ready, streamDiagnostic: true });
  expect(model.snapshot()).toMatchObject({ state: 'unchecked', stream: 'unchecked', checkedAt: null });
  model.close();
});
