'use strict';
// A disposable authenticated bridge must survive a client disconnect after
// the controller has returned a complete, validated non-stop response.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const readline = require('node:readline');
const { randomBytes, randomUUID, createHmac } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { inspectNativeProcess } = require('../desktop/native-helper.cjs');
const { requestPrivateControl } = require('../desktop/private-control.cjs');
if (process.platform !== 'win32') throw new Error('Windows required');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-bridge-disconnect-'));
const binary = path.join(temp, 'PrivateControlPipe.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sign = (key, message) => createHmac('sha256', Buffer.from(key, 'base64url')).update(message).digest('base64url');
let bridge;
function deadline(promise, timeout, message) { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]).finally(() => clearTimeout(timer)); }
async function startBridge(heldAction) {
  const name = `hajimink-${randomBytes(16).toString('hex')}`, pipe = `\\\\.\\pipe\\${name}`, secret = randomBytes(32).toString('base64url');
  const parent = await inspectNativeProcess(binary, process.pid);
  const identity = { instanceId: randomUUID(), dataDir: path.join(temp, 'data'), entryPath: path.join(temp, 'gateway.js'), nodePath: process.execPath, port: 39215, processId: process.pid, processCreation: parent.creation, controllerPath: path.join(temp, 'controller.cjs') };
  const child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {}); let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text.slice(0, Math.max(0, 8192 - stderr.length)); }); child.on('error', () => {});
  let readyResolve, heldResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const held = new Promise(resolve => { heldResolve = resolve; });
  let holding = true;
  const lines = readline.createInterface({ input: child.stdout });
  function answer(message) { child.stdin.write(`${JSON.stringify({ requestId: message.requestId, action: message.action, ok: true })}\n`); }
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.type === 'ready') readyResolve();
    else if (message.type === 'request') {
      if (holding && message.action === heldAction) { holding = false; heldResolve(message); }
      else answer(message);
    }
  });
  child.stdin.write(`${JSON.stringify({ mode: 'bridge', pipeName: name, secret, identity: Buffer.from(JSON.stringify(identity)).toString('base64url'), parentPid: process.pid, parentCreation: parent.creation })}\n`);
  try { await deadline(ready, 10000, 'bridge did not become ready'); }
  catch (error) {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, delay(5000)]);
    }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    throw error;
  }
  return { child, lines, pipe, secret, identity, held, answer, stderr: () => stderr };
}
async function abortAfterCommand(instance, action, responseMode = 'valid') {
  const socket = net.createConnection(instance.pipe), nonce = randomBytes(32).toString('base64url');
  socket.on('error', () => {}); socket.setEncoding('utf8');
  await deadline(new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); }), 5000, 'connection timed out');
  const challenge = await deadline(new Promise((resolve, reject) => {
    let text = '';
    socket.on('data', function onData(chunk) { text += chunk; if (!text.includes('\n')) return; socket.off('data', onData); try { resolve(JSON.parse(text.slice(0, text.indexOf('\n')))); } catch (error) { reject(error); } });
    socket.write(`${JSON.stringify({ type: 'hello', nonce })}\n`);
  }), 5000, 'challenge timed out');
  assert.equal(challenge.proof, sign(instance.secret, `HajiMink|1|server|${nonce}|${challenge.nonce}|${challenge.identity}`));
  const proof = sign(instance.secret, `HajiMink|1|client|${nonce}|${challenge.nonce}|${action}`);
  socket.write(`${JSON.stringify({ type: 'command', action, proof })}\n`);
  const request = await deadline(instance.held, 5000, 'controller did not receive command');
  socket.destroy(); await delay(200);
  if (responseMode === 'invalid') instance.child.stdin.write(`${JSON.stringify({ requestId: '0'.repeat(32), action, ok: true })}\n`);
  else instance.answer(request);
}
(async () => {
  const csc = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const compiled = spawnSync(csc, ['/nologo', '/optimize+', '/target:exe', '/reference:System.Web.Extensions.dll', '/reference:System.Security.dll', '/reference:System.Management.dll', `/out:${binary}`, path.join(root, 'desktop', 'native', 'PrivateControlPipe.cs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stdout || compiled.stderr);
  bridge = await startBridge('status');
  await abortAfterCommand(bridge, 'status');
  await delay(500);
  assert.equal(bridge.child.exitCode, null, `completed status after a client disconnect must not kill the bridge: ${bridge.stderr()}`);
  assert.equal((await requestPrivateControl(bridge.pipe, bridge.secret, bridge.identity, 'status', 6000)).result.ok, true);
  const exiting = new Promise(resolve => bridge.child.once('exit', resolve));
  await requestPrivateControl(bridge.pipe, bridge.secret, bridge.identity, 'stop', 6000);
  assert.equal(await deadline(exiting, 6000, 'bridge did not stop'), 0);
  bridge.lines.close(); bridge = null;

  bridge = await startBridge('stop');
  const stopExit = new Promise(resolve => bridge.child.once('exit', resolve));
  await abortAfterCommand(bridge, 'stop');
  assert.equal(await deadline(stopExit, 6000, 'completed stop must close its bridge even after client disconnect'), 0);
  bridge.lines.close(); bridge = null;

  bridge = await startBridge('status');
  const invalidExit = new Promise(resolve => bridge.child.once('exit', resolve));
  await abortAfterCommand(bridge, 'status', 'invalid');
  assert.notEqual(await deadline(invalidExit, 6000, 'invalid controller response must close the bridge'), 0);
  bridge.lines.close(); bridge = null;
  console.log('PASS bridge recovery after authenticated client disconnect, completed stop and fail-closed invalid response');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (bridge) {
    bridge.lines.close();
    // This handle belongs to the helper spawned by this isolated test.
    if (bridge.child.exitCode === null && bridge.child.signalCode === null) {
      const exited = new Promise(resolve => bridge.child.once('exit', resolve));
      bridge.child.kill();
      await Promise.race([exited, delay(5000)]);
    }
    bridge.child.stdin.destroy(); bridge.child.stdout.destroy(); bridge.child.stderr.destroy();
  }
  const actual = fs.realpathSync(temp), base = fs.realpathSync(os.tmpdir());
  if (path.dirname(actual).toLowerCase() !== base.toLowerCase() || !path.basename(actual).startsWith('hajimink-bridge-disconnect-')) throw new Error('Unexpected fixture directory');
  try { fs.rmSync(actual, { recursive: true, force: true }); } catch { console.error('Test fixture retained:', temp); process.exitCode = 1; }
});
