// ============================================
// Zule AI — OCR Worker warm-start & idle grace period tests
// ============================================
//
// Tests for Requirement 3.1, 3.3, 3.4, 3.5:
//   - warmOcrWorker starts initialization without blocking
//   - scheduleIdleTermination retains worker for grace period
//   - cancelIdleTermination prevents termination on session restart
//   - terminateOcrWorkerImmediate bypasses grace period
//   - Re-attach within grace period reuses the existing worker

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelIdleTermination,
  configureOcrService,
  hasActiveWorker,
  isIdleTerminationScheduled,
  scheduleIdleTermination,
  terminateOcrWorker,
  terminateOcrWorkerImmediate,
  warmOcrWorker,
} from './ocrWorker';

// Mock tesseract.js so we don't need the actual binary
vi.mock('tesseract.js', () => ({
  createWorker: vi.fn().mockImplementation(() =>
    Promise.resolve({
      recognize: vi.fn().mockResolvedValue({ data: { text: 'mock text' } }),
      terminate: vi.fn().mockResolvedValue(undefined),
    })
  ),
}));

// Mock modelDownloadRegistry
vi.mock('../brain/modelDownloadRegistry', () => ({
  modelDownloadRegistry: {
    upsert: vi.fn(),
  },
}));

describe('OCR Worker warm-start and idle grace period', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    // Ensure clean state before each test
    await terminateOcrWorker();
    cancelIdleTermination();
    configureOcrService({ idleGracePeriodMs: 30_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('warmOcrWorker', () => {
    it('starts worker initialization and returns a promise', async () => {
      expect(hasActiveWorker()).toBe(false);

      const promise = warmOcrWorker();
      // Worker initialization is kicked off
      expect(hasActiveWorker()).toBe(true);

      await promise;
      expect(hasActiveWorker()).toBe(true);
    });

    it('does not block — returns immediately even if worker is initializing', () => {
      // warmOcrWorker should return a promise but not block the caller
      const promise = warmOcrWorker('eng');
      expect(promise).toBeInstanceOf(Promise);
      // The worker is initializing but hasActiveWorker is true because
      // workerPromise is set synchronously
      expect(hasActiveWorker()).toBe(true);
    });

    it('reuses existing worker when called with same language', async () => {
      await warmOcrWorker('eng');
      expect(hasActiveWorker()).toBe(true);

      // Second call with same language should reuse
      const { createWorker } = await import('tesseract.js');
      const callCountBefore = vi.mocked(createWorker).mock.calls.length;

      await warmOcrWorker('eng');
      const callCountAfter = vi.mocked(createWorker).mock.calls.length;

      // No additional createWorker call
      expect(callCountAfter).toBe(callCountBefore);
    });

    it('cancels any pending idle termination', async () => {
      await warmOcrWorker('eng');
      scheduleIdleTermination();
      expect(isIdleTerminationScheduled()).toBe(true);

      // Warm-start cancels the idle termination
      await warmOcrWorker('eng');
      expect(isIdleTerminationScheduled()).toBe(false);
    });
  });

  describe('scheduleIdleTermination', () => {
    it('schedules termination after the configured grace period', async () => {
      await warmOcrWorker('eng');
      expect(hasActiveWorker()).toBe(true);

      scheduleIdleTermination();
      expect(isIdleTerminationScheduled()).toBe(true);

      // Worker still alive before grace period elapses
      vi.advanceTimersByTime(29_999);
      expect(hasActiveWorker()).toBe(true);

      // Worker terminated after grace period elapses
      vi.advanceTimersByTime(1);
      // Allow the async termination to complete
      await vi.runAllTimersAsync();
      expect(hasActiveWorker()).toBe(false);
      expect(isIdleTerminationScheduled()).toBe(false);
    });

    it('uses custom grace period from config', async () => {
      configureOcrService({ idleGracePeriodMs: 5_000 });
      await warmOcrWorker('eng');

      scheduleIdleTermination();

      // Still alive at 4999ms
      vi.advanceTimersByTime(4_999);
      expect(hasActiveWorker()).toBe(true);

      // Terminated at 5000ms
      vi.advanceTimersByTime(1);
      await vi.runAllTimersAsync();
      expect(hasActiveWorker()).toBe(false);
    });

    it('cancels previous termination timer when called again', async () => {
      await warmOcrWorker('eng');

      scheduleIdleTermination();
      vi.advanceTimersByTime(20_000); // 20s into first 30s timer

      // Schedule again — should reset the timer
      scheduleIdleTermination();
      vi.advanceTimersByTime(20_000); // 20s into second 30s timer
      expect(hasActiveWorker()).toBe(true); // Still alive (only 20s of new timer)

      vi.advanceTimersByTime(10_000); // Now 30s into second timer
      await vi.runAllTimersAsync();
      expect(hasActiveWorker()).toBe(false);
    });
  });

  describe('cancelIdleTermination', () => {
    it('cancels a scheduled termination', async () => {
      await warmOcrWorker('eng');
      scheduleIdleTermination();
      expect(isIdleTerminationScheduled()).toBe(true);

      cancelIdleTermination();
      expect(isIdleTerminationScheduled()).toBe(false);

      // Worker survives past the grace period
      vi.advanceTimersByTime(60_000);
      await vi.runAllTimersAsync();
      expect(hasActiveWorker()).toBe(true);
    });

    it('is safe to call when no termination is scheduled', () => {
      expect(() => cancelIdleTermination()).not.toThrow();
      expect(isIdleTerminationScheduled()).toBe(false);
    });
  });

  describe('terminateOcrWorkerImmediate', () => {
    it('terminates the worker immediately regardless of grace period', async () => {
      await warmOcrWorker('eng');
      scheduleIdleTermination();
      expect(hasActiveWorker()).toBe(true);
      expect(isIdleTerminationScheduled()).toBe(true);

      await terminateOcrWorkerImmediate();
      expect(hasActiveWorker()).toBe(false);
      expect(isIdleTerminationScheduled()).toBe(false);
    });

    it('cancels any pending idle termination', async () => {
      await warmOcrWorker('eng');
      scheduleIdleTermination();

      await terminateOcrWorkerImmediate();
      expect(isIdleTerminationScheduled()).toBe(false);
    });

    it('is safe to call when no worker is active', async () => {
      expect(hasActiveWorker()).toBe(false);
      await expect(terminateOcrWorkerImmediate()).resolves.toBeUndefined();
    });
  });

  describe('Re-attach within grace period reuses existing worker', () => {
    it('reuses worker when session restarts within grace period', async () => {
      const { createWorker } = await import('tesseract.js');

      // Start session and warm worker
      await warmOcrWorker('eng');
      const callsAfterFirstWarm = vi.mocked(createWorker).mock.calls.length;

      // Stop session — schedule idle termination
      scheduleIdleTermination();

      // Re-attach within grace period (e.g., 10s later)
      vi.advanceTimersByTime(10_000);
      expect(hasActiveWorker()).toBe(true); // Worker still alive

      // Warm again — should reuse
      await warmOcrWorker('eng');
      const callsAfterSecondWarm = vi.mocked(createWorker).mock.calls.length;

      // No new worker created
      expect(callsAfterSecondWarm).toBe(callsAfterFirstWarm);
      expect(hasActiveWorker()).toBe(true);
    });

    it('creates new worker when session restarts after grace period', async () => {
      const { createWorker } = await import('tesseract.js');

      // Start session and warm worker
      await warmOcrWorker('eng');
      const callsAfterFirstWarm = vi.mocked(createWorker).mock.calls.length;

      // Stop session — schedule idle termination
      scheduleIdleTermination();

      // Let grace period elapse
      vi.advanceTimersByTime(30_000);
      await vi.runAllTimersAsync();
      expect(hasActiveWorker()).toBe(false); // Worker terminated

      // Re-attach after grace period — must create new worker
      await warmOcrWorker('eng');
      const callsAfterSecondWarm = vi.mocked(createWorker).mock.calls.length;

      // New worker was created
      expect(callsAfterSecondWarm).toBe(callsAfterFirstWarm + 1);
      expect(hasActiveWorker()).toBe(true);
    });
  });
});
