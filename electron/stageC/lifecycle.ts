/**
 * Stage C Lifecycle — Single-Surface Cutover, Crash/Timeout Fallback, Retry, and Shutdown Ownership
 *
 * Implements the strict lifecycle invariants for Stage C transitions:
 *
 * 1. **Single-surface cutover**: Strictly `hide Layer 0 → show Stage C` — never both visible.
 * 2. **Fallback ordering**: Strictly `hide/close Stage C → restore Layer 0` — never mismatched.
 * 3. **One transition owner**: Under timeout/disconnect/exit/capture races, exactly one code
 *    path handles the transition. Late notifications cannot mutate recovered Layer 0 state.
 * 4. **500ms recovery**: Total fallback-to-usable-Layer-0 within 500ms (integrates with captureFallback).
 * 5. **Two-second graceful shutdown**: `shutdown()` sends `lifecycle.shutdown`, waits 2s, kills.
 * 6. **Credential invalidation**: After disconnect/exit, invalidate Launch_Credential and overwrite buffers.
 * 7. **Orphan cleanup**: After process exit, verify no owned `ZuleUI.exe` or `ZuleUIWindow` top-level window.
 * 8. **Diagnostic retry**: One retry max, rate-limited per App Core launch.
 *
 * Requirements: 5.20–5.25, 13.1–13.17
 */

import type { ChildProcess } from 'node:child_process';
import { StageCPhase, StageCFailureReason, ControllerToSidecarType } from './protocol/schema';

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

/** Recovery deadline: Layer 0 must be usable within 500ms of fallback notification (Req 13.4–13.5). */
export const RECOVERY_DEADLINE_MS = 500;

/** Graceful shutdown wait time before forced termination (Req 5.20–5.21). */
export const SHUTDOWN_WAIT_MS = 2000;

/** Maximum diagnostic retries per App Core launch (Req 5.24). */
export const MAX_DIAGNOSTIC_RETRIES = 1;

// ────────────────────────────────────────────────────────────────────
// Transition Owner Guard
// ────────────────────────────────────────────────────────────────────

/**
 * Ensures exactly one transition owner under race conditions.
 *
 * Under simultaneous timeout, disconnect, process-exit, and capture-verification
 * notifications (Req 13.13), only the first caller acquires ownership. Subsequent
 * callers observe that the transition is already claimed and return immediately
 * without mutating Layer 0 state (Req 13.14).
 */
export class TransitionOwner {
  private _claimed = false;
  private _claimReason: string | null = null;

  /**
   * Attempt to claim transition ownership.
   * @returns true if this caller now owns the transition; false if already claimed.
   */
  claim(reason: string): boolean {
    if (this._claimed) return false;
    this._claimed = true;
    this._claimReason = reason;
    return true;
  }

  /** Whether any caller currently owns the transition. */
  get isClaimed(): boolean {
    return this._claimed;
  }

  /** The reason of the current owner, or null. */
  get claimReason(): string | null {
    return this._claimReason;
  }

  /** Reset ownership (only for reuse after full lifecycle reset). */
  reset(): void {
    this._claimed = false;
    this._claimReason = null;
  }
}

// ────────────────────────────────────────────────────────────────────
// Lifecycle Dependencies (injected for testability)
// ────────────────────────────────────────────────────────────────────

/**
 * Injectable dependencies for lifecycle operations.
 * Isolates native/OS/process concerns for unit testing.
 */
export interface LifecycleDeps {
  /** Hide or close the Stage C floating surface. Returns true on success. */
  hideStageCsurface(): boolean;

  /** Show the Stage C floating surface. Returns true on success. */
  showStageCsurface(): boolean;

  /** Show Layer 0 (make visible and usable). Returns true on success. */
  showLayer0(): boolean;

  /** Hide Layer 0. Returns true on success. */
  hideLayer0(): boolean;

  /** Whether Layer 0 is currently visible. */
  isLayer0Visible(): boolean;

  /** Whether Stage C surface is currently visible. */
  isStageCVisible(): boolean;

  /**
   * Send a message over the authenticated connection.
   * Returns true if sent successfully.
   */
  sendMessage(type: string, payload: Record<string, unknown>): boolean;

  /**
   * Wait for a specific message type or timeout.
   * Returns the received message or null on timeout.
   */
  waitForMessage(type: string, timeoutMs: number): Promise<unknown | null>;

  /** Kill the owned sidecar process. */
  killProcess(process: ChildProcess): void;

  /** Whether the owned process is still alive. */
  isProcessAlive(process: ChildProcess): boolean;

