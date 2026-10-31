import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildApp } from './app.js';
import type { GatewayConfig } from './security.js';
// @ts-expect-error Shared with the Electron controller as a CommonJS module.
import { normalizeDesktopStatus } from '../desktop/desktop-status.cjs';
const { values } = parseArgs({ options: { config: { type: 'string' }, 'data-dir': { type: 'string' } } });
const dataDir = values['data-dir'] || process.env.AGENT_CONTROL_DATA_DIR || path.resolve('.local/runtime');
const configPath = values.config || process.env.AGENT_CONTROL_CONFIG || path.join(dataDir, 'config.json');
const saved = values.config || fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
const config: GatewayConfig = { mode: 'local', port: 3000, publicOrigin: 'http://localhost:3000', ...saved, dataDir, ...(process.env.AGENT_CONTROL_PORT ? { port: Number(process.env.AGENT_CONTROL_PORT) } : {}) };
let closing = false;
let closeApp: (() => Promise<unknown>) | undefined;
function shutdown() {
  if (closing) return;
  closing = true;
  if (!closeApp) { process.exit(0); return; }
  void closeApp().then(() => process.exit(0), () => process.exit(1));
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
if (process.send) process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'hajimink:gateway-stop') shutdown(); });
const { app, adapter, registry, streamDiagnostic, ownerAuth } = await buildApp(config);
if (process.send) process.on('message', message => {
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'hajimink:local-session' || !('requestId' in message) || typeof message.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(message.requestId) || config.mode !== 'owner' || !process.send || !process.connected) return;
  try { process.send({ type: 'hajimink:local-session-result', requestId: message.requestId, ...ownerAuth.issueSession() }, () => {}); } catch {}
});
// Ticket requests arrive only through the IPC channel of this exact child.
if (process.send) process.on('message', message => {
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'hajimink:stream-diagnostic' || !('requestId' in message) || typeof message.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(message.requestId) || config.mode !== 'owner' || !process.send || !process.connected) return;
  try { process.send({ type: 'hajimink:stream-diagnostic-result', requestId: message.requestId, ...streamDiagnostic.issue() }, () => {}); } catch {}
});
// Only the owning controller receives this status over the existing child IPC.
// In particular, owner-mode status must not be exposed through an anonymous HTTP route.
function publishDesktopStatus() {
  if (!process.send || !process.connected) return;
  const desktop = normalizeDesktopStatus(adapter.status);
  try { process.send({ type: 'hajimink:desktop-status', desktop }, () => {}); } catch {}
}
if (process.send) adapter.on('desktop', publishDesktopStatus);
closeApp = () => app.close();
await registry.start();
await app.listen({ host: '127.0.0.1', port: config.port });
if (process.send && process.connected) {
  try { process.send({ type: 'hajimink:gateway-ready', port: config.port, mode: config.mode, streamDiagnostic: config.mode === 'owner' }, () => {}); } catch {}
  publishDesktopStatus();
}
console.log(`Agent Control 已启动：http://127.0.0.1:${config.port}（${config.mode} 模式）`);
if (!adapter.status.connected) console.log(`桌面连接：${adapter.status.reason}`);
