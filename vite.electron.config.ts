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
import fs from 'node:fs'
import { copyVendorAssets } from './scripts/copy-vendor.mjs'
import { fetchModels } from './scripts/fetch-models.mjs'

// ESM does not provide __dirname; reconstruct from import.meta.url so
// the absolute alias paths below resolve regardless of cwd.
const __dirname = path.dirname(fileURLToPath(import.meta.url))

function copyPhonePage(): void {
  try {
    const src = path.resolve(__dirname, 'electron/phonePage.html')
    const dest = path.resolve(__dirname, 'dist-electron/phonePage.html')
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
    }
  } catch (err) {
    console.warn('[vite.electron] failed to copy phonePage.html:', err)
  }
}

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
      copyPhonePage()
    },
    configureServer() {
      copyVendorAssets({ silent: true })
      void fetchModels({ silent: true })
      copyPhonePage()
    },
    closeBundle() {
      copyPhonePage()
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
        // @huggingface/transformers (v3) statically imports `onnxruntime-node`
        // in its ONNX backend, even though it only *uses* it under Node. That
        // package is CJS with a native binding and no browser entry, so we
        // alias it to an empty (non-throwing) stub for the sandboxed renderer.
        // The web backend (onnxruntime-web — WebGPU/WASM) runs inference here.
        find: /^onnxruntime-node$/,
        replacement: path.resolve(
          __dirname,
          'src/brain/onnxruntime-node-stub.ts',
        ),
      },
    ],
  },
  // Pre-bundle the document parsers in dev so esbuild can rewrite any
  // residual CJS interop into ESM ahead of HMR. pdfjs-dist v6 is already
  // ESM so it doesn't need pre-bundling (and pre-bundling its 30 MB
  // worker would stall Vite startup).
  optimizeDeps: {
    // Pre-bundle the ML inference stack so esbuild resolves the large ESM graph
    // once and HMR stays stable. We only list the top-level package by its bare
    // name — `onnxruntime-web` is nested under @huggingface/transformers's own
    // node_modules, so it is NOT resolvable by bare specifier from the project
    // root (listing it here fails dependency resolution). esbuild follows it
    // transitively when it pre-bundles @huggingface/transformers.
    include: ['@huggingface/transformers'],
    // onnxruntime-node is the native Node backend — never used in the renderer
    // and aliased to an empty stub above. Keep it out of dependency analysis.
    exclude: ['onnxruntime-node'],
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
              // The native ML stack (transformers' node build + onnxruntime-node
              // + its peer sharp) must NOT be bundled — it ships native `.node`/
              // `.dll` binaries and is loaded from node_modules at runtime via a
              // dynamic import in whisperService.ts. Externalize so Rollup leaves
              // the `import('@huggingface/transformers')` as a runtime require.
              external: [
                'electron',
                'node:path',
                'node:url',
                'node:module',
                '@huggingface/transformers',
                'onnxruntime-node',
                'sharp',
                // `hnswlib-node` is the native HNSW addon used by
                // electron/vectorIndexService.ts. Like the other native
                // bindings above it must be loaded from node_modules at
                // runtime; bundling would inline the .node binary path
                // resolution and break the addon load.
                'hnswlib-node',
                // `koffi` is the FFI library used by
                // electron/nativeStealth.ts to call Win32 APIs directly.
                // Ships prebuilt native binaries — must load at runtime.
                'koffi',
              ],
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
            // vite-plugin-electron builds every entry in *library mode*
            // (`build.lib`), and it's `lib.formats` — not
            // rolldownOptions.output.format — that actually decides the
            // emitted format; the plugin's own default sets
            // `formats: ['es']` here because root package.json has
            // "type": "module", and that wins the merge over anything set
            // under rolldownOptions/rollupOptions.output.format.
            //
            // CJS, not ES: with sandbox: true (electron/main.ts,
            // electron/overlayManager.ts) Electron loads the preload
            // through its own restricted script wrapper, which never goes
            // through Node's ESM loader — an `import` statement throws
            // "Cannot use import statement outside a module" at runtime.
            lib: {
              entry: 'electron/preload.ts',
              formats: ['cjs'],
              fileName: () => 'preload.cjs',
            },
            rolldownOptions: {
              external: ['electron'],
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
          // 3D hero stack — Hero_3D_Canvas (landing-page-3d-enhancement Req 2.6, 11.3)
          // Routed into its own async chunk so `three` and the R3F wrappers
          // only download when LandingPage lazily imports Hero3DCanvas.
          // Trailing `/` on `three` keeps unrelated packages like
          // `three-mesh-bvh` or `three-stdlib` out of this chunk.
          if (
            id.includes('node_modules/three/') ||
            id.includes('node_modules/@react-three/fiber') ||
            id.includes('node_modules/@react-three/drei')
          ) {
            return 'vendor-three';
          }
          // Heavy ML runtime — Vector_Index + Whisper (Requirement 21.1)
          if (id.includes('@huggingface/transformers') || id.includes('onnxruntime')) {
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
