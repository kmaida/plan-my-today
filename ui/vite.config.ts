import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load .env from the parent (server) directory to get LOCAL_TUNNEL
  const parentEnv = loadEnv(mode, path.resolve(__dirname, '..'), '')
  const backendTarget = parentEnv.LOCAL_TUNNEL || `http://localhost:${parentEnv.PORT || '9005'}`

  return {
    plugins: [react()],
    server: {
      port: 9006,
      proxy: {
        // Proxy API and MCP requests to the backend server (via ngrok tunnel)
        '/api': {
          target: backendTarget,
          changeOrigin: true,
        },
        '/mcp': {
          target: backendTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
