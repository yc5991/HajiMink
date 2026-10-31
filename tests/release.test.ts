import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import asar from '@electron/asar';
import { removeTempFixture } from './safe-temp';
// @ts-expect-error The standalone release utility is also runnable without the TypeScript toolchain.
import { inspectRelease, releaseFiles } from '../scripts/check-release.mjs';
// @ts-expect-error The desktop release utility is also runnable without the TypeScript toolchain.
import { inspectDesktopRelease } from '../scripts/check-desktop-release.mjs';
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) removeTempFixture(dir, 'agent-control-'); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-release-')); directories.push(root);
  fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, '.local'));
  fs.writeFileSync(path.join(root, 'release-files.json'), JSON.stringify({ directories: ['src'], files: ['README.md'] }));
  fs.writeFileSync(path.join(root, 'README.md'), 'public documentation');
  fs.writeFileSync(path.join(root, 'src', 'public.ts'), 'export const value = 1;');
  fs.writeFileSync(path.join(root, '.local', 'gateway.sqlite'), 'private runtime fixture');
  return root;
}
it('excludes runtime files and reports content findings without exposing their values', () => {
  const root = fixture();
  expect(releaseFiles(root)).toEqual(['README.md', 'src/public.ts']);
  const address = ['owner', 'private-mail.org'].join('@');
  fs.writeFileSync(path.join(root, 'README.md'), address);
  const result = inspectRelease(root);
  expect(result.issues).toEqual(['README.md:1: non-example email address']);
  expect(JSON.stringify(result.issues)).not.toContain(address);
});
it('rejects a junction that would package a directory outside the declared source', () => {
  const root = fixture(); const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-outside-')); directories.push(outside);
  fs.writeFileSync(path.join(outside, 'private.txt'), 'not for release');
  fs.symlinkSync(outside, path.join(root, 'src', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => releaseFiles(root)).toThrow('Symbolic links');
});
it('detects an already tracked runtime file even if the current ignore rules would hide it', () => {
  const root = fixture();
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  execFileSync('git', ['add', '-f', '.local/gateway.sqlite'], { cwd: root, windowsHide: true });
  expect(inspectRelease(root).issues).toContain('.local/gateway.sqlite: tracked outside the release allowlist');
});
it('permits only the known upstream deprecation contact in package-lock while still reporting it elsewhere', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'release-files.json'), JSON.stringify({ directories: ['src'], files: ['README.md', 'package-lock.json'] }));
  const address = ['i', 'izs.me'].join('@');
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ deprecated: `Upstream support: ${address}` }, null, 2));
  expect(inspectRelease(root).issues).toEqual([]);
  fs.writeFileSync(path.join(root, 'README.md'), address);
  expect(inspectRelease(root).issues).toEqual(['README.md:1: non-example email address']);
});

it('permits C# source while still rejecting executable binaries in the source manifest', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'src', 'controller.cs'), 'internal class Controller {}');
  expect(inspectRelease(root).issues).toEqual([]);
  fs.writeFileSync(path.join(root, 'src', 'controller.exe'), 'binary fixture');
  expect(() => releaseFiles(root)).toThrow('Runtime or private file');
});

it('reports local documentation paths and configured private markers without exposing their values', () => {
  const root = fixture();
  const marker = 'private-origin.example.test';
  const localPath = 'D:\\PrivateWorkspace\\artifact';
  fs.writeFileSync(path.join(root, 'README.md'), `path: ${localPath}\naddress: ${marker}`);
  const issues = inspectRelease(root, { privateMarkers: [marker] }).issues;
  expect(issues).toContain('README.md:1: absolute Windows path in documentation');
  expect(issues).toContain('README.md:2: private marker');
  expect(JSON.stringify(issues)).not.toContain(marker);
  expect(JSON.stringify(issues)).not.toContain(localPath);
});

it('checks packaged app content, dependencies and runtime data without revealing markers', async () => {
  const root = fixture(); const app = path.join(root, 'app'); const unpacked = path.join(root, 'unpacked');
  fs.mkdirSync(path.join(app, 'desktop', 'native'), { recursive: true });
  fs.writeFileSync(path.join(app, 'shell.js'), 'const marker = "private-host.example.test";');
  fs.writeFileSync(path.join(app, 'desktop', 'native', 'controller.cs'), 'const string marker = "private-host.example.test";');
  const files = [
    'HajiMink.exe', 'resources/gateway/dist/index.html', 'resources/gateway/dist-server/index.js',
    'resources/gateway/runtime/node.exe', 'resources/gateway/controller/PrivateControlPipe.exe',
    'resources/licenses/HajiMink-LICENSE.txt', 'resources/licenses/DEPENDENCIES.md', 'resources/licenses/BRAND-ASSETS.md',
    'resources/gateway/node_modules/sample/index.js', 'resources/gateway/connections.json'
  ];
  for (const file of files) { const target = path.join(unpacked, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.includes('node_modules') ? 'private-host.example.test' : 'fixture'); }
  await asar.createPackage(app, path.join(unpacked, 'resources', 'app.asar'));
  const result = inspectDesktopRelease(unpacked, ['private-host.example.test']);
  expect(result.issues).toContain('app.asar/shell.js:1: private marker');
  expect(result.issues).toContain('app.asar/desktop/native/controller.cs:1: private marker');
  expect(result.issues).toContain('gateway/node_modules/sample/index.js: private marker');
  expect(result.issues).toContain('gateway/connections.json: runtime data file');
  expect(JSON.stringify(result.issues)).not.toContain('private-host.example.test');
});
