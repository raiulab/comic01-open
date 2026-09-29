import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        proxyTimeout: 300000
      },
      '/generated': 'http://localhost:8000',
      '/uploads': 'http://localhost:8000'
    }
  }
});
