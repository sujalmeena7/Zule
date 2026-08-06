/**
 * Stage C — Capture Integration Tests
 *
 * Automated Windows capture and failure-injection tests:
 * - Run 20 enable/disable cycles with mock native API read-back
 * - Inject APPLY_FAILED, READ_BACK_MISMATCH, READ_BACK_TIMEOUT failures
 * - Measure Layer 0 recovery occurs within 500ms
 *
 * Requirements: 12.1–12.12, 17.13–17.14
 */

import { describe, it, expect, beforeEach } from 'vitest';

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
// Test Helpers
// ────────────────────────────────────────────────────────────────────

const FAKE_HWND = 0xCAFE_1234;

/** Creates a controllable clock. */
function createMockClock(initial = 0): AffinityClock & FallbackClock & {
  time: number;
  advance(ms: number): void;
} {
  const clock = {
    time: initial,
    now() { return clock.time; },
    advance(ms: number) { clock.time += ms; },
  };
  return clock;
}

/** Failure injection mode for the mock API. */
type FailureMode = 'none' | 'apply_failed' | 'read_back_mismatch' | 'read_back_timeout';

/**
 * Creates a mock API with injectable failure modes and realistic timing.
 * Tracks all operations for verification.
 */
function createNativeApi(clock: ReturnType<typeof createMockClock>) {
  let failureMode: FailureMode = 'none';
  let currentAffinity: number = DisplayAffinityValue.WDA_NONE;
  const operations: Array<{ op: string; time: number; value?: number }> = [];

  const api: DisplayAffinityApi & {
    setFailureMode(mode: FailureMode): void;
    getOperations(): typeof operations;
    getCurrentAffinity(): number;
  } = {
    setFailureMode(mode: FailureMode) { failureMode = mode; },
    getOperations() { return operations; },
    getCurrentAffinity() { return currentAffinity; },

    setWindowDisplayAffinity(_hwnd: unknown, affinity: number): boolean {
      clock.advance(2); // Realistic 2ms for Win32 call
      operations.push({ op: 'set', time: clock.time, value: affinity });

      if (failureMode === 'apply_failed') {
        return false;
      }
      currentAffinity = affinity;
      return true;
    },

    getWindowDisplayAffinity(_hwnd: unknown): number | null {
      if (failureMode === 'read_back_timeout') {
        clock.advance(READ_BACK_DEADLINE_MS + 10); // Exceed deadline
        operations.push({ op: 'get_timeout', time: clock.time });
        return currentAffinity;
      }

      clock.advance(3); // Realistic 3ms for Win32 call
      operations.push({ op: 'get', time: clock.time });

      if (failureMode === 'read_back_mismatch') {
        // Return opposite of what was set
        return currentAffinity === DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE
          ? DisplayAffinityValue.WDA_NONE
          : DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE;
      }

      return currentAffinity;
    },
  };

  return api;
}

/**
 * Creates fallback deps that track Layer 0 recovery timing.
 */
function createRecoveryDeps(
  clock: ReturnType<typeof createMockClock>,
  requestedValue: boolean,
) {
  let layer0Visible = false;
  let layer0CaptureApplied = false;
  let recoveryStartTime = 0;

  const deps: CaptureFallbackDeps & {
    isLayer0Visible(): boolean;
    isLayer0CaptureApplied(): boolean;
    getRecoveryTime(): number;
  } = {
    hideStageC() {
      recoveryStartTime = clock.time;
      clock.advance(5); // Fast hide
      return true;
    },
    showLayer0() {
      clock.advance(10); // Show takes 10ms
      layer0Visible = true;
      return true;
    },
    applyLayer0Capture(enabled: boolean) {
      clock.advance(15); // Apply takes 15ms
      layer0CaptureApplied = true;
      return true;
    },
    verifyLayer0Capture(enabled: boolean) {
      clock.advance(10); // Verify takes 10ms
      return enabled === requestedValue;
    },
    getRequestedCaptureValue() {
      return requestedValue;
    },
    isLayer0Visible() { return layer0Visible; },
    isLayer0CaptureApplied() { return layer0CaptureApplied; },
    getRecoveryTime() { return clock.time - recoveryStartTime; },
  };

  return deps;
}

// ────────────────────────────────────────────────────────────────────
// Tests: 20 Enable/Disable Cycles with Native Read-Back
// ────────────────────────────────────────────────────────────────────

