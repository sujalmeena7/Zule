// ============================================
// Zule AI — Stage C Controller Integration & Failure-Injection Tests
// ============================================
//
// Task 24.15: Cover every probe/startup/endpoint/auth/handshake/WebView2/
// bridge/composition/snapshot/frame/disconnect/timeout/crash failure,
// repeated requests, retry limit, normal shutdown.
//
// Requirements: 4.1–4.13, 5.1–5.25, 8.1–8.10, 13.1–13.17, 17.15–17.16, 17.22

import { describe, it, expect, vi } from 'vitest';

import {
  StageCController,
  StageCControllerDeps,
  AuthenticatedConnection,
} from '../../stageC/controller';

import { StageCPhase, HostStrategy, StageCFailureReason } from '../../stageC/protocol/schema';
import type { RuntimeProbeResult } from '../../stageC/runtimeProbe';
import type { Layer0AdapterInterface, CanonicalProjectionOwner } from '../../stageC/layer0Adapter';
import type { AuthConnection } from '../../stageC/ipc/authenticator';
import type { LaunchEndpoint, BootstrapRecord } from '../../stageC/ipc/namedPipe';
import type { OverlayProjection } from '../../stageC/protocol/projection';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

// ────────────────────────────────────────────────────────────────────
// Shared test infrastructure
// ────────────────────────────────────────────────────────────────────

function mockLayer0(): Layer0AdapterInterface {
  return {
    ensureCreated: vi.fn(), show: vi.fn(), hide: vi.fn(),
    applyState: vi.fn(), setBounds: vi.fn(),
    setCaptureProtection: vi.fn().mockReturnValue(true),
    isVisible: vi.fn().mockReturnValue(true),
    getBounds: vi.fn().mockReturnValue({ left: 100, top: 100, width: 400, height: 100 }),
    getCaptureProtection: vi.fn().mockReturnValue(true),
    isUsable: vi.fn().mockReturnValue(true),
  };
}

function mockProjectionOwner(): CanonicalProjectionOwner {
  let rev = 0;
  return {
    getState: vi.fn().mockReturnValue({
      visible: true, mode: 'compact',
      bounds_dip: { left: 100, top: 100, width: 400, height: 100 },
      capture_protection: true, isSystemAudioActive: false,
      isLoading: false, isStreaming: false, streamingText: '',
      aiResponse: null, inputText: '', elapsedTime: 0,
    }),
    updateState: vi.fn(),
    buildSnapshot: vi.fn().mockImplementation(() => {
      rev++;
      return { revision: rev, visibility_requested: true,
        bounds_dip: { left: 100, top: 100, width: 400, height: 100 },
        mode: 'compact', capture_protection: true, render_state: {},
      } as OverlayProjection;
    }),
    buildPatch: vi.fn().mockReturnValue(null),
    resetProjection: vi.fn(),
    getRevision: vi.fn().mockImplementation(() => rev),
  };
}

function mockEndpoint(launchId = 'int-launch'): LaunchEndpoint {
  return {
    pipeName: `\\\\.\\pipe\\zule-${launchId}`,
    launchId,
    bootstrap: {
      pipeName: `\\\\.\\pipe\\zule-${launchId}`, launchId,
      credential: 'x'.repeat(64), serverNonce: 'y'.repeat(64),
      clientNonce: 'z'.repeat(64), parentPid: 5000,
    } as BootstrapRecord,
    server: { close: vi.fn() } as any,
    consumed: false,
    destroy: vi.fn(),
  };
}

function mockChild(): ChildProcess {
  const p = new EventEmitter() as unknown as ChildProcess;
  (p as any).pid = 4444;
  (p as any).killed = false;
  (p as any).kill = vi.fn(() => { (p as any).killed = true; });
  return p;
}

function mockConn(msgs: unknown[] = []): AuthConnection {
  let i = 0;
  return {
    send: vi.fn(),
    receive: vi.fn().mockImplementation(async () => i < msgs.length ? msgs[i++] : null),
    close: vi.fn(),
    connected: true,
  };
}