  /**
   * Invalidate the launch credential and overwrite mutable buffers (Req 6.12, 5.22).
   * Best-effort: failure does not block fallback.
   */
  invalidateCredential(credential: string | null): void;

  /**
   * Check for orphaned ZuleUI.exe processes or ZuleUIWindow top-level windows (Req 5.22).
   * Returns true if orphans were found (and cleaned).
   */
  checkAndCleanOrphans(sidecarPid: number | null): boolean;

  /**
   * Preserve the latest canonical state (revision, visibility, bounds, mode, capture) (Req 13.11).
   */
  preserveCanonicalState(): void;

  /** Emit a content-free telemetry event. */
  emitTelemetry(event: string, data?: Record<string, unknown>): void;

  /** Get current time in milliseconds (monotonic). */
  now(): number;
}

// ────────────────────────────────────────────────────────────────────
// Cutover Result
// ────────────────────────────────────────────────────────────────────

export interface CutoverResult {
  success: boolean;
  /** Time taken for the cutover in ms. */
  durationMs: number;
}

// ────────────────────────────────────────────────────────────────────
// Fallback Result
// ────────────────────────────────────────────────────────────────────

export interface FallbackResult {
  /** Whether Layer 0 was recovered within the deadline. */
  recovered: boolean;
  /** Reason that triggered the fallback. */
  reason: StageCFailureReason;
  /** Recovery duration in ms. */
  recoveryMs: number;
  /** Whether credentials were invalidated. */
  credentialInvalidated: boolean;
  /** Whether orphan cleanup was performed. */
  orphansCleaned: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Shutdown Result
// ────────────────────────────────────────────────────────────────────

export interface ShutdownResult {
  /** Whether shutdown completed gracefully (ack received within 2s). */
  graceful: boolean;
  /** Whether the process was force-killed after timeout. */
  forceKilled: boolean;
  /** Whether credentials were invalidated. */
  credentialInvalidated: boolean;
  /** Whether orphan cleanup passed. */
  orphansCleaned: boolean;
  /** Total shutdown duration in ms. */
  durationMs: number;
}

// ────────────────────────────────────────────────────────────────────
// Lifecycle Manager
// ────────────────────────────────────────────────────────────────────

/**
 * Manages Stage C lifecycle transitions with strict single-surface invariants.
 *
 * Each instance corresponds to one Stage C launch. The TransitionOwner ensures
 * that racing notifications (timeout, disconnect, exit, capture failure) resolve
 * to exactly one fallback execution path.
 */
export class LifecycleManager {
  private readonly deps: LifecycleDeps;
  private readonly transitionOwner = new TransitionOwner();
  private _phase: StageCPhase = StageCPhase.DISABLED;
  private _shutdownActive = false;
  private _diagnosticRetryCount = 0;
  private _credential: string | null = null;
  private _sidecarProcess: ChildProcess | null = null;
  private _sidecarPid: number | null = null;

  constructor(deps: LifecycleDeps) {
    this.deps = deps;
  }

  // ──────────────────────────────────────────────────────────────────
  // Public State
  // ──────────────────────────────────────────────────────────────────

  get phase(): StageCPhase {
    return this._phase;
  }

  get isShutdownActive(): boolean {
    return this._shutdownActive;
  }

  get diagnosticRetryCount(): number {
    return this._diagnosticRetryCount;
  }

  get transitionClaimed(): boolean {
    return this.transitionOwner.isClaimed;
  }

  // ──────────────────────────────────────────────────────────────────
  // Binding
  // ──────────────────────────────────────────────────────────────────

  /**
   * Bind a sidecar process and credential to this lifecycle manager.
   * Must be called after spawn + authentication succeeds.
   */
  bind(process: ChildProcess | null, pid: number | null, credential: string | null): void {
    this._sidecarProcess = process;
    this._sidecarPid = pid;
    this._credential = credential;
  }

  // ──────────────────────────────────────────────────────────────────
  // Single-Surface Cutover (Req 5.15, 13.7)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Perform the single-surface cutover: `hide Layer 0 → show Stage C`.
   *
   * Invariants:
   * - Layer 0 is hidden BEFORE Stage C is shown (Req 5.15, 13.7).
   * - At no point are both surfaces visible simultaneously (Req 13.10).
   * - If Stage C cannot be shown, Layer 0 is immediately restored.
   */
  cutover(): CutoverResult {
    const start = this.deps.now();

    // Step 1: Hide Layer 0 FIRST
    this.deps.hideLayer0();

    // Step 2: Show Stage C
    const showSuccess = this.deps.showStageCsurface();

    if (!showSuccess) {
      // Rollback: restore Layer 0 immediately
      this.deps.showLayer0();
      return { success: false, durationMs: this.deps.now() - start };
    }

    this._phase = StageCPhase.ACTIVE;
    return { success: true, durationMs: this.deps.now() - start };
  }