describe('Capture Integration — 20 enable/disable cycles', () => {
  let clock: ReturnType<typeof createMockClock>;
  let api: ReturnType<typeof createNativeApi>;
  let manager: DisplayAffinityManager;

  beforeEach(() => {
    clock = createMockClock();
    api = createNativeApi(clock);
    manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);
  });

  it('completes 20 enable/disable cycles with correct read-back each time', () => {
    for (let i = 0; i < 20; i++) {
      const enabled = i % 2 === 0; // alternate enable/disable
      const result = manager.applyCaptureProtection(enabled);

      expect(result.status).toBe(CaptureProtectionStatus.APPLIED);

      const expectedValue = enabled
        ? DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE
        : DisplayAffinityValue.WDA_NONE;
      expect(result.readBackValue).toBe(expectedValue);
      expect(result.requestedValue).toBe(expectedValue);
      expect(result.elapsedMs).toBeLessThan(READ_BACK_DEADLINE_MS);

      // Verify the native state matches
      expect(api.getCurrentAffinity()).toBe(expectedValue);

      clock.advance(50); // 50ms between cycles
    }

    // Verify 20 set + 20 get operations occurred
    const ops = api.getOperations();
    const setCalls = ops.filter((o) => o.op === 'set');
    const getCalls = ops.filter((o) => o.op === 'get');
    expect(setCalls).toHaveLength(20);
    expect(getCalls).toHaveLength(20);
  });

  it('20 rapid enable cycles all succeed without timeout', () => {
    for (let i = 0; i < 20; i++) {
      const result = manager.applyCaptureProtection(true);

      expect(result.status).toBe(CaptureProtectionStatus.APPLIED);
      expect(result.readBackValue).toBe(DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE);
      expect(result.elapsedMs).toBeLessThan(READ_BACK_DEADLINE_MS);

      clock.advance(20); // 20ms between rapid cycles
    }
  });

  it('20 rapid disable cycles all succeed without timeout', () => {
    // Start with protection enabled
    manager.applyCaptureProtection(true);
    clock.advance(10);

    for (let i = 0; i < 20; i++) {
      const result = manager.applyCaptureProtection(false);

      expect(result.status).toBe(CaptureProtectionStatus.APPLIED);
      expect(result.readBackValue).toBe(DisplayAffinityValue.WDA_NONE);
      expect(result.elapsedMs).toBeLessThan(READ_BACK_DEADLINE_MS);

      clock.advance(20);
    }
  });

  it('20 cycles with interspersed lifecycle reapplies all maintain correct state', () => {
    const triggers = [
      ReapplyTrigger.CREATE,
      ReapplyTrigger.RECREATE,
      ReapplyTrigger.SHOW,
      ReapplyTrigger.DISPLAY_MIGRATION,
    ];

    for (let i = 0; i < 20; i++) {
      const enabled = i % 3 !== 0; // mostly enabled
      manager.applyCaptureProtection(enabled);

      // Apply a lifecycle trigger after each toggle
      const trigger = triggers[i % triggers.length];
      const reapplyResult = manager.reapplyIfNeeded(trigger);

      expect(reapplyResult).not.toBeNull();
      expect(reapplyResult!.status).toBe(CaptureProtectionStatus.APPLIED);

      const expectedValue = enabled
        ? DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE
        : DisplayAffinityValue.WDA_NONE;
      expect(reapplyResult!.readBackValue).toBe(expectedValue);

      clock.advance(30);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Failure Injection — APPLY_FAILED
// ────────────────────────────────────────────────────────────────────

describe('Capture Integration — APPLY_FAILED injection', () => {
  it('detects apply failure and triggers Layer 0 recovery within 500ms', () => {
    const clock = createMockClock();
    const api = createNativeApi(clock);
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    // Normal apply first
    const normalResult = manager.applyCaptureProtection(true);
    expect(normalResult.status).toBe(CaptureProtectionStatus.APPLIED);

    // Inject APPLY_FAILED
    api.setFailureMode('apply_failed');
    const failResult = manager.applyCaptureProtection(true);
    expect(failResult.status).toBe(CaptureProtectionStatus.APPLY_FAILED);

    // Trigger fallback recovery
    const deps = createRecoveryDeps(clock, true);
    const fallbackResult = executeCaptureFallback(deps, clock);

    // Recovery must complete within 500ms
    expect(fallbackResult.recoveryMs).toBeLessThan(RECOVERY_DEADLINE_MS);
    expect(fallbackResult.layer0Visible).toBe(true);
    expect(deps.isLayer0CaptureApplied()).toBe(true);
  });

  it('apply failure does not corrupt manager state for subsequent applies', () => {
    const clock = createMockClock();
    const api = createNativeApi(clock);
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    // Inject failure
    api.setFailureMode('apply_failed');
    const failResult = manager.applyCaptureProtection(true);
    expect(failResult.status).toBe(CaptureProtectionStatus.APPLY_FAILED);

    // Clear failure
    api.setFailureMode('none');
    const successResult = manager.applyCaptureProtection(true);
    expect(successResult.status).toBe(CaptureProtectionStatus.APPLIED);
    expect(successResult.readBackValue).toBe(DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Failure Injection — READ_BACK_MISMATCH
// ────────────────────────────────────────────────────────────────────

describe('Capture Integration — READ_BACK_MISMATCH injection', () => {
  it('detects mismatch and triggers Layer 0 recovery within 500ms', () => {
    const clock = createMockClock();
    const api = createNativeApi(clock);
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    // Inject READ_BACK_MISMATCH
    api.setFailureMode('read_back_mismatch');
    const result = manager.applyCaptureProtection(true);
    expect(result.status).toBe(CaptureProtectionStatus.READ_BACK_MISMATCH);
    expect(result.requestedValue).toBe(DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE);
    // Read-back should show the wrong value
    expect(result.readBackValue).toBe(DisplayAffinityValue.WDA_NONE);

    // Trigger fallback
    const deps = createRecoveryDeps(clock, true);
    const fallbackResult = executeCaptureFallback(deps, clock);

    expect(fallbackResult.recoveryMs).toBeLessThan(RECOVERY_DEADLINE_MS);
    expect(fallbackResult.status).toBe(CaptureFallbackStatus.FALLBACK_COMPLETE);
    expect(fallbackResult.layer0Visible).toBe(true);
  });

  it('mismatch on disable also triggers correct recovery', () => {
    const clock = createMockClock();
    const api = createNativeApi(clock);
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    // First enable normally
    manager.applyCaptureProtection(true);
    clock.advance(10);

    // Now inject mismatch on disable
    api.setFailureMode('read_back_mismatch');
    const result = manager.applyCaptureProtection(false);
    expect(result.status).toBe(CaptureProtectionStatus.READ_BACK_MISMATCH);

    // Fallback with disabled value
    const deps = createRecoveryDeps(clock, false);
    const fallbackResult = executeCaptureFallback(deps, clock);

    expect(fallbackResult.recoveryMs).toBeLessThan(RECOVERY_DEADLINE_MS);
    expect(fallbackResult.layer0Visible).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Failure Injection — READ_BACK_TIMEOUT
// ────────────────────────────────────────────────────────────────────

describe('Capture Integration — READ_BACK_TIMEOUT injection', () => {
  it('detects timeout and triggers Layer 0 recovery within 500ms', () => {
    const clock = createMockClock();
    const api = createNativeApi(clock);
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    // Inject READ_BACK_TIMEOUT
    api.setFailureMode('read_back_timeout');
    const result = manager.applyCaptureProtection(true);
    expect(result.status).toBe(CaptureProtectionStatus.READ_BACK_TIMEOUT);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(READ_BACK_DEADLINE_MS);

    // Trigger fallback — even though the affinity call itself took >100ms,
    // the overall Layer 0 recovery must still complete within 500ms
    const recoveryClock = createMockClock(); // Fresh clock for recovery
    const deps = createRecoveryDeps(recoveryClock, true);
    const fallbackResult = executeCaptureFallback(deps, recoveryClock);

    expect(fallbackResult.recoveryMs).toBeLessThan(RECOVERY_DEADLINE_MS);
    expect(fallbackResult.status).toBe(CaptureFallbackStatus.FALLBACK_COMPLETE);
    expect(fallbackResult.layer0Visible).toBe(true);
  });

  it('timeout recovery is independent of the original timeout duration', () => {
    const clock = createMockClock();
    const api = createNativeApi(clock);
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    // Timeout occurred (simulates extended API latency)
    api.setFailureMode('read_back_timeout');
    manager.applyCaptureProtection(true);

    // Recovery path uses its own timing budget
    const recoveryClock = createMockClock();
    const deps = createRecoveryDeps(recoveryClock, true);
    const fallbackResult = executeCaptureFallback(deps, recoveryClock);

    // Must complete well under 500ms regardless of prior timeout
    expect(fallbackResult.recoveryMs).toBeLessThan(100);
    expect(fallbackResult.layer0Visible).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Combined Failure Sequence and Recovery
// ────────────────────────────────────────────────────────────────────

describe('Capture Integration — combined failure sequence', () => {
  it('handles all three failure types in sequence with correct recovery each time', () => {
    const clock = createMockClock();
    const api = createNativeApi(clock);
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    const failures: Array<{ mode: FailureMode; expectedStatus: CaptureProtectionStatus }> = [
      { mode: 'apply_failed', expectedStatus: CaptureProtectionStatus.APPLY_FAILED },
      { mode: 'read_back_mismatch', expectedStatus: CaptureProtectionStatus.READ_BACK_MISMATCH },
      { mode: 'read_back_timeout', expectedStatus: CaptureProtectionStatus.READ_BACK_TIMEOUT },
    ];

    for (const { mode, expectedStatus } of failures) {
      api.setFailureMode(mode);
      const result = manager.applyCaptureProtection(true);
      expect(result.status).toBe(expectedStatus);

      // Each failure triggers recovery — use fresh clock for each
      const recoveryClock = createMockClock();
      const deps = createRecoveryDeps(recoveryClock, true);
      const fallbackResult = executeCaptureFallback(deps, recoveryClock);

      expect(fallbackResult.recoveryMs).toBeLessThan(RECOVERY_DEADLINE_MS);
      expect(fallbackResult.layer0Visible).toBe(true);

      // Clear failure and verify normal operation resumes
      api.setFailureMode('none');
      clock.advance(50);
      const recoveryResult = manager.applyCaptureProtection(true);
      expect(recoveryResult.status).toBe(CaptureProtectionStatus.APPLIED);

      clock.advance(100);
    }
  });

  it('failure mid-cycle does not lose the user-requested value', () => {
    const clock = createMockClock();
    const api = createNativeApi(clock);
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    // Enable protection successfully
    manager.applyCaptureProtection(true);
    expect(manager.getState().enabled).toBe(true);
    clock.advance(50);

    // Inject mismatch failure
    api.setFailureMode('read_back_mismatch');
    manager.applyCaptureProtection(true);

    // State still tracks enabled=true (user's intent)
    expect(manager.getState().enabled).toBe(true);
    // But verified=false since mismatch occurred
    expect(manager.getState().verified).toBe(false);

    // Clear failure and reapply
    api.setFailureMode('none');
    const reapplyResult = manager.reapplyIfNeeded(ReapplyTrigger.RECREATE);
    expect(reapplyResult).not.toBeNull();
    expect(reapplyResult!.status).toBe(CaptureProtectionStatus.APPLIED);
    expect(reapplyResult!.readBackValue).toBe(DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE);
  });

  it('20 cycles with random failure injection still recovers every time', () => {
    const clock = createMockClock();
    const api = createNativeApi(clock);
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    // Predetermined failure pattern: inject on cycles 3, 7, 11, 15, 19
    const failureCycles = new Set([3, 7, 11, 15, 19]);
    const failureModes: FailureMode[] = [
      'apply_failed',
      'read_back_mismatch',
      'read_back_timeout',
      'apply_failed',
      'read_back_mismatch',
    ];

    let failureIdx = 0;

    for (let i = 0; i < 20; i++) {
      const enabled = i % 2 === 0;

      if (failureCycles.has(i)) {
        // Inject failure
        api.setFailureMode(failureModes[failureIdx++]);
        const result = manager.applyCaptureProtection(enabled);
        expect(result.status).not.toBe(CaptureProtectionStatus.APPLIED);

        // Trigger recovery
        const recoveryClock = createMockClock();
        const deps = createRecoveryDeps(recoveryClock, enabled);
        const fallbackResult = executeCaptureFallback(deps, recoveryClock);

        expect(fallbackResult.recoveryMs).toBeLessThan(RECOVERY_DEADLINE_MS);
        expect(fallbackResult.layer0Visible).toBe(true);

        // Clear failure for next cycle
        api.setFailureMode('none');
      } else {
        // Normal cycle
        const result = manager.applyCaptureProtection(enabled);
        expect(result.status).toBe(CaptureProtectionStatus.APPLIED);
      }

      clock.advance(30);
    }
  });
});
