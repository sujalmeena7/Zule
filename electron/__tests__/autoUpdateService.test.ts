// Feature: auto-updater, Property 5: Errors return to previous actionable state
// **Validates: Requirements 2.7, 3.7, 5.7, 8.1, 8.2**
//
// For any error encountered during the update lifecycle (network timeout,
// server error, integrity failure, storage error), the state machine SHALL
// transition to either `idle` (if the error occurred during `checking`) or
// `available` (if the error occurred during `downloading`), and SHALL never
// remain stuck in `checking` or `downloading` after an error.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Store event handlers registered by autoUpdateService so we can trigger them
const eventHandlers: Record<string, (...args: unknown[]) => void> = {};

// We need to mock `node:module` so that `createRequire` returns a function
// that intercepts `require('electron')` and `require('electron-updater')`.
// The autoUpdateService.ts uses:
//   import { createRequire } from 'node:module';
//   const require = createRequire(import.meta.url);
//   const { app } = require('electron');
// And later in initAutoUpdater:
//   const { autoUpdater } = require('electron-updater');

vi.mock('node:module', () => {
  return {
    createRequire: () => (moduleName: string) => {
      if (moduleName === 'electron') {
        return { app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => '/tmp/test-userdata' } };
      }
      if (moduleName === 'electron-updater') {
        return {
          autoUpdater: {
            autoDownload: true,
            autoInstallOnAppQuit: true,
            on: (event: string, handler: (...args: unknown[]) => void) => {
              eventHandlers[event] = handler;
            },
            checkForUpdates: vi.fn().mockResolvedValue(undefined),
            downloadUpdate: vi.fn().mockResolvedValue(undefined),
          },
        };
      }
      // For any other module, throw
      throw new Error(`Unexpected require in test: ${moduleName}`);
    },
    // Provide default export to satisfy ESM interop
    default: {
      createRequire: () => (moduleName: string) => {
        if (moduleName === 'electron') {
          return { app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => '/tmp/test-userdata' } };
        }
        if (moduleName === 'electron-updater') {
          return {
            autoUpdater: {
              autoDownload: true,
              autoInstallOnAppQuit: true,
              on: (event: string, handler: (...args: unknown[]) => void) => {
                eventHandlers[event] = handler;
              },
              checkForUpdates: vi.fn().mockResolvedValue(undefined),
              downloadUpdate: vi.fn().mockResolvedValue(undefined),
            },
          };
        }
        throw new Error(`Unexpected require in test: ${moduleName}`);
      },
    },
  };
});

// Mock node:fs to prevent actual file system access during tests
vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn().mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  readFileSync: vi.fn().mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// ── Import after mocks ───────────────────────────────────────────────────────

import { AutoUpdateService } from '../autoUpdateService';

// ── Generators ───────────────────────────────────────────────────────────────

/** Error categories as defined by the design document. */
const errorCategories = [
  'unreachable',
  'timeout',
  'server-error',
  'network',
  'storage',
  'integrity',
] as const;

/** Maps error category to an error message that triggers the category classification. */
const errorMessageMap: Record<string, string> = {
  'unreachable': 'ENOTFOUND: getaddrinfo ENOTFOUND github.com',
  'timeout': 'ETIMEDOUT: connection timed out',
  'server-error': 'HTTP 500 server error',
  'network': 'network connection lost',
  'storage': 'ENOSPC: no space left on device',
  'integrity': 'integrity check failed: hash mismatch',
};

/** Generates a random error category. */
const arbErrorCategory = fc.constantFrom(...errorCategories);

/** States from which errors can occur during the update lifecycle. */
const errorStates = ['checking', 'downloading'] as const;

