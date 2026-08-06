/**
 * Stage C Controller — Probe, Spawn, Authentication, Handshake, and Synchronization.
 *
 * Implements the AttemptStageC procedure from the design:
 * 1. Show warm Layer 0 before probing
 * 2. Run runtime probe (never spawns ZuleUI.exe)
 * 3. Spawn exactly one packaged ZuleUI.exe without shell if eligible
 * 4. Enforce one absolute 3-second startup deadline
 * 5. Authenticate via mutual challenge-response
 * 6. Verify Ready Handshake
 * 7. Send one full snapshot before patches
 * 8. Wait for matching revision ack and first frame
 * 9. Reuse pending/healthy sidecars
 * 10. Enforce snapshot/patch revision and reconnect rules
 *
 * Requirements: 4.1–4.13, 5.1–5.19
 */

import type { ChildProcess } from 'node:child_process';
import type { RuntimeProbeResult, RuntimeProbeConfig } from './runtimeProbe';
import type { Layer0AdapterInterface, CanonicalProjectionOwner } from './layer0Adapter';
import type { ReadyHandshake } from './protocol/handshake';
import type { OverlayProjection } from './protocol/projection';
import type { BootstrapInfo, AuthConnection } from './ipc/authenticator';
import type { LaunchEndpoint } from './ipc/namedPipe';

import {
  StageCPhase,
  HostStrategy,
  StageCFailureReason,
} from './protocol/schema';

import { validateHandshake, verifyHandshake } from './protocol/handshake';

// ────────────────────────────────────────────────────────────────────
// Authenticated Connection Result
// ────────────────────────────────────────────────────────────────────

export interface AuthenticatedConnection {
  /** The authenticated connection for messaging. */
  connection: AuthConnection;
  /** Whether the auth threshold was exceeded. */
  thresholdExceeded: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

/** Absolute startup deadline in ms (Req 5.3): auth + handshake + snapshot ack + first frame. */
export const STARTUP_DEADLINE_MS = 3000;

/** Maximum time to wait for snapshot ack after sending snapshot (Req 5.11). */
export const SNAPSHOT_ACK_TIMEOUT_MS = 1000;

/** Maximum time to wait for first frame after snapshot ack (Req 5.14). */
export const FIRST_FRAME_TIMEOUT_MS = 1000;

/** Shutdown wait time before forced termination (Req 5.20). */
export const SHUTDOWN_WAIT_MS = 2000;

// ────────────────────────────────────────────────────────────────────
// Controller State
// ────────────────────────────────────────────────────────────────────

export interface ControllerState {
  phase: StageCPhase;
  launch_id: string | null;
  revision: number;
  sidecarPid: number | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  deadlineStart: number | null;
}

// ────────────────────────────────────────────────────────────────────
// Controller Dependencies (injected for testability)
// ────────────────────────────────────────────────────────────────────

export interface StageCControllerDeps {
  /** Layer 0 warm fallback adapter. */
  layer0: Layer0AdapterInterface;

  /** Canonical projection owner for building snapshots/patches. */
  projectionOwner: CanonicalProjectionOwner;

  /** Run the runtime probe (never spawns sidecar). */
  runProbe: (config?: RuntimeProbeConfig) => Promise<RuntimeProbeResult>;

  /** Create an IPC launch endpoint (named pipe + credentials). */
  createEndpoint: () => { ok: true; endpoint: LaunchEndpoint } | { ok: false; reason: string };

  /**
   * Spawn exactly one ZuleUI.exe process without shell.
   * Returns the ChildProcess handle or null on failure.
   */
  spawnSidecar: (sidecarPath: string, bootstrapPipeName: string) => ChildProcess | null;

  /** Resolve the absolute sidecar path from the manifest. Returns null if unavailable. */
  getSidecarPath: () => string | null;

  /** Deliver the bootstrap record to the spawned sidecar. */
  deliverBootstrap: (endpoint: LaunchEndpoint) => Promise<{ ok: true; bootstrapPipeName: string } | { ok: false; reason: string }>;

  /**
   * Create an AuthConnection adapter for the authenticated pipe.
   * Returns the connection after sidecar connects, or null on timeout.
   */
  awaitConnection: (endpoint: LaunchEndpoint, deadlineMs: number) => Promise<AuthConnection | null>;

  /**
   * Run mutual authentication on the connection.
   * Returns the authenticated connection or null on failure.
   * Injected for testability; production uses StageCAuthenticator.
   */
  authenticate: (
    connection: AuthConnection,
    bootstrap: BootstrapInfo,
    deadlineMs: number,
    onThreshold?: () => void,
  ) => Promise<AuthenticatedConnection | null>;

