'use strict';
// Windows-only DPAPI wrapper for per-instance controller secrets. The helper
// communicates over inherited stdio; plaintext is never passed as an argument.
const fs = require('node:fs/promises');
const path = require('node:path');
const { invokeNativeHelper } = require('./native-helper.cjs');
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{43}$/;
function validKey(value) {
  return typeof value === 'string' && KEY.test(value) && Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value;
}
function context(dataDir, instanceId) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || !ID.test(instanceId)) throw new Error('本机控制凭据的实例信息无效');
  const normalized = path.resolve(dataDir);
  return `${process.platform === 'win32' ? normalized.toLowerCase() : normalized}|${instanceId.toLowerCase()}`;
}
async function runHelper(executable, input, expectedType) {
  let result;
  try { result = await invokeNativeHelper(executable, input, expectedType); }
  catch { throw new Error('本机控制凭据保护操作失败'); }
  if (typeof result.value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(result.value) || result.value.length > 4096) throw new Error('本机控制凭据保护结果无效');
  return result.value;
}
async function secretPath(dataDir, instanceId, create = false) {
  context(dataDir, instanceId);
  const root = await fs.realpath(path.resolve(dataDir));
  const folder = path.join(root, 'controller-secrets');
  if (create) await fs.mkdir(folder, { recursive: true });
  const actual = await fs.realpath(folder);
  const compare = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (!compare(actual).startsWith(compare(root + path.sep))) throw new Error('本机控制凭据目录无效');
  return path.join(actual, `${instanceId.toLowerCase()}.dpapi`);
}
async function sealControlSecret(executable, dataDir, instanceId, key) {
  if (!validKey(key)) throw new Error('本机控制凭据无效');
  const file = await secretPath(dataDir, instanceId, true);
  const protectedValue = await runHelper(executable, { mode: 'seal', context: context(dataDir, instanceId), value: key }, 'sealed');
  await fs.writeFile(file, `${protectedValue}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return file;
}
async function openControlSecret(executable, dataDir, instanceId) {
  const file = await secretPath(dataDir, instanceId);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 4096) throw new Error('本机控制凭据文件无效');
  const protectedValue = (await fs.readFile(file, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(protectedValue)) throw new Error('本机控制凭据文件无效');
  const key = await runHelper(executable, { mode: 'open', context: context(dataDir, instanceId), value: protectedValue }, 'opened');
  if (!validKey(key)) throw new Error('本机控制凭据无效');
  return key;
}
module.exports = { sealControlSecret, openControlSecret };
