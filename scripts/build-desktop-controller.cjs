'use strict';
// Build a physical Windows controller directory, isolated from the online build.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32') { console.log('Windows 本机控制器在此平台不构建'); process.exit(0); }
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.local', 'hajimink-stage', 'controller');
fs.mkdirSync(out, { recursive: true });
const csc = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const result = spawnSync(csc, ['/nologo', '/optimize+', '/target:exe', '/reference:System.Web.Extensions.dll', '/reference:System.Security.dll', '/reference:System.Management.dll', `/out:${path.join(out, 'PrivateControlPipe.exe')}`, path.join(root, 'desktop', 'native', 'PrivateControlPipe.cs')], { encoding: 'utf8', windowsHide: true });
if (result.status !== 0) { console.error(result.stdout || result.stderr || '编译本机控制器失败'); process.exit(1); }
for (const name of ['gateway-controller.cjs', 'gateway-manager.cjs', 'native-helper.cjs', 'desktop-status.cjs', 'natapp-manager.cjs']) fs.copyFileSync(path.join(root, 'desktop', name), path.join(out, name));
console.log('已在隔离目录准备 Windows 本机控制器');
