import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Em desenvolvimento o Vite serve o frontend e faz proxy do WebSocket/API para o servidor local da HQ.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:4777', ws: true },
      '/api': { target: 'http://127.0.0.1:4777' },
    },
  },
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
});
