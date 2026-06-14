import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest configuration for the Zule project.
//
// - jsdom environment so that DOM-touching helpers (clamp / hooks / fake IndexedDB)
//   can be exercised in Vitest without a full browser.
// - Coverage uses the V8 provider with a per-directory threshold of 80% statements
//   on `src/brain/` per Requirement 30.4.
// - E2E tests under `e2e/**` are excluded; they run via Playwright (`npm run test:e2e`).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'e2e/**',
    ],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/main.tsx',
        'src/**/*.d.ts',
      ],
      // Per-directory gate: src/brain/ must hit at least 80% statement coverage.
      // Other directories are reported but not gated here.
      thresholds: {
        'src/brain/**': {
          statements: 80,
          branches: 70,
          functions: 80,
          lines: 80,
        },
      },
    },
  },
});
