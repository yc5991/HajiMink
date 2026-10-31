import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { startDshLocalPreview } from '../server/dsh-local-preview.js';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4310' }, 'upstream-port': { type: 'string' }, 'dsh-home': { type: 'string' } } });
function discoverPort() {
  if (process.platform !== 'win32') throw new Error('请用 --upstream-port 指定正在运行的 DSH 网页端口');
  // Read process metadata and listener ownership only. Never serialize command lines or environment.
  const script = '$ErrorActionPreference="Stop"; $dshOwners=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "DeepSeek Harness.exe" -and $_.CommandLine -match "dsh-desktop-host[\\\\/]lib[\\\\/]index.js" } | Select-Object -ExpandProperty ProcessId); @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -eq "127.0.0.1" -and $dshOwners -contains $_.OwningProcess } | Select-Object -ExpandProperty LocalPort) | ConvertTo-Json -Compress';
  let ports: unknown;
  try { ports = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch { throw new Error('未能发现 DSH 网页端口，请保持桌面应用运行，或用 --upstream-port 指定端口'); }
  const found = Array.isArray(ports) ? ports : [ports];
  if (found.length !== 1 || typeof found[0] !== 'number') throw new Error('DSH 网页入口不唯一，请用 --upstream-port 指定端口');
  return found[0];
}
try {
  const upstreamPort = values['upstream-port'] ? Number(values['upstream-port']) : discoverPort();
  const credentialsPath = path.join(values['dsh-home'] || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml');
  const preview = await startDshLocalPreview({ port: Number(values.port), upstreamPort, credentialsPath });
  console.log(`HajiMink · DSH 本地预览：${preview.url}`);
  console.log(`转发到本机 DSH 网页端口 ${upstreamPort}；HTTP 与 WebSocket 共用原服务。`);
  console.log('仅本机访问；认证信息留在服务端内存；关闭预览不会停止 DSH 任务。');
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    if (closing) return;
    closing = true; void preview.close().then(() => process.exit(0));
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'DSH 本地预览无法启动');
  process.exitCode = 1;
}
