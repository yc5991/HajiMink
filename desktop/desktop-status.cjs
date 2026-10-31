'use strict';
// The gateway/controller pipe carries status only, never conversation content.
// Keep arbitrary exception text, paths and extra properties out of the UI/pipe.
const VERSION = /^\d{1,4}(?:\.\d{1,6}){1,4}$/;
const REASONS = new Set([
  '正在连接桌面应用',
  '正在检查桌面版本',
  'Codex 桌面连接已断开',
  '请在 Windows 上打开 Codex 桌面应用',
  '等待桌面工具桥就绪',
  '检测到多个桌面工具桥，请关闭多余实例后重试',
  '请先在桌面端建立一个本机会话',
  '桌面只读接口不完整，暂时无法连接'
]);
function normalizeDesktopStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { connected, compatible, accessMode, version } = value;
  if (typeof connected !== 'boolean' || typeof compatible !== 'boolean' || !['full', 'limited', 'read-only', 'blocked'].includes(accessMode)) return null;
  if (version !== null && (typeof version !== 'string' || !VERSION.test(version))) return null;
  if (connected && version === null) return null;
  if ((accessMode === 'full' || accessMode === 'limited') && (!connected || !compatible)) return null;
  if (accessMode === 'read-only' && (!connected || compatible)) return null;
  if (accessMode === 'blocked' && (connected || compatible)) return null;
  const reason = typeof value.reason === 'string' && (REASONS.has(value.reason) || (version !== null && value.reason === `桌面版本 ${version} 尚未通过兼容验证，暂时无法连接`)) ? value.reason : undefined;
  return { connected, compatible, accessMode, version, ...(reason ? { reason } : {}) };
}
module.exports = { normalizeDesktopStatus };
