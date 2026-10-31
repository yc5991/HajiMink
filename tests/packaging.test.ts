import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import builder from '../desktop-builder.json';
import manifest from '../package.json';

const require = createRequire(import.meta.url);
const { FileMatcher } = require('app-builder-lib/out/fileMatcher');

describe('Windows desktop packaging', () => {
  it('excludes the unintegrated tunnel prototype while retaining the active desktop code', () => {
    const root = path.resolve('fixture-app');
    const filter = new FileMatcher(root, root, (value: string) => value, builder.files).createFilter();
    const included = (file: string) => filter(path.join(root, ...file.split('/')), { isDirectory: () => false });
    expect(included('desktop/tunnel-manager.cjs')).toBe(false);
    expect(included('desktop/providers.cjs')).toBe(true);
    expect(included('desktop/tunnel-status.cjs')).toBe(true);
    expect(included('desktop/natapp-manager.cjs')).toBe(true);
  });

  it('keeps browser dependencies available to the build without installing them for the gateway', () => {
    const dependencies: Record<string, string> = manifest.dependencies;
    const buildDependencies: Record<string, string> = manifest.devDependencies;
    for (const name of ['@simplewebauthn/browser', '@xterm/addon-fit', '@xterm/xterm', 'lucide-react', 'react', 'react-dom', 'react-markdown', 'remark-gfm']) {
      expect(dependencies[name], name).toBeUndefined();
      expect(buildDependencies[name], name).toBeTruthy();
    }
    for (const name of ['@fastify/static', '@fastify/websocket', '@simplewebauthn/server', 'fastify', 'immer', 'jose', 'node-pty', 'ws', 'zod']) {
      expect(dependencies[name], name).toBeTruthy();
    }
  });

  it('retains x64 terminal binaries and licenses but excludes other architectures and debug files', () => {
    const entry = builder.win.extraResources.find(value => value.to === 'gateway/node_modules');
    if (!entry || !('filter' in entry)) throw new Error('Missing gateway dependency filter');
    const root = path.resolve('fixture-node-modules');
    const filter = new FileMatcher(root, root, (value: string) => value, entry.filter).createFilter();
    const included = (file: string) => filter(path.join(root, ...file.split('/')), { isDirectory: () => false });

    for (const file of ['node-pty/prebuilds/win32-x64/conpty.node', 'node-pty/prebuilds/win32-x64/pty.node', 'node-pty/prebuilds/win32-x64/winpty-agent.exe', 'node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe', 'fastify/LICENSE']) {
      expect(included(file), file).toBe(true);
    }
    for (const file of ['node-pty/prebuilds/win32-arm64/conpty.node', 'node-pty/prebuilds/darwin-x64/pty.node', 'node-pty/prebuilds/linux-x64/pty.node', 'node-pty/third_party/conpty/1.0/win10-arm64/OpenConsole.exe', 'node-pty/prebuilds/win32-x64/conpty.pdb', 'fastify/index.js.map', 'fastify/index.d.ts', 'fastify/index.d.cts', 'fastify/index.d.mts']) {
      expect(included(file), file).toBe(false);
    }
  });
});
