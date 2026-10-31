'use strict';
// Detached Windows controller. The desktop sends a one-time bootstrap over an
// inherited pipe; the controller owns the gateway and a user-restricted pipe.
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { GatewayManager, readHealth } = require('./gateway-manager.cjs');
const { NatappManager } = require('./natapp-manager.cjs');
const { inspectNativeProcess } = require('./native-helper.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PIPE = /^hajimink-[0-9a-f]{32}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let manager, natapp, bridge, input, record, phase = 'bootstrap';
// Keep the controller alive even if its private transport fails unexpectedly.
setInterval(() => {}, 1000);
process.stdout.on('error', () => {});
function samePath(a, b) { return typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function replyParent(value) { try { process.stdout.end(`${JSON.stringify(value)}\n`); } catch {} }
function readBootstrap() {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      text += chunk;
      if (text.length > 16384) { process.stdin.destroy(); reject(new Error('bootstrap')); return; }
      const end = text.indexOf('\n');
      if (end < 0) return;
      process.stdin.destroy();
      try { resolve(JSON.parse(text.slice(0, end))); } catch { reject(new Error('bootstrap')); }
    });
    process.stdin.once('error', reject);
    process.stdin.once('end', () => reject(new Error('bootstrap')));
  });
}
function validate(value) {
  if (!value || value.version !== 1 || !UUID.test(value.instanceId) || !PIPE.test(value.pipeName) || !SECRET.test(value.secret)) throw new Error('bootstrap');
  for (const field of ['appRoot', 'dataDir', 'entryPath', 'nodePath', 'nativePath', 'controllerPath']) if (typeof value[field] !== 'string' || !path.isAbsolute(value[field])) throw new Error('bootstrap');
  if (!samePath(value.controllerPath, __filename) || !samePath(value.entryPath, path.join(value.appRoot, 'dist-server', 'index.js')) || !samePath(value.nativePath, path.join(path.dirname(__filename), 'PrivateControlPipe.exe'))) throw new Error('bootstrap');
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || typeof value.runAsNode !== 'boolean') throw new Error('bootstrap');
  return value;
}
async function updateRecord(value, controller) {
  const file = path.join(value.dataDir, 'controller.instance.json');
  const current = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const key of ['instanceId', 'pipeName', 'port']) if (current[key] !== value[key]) throw new Error('record');
  for (const key of ['dataDir', 'entryPath', 'nodePath', 'controllerPath']) if (!samePath(current[key], value[key])) throw new Error('record');
  record = { ...current, controllerPid: process.pid, controllerCreation: controller.creation };
  const tmp = `${file}.${value.instanceId}.tmp`;
  try { await fs.writeFile(tmp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
}
async function releaseRecord(value) {
  const file = path.join(value.dataDir, 'controller.instance.json');
  try {
    const current = JSON.parse(await fs.readFile(file, 'utf8'));
    if (current.instanceId !== value.instanceId) return;
    await fs.unlink(file);
    const secretFile = path.join(value.dataDir, 'controller-secrets', `${value.instanceId.toLowerCase()}.dpapi`);
    await fs.unlink(secretFile).catch(() => {});
  } catch {}
}
async function startBridge(value, controller, gateway) {
  let gatewayIdentity = null;
  if (gateway.pid) {
    phase = 'inspect-gateway';
    gatewayIdentity = await inspectNativeProcess(value.nativePath, gateway.pid, { kind: 'gateway', entry: value.entryPath, dataDir: value.dataDir });
    if (!samePath(gatewayIdentity.image, value.nodePath)) throw new Error('gateway identity');
  }
  const identity = { instanceId: value.instanceId, dataDir: path.resolve(value.dataDir), entryPath: path.resolve(value.entryPath), nodePath: path.resolve(value.nodePath), controllerPath: path.resolve(value.controllerPath), port: value.port, processId: process.pid, processCreation: controller.creation, gatewayPid: gatewayIdentity?.pid || null, gatewayCreation: gatewayIdentity?.creation || null };
  phase = 'bridge-spawn';
  bridge = spawn(value.nativePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  bridge.stdin.on('error', () => {});
  bridge.on('error', () => {});
  const lines = readline.createInterface({ input: bridge.stdout });
  let readyResolve, readyReject, stopping = false;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => readyReject(new Error('bridge timeout')), 10000);
  bridge.once('exit', () => { clearTimeout(timer); readyReject(new Error('bridge exited')); });
  lines.on('line', line => {
    if (line.length > 8192) return;
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message?.type === 'ready') { clearTimeout(timer); readyResolve(); return; }
    if (message?.type !== 'request' || !/^[0-9a-f]{32}$/.test(message.requestId) || !['status', 'stop', 'stop-keep-natapp', 'diagnose-stream', 'local-session', 'natapp-start', 'natapp-stop'].includes(message.action) || stopping) return;
    if (['stop', 'stop-keep-natapp'].includes(message.action)) stopping = true;
    void (async () => {
      let state = manager.snapshot(), tunnel;
      if (message.action === 'natapp-start') tunnel = await natapp.start();
      else if (message.action === 'natapp-stop' || message.action === 'stop') tunnel = await natapp.stop();
      else tunnel = await natapp.refresh();
      if (message.action === 'stop' && !['running', 'unconfirmed'].includes(tunnel.state)) state = await manager.stop();
      if (message.action === 'stop-keep-natapp' && tunnel.state === 'running' && tunnel.managed) state = await manager.stop();
      let ticket = null;
      if (message.action === 'diagnose-stream') ticket = await manager.streamTicket().catch(() => null);
      if (message.action === 'local-session') ticket = await manager.localSession().catch(() => null);
      const ok = ['status', 'natapp-start', 'natapp-stop'].includes(message.action) || (['diagnose-stream', 'local-session'].includes(message.action) ? !!ticket : (!state.managed && !manager.child));
      const response = { requestId: message.requestId, action: message.action, ok, gateway: state, natapp: tunnel, ...(ticket ? { ticket } : {}) };
      try { bridge.stdin.write(`${JSON.stringify(response)}\n`); } catch {}
      if (['stop', 'stop-keep-natapp'].includes(message.action) && ok) {
        await Promise.race([new Promise(resolve => bridge.once('exit', resolve)), delay(3000)]);
        await releaseRecord(value);
        process.exit(0);
      }
      stopping = false;
    })().catch(() => { stopping = false; });
  });
  bridge.stdin.write(`${JSON.stringify({ mode: 'bridge', pipeName: value.pipeName, secret: value.secret, identity: Buffer.from(JSON.stringify(identity)).toString('base64url'), parentPid: process.pid, parentCreation: controller.creation })}\n`);
  phase = 'bridge-ready';
  await ready;
  return { identity, gateway };
}
(async () => {
  input = validate(await readBootstrap());
  phase = 'inspect-controller';
  const self = await inspectNativeProcess(input.nativePath, process.pid, { kind: 'controller', entry: input.controllerPath });
  if (!samePath(self.image, input.nodePath)) throw new Error('controller identity');
  phase = 'record';
  await updateRecord(input, self);
  phase = 'gateway';
  manager = new GatewayManager({ appRoot: input.appRoot, dataDir: input.dataDir, entryPath: input.entryPath, nodePath: input.nodePath, runAsNode: input.runAsNode, port: input.port, startTimeoutMs: input.startTimeoutMs, stopTimeoutMs: input.stopTimeoutMs });
  natapp = new NatappManager({ dataDir: input.dataDir, nativePath: input.nativePath, verifyGateway: async () => {
    const before = manager.snapshot(), child = manager.child;
    if (before.state !== 'ready' || !before.managed || before.mode !== 'owner' || !child?.connected || child.pid !== before.pid || child.exitCode !== null || child.signalCode !== null) return false;
    const health = await readHealth(input.port, { mode: 'owner', publicOrigin: before.publicOrigin });
    const after = manager.snapshot();
    return !!health?.ok && health.mode === 'owner' && after.state === 'ready' && after.pid === before.pid && after.publicOrigin === before.publicOrigin && manager.child === child && child.connected && child.exitCode === null && child.signalCode === null;
  } });
  const priorTunnel = await natapp.refresh();
  if (['running', 'unconfirmed'].includes(priorTunnel.state)) {
    let config;
    try { config = JSON.parse(await fs.readFile(path.join(input.dataDir, 'config.json'), 'utf8')); } catch {}
    if (priorTunnel.state !== 'running' || config?.mode !== 'owner' || typeof config.publicOrigin !== 'string' || !config.publicOrigin.startsWith('https://')) throw new Error('tunnel protection unconfirmed');
  }
  const gateway = await manager.start();
  if (gateway.state !== 'ready' && !gateway.managed) throw new Error('gateway unavailable');
  phase = 'bridge';
  const started = await startBridge(input, self, gateway);
  replyParent({ type: 'ready', gateway: started.gateway, identity: started.identity });
})().catch(async () => {
  let state;
  if (manager) state = await manager.stop().catch(() => null);
  if (!state?.managed && !manager?.child && input) await releaseRecord(input);
  replyParent({ type: 'error', managed: !!state?.managed, phase });
  if (state?.managed || manager?.child) setInterval(() => {}, 1000);
  else setTimeout(() => process.exit(1), 100);
});
