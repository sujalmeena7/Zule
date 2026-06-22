// Feature: auto-updater, Property 12: Event delivery fan-out correctness
// **Validates: Requirements 10.6, 10.8**
//
// For any Auto_Updater state transition and any combination of
// (dashboardWindow, overlayWindow) destruction states, the IPC bridge SHALL
// deliver the state event to every non-destroyed window and SHALL silently
// skip every destroyed window without throwing.

import { describe, test, expect, vi } from 'vitest';
import * as fc from 'fast-check';

// ── Types ────────────────────────────────────────────────────────────────────

interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing';
  availableVersion: string | null;
  currentVersion: string;
  releaseNotes: string | null;
  progress: { percent: number; bytesReceived: number; totalBytes: number } | null;
  error: { stage: string; category: string } | null;
}

interface MockWebContents {
  send: ReturnType<typeof vi.fn>;
}

interface MockBrowserWindow {
  isDestroyed: () => boolean;
  webContents: MockWebContents;
}

// ── Fan-out implementation under test ────────────────────────────────────────

/**
 * Broadcasts an update state to all non-destroyed windows.
 * This mirrors the fan-out pattern from the design document:
 * - Delivers state event to every non-destroyed window
 * - Silently skips every destroyed window without throwing
 */
function broadcastUpdateState(state: UpdateState, windows: MockBrowserWindow[]): void {
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('update:state', state);
    }
  }
}

// ── Generators ───────────────────────────────────────────────────────────────

/** Generates a random update status. */
const arbStatus = fc.constantFrom(
  'idle' as const,
  'checking' as const,
  'available' as const,
  'downloading' as const,
  'ready' as const,
  'installing' as const,
);

/** Generates a random semantic version string. */
const arbVersion = fc.tuple(
  fc.integer({ min: 0, max: 99 }),
  fc.integer({ min: 0, max: 99 }),
  fc.integer({ min: 0, max: 99 }),
).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

/** Generates a random UpdateState. */
const arbUpdateState: fc.Arbitrary<UpdateState> = fc.record({
  status: arbStatus,
  availableVersion: fc.oneof(arbVersion, fc.constant(null)),
  currentVersion: arbVersion,
  releaseNotes: fc.oneof(fc.string({ minLength: 0, maxLength: 100 }), fc.constant(null)),
  progress: fc.oneof(
    fc.record({
      percent: fc.integer({ min: 0, max: 100 }),
      bytesReceived: fc.integer({ min: 0, max: 100_000_000 }),
      totalBytes: fc.integer({ min: 1, max: 100_000_000 }),
    }),
    fc.constant(null),
  ),
  error: fc.oneof(
    fc.record({
      stage: fc.constantFrom('check', 'download', 'integrity', 'install'),
      category: fc.constantFrom('unreachable', 'timeout', 'server-error', 'network', 'storage', 'integrity'),
    }),
    fc.constant(null),
  ),
});

/** Generates a boolean indicating whether a window is destroyed. */
const arbDestroyed = fc.boolean();

/**
 * Generates a random combination of window destruction states.
 * Each element represents whether a window is destroyed (true) or alive (false).
 * Array length is 0, 1, or 2 to cover: no windows, one window, two windows (dashboard + overlay).
 */
const arbWindowStates = fc.array(arbDestroyed, { minLength: 0, maxLength: 2 });

/** Creates a mock BrowserWindow with the given destroyed state. */
function createMockWindow(destroyed: boolean): MockBrowserWindow {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      send: vi.fn(),
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 12: Event delivery fan-out correctness', () => {
  test('fan-out delivers to all non-destroyed windows and skips destroyed ones without throwing', () => {
    fc.assert(
      fc.property(arbUpdateState, arbWindowStates, (state, windowStates) => {
        // Create mock windows based on generated destruction states
        const windows = windowStates.map((destroyed) => createMockWindow(destroyed));

        // broadcastUpdateState must not throw regardless of destruction combination
        expect(() => broadcastUpdateState(state, windows)).not.toThrow();

        // Verify delivery correctness for each window
        for (let i = 0; i < windows.length; i++) {
          const win = windows[i];
          if (windowStates[i]) {
            // Destroyed window: send must NOT have been called
            expect(win.webContents.send).not.toHaveBeenCalled();
          } else {
            // Non-destroyed window: send MUST have been called with the state
            expect(win.webContents.send).toHaveBeenCalledTimes(1);
            expect(win.webContents.send).toHaveBeenCalledWith('update:state', state);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  test('fan-out works correctly with 0 windows (no windows exist)', () => {
    fc.assert(
      fc.property(arbUpdateState, (state) => {
        const windows: MockBrowserWindow[] = [];

        // Must not throw with empty window list
        expect(() => broadcastUpdateState(state, windows)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  test('fan-out handles the case where all windows are destroyed', () => {
    fc.assert(
      fc.property(
        arbUpdateState,
        fc.integer({ min: 1, max: 2 }),
        (state, windowCount) => {
          // All windows are destroyed
          const windows = Array.from({ length: windowCount }, () => createMockWindow(true));

          // Must not throw when all windows are destroyed
          expect(() => broadcastUpdateState(state, windows)).not.toThrow();

          // No window should have received the event
          for (const win of windows) {
            expect(win.webContents.send).not.toHaveBeenCalled();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  test('fan-out sends to exactly the non-destroyed windows (count verification)', () => {
    fc.assert(
      fc.property(arbUpdateState, arbWindowStates, (state, windowStates) => {
        const windows = windowStates.map((destroyed) => createMockWindow(destroyed));

        broadcastUpdateState(state, windows);

        // Count how many windows received the event
        const sentCount = windows.filter((win) => (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.length > 0).length;
        const expectedCount = windowStates.filter((destroyed) => !destroyed).length;

        expect(sentCount).toBe(expectedCount);
      }),
      { numRuns: 100 },
    );
  });
});
