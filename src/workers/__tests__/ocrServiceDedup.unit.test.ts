// ============================================
// Zule AI — OCR Service deduplication & grace period unit tests
// ============================================
//
// Tests for Requirements 3.3, 3.4, 3.5, 3.6:
//   - Worker survives stop within grace period
//   - Worker terminates after grace period elapses
//   - Immediate terminate on renderer teardown ignores grace period
//   - Initialization failure surfaces through OcrWatchdog
//   - Dedup gate returns same result for concurrent same-frame calls
//   - Dedup gate starts new OCR for different frame hash
//   - Dedup gate clears state after completion

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDedupState,
  _resetWorkerState,
  cancelIdleTermination,
  configureOcrService,
  hasActiveWorker,
  isIdleTerminationScheduled,
  OcrWatchdog,
  recognizeTextDeduped,
  scheduleIdleTermination,
  terminateOcrWorker,
  terminateOcrWorkerImmediate,
  warmOcrWorker,
} from '../ocrWorker';

// ---- Mocks ----

const mockRecognize = vi.fn().mockResolvedValue({ data: { text: 'mock text' } });
const mockTerminate = vi.fn().mockResolvedValue(undefined);

vi.mock('tesseract.js', () => ({
  createWorker: vi.fn().mockImplementation(() =>
    Promise.resolve({
      recognize: mockRecognize,
      terminate: mockTerminate,
    })
  ),
}));

vi.mock('../../brain/modelDownloadRegistry', () => ({
  modelDownloadRegistry: {
    upsert: vi.fn(),
  },
}));

// ---- Helpers ----

/** Create a fake canvas-like object for recognizeTextDeduped */
function fakeCanvas(): HTMLCanvasElement {
  return {} as unknown as HTMLCanvasElement;
}

/** Create a frame hash from a simple byte value */
function makeHash(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes.length === 0 ? [1, 2, 3, 4, 5, 6, 7, 8] : bytes);
}

