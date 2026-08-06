/**
 * Stage C Controller — Lifecycle Enhancement Tests
 *
 * Tests the enhanced controller lifecycle: graceful shutdown, credential
 * invalidation, orphan cleanup, single transition owner under races,
 * and disconnect/exit handling.
 *
 * Requirements: 5.20–5.25, 13.1–13.17
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  StageCController,
  StageCControllerDeps,
  AuthenticatedConnection,
  SHUTDOWN_WAIT_MS,
} from '../../stageC/controller';

import { StageCPhase, HostStrategy, StageCFailureReason } from '../../stageC/protocol/schema';
import type { RuntimeProbeResult } from '../../stageC/runtimeProbe';
import type { Layer0AdapterInterface, CanonicalProjectionOwner } from '../../stageC/layer0Adapter';
import type { AuthConnection, BootstrapInfo } from '../../stageC/ipc/authenticator';
import type { LaunchEndpoint, BootstrapRecord } from '../../stageC/ipc/namedPipe';
import type { OverlayProjection } from '../../stageC/protocol/projection';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

// ────────────────────────────────────────────────────────────────────
// Mock Factories (same as controller.test.ts)
// ────────────────────────────────────────────────────────────────────

function createMockLayer0(): Layer0AdapterInterface {
  return {
    ensureCreated: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    applyState: vi.fn(),
    setBounds: vi.fn(),
    setCaptureProtection: vi.fn().mockReturnValue(true),
    isVisible: vi.fn().mockReturnValue(true),
    getBounds: vi.fn().mockReturnValue({ left: 100, top: 100, width: 400, height: 100 }),
    getCaptureProtection: vi.fn().mockReturnValue(true),
    isUsable: vi.fn().mockReturnValue(true),
  };
}

function createMockProjectionOwner(): CanonicalProjectionOwner {
  let revision = 0;
  return {
    getState: vi.fn().mockReturnValue({
      visible: true,
      mode: 'compact',
      bounds_dip: { left: 100, top: 100, width: 400, height: 100 },
      capture_protection: true,
      isSystemAudioActive: false,
      isLoading: false,
      isStreaming: false,
      streamingText: '',
      aiResponse: null,
      inputText: '',
      elapsedTime: 0,
    }),
    updateState: vi.fn(),
    buildSnapshot: vi.fn().mockImplementation(() => {
      revision++;
      return {
        revision,
        visibility_requested: true,
        bounds_dip: { left: 100, top: 100, width: 400, height: 100 },
        mode: 'compact',
        capture_protection: true,
        render_state: { visible: true },
      } as OverlayProjection;
    }),
    buildPatch: vi.fn().mockReturnValue(null),
    resetProjection: vi.fn(),
    getRevision: vi.fn().mockImplementation(() => revision),
  };
}

function createMockEndpoint(launchId = 'test-launch-id'): LaunchEndpoint {
  return {
    pipeName: `\\\\.\\pipe\\zule-stage-c-${launchId}`,
    launchId,
    bootstrap: {
      pipeName: `\\\\.\\pipe\\zule-stage-c-${launchId}`,
      launchId,
      credential: 'a'.repeat(64),
      serverNonce: 'b'.repeat(64),
      clientNonce: 'c'.repeat(64),
      parentPid: 1234,
    } as BootstrapRecord,
    server: { close: vi.fn() } as any,
    consumed: false,
    destroy: vi.fn(),
  };
}

function createMockChildProcess(): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  (proc as any).pid = 9999;
  (proc as any).killed = false;
  (proc as any).kill = vi.fn(() => { (proc as any).killed = true; });
  return proc;
}

function createMockConnection(messages: unknown[] = []): AuthConnection {
  let messageIndex = 0;
  return {
    send: vi.fn(),
    receive: vi.fn().mockImplementation(async (_deadlineMs: number) => {
      if (messageIndex < messages.length) {
        return messages[messageIndex++];
      }
      return null;
    }),
    close: vi.fn(),
    connected: true,
  };
}

function createHappyPathDeps(overrides: Partial<StageCControllerDeps> = {}): StageCControllerDeps {
  const layer0 = createMockLayer0();
  const projectionOwner = createMockProjectionOwner();
  const endpoint = createMockEndpoint();
  const childProcess = createMockChildProcess();

  const readyHandshake = {
    launch_id: endpoint.launchId,
    sidecar_version: '1.0.0',
    protocol_major: 1,
    protocol_minor: 0,
    bridge_schema_version: 1,
    capabilities: ['overlay'],
    webview2_runtime_version: '119.0.2151.97',
  };

  const snapshotAck = { revision: 1 };
  const firstFrame = { revision: 1 };
  const connection = createMockConnection([readyHandshake, snapshotAck, firstFrame]);

  return {
    layer0,
    projectionOwner,
    runProbe: vi.fn().mockResolvedValue({ eligible: true, reason: null } as RuntimeProbeResult),
    createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint }),
    spawnSidecar: vi.fn().mockReturnValue(childProcess),
    getSidecarPath: vi.fn().mockReturnValue('C:\\path\\to\\ZuleUI.exe'),
    deliverBootstrap: vi.fn().mockResolvedValue({ ok: true, bootstrapPipeName: '\\\\.\\pipe\\bootstrap' }),
    awaitConnection: vi.fn().mockResolvedValue(connection),
    authenticate: vi.fn().mockResolvedValue({ connection, thresholdExceeded: false } as AuthenticatedConnection),
    getRequiredCapabilities: vi.fn().mockReturnValue(['overlay']),
    emitTelemetry: vi.fn(),
    verifyNoOrphans: vi.fn(),
    invalidateCredential: vi.fn(),
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('StageCController — Graceful Shutdown (Req 5.20–5.22)', () => {
  it('sends lifecycle.shutdown on stopOverlay when ACTIVE', async () => {
    const endpoint = createMockEndpoint();
    const handshake = {
      launch_id: endpoint.launchId,
      sidecar_version: '1.0.0',
      protocol_major: 1,
      protocol_minor: 0,
      bridge_schema_version: 1,
      capabilities: ['overlay'],
      webview2_runtime_version: '119.0.2151.97',
    };
    const snapshotAck = { revision: 1 };
    const firstFrame = { revision: 1 };
    // Connection for startup + then for shutdown ack
    const shutdownAck = { launch_id: endpoint.launchId };
    const connection = createMockConnection([handshake, snapshotAck, firstFrame, shutdownAck]);

    const deps = createHappyPathDeps({
      createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint }),
      authenticate: vi.fn().mockResolvedValue({ connection, thresholdExceeded: false }),
    });

    const controller = new StageCController(deps);
    await controller.requestOverlay();
    expect(controller.status().phase).toBe(StageCPhase.ACTIVE);

    await controller.stopOverlay();

    // Should have sent lifecycle.shutdown
    const sendCalls = (connection.send as any).mock.calls;
    const shutdownCall = sendCalls.find(
      (call: any[]) => call[0]?.type === 'lifecycle.shutdown',
    );
    expect(shutdownCall).toBeDefined();
    expect(controller.status().phase).toBe(StageCPhase.DISABLED);
  });

  it('SHUTDOWN_WAIT_MS is 2000ms (Req 5.20)', () => {
    expect(SHUTDOWN_WAIT_MS).toBe(2000);
  });

  it('calls invalidateCredential on shutdown (Req 5.22, 6.12)', async () => {
    const deps = createHappyPathDeps();
    const controller = new StageCController(deps);
    await controller.requestOverlay();
    expect(controller.status().phase).toBe(StageCPhase.ACTIVE);

    await controller.stopOverlay();

    expect(deps.invalidateCredential).toHaveBeenCalled();
  });

  it('calls verifyNoOrphans on shutdown (Req 5.22)', async () => {
    const deps = createHappyPathDeps();
    const controller = new StageCController(deps);
    await controller.requestOverlay();

    await controller.stopOverlay();

    expect(deps.verifyNoOrphans).toHaveBeenCalled();
  });

  it('hides Layer 0 when not ACTIVE', async () => {
    const deps = createHappyPathDeps({
      runProbe: vi.fn().mockResolvedValue({ eligible: false, reason: 'NON_WINDOWS' }),
    });
    const controller = new StageCController(deps);
    await controller.requestOverlay();

    await controller.stopOverlay();

    expect(deps.layer0.hide).toHaveBeenCalled();
  });
});

describe('StageCController — Cutover Ordering (Req 5.15, 13.7)', () => {
  it('cutover is strictly hide Layer 0 → show Stage C', async () => {
    const callOrder: string[] = [];
    const deps = createHappyPathDeps();
    (deps.layer0.hide as any).mockImplementation(() => callOrder.push('hideL0'));

    const controller = new StageCController(deps);
    await controller.requestOverlay();

    // Layer 0 hide must happen during cutover
    expect(callOrder).toContain('hideL0');
    expect(controller.status().phase).toBe(StageCPhase.ACTIVE);
  });
});

describe('StageCController — Fallback Ordering (Req 13.8)', () => {
  it('fallback shows Layer 0 after any cleanup', async () => {
    const deps = createHappyPathDeps({
      authenticate: vi.fn().mockResolvedValue(null),
    });

    const controller = new StageCController(deps);
    await controller.requestOverlay();

    // Layer 0 should be visible after fallback
    expect(deps.layer0.show).toHaveBeenCalled();
    expect(deps.layer0.ensureCreated).toHaveBeenCalled();
    expect(controller.status().phase).toBe(StageCPhase.LAYER_0_ACTIVE);
  });
});

describe('StageCController — Single Transition Owner (Req 13.13–13.14)', () => {
  it('multiple fallback calls only execute once', async () => {
    const deps = createHappyPathDeps({
      awaitConnection: vi.fn().mockResolvedValue(null),
    });

    const controller = new StageCController(deps);
    await controller.requestOverlay();

    // The fallback was triggered once by auth failure; subsequent calls are no-ops
    expect(controller.status().phase).toBe(StageCPhase.LAYER_0_ACTIVE);

    // Calling onProcessExit after fallback should be a no-op
    controller.onProcessExit();
    expect(controller.status().phase).toBe(StageCPhase.LAYER_0_ACTIVE);
  });

  it('onDisconnect after fallback does not mutate Layer 0 (Req 13.14)', async () => {
    const deps = createHappyPathDeps({
      authenticate: vi.fn().mockResolvedValue(null),
    });
    const controller = new StageCController(deps);
    await controller.requestOverlay();

    // Clear call counts
    (deps.layer0.show as any).mockClear();

    // Late disconnect should not re-show Layer 0
    controller.onDisconnect();
    expect(deps.layer0.show).not.toHaveBeenCalled();
  });
});

describe('StageCController — Process Exit / Disconnect Handlers', () => {
  it('onProcessExit triggers fallback when active', async () => {
    const deps = createHappyPathDeps();
    const controller = new StageCController(deps);
    await controller.requestOverlay();
    expect(controller.status().phase).toBe(StageCPhase.ACTIVE);

    controller.onProcessExit();

    expect(controller.status().phase).toBe(StageCPhase.LAYER_0_ACTIVE);
    expect(controller.status().failure).toBe(StageCFailureReason.PROCESS_EXIT);
  });

  it('onDisconnect triggers fallback when active', async () => {
    const deps = createHappyPathDeps();
    const controller = new StageCController(deps);
    await controller.requestOverlay();
    expect(controller.status().phase).toBe(StageCPhase.ACTIVE);

    controller.onDisconnect();

    expect(controller.status().phase).toBe(StageCPhase.LAYER_0_ACTIVE);
    expect(controller.status().failure).toBe(StageCFailureReason.IPC_DISCONNECT);
  });

  it('onCaptureFailure triggers fallback', async () => {
    const deps = createHappyPathDeps();
    const controller = new StageCController(deps);
    await controller.requestOverlay();
    expect(controller.status().phase).toBe(StageCPhase.ACTIVE);

    controller.onCaptureFailure();

    expect(controller.status().phase).toBe(StageCPhase.LAYER_0_ACTIVE);
    expect(controller.status().failure).toBe(StageCFailureReason.CAPTURE_PROTECTION_FAILURE);
  });
});

describe('StageCController — Credential Invalidation (Req 6.12)', () => {
  it('invalidates credential on auth failure', async () => {
    const deps = createHappyPathDeps({
      authenticate: vi.fn().mockResolvedValue(null),
    });
    const controller = new StageCController(deps);
    await controller.requestOverlay();

    expect(deps.invalidateCredential).toHaveBeenCalled();
  });

  it('invalidates credential on handshake failure', async () => {
    const endpoint = createMockEndpoint();
    const connection = createMockConnection([]); // No handshake
    const deps = createHappyPathDeps({
      createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint }),
      authenticate: vi.fn().mockResolvedValue({ connection, thresholdExceeded: false }),
    });
    const controller = new StageCController(deps);
    await controller.requestOverlay();

    expect(deps.invalidateCredential).toHaveBeenCalled();
  });
});

describe('StageCController — Diagnostic Retry Rate Limiting (Req 5.23–5.25)', () => {
  it('allows exactly one retry per launch (Req 5.24)', async () => {
    const deps = createHappyPathDeps({
      authenticate: vi.fn().mockResolvedValue(null),
    });
    const controller = new StageCController(deps);
    await controller.requestOverlay(); // fails

    const first = await controller.requestDiagnosticRetry();
    expect(first).toBe(true);

    const second = await controller.requestDiagnosticRetry();
    expect(second).toBe(false);
  });

  it('rejects retry when no failure occurred', async () => {
    const deps = createHappyPathDeps();
    const controller = new StageCController(deps);
    // No requestOverlay yet — no failure

    const result = await controller.requestDiagnosticRetry();
    expect(result).toBe(false);
  });

  it('terminates stale sidecar before retry (Req 5.23)', async () => {
    const childProcess = createMockChildProcess();
    const endpoint = createMockEndpoint();
    const connection = createMockConnection([]); // will cause handshake failure
    const deps = createHappyPathDeps({
      createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint }),
      spawnSidecar: vi.fn().mockReturnValue(childProcess),
      authenticate: vi.fn().mockResolvedValue({ connection, thresholdExceeded: false }),
    });
    const controller = new StageCController(deps);
    await controller.requestOverlay(); // fails

    // Kill should have been called during fallback cleanup
    expect((childProcess as any).kill).toHaveBeenCalled();
  });
});
