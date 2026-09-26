import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` serves the app on http://localhost:5173 and sends API and WebSocket calls to the
// running system on https://localhost:8443 (started with docker compose).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'https://localhost:8443', changeOrigin: false, secure: false },
      '/ws': { target: 'wss://localhost:8443', ws: true, secure: false },
    },
  },
  build: { outDir: 'dist', sourcemap: false, assetsInlineLimit: 0 }, // no data: URIs, so the strict CSP (font-src 'self') holds
});
