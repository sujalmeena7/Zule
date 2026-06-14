import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { copyVendorAssets } from './scripts/copy-vendor.mjs'

/**
 * Vite plugin that mirrors PDF.js, Tesseract, and Transformers.js (ONNX)
 * runtime assets from `node_modules/` into `public/vendor/` before the
 * dev server starts and before each production build.
 *
 * This is what makes the audit-fix in task 6.1 work: the application
 * code references `/vendor/...` paths (Requirement 15.7, 21.5), and this
 * plugin guarantees those paths exist on disk regardless of whether the
 * developer runs `vite`, `vite build`, or `vite preview`.
 */
function copyVendorPlugin(): Plugin {
  return {
    name: 'zule:copy-vendor',
    apply: () => true,
    // `buildStart` fires for both `vite build` (production) and `vite`
    // (dev: at the start of the first transform). For the dev server we
    // additionally hook `configureServer` so the assets exist *before*
    // the first request is served.
    buildStart() {
      copyVendorAssets({ silent: true })
    },
    configureServer() {
      copyVendorAssets({ silent: true })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), copyVendorPlugin()],
  resolve: {
    alias: {
      // @xenova/transformers is used in vectorStore.ts but only runs in Electron.
      // For the web/landing page build, stub it out so the build doesn't fail.
      '@xenova/transformers': '@huggingface/transformers',
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // Heavy ML runtime — Vector_Index + Whisper (Requirement 21.1)
          if (id.includes('@xenova/transformers') || id.includes('@huggingface/transformers') || id.includes('onnxruntime')) {
            return 'vendor-transformers';
          }
          // Heavy computer vision — OCR_Worker (Requirement 21.1)
          if (id.includes('tesseract.js') || id.includes('tesseract.js-core')) {
            return 'vendor-tesseract';
          }
          // Document processing — Document_Parser (Requirement 21.1)
          if (id.includes('pdfjs-dist')) {
            return 'vendor-pdf';
          }
          if (id.includes('node_modules/mammoth')) {
            return 'vendor-mammoth';
          }
          // Provider adapters — loaded on demand (Requirement 21.1)
          if (id.includes('src/brain/providers/gemini')) {
            return 'provider-gemini';
          }
          if (id.includes('src/brain/providers/openai')) {
            return 'provider-openai';
          }
          if (id.includes('src/brain/providers/anthropic')) {
            return 'provider-anthropic';
          }
          if (id.includes('src/brain/providers/ollama')) {
            return 'provider-ollama';
          }
          if (id.includes('src/brain/providers/simulation')) {
            return 'provider-simulation';
          }
        },
      },
    },
  },
})
