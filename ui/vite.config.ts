import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load .env from the parent (server) directory to get PORT
  const parentEnv = loadEnv(mode, path.resolve(__dirname, '..'), '')
  const target = `http://localhost:${parentEnv.PORT || '9005'}`

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: "autoUpdate",
        workbox: {
          globPatterns: [], // No precaching — no offline support needed
        },
        manifest: {
          name: "Plan My Today",
          short_name: "Plan Today",
          description: "AI-powered daily task aggregator",
          theme_color: "#3D2E1F",
          background_color: "#FAFAF8",
          display: "standalone",
          id: "/",
          scope: "/",
          start_url: "/",
          icons: [
            { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
            { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
            { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          ],
        },
      }),
    ],
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