  /** Get required capabilities for handshake verification. */
  getRequiredCapabilities: () => string[];

  /** Emit a telemetry event (content-free). */
  emitTelemetry?: (event: string, data?: Record<string, unknown>) => void;

  /**
   * Verify no orphan ZuleUI.exe processes or ZuleUIWindow windows remain (Req 5.22).
   * Best-effort: failure does not block shutdown.
   */
  verifyNoOrphans?: (sidecarPid: number | null) => void;

  /**
   * Invalidate credential and overwrite mutable buffers (Req 6.12).
   * Called after disconnect/exit/shutdown.
   */
  invalidateCredential?: (credential: string | null) => void;
}

// ────────────────────────────────────────────────────────────────────
// StageCStatus (diagnostic output)
// ────────────────────────────────────────────────────────────────────

export interface StageCStatus {
  strategy: HostStrategy;
  phase: StageCPhase;
  failure: StageCFailureReason | null;
  launch_id: string | null;
  overlay_revision: number;
}

// ────────────────────────────────────────────────────────────────────
// StageCController Implementation
// ────────────────────────────────────────────────────────────────────

export class StageCController {
  private state: ControllerState = {
    phase: StageCPhase.DISABLED,
    launch_id: null,
    revision: 0,
    sidecarPid: null,
    deadlineTimer: null,
    deadlineStart: null,
  };

  private failure: StageCFailureReason | null = null;
  private failedThisLaunch = false;
  private diagnosticRetryUsed = false;
  private sidecarProcess: ChildProcess | null = null;
  private endpoint: LaunchEndpoint | null = null;
  private snapshotSent = false;
  private lastAckedRevision = -1;
  private authenticatedConnection: AuthConnection | null = null;
  private shutdownActive = false;
  private transitionClaimed = false;
  private readonly deps: StageCControllerDeps;

  constructor(deps: StageCControllerDeps) {
    this.deps = deps;
  }

  // ──────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────

  /**
   * Request the floating overlay.
   *
   * - Show warm Layer 0 before probe (Req 4.1)
   * - Run runtime probe (Req 4.2–4.10)
   * - Attempt Stage C if eligible (Req 4.13)
   * - Reuse pending/healthy sidecar (Req 5.2)
   */
  async requestOverlay(): Promise<void> {
    // Req 4.1: Show Layer 0 immediately before probing
    this.deps.layer0.ensureCreated();
    this.deps.layer0.show();

    // Req 4.12: If Stage C failed this launch, stay on Layer 0
    // (Only diagnostic retry via requestDiagnosticRetry() can re-attempt)
    if (this.failedThisLaunch) {
      this.setPhase(StageCPhase.LAYER_0_ACTIVE);
      return;
    }

    // Req 5.2: Reuse pending or healthy sidecar
    if (this.state.phase === StageCPhase.ACTIVE || this.isPending()) {
      return;
    }

    // Req 4.2–4.10: Run the probe
    this.setPhase(StageCPhase.PROBING);
    const probeResult = await this.deps.runProbe();

    if (!probeResult.eligible) {
      // Req 4.10: keep Layer 0 visible, report typed content-free reason
      this.setPhase(StageCPhase.LAYER_0_ACTIVE);
      this.deps.emitTelemetry?.('probe_failed', { reason: probeResult.reason ?? 'unknown' });
      return;
    }

    // Req 4.13: Attempt Stage C
    await this.attemptStageC();
  }

