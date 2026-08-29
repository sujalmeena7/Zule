// Feature: screen-context-latency, Property 3: In-flight OCR deduplication
// Feature: screen-context-latency, Property 5: Worker initialization deduplication
// Feature: screen-context-latency, Property 6: Idle grace period worker reuse
//
// **Validates: Requirements 1.5, 3.2, 3.3, 3.4**

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

// Mock tesseract.js before importing the module under test
const mockRecognize = vi.fn();
const mockTerminate = vi.fn();
const mockCreateWorker = vi.fn();

vi.mock('tesseract.js', () => ({
  createWorker: (...args: unknown[]) => mockCreateWorker(...args),
}));

vi.mock('../../brain/modelDownloadRegistry', () => ({
  modelDownloadRegistry: {
    upsert: vi.fn(),
  },
}));

import {
  getOcrWorker,
  recognizeTextDeduped,
  terminateOcrWorker,
  warmOcrWorker,
  scheduleIdleTermination,
  configureOcrService,
  _resetDedupState,
} from '../ocrWorker';

describe('OCR Service Property Tests', () => {
  beforeEach(async () => {
    vi.useFakeTimers();

    // Terminate any existing worker and reset dedup state
    await terminateOcrWorker();
    _resetDedupState();

    // Reset mocks
    mockRecognize.mockReset();
    mockTerminate.mockReset();
    mockCreateWorker.mockReset();

    // Default mock: createWorker resolves with a mock worker
    mockCreateWorker.mockImplementation(() =>
      Promise.resolve({
        recognize: mockRecognize,
        terminate: mockTerminate,
      }),
    );

    // Default mock: recognize resolves after a small delay
    mockRecognize.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ data: { text: 'mock text' } }), 50);
        }),
    );

    mockTerminate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Feature: screen-context-latency, Property 3: In-flight OCR deduplication
  describe('Property 3: In-flight OCR deduplication', () => {
    it('exactly 1 Tesseract recognize call for N concurrent requests with the same frame hash', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 20 }), async (concurrencyCount) => {
          // Reset state for each iteration
          await terminateOcrWorker();
          _resetDedupState();
          mockRecognize.mockReset();
          mockCreateWorker.mockReset();

          mockCreateWorker.mockImplementation(() =>
            Promise.resolve({
              recognize: mockRecognize,
              terminate: mockTerminate,
            }),
          );

          // recognize returns after a delay so all calls overlap
          mockRecognize.mockImplementation(
            () =>
              new Promise((resolve) => {
                setTimeout(() => resolve({ data: { text: 'recognized text' } }), 100);
              }),
          );

          // Create a consistent frame hash for all calls
          const frameHash = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
          const mockCanvas = {} as HTMLCanvasElement;

          // Fire N concurrent calls with the SAME frameHash
          const promises = Array.from({ length: concurrencyCount }, () =>
            recognizeTextDeduped(mockCanvas, frameHash),
          );

          // Advance timers to let the recognize call resolve
          await vi.advanceTimersByTimeAsync(200);

          // Wait for all promises to resolve
          const results = await Promise.all(promises);

          // All callers should get the same result
          for (const result of results) {
            expect(result).toBe('recognized text');
          }

          // Exactly 1 Tesseract recognize call, not N
          expect(mockRecognize).toHaveBeenCalledTimes(1);
        }),
        { numRuns: 100 },
      );
    });
  });

  // Feature: screen-context-latency, Property 5: Worker initialization deduplication
  describe('Property 5: Worker initialization deduplication', () => {
    it('exactly 1 createWorker call for N concurrent getOcrWorker() calls', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 10 }), async (concurrencyCount) => {
          // Reset state for each iteration
          await terminateOcrWorker();
          _resetDedupState();
          mockCreateWorker.mockReset();

          // createWorker resolves after a delay to simulate initialization time
          mockCreateWorker.mockImplementation(
            () =>
              new Promise((resolve) => {
                setTimeout(
                  () =>
                    resolve({
                      recognize: mockRecognize,
                      terminate: mockTerminate,
                    }),
                  50,
                );
              }),
          );

          // Fire N concurrent getOcrWorker calls simultaneously
          const promises = Array.from({ length: concurrencyCount }, () => getOcrWorker());

          // Advance timers to let createWorker resolve
          await vi.advanceTimersByTimeAsync(100);

          // Wait for all promises
          const workers = await Promise.all(promises);

          // All callers should get the same worker instance
          const firstWorker = workers[0];
          for (const worker of workers) {
            expect(worker).toBe(firstWorker);
          }

          // Exactly 1 createWorker invocation
          expect(mockCreateWorker).toHaveBeenCalledTimes(1);
        }),
        { numRuns: 100 },
      );
    });
  });

  // Feature: screen-context-latency, Property 6: Idle grace period worker reuse
  describe('Property 6: Idle grace period worker reuse', () => {
    it('worker is reused iff stopDuration < gracePeriod', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            stopDuration: fc.integer({ min: 0, max: 120_000 }),
            gracePeriod: fc.integer({ min: 1000, max: 60_000 }),
          }),
          async ({ stopDuration, gracePeriod }) => {
            // Reset state for each iteration
            await terminateOcrWorker();
            _resetDedupState();
            mockCreateWorker.mockReset();
            mockTerminate.mockReset();

            mockCreateWorker.mockImplementation(() =>
              Promise.resolve({
                recognize: mockRecognize,
                terminate: mockTerminate,
              }),
            );
            mockTerminate.mockResolvedValue(undefined);

            // Configure the grace period
            configureOcrService({ idleGracePeriodMs: gracePeriod });

            // Warm the worker (first createWorker call)
            await warmOcrWorker();
            expect(mockCreateWorker).toHaveBeenCalledTimes(1);

            // Schedule idle termination (simulates session stop)
            scheduleIdleTermination();

            // Advance time by stopDuration
            await vi.advanceTimersByTimeAsync(stopDuration);

            // Warm again (simulates session restart)
            await warmOcrWorker();

            if (stopDuration < gracePeriod) {
              // Worker should be reused — still only 1 createWorker call
              expect(mockCreateWorker).toHaveBeenCalledTimes(1);
            } else {
              // Worker was terminated and recreated — 2 createWorker calls
              expect(mockCreateWorker).toHaveBeenCalledTimes(2);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
