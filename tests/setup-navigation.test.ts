import { expect, it } from 'vitest';
// @ts-expect-error Electron and Node share this CommonJS module.
import { createSetupBinding, sameSetupGateway, setupNavigationUrl } from '../desktop/setup-navigation.cjs';

const time = 1_700_000_000_000;
const gateway = { state: 'ready', managed: true, mode: 'owner', setupPending: true, awaitingPublicOrigin: false, publicOrigin: 'https://gateway.example:8443', port: 3500, pid: 45, controllerPid: 46 };

it('opens only the exact saved HTTPS origin for the current setup generation', () => {
  const binding = createSetupBinding(gateway, time + 600_000, time);
  expect(sameSetupGateway(binding, gateway)).toBe(true);
  expect(setupNavigationUrl(binding, gateway, 'gateway.example:8443', time)).toBe('https://gateway.example:8443/');
  expect(setupNavigationUrl(binding, gateway, 'https://gateway.example:8443/', time)).toBe('https://gateway.example:8443/');
  expect(JSON.stringify(binding)).not.toMatch(/code|token|password/i);
  for (const input of ['https://other.example', 'http://gateway.example:8443', 'https://user:secret@' + 'gateway.example:8443', 'https://gateway.example:8443/path', 'https://gateway.example:8443/?code=secret', 'file:///secret', '', null]) {
    expect(() => setupNavigationUrl(binding, gateway, input, time)).toThrow();
  }
});

it('invalidates a setup target on expiry, pending state changes or a different managed instance', () => {
  const binding = createSetupBinding(gateway, time + 1000, time);
  expect(() => setupNavigationUrl(binding, gateway, gateway.publicOrigin, time + 1000)).toThrow(/过期/);
  for (const changed of [
    { state: 'stopped' }, { managed: false }, { mode: 'local' }, { setupPending: false }, { awaitingPublicOrigin: true },
    { publicOrigin: 'https://different.example' }, { port: 3501 }, { pid: 47 }, { controllerPid: 48 }
  ]) {
    expect(sameSetupGateway(binding, { ...gateway, ...changed })).toBe(false);
    expect(() => setupNavigationUrl(binding, { ...gateway, ...changed }, gateway.publicOrigin, time)).toThrow(/变化/);
  }
  for (const changed of [
    { publicOrigin: 'https://hajimink-setup.invalid' }, { publicOrigin: 'http://127.0.0.1:3500' }, { publicOrigin: 'https://user:secret@example.com' },
    { port: 80 }, { pid: 0 }, { controllerPid: null }, { setupPending: false }
  ]) expect(() => createSetupBinding({ ...gateway, ...changed }, time + 1000, time)).toThrow();
  expect(() => createSetupBinding(gateway, time, time)).toThrow();
  expect(() => createSetupBinding(gateway, time + 16 * 60_000, time)).toThrow();
});
