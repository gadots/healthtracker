import fs from 'node:fs'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Baked into the bundle so the app can state which build is installed. There is
// no auto-update: the version is how you tell a fresh download from an old one.
const { version } = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
