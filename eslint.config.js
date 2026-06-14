import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'e2e']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: {
          allowDefaultProject: ['vitest.config.ts', 'vitest.setup.ts', 'eslint.config.js', 'playwright.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Ban alert() calls in production code (Requirement 21.2)
      'no-alert': 'error',
      // Guard against new Promise(async ...) anti-pattern (Requirement 30.3)
      '@typescript-eslint/no-misused-promises': ['warn', {
        checksVoidReturn: {
          attributes: false, // Allow async event handlers in JSX
        },
      }],
    },
  },
])
