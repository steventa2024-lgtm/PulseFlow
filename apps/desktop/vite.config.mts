import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const apiTarget = process.env.PULSEFLOW_DEV_API ?? 'http://127.0.0.1:5199';

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The host rejects cross-origin writes, so the dev proxy strips the Vite origin.
      '/api': { target: apiTarget, configure: (proxy) => proxy.on('proxyReq', (req) => req.removeHeader('origin')) },
      '/hooks': { target: apiTarget },
      '/demo': { target: apiTarget },
    },
  },
});
