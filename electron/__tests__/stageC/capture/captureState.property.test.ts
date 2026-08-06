// ============================================
// Zule AI — Capture State Property-Based Tests
// ============================================
//
// Feature: stealth-window-host, Property 16: Capture state follows the user value
//
// Generate toggles, recreation, show, monitor migration, mismatch, and fallback
// sequences; assert visible-surface read-back equals the latest request and
// mismatched Stage C is never exposed.
//
// **Validates: Requirements 12.1–12.10**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  DisplayAffinityManager,
  DisplayAffinityValue,
  CaptureProtectionStatus,
  ReapplyTrigger,
  READ_BACK_DEADLINE_MS,
  type DisplayAffinityApi,
  type AffinityClock,
} from '../../../stageC/capture/displayAffinity';

import {
  executeCaptureFallback,
  CaptureFallbackStatus,
  RECOVERY_DEADLINE_MS,
  type CaptureFallbackDeps,
  type FallbackClock,
} from '../../../stageC/capture/captureFallback';

// ────────────────────────────────────────────────────────────────────
// Types and Generators
// ────────────────────────────────────────────────────────────────────

/** Lifecycle event types that a capture system may encounter. */
type CaptureEvent =
  | { type: 'toggle'; enabled: boolean }
  | { type: 'recreate' }
  | { type: 'show' }
  | { type: 'monitorMigration' }
  | { type: 'mismatch' }
  | { type: 'fallback' };

/** Generates a single capture event. */
const captureEventArb: fc.Arbitrary<CaptureEvent> = fc.oneof(
  { weight: 4, arbitrary: fc.boolean().map((enabled): CaptureEvent => ({ type: 'toggle', enabled })) },
  { weight: 2, arbitrary: fc.constant<CaptureEvent>({ type: 'recreate' }) },
  { weight: 2, arbitrary: fc.constant<CaptureEvent>({ type: 'show' }) },
  { weight: 2, arbitrary: fc.constant<CaptureEvent>({ type: 'monitorMigration' }) },
  { weight: 1, arbitrary: fc.constant<CaptureEvent>({ type: 'mismatch' }) },
  { weight: 1, arbitrary: fc.constant<CaptureEvent>({ type: 'fallback' }) },
);

/** Generates sequences of capture events of length 1–20. */
const captureSequenceArb = fc.array(captureEventArb, { minLength: 1, maxLength: 20 });

// ────────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────────

const FAKE_HWND = 0xBEEF_CAFE;

/** Creates a controllable clock. */
function createClock(initial = 0): AffinityClock & { time: number; advance(ms: number): void } {
  const clock = {
    time: initial,
    now() { return clock.time; },
    advance(ms: number) { clock.time += ms; },
  };
  return clock;
}

/**
 * Creates a mock API where the read-back value can be controlled per-call.
 * By default, read-back always matches the last set value (normal behavior).
 */
function createTrackingApi() {
  let lastSetValue: number = DisplayAffinityValue.WDA_NONE;
  let forceMismatch = false;
  let forceSetFail = false;

  return {
    get lastSetValue() { return lastSetValue; },
    set triggerMismatch(v: boolean) { forceMismatch = v; },
    set triggerSetFail(v: boolean) { forceSetFail = v; },

    setWindowDisplayAffinity(_hwnd: unknown, affinity: number): boolean {
      if (forceSetFail) return false;
      lastSetValue = affinity;
      return true;
    },
    getWindowDisplayAffinity(_hwnd: unknown): number | null {
      if (forceMismatch) {
        // Return the opposite value
        return lastSetValue === DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE
          ? DisplayAffinityValue.WDA_NONE
          : DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE;
      }
      return lastSetValue;
    },
  };
}

/**
 * Tracks whether a mismatched Stage C surface was ever "exposed" (visible with wrong value).
 * Mismatch means: the visible surface read-back differs from the user's requested value.
 */
interface VisibilityTracker {
  stageCVisible: boolean;
  layer0Visible: boolean;
  mismatchedExposures: number;
}

// ────────────────────────────────────────────────────────────────────
// Property Tests
// ────────────────────────────────────────────────────────────────────