function happyDeps(overrides: Partial<StageCControllerDeps> = {}): StageCControllerDeps {
  const ep = mockEndpoint();
  const hs = {
    launch_id: ep.launchId, sidecar_version: '1.0.0',
    protocol_major: 1, protocol_minor: 0, bridge_schema_version: 1,
    capabilities: ['overlay'], webview2_runtime_version: '119.0.2151.97',
  };
  const conn = mockConn([hs, { revision: 1 }, { revision: 1 }]);
  return {
    layer0: mockLayer0(), projectionOwner: mockProjectionOwner(),
    runProbe: vi.fn().mockResolvedValue({ eligible: true, reason: null } as RuntimeProbeResult),
    createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint: ep }),
    spawnSidecar: vi.fn().mockReturnValue(mockChild()),
    getSidecarPath: vi.fn().mockReturnValue('C:\\ZuleUI.exe'),
    deliverBootstrap: vi.fn().mockResolvedValue({ ok: true, bootstrapPipeName: '\\\\.\\pipe\\bs' }),
    awaitConnection: vi.fn().mockResolvedValue(conn),
    authenticate: vi.fn().mockResolvedValue({ connection: conn, thresholdExceeded: false } as AuthenticatedConnection),
    getRequiredCapabilities: vi.fn().mockReturnValue(['overlay']),
    emitTelemetry: vi.fn(), verifyNoOrphans: vi.fn(), invalidateCredential: vi.fn(),
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// Integration Tests
// ────────────────────────────────────────────────────────────────────

