/**
 * Vite Configuration — Stage C Overlay Bundle
 *
 * Builds the Stage C overlay as a standalone web bundle separate from
 * the main app and Electron builds. Output goes to `resources/stage-c/overlay/`
 * with content-hashed filenames for cache-busting.
 *
 * This bundle contains ONLY the presentation layer:
 * - React + ReactDOM
 * - Presentation components (ControlCapsule, SuggestionCard, InputBar)
 * - Bridge adapter (window.zuleOverlay consumer)
 * - Shared CSS
 *
 * It does NOT include:
 * - Electron modules
 * - AI providers, audio/capture pipelines
 * - Storage, database, or credential modules
 * - Heavy ML/OCR/PDF vendor chunks
 *
 * Layer 0 assets in dist/ are untouched by this build.
 *
 * Requirements: 7.11–7.15, 8.1–8.7, 9.9, 14.1–14.2
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname, 'src/stageC/overlay'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      // Ensure shared component imports resolve from the project root
      { find: '@', replacement: path.resolve(__dirname, 'src') },
      // Stub out heavy/service modules that presentation components
      // transitively reference via type imports or dead-code paths.
      // These stubs prevent bundling ML, native, and service code.
      { find: /^@huggingface\/transformers$/, replacement: path.resolve(__dirname, 'src/stageC/overlay/stubs/empty.ts') },
      { find: /^onnxruntime-node$/, replacement: path.resolve(__dirname, 'src/stageC/overlay/stubs/empty.ts') },
      { find: /^onnxruntime-web$/, replacement: path.resolve(__dirname, 'src/stageC/overlay/stubs/empty.ts') },
      { find: /^tesseract\.js$/, replacement: path.resolve(__dirname, 'src/stageC/overlay/stubs/empty.ts') },
      { find: /^pdfjs-dist/, replacement: path.resolve(__dirname, 'src/stageC/overlay/stubs/empty.ts') },
      { find: /^mammoth$/, replacement: path.resolve(__dirname, 'src/stageC/overlay/stubs/empty.ts') },
      { find: /^koffi$/, replacement: path.resolve(__dirname, 'src/stageC/overlay/stubs/empty.ts') },
      { find: /^hnswlib-node$/, replacement: path.resolve(__dirname, 'src/stageC/overlay/stubs/empty.ts') },
      { find: /^sharp$/, replacement: path.resolve(__dirname, 'src/stageC/overlay/stubs/empty.ts') },
      { find: /^electron$/, replacement: path.resolve(__dirname, 'src/stageC/overlay/stubs/empty.ts') },
      // Stub the vector store (heavy ML dependency)
      { find: /\.\.\/brain\/vectorStore$/, replacement: path.resolve(__dirname, 'src/stageC/overlay/stubs/empty.ts') },
      { find: /\.\.\/\.\.\/brain\/vectorStore$/, replacement: path.resolve(__dirname, 'src/stageC/overlay/stubs/empty.ts') },
    ],
  },
  build: {
    outDir: path.resolve(__dirname, 'resources/stage-c/overlay'),
    emptyOutDir: true,
    // Content-hashed filenames for cache-busting (Req 14.1)
    rollupOptions: {
      input: path.resolve(__dirname, 'src/stageC/overlay/index.html'),
      output: {
        // Hashed asset filenames
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
    // Minimal bundle — no sourcemaps in production sidecar
    sourcemap: false,
    // Target modern browsers (WebView2 uses latest Chromium)
    target: 'esnext',
    minify: 'esbuild',
  },
  // Prevent any Node.js or Electron modules from being resolved
  optimizeDeps: {
    exclude: [
      'electron',
      'koffi',
      'hnswlib-node',
      'sharp',
      '@huggingface/transformers',
      'onnxruntime-node',
      'onnxruntime-web',
      'tesseract.js',
      'pdfjs-dist',
      'mammoth',
    ],
  },
});