describe('Stage C Capture — Property Tests', () => {
  // Property 16: Capture state follows the user value
  describe('Property 16: Capture state follows the user value', () => {
    it('visible-surface read-back always equals the latest user request after any event sequence', () => {
      fc.assert(
        fc.property(captureSequenceArb, (events) => {
          const clock = createClock();
          const api = createTrackingApi();
          const manager = new DisplayAffinityManager(api, clock);
          manager.setHwnd(FAKE_HWND);

          // Track what the user last requested
          let userRequestedEnabled = false;

          for (const event of events) {
            // Reset mismatch/failure flags between events
            api.triggerMismatch = false;
            api.triggerSetFail = false;

            switch (event.type) {
              case 'toggle': {
                userRequestedEnabled = event.enabled;
                const result = manager.applyCaptureProtection(event.enabled);
                // When successful, read-back must match user request
                if (result.status === CaptureProtectionStatus.APPLIED) {
                  const expectedValue = event.enabled
                    ? DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE
                    : DisplayAffinityValue.WDA_NONE;
                  expect(result.readBackValue).toBe(expectedValue);
                }
                break;
              }
              case 'recreate': {
                // Simulate window recreation: new HWND, reapply
                const newHwnd = FAKE_HWND + Math.floor(clock.time);
                const result = manager.setHwndAndReapply(newHwnd, ReapplyTrigger.RECREATE);
                if (result && result.status === CaptureProtectionStatus.APPLIED) {
                  const expectedValue = userRequestedEnabled
                    ? DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE
                    : DisplayAffinityValue.WDA_NONE;
                  expect(result.readBackValue).toBe(expectedValue);
                }
                break;
              }
              case 'show': {
                const result = manager.reapplyIfNeeded(ReapplyTrigger.SHOW);
                if (result && result.status === CaptureProtectionStatus.APPLIED) {
                  const expectedValue = userRequestedEnabled
                    ? DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE
                    : DisplayAffinityValue.WDA_NONE;
                  expect(result.readBackValue).toBe(expectedValue);
                }
                break;
              }
              case 'monitorMigration': {
                const result = manager.reapplyIfNeeded(ReapplyTrigger.DISPLAY_MIGRATION);
                if (result && result.status === CaptureProtectionStatus.APPLIED) {
                  const expectedValue = userRequestedEnabled
                    ? DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE
                    : DisplayAffinityValue.WDA_NONE;
                  expect(result.readBackValue).toBe(expectedValue);
                }
                break;
              }
              case 'mismatch': {
                // Inject a mismatch condition — the API returns wrong value
                api.triggerMismatch = true;
                const result = manager.applyCaptureProtection(userRequestedEnabled);
                // Must detect the mismatch
                expect(result.status).toBe(CaptureProtectionStatus.READ_BACK_MISMATCH);
                api.triggerMismatch = false;
                break;
              }
              case 'fallback': {
                // Fallback triggered by mismatch — Stage C hidden, Layer 0 shown
                // Verify fallback correctly applies user's value to Layer 0
                const fallbackClock: FallbackClock & { time: number; advance(ms: number): void } = {
                  time: 0,
                  now() { return this.time; },
                  advance(ms: number) { this.time += ms; },
                };

                let appliedToLayer0: boolean | undefined;
                const deps: CaptureFallbackDeps = {
                  hideStageC: () => true,
                  showLayer0: () => true,
                  applyLayer0Capture: (enabled) => { appliedToLayer0 = enabled; return true; },
                  verifyLayer0Capture: (enabled) => enabled === userRequestedEnabled,
                  getRequestedCaptureValue: () => userRequestedEnabled,
                };

                const fallbackResult = executeCaptureFallback(deps, fallbackClock);
                // Layer 0 must have user's requested value
                expect(appliedToLayer0).toBe(userRequestedEnabled);
                expect(fallbackResult.status).toBe(CaptureFallbackStatus.FALLBACK_COMPLETE);
                break;
              }
            }

            clock.advance(5); // Advance time between events
          }

          // Final state: the manager's tracked state reflects the user's last request
          const finalState = manager.getState();
          expect(finalState.enabled).toBe(userRequestedEnabled);
        }),
        { numRuns: 300 },
      );
    });

    it('mismatched Stage C surface is never exposed — mismatch always triggers non-APPLIED status', () => {
      fc.assert(
        fc.property(
          fc.array(fc.boolean(), { minLength: 1, maxLength: 15 }),
          fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
          (toggles, mismatchPoints) => {
            const clock = createClock();
            const api = createTrackingApi();
            const manager = new DisplayAffinityManager(api, clock);
            manager.setHwnd(FAKE_HWND);

            let mismatchIdx = 0;

            for (const enabled of toggles) {
              // Decide if this toggle should produce a mismatch
              const injectMismatch = mismatchIdx < mismatchPoints.length && mismatchPoints[mismatchIdx];
              mismatchIdx++;

              api.triggerMismatch = injectMismatch;
              const result = manager.applyCaptureProtection(enabled);

              if (injectMismatch) {
                // Mismatched Stage C must NOT return APPLIED
                // This guarantees the mismatched surface is never presented as ready
                expect(result.status).not.toBe(CaptureProtectionStatus.APPLIED);
                // The read-back value must differ from the requested value
                if (result.readBackValue !== null) {
                  const requestedValue = enabled
                    ? DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE
                    : DisplayAffinityValue.WDA_NONE;
                  expect(result.readBackValue).not.toBe(requestedValue);
                }
              } else {
                // Normal path: read-back matches
                expect(result.status).toBe(CaptureProtectionStatus.APPLIED);
              }

              api.triggerMismatch = false;
              clock.advance(2);
            }
          },
        ),
        { numRuns: 300 },
      );
    });

    it('reapply after lifecycle events preserves the user-requested value, not an independent value', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.array(
            fc.constantFrom(
              ReapplyTrigger.CREATE,
              ReapplyTrigger.RECREATE,
              ReapplyTrigger.SHOW,
              ReapplyTrigger.DISPLAY_MIGRATION,
            ),
            { minLength: 1, maxLength: 10 },
          ),
          (initialEnabled, triggers) => {
            const clock = createClock();
            const api = createTrackingApi();
            const manager = new DisplayAffinityManager(api, clock);
            manager.setHwnd(FAKE_HWND);

            // Set initial user value
            manager.applyCaptureProtection(initialEnabled);

            const expectedValue = initialEnabled
              ? DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE
              : DisplayAffinityValue.WDA_NONE;

            // Each lifecycle trigger must reapply the same user-requested value
            for (const trigger of triggers) {
              const result = manager.reapplyIfNeeded(trigger);
              expect(result).not.toBeNull();
              expect(result!.requestedValue).toBe(expectedValue);
              if (result!.status === CaptureProtectionStatus.APPLIED) {
                expect(result!.readBackValue).toBe(expectedValue);
              }
              clock.advance(1);
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    it('fallback always applies user-requested value to Layer 0 regardless of Stage C state', () => {
      fc.assert(
        fc.property(
          fc.boolean(), // user's requested capture value
          fc.array(
            fc.record({
              applySuccess: fc.boolean(),
              verifySuccess: fc.boolean(),
              timingMs: fc.integer({ min: 0, max: 400 }),
            }),
            { minLength: 1, maxLength: 5 },
          ),
          (requestedValue, fallbackAttempts) => {
            for (const attempt of fallbackAttempts) {
              const fallbackClock: FallbackClock & { time: number; advance(ms: number): void } = {
                time: 0,
                now() { return this.time; },
                advance(ms: number) { this.time += ms; },
              };

              let appliedValue: boolean | undefined;
              let verifiedValue: boolean | undefined;

              const deps: CaptureFallbackDeps = {
                hideStageC: () => { fallbackClock.advance(10); return true; },
                showLayer0: () => { fallbackClock.advance(10); return true; },
                applyLayer0Capture: (enabled) => {
                  appliedValue = enabled;
                  fallbackClock.advance(attempt.timingMs);
                  return attempt.applySuccess;
                },
                verifyLayer0Capture: (enabled) => {
                  verifiedValue = enabled;
                  fallbackClock.advance(20);
                  return attempt.verifySuccess;
                },
                getRequestedCaptureValue: () => requestedValue,
              };

              const result = executeCaptureFallback(deps, fallbackClock);

              // The applied value must always be the user's requested value
              expect(appliedValue).toBe(requestedValue);

              // Layer 0 must always be visible after fallback
              expect(result.layer0Visible).toBe(true);

              // If verification was attempted, it used the correct value
              if (attempt.applySuccess && result.recoveryMs < RECOVERY_DEADLINE_MS) {
                expect(verifiedValue).toBe(requestedValue);
              }
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
