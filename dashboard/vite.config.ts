import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // Proxy API + SSE calls to the FastAPI orchestrator in dev so the browser
    // can hit the Vite dev server without CORS issues.
    proxy: {
      '/sessions': 'http://127.0.0.1:8765',
      '/logs': 'http://127.0.0.1:8765',
      '/health': 'http://127.0.0.1:8765',
      '/events': 'http://127.0.0.1:8765',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
