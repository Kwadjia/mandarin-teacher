import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

// The API serves both JSON and the generated audio, so both are proxied in dev.
// In production the Worker serves the built assets and there is no proxy.
const API = process.env.API_URL ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/audio': { target: API, changeOrigin: true },
      '/tones': { target: API, changeOrigin: true },
    },
  },
});
