'use strict';
// Authenticated Windows local named-pipe transport shared by the desktop and controller.
const net = require('node:net');
const path = require('node:path');
const { randomBytes, createHmac, timingSafeEqual } = require('node:crypto');
const MAX_FRAME = 8192;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const PIPE = /^\\\\\.\\pipe\\hajimink-[0-9a-f]{32}$/;
const b64 = value => Buffer.from(value).toString('base64url');
const sign = (secret, text) => createHmac('sha256', secret).update(text, 'utf8').digest('base64url');
const nonce = () => randomBytes(32).toString('base64url');
function equal(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8'), b = Buffer.from(right, 'utf8');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
function decodeJson(value) {
  if (typeof value !== 'string' || value.length > MAX_FRAME || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('控制通道消息无效');
  const bytes = Buffer.from(value, 'base64url');
  if (b64(bytes) !== value) throw new Error('控制通道消息无效');
  let decoded;
  try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('控制通道消息无效'); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('控制通道消息无效');
  return decoded;
}
function normalized(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('控制通道身份无效');
  const result = path.resolve(value);
  return process.platform === 'win32' ? result.toLowerCase() : result;
}
function verifyIdentity(actual, expected) {
  if (!expected || !actual || typeof actual !== 'object') return false;
  if (typeof expected.instanceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(expected.instanceId) || actual.instanceId !== expected.instanceId) return false;
  if (!Number.isInteger(expected.port) || expected.port < 1024 || expected.port > 65535 || actual.port !== expected.port) return false;
  for (const key of ['dataDir', 'entryPath', 'nodePath']) {
    try { if (normalized(actual[key]) !== normalized(expected[key])) return false; } catch { return false; }
  }
  if (expected.processId !== undefined && (!Number.isSafeInteger(expected.processId) || actual.processId !== expected.processId)) return false;
  if (expected.processCreation !== undefined && (typeof expected.processCreation !== 'string' || actual.processCreation !== expected.processCreation)) return false;
  if (expected.controllerPath !== undefined) { try { if (normalized(actual.controllerPath) !== normalized(expected.controllerPath)) return false; } catch { return false; } }
  return true;
}
class Frames {
  constructor(socket) {
    this.socket = socket; this.buffer = ''; this.lines = []; this.waiter = null; this.error = null;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      this.buffer += chunk;
      if (this.buffer.length > MAX_FRAME * 2) return this.fail();
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        if (index > MAX_FRAME || this.lines.length >= 4) return this.fail();
        this.lines.push(this.buffer.slice(0, index)); this.buffer = this.buffer.slice(index + 1);
      }
      if (this.buffer.length > MAX_FRAME) return this.fail();
      this.wake();
    });
    socket.on('error', () => this.fail());
    socket.on('end', () => this.fail());
    socket.on('close', () => this.fail());
    socket.on('timeout', () => this.fail());
  }
  fail() { if (!this.error) this.error = new Error('本机控制通道不可用'); this.socket.destroy(); this.wake(); }
  wake() { if (!this.waiter) return; if (!this.lines.length && !this.error) return; const { resolve, reject } = this.waiter; this.waiter = null; if (this.lines.length) resolve(this.lines.shift()); else reject(this.error); }
  read() { if (this.lines.length) return Promise.resolve(this.lines.shift()); if (this.error) return Promise.reject(this.error); return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; }); }
  async message() { const line = await this.read(); let value; try { value = JSON.parse(line); } catch { throw new Error('控制通道消息无效'); } if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('控制通道消息无效'); return value; }
  write(value) { const text = `${JSON.stringify(value)}\n`; if (Buffer.byteLength(text) > MAX_FRAME) throw new Error('控制通道消息过大'); this.socket.write(text); }
  async flush(value) { const text = `${JSON.stringify(value)}\n`; if (Buffer.byteLength(text) > MAX_FRAME) throw new Error('控制通道消息过大'); await new Promise((resolve, reject) => this.socket.write(text, error => error ? reject(error) : resolve())); }
}
async function requestPrivateControl(pipeName, secretText, expected, action, timeoutMs = 5000) {
  if (process.platform !== 'win32' || typeof pipeName !== 'string' || !PIPE.test(pipeName)) throw new Error('本机控制通道地址无效');
  if (typeof secretText !== 'string' || !NONCE.test(secretText) || b64(Buffer.from(secretText, 'base64url')) !== secretText) throw new Error('本机控制凭据无效');
  if (!['status', 'stop', 'stop-keep-natapp', 'diagnose-stream', 'local-session', 'natapp-start', 'natapp-stop'].includes(action)) throw new Error('本机控制操作无效');
  const secret = Buffer.from(secretText, 'base64url');
  const socket = net.createConnection(pipeName);
  const frames = new Frames(socket);
  socket.setTimeout(timeoutMs);
  const deadline = setTimeout(() => socket.destroy(new Error('本机控制通道超时')), timeoutMs);
  let phase = 'connect';
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
      socket.once('timeout', () => reject(new Error('本机控制通道超时')));
      socket.once('close', () => reject(new Error('本机控制通道不可用')));
    });
    phase = 'challenge';
    const clientNonce = nonce();
    frames.write({ type: 'hello', nonce: clientNonce });
    const challenge = await frames.message();
    if (challenge.type !== 'challenge' || typeof challenge.nonce !== 'string' || !NONCE.test(challenge.nonce) || typeof challenge.identity !== 'string') throw new Error('本机控制通道身份无效');
    const expectedServer = sign(secret, `HajiMink|1|server|${clientNonce}|${challenge.nonce}|${challenge.identity}`);
    if (!equal(challenge.proof, expectedServer)) throw new Error('本机控制通道身份校验失败');
    const identity = decodeJson(challenge.identity);
    if (!verifyIdentity(identity, expected)) throw new Error('本机网关实例信息不匹配');
    const clientProof = sign(secret, `HajiMink|1|client|${clientNonce}|${challenge.nonce}|${action}`);
    frames.write({ type: 'command', action, proof: clientProof });
    phase = 'result';
    const result = await frames.message();
    const expectedResult = sign(secret, `HajiMink|1|result|${clientNonce}|${challenge.nonce}|${action}|${result.data}`);
    if (result.type !== 'result' || !equal(result.proof, expectedResult)) throw new Error('本机控制通道结果校验失败');
    const data = decodeJson(result.data);
    const ackProof = sign(secret, `HajiMink|1|ack|${clientNonce}|${challenge.nonce}|${action}|${result.data}`);
    await frames.flush({ type: 'ack', proof: ackProof }).catch(() => {});
    if (data.ok !== true || data.action !== action) throw new Error('本机控制操作未完成');
    return { identity, result: data };
  } catch (error) { if (error && typeof error === 'object') error.phase = phase; throw error; } finally { clearTimeout(deadline); socket.destroy(); secret.fill(0); }
}
module.exports = { requestPrivateControl };
