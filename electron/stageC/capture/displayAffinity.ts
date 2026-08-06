/**
 * Stage C — Display Affinity Capture Protection
 *
 * Applies and verifies SetWindowDisplayAffinity on the native floating surface.
 * Maps enabled → WDA_EXCLUDEFROMCAPTURE, disabled → WDA_NONE.
 * Performs read-back verification within 100ms and returns typed results.
 * Tracks state for reapplication after create, recreate, show, and display migration.
 *
 * Requirements: 12.1–12.5, 12.10
 */

// ────────────────────────────────────────────────────────────────────
// Win32 Display Affinity Constants
// ────────────────────────────────────────────────────────────────────

export enum DisplayAffinityValue {
  /** No display affinity — window appears in screen capture normally. */
  WDA_NONE = 0x00000000,
  /** Exclude from capture — window content is invisible to capture APIs. */
  WDA_EXCLUDEFROMCAPTURE = 0x00000011,
}

// ────────────────────────────────────────────────────────────────────
// Result Types
// ────────────────────────────────────────────────────────────────────

/** Status codes for capture protection operations. */
export enum CaptureProtectionStatus {
  /** Successfully set and verified via read-back. */
  APPLIED = 'APPLIED',
  /** SetWindowDisplayAffinity returned false/error. */
  APPLY_FAILED = 'APPLY_FAILED',
  /** Read-back value does not match requested value. */
  READ_BACK_MISMATCH = 'READ_BACK_MISMATCH',
  /** Read-back verification did not complete within 100ms. */
  READ_BACK_TIMEOUT = 'READ_BACK_TIMEOUT',
}

/** Structured result of a capture protection operation. */
export interface CaptureProtectionResult {
  /** Outcome status of the operation. */
  status: CaptureProtectionStatus;
  /** The display affinity value that was requested. */
  requestedValue: DisplayAffinityValue;
  /** The display affinity value read back (null if read-back failed/timeout). */
  readBackValue: DisplayAffinityValue | null;
  /** Elapsed time in milliseconds for the operation. */
  elapsedMs: number;
}

/** Internal tracked state for reapply logic. */
export interface CaptureProtectionState {
  /** Whether capture protection is enabled. */
  enabled: boolean;
  /** Timestamp of last successful application (ms since epoch). */
  lastAppliedMs: number;
  /** Whether the last application was verified via read-back. */
  verified: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Lifecycle reapply trigger events
// ────────────────────────────────────────────────────────────────────

export enum ReapplyTrigger {
  CREATE = 'create',
  RECREATE = 'recreate',
  SHOW = 'show',
  DISPLAY_MIGRATION = 'display_migration',
}

// ────────────────────────────────────────────────────────────────────
// Win32 API Dependency Interface (for testability)
// ────────────────────────────────────────────────────────────────────

/**
 * Abstraction over SetWindowDisplayAffinity and GetWindowDisplayAffinity
 * to allow unit testing without real Win32 calls.
 */
export interface DisplayAffinityApi {
  /** Calls SetWindowDisplayAffinity(hwnd, affinity). Returns true on success. */
  setWindowDisplayAffinity(hwnd: unknown, affinity: number): boolean;
  /** Calls GetWindowDisplayAffinity(hwnd). Returns the affinity value or null on failure. */
  getWindowDisplayAffinity(hwnd: unknown): number | null;
}

/**
 * Clock abstraction for testability of timing constraints.
 */
export interface AffinityClock {
  /** Returns current time in milliseconds. */
  now(): number;
}

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

/** Maximum time allowed for read-back verification (Req 12.3). */
export const READ_BACK_DEADLINE_MS = 100;

// ────────────────────────────────────────────────────────────────────
// Default implementations
// ────────────────────────────────────────────────────────────────────

/** Default clock using performance.now() for monotonic timing. */
export const DEFAULT_CLOCK: AffinityClock = {
  now: () => performance.now(),
};

// ────────────────────────────────────────────────────────────────────
// Core Implementation
// ────────────────────────────────────────────────────────────────────

/**
 * Manages display affinity capture protection for a native floating surface.
 *
 * Tracks state and provides reapply semantics after lifecycle events.
 */
export class DisplayAffinityManager {
  private state: CaptureProtectionState = {
    enabled: false,
    lastAppliedMs: 0,
    verified: false,
  };

  private readonly api: DisplayAffinityApi;
  private readonly clock: AffinityClock;
  private hwnd: unknown | null = null;

  constructor(api: DisplayAffinityApi, clock: AffinityClock = DEFAULT_CLOCK) {
    this.api = api;
    this.clock = clock;
  }

  /**
   * Set the HWND target for affinity operations.
   * Must be called before applyCaptureProtection or reapplyIfNeeded.
   */
  setHwnd(hwnd: unknown): void {
    this.hwnd = hwnd;
  }