/** Generates a random state from which an error can occur. */
const arbErrorState = fc.constantFrom(...errorStates);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 5: Errors return to previous actionable state', () => {
  beforeEach(() => {
    // Clear event handlers between tests
    Object.keys(eventHandlers).forEach((k) => delete eventHandlers[k]);
  });

  test('errors during checking → idle; errors during downloading → available (property)', () => {
    fc.assert(
      fc.property(arbErrorCategory, arbErrorState, (errorCategory, errorState) => {
        // Reset event handlers and create fresh service for each iteration
        Object.keys(eventHandlers).forEach((k) => delete eventHandlers[k]);
        const svc = new AutoUpdateService();

        // Get the error handler that was registered during construction
        const errorHandler = eventHandlers['error'];
        expect(errorHandler).toBeDefined();

        if (errorState === 'checking') {
          // Trigger checkForUpdate to enter 'checking' state
          void svc.checkForUpdate('manual');

          // Verify we're in checking state
          expect(svc.getState().status).toBe('checking');

          // Trigger the error
          const errorMsg = errorMessageMap[errorCategory];
          errorHandler(new Error(errorMsg));

          // After error during checking → should be idle
          const state = svc.getState();
          expect(state.status).toBe('idle');
          expect(state.status).not.toBe('checking');
        } else {
          // errorState === 'downloading'
          // First, simulate reaching 'available' state via the update-available event
          void svc.checkForUpdate('manual');

          // Trigger update-available event to move to 'available'
          const updateAvailableHandler = eventHandlers['update-available'];
          if (updateAvailableHandler) {
            updateAvailableHandler({ version: '2.0.0', releaseNotes: 'New version' });
          }

          expect(svc.getState().status).toBe('available');

          // Now trigger downloadUpdate to enter 'downloading' state
          void svc.downloadUpdate();

          expect(svc.getState().status).toBe('downloading');

          // Trigger the error
          const errorMsg = errorMessageMap[errorCategory];
          errorHandler(new Error(errorMsg));

          // After error during downloading → should be available
          const state = svc.getState();
          expect(state.status).toBe('available');
          expect(state.status).not.toBe('downloading');
        }
      }),
      { numRuns: 100 },
    );
  });

  test('state machine never remains stuck in checking or downloading after any error', () => {
    fc.assert(
      fc.property(arbErrorCategory, arbErrorState, (errorCategory, errorState) => {
        // Reset and create fresh service
        Object.keys(eventHandlers).forEach((k) => delete eventHandlers[k]);
        const svc = new AutoUpdateService();

        const errorHandler = eventHandlers['error'];
        expect(errorHandler).toBeDefined();

        if (errorState === 'checking') {
          void svc.checkForUpdate('manual');
        } else {
          // Get to downloading state
          void svc.checkForUpdate('manual');
          const updateAvailableHandler = eventHandlers['update-available'];
          if (updateAvailableHandler) {
            updateAvailableHandler({ version: '2.0.0', releaseNotes: '' });
          }
          void svc.downloadUpdate();
        }

        // Trigger error
        const errorMsg = errorMessageMap[errorCategory];
        errorHandler(new Error(errorMsg));

        // The key property: state is NEVER stuck in checking or downloading
        const finalStatus = svc.getState().status;
        expect(finalStatus).not.toBe('checking');
        expect(finalStatus).not.toBe('downloading');
      }),
      { numRuns: 100 },
    );
  });

  test('error state includes error information with correct stage', () => {
    fc.assert(
      fc.property(arbErrorCategory, arbErrorState, (errorCategory, errorState) => {
        Object.keys(eventHandlers).forEach((k) => delete eventHandlers[k]);
        const svc = new AutoUpdateService();

        const errorHandler = eventHandlers['error'];
        expect(errorHandler).toBeDefined();

        if (errorState === 'checking') {
          void svc.checkForUpdate('manual');
        } else {
          void svc.checkForUpdate('manual');
          const updateAvailableHandler = eventHandlers['update-available'];
          if (updateAvailableHandler) {
            updateAvailableHandler({ version: '2.0.0', releaseNotes: 'notes' });
          }
          void svc.downloadUpdate();
        }

        const errorMsg = errorMessageMap[errorCategory];
        errorHandler(new Error(errorMsg));

        const state = svc.getState();
        // Error info should be populated
        expect(state.error).not.toBeNull();
        if (state.error) {
          // Stage should match the state we were in
          const expectedStage = errorState === 'checking' ? 'check' : 'download';
          expect(state.error.stage).toBe(expectedStage);
        }
      }),
      { numRuns: 100 },
    );
  });
});
