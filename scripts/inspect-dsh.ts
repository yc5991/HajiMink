import fs from 'node:fs';
import path from 'node:path';

// Read only the installed application archive's package metadata; never open profiles or credentials.
const archive = process.argv[2] || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar');
const fd = fs.openSync(archive, 'r');
try {
  const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, prefix.length, 0);
  const length = prefix.readUInt32LE(12);
  if (length > 32 * 1024 * 1024) throw new Error('DSH archive header is too large');
  const bytes = Buffer.alloc(length); fs.readSync(fd, bytes, 0, length, 16);
  const root = JSON.parse(bytes.toString('utf8')).files;
  type Entry = { files?: Record<string, Entry>; size?: number; offset?: string; unpacked?: boolean };
  const file = (name: string) => name.split('/').reduce<Entry | undefined>((entry, part) => entry?.files?.[part], { files: root });
  const entry = file('package.json');
  if (!entry || entry.unpacked || !Number.isSafeInteger(entry.size) || !entry.size || entry.size > 1024 * 1024 || !/^\d+$/.test(entry.offset || '')) throw new Error('DSH package metadata is unavailable');
  const body = Buffer.alloc(entry.size); fs.readSync(fd, body, 0, body.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
  const pkg = JSON.parse(body.toString('utf8'));
  console.log(JSON.stringify({ installed: true, package: pkg.name, version: pkg.version, commit: pkg.dshBuildCommit, desktopHostBundled: !!file('dsh/node_modules/@deepseek-ai/dsh-desktop-host/package.json'), apiGatewayBundled: !!file('dsh/node_modules/@deepseek-ai/dsh-api-gateway/package.json'), connected: false, reason: '仅检查安装包，尚未建立经过授权的桌面连接' }, null, 2));
} finally { fs.closeSync(fd); }
