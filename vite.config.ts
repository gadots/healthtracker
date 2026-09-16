import fs from 'node:fs'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Baked into the bundle so the app can state which build is installed. There is
// no auto-update: the version is how you tell a fresh download from an old one.
const { version } = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'))

// `--mode web` builds the hosted SPA that talks to the BFF in `server/`.
// Any other mode builds the Electron renderer, which talks to the preload bridge.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    // Separate output so the Electron renderer and the hosted SPA can coexist;
    // `electron-builder` only ever packages `dist/`.
    outDir: mode === 'web' ? 'dist-web' : 'dist',
  },
  define: {
    __APP_VERSION__: JSON.stringify(version),
    // A literal so Rollup can drop the dead branch and keep the assistant
    // (and `@assistant-ui/react`) out of the web bundle entirely.
    __WEB_TARGET__: JSON.stringify(mode === 'web'),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // The assistant drives local CLI binaries over IPC, which a browser cannot
      // do. Swapping the module keeps `@assistant-ui/react` out of the web bundle.
      ...(mode === 'web'
        ? { '@/components/HealthAssistant': path.resolve(__dirname, './src/components/HealthAssistant.web-stub.tsx') }
        : {}),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.OPENFIT_SERVER_URL || 'http://127.0.0.1:42814',
        changeOrigin: false,
      },
    },
  },
}))
