'use strict';
// The real CLI is started with an empty, disposable home and no prompt is sent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const stage = process.env.HAJIMINK_CLI_RUNTIME || path.join(root, '.local', 'hajimink-stage');
const helper = path.join(stage, 'dist-server', 'cli-pty-worker.cjs');
const executable = process.env.HAJIMINK_CLI_BINARY || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-cli-pty-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let worker, workerExited = true, cliPid = 0;
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitFor(predicate, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await delay(50); }
  throw new Error('Timed out waiting for the isolated CLI process');
}
async function exercise(action) {
  let output = '', started = false, reportedExit = false;
  const home = path.join(temp, action); fs.mkdirSync(path.join(home, 'codex-home'), { recursive: true });
  workerExited = false; cliPid = 0;
  worker = fork(helper, [], {
    cwd: temp, windowsHide: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, CODEX_HOME: path.join(home, 'codex-home'), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home }
  });
  worker.on('message', message => {
    if (message.type === 'started') { started = true; cliPid = message.pid; }
    if (message.type === 'output') output += message.data;
    if (message.type === 'exit') reportedExit = true;
  });
  worker.on('exit', () => { workerExited = true; });
  worker.send({ type: 'start', file: executable, args: [], cwd: temp, cols: 100, rows: 30 });
  await waitFor(() => started && output.length > 0, 12000);
  await delay(2000);
  assert.ok(cliPid > 0 && alive(cliPid), `interactive CLI must still be running before input (pid=${cliPid}, exited=${workerExited}, output=${JSON.stringify(output.slice(-3000))})`);
  const visibleOutput = output.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  assert.match(visibleOutput, /codex|sign.?in|log.?in|chatgpt/i, 'interactive CLI must render a startup or login screen');
  worker.send(action === 'input' ? { type: 'input', data: '\x03' } : { type: 'stop' });
  if (action === 'input') await waitFor(() => reportedExit, 10000);
  await waitFor(() => workerExited, 10000);
  await waitFor(() => !alive(cliPid), 5000);
}
(async () => {
  assert.ok(fs.existsSync(helper), 'Build the isolated desktop fixture first');
  assert.ok(fs.existsSync(executable), 'Codex CLI executable is not installed at the tested path');
  await exercise('input');
  await exercise('stop');
  console.log('PASS real Codex CLI: isolated home, native PTY startup, Ctrl+C, forced stop and worker exit; no login or prompt');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (worker && !workerExited) {
    if (worker.connected) worker.send({ type: 'stop' });
    try { await waitFor(() => workerExited, 7500); } catch { worker.kill(); }
  }
  const resolved = fs.realpathSync(temp), safeRoot = fs.realpathSync(os.tmpdir());
  if (!resolved.startsWith(safeRoot + path.sep) || !path.basename(resolved).startsWith('hajimink-cli-pty-')) throw new Error('Unexpected test directory');
  if (workerExited && (!cliPid || !alive(cliPid))) fs.rmSync(resolved, { recursive: true, force: true });
  else { console.error(`CLI exit not confirmed; retained isolated test directory: ${resolved}`); process.exitCode = 1; }
});
