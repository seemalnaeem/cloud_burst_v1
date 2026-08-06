import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Tailwind 4 through its Vite plugin. No tailwind.config.js and no PostCSS
// config, the theme lives in src/styles/index.css as an @theme block.
export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The contracts directory is mounted into the container. Importing JSON
      // from it means the frontend reads exactly the same thresholds and
      // palettes as the backend.
      '@contracts': fileURLToPath(new URL('./src/contracts', import.meta.url))
    }
  },

  server: {
    // Listen on every interface. Loopback inside a container is unreachable
    // from outside it.
    host: '0.0.0.0',
    port: 4090,
    strictPort: true,

    // Vite 5 and later reject requests whose Host header it was not told
    // about, which is every request once the machine picks up a new DHCP
    // address. Allowing any host is the point of this project's auto IP
    // requirement.
    allowedHosts: true,

    // The HMR websocket must target the published port. Without this it tries
    // the internal port and fails silently: the page still loads, edits just
    // stop appearing, and it takes a while to notice.
    hmr: { clientPort: 4090 },

    // Polling because bind mounts on Windows and macOS do not deliver inotify
    // events into the container.
    watch: { usePolling: true, interval: 300 }
  },

  preview: {
    host: '0.0.0.0',
    port: 4090,
    strictPort: true
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // Mapbox GL is large and changes rarely, so it caches well on its own.
          mapbox: ['mapbox-gl'],
          charts: ['recharts']
        }
      }
    }
  }
})
