import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load .env from the parent (server) directory to get LOCAL_TUNNEL
  const parentEnv = loadEnv(mode, path.resolve(__dirname, '..'), '')
  const tunnelTarget = parentEnv.LOCAL_TUNNEL || `http://localhost:${parentEnv.PORT || '9005'}`
  const localTarget = `http://localhost:${parentEnv.PORT || '9005'}`

  return {
    plugins: [react()],
    server: {
      port: 9006,
      proxy: {
        // API requests go directly to localhost (no auth required, avoids ngrok latency)
        '/api': {
          target: localTarget,
          changeOrigin: true,
        },
        // MCP and OAuth discovery must go through ngrok for correct redirect URLs
        '/mcp': {
          target: tunnelTarget,
          changeOrigin: true,
          headers: {
            'ngrok-skip-browser-warning': 'true',
          },
        },
        '/.well-known': {
          target: tunnelTarget,
          changeOrigin: true,
          headers: {
            'ngrok-skip-browser-warning': 'true',
          },
        },
      },
    },
  }
})
