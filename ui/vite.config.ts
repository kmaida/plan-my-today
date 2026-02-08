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
