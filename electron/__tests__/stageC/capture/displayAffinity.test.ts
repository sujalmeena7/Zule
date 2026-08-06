/**
 * Stage C — Display Affinity Capture Protection Tests
 *
 * Verifies:
 * - Correct Win32 API mapping (enabled→WDA_EXCLUDEFROMCAPTURE, disabled→WDA_NONE)
 * - Read-back within 100ms timeout
 * - Mismatch detection
 * - Reapply after lifecycle events
 * - Typed result for each failure case
 *
 * Requirements: 12.1–12.5, 12.10
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
  type CaptureProtectionResult,
} from '../../../stageC/capture/displayAffinity';

// ────────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────────

/** Fake HWND for testing. */
const FAKE_HWND = 0xDEAD_BEEF;

/** Creates a mock DisplayAffinityApi with controllable behavior. */
function createMockApi(options: {
  setResult?: boolean;
  getResult?: number | null;
  setDelay?: number;
  getDelay?: number;
  onSet?: (hwnd: unknown, affinity: number) => void;
} = {}): DisplayAffinityApi & { setCalls: Array<{ hwnd: unknown; affinity: number }>; getCalls: unknown[] } {
  const {
    setResult = true,
    getResult = DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE,
    onSet,
  } = options;

  const setCalls: Array<{ hwnd: unknown; affinity: number }> = [];
  const getCalls: unknown[] = [];

  return {
    setCalls,
    getCalls,
    setWindowDisplayAffinity(hwnd: unknown, affinity: number): boolean {
      setCalls.push({ hwnd, affinity });
      onSet?.(hwnd, affinity);
      return setResult;
    },
    getWindowDisplayAffinity(hwnd: unknown): number | null {
      getCalls.push(hwnd);
      return getResult;
    },
  };
}

/** Creates a controllable clock for testing timing behavior. */
function createMockClock(initialTime = 0): AffinityClock & { time: number; advance(ms: number): void } {
  const clock = {
    time: initialTime,
    now(): number {
      return clock.time;
    },
    advance(ms: number): void {
      clock.time += ms;
    },
  };
  return clock;
}

// ────────────────────────────────────────────────────────────────────
// Tests: Win32 API Mapping (Req 12.1, 12.2)
// ────────────────────────────────────────────────────────────────────