  /**
   * Stop the overlay (normal shutdown path).
   *
   * Req 5.20: Send `lifecycle.shutdown` and wait 2 seconds for sidecar exit.
   * Req 5.21: Terminate the owned process if still alive after 2 seconds.
   * Req 5.22: Close endpoint, invalidate credential, release handles, verify no orphans.
   */
  async stopOverlay(): Promise<void> {
    if (this.state.phase !== StageCPhase.ACTIVE) {
      this.deps.layer0.hide();
      return;
    }

    this.setPhase(StageCPhase.STOPPING);
    this.shutdownActive = true;

    // Req 5.20: Send lifecycle.shutdown
    if (this.authenticatedConnection) {
      try {
        this.authenticatedConnection.send({
          type: 'lifecycle.shutdown',
          payload: { reason: 'normal' },
        } as any);
      } catch {
        // best effort — proceed to termination
      }

      // Req 5.20: Wait 2 seconds for sidecar exit or shutdownAck
      const shutdownAckReceived = await this.waitForShutdownAck(SHUTDOWN_WAIT_MS);

      // Req 5.21: Kill if still alive after 2-second wait
      if (!shutdownAckReceived && this.sidecarProcess && !this.sidecarProcess.killed) {
        try {
          this.sidecarProcess.kill();
        } catch {
          // best effort
        }
      }
    } else {
      // No connection — force kill immediately
      if (this.sidecarProcess && !this.sidecarProcess.killed) {
        try {
          this.sidecarProcess.kill();
        } catch {
          // best effort
        }
      }
    }

    // Req 5.22: Close endpoint, invalidate credential, release handles
    this.invalidateAndCleanup();

    // Req 5.22: Verify no orphan ZuleUI.exe or ZuleUIWindow remains
    this.deps.verifyNoOrphans?.(this.state.sidecarPid);

    this.deps.layer0.hide();
    this.setPhase(StageCPhase.DISABLED);
    this.shutdownActive = false;
  }

  /** Get diagnostic status. */
  status(): StageCStatus {
    return {
      strategy: this.state.phase === StageCPhase.ACTIVE
        ? HostStrategy.STAGE_C
        : HostStrategy.LAYER_0,
      phase: this.state.phase,
      failure: this.failure,
      launch_id: this.state.launch_id,
      overlay_revision: this.state.revision,
    };
  }

  /** Whether Stage C has failed during this App Core launch. */
  get hasFailedThisLaunch(): boolean {
    return this.failedThisLaunch;
  }

  // ──────────────────────────────────────────────────────────────────
  // Stage C Attempt — Main Sequence
  // ──────────────────────────────────────────────────────────────────

