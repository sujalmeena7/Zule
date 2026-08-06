/**
 * Stage C — Capture Fallback and Layer 0 Parity Tests
 *
 * Verifies:
 * - Stage C is hidden before Layer 0 is shown (Req 12.7, 13.8)
 * - Recovery completes within 500ms (Req 12.6, 13.8)
 * - Dashboard capture is never modified (Req 12.11)
 * - Typed degradation for each failure mode (Req 12.9, 12.12)
 * - Layer 0 has correct capture value after fallback (Req 12.8)
 *
 * Requirements: 12.6–12.12, 13.8–13.12
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  executeCaptureFallback,
  CaptureFallbackStatus,
  RECOVERY_DEADLINE_MS,
  type CaptureFallbackDeps,
  type CaptureFallbackResult,
  type FallbackClock,
} from '../../../stageC/capture/captureFallback';

// ────────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────────

/** Creates a controllable clock for testing timing behavior. */
function createMockClock(initialTime = 0): FallbackClock & { time: number; advance(ms: number): void } {
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

/** Records the order in which dependency operations are called. */
type OperationLog = Array<'hideStageC' | 'showLayer0' | 'applyLayer0Capture' | 'verifyLayer0Capture' | 'getRequestedCaptureValue'>;

/** Creates mock deps with configurable behavior and operation logging. */
function createMockDeps(options: {
  hideResult?: boolean;
  showResult?: boolean;
  applyResult?: boolean;
  verifyResult?: boolean;
  requestedValue?: boolean;
  onHide?: () => void;
  onShow?: () => void;
  onApply?: (enabled: boolean) => void;
  onVerify?: (enabled: boolean) => void;
} = {}): CaptureFallbackDeps & { log: OperationLog } {
  const {
    hideResult = true,
    showResult = true,
    applyResult = true,
    verifyResult = true,
    requestedValue = true,
    onHide,
    onShow,
    onApply,
    onVerify,
  } = options;

  const log: OperationLog = [];

  return {
    log,
    hideStageC(): boolean {
      log.push('hideStageC');
      onHide?.();
      return hideResult;
    },
    showLayer0(): boolean {
      log.push('showLayer0');
      onShow?.();
      return showResult;
    },
    applyLayer0Capture(enabled: boolean): boolean {
      log.push('applyLayer0Capture');
      onApply?.(enabled);
      return applyResult;
    },
    verifyLayer0Capture(enabled: boolean): boolean {
      log.push('verifyLayer0Capture');
      onVerify?.(enabled);
      return verifyResult;
    },
    getRequestedCaptureValue(): boolean {
      log.push('getRequestedCaptureValue');
      return requestedValue;
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Tests: Stage C hidden before Layer 0 shown (Req 12.7, 13.8)
// ────────────────────────────────────────────────────────────────────

describe('Capture Fallback — ordering guarantees', () => {
  it('hides Stage C before showing Layer 0 (Req 12.7, 13.8)', () => {
    const clock = createMockClock();
    const deps = createMockDeps();

    executeCaptureFallback(deps, clock);

    const hideIndex = deps.log.indexOf('hideStageC');
    const showIndex = deps.log.indexOf('showLayer0');

    expect(hideIndex).toBeGreaterThanOrEqual(0);
    expect(showIndex).toBeGreaterThanOrEqual(0);
    expect(hideIndex).toBeLessThan(showIndex);
  });

  it('hides Stage C before applying Layer 0 capture (Req 12.7)', () => {
    const clock = createMockClock();
    const deps = createMockDeps();

    executeCaptureFallback(deps, clock);

    const hideIndex = deps.log.indexOf('hideStageC');
    const applyIndex = deps.log.indexOf('applyLayer0Capture');

    expect(hideIndex).toBeLessThan(applyIndex);
  });

  it('applies Layer 0 capture before showing Layer 0 (Req 12.8)', () => {
    const clock = createMockClock();
    const deps = createMockDeps();

    executeCaptureFallback(deps, clock);

    const applyIndex = deps.log.indexOf('applyLayer0Capture');
    const showIndex = deps.log.indexOf('showLayer0');

    expect(applyIndex).toBeLessThan(showIndex);
  });

  it('verifies Layer 0 capture before showing Layer 0 (Req 12.8)', () => {
    const clock = createMockClock();
    const deps = createMockDeps();

    executeCaptureFallback(deps, clock);

    const verifyIndex = deps.log.indexOf('verifyLayer0Capture');
    const showIndex = deps.log.indexOf('showLayer0');

    expect(verifyIndex).toBeLessThan(showIndex);
  });

  it('always calls hideStageC first in the operation sequence', () => {
    const clock = createMockClock();
    const deps = createMockDeps();

    executeCaptureFallback(deps, clock);

    expect(deps.log[0]).toBe('hideStageC');
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: 500ms recovery deadline (Req 12.6, 13.8)
// ────────────────────────────────────────────────────────────────────

describe('Capture Fallback — 500ms recovery deadline', () => {
  it('completes within 500ms under normal conditions (Req 12.6)', () => {
    const clock = createMockClock();
    const deps = createMockDeps({
      onHide: () => clock.advance(10),
      onApply: () => clock.advance(20),
      onVerify: () => clock.advance(30),
      onShow: () => clock.advance(10),
    });

    const result = executeCaptureFallback(deps, clock);

    expect(result.recoveryMs).toBeLessThan(RECOVERY_DEADLINE_MS);
    expect(result.status).toBe(CaptureFallbackStatus.FALLBACK_COMPLETE);
  });

  it('reports RECOVERY_TIMEOUT when apply exceeds deadline (Req 13.8)', () => {
    const clock = createMockClock();
    const deps = createMockDeps({
      onHide: () => clock.advance(10),
      onApply: () => clock.advance(RECOVERY_DEADLINE_MS), // exceeds deadline
    });

    const result = executeCaptureFallback(deps, clock);

    expect(result.status).toBe(CaptureFallbackStatus.RECOVERY_TIMEOUT);
    expect(result.layer0Visible).toBe(true); // Still shows Layer 0
  });

  it('reports RECOVERY_TIMEOUT when verification exceeds deadline', () => {
    const clock = createMockClock();
    const deps = createMockDeps({
      onHide: () => clock.advance(10),
      onApply: () => clock.advance(100),
      onVerify: () => clock.advance(RECOVERY_DEADLINE_MS), // pushes past deadline
    });

    const result = executeCaptureFallback(deps, clock);

    expect(result.status).toBe(CaptureFallbackStatus.RECOVERY_TIMEOUT);
    expect(result.layer0Visible).toBe(true);
  });

  it('reports RECOVERY_TIMEOUT when showLayer0 causes deadline exceed', () => {
    const clock = createMockClock();
    const deps = createMockDeps({
      onHide: () => clock.advance(10),
      onApply: () => clock.advance(100),
      onVerify: () => clock.advance(100),
      onShow: () => clock.advance(RECOVERY_DEADLINE_MS), // exceeds during show
    });

    const result = executeCaptureFallback(deps, clock);

    expect(result.status).toBe(CaptureFallbackStatus.RECOVERY_TIMEOUT);
  });

  it('always shows Layer 0 even when deadline is exceeded (Req 12.6)', () => {
    const clock = createMockClock();
    const deps = createMockDeps({
      onHide: () => clock.advance(RECOVERY_DEADLINE_MS + 100),
    });

    const result = executeCaptureFallback(deps, clock);

    expect(result.layer0Visible).toBe(true);
    // showLayer0 should still be called
    expect(deps.log).toContain('showLayer0');
  });

  it('RECOVERY_DEADLINE_MS is exactly 500', () => {
    expect(RECOVERY_DEADLINE_MS).toBe(500);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Dashboard capture never modified (Req 12.11)
// ────────────────────────────────────────────────────────────────────

describe('Capture Fallback — Dashboard ownership (Req 12.11)', () => {
  it('only calls applyLayer0Capture and verifyLayer0Capture, never Dashboard ops', () => {
    const clock = createMockClock();
    const deps = createMockDeps();

    executeCaptureFallback(deps, clock);

    // The deps interface has no Dashboard methods by design.
    // All operations in the log relate only to Stage C and Layer 0.
    const validOps = new Set([
      'hideStageC',
      'showLayer0',
      'applyLayer0Capture',
      'verifyLayer0Capture',
      'getRequestedCaptureValue',
    ]);

    for (const op of deps.log) {
      expect(validOps.has(op)).toBe(true);
    }
  });

  it('the dependency interface has no Dashboard-related methods', () => {
    // This is a compile-time guarantee enforced by the CaptureFallbackDeps type.
    // The interface only has: hideStageC, showLayer0, applyLayer0Capture,
    // verifyLayer0Capture, getRequestedCaptureValue.
    const deps = createMockDeps();
    const keys = Object.keys(deps).filter((k) => k !== 'log');

    expect(keys).not.toContain('applyDashboardCapture');
    expect(keys).not.toContain('modifyDashboard');
    expect(keys).not.toContain('setDashboardProtection');
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Typed degradation for each failure mode (Req 12.9, 12.12)
// ────────────────────────────────────────────────────────────────────

describe('Capture Fallback — typed degradation', () => {
  it('returns FALLBACK_COMPLETE when apply and verify succeed within deadline', () => {
    const clock = createMockClock();
    const deps = createMockDeps({ applyResult: true, verifyResult: true });

    const result = executeCaptureFallback(deps, clock);

    expect(result.status).toBe(CaptureFallbackStatus.FALLBACK_COMPLETE);
    expect(result.captureValueApplied).toBe(true);
    expect(result.layer0Visible).toBe(true);
  });

  it('returns FALLBACK_PARTIAL when apply succeeds but verify fails (Req 12.9)', () => {
    const clock = createMockClock();
    const deps = createMockDeps({ applyResult: true, verifyResult: false });

    const result = executeCaptureFallback(deps, clock);

    expect(result.status).toBe(CaptureFallbackStatus.FALLBACK_PARTIAL);
    expect(result.captureValueApplied).toBe(true);
    expect(result.layer0Visible).toBe(true);
  });

  it('returns FALLBACK_PARTIAL when apply fails (Req 12.9)', () => {
    const clock = createMockClock();
    const deps = createMockDeps({ applyResult: false });

    const result = executeCaptureFallback(deps, clock);

    expect(result.status).toBe(CaptureFallbackStatus.FALLBACK_PARTIAL);
    expect(result.captureValueApplied).toBe(false);
    expect(result.layer0Visible).toBe(true);
  });

  it('returns RECOVERY_TIMEOUT when deadline is exceeded', () => {
    const clock = createMockClock();
    const deps = createMockDeps({
      onHide: () => clock.advance(RECOVERY_DEADLINE_MS + 1),
    });

    const result = executeCaptureFallback(deps, clock);

    expect(result.status).toBe(CaptureFallbackStatus.RECOVERY_TIMEOUT);
    expect(result.layer0Visible).toBe(true);
  });

  it('never uses impossibility language in status values (Req 12.12)', () => {
    // Status values describe observed state, not impossibility
    const allStatuses = Object.values(CaptureFallbackStatus);

    for (const status of allStatuses) {
      expect(status.toLowerCase()).not.toContain('impossible');
      expect(status.toLowerCase()).not.toContain('cannot');
      expect(status.toLowerCase()).not.toContain('never');
    }
  });

  it('result always includes recoveryMs, captureValueApplied, layer0Visible', () => {
    const clock = createMockClock();
    const deps = createMockDeps();

    const result = executeCaptureFallback(deps, clock);

    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('recoveryMs');
    expect(result).toHaveProperty('captureValueApplied');
    expect(result).toHaveProperty('layer0Visible');
    expect(typeof result.recoveryMs).toBe('number');
    expect(typeof result.captureValueApplied).toBe('boolean');
    expect(typeof result.layer0Visible).toBe('boolean');
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Layer 0 capture parity (Req 12.8)
// ────────────────────────────────────────────────────────────────────

describe('Capture Fallback — Layer 0 capture parity', () => {
  it('applies the same capture value user requested (enabled=true)', () => {
    const clock = createMockClock();
    let appliedValue: boolean | undefined;
    const deps = createMockDeps({
      requestedValue: true,
      onApply: (enabled) => { appliedValue = enabled; },
    });

    executeCaptureFallback(deps, clock);

    expect(appliedValue).toBe(true);
  });

  it('applies the same capture value user requested (enabled=false)', () => {
    const clock = createMockClock();
    let appliedValue: boolean | undefined;
    const deps = createMockDeps({
      requestedValue: false,
      onApply: (enabled) => { appliedValue = enabled; },
    });

    executeCaptureFallback(deps, clock);

    expect(appliedValue).toBe(false);
  });

  it('verifies with the same value that was requested', () => {
    const clock = createMockClock();
    let verifiedValue: boolean | undefined;
    const deps = createMockDeps({
      requestedValue: true,
      onVerify: (enabled) => { verifiedValue = enabled; },
    });

    executeCaptureFallback(deps, clock);

    expect(verifiedValue).toBe(true);
  });

  it('skips verification when apply fails', () => {
    const clock = createMockClock();
    const deps = createMockDeps({ applyResult: false });

    executeCaptureFallback(deps, clock);

    expect(deps.log).not.toContain('verifyLayer0Capture');
  });

  it('queries requested value after hiding Stage C', () => {
    const clock = createMockClock();
    const deps = createMockDeps();

    executeCaptureFallback(deps, clock);

    const hideIndex = deps.log.indexOf('hideStageC');
    const getValueIndex = deps.log.indexOf('getRequestedCaptureValue');

    expect(hideIndex).toBeLessThan(getValueIndex);
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Fallback state preservation (Req 13.11, 13.12)
// ────────────────────────────────────────────────────────────────────

describe('Capture Fallback — state preservation (Req 13.11, 13.12)', () => {
  it('always results in Layer 0 being visible regardless of failures', () => {
    const clock = createMockClock();

    // Test with hideStageC failure
    const deps1 = createMockDeps({ hideResult: false });
    const result1 = executeCaptureFallback(deps1, clock);
    expect(result1.layer0Visible).toBe(true);

    // Test with apply failure
    const deps2 = createMockDeps({ applyResult: false });
    const result2 = executeCaptureFallback(deps2, clock);
    expect(result2.layer0Visible).toBe(true);

    // Test with verify failure
    const deps3 = createMockDeps({ verifyResult: false });
    const result3 = executeCaptureFallback(deps3, clock);
    expect(result3.layer0Visible).toBe(true);
  });

  it('reports recoveryMs accurately for timing analysis', () => {
    const clock = createMockClock(1000);
    const deps = createMockDeps({
      onHide: () => clock.advance(50),
      onApply: () => clock.advance(30),
      onVerify: () => clock.advance(20),
      onShow: () => clock.advance(10),
    });

    const result = executeCaptureFallback(deps, clock);

    expect(result.recoveryMs).toBe(110);
  });

  it('proceeds through full sequence even when hideStageC fails', () => {
    const clock = createMockClock();
    const deps = createMockDeps({ hideResult: false });

    executeCaptureFallback(deps, clock);

    // Should still proceed to apply and show Layer 0
    expect(deps.log).toContain('applyLayer0Capture');
    expect(deps.log).toContain('showLayer0');
  });
});

// ────────────────────────────────────────────────────────────────────
// Tests: Edge cases
// ────────────────────────────────────────────────────────────────────

describe('Capture Fallback — edge cases', () => {
  it('handles showLayer0 returning false gracefully', () => {
    const clock = createMockClock();
    const deps = createMockDeps({ showResult: false });

    const result = executeCaptureFallback(deps, clock);

    expect(result.layer0Visible).toBe(false);
  });

  it('handles all operations failing gracefully', () => {
    const clock = createMockClock();
    const deps = createMockDeps({
      hideResult: false,
      showResult: false,
      applyResult: false,
      verifyResult: false,
    });

    const result = executeCaptureFallback(deps, clock);

    expect(result.status).toBe(CaptureFallbackStatus.FALLBACK_PARTIAL);
    expect(result.captureValueApplied).toBe(false);
    expect(result.layer0Visible).toBe(false);
  });

  it('exact deadline boundary: 499ms returns non-timeout status', () => {
    const clock = createMockClock();
    const deps = createMockDeps({
      onHide: () => clock.advance(200),
      onApply: () => clock.advance(200),
      onVerify: () => clock.advance(49),
      onShow: () => clock.advance(50),
    });

    const result = executeCaptureFallback(deps, clock);

    expect(result.recoveryMs).toBe(499);
    expect(result.status).toBe(CaptureFallbackStatus.FALLBACK_COMPLETE);
  });

  it('exact deadline boundary: 500ms triggers timeout', () => {
    const clock = createMockClock();
    const deps = createMockDeps({
      onHide: () => clock.advance(200),
      onApply: () => clock.advance(200),
      onVerify: () => clock.advance(50),
      onShow: () => clock.advance(50),
    });

    const result = executeCaptureFallback(deps, clock);

    expect(result.recoveryMs).toBe(500);
    expect(result.status).toBe(CaptureFallbackStatus.RECOVERY_TIMEOUT);
  });
});