describe('Stage C Controller — Integration & Failure Injection', () => {
  describe('Probe failures', () => {
    it('non-eligible probe keeps Layer 0 active', async () => {
      const deps = happyDeps({ runProbe: vi.fn().mockResolvedValue({ eligible: false, reason: 'NON_WINDOWS' }) });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().phase).toBe(StageCPhase.LAYER_0_ACTIVE);
      expect(deps.spawnSidecar).not.toHaveBeenCalled();
    });

    it('probe returning ineligible prevents any launch attempt', async () => {
      const deps = happyDeps({ runProbe: vi.fn().mockResolvedValue({ eligible: false, reason: 'MANIFEST_MISSING' }) });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().strategy).toBe(HostStrategy.LAYER_0);
      expect(deps.spawnSidecar).not.toHaveBeenCalled();
      expect(deps.createEndpoint).not.toHaveBeenCalled();
    });
  });

  describe('Endpoint failures', () => {
    it('createEndpoint failure triggers NATIVE_BOUNDARY_FAILURE', async () => {
      const deps = happyDeps({ createEndpoint: vi.fn().mockReturnValue({ ok: false, reason: 'pipe_error' }) });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().failure).toBe(StageCFailureReason.NATIVE_BOUNDARY_FAILURE);
    });
  });

  describe('Sidecar path failures', () => {
    it('null sidecar path triggers NATIVE_BOUNDARY_FAILURE', async () => {
      const deps = happyDeps({ getSidecarPath: vi.fn().mockReturnValue(null) });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().failure).toBe(StageCFailureReason.NATIVE_BOUNDARY_FAILURE);
    });
  });

  describe('Spawn failures', () => {
    it('null spawn result triggers NATIVE_BOUNDARY_FAILURE', async () => {
      const deps = happyDeps({ spawnSidecar: vi.fn().mockReturnValue(null) });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().failure).toBe(StageCFailureReason.NATIVE_BOUNDARY_FAILURE);
    });
  });

  describe('Bootstrap delivery failures', () => {
    it('deliverBootstrap failure triggers NATIVE_BOUNDARY_FAILURE', async () => {
      const deps = happyDeps({ deliverBootstrap: vi.fn().mockResolvedValue({ ok: false, reason: 'delivery_failed' }) });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().failure).toBe(StageCFailureReason.NATIVE_BOUNDARY_FAILURE);
    });
  });

  describe('Authentication failures', () => {
    it('null connection triggers AUTHENTICATION_FAILED', async () => {
      const deps = happyDeps({ awaitConnection: vi.fn().mockResolvedValue(null) });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().failure).toBe(StageCFailureReason.AUTHENTICATION_FAILED);
    });

    it('null auth result triggers AUTHENTICATION_FAILED', async () => {
      const deps = happyDeps({ authenticate: vi.fn().mockResolvedValue(null) });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().failure).toBe(StageCFailureReason.AUTHENTICATION_FAILED);
    });
  });

  describe('Handshake failures', () => {
    it('no handshake message triggers HANDSHAKE_FAILURE', async () => {
      const conn = mockConn([]);
      const deps = happyDeps({ authenticate: vi.fn().mockResolvedValue({ connection: conn, thresholdExceeded: false }) });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().failure).toBe(StageCFailureReason.HANDSHAKE_FAILURE);
    });

    it('wrong protocol_major triggers HANDSHAKE_FAILURE', async () => {
      const ep = mockEndpoint();
      const badHs = { launch_id: ep.launchId, sidecar_version: '1.0.0', protocol_major: 99, protocol_minor: 0, bridge_schema_version: 1, capabilities: ['overlay'], webview2_runtime_version: '119.0.0.0' };
      const conn = mockConn([badHs]);
      const deps = happyDeps({
        createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint: ep }),
        authenticate: vi.fn().mockResolvedValue({ connection: conn, thresholdExceeded: false }),
      });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().failure).toBe(StageCFailureReason.HANDSHAKE_FAILURE);
    });

    it('missing capability triggers HANDSHAKE_FAILURE', async () => {
      const ep = mockEndpoint();
      const hs = { launch_id: ep.launchId, sidecar_version: '1.0.0', protocol_major: 1, protocol_minor: 0, bridge_schema_version: 1, capabilities: [], webview2_runtime_version: '119.0.0.0' };
      const conn = mockConn([hs]);
      const deps = happyDeps({
        createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint: ep }),
        authenticate: vi.fn().mockResolvedValue({ connection: conn, thresholdExceeded: false }),
      });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().failure).toBe(StageCFailureReason.HANDSHAKE_FAILURE);
    });
  });

  describe('Snapshot ack failures', () => {
    it('no ack triggers STATE_ACK_TIMEOUT', async () => {
      const ep = mockEndpoint();
      const hs = { launch_id: ep.launchId, sidecar_version: '1.0.0', protocol_major: 1, protocol_minor: 0, bridge_schema_version: 1, capabilities: ['overlay'], webview2_runtime_version: '119.0.0.0' };
      const conn = mockConn([hs]); // only handshake, no ack
      const deps = happyDeps({
        createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint: ep }),
        authenticate: vi.fn().mockResolvedValue({ connection: conn, thresholdExceeded: false }),
      });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().failure).toBe(StageCFailureReason.STATE_ACK_TIMEOUT);
    });

    it('wrong revision ack triggers STATE_ACK_TIMEOUT', async () => {
      const ep = mockEndpoint();
      const hs = { launch_id: ep.launchId, sidecar_version: '1.0.0', protocol_major: 1, protocol_minor: 0, bridge_schema_version: 1, capabilities: ['overlay'], webview2_runtime_version: '119.0.0.0' };
      const conn = mockConn([hs, { revision: 999 }]);
      const deps = happyDeps({
        createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint: ep }),
        authenticate: vi.fn().mockResolvedValue({ connection: conn, thresholdExceeded: false }),
      });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().failure).toBe(StageCFailureReason.STATE_ACK_TIMEOUT);
    });
  });

  describe('First frame failures', () => {
    it('no first frame triggers FIRST_FRAME_TIMEOUT', async () => {
      const ep = mockEndpoint();
      const hs = { launch_id: ep.launchId, sidecar_version: '1.0.0', protocol_major: 1, protocol_minor: 0, bridge_schema_version: 1, capabilities: ['overlay'], webview2_runtime_version: '119.0.0.0' };
      const conn = mockConn([hs, { revision: 1 }]); // ack but no frame
      const deps = happyDeps({
        createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint: ep }),
        authenticate: vi.fn().mockResolvedValue({ connection: conn, thresholdExceeded: false }),
      });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().failure).toBe(StageCFailureReason.FIRST_FRAME_TIMEOUT);
    });

    it('wrong revision frame triggers FIRST_FRAME_TIMEOUT', async () => {
      const ep = mockEndpoint();
      const hs = { launch_id: ep.launchId, sidecar_version: '1.0.0', protocol_major: 1, protocol_minor: 0, bridge_schema_version: 1, capabilities: ['overlay'], webview2_runtime_version: '119.0.0.0' };
      const conn = mockConn([hs, { revision: 1 }, { revision: 42 }]);
      const deps = happyDeps({
        createEndpoint: vi.fn().mockReturnValue({ ok: true, endpoint: ep }),
        authenticate: vi.fn().mockResolvedValue({ connection: conn, thresholdExceeded: false }),
      });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().failure).toBe(StageCFailureReason.FIRST_FRAME_TIMEOUT);
    });
  });

  describe('Disconnect and crash events', () => {
    it('onDisconnect triggers fallback when active', async () => {
      const deps = happyDeps();
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().phase).toBe(StageCPhase.ACTIVE);

      ctrl.onDisconnect();
      expect(ctrl.status().phase).toBe(StageCPhase.LAYER_0_ACTIVE);
    });

    it('onProcessExit triggers fallback when active', async () => {
      const deps = happyDeps();
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().phase).toBe(StageCPhase.ACTIVE);

      ctrl.onProcessExit();
      expect(ctrl.status().phase).toBe(StageCPhase.LAYER_0_ACTIVE);
    });

    it('onCaptureFailure triggers fallback', async () => {
      const deps = happyDeps();
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();

      ctrl.onCaptureFailure();
      expect(ctrl.status().phase).toBe(StageCPhase.LAYER_0_ACTIVE);
      expect(ctrl.status().failure).toBe(StageCFailureReason.CAPTURE_PROTECTION_FAILURE);
    });
  });

  describe('Repeated requests and reuse', () => {
    it('second request reuses active sidecar', async () => {
      const deps = happyDeps();
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      await ctrl.requestOverlay();
      expect((deps.spawnSidecar as any).mock.calls.length).toBe(1);
    });

    it('request after failure stays on Layer 0', async () => {
      const deps = happyDeps({ authenticate: vi.fn().mockResolvedValue(null) });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.hasFailedThisLaunch).toBe(true);

      await ctrl.requestOverlay();
      expect(ctrl.status().phase).toBe(StageCPhase.LAYER_0_ACTIVE);
      expect((deps.runProbe as any).mock.calls.length).toBe(1); // no re-probe
    });
  });

  describe('Retry limit', () => {
    it('allows exactly one diagnostic retry', async () => {
      const deps = happyDeps({ authenticate: vi.fn().mockResolvedValue(null) });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();

      const firstRetry = await ctrl.requestDiagnosticRetry();
      expect(firstRetry).toBe(true);

      const secondRetry = await ctrl.requestDiagnosticRetry();
      expect(secondRetry).toBe(false);
    });

    it('retry without prior failure returns false', async () => {
      const deps = happyDeps();
      const ctrl = new StageCController(deps);
      // No failure occurred — retry should be rejected
      const result = await ctrl.requestDiagnosticRetry();
      expect(result).toBe(false);
    });
  });

  describe('Normal shutdown', () => {
    it('stopOverlay sends shutdown and cleans up', async () => {
      const deps = happyDeps();
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(ctrl.status().phase).toBe(StageCPhase.ACTIVE);

      await ctrl.stopOverlay();
      expect(ctrl.status().phase).toBe(StageCPhase.DISABLED);
      expect(deps.layer0.hide).toHaveBeenCalled();
    });

    it('stopOverlay when not active just hides Layer 0', async () => {
      const deps = happyDeps({ runProbe: vi.fn().mockResolvedValue({ eligible: false, reason: 'NON_WINDOWS' }) });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();

      await ctrl.stopOverlay();
      expect(deps.layer0.hide).toHaveBeenCalled();
    });
  });

  describe('Happy path — full startup success', () => {
    it('completes probe → spawn → auth → handshake → sync → cutover', async () => {
      const deps = happyDeps();
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();

      expect(ctrl.status().phase).toBe(StageCPhase.ACTIVE);
      expect(ctrl.status().strategy).toBe(HostStrategy.STAGE_C);
      expect(ctrl.status().failure).toBeNull();
      expect(deps.runProbe).toHaveBeenCalledTimes(1);
      expect(deps.spawnSidecar).toHaveBeenCalledTimes(1);
      expect(deps.authenticate).toHaveBeenCalledTimes(1);
      expect(deps.layer0.hide).toHaveBeenCalled();
    });
  });

  describe('Credential invalidation on failure', () => {
    it('invalidateCredential is called on auth failure', async () => {
      const deps = happyDeps({ authenticate: vi.fn().mockResolvedValue(null) });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(deps.invalidateCredential).toHaveBeenCalled();
    });
  });

  describe('Orphan cleanup', () => {
    it('verifyNoOrphans is called on failure', async () => {
      const deps = happyDeps({ authenticate: vi.fn().mockResolvedValue(null) });
      const ctrl = new StageCController(deps);
      await ctrl.requestOverlay();
      expect(deps.verifyNoOrphans).toHaveBeenCalled();
    });
  });
});
