import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard is served by the local Express server in production; in dev we
// proxy /api to that server so `npm run dev:web` works alongside `npm run dev:server`.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4317',
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 900,
  },
});
