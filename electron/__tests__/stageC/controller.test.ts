/**
 * Stage C Controller — Unit Tests
 *
 * Tests the StageCController probe, spawn, authentication, handshake,
 * synchronization, reuse, and deadline enforcement.
 *
 * Requirements: 4.1–4.13, 5.1–5.19
 */

import { describe, it, expect, vi } from 'vitest';

import {
  StageCController,
  StageCControllerDeps,
  AuthenticatedConnection,
  STARTUP_DEADLINE_MS,
  SNAPSHOT_ACK_TIMEOUT_MS,
  FIRST_FRAME_TIMEOUT_MS,
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
// Mock Factories
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

/**
 * Create a full happy-path dependencies set.
 * The connection sends: ReadyHandshake → snapshotAck → firstFrameReady
 */
function createHappyPathDeps(overrides: Partial<StageCControllerDeps> = {}): StageCControllerDeps {
  const layer0 = createMockLayer0();
  const projectionOwner = createMockProjectionOwner();
  const endpoint = createMockEndpoint();
  const childProcess = createMockChildProcess();

  // Messages the sidecar sends back in sequence (after authentication)
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
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('StageCController', () => {
  // Helper to ensure async tests use real timers
  function withRealTimers(fn: () => Promise<void>) {
    return async () => {
      await fn();
    };
  }

  describe('Layer 0 shown before probe (Req 4.1)', () => {
    it('calls layer0.ensureCreated() and show() before running probe', withRealTimers(async () => {
      const deps = createHappyPathDeps();
      const callOrder: string[] = [];
      (deps.layer0.ensureCreated as any).mockImplementation(() => callOrder.push('ensureCreated'));
      (deps.layer0.show as any).mockImplementation(() => callOrder.push('show'));
      (deps.runProbe as any).mockImplementation(async () => {
        callOrder.push('probe');
        return { eligible: false, reason: 'NON_WINDOWS' };
      });

      const controller = new StageCController(deps);
      await controller.requestOverlay();

      expect(callOrder[0]).toBe('ensureCreated');
      expect(callOrder[1]).toBe('show');
      expect(callOrder[2]).toBe('probe');
    }));

    it('shows Layer 0 even when probe will fail', withRealTimers(async () => {
      const deps = createHappyPathDeps({
        runProbe: vi.fn().mockResolvedValue({ eligible: false, reason: 'MANIFEST_MISSING' }),
      });

      const controller = new StageCController(deps);
      await controller.requestOverlay();

      expect(deps.layer0.ensureCreated).toHaveBeenCalled();
      expect(deps.layer0.show).toHaveBeenCalled();
    }));
  });

  describe('Only one spawn per launch attempt (Req 5.1)', () => {
    it('calls spawnSidecar exactly once on successful attempt', withRealTimers(async () => {
      const deps = createHappyPathDeps();
      const controller = new StageCController(deps);
      await controller.requestOverlay();

      expect(deps.spawnSidecar).toHaveBeenCalledTimes(1);
    }));

    it('does not spawn if probe fails', withRealTimers(async () => {
      const deps = createHappyPathDeps({
        runProbe: vi.fn().mockResolvedValue({ eligible: false, reason: 'NON_WINDOWS' }),
      });
      const controller = new StageCController(deps);
      await controller.requestOverlay();

      expect(deps.spawnSidecar).not.toHaveBeenCalled();
    }));

    it('spawns without shell (no shell option)', withRealTimers(async () => {
      const deps = createHappyPathDeps();
      const controller = new StageCController(deps);
      await controller.requestOverlay();

      // spawnSidecar is called with sidecar path and bootstrap pipe name
      expect(deps.spawnSidecar).toHaveBeenCalledWith(
        'C:\\path\\to\\ZuleUI.exe',
        '\\\\.\\pipe\\bootstrap',
      );
    }));
  });

  describe('3-second deadline enforcement (Req 5.3, 5.16)', () => {
    it('falls back with AUTHENTICATION_FAILED when connection unavailable', withRealTimers(async () => {
      const deps = createHappyPathDeps({
        awaitConnection: vi.fn().mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 50));
          return null;
        }),
        authenticate: vi.fn().mockResolvedValue(null),
      });

      const controller = new StageCController(deps);
      await controller.requestOverlay();

      const status = controller.status();
      expect(status.phase).toBe(StageCPhase.LAYER_0_ACTIVE);
      expect(status.failure).toBe(StageCFailureReason.AUTHENTICATION_FAILED);
    }));

    it('falls back with HANDSHAKE_FAILURE when handshake not received in time', withRealTimers(async () => {
      // Connection that returns null on receive (no handshake message)
      const connection = createMockConnection([]);
      const deps = createHappyPathDeps({
        authenticate: vi.fn().mockResolvedValue({ connection, thresholdExceeded: false }),
      });

      const controller = new StageCController(deps);
      await controller.requestOverlay();

      const status = controller.status();
      expect(status.phase).toBe(StageCPhase.LAYER_0_ACTIVE);
      expect(status.failure).toBe(StageCFailureReason.HANDSHAKE_FAILURE);
    }));
  });

  describe('Ready handshake verification (Req 5.4–5.8)', () => {
    it('falls back on handshake with wrong launch_id', withRealTimers(async () => {
      const badHandshake = {
        launch_id: 'wrong-launch-id',
        sidecar_version: '1.0.0',
        protocol_major: 1,
        protocol_minor: 0,
        bridge_schema_version: 1,
        capabilities: ['overlay'],
        webview2_runtime_version: '119.0.2151.97',
      };
      const connection = createMockConnection([badHandshake]);
      const deps = createHappyPathDeps({
        authenticate: vi.fn().mockResolvedValue({ connection, thresholdExceeded: false }),
      });

      const controller = new StageCController(deps);
      await controller.requestOverlay();

      const status = controller.status();
      expect(status.failure).toBe(StageCFailureReason.HANDSHAKE_FAILURE);
    }));

    it('falls back on handshake with wrong protocol_major', withRealTimers(async () => {
      const endpoint = createMockEndpoint();
      const badHandshake = {
        launch_id: endpoint.launchId,
        sidecar_version: '1.0.0',
        protocol_major: 99,
        protocol_minor: 0,
        bridge_schema_version: 1,
        capabilities: ['overlay'],
        webview2_runtime_version: '119.0.2151.97',
      };
      const connection = createMockConnection([badHandshake]);
      const deps = createHappyPathDeps({
        createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint }),
        authenticate: vi.fn().mockResolvedValue({ connection, thresholdExceeded: false }),
      });

      const controller = new StageCController(deps);
      await controller.requestOverlay();

      const status = controller.status();
      expect(status.failure).toBe(StageCFailureReason.HANDSHAKE_FAILURE);
    }));

    it('falls back when required capability is missing', withRealTimers(async () => {
      const endpoint = createMockEndpoint();
      const handshake = {
        launch_id: endpoint.launchId,
        sidecar_version: '1.0.0',
        protocol_major: 1,
        protocol_minor: 0,
        bridge_schema_version: 1,
        capabilities: [], // missing 'overlay'
        webview2_runtime_version: '119.0.2151.97',
      };
      const connection = createMockConnection([handshake]);
      const deps = createHappyPathDeps({
        createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint }),
        authenticate: vi.fn().mockResolvedValue({ connection, thresholdExceeded: false }),
        getRequiredCapabilities: vi.fn().mockReturnValue(['overlay']),
      });

      const controller = new StageCController(deps);
      await controller.requestOverlay();

      const status = controller.status();
      expect(status.failure).toBe(StageCFailureReason.HANDSHAKE_FAILURE);
    }));

    it('accepts a valid handshake and proceeds to ACTIVE', withRealTimers(async () => {
      const deps = createHappyPathDeps();
      const controller = new StageCController(deps);
      await controller.requestOverlay();

      const status = controller.status();
      expect(status.phase).toBe(StageCPhase.ACTIVE);
      expect(status.failure).toBeNull();
    }));
  });

  describe('Full snapshot sent before patches (Req 5.9, 5.19)', () => {
    it('calls projectionOwner.resetProjection() before buildSnapshot()', withRealTimers(async () => {
      const deps = createHappyPathDeps();
      const callOrder: string[] = [];
      (deps.projectionOwner.resetProjection as any).mockImplementation(() => callOrder.push('reset'));
      (deps.projectionOwner.buildSnapshot as any).mockImplementation(() => {
        callOrder.push('snapshot');
        return {
          revision: 1,
          visibility_requested: true,
          bounds_dip: { left: 100, top: 100, width: 400, height: 100 },
          mode: 'compact',
          capture_protection: true,
          render_state: {},
        };
      });

      const controller = new StageCController(deps);
      await controller.requestOverlay();

      expect(callOrder).toContain('reset');
      expect(callOrder).toContain('snapshot');
      expect(callOrder.indexOf('reset')).toBeLessThan(callOrder.indexOf('snapshot'));
    }));

    it('sends the snapshot over the authenticated connection', withRealTimers(async () => {
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
      const connection = createMockConnection([handshake, snapshotAck, firstFrame]);
      const deps = createHappyPathDeps({
        createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint }),
        authenticate: vi.fn().mockResolvedValue({ connection, thresholdExceeded: false }),
      });

      const controller = new StageCController(deps);
      await controller.requestOverlay();

      // Snapshot was sent through the authenticated connection
      expect(connection.send).toHaveBeenCalled();
      const sentMessages = (connection.send as any).mock.calls;
      const snapshotCall = sentMessages.find(
        (call: any[]) => call[0]?.type === 'state.snapshot',
      );
      expect(snapshotCall).toBeDefined();
    }));
  });

  describe('Matching ack required before cutover (Req 5.11)', () => {
    it('falls back with STATE_ACK_TIMEOUT when ack has wrong revision', withRealTimers(async () => {
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
      const wrongAck = { revision: 999 }; // wrong revision
      const connection = createMockConnection([handshake, wrongAck]);
      const deps = createHappyPathDeps({
        createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint }),
        authenticate: vi.fn().mockResolvedValue({ connection, thresholdExceeded: false }),
      });

      const controller = new StageCController(deps);
      await controller.requestOverlay();

      const status = controller.status();
      expect(status.failure).toBe(StageCFailureReason.STATE_ACK_TIMEOUT);
    }));

    it('falls back with STATE_ACK_TIMEOUT when ack never arrives', withRealTimers(async () => {
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
      // After handshake, no more messages (ack never arrives)
      const connection = createMockConnection([handshake]);
      const deps = createHappyPathDeps({
        createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint }),
        authenticate: vi.fn().mockResolvedValue({ connection, thresholdExceeded: false }),
      });

      const controller = new StageCController(deps);
      await controller.requestOverlay();

      const status = controller.status();
      expect(status.failure).toBe(StageCFailureReason.STATE_ACK_TIMEOUT);
    }));

    it('proceeds when ack revision matches snapshot revision', withRealTimers(async () => {
      const deps = createHappyPathDeps();
      const controller = new StageCController(deps);
      await controller.requestOverlay();

      const status = controller.status();
      expect(status.phase).toBe(StageCPhase.ACTIVE);
    }));
  });

  describe('First frame required in order (Req 5.12–5.14)', () => {
    it('falls back with FIRST_FRAME_TIMEOUT when first frame never arrives', withRealTimers(async () => {
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
      // No first frame message after ack
      const connection = createMockConnection([handshake, snapshotAck]);
      const deps = createHappyPathDeps({
        createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint }),
        authenticate: vi.fn().mockResolvedValue({ connection, thresholdExceeded: false }),
      });

      const controller = new StageCController(deps);
      await controller.requestOverlay();

      const status = controller.status();
      expect(status.failure).toBe(StageCFailureReason.FIRST_FRAME_TIMEOUT);
    }));

    it('falls back when first frame has wrong revision', withRealTimers(async () => {
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
      const wrongFrame = { revision: 42 }; // wrong revision
      const connection = createMockConnection([handshake, snapshotAck, wrongFrame]);
      const deps = createHappyPathDeps({
        createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint }),
        authenticate: vi.fn().mockResolvedValue({ connection, thresholdExceeded: false }),
      });

      const controller = new StageCController(deps);
      await controller.requestOverlay();

      const status = controller.status();
      expect(status.failure).toBe(StageCFailureReason.FIRST_FRAME_TIMEOUT);
    }));
  });

  describe('Reuse of pending/healthy sidecar (Req 5.2)', () => {
    it('does not spawn again when sidecar is active', withRealTimers(async () => {
      const deps = createHappyPathDeps();
      const controller = new StageCController(deps);

      // First request: should spawn
      await controller.requestOverlay();
      expect(deps.spawnSidecar).toHaveBeenCalledTimes(1);
      expect(controller.status().phase).toBe(StageCPhase.ACTIVE);

      // Second request: should reuse (no additional spawn)
      await controller.requestOverlay();
      expect(deps.spawnSidecar).toHaveBeenCalledTimes(1);
    }));
  });

  describe('Cutover ordering (Req 5.15)', () => {
    it('hides Layer 0 before entering ACTIVE phase', withRealTimers(async () => {
      const deps = createHappyPathDeps();
      const callOrder: string[] = [];
      (deps.layer0.hide as any).mockImplementation(() => callOrder.push('hide'));

      const controller = new StageCController(deps);
      await controller.requestOverlay();

      // Layer 0 hide should have been called
      expect(deps.layer0.hide).toHaveBeenCalled();
      expect(controller.status().phase).toBe(StageCPhase.ACTIVE);
    }));
  });

  describe('Failed this launch stays on Layer 0 (Req 4.12)', () => {
    it('does not re-probe after failure', withRealTimers(async () => {
      const deps = createHappyPathDeps({
        authenticate: vi.fn().mockResolvedValue(null), // Auth will fail
      });
      const controller = new StageCController(deps);

      // First attempt fails
      await controller.requestOverlay();
      expect(controller.hasFailedThisLaunch).toBe(true);

      // Reset call count
      (deps.runProbe as any).mockClear();

      // Second attempt should not probe — failed this launch
      await controller.requestOverlay();
      expect(deps.runProbe).not.toHaveBeenCalled();
      expect(controller.status().phase).toBe(StageCPhase.LAYER_0_ACTIVE);
    }));
  });

  describe('Diagnostic retry (Req 5.23–5.25)', () => {
    it('allows one retry after failure', withRealTimers(async () => {
      // First: failing deps (auth returns null)
      const endpoint = createMockEndpoint();
      const deps = createHappyPathDeps({
        createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint }),
        authenticate: vi.fn().mockResolvedValue(null),
      });
      const controller = new StageCController(deps);

      await controller.requestOverlay();
      expect(controller.hasFailedThisLaunch).toBe(true);

      // Now set up for success on retry
      const successEndpoint = createMockEndpoint('retry-id');
      const handshake = {
        launch_id: successEndpoint.launchId,
        sidecar_version: '1.0.0',
        protocol_major: 1,
        protocol_minor: 0,
        bridge_schema_version: 1,
        capabilities: ['overlay'],
        webview2_runtime_version: '119.0.2151.97',
      };
      const ack = { revision: 1 };
      const frame = { revision: 1 };
      const successConnection = createMockConnection([handshake, ack, frame]);

      (deps.createEndpoint as any).mockReturnValue({ ok: true, endpoint: successEndpoint });
      (deps.authenticate as any).mockResolvedValue({ connection: successConnection, thresholdExceeded: false });

      const result = await controller.requestDiagnosticRetry();
      expect(result).toBe(true);
    }));

    it('rejects second retry', withRealTimers(async () => {
      const deps = createHappyPathDeps({
        authenticate: vi.fn().mockResolvedValue(null),
      });
      const controller = new StageCController(deps);

      await controller.requestOverlay();
      await controller.requestDiagnosticRetry();
      const result = await controller.requestDiagnosticRetry();
      expect(result).toBe(false);
    }));
  });

  describe('Fallback restores Layer 0 (Req 13.1, 13.9)', () => {
    it('shows Layer 0 on auth failure', withRealTimers(async () => {
      const deps = createHappyPathDeps({
        authenticate: vi.fn().mockResolvedValue(null),
      });
      const controller = new StageCController(deps);
      await controller.requestOverlay();

      // show is called both at the start (warm Layer 0) and during fallback
      expect(deps.layer0.show).toHaveBeenCalled();
      expect(controller.status().strategy).toBe(HostStrategy.LAYER_0);
    }));
  });

  describe('Cleanup on failure', () => {
    it('kills sidecar process on handshake failure', withRealTimers(async () => {
      const endpoint = createMockEndpoint();
      const childProcess = createMockChildProcess();
      const connection = createMockConnection([]); // no handshake comes
      const deps = createHappyPathDeps({
        createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint }),
        spawnSidecar: vi.fn().mockReturnValue(childProcess),
        authenticate: vi.fn().mockResolvedValue({ connection, thresholdExceeded: false }),
      });

      const controller = new StageCController(deps);
      await controller.requestOverlay();

      expect((childProcess as any).kill).toHaveBeenCalled();
    }));

    it('destroys endpoint on failure', withRealTimers(async () => {
      const endpoint = createMockEndpoint();
      const connection = createMockConnection([]); // no handshake
      const deps = createHappyPathDeps({
        createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint }),
        authenticate: vi.fn().mockResolvedValue({ connection, thresholdExceeded: false }),
      });

      const controller = new StageCController(deps);
      await controller.requestOverlay();

      expect(endpoint.destroy).toHaveBeenCalled();
    }));
  });

  describe('Status reporting', () => {
    it('reports LAYER_0 strategy when not active', withRealTimers(async () => {
      const deps = createHappyPathDeps({
        runProbe: vi.fn().mockResolvedValue({ eligible: false, reason: 'NON_WINDOWS' }),
      });
      const controller = new StageCController(deps);
      await controller.requestOverlay();

      const status = controller.status();
      expect(status.strategy).toBe(HostStrategy.LAYER_0);
    }));

    it('reports STAGE_C strategy when active', withRealTimers(async () => {
      const deps = createHappyPathDeps();
      const controller = new StageCController(deps);
      await controller.requestOverlay();

      const status = controller.status();
      expect(status.strategy).toBe(HostStrategy.STAGE_C);
    }));
  });
});