describe('OCR Service dedup and grace period', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    // Clean state — use _resetWorkerState to handle rejected workerPromise
    _resetWorkerState();
    configureOcrService({ idleGracePeriodMs: 30_000 });
    mockRecognize.mockClear();
    mockTerminate.mockClear();
    // Reset createWorker mock
    const { createWorker } = await import('tesseract.js');
    vi.mocked(createWorker).mockClear();
    // Restore default createWorker implementation
    vi.mocked(createWorker).mockImplementation(() =>
      Promise.resolve({
        recognize: mockRecognize,
        terminate: mockTerminate,
      })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- Grace period tests (Requirements 3.3, 3.4, 3.5) ----

  describe('Worker survives stop within grace period (Req 3.3)', () => {
    it('retains the worker when re-attach happens before grace period expires', async () => {
      await warmOcrWorker('eng');
      expect(hasActiveWorker()).toBe(true);

      // Session stops — schedule idle termination
      scheduleIdleTermination();
      expect(isIdleTerminationScheduled()).toBe(true);

      // Re-attach within grace period (10s < 30s)
      vi.advanceTimersByTime(10_000);
      expect(hasActiveWorker()).toBe(true);

      // Cancel idle termination (simulating session restart)
      cancelIdleTermination();

      // Worker persists beyond the original grace period
      vi.advanceTimersByTime(60_000);
      await vi.runAllTimersAsync();
      expect(hasActiveWorker()).toBe(true);
    });
  });

  describe('Worker terminates after grace period elapses (Req 3.4)', () => {
    it('terminates the worker when grace period fully elapses', async () => {
      await warmOcrWorker('eng');
      expect(hasActiveWorker()).toBe(true);

      scheduleIdleTermination();

      // Advance just before grace period
      vi.advanceTimersByTime(29_999);
      expect(hasActiveWorker()).toBe(true);

      // Cross the grace period boundary
      vi.advanceTimersByTime(1);
      await vi.runAllTimersAsync();
      expect(hasActiveWorker()).toBe(false);
    });
  });

  describe('Immediate terminate on renderer teardown ignores grace period (Req 3.5)', () => {
    it('terminates immediately without waiting for the timer', async () => {
      await warmOcrWorker('eng');
      expect(hasActiveWorker()).toBe(true);

      // Schedule idle termination (would fire at 30s)
      scheduleIdleTermination();
      expect(isIdleTerminationScheduled()).toBe(true);

      // Immediate terminate — renderer teardown
      await terminateOcrWorkerImmediate();

      // Worker is gone immediately
      expect(hasActiveWorker()).toBe(false);
      expect(isIdleTerminationScheduled()).toBe(false);
    });

    it('works even when no idle termination is scheduled', async () => {
      await warmOcrWorker('eng');
      expect(hasActiveWorker()).toBe(true);

      await terminateOcrWorkerImmediate();
      expect(hasActiveWorker()).toBe(false);
    });
  });

  // ---- Dedup gate tests (Req 1.5, 3.2) ----

  describe('Dedup gate returns same result for concurrent same-frame calls', () => {
    it('resolves all concurrent callers with the same result from a single OCR call', async () => {
      await warmOcrWorker('eng');
      mockRecognize.mockResolvedValue({ data: { text: 'deduped result' } });

      const hash = makeHash(10, 20, 30, 40, 50, 60, 70, 80);
      const canvas = fakeCanvas();

      // Fire 3 concurrent calls with the same frame hash
      const p1 = recognizeTextDeduped(canvas, hash, 'eng');
      const p2 = recognizeTextDeduped(canvas, hash, 'eng');
      const p3 = recognizeTextDeduped(canvas, hash, 'eng');

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      // All 3 get the same result
      expect(r1).toBe('deduped result');
      expect(r2).toBe('deduped result');
      expect(r3).toBe('deduped result');

      // worker.recognize was called exactly once
      expect(mockRecognize).toHaveBeenCalledTimes(1);
    });
  });

  describe('Dedup gate starts new OCR for different frame hash', () => {
    it('invokes OCR twice for two different hashes', async () => {
      await warmOcrWorker('eng');
      mockRecognize
        .mockResolvedValueOnce({ data: { text: 'text A' } })
        .mockResolvedValueOnce({ data: { text: 'text B' } });

      const hashA = makeHash(1, 2, 3, 4, 5, 6, 7, 8);
      const hashB = makeHash(9, 8, 7, 6, 5, 4, 3, 2);
      const canvas = fakeCanvas();

      // Call with hash A, then (after it completes) with hash B
      const resultA = await recognizeTextDeduped(canvas, hashA, 'eng');
      const resultB = await recognizeTextDeduped(canvas, hashB, 'eng');

      expect(resultA).toBe('text A');
      expect(resultB).toBe('text B');
      expect(mockRecognize).toHaveBeenCalledTimes(2);
    });
  });

  describe('Dedup gate clears state after completion', () => {
    it('does NOT dedup when same hash is called after the first completes', async () => {
      await warmOcrWorker('eng');

      // Set up sequential return values
      let callCount = 0;
      mockRecognize.mockImplementation(() => {
        callCount++;
        return Promise.resolve({ data: { text: `call ${callCount}` } });
      });

      const hash = makeHash(1, 1, 1, 1, 1, 1, 1, 1);
      const canvas = fakeCanvas();

      // First call — completes
      const result1 = await recognizeTextDeduped(canvas, hash, 'eng');
      expect(result1).toBe('call 1');

      // Second call with same hash — NOT deduped because state was cleared
      const result2 = await recognizeTextDeduped(canvas, hash, 'eng');
      expect(result2).toBe('call 2');

      // recognize was called twice
      expect(mockRecognize).toHaveBeenCalledTimes(2);
    });
  });

  // ---- Initialization failure (Req 3.6) ----

  describe('Initialization failure surfaces through OcrWatchdog (Req 3.6)', () => {
    it('OcrWatchdog can record the failure and transition to recreated state', () => {
      const watchdog = new OcrWatchdog({ maxErrors: 3, windowMs: 30_000 });

      // Simulate 3 initialization failures within the window
      watchdog.recordError(1000);
      watchdog.recordError(2000);
      const result = watchdog.recordError(3000);

      expect(result.state).toBe('recreated');
      expect(result.action).toBe('recreate');
      expect(watchdog.state).toBe('recreated');
    });

    it('OcrWatchdog disables OCR after the recreated worker also fails', () => {
      const watchdog = new OcrWatchdog({ maxErrors: 3, windowMs: 30_000 });

      // First 3 errors → recreate
      watchdog.recordError(1000);
      watchdog.recordError(2000);
      watchdog.recordError(3000);
      expect(watchdog.state).toBe('recreated');

      // Next error after recreate → disable
      const result = watchdog.recordError(5000);
      expect(result.state).toBe('disabled');
      expect(result.action).toBe('disable');
    });

    it('rejects the recognizeTextDeduped promise when createWorker fails', async () => {
      // Ensure no worker exists
      _resetWorkerState();

      const { createWorker } = await import('tesseract.js');
      vi.mocked(createWorker).mockImplementationOnce(() =>
        Promise.reject(new Error('Worker init failed'))
      );

      const hash = makeHash(5, 5, 5, 5, 5, 5, 5, 5);
      const canvas = fakeCanvas();

      // recognizeTextDeduped should reject
      await expect(recognizeTextDeduped(canvas, hash, 'eng')).rejects.toThrow(
        'Worker init failed'
      );
    });

    it('integrates: dedup gate clears in-flight state on init failure', async () => {
      // Start fresh — ensure no active worker
      _resetWorkerState();

      const { createWorker } = await import('tesseract.js');

      // createWorker will fail
      vi.mocked(createWorker).mockImplementationOnce(() =>
        Promise.reject(new Error('Init fail'))
      );

      const hashA = makeHash(7, 7, 7, 7, 7, 7, 7, 7);
      const hashB = makeHash(8, 8, 8, 8, 8, 8, 8, 8);
      const canvas = fakeCanvas();

      // First call fails
      await expect(recognizeTextDeduped(canvas, hashA, 'eng')).rejects.toThrow('Init fail');

      // The dedup gate's inFlightPromise was cleared by .finally()
      // So a call with a DIFFERENT hash doesn't get the old rejected promise
      // It will also fail (because workerPromise is still rejected) but with a fresh attempt
      await expect(recognizeTextDeduped(canvas, hashB, 'eng')).rejects.toThrow('Init fail');

      // Neither call hit worker.recognize (both failed at init)
      expect(mockRecognize).not.toHaveBeenCalled();
    });
  });
});
