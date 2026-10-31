import { describe, expect, it } from 'vitest';
// @ts-expect-error CommonJS is shared with the isolated Windows controller.
import { normalizeDesktopStatus } from '../desktop/desktop-status.cjs';
// @ts-expect-error The desktop managers are CommonJS entry points.
import { GatewayManager } from '../desktop/gateway-manager.cjs';
// @ts-expect-error The desktop managers are CommonJS entry points.
import { ControllerGatewayManager } from '../desktop/controller-manager.cjs';

const version = '26.1023.6123.0';
const readOnly = { connected: true, compatible: false, accessMode: 'read-only', version };
const limited = { connected: true, compatible: true, accessMode: 'limited', version };

describe('desktop connection status crossing the private controller boundary', () => {
  it('preserves verified full, read-only and offline states without unrelated fields', () => {
    expect(normalizeDesktopStatus({ ...limited, extra: 'private' })).toEqual(limited);
    expect(normalizeDesktopStatus({ ...readOnly, reason: `Codex ${version} 已连接，目前仅支持查看；发送、停止和审批等操作尚待验证，请在 Codex 中处理`, token: 'secret', thread: 'private' })).toEqual(readOnly);
    expect(normalizeDesktopStatus({ connected: true, compatible: true, accessMode: 'full', version: '26.1021.3705.0' })).toEqual({ connected: true, compatible: true, accessMode: 'full', version: '26.1021.3705.0' });
    expect(normalizeDesktopStatus({ connected: false, compatible: false, accessMode: 'blocked', version: null, reason: '请在 Windows 上打开 Codex 桌面应用' })).toEqual({ connected: false, compatible: false, accessMode: 'blocked', version: null, reason: '请在 Windows 上打开 Codex 桌面应用' });
    const reason = `桌面版本 ${version} 尚未通过兼容验证，暂时无法连接`;
    expect(normalizeDesktopStatus({ connected: false, compatible: false, accessMode: 'blocked', version, reason })).toEqual({ connected: false, compatible: false, accessMode: 'blocked', version, reason });
  });
  it('does not pass arbitrary exception messages or private paths to the desktop', () => {
    const blocked = { connected: false, compatible: false, accessMode: 'blocked', version };
    expect(normalizeDesktopStatus({ ...blocked, reason: 'C:\\Users\\private\\token.txt: secret', token: 'secret' })).toEqual(blocked);
    expect(normalizeDesktopStatus({ ...blocked, reason: `桌面版本 ${version} 尚未通过兼容验证，暂时无法连接\nsecret` })).toEqual(blocked);
  });
  it('rejects malformed or contradictory capabilities instead of advertising them', () => {
    for (const value of [
      null, [], {}, { ...readOnly, version: null }, { ...readOnly, version: '26.0\nsecret' },
      { ...readOnly, connected: 'yes' }, { ...readOnly, compatible: true },
      { ...readOnly, connected: false }, { ...readOnly, accessMode: 'full' }, { ...limited, connected: false }, { ...limited, compatible: false },
      { ...readOnly, accessMode: 'blocked' }, { ...readOnly, accessMode: 'future' },
      { ...readOnly, version: '9'.repeat(1000) },
    ]) expect(normalizeDesktopStatus(value)).toBeNull();
  });
  it('clears old desktop status when either owning gateway manager stops or fails', () => {
    for (const Manager of [GatewayManager, ControllerGatewayManager]) {
      const manager = new Manager({ appRoot: process.cwd(), dataDir: process.cwd(), port: 3000, platform: 'win32' });
      for (const status of ['starting', 'stopping', 'stopped', 'error']) {
        manager.emitState({ state: 'ready', managed: true, desktop: readOnly });
        expect(manager.snapshot().desktop).toEqual(readOnly);
        manager.emitState({ state: status, managed: false });
        expect(manager.snapshot().desktop).toBeNull();
      }
      manager.close();
    }
  });
});
