// ============================================
// Zule AI — Vite Config for Electron Build
// ============================================
//
// This is a SEPARATE config used only for `electron:dev` and `electron:build`.
// The original `vite.config.ts` remains untouched for web-only development.
//
// It extends the base config and adds vite-plugin-electron to compile
// the Electron main process and preload script alongside the React app.

import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyVendorAssets } from './scripts/copy-vendor.mjs'
import { fetchModels } from './scripts/fetch-models.mjs'

// ESM does not provide __dirname; reconstruct from import.meta.url so
// the absolute alias paths below resolve regardless of cwd.
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Copy vendor assets plugin (same as base config).
 */
function copyVendorPlugin(): Plugin {
  return {
    name: 'zule:copy-vendor',
    apply: () => true,
    buildStart() {
      copyVendorAssets({ silent: true })
      // Mirror the embedding model into public/vendor/models/ on build.
      // Fire-and-forget: idempotent and non-fatal (renderer falls back to
      // the remote HF fetch if the local copy is missing).
      void fetchModels({ silent: true })
    },
    configureServer() {
      copyVendorAssets({ silent: true })
      void fetchModels({ silent: true })
    },
  }
}

export default defineConfig({
  // Force the renderer to use browser-style resolution so packages like
  // `mammoth` and `pdfjs-dist` pick up their ESM/browser entry points
  // instead of CommonJS Node entries (which call `require()` — undefined
  // in a contextIsolation: true renderer).
  resolve: {
    conditions: ['browser', 'module', 'import', 'default'],
    alias: [
      {
        // mammoth's `main` points at `./lib/index.js` (CJS, uses `require`).
        // The package ships a pre-bundled browser build that's ESM-safe.
        find: /^mammoth$/,
        replacement: path.resolve(
          __dirname,
          'node_modules/mammoth/mammoth.browser.min.js',
        ),
      },
      {
        // Stub out the entire ML inference stack. @xenova/transformers
        // depends on onnxruntime-web@1.14.0 which segfaults under
        // Electron 42's V8. Until it's upgraded, the stub prevents Vite
        // from trying to resolve the missing dist/ directory and prevents
        // the renderer from ever touching the broken WASM backend.
        find: /^@xenova\/transformers$/,
        replacement: path.resolve(
          __dirname,
          'src/brain/transformers-stub.ts',
        ),
      },
      {
        // onnxruntime-web dist is missing / incompatible — stub to prevent
        // Vite import analysis failures on any transitive import.
        find: /^onnxruntime-web/,
        replacement: path.resolve(
          __dirname,
          'src/brain/transformers-stub.ts',
        ),
      },
    ],
  },
  // Pre-bundle the document parsers in dev so esbuild can rewrite any
  // residual CJS interop into ESM ahead of HMR. pdfjs-dist v6 is already
  // ESM so it doesn't need pre-bundling (and pre-bundling its 30 MB
  // worker would stall Vite startup).
  optimizeDeps: {
    include: [],
    // Exclude the ML inference stack from dependency analysis. The ONNX WASM
    // backend (onnxruntime-web@1.14.0) is binary-incompatible with Electron
    // 42's V8 and segfaults on instantiation. We've disabled embedding in the
    // renderer for now; excluding these ensures Vite never tries to resolve or
    // bundle them (which fails anyway since onnxruntime-web/dist is missing).
    exclude: ['@xenova/transformers', 'onnxruntime-web', 'onnxruntime-node'],
  },

  plugins: [
    react(),
    copyVendorPlugin(),

    // Compile Electron main process + preload to dist-electron/
    electron([
      {
        // Main process entry
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron', 'node:path', 'node:url'],
            },
          },
        },
      },
      {
        // Preload script entry
        entry: 'electron/preload.ts',
        onstart(args) {
          // Notify the Electron main process to reload when preload changes
          args.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
              output: {
                format: 'es',
                entryFileNames: '[name].mjs',
              },
            },
          },
        },
      },
    ]),

    // NOTE: vite-plugin-electron-renderer was intentionally removed. The
    // renderer runs with `contextIsolation: true` + `nodeIntegration: false`
    // and talks to the main process exclusively through the preload bridge,
    // so it is pure browser code with no Node access. The renderer plugin
    // rewrites bare imports of heavy deps (onnxruntime-web, mammoth, etc.)
    // into `require()` calls assuming Node integration — which throws
    // "ReferenceError: require is not defined" at runtime in our sandboxed
    // renderer. Removing it lets these packages load as plain browser ESM.
  ],

  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // Heavy ML runtime — Vector_Index + Whisper (Requirement 21.1)
          if (id.includes('@xenova/transformers') || id.includes('onnxruntime')) {
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
