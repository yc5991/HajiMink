import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['server/index.ts'], format: ['esm'], platform: 'node', target: 'node24', outDir: 'dist-server', removeNodeProtocol: false, external: ['node:sqlite'], clean: false });