describe('DisplayAffinityManager — Win32 API mapping', () => {
  let manager: DisplayAffinityManager;
  let api: ReturnType<typeof createMockApi>;
  let clock: ReturnType<typeof createMockClock>;

  beforeEach(() => {
    clock = createMockClock();
    api = createMockApi({ getResult: DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE });
    manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);
  });

  it('maps enabled=true to WDA_EXCLUDEFROMCAPTURE (Req 12.1)', () => {
    manager.applyCaptureProtection(true);

    expect(api.setCalls).toHaveLength(1);
    expect(api.setCalls[0].affinity).toBe(DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE);
    expect(api.setCalls[0].hwnd).toBe(FAKE_HWND);
  });

  it('maps enabled=false to WDA_NONE (Req 12.2)', () => {
    const apiNone = createMockApi({ getResult: DisplayAffinityValue.WDA_NONE });
    const mgr = new DisplayAffinityManager(apiNone, clock);
    mgr.setHwnd(FAKE_HWND);

    mgr.applyCaptureProtection(false);

    expect(apiNone.setCalls).toHaveLength(1);
    expect(apiNone.setCalls[0].affinity).toBe(DisplayAffinityValue.WDA_NONE);
  });

  it('returns APPLIED status with correct requestedValue on success', () => {
    const result = manager.applyCaptureProtection(true);

    expect(result.status).toBe(CaptureProtectionStatus.APPLIED);
    expect(result.requestedValue).toBe(DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE);
    expect(result.readBackValue).toBe(DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE);
  });

  it('WDA_NONE constant equals 0x00000000', () => {
    expect(DisplayAffinityValue.WDA_NONE).toBe(0x00000000);
  });

  it('WDA_EXCLUDEFROMCAPTURE constant equals 0x00000011', () => {
    expect(DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE).toBe(0x00000011);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Read-back verification within 100ms (Req 12.3, 12.4)
// ────────────────────────────────────────────────────────────────────

describe('DisplayAffinityManager — read-back verification', () => {
  it('reports APPLIED when read-back matches within 100ms (Req 12.3, 12.4)', () => {
    const clock = createMockClock(0);
    const api = createMockApi({ getResult: DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE });
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    // Simulate that read-back takes 50ms (within deadline)
    const originalGet = api.getWindowDisplayAffinity.bind(api);
    api.getWindowDisplayAffinity = (hwnd) => {
      clock.advance(50); // 50ms elapsed for the read-back
      return originalGet(hwnd);
    };

    const result = manager.applyCaptureProtection(true);

    expect(result.status).toBe(CaptureProtectionStatus.APPLIED);
    expect(result.elapsedMs).toBeLessThan(READ_BACK_DEADLINE_MS);
  });

  it('reports READ_BACK_TIMEOUT when read-back exceeds 100ms (Req 12.3)', () => {
    const clock = createMockClock(0);
    const api = createMockApi({ getResult: DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE });
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    // Simulate that SetWindowDisplayAffinity takes 10ms
    const originalSet = api.setWindowDisplayAffinity.bind(api);
    api.setWindowDisplayAffinity = (hwnd, affinity) => {
      clock.advance(10);
      return originalSet(hwnd, affinity);
    };

    // Simulate that GetWindowDisplayAffinity takes 95ms (total > 100ms)
    api.getWindowDisplayAffinity = (hwnd) => {
      clock.advance(95); // total now 105ms > deadline
      return DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE;
    };

    const result = manager.applyCaptureProtection(true);

    expect(result.status).toBe(CaptureProtectionStatus.READ_BACK_TIMEOUT);
    expect(result.requestedValue).toBe(DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE);
  });

  it('reports READ_BACK_TIMEOUT when set itself exceeds deadline', () => {
    const clock = createMockClock(0);
    const api = createMockApi({ getResult: DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE });
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    // Set takes the whole deadline
    const originalSet = api.setWindowDisplayAffinity.bind(api);
    api.setWindowDisplayAffinity = (hwnd, affinity) => {
      clock.advance(READ_BACK_DEADLINE_MS); // exactly at deadline
      return originalSet(hwnd, affinity);
    };

    const result = manager.applyCaptureProtection(true);

    expect(result.status).toBe(CaptureProtectionStatus.READ_BACK_TIMEOUT);
  });

  it('includes elapsedMs in all results', () => {
    const clock = createMockClock(0);
    const api = createMockApi({ getResult: DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE });
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    const originalSet = api.setWindowDisplayAffinity.bind(api);
    api.setWindowDisplayAffinity = (hwnd, affinity) => {
      clock.advance(5);
      return originalSet(hwnd, affinity);
    };
    const originalGet = api.getWindowDisplayAffinity.bind(api);
    api.getWindowDisplayAffinity = (hwnd) => {
      clock.advance(10);
      return originalGet(hwnd);
    };

    const result = manager.applyCaptureProtection(true);

    expect(result.elapsedMs).toBe(15);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Mismatch detection (Req 12.5)
// ────────────────────────────────────────────────────────────────────

describe('DisplayAffinityManager — mismatch detection', () => {
  it('reports READ_BACK_MISMATCH when read-back differs from request (Req 12.5)', () => {
    const clock = createMockClock(0);
    // Set succeeds but read-back returns WDA_NONE instead of WDA_EXCLUDEFROMCAPTURE
    const api = createMockApi({
      setResult: true,
      getResult: DisplayAffinityValue.WDA_NONE,
    });
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    const result = manager.applyCaptureProtection(true);

    expect(result.status).toBe(CaptureProtectionStatus.READ_BACK_MISMATCH);
    expect(result.requestedValue).toBe(DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE);
    expect(result.readBackValue).toBe(DisplayAffinityValue.WDA_NONE);
  });

  it('reports READ_BACK_MISMATCH when GetWindowDisplayAffinity returns null', () => {
    const clock = createMockClock(0);
    const api = createMockApi({
      setResult: true,
      getResult: null,
    });
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    const result = manager.applyCaptureProtection(true);

    expect(result.status).toBe(CaptureProtectionStatus.READ_BACK_MISMATCH);
    expect(result.readBackValue).toBeNull();
  });

  it('reports READ_BACK_MISMATCH when disabling but read-back still shows protected', () => {
    const clock = createMockClock(0);
    const api = createMockApi({
      setResult: true,
      getResult: DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE, // still protected!
    });
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    const result = manager.applyCaptureProtection(false);

    expect(result.status).toBe(CaptureProtectionStatus.READ_BACK_MISMATCH);
    expect(result.requestedValue).toBe(DisplayAffinityValue.WDA_NONE);
    expect(result.readBackValue).toBe(DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Apply failure (Req 12.5)
// ────────────────────────────────────────────────────────────────────

describe('DisplayAffinityManager — apply failure', () => {
  it('reports APPLY_FAILED when SetWindowDisplayAffinity returns false', () => {
    const clock = createMockClock(0);
    const api = createMockApi({ setResult: false });
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    const result = manager.applyCaptureProtection(true);

    expect(result.status).toBe(CaptureProtectionStatus.APPLY_FAILED);
    expect(result.requestedValue).toBe(DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE);
    expect(result.readBackValue).toBeNull();
  });

  it('does not call GetWindowDisplayAffinity after set failure', () => {
    const clock = createMockClock(0);
    const api = createMockApi({ setResult: false });
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    manager.applyCaptureProtection(true);

    expect(api.getCalls).toHaveLength(0);
  });

  it('reports APPLY_FAILED when hwnd is null', () => {
    const clock = createMockClock(0);
    const api = createMockApi();
    const manager = new DisplayAffinityManager(api, clock);
    // Do NOT set hwnd

    const result = manager.applyCaptureProtection(true);

    expect(result.status).toBe(CaptureProtectionStatus.APPLY_FAILED);
    expect(api.setCalls).toHaveLength(0);
    expect(api.getCalls).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Reapply after lifecycle events (Req 12.10)
// ────────────────────────────────────────────────────────────────────

describe('DisplayAffinityManager — reapply after lifecycle events', () => {
  let manager: DisplayAffinityManager;
  let api: ReturnType<typeof createMockApi>;
  let clock: ReturnType<typeof createMockClock>;

  beforeEach(() => {
    clock = createMockClock();
    api = createMockApi({ getResult: DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE });
    manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);
    // Initial apply
    manager.applyCaptureProtection(true);
    // Reset tracking
    api.setCalls.length = 0;
    api.getCalls.length = 0;
  });

  it('reapplies after CREATE trigger (Req 12.10)', () => {
    const result = manager.reapplyIfNeeded(ReapplyTrigger.CREATE);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(CaptureProtectionStatus.APPLIED);
    expect(api.setCalls).toHaveLength(1);
    expect(api.setCalls[0].affinity).toBe(DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE);
  });

  it('reapplies after RECREATE trigger (Req 12.10)', () => {
    const result = manager.reapplyIfNeeded(ReapplyTrigger.RECREATE);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(CaptureProtectionStatus.APPLIED);
    expect(api.setCalls).toHaveLength(1);
  });

  it('reapplies after SHOW trigger (Req 12.10)', () => {
    const result = manager.reapplyIfNeeded(ReapplyTrigger.SHOW);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(CaptureProtectionStatus.APPLIED);
    expect(api.setCalls).toHaveLength(1);
  });

  it('reapplies after DISPLAY_MIGRATION trigger (Req 12.10)', () => {
    const result = manager.reapplyIfNeeded(ReapplyTrigger.DISPLAY_MIGRATION);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(CaptureProtectionStatus.APPLIED);
    expect(api.setCalls).toHaveLength(1);
  });

  it('reapplies WDA_NONE when protection is disabled', () => {
    // Switch to disabled
    const apiDisabled = createMockApi({ getResult: DisplayAffinityValue.WDA_NONE });
    const mgrDisabled = new DisplayAffinityManager(apiDisabled, clock);
    mgrDisabled.setHwnd(FAKE_HWND);
    mgrDisabled.applyCaptureProtection(false);
    apiDisabled.setCalls.length = 0;

    const result = mgrDisabled.reapplyIfNeeded(ReapplyTrigger.SHOW);

    expect(result).not.toBeNull();
    expect(result!.requestedValue).toBe(DisplayAffinityValue.WDA_NONE);
    expect(apiDisabled.setCalls[0].affinity).toBe(DisplayAffinityValue.WDA_NONE);
  });

  it('setHwndAndReapply updates hwnd and reapplies', () => {
    const newHwnd = 0xCAFE_BABE;

    const result = manager.setHwndAndReapply(newHwnd, ReapplyTrigger.RECREATE);

    expect(result).not.toBeNull();
    expect(api.setCalls).toHaveLength(1);
    expect(api.setCalls[0].hwnd).toBe(newHwnd);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: State tracking
// ────────────────────────────────────────────────────────────────────

describe('DisplayAffinityManager — state tracking', () => {
  it('tracks enabled state after successful apply', () => {
    const clock = createMockClock(1000);
    const api = createMockApi({ getResult: DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE });
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    manager.applyCaptureProtection(true);
    const state = manager.getState();

    expect(state.enabled).toBe(true);
    expect(state.verified).toBe(true);
    expect(state.lastAppliedMs).toBeGreaterThan(0);
  });

  it('tracks disabled state', () => {
    const clock = createMockClock(1000);
    const api = createMockApi({ getResult: DisplayAffinityValue.WDA_NONE });
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    manager.applyCaptureProtection(false);
    const state = manager.getState();

    expect(state.enabled).toBe(false);
    expect(state.verified).toBe(true);
  });

  it('marks verified=false on apply failure', () => {
    const clock = createMockClock(0);
    const api = createMockApi({ setResult: false });
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    manager.applyCaptureProtection(true);
    const state = manager.getState();

    expect(state.enabled).toBe(true);
    expect(state.verified).toBe(false);
  });

  it('marks verified=false on mismatch', () => {
    const clock = createMockClock(0);
    const api = createMockApi({
      setResult: true,
      getResult: DisplayAffinityValue.WDA_NONE, // mismatch
    });
    const manager = new DisplayAffinityManager(api, clock);
    manager.setHwnd(FAKE_HWND);

    manager.applyCaptureProtection(true);
    const state = manager.getState();

    expect(state.enabled).toBe(true);
    expect(state.verified).toBe(false);
  });

  it('initial state is disabled and unverified', () => {
    const clock = createMockClock(0);
    const api = createMockApi();
    const manager = new DisplayAffinityManager(api, clock);

    const state = manager.getState();

    expect(state.enabled).toBe(false);
    expect(state.verified).toBe(false);
    expect(state.lastAppliedMs).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Typed results completeness
// ────────────────────────────────────────────────────────────────────

describe('DisplayAffinityManager — typed result completeness', () => {
  it('every result has status, requestedValue, readBackValue, and elapsedMs', () => {
    const clock = createMockClock(0);
    const results: CaptureProtectionResult[] = [];

    // APPLIED
    const apiSuccess = createMockApi({ getResult: DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE });
    const mgr1 = new DisplayAffinityManager(apiSuccess, clock);
    mgr1.setHwnd(FAKE_HWND);
    results.push(mgr1.applyCaptureProtection(true));

    // APPLY_FAILED
    const apiFail = createMockApi({ setResult: false });
    const mgr2 = new DisplayAffinityManager(apiFail, clock);
    mgr2.setHwnd(FAKE_HWND);
    results.push(mgr2.applyCaptureProtection(true));

    // READ_BACK_MISMATCH
    const apiMismatch = createMockApi({ setResult: true, getResult: DisplayAffinityValue.WDA_NONE });
    const mgr3 = new DisplayAffinityManager(apiMismatch, clock);
    mgr3.setHwnd(FAKE_HWND);
    results.push(mgr3.applyCaptureProtection(true));

    // READ_BACK_TIMEOUT
    const clockTimeout = createMockClock(0);
    const apiTimeout = createMockApi({ getResult: DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE });
    const mgr4 = new DisplayAffinityManager(apiTimeout, clockTimeout);
    mgr4.setHwnd(FAKE_HWND);
    const originalSet = apiTimeout.setWindowDisplayAffinity.bind(apiTimeout);
    apiTimeout.setWindowDisplayAffinity = (hwnd, affinity) => {
      clockTimeout.advance(READ_BACK_DEADLINE_MS + 1);
      return originalSet(hwnd, affinity);
    };
    results.push(mgr4.applyCaptureProtection(true));

    // Verify all results have the required fields
    for (const result of results) {
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('requestedValue');
      expect(result).toHaveProperty('readBackValue');
      expect(result).toHaveProperty('elapsedMs');
      expect(typeof result.elapsedMs).toBe('number');
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    }

    // Verify we got all four statuses
    const statuses = results.map((r) => r.status);
    expect(statuses).toContain(CaptureProtectionStatus.APPLIED);
    expect(statuses).toContain(CaptureProtectionStatus.APPLY_FAILED);
    expect(statuses).toContain(CaptureProtectionStatus.READ_BACK_MISMATCH);
    expect(statuses).toContain(CaptureProtectionStatus.READ_BACK_TIMEOUT);
  });
});