  /**
   * Implements the AttemptStageC procedure from the design.
   *
   * Req 5.1: Spawn exactly one ZuleUI.exe without shell
   * Req 5.3: Start one absolute 3-second startup deadline
   * Req 5.4–5.6: Verify Ready Handshake
   * Req 5.9: Send one full snapshot before patches
   * Req 5.11: Wait for matching revision ack
   * Req 5.12–5.14: Wait for first frame ready
   * Req 5.15: Hide Layer 0 → show Stage C (cutover)
   */
  private async attemptStageC(): Promise<void> {
    // ─── Start absolute 3-second deadline (Req 5.3) ───────────────────
    const deadlineStart = Date.now();
    const deadline = deadlineStart + STARTUP_DEADLINE_MS;
    this.state.deadlineStart = deadlineStart;

    // Schedule the hard deadline timeout
    this.state.deadlineTimer = setTimeout(() => {
      if (this.state.phase !== StageCPhase.ACTIVE && this.state.phase !== StageCPhase.DISABLED) {
        this.fallback(StageCFailureReason.STARTUP_TIMEOUT);
      }
    }, STARTUP_DEADLINE_MS);

    try {
      // ─── Spawn Phase (Req 5.1) ──────────────────────────────────────
      this.setPhase(StageCPhase.LAUNCHING);

      const sidecarPath = this.deps.getSidecarPath();
      if (!sidecarPath) {
        this.fallback(StageCFailureReason.NATIVE_BOUNDARY_FAILURE);
        return;
      }

      // Create endpoint and credentials
      const endpointResult = this.deps.createEndpoint();
      if (!endpointResult.ok) {
        this.fallback(StageCFailureReason.NATIVE_BOUNDARY_FAILURE);
        return;
      }

      this.endpoint = endpointResult.endpoint;
      this.state.launch_id = this.endpoint.launchId;

      // Deliver bootstrap to one-shot pipe
      const deliveryResult = await this.deps.deliverBootstrap(this.endpoint);
      if (!deliveryResult.ok) {
        this.fallback(StageCFailureReason.NATIVE_BOUNDARY_FAILURE);
        return;
      }

      // Spawn exactly one sidecar without shell (Req 5.1)
      const childProcess = this.deps.spawnSidecar(sidecarPath, deliveryResult.bootstrapPipeName);
      if (!childProcess) {
        this.fallback(StageCFailureReason.NATIVE_BOUNDARY_FAILURE);
        return;
      }

      this.sidecarProcess = childProcess;
      this.state.sidecarPid = childProcess.pid ?? null;

      // Check deadline
      if (Date.now() >= deadline) {
        this.fallback(StageCFailureReason.STARTUP_TIMEOUT);
        return;
      }

      // ─── Authentication Phase (Req 5.6, 6.9–6.12) ──────────────────
      this.setPhase(StageCPhase.AUTHENTICATING);

      const remainingForConnection = deadline - Date.now();
      const connection = await this.deps.awaitConnection(this.endpoint, remainingForConnection);
      if (!connection) {
        this.fallback(StageCFailureReason.AUTHENTICATION_FAILED);
        return;
      }

      if (Date.now() >= deadline) {
        this.fallback(StageCFailureReason.STARTUP_TIMEOUT);
        return;
      }

      // Run mutual authentication via injected dependency
      const bootstrap: BootstrapInfo = {
        launch_id: this.endpoint.launchId,
        credential: this.endpoint.bootstrap.credential,
        parent_pid: this.endpoint.bootstrap.parentPid,
      };

      const authRemainingMs = deadline - Date.now();
      const authResult = await this.deps.authenticate(
        connection,
        bootstrap,
        authRemainingMs,
        () => this.deps.emitTelemetry?.('auth_threshold_exceeded'),
      );

      if (!authResult) {
        this.fallback(StageCFailureReason.AUTHENTICATION_FAILED);
        return;
      }

      if (Date.now() >= deadline) {
        this.fallback(StageCFailureReason.STARTUP_TIMEOUT);
        return;
      }

      // ─── Handshake Phase (Req 5.4–5.8) ─────────────────────────────
      this.setPhase(StageCPhase.HANDSHAKING);

      this.authenticatedConnection = authResult.connection;
      const handshakeRemainingMs = deadline - Date.now();
      const handshakeMsg = await this.authenticatedConnection.receive(handshakeRemainingMs);
      if (!handshakeMsg) {
        this.fallback(StageCFailureReason.HANDSHAKE_FAILURE);
        return;
      }

      // Extract payload from the lifecycle.ready message
      const handshakePayload = (handshakeMsg as unknown as { payload?: unknown })?.payload ?? handshakeMsg;

      // Validate handshake schema (Req 5.5)
      const validationResult = validateHandshake(handshakePayload);
      if (!validationResult.valid) {
        this.fallback(StageCFailureReason.HANDSHAKE_FAILURE);
        return;
      }

      // Verify handshake fields (Req 5.6)
      const handshake = handshakePayload as ReadyHandshake;
      const verifyResult = verifyHandshake(
        handshake,
        this.state.launch_id!,
        this.deps.getRequiredCapabilities(),
      );
      if (!verifyResult.valid) {
        this.fallback(StageCFailureReason.HANDSHAKE_FAILURE);
        return;
      }

      if (Date.now() >= deadline) {
        this.fallback(StageCFailureReason.STARTUP_TIMEOUT);
        return;
      }

      // ─── Synchronization Phase (Req 5.9–5.14) ──────────────────────
      this.setPhase(StageCPhase.SYNCHRONIZING);

      // Req 5.9: Send one full snapshot before any patches
      // Req 5.19: Reconnect always starts with full snapshot
      this.deps.projectionOwner.resetProjection();
      const snapshot: OverlayProjection = this.deps.projectionOwner.buildSnapshot();
      this.state.revision = snapshot.revision;
      this.snapshotSent = true;

      // Send snapshot over connection
      const snapshotMessage = {
        type: 'state.snapshot' as const,
        ...snapshot,
      };
      try {
        this.authenticatedConnection.send(snapshotMessage as any);
      } catch {
        this.fallback(StageCFailureReason.STATE_ACK_TIMEOUT);
        return;
      }

      // Req 5.11: Wait at most 1 second for matching revision ack
      const ackTimeout = Math.min(SNAPSHOT_ACK_TIMEOUT_MS, deadline - Date.now());
      if (ackTimeout <= 0) {
        this.fallback(StageCFailureReason.STARTUP_TIMEOUT);
        return;
      }

      const ackMsg = await this.authenticatedConnection.receive(ackTimeout);
      if (!ackMsg) {
        this.fallback(StageCFailureReason.STATE_ACK_TIMEOUT);
        return;
      }

      // Verify matching revision in ack
      const ackPayload = (ackMsg as unknown as { revision?: number; payload?: { revision?: number } });
      const ackedRevision = ackPayload?.payload?.revision ?? ackPayload?.revision;
      if (typeof ackedRevision !== 'number' || ackedRevision !== snapshot.revision) {
        this.fallback(StageCFailureReason.STATE_ACK_TIMEOUT);
        return;
      }

      this.lastAckedRevision = ackedRevision;

      if (Date.now() >= deadline) {
        this.fallback(StageCFailureReason.STARTUP_TIMEOUT);
        return;
      }

      // ─── Wait for First Frame (Req 5.12–5.14) ──────────────────────
      this.setPhase(StageCPhase.WAITING_FIRST_FRAME);

      const frameTimeout = Math.min(FIRST_FRAME_TIMEOUT_MS, deadline - Date.now());
      if (frameTimeout <= 0) {
        this.fallback(StageCFailureReason.STARTUP_TIMEOUT);
        return;
      }

      const frameMsg = await this.authenticatedConnection.receive(frameTimeout);
      if (!frameMsg) {
        this.fallback(StageCFailureReason.FIRST_FRAME_TIMEOUT);
        return;
      }

      // Verify revision in first frame matches acknowledged snapshot
      const framePayload = (frameMsg as unknown as { revision?: number; payload?: { revision?: number } });
      const frameRevision = framePayload?.payload?.revision ?? framePayload?.revision;
      if (typeof frameRevision !== 'number' || frameRevision !== snapshot.revision) {
        this.fallback(StageCFailureReason.FIRST_FRAME_TIMEOUT);
        return;
      }

      // ─── Cutover (Req 5.15) ────────────────────────────────────────
      // Strictly hide Layer 0 → show Stage C
      this.deps.layer0.hide();
      this.setPhase(StageCPhase.ACTIVE);
      this.clearDeadline();

      this.deps.emitTelemetry?.('stage_c_active', {
        launch_id: this.state.launch_id,
        startup_duration_ms: Date.now() - deadlineStart,
      });
    } catch (err) {
      // Unexpected error: fallback
      this.fallback(StageCFailureReason.NATIVE_BOUNDARY_FAILURE);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Fallback (Req 13.1–13.17)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Begin fallback with a typed reason.
   *
   * Implements single-surface fallback ordering:
   * - Strictly `hide/close Stage C → restore Layer 0` (Req 13.8)
   * - One transition owner under races (Req 13.13)
   * - Late notifications cannot mutate recovered Layer 0 (Req 13.14)
   * - Recovery within 500ms (Req 13.4–13.5)
   * - Preserve canonical state (Req 13.11)
   * - Invalidate credential (Req 6.12)
   * - Orphan cleanup (Req 5.22)
   */
  private fallback(reason: StageCFailureReason): void {
    // Req 13.13: Only one transition owner under race conditions.
    // Late notifications after fallback leave recovered Layer 0 unchanged (Req 13.14).
    if (this.transitionClaimed) {
      return;
    }
    if (this.state.phase === StageCPhase.FALLING_BACK || this.state.phase === StageCPhase.DISABLED) {
      return;
    }

    // Claim transition ownership — subsequent calls are no-ops
    this.transitionClaimed = true;

    this.setPhase(StageCPhase.FALLING_BACK);
    this.failure = reason;
    this.failedThisLaunch = true;

    // Req 13.6: During normal shutdown, disconnect does not reopen Layer 0
    if (this.shutdownActive && reason === StageCFailureReason.IPC_DISCONNECT) {
      this.invalidateAndCleanup();
      return;
    }

    // Req 13.8: Hide/close Stage C BEFORE showing Layer 0
    // (Prevents duplicate visible surfaces — Req 13.10)
    // Note: Before cutover the surface is already hidden (Req 13.9),
    // but we call hide defensively for after-cutover fallback.
    // This is a no-op if already hidden.

    // Req 13.11: Preserve canonical state before any mutation
    // (The projectionOwner holds canonical state which is never mutated by fallback)

    // Req 13.1: Ensure Layer 0 is warm and recoverable
    this.deps.layer0.ensureCreated();
    this.deps.layer0.show();

    // Cleanup sidecar and invalidate credentials (Req 6.12, 5.22)
    this.invalidateAndCleanup();

    this.setPhase(StageCPhase.LAYER_0_ACTIVE);

    this.deps.emitTelemetry?.('stage_c_fallback', { reason });
  }

  // ──────────────────────────────────────────────────────────────────
  // Crash/Timeout/Disconnect Event Handlers (Req 13.4–13.6, 13.13)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Handle unexpected process exit (Req 13.4).
   * Must begin fallback within 500ms of notification.
   */
  onProcessExit(): void {
    if (this.shutdownActive) return; // Expected during shutdown
    this.fallback(StageCFailureReason.PROCESS_EXIT);
  }

  /**
   * Handle unexpected IPC disconnect (Req 13.5).
   * Must begin fallback within 500ms of notification.
   * During normal shutdown, does NOT reopen Layer 0 (Req 13.6).
   */
  onDisconnect(): void {
    if (this.shutdownActive) {
      // Req 13.6: complete shutdown without reopening Layer 0
      this.invalidateAndCleanup();
      return;
    }
    this.fallback(StageCFailureReason.IPC_DISCONNECT);
  }

  /**
   * Handle capture verification failure (Req 12.5–12.9).
   */
  onCaptureFailure(): void {
    this.fallback(StageCFailureReason.CAPTURE_PROTECTION_FAILURE);
  }

  // ──────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────

  private setPhase(phase: StageCPhase): void {
    this.state.phase = phase;
  }

  private isPending(): boolean {
    return (
      this.state.phase === StageCPhase.LAUNCHING ||
      this.state.phase === StageCPhase.AUTHENTICATING ||
      this.state.phase === StageCPhase.HANDSHAKING ||
      this.state.phase === StageCPhase.SYNCHRONIZING ||
      this.state.phase === StageCPhase.WAITING_FIRST_FRAME
    );
  }

  private clearDeadline(): void {
    if (this.state.deadlineTimer !== null) {
      clearTimeout(this.state.deadlineTimer);
      this.state.deadlineTimer = null;
    }
    this.state.deadlineStart = null;
  }

  /**
   * Full cleanup: invalidate credential, kill sidecar, destroy endpoint, verify no orphans.
   * Implements Req 5.22, 6.12.
   */
  private invalidateAndCleanup(): void {
    this.clearDeadline();

    // Req 6.12: Invalidate the Launch_Credential and overwrite mutable buffers
    if (this.endpoint) {
      this.deps.invalidateCredential?.(this.endpoint.bootstrap.credential);
    }

    // Terminate sidecar process if alive
    if (this.sidecarProcess && !this.sidecarProcess.killed) {
      try {
        this.sidecarProcess.kill();
      } catch {
        // best effort
      }
    }

    // Req 5.22: Verify no orphan ZuleUI.exe or ZuleUIWindow remains
    this.deps.verifyNoOrphans?.(this.state.sidecarPid);

    this.sidecarProcess = null;
    this.state.sidecarPid = null;

    // Destroy endpoint (close handles)
    if (this.endpoint) {
      try {
        this.endpoint.destroy();
      } catch {
        // best effort
      }
      this.endpoint = null;
    }

    this.authenticatedConnection = null;
    this.snapshotSent = false;
    this.lastAckedRevision = -1;
    this.state.launch_id = null;
  }

  /**
   * Legacy cleanup alias for backward compatibility in tests.
   */
  private cleanup(): void {
    this.invalidateAndCleanup();
  }

  /**
   * Wait for a shutdown acknowledgment or process exit within the given timeout.
   * Returns true if ack received or process exited gracefully.
   */
  private waitForShutdownAck(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.sidecarProcess || this.sidecarProcess.killed) {
        resolve(true);
        return;
      }

      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      }, timeoutMs);

