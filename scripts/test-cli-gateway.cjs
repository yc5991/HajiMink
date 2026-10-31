'use strict';
// Runs the built gateway and real CLI with disposable data; no login or Agent prompt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const WebSocket = require('ws');
const root = path.resolve(__dirname, '..');
const stage = process.env.HAJIMINK_CLI_RUNTIME || path.join(root, '.local', 'hajimink-stage');
const runtime = path.join(stage, 'runtime', 'node.exe');
const entry = path.join(stage, 'dist-server', 'index.js');
const executable = process.env.HAJIMINK_CLI_BINARY || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-cli-gateway-'));
const home = path.join(temp, 'home'); fs.mkdirSync(path.join(home, 'codex-home'), { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, exited = false, socket;
async function waitFor(predicate, timeout, message) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await delay(50); }
  throw new Error(message);
}
const { freePort } = require('./test-network.cjs');
(async () => {
  for (const file of [runtime, entry, executable]) assert.ok(fs.existsSync(file), `Missing test dependency: ${file}`);
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  let ready = false;
  child = fork(entry, ['--data-dir', path.join(temp, 'gateway')], {
    execPath: runtime, cwd: stage, windowsHide: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, AGENT_CONTROL_PORT: String(port), CODEX_HOME: path.join(home, 'codex-home'), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH || ''}` }
  });
  child.on('message', message => { if (message?.type === 'hajimink:gateway-ready') ready = true; });
  child.on('exit', () => { exited = true; });
  await waitFor(() => ready || exited, 25000, 'Isolated gateway did not start');
  assert.ok(ready && !exited, 'Isolated gateway exited before startup');
  const session = await fetch(`${origin}/api/session`);
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  let started = false, output = '', finished = false, closed = false, failure = '';
  socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/cli`, { headers: { origin, cookie } });
  socket.on('open', () => socket.send(JSON.stringify({ type: 'start', cols: 100, rows: 30 })));
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type === 'started') started = true;
    if (message.type === 'output') output += message.data;
    if (message.type === 'exit') finished = true;
    if (message.type === 'error') failure = message.message;
  });
  socket.on('close', () => { closed = true; });
  await waitFor(() => failure || finished || (started && output.length > 0), 15000, 'CLI did not start through the gateway');
  assert.equal(failure, ''); assert.ok(started && !finished, 'CLI ended before interaction');
  await delay(2000);
  const visible = output.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  assert.match(visible, /codex|sign.?in|log.?in|chatgpt/i);
  socket.send(JSON.stringify({ type: 'input', data: '\x03' }));
  await waitFor(() => finished && closed, 10000, 'CLI did not exit after Ctrl+C');
  child.send({ type: 'hajimink:gateway-stop' });
  await waitFor(() => exited, 10000, 'Isolated gateway did not stop');
  console.log('PASS built gateway: authenticated WebSocket to real isolated Codex CLI, output, Ctrl+C, terminal and gateway shutdown');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  socket?.terminate();
  if (child && !exited) {
    if (child.connected) child.send({ type: 'hajimink:gateway-stop' });
    try { await waitFor(() => exited, 10000, 'Gateway cleanup timed out'); } catch { child.kill(); }
  }
  const resolved = fs.realpathSync(temp), safeRoot = fs.realpathSync(os.tmpdir());
  if (!resolved.startsWith(safeRoot + path.sep) || !path.basename(resolved).startsWith('hajimink-cli-gateway-')) throw new Error('Unexpected test directory');
  if (exited) fs.rmSync(resolved, { recursive: true, force: true });
  else { console.error(`Gateway exit not confirmed; retained isolated test directory: ${resolved}`); process.exitCode = 1; }
});