  /**
   * Get the current tracked capture protection state.
   */
  getState(): Readonly<CaptureProtectionState> {
    return { ...this.state };
  }

  /**
   * Apply capture protection to the floating surface.
   *
   * Maps enabled → WDA_EXCLUDEFROMCAPTURE, disabled → WDA_NONE (Req 12.1, 12.2).
   * Performs read-back verification within 100ms (Req 12.3).
   * Returns typed result indicating success/failure mode (Req 12.4, 12.5).
   */
  applyCaptureProtection(enabled: boolean): CaptureProtectionResult {
    const startTime = this.clock.now();

    const requestedValue = enabled
      ? DisplayAffinityValue.WDA_EXCLUDEFROMCAPTURE
      : DisplayAffinityValue.WDA_NONE;

    if (this.hwnd === null) {
      return {
        status: CaptureProtectionStatus.APPLY_FAILED,
        requestedValue,
        readBackValue: null,
        elapsedMs: this.clock.now() - startTime,
      };
    }

    // Step 1: Apply the display affinity value
    const setSuccess = this.api.setWindowDisplayAffinity(this.hwnd, requestedValue);
    if (!setSuccess) {
      const elapsed = this.clock.now() - startTime;
      this.state = { enabled, lastAppliedMs: 0, verified: false };
      return {
        status: CaptureProtectionStatus.APPLY_FAILED,
        requestedValue,
        readBackValue: null,
        elapsedMs: elapsed,
      };
    }

    // Step 2: Read-back verification within 100ms deadline (Req 12.3)
    const result = this.readBackCaptureState(requestedValue, startTime);

    // Update tracked state
    if (result.status === CaptureProtectionStatus.APPLIED) {
      this.state = {
        enabled,
        lastAppliedMs: this.clock.now(),
        verified: true,
      };
    } else {
      this.state = { enabled, lastAppliedMs: 0, verified: false };
    }

    return result;
  }

  /**
   * Perform read-back verification of the current display affinity value.
   *
   * Returns typed result: APPLIED if matches, READ_BACK_MISMATCH if different,
   * READ_BACK_TIMEOUT if verification exceeds 100ms (Req 12.3–12.5).
   */
  private readBackCaptureState(
    expectedValue: DisplayAffinityValue,
    startTime: number,
  ): CaptureProtectionResult {
    const elapsed = this.clock.now() - startTime;

    // Check if we've already exceeded the deadline before even attempting read-back
    if (elapsed >= READ_BACK_DEADLINE_MS) {
      return {
        status: CaptureProtectionStatus.READ_BACK_TIMEOUT,
        requestedValue: expectedValue,
        readBackValue: null,
        elapsedMs: elapsed,
      };
    }

    // Perform the read-back
    const readBack = this.api.getWindowDisplayAffinity(this.hwnd);
    const totalElapsed = this.clock.now() - startTime;

    // Check timeout after read-back
    if (totalElapsed >= READ_BACK_DEADLINE_MS) {
      return {
        status: CaptureProtectionStatus.READ_BACK_TIMEOUT,
        requestedValue: expectedValue,
        readBackValue: readBack !== null ? readBack as DisplayAffinityValue : null,
        elapsedMs: totalElapsed,
      };
    }

    // Read-back failed (API returned null)
    if (readBack === null) {
      return {
        status: CaptureProtectionStatus.READ_BACK_MISMATCH,
        requestedValue: expectedValue,
        readBackValue: null,
        elapsedMs: totalElapsed,
      };
    }

    // Compare read-back with expected
    if (readBack !== expectedValue) {
      return {
        status: CaptureProtectionStatus.READ_BACK_MISMATCH,
        requestedValue: expectedValue,
        readBackValue: readBack as DisplayAffinityValue,
        elapsedMs: totalElapsed,
      };
    }

    // Success: value matches
    return {
      status: CaptureProtectionStatus.APPLIED,
      requestedValue: expectedValue,
      readBackValue: readBack as DisplayAffinityValue,
      elapsedMs: totalElapsed,
    };
  }

  /**
   * Reapply capture protection after lifecycle events.
   *
   * Called after create, recreate, show, and display migration (Req 12.10).
   * Returns the application result, or null if no protection is currently enabled.
   */
  reapplyIfNeeded(trigger: ReapplyTrigger): CaptureProtectionResult | null {
    // Always reapply after lifecycle events regardless of current state
    // because the OS may have reset the affinity value (Req 12.10)
    return this.applyCaptureProtection(this.state.enabled);
  }

  /**
   * Update the HWND and reapply protection.
   * Used when the window is recreated with a new handle.
   */
  setHwndAndReapply(hwnd: unknown, trigger: ReapplyTrigger): CaptureProtectionResult | null {
    this.hwnd = hwnd;
    return this.reapplyIfNeeded(trigger);
  }
}
