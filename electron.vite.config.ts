import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Vite injects `crossorigin` on injected script/link tags. With `loadFile()` the renderer uses
 * the `file://` protocol; Chromium treats module scripts/styles with `crossorigin` as CORS fetches,
 * which fail without ACAO headers — result is an empty #root (white screen). Strip for production HTML.
 */
function stripCrossoriginForFileProtocol(): Plugin {
  return {
    name: 'strip-crossorigin-file-protocol',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html: string) {
        return html.replace(/\s+crossorigin(?:=["'][^"']*["'])?/gi, '')
      },
    },
  }
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ['bufferutil', 'utf-8-validate'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    base: './',
    plugins: [react(), tailwindcss(), stripCrossoriginForFileProtocol()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer'),
      },
    },
  },
})
