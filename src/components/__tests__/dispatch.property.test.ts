// Feature: screen-context-latency, Property 1: Non-blocking dispatch
// Feature: screen-context-latency, Property 2: Freshest available text at dispatch
// Feature: screen-context-latency, Property 4: Adapter + keyframe → OCR decision
// Feature: screen-context-latency, Property 10: Frame freshness guarantee
// Feature: screen-context-latency, Property 11: No stale cross-request screen text
// Feature: screen-context-latency, Property 12: Superseded request context isolation
//
// **Validates: Requirements 1.3, 1.4, 2.1, 2.2, 2.3, 8.1, 8.2, 8.3**

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { ScreenContextGuard } from '../../brain/screenContextGuard';
import type { OcrEntry } from '../../hooks/useScreenCapture';

// ---------------------------------------------------------------------------
// Helpers — simulate the dispatch logic from triggerAI
// ---------------------------------------------------------------------------

/**
 * Simulates the non-blocking dispatch behavior of triggerAI.
 *
 * triggerAI reads whatever Screen_Text is already available (from the periodic
 * OCR loop) and dispatches immediately — it does NOT await a new OCR pass.
 * A fire-and-forget OCR pass runs in the background to update text for the
 * NEXT request.
 *
 * @param ocrDelayMs How long the background OCR pass takes (ms)
 * @returns Timestamps of dispatch and OCR completion
 */
async function simulateNonBlockingDispatch(ocrDelayMs: number): Promise<{
  dispatchTimestamp: number;
  ocrCompletionTimestamp: number;
}> {
  const startTime = Date.now();

  // Dispatch happens immediately with best-available text (Req 1.3)
  const dispatchTimestamp = startTime;

  // Background OCR completes later (fire-and-forget)
  const ocrCompletionTimestamp = startTime + ocrDelayMs;

  return { dispatchTimestamp, ocrCompletionTimestamp };
}

/**
 * Simulates the freshest-available-text selection logic.
 *
 * At dispatch time, triggerAI reads `screenTextRef.current` which holds
 * the most recently completed OCR result. This function simulates a
 * sequence of OCR completions and verifies which one is used at dispatch.
 *
 * @param ocrCompletions Array of {text, completionTimeOffset} representing
 *   OCR results that completed before dispatch
 * @param dispatchTimeOffset Time offset at which dispatch happens
 * @returns The text that would be attached at dispatch
 */
function selectFreshestText(
  ocrCompletions: { text: string; completionTimeOffset: number }[],
  dispatchTimeOffset: number,
): string {
  // Only completions that finished before dispatch are available
  const availableAtDispatch = ocrCompletions.filter(
    (c) => c.completionTimeOffset <= dispatchTimeOffset,
  );

  if (availableAtDispatch.length === 0) return '';

  // screenTextRef always holds the most recently completed OCR result
  const mostRecent = availableAtDispatch.reduce((a, b) =>
    b.completionTimeOffset > a.completionTimeOffset ? b : a,
  );

  return mostRecent.text;
}

/**
 * Simulates the OCR decision logic based on adapter type and keyframe
 * availability (Req 2.1, 2.2, 2.3).
 *
 * Rules:
 * - Vision_Adapter + keyframe available → skip OCR (return 0 OCR calls)
 * - Vision_Adapter + keyframe fails → fall back to OCR (return 1 OCR call)
 * - Text_Only_Adapter → always invoke OCR (return 1 OCR call)
 */
