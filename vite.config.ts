import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { frontendLicenses } from './scripts/frontend-licenses';
export default defineConfig({ plugins: [react(), frontendLicenses()], server: { host: '127.0.0.1', port: 5173, watch: { ignored: ['**/.local/**', '**/dist/**', '**/dist-next/**', '**/dist-server*/**', '**/output/**'] }, proxy: { '/api': { target: 'http://127.0.0.1:3001', ws: true, changeOrigin: false } } }, build: { sourcemap: false } });
