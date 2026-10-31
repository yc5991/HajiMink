'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const readline = require('node:readline');
const { randomBytes, randomUUID, createHmac } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { requestPrivateControl } = require('../desktop/private-control.cjs');
const { sealControlSecret, openControlSecret } = require('../desktop/protected-credential.cjs');
if (process.platform !== 'win32') throw new Error('此测试需要 Windows');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimink-private-pipe-'));
const csc = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const binary = path.join(temp, 'PrivateControlPipe.exe');
let child, fake, pipe, secret, identity;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitExit = (proc, timeout = 10000) => Promise.race([new Promise(resolve => { if (proc.exitCode !== null) resolve(proc.exitCode); else proc.once('exit', resolve); }), delay(timeout).then(() => { throw new Error('测试进程退出超时'); })]);
function nextLine(stream, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const reader = readline.createInterface({ input: stream });
    const timer = setTimeout(() => { reader.close(); reject(new Error('测试服务未就绪')); }, timeout);
    reader.once('line', value => { clearTimeout(timer); reader.close(); resolve(value); });
    reader.once('close', () => { clearTimeout(timer); });
  });
}
function wireName(name) { return `\\\\.\\pipe\\${name}`; }
function sendRaw(pipe, makePayload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe); let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('测试消息超时')); }, 6000);
    socket.on('connect', () => socket.write(makePayload()));
    socket.on('data', chunk => { data += chunk.toString(); if (data.includes('\n')) { socket.destroy(); clearTimeout(timer); resolve(data); } });
    socket.on('close', () => { clearTimeout(timer); resolve(data); });
    socket.on('error', error => { clearTimeout(timer); if (['EPIPE', 'ECONNRESET'].includes(error.code)) resolve(data); else reject(error); });
  });
}
(async () => {
  const compile = spawnSync(csc, ['/nologo', '/optimize+', '/target:exe', '/reference:System.Web.Extensions.dll', '/reference:System.Security.dll', '/reference:System.Management.dll', `/out:${binary}`, path.join(root, 'desktop', 'native', 'PrivateControlPipe.cs')], { encoding: 'utf8', windowsHide: true });
  if (compile.status !== 0) throw new Error(`测试控制通道编译失败：${compile.stdout || compile.stderr}`);
  const key = randomBytes(32).toString('base64url'), context = `fixture:${randomUUID()}`;
  const runKeyOperation = input => new Promise((resolve, reject) => {
    const proc = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); let output = '';
    proc.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 8192) proc.stdout.destroy(); });
    proc.once('error', reject); proc.once('close', code => resolve({ code, output }));
    proc.stdin.on('error', () => {}); proc.stdin.end(`${JSON.stringify(input)}\n`);
  });
  const sealed = await runKeyOperation({ mode: 'seal', context, value: key });
  assert.equal(sealed.code, 0); assert.equal(sealed.output.includes(key), false);
  const sealedValue = JSON.parse(sealed.output).value;
  const reopened = await runKeyOperation({ mode: 'open', context, value: sealedValue });
  assert.equal(reopened.code, 0); assert.equal(JSON.parse(reopened.output).value, key);
  assert.notEqual((await runKeyOperation({ mode: 'open', context: `${context}-wrong`, value: sealedValue })).code, 0, 'credential context must be bound');
  const changed = Buffer.from(sealedValue, 'base64url'); changed[changed.length - 1] ^= 1;
  assert.notEqual((await runKeyOperation({ mode: 'open', context, value: changed.toString('base64url') })).code, 0, 'tampered protected credential must fail');

  const protectedDataDir = path.join(temp, 'protected-data'); fs.mkdirSync(protectedDataDir);
  const protectedId = randomUUID(), protectedKey = randomBytes(32).toString('base64url');
  const sealedPath = await sealControlSecret(binary, protectedDataDir, protectedId, protectedKey);
  assert.equal(fs.readFileSync(sealedPath, 'utf8').includes(protectedKey), false);
  assert.equal(await openControlSecret(binary, protectedDataDir, protectedId), protectedKey);
  await assert.rejects(sealControlSecret(binary, protectedDataDir, protectedId, randomBytes(32).toString('base64url')), /EEXIST/);
  assert.equal(await openControlSecret(binary, protectedDataDir, protectedId), protectedKey, 'duplicate creation must not overwrite the stored key');
  const secondId = randomUUID();
  fs.copyFileSync(sealedPath, path.join(protectedDataDir, 'controller-secrets', `${secondId}.dpapi`));
  await assert.rejects(openControlSecret(binary, protectedDataDir, secondId), /保护操作失败/, 'a credential copied to a different instance must fail');

  const name = `hajimink-${randomBytes(16).toString('hex')}`;
  pipe = wireName(name); secret = randomBytes(32).toString('base64url');
  identity = { instanceId: randomUUID(), dataDir: path.join(temp, 'data'), entryPath: path.join(temp, 'gateway', 'index.js'), nodePath: path.join(temp, 'runtime', 'node.exe'), port: 39215, processId: process.pid, processCreation: '134000000000000000', controllerPath: path.join(temp, 'controller', 'gateway-controller.cjs') };
  const boot = { pipeName: name, secret, identity: Buffer.from(JSON.stringify(identity)).toString('base64url') };
  child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const readyLine = nextLine(child.stdout); child.stdin.end(`${JSON.stringify(boot)}\n`);
  const ready = JSON.parse(await readyLine);
  assert.equal(ready.type, 'ready'); assert.equal(ready.remoteRejected, true);
  assert.match(ready.sid, /^S-1-\d(?:-\d+)+$/);
  assert.equal((ready.dacl.match(/\(/g) || []).length, 1, 'pipe DACL must contain exactly one allow entry');
  // Windows can serialize the current account as an SDDL alias such as LA.
  // Resolve it with Windows before comparing the actual SID, not its display text.
  const resolveDaclSid = dacl => {
    const script = '$s=[Console]::In.ReadToEnd(); $a=([System.Security.AccessControl.RawSecurityDescriptor]::new($s)).DiscretionaryAcl; if ($a.Count -ne 1 -or $a[0].AceType -ne [System.Security.AccessControl.AceType]::AccessAllowed) { exit 1 }; [Console]::Out.Write($a[0].SecurityIdentifier.Value)';
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: dacl, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.status !== 0 || result.error) throw new Error('无法解析安全通道权限');
    return result.stdout.trim();
  };
  assert.equal(resolveDaclSid('D:P(A;;FA;;;SY)'), 'S-1-5-18', 'well-known SDDL aliases must resolve to their SID');
  assert.match(resolveDaclSid('D:P(A;;FA;;;LA)'), /-500$/, 'local administrator SDDL alias must resolve to its SID');
  const allowedSid = resolveDaclSid(ready.dacl);
  assert.equal(allowedSid, ready.sid, 'pipe DACL must grant only the current user');
  assert.ok(!['S-1-1-0', 'S-1-5-7', 'S-1-5-11', 'S-1-5-32-545'].includes(allowedSid), 'pipe DACL must not grant access to broad groups');
  const status = await requestPrivateControl(pipe, secret, identity, 'status');
  assert.equal(status.result.ok, true); assert.equal(status.identity.instanceId, identity.instanceId);
  await assert.rejects(requestPrivateControl(pipe, randomBytes(32).toString('base64url'), identity, 'stop'), /身份校验失败/);
  for (const mismatch of [
    { instanceId: randomUUID() }, { port: identity.port + 1 }, { processId: identity.processId + 1 }, { processCreation: '134000000000000001' }, { controllerPath: path.join(temp, 'other-controller.cjs') },
    { dataDir: path.join(temp, 'other') }, { entryPath: path.join(temp, 'other-entry.js') }, { nodePath: path.join(temp, 'other-node.exe') }
  ]) await assert.rejects(requestPrivateControl(pipe, secret, { ...identity, ...mismatch }, 'stop'), /实例信息不匹配/);
  assert.equal((await requestPrivateControl(pipe, secret, identity, 'status')).result.ok, true, 'failed authentication must not stop the server');

  // Captured commands cannot be replayed against a fresh server nonce.
  const clientNonce = randomBytes(32).toString('base64url');
  const firstChallenge = JSON.parse((await sendRaw(pipe, () => `${JSON.stringify({ type: 'hello', nonce: clientNonce })}\n`)).trim());
  const replayProof = createHmac('sha256', Buffer.from(secret, 'base64url')).update(`HajiMink|1|client|${clientNonce}|${firstChallenge.nonce}|stop`).digest('base64url');
  await delay(100);
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe); let response = '', stage = 0;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('重放测试超时')); }, 5000);
    socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'hello', nonce: clientNonce })}\n`));
    socket.on('data', chunk => {
      response += chunk.toString();
      if (stage === 0 && response.includes('\n')) {
        const challenge = JSON.parse(response.slice(0, response.indexOf('\n'))); response = ''; stage = 1;
        assert.notEqual(challenge.nonce, firstChallenge.nonce);
        socket.write(`${JSON.stringify({ type: 'command', action: 'stop', proof: replayProof })}\n`);
      }
    });
    socket.on('close', () => { clearTimeout(timer); if (response) reject(new Error('重放请求意外获得响应')); else resolve(); });
    socket.on('error', error => { if (!['EPIPE', 'ECONNRESET'].includes(error.code)) { clearTimeout(timer); reject(error); } });
  });
  assert.equal((await requestPrivateControl(pipe, secret, identity, 'status')).result.ok, true, 'a replayed stop command must be rejected');

  // A second instance cannot squat on the same pipe name.
  const duplicate = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  duplicate.stdin.end(`${JSON.stringify(boot)}\n`);
  assert.notEqual(await waitExit(duplicate), 0, 'a duplicate pipe instance must be rejected');

  // An untrusted server never receives the secret or a client command.
  const fakeName = `hajimink-${randomBytes(16).toString('hex')}`, fakePipe = wireName(fakeName);
  let captured = '';
  fake = net.createServer(socket => { socket.on('data', data => { captured += data.toString(); if (captured.includes('\n')) socket.write(`${JSON.stringify({ type: 'challenge', nonce: randomBytes(32).toString('base64url'), identity: boot.identity, proof: randomBytes(32).toString('base64url') })}\n`); }); });
  await new Promise((resolve, reject) => { fake.once('error', reject); fake.listen(fakePipe, resolve); });
  await assert.rejects(requestPrivateControl(fakePipe, secret, identity, 'stop'), /身份校验失败/);
  await delay(100);
  assert.equal(captured.includes(secret), false); assert.equal(captured.includes('command'), false);
  await new Promise(resolve => fake.close(resolve)); fake = undefined;

  // A peer that slowly trickles bytes cannot extend the overall deadline.
  const slowName = `hajimink-${randomBytes(16).toString('hex')}`, slowPipe = wireName(slowName);
  fake = net.createServer(socket => {
    let interval;
    socket.once('data', () => { interval = setInterval(() => { if (!socket.destroyed) socket.write('x'); }, 100); });
    socket.on('close', () => clearInterval(interval)); socket.on('error', () => clearInterval(interval));
  });
  await new Promise((resolve, reject) => { fake.once('error', reject); fake.listen(slowPipe, resolve); });
  const deadlineStart = Date.now();
  await assert.rejects(requestPrivateControl(slowPipe, secret, identity, 'status', 900));
  assert.ok(Date.now() - deadlineStart < 2500, 'the request must have an absolute deadline');
  await new Promise(resolve => fake.close(resolve)); fake = undefined;

  // Oversized and incomplete frames must be isolated to that connection.
  await sendRaw(pipe, () => `${'x'.repeat(8200)}\n`);
  assert.equal((await requestPrivateControl(pipe, secret, identity, 'status')).result.ok, true);
  const idle = net.createConnection(pipe); await new Promise((resolve, reject) => { idle.once('connect', resolve); idle.once('error', reject); });
  await delay(3800); idle.destroy();
  assert.equal((await requestPrivateControl(pipe, secret, identity, 'status', 8000)).result.ok, true, 'idle client must not permanently block the pipe');

  const stopped = await requestPrivateControl(pipe, secret, identity, 'stop'); assert.equal(stopped.result.ok, true);
  assert.equal(await waitExit(child), 0); child = undefined;
  console.log('PASS Windows private control prototype: DPAPI-protected credential persistence and user/context binding, single-user DACL, local-only pipe flag, first-instance protection, mutual challenge authentication, identity/path checks, no plaintext secret to a fake server, denied and replayed stops, bounded frames, absolute deadlines and idle recovery');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (fake) await new Promise(resolve => fake.close(resolve));
  if (child && child.exitCode === null && pipe && secret && identity) {
    try { await requestPrivateControl(pipe, secret, identity, 'stop', 8000); await waitExit(child, 10000); } catch {}
  }
  if (child && child.exitCode === null) {
    console.error('测试进程仍在运行；保留临时目录以便安全检查：', temp);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
    process.exitCode = 1;
    return;
  }
  const resolved = fs.realpathSync(temp), safeRoot = fs.realpathSync(os.tmpdir());
  if (!resolved.startsWith(safeRoot + path.sep) || !path.basename(resolved).startsWith('hajimink-private-pipe-')) throw new Error('Unexpected test directory');
  fs.rmSync(resolved, { recursive: true, force: true });
});