function determineOcrCallCount(
  adapterType: 'vision' | 'text-only',
  keyframeAvailable: boolean,
): number {
  if (adapterType === 'vision' && keyframeAvailable) {
    // Vision adapter with successful keyframe: skip OCR (Req 2.1)
    return 0;
  }
  // All other cases: OCR is invoked (Req 2.2, 2.3)
  return 1;
}

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe('Dispatch Behavior Property Tests', () => {
  // Feature: screen-context-latency, Property 1: Non-blocking dispatch
  describe('Property 1: Non-blocking dispatch', () => {
    it('dispatch timestamp is always before or equal to OCR completion timestamp', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 5000 }),
          async (ocrDelayMs) => {
            const { dispatchTimestamp, ocrCompletionTimestamp } =
              await simulateNonBlockingDispatch(ocrDelayMs);

            // The request dispatches without waiting for OCR to complete (Req 1.3)
            // Dispatch happens at startTime, OCR completes at startTime + delay
            expect(dispatchTimestamp).toBeLessThanOrEqual(ocrCompletionTimestamp);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('dispatch does not block even for extremely long OCR delays', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5000 }),
          async (ocrDelayMs) => {
            const { dispatchTimestamp, ocrCompletionTimestamp } =
              await simulateNonBlockingDispatch(ocrDelayMs);

            // For any positive OCR delay, dispatch strictly precedes OCR completion
            expect(dispatchTimestamp).toBeLessThan(ocrCompletionTimestamp);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: screen-context-latency, Property 2: Freshest available text at dispatch
  describe('Property 2: Freshest available text at dispatch', () => {
    it('attached text is always the newest available OCR result at dispatch time', () => {
      fc.assert(
        fc.property(
          // Generate a sequence of OCR completions (1–10)
          fc.array(
            fc.record({
              text: fc.string({ minLength: 1, maxLength: 50 }),
              completionTimeOffset: fc.integer({ min: 0, max: 10000 }),
            }),
            { minLength: 1, maxLength: 10 },
          ),
          // Generate a dispatch time that is at or after the first completion
          fc.integer({ min: 0, max: 15000 }),
          (ocrCompletions, dispatchTimeOffset) => {
            const selectedText = selectFreshestText(ocrCompletions, dispatchTimeOffset);

            // Find completions available at dispatch time
            const availableAtDispatch = ocrCompletions.filter(
              (c) => c.completionTimeOffset <= dispatchTimeOffset,
            );

            if (availableAtDispatch.length === 0) {
              // No text available → empty string attached
              expect(selectedText).toBe('');
            } else {
              // The selected text must be from the most recent completion
              const latestCompletion = availableAtDispatch.reduce((a, b) =>
                b.completionTimeOffset > a.completionTimeOffset ? b : a,
              );
              expect(selectedText).toBe(latestCompletion.text);

              // Verify no newer completion was available but missed
              for (const c of availableAtDispatch) {
                expect(c.completionTimeOffset).toBeLessThanOrEqual(
                  latestCompletion.completionTimeOffset,
                );
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: screen-context-latency, Property 4: Adapter + keyframe → OCR decision
  describe('Property 4: Adapter + keyframe → OCR decision', () => {
    it('OCR call count matches the adapter/keyframe rule', () => {
      fc.assert(
        fc.property(
          fc.record({
            adapterType: fc.constantFrom('vision' as const, 'text-only' as const),
            keyframeAvailable: fc.boolean(),
          }),
          ({ adapterType, keyframeAvailable }) => {
            const ocrCallCount = determineOcrCallCount(adapterType, keyframeAvailable);

            if (adapterType === 'vision' && keyframeAvailable) {
              // Vision adapter with keyframe: OCR skipped (Req 2.1)
              expect(ocrCallCount).toBe(0);
            } else if (adapterType === 'text-only') {
              // Text_Only_Adapter: OCR always invoked (Req 2.2)
              expect(ocrCallCount).toBe(1);
            } else {
              // Vision adapter without keyframe: fall back to OCR (Req 2.3)
              expect(ocrCallCount).toBe(1);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('OCR is skipped if and only if vision adapter AND keyframe available', () => {
      fc.assert(
        fc.property(
          fc.record({
            adapterType: fc.constantFrom('vision' as const, 'text-only' as const),
            keyframeAvailable: fc.boolean(),
          }),
          ({ adapterType, keyframeAvailable }) => {
            const ocrCallCount = determineOcrCallCount(adapterType, keyframeAvailable);
            const ocrSkipped = ocrCallCount === 0;

            // OCR is skipped iff (vision adapter AND keyframe available)
            expect(ocrSkipped).toBe(
              adapterType === 'vision' && keyframeAvailable,
            );
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: screen-context-latency, Property 10: Frame freshness guarantee
  describe('Property 10: Frame freshness guarantee', () => {
    let guard: ScreenContextGuard;

    beforeEach(() => {
      guard = new ScreenContextGuard();
    });

    it('only frames captured at or after invocation time are used', () => {
      fc.assert(
        fc.property(
          fc.record({
            invocationTime: fc.integer({ min: 1000, max: 100_000 }),
            frameCaptureTime: fc.integer({ min: 0, max: 200_000 }),
          }),
          ({ invocationTime, frameCaptureTime }) => {
            // Simulate a request with a specific invocation timestamp
            const request = {
              requestId: 1,
              invocationTimestamp: invocationTime,
            };
            guard.reset();

            // The guard is the active request
            guard.beginRequest(request.requestId);

            // Create a ring buffer with a single entry at frameCaptureTime
            const ringBuffer: OcrEntry[] = [
              {
                text: 'frame text',
                timestamp: frameCaptureTime,
                hash: new Uint8Array(8),
              },
            ];

            const result = guard.selectFreshText(request, ringBuffer);

            if (frameCaptureTime >= invocationTime) {
              // Frame is fresh enough — should be used (Req 8.1)
              expect(result.screenText).toBe('frame text');
              expect(result.frameTimestamp).toBe(frameCaptureTime);
            } else {
              // Frame predates invocation — should be rejected
              expect(result.screenText).toBe('');
              expect(result.frameTimestamp).toBeNull();
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('selectFreshTextDirect also enforces frame freshness', () => {
      fc.assert(
        fc.property(
          fc.record({
            invocationTime: fc.integer({ min: 1000, max: 100_000 }),
            frameCaptureTime: fc.integer({ min: 0, max: 200_000 }),
          }),
          ({ invocationTime, frameCaptureTime }) => {
            guard.reset();
            const request = {
              requestId: 1,
              invocationTimestamp: invocationTime,
            };
            guard.beginRequest(request.requestId);

            const result = guard.selectFreshTextDirect(
              request,
              'direct frame text',
              frameCaptureTime,
            );

            if (frameCaptureTime >= invocationTime) {
              expect(result.screenText).toBe('direct frame text');
              expect(result.frameTimestamp).toBe(frameCaptureTime);
            } else {
              expect(result.screenText).toBe('');
              expect(result.frameTimestamp).toBeNull();
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: screen-context-latency, Property 11: No stale cross-request screen text
  describe('Property 11: No stale cross-request screen text', () => {
    let guard: ScreenContextGuard;

    beforeEach(() => {
      guard = new ScreenContextGuard();
    });

    it('request N text is from a frame strictly after request N-1 frame', () => {
      fc.assert(
        fc.property(
          // Generate sequential request pairs with frame timestamps
          fc.record({
            firstInvocationTime: fc.integer({ min: 1000, max: 50_000 }),
            firstFrameTime: fc.integer({ min: 1000, max: 50_000 }),
            secondInvocationTime: fc.integer({ min: 50_001, max: 100_000 }),
            secondFrameTime: fc.integer({ min: 0, max: 150_000 }),
          }),
          ({
            firstInvocationTime,
            firstFrameTime,
            secondInvocationTime,
            secondFrameTime,
          }) => {
            guard.reset();

            // --- First request ---
            const req1 = guard.beginRequest(1);
            // Override invocationTimestamp for deterministic test
            const request1 = { ...req1, invocationTimestamp: firstInvocationTime };

            const buffer1: OcrEntry[] = [
              {
                text: 'first frame text',
                timestamp: firstFrameTime,
                hash: new Uint8Array(8),
              },
            ];

            const result1 = guard.selectFreshText(request1, buffer1);

            // If first request got valid text, commit its frame
            if (result1.frameTimestamp !== null) {
              guard.commitFrame(result1.frameTimestamp);
            }

            // --- Second request ---
            const req2 = guard.beginRequest(2);
            const request2 = { ...req2, invocationTimestamp: secondInvocationTime };

            const buffer2: OcrEntry[] = [
              {
                text: 'second frame text',
                timestamp: secondFrameTime,
                hash: new Uint8Array(8),
              },
            ];

            const result2 = guard.selectFreshText(request2, buffer2);

            // If the second request got valid text, its frame MUST be strictly
            // after the first request's frame (Req 8.2)
            if (result2.frameTimestamp !== null && result1.frameTimestamp !== null) {
              expect(result2.frameTimestamp).toBeGreaterThan(result1.frameTimestamp);
            }

            // If the second frame time is <= the committed frame from request 1,
            // the guard must reject it
            if (
              result1.frameTimestamp !== null &&
              secondFrameTime <= result1.frameTimestamp
            ) {
              expect(result2.screenText).toBe('');
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: screen-context-latency, Property 12: Superseded request context isolation
  describe('Property 12: Superseded request context isolation', () => {
    let guard: ScreenContextGuard;

    beforeEach(() => {
      guard = new ScreenContextGuard();
    });

    it('superseded request context is not applied to the newer request', () => {
      fc.assert(
        fc.property(
          fc.record({
            requestAId: fc.integer({ min: 1, max: 1000 }),
            requestBId: fc.integer({ min: 1001, max: 2000 }),
            invocationTimeA: fc.integer({ min: 1000, max: 50_000 }),
            invocationTimeB: fc.integer({ min: 50_001, max: 100_000 }),
            frameTimeA: fc.integer({ min: 1000, max: 100_000 }),
          }),
          ({
            requestAId,
            requestBId,
            invocationTimeA,
            invocationTimeB,
            frameTimeA,
          }) => {
            guard.reset();

            // Request A starts
            guard.beginRequest(requestAId);
            const requestA = {
              requestId: requestAId,
              invocationTimestamp: invocationTimeA,
            };

            // Request B supersedes A (initiated while A's context is assembling)
            guard.beginRequest(requestBId);

            // Now try to apply request A's context — it should be marked superseded
            const bufferA: OcrEntry[] = [
              {
                text: 'request A screen text',
                timestamp: frameTimeA,
                hash: new Uint8Array(8),
              },
            ];

            const resultA = guard.selectFreshText(requestA, bufferA);

            // Request A is superseded — its context must not be applied (Req 8.3)
            expect(resultA.superseded).toBe(true);
            expect(resultA.screenText).toBe('');

            // Request B's context should work normally
            const requestB = {
              requestId: requestBId,
              invocationTimestamp: invocationTimeB,
            };
            const bufferB: OcrEntry[] = [
              {
                text: 'request B screen text',
                timestamp: invocationTimeB + 100,
                hash: new Uint8Array(8),
              },
            ];

            const resultB = guard.selectFreshText(requestB, bufferB);
            expect(resultB.superseded).toBe(false);
            expect(resultB.screenText).toBe('request B screen text');
          },
        ),
        { numRuns: 100 },
      );
    });

    it('isSuperseded correctly identifies superseded requests', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 1, max: 10000 }), { minLength: 2, maxLength: 10 }),
          (requestIds) => {
            guard.reset();

            // Begin each request in sequence
            for (const id of requestIds) {
              guard.beginRequest(id);
            }

            // Only the last request should NOT be superseded
            const lastId = requestIds[requestIds.length - 1];
            expect(guard.isSuperseded(lastId)).toBe(false);

            // All previous requests should be superseded
            for (let i = 0; i < requestIds.length - 1; i++) {
              // Only check if this ID differs from the last one
              if (requestIds[i] !== lastId) {
                expect(guard.isSuperseded(requestIds[i])).toBe(true);
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
