import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {},
  renderer: {
    plugins: [react()],
    // electron-vite leaves bundles unminified by default (measured: 680 kB renderer bundle)
    build: { minify: true }
  }
})