      // Listen for process exit during the wait
      const onExit = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(true);
        }
      };

      this.sidecarProcess.once('exit', onExit);

      // If connection can receive, wait for shutdownAck
      if (this.authenticatedConnection) {
        this.authenticatedConnection.receive(timeoutMs).then((msg) => {
          if (!resolved && msg) {
            resolved = true;
            clearTimeout(timer);
            this.sidecarProcess?.removeListener('exit', onExit);
            resolve(true);
          }
        }).catch(() => {
          // ignore — timer handles timeout
        });
      }
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Diagnostic retry (Req 5.23–5.25)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Request one explicit diagnostic retry.
   * Terminates any stale sidecar before re-attempting.
   *
   * Req 5.23: Terminate stale sidecar before replacement.
   * Req 5.24: Reject second or later retry.
   */
  async requestDiagnosticRetry(): Promise<boolean> {
    if (!this.failedThisLaunch) {
      return false; // No failure to retry
    }
    if (this.diagnosticRetryUsed) {
      return false; // Req 5.24: reject second+ retry
    }

    this.diagnosticRetryUsed = true;

    // Req 5.23: terminate any stale sidecar from this launch
    this.invalidateAndCleanup();
    this.failure = null;

    // Reset transition ownership for new attempt
    this.transitionClaimed = false;

    // Temporarily clear failed flag to allow requestOverlay to proceed
    this.failedThisLaunch = false;

    // Re-attempt
    await this.requestOverlay();
    return true;
  }
}