  // ──────────────────────────────────────────────────────────────────
  // Fallback (Req 13.4–13.14)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Execute fallback: `hide/close Stage C → restore Layer 0`.
   *
   * Invariants:
   * - Only ONE transition owner executes this under races (Req 13.13).
   * - Late notifications after fallback do NOT mutate Layer 0 (Req 13.14).
   * - Recovery must complete within 500ms (Req 13.4–13.5).
   * - Canonical state is preserved (Req 13.11).
   * - Credential is invalidated (Req 6.12, 5.22).
   * - Orphan cleanup is performed (Req 5.22).
   *
   * @param reason The typed failure reason.
   * @returns FallbackResult describing the outcome.
   */
  fallback(reason: StageCFailureReason): FallbackResult | null {
    // Req 13.13: Only one transition owner under race conditions
    if (!this.transitionOwner.claim(`fallback:${reason}`)) {
      // Late notification — do NOT mutate recovered Layer 0 state (Req 13.14)
      return null;
    }

    // Req 13.6: During normal shutdown, disconnect does not reopen Layer 0
    if (this._shutdownActive && reason === StageCFailureReason.IPC_DISCONNECT) {
      return {
        recovered: true,
        reason,
        recoveryMs: 0,
        credentialInvalidated: this.invalidateCredentialSafe(),
        orphansCleaned: false,
      };
    }

    const start = this.deps.now();
    this._phase = StageCPhase.FALLING_BACK;

    // Step 1: Hide/close Stage C FIRST (Req 13.8)
    // Before cutover: keep Layer 0 visible while cleaning hidden surface (Req 13.9)
    // After cutover: hide Stage C before showing Layer 0 (Req 13.8)
    this.deps.hideStageCsurface();

    // Step 2: Preserve canonical state (Req 13.11)
    this.deps.preserveCanonicalState();

    // Step 3: Show Layer 0 (Req 13.1, 13.4)
    this.deps.showLayer0();

    // Capture pid before terminate nullifies it
    const sidecarPid = this._sidecarPid;

    // Step 4: Terminate sidecar if alive
    this.terminateSidecar();

    // Step 5: Invalidate credential (Req 6.12, 5.22)
    const credentialInvalidated = this.invalidateCredentialSafe();

    // Step 6: Orphan cleanup (Req 5.22)
    const orphansCleaned = this.deps.checkAndCleanOrphans(sidecarPid);

    const recoveryMs = this.deps.now() - start;
    this._phase = StageCPhase.LAYER_0_ACTIVE;

    // Check 500ms recovery deadline (Req 13.4–13.5)
    if (recoveryMs > RECOVERY_DEADLINE_MS) {
      this.deps.emitTelemetry('fallback_recovery_exceeded', { recoveryMs, reason });
    }

    this.deps.emitTelemetry('stage_c_fallback', { reason, recoveryMs });

    return {
      recovered: recoveryMs <= RECOVERY_DEADLINE_MS,
      reason,
      recoveryMs,
      credentialInvalidated,
      orphansCleaned,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Graceful Shutdown (Req 5.20–5.22)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Perform graceful shutdown:
   * 1. Send `lifecycle.shutdown` (Req 5.20).
   * 2. Wait 2 seconds for sidecar exit (Req 5.20).
   * 3. Kill if still alive (Req 5.21).
   * 4. Close endpoint, invalidate credential, release handles (Req 5.22).
   * 5. Verify no orphans remain (Req 5.22).
   */
  async shutdown(shutdownReason = 'normal'): Promise<ShutdownResult> {
    const start = this.deps.now();
    this._shutdownActive = true;
    this._phase = StageCPhase.STOPPING;

    // Step 1: Send lifecycle.shutdown (Req 5.20)
    const sent = this.deps.sendMessage(ControllerToSidecarType.LIFECYCLE_SHUTDOWN, { reason: shutdownReason });

    let graceful = false;
    let forceKilled = false;

    if (sent && this._sidecarProcess) {
      // Step 2: Wait 2 seconds for shutdownAck or process exit (Req 5.20)
      const ack = await this.deps.waitForMessage('lifecycle.shutdownAck', SHUTDOWN_WAIT_MS);

      if (ack || !this.deps.isProcessAlive(this._sidecarProcess)) {
        graceful = true;
      } else {
        // Step 3: Kill if still alive after 2s (Req 5.21)
        this.deps.killProcess(this._sidecarProcess);
        forceKilled = true;
      }
    } else if (this._sidecarProcess) {
      // Could not send shutdown message — force kill
      this.deps.killProcess(this._sidecarProcess);
      forceKilled = true;
    }

    // Step 4: Invalidate credential (Req 5.22)
    const credentialInvalidated = this.invalidateCredentialSafe();

    // Step 5: Orphan cleanup (Req 5.22)
    const orphansCleaned = this.deps.checkAndCleanOrphans(this._sidecarPid);

    this._phase = StageCPhase.DISABLED;
    this._shutdownActive = false;

    const durationMs = this.deps.now() - start;

    this.deps.emitTelemetry('stage_c_shutdown', {
      graceful,
      forceKilled,
      durationMs,
    });

    return {
      graceful,
      forceKilled,
      credentialInvalidated,
      orphansCleaned,
      durationMs,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Diagnostic Retry (Req 5.23–5.25)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Check if a diagnostic retry is permitted.
   *
   * Req 5.23: Terminate stale sidecar before replacement.
   * Req 5.24: Reject second or later retry.
   * Req 5.25: Expose retry status only through local diagnostics.
   *
   * @returns true if retry is permitted and count incremented; false if rejected.
   */
  canRetry(): boolean {
    if (this._diagnosticRetryCount >= MAX_DIAGNOSTIC_RETRIES) {
      return false;
    }
    return true;
  }

  /**
   * Consume one diagnostic retry.
   * Terminates any stale sidecar before allowing retry (Req 5.23).
   *
   * @returns true if retry was consumed; false if rejected (Req 5.24).
   */
  consumeRetry(): boolean {
    if (!this.canRetry()) return false;
    this._diagnosticRetryCount++;

    // Req 5.23: terminate stale sidecar before replacement
    this.terminateSidecar();
    this.invalidateCredentialSafe();

    // Reset transition owner for the new attempt
    this.transitionOwner.reset();
    this._phase = StageCPhase.DISABLED;

    return true;
  }

  // ──────────────────────────────────────────────────────────────────
  // Event Handlers for Crash/Timeout/Disconnect Races
  // ──────────────────────────────────────────────────────────────────

  /**
   * Handle unexpected process exit (Req 13.4).
   * Must begin fallback within 500ms of notification.
   */
  onProcessExit(): FallbackResult | null {
    if (this._shutdownActive) {
      // During normal shutdown, process exit is expected (Req 13.6)
      return null;
    }
    return this.fallback(StageCFailureReason.PROCESS_EXIT);
  }

  /**
   * Handle unexpected IPC disconnect (Req 13.5).
   * Must begin fallback within 500ms of notification.
   */
  onDisconnect(): FallbackResult | null {
    // Req 13.6: During normal shutdown, disconnect doesn't reopen Layer 0
    if (this._shutdownActive) {
      this.invalidateCredentialSafe();
      return null;
    }
    return this.fallback(StageCFailureReason.IPC_DISCONNECT);
  }

  /**
   * Handle startup timeout expiry (Req 13.2).
   */
  onTimeout(): FallbackResult | null {
    return this.fallback(StageCFailureReason.STARTUP_TIMEOUT);
  }

  /**
   * Handle capture verification failure (Req 12.5–12.9).
   */
  onCaptureFailure(): FallbackResult | null {
    return this.fallback(StageCFailureReason.CAPTURE_PROTECTION_FAILURE);
  }

  // ──────────────────────────────────────────────────────────────────
  // Internal Helpers
  // ──────────────────────────────────────────────────────────────────

  private terminateSidecar(): void {
    if (this._sidecarProcess && this.deps.isProcessAlive(this._sidecarProcess)) {
      try {
        this.deps.killProcess(this._sidecarProcess);
      } catch {
        // best effort
      }
    }
    this._sidecarProcess = null;
    this._sidecarPid = null;
  }

  /**
   * Invalidate the launch credential and overwrite mutable buffers.
   * Best-effort: never blocks fallback (Req 13.17).
   */
  private invalidateCredentialSafe(): boolean {
    if (!this._credential) return false;
    try {
      this.deps.invalidateCredential(this._credential);
      this._credential = null;
      return true;
    } catch {
      // Req 13.17: telemetry failure does not change recovery result
      this._credential = null;
      return false;
    }
  }
}
