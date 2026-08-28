import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { outDir, sharedPlugins } from './vite.shared.ts'

/** Side panel: minimal vanilla TypeScript controller (html entry, no React). */
export default defineConfig({
  plugins: sharedPlugins,
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'panel/index.html'),
      output: {
        entryFileNames: 'panel/assets/[name].js',
        chunkFileNames: 'panel/assets/[name]-[hash].js',
        assetFileNames: 'panel/assets/[name][extname]',
      },
    },
  },
})

export { outDir }
