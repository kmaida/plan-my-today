import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load .env from the parent (server) directory to get PORT
  const parentEnv = loadEnv(mode, path.resolve(__dirname, '..'), '')
  const target = `http://localhost:${parentEnv.PORT || '9005'}`

  return {
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            // Isolate large vendor deps into cache-friendly chunks so that
            // app-only changes don't invalidate the (unchanged) vendor cache.
            if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
              return 'vendor-react'
            }
            if (id.includes('node_modules/@modelcontextprotocol/')) {
              return 'vendor-mcp'
            }
          },
        },
      },
    },
    server: {
      port: 9006,
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
        },
        '/mcp': {
          target,
          changeOrigin: true,
        },
        '/.well-known': {
          target,
          changeOrigin: true,
        },
      },
    },
  }
})
