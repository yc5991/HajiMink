'use strict';
// The request travels over inherited stdin; helper output is bounded and never logged.
const path = require('node:path');
const { spawn } = require('node:child_process');
function invokeNativeHelper(executable, input, expectedType, timeoutMs = 5000) {
  if (process.platform !== 'win32' || typeof executable !== 'string' || !path.isAbsolute(executable)) return Promise.reject(new Error('本机控制辅助程序不可用'));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', settled = false;
    const timer = setTimeout(() => finish(new Error('本机控制辅助程序超时')), timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.stdin.destroy(); child.stdout.destroy(); child.unref();
      if (error) reject(error); else resolve(result);
    };
    child.once('error', () => finish(new Error('无法启动本机控制辅助程序')));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 8192) finish(new Error('本机控制辅助程序结果无效')); });
    child.once('close', code => {
      if (code !== 0) return finish(new Error('本机控制辅助程序执行失败'));
      try {
        const value = JSON.parse(output);
        if (!value || value.type !== expectedType) throw new Error();
        finish(null, value);
      } catch { finish(new Error('本机控制辅助程序结果无效')); }
    });
    try { child.stdin.end(`${JSON.stringify(input)}\n`); }
    catch { finish(new Error('本机控制辅助程序执行失败')); }
  });
}
async function inspectNativeProcess(executable, pid, expected) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('本机进程标识无效');
  const value = await invokeNativeHelper(executable, { mode: 'inspect', pid, ...(expected || {}) }, 'process');
  if (value.pid !== pid || typeof value.image !== 'string' || !path.isAbsolute(value.image) || typeof value.creation !== 'string' || !/^\d{15,22}$/.test(value.creation)) throw new Error('本机进程身份信息无效');
  if (expected && value.argsMatched !== true) throw new Error('本机进程启动参数不匹配');
  return { pid, image: path.resolve(value.image), creation: value.creation };
}
async function stopOwnedTunnel(executable, pid, expected) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !['tunnel', 'natapp'].includes(expected?.kind) || typeof expected.creation !== 'string') throw new Error('本机 Tunnel 进程身份无效');
  const result = await invokeNativeHelper(executable, { mode: 'stop-owned', pid, ...expected }, 'stopped', 15000);
  if (result.pid !== pid) throw new Error('本机 Tunnel 进程停止结果无效');
  return true;
}
async function isOriginalProcessGone(executable, pid, creation) {
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof creation !== 'string' || !/^\d{15,22}$/.test(creation)) throw new Error('本机进程身份无效');
  const value = await invokeNativeHelper(executable, { mode: 'check-original-process', pid, creation }, 'process-instance-check');
  if (value.pid !== pid || typeof value.gone !== 'boolean') throw new Error('无法确认进程状态');
  return value.gone;
}
async function countNatappProcesses(executable) {
  const value = await invokeNativeHelper(executable, { mode: 'count-natapp' }, 'natapp-process-count', 7000);
  if (!Number.isSafeInteger(value.count) || value.count < 0 || value.count > 100000) throw new Error('无法确认 NATAPP 进程状态');
  return value.count;
}
module.exports = { invokeNativeHelper, inspectNativeProcess, stopOwnedTunnel, countNatappProcesses, isOriginalProcessGone };
