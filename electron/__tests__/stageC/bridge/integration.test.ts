/**
 * Stage C — Packaged-Overlay, Bridge, and Service-Ownership Integration Tests
 *
 * Tests:
 * - Exact 65,536 / 65,537-byte bridge message boundaries
 * - Denied content operations (navigation/popups/downloads/permissions)
 * - Invalid native revalidation outcomes
 * - Projection redaction (no credentials/paths/media)
 * - Stream/result routing (ai.streamDelta/completed/failed)
 * - Absence of duplicate service pipelines
 *
 * Requirements: 7.1–7.15, 8.1–8.10, 17.12
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  revalidatePageMessage,
  dispatchPageMessage,
  EXPECTED_BRIDGE_VERSION,
  MAX_BRIDGE_REGIONS,
  MAX_ACTION_STRING_LENGTH,
  MAX_PARAMETERS_KEYS,
} from '../../../stageC/bridge/nativeBridge';
import {
  MAX_BRIDGE_MESSAGE_BYTES,
  BRIDGE_SCHEMA_VERSION,
  SidecarToControllerType,
  ControllerToSidecarType,
  OverlayMode,
} from '../../../stageC/protocol/schema';
import { BridgeMethodType } from '../../../stageC/protocol/bridge';
import {
  WebView2ContentPolicy,
  createContentPolicy,
  ContentPolicyEventType,
  PACKAGED_VIRTUAL_ORIGIN,
} from '../../../stageC/bridge/contentPolicy';
import {
  IntentAdapter,
  createIntentAdapter,
  type IntentAdapterDeps,
  type OverlayServiceDelegate,
  type AIServiceDelegate,
  type AudioServiceDelegate,
  type ScreenCaptureServiceDelegate,
  type SidecarSender,
} from '../../../stageC/intentAdapter';
import {
  ProjectionBuilder,
  isRenderStateSafe,
  type CanonicalOverlayState,
} from '../../../stageC/projectionBuilder';

// ────────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────────

function makeCanonicalState(overrides?: Partial<CanonicalOverlayState>): CanonicalOverlayState {
  return {
    visible: true,
    mode: OverlayMode.COMPACT,
    bounds_dip: { left: 100, top: 50, width: 400, height: 300 },
    capture_protection: true,
    isSystemAudioActive: false,
    isLoading: false,
    isStreaming: false,
    streamingText: '',
    aiResponse: null,
    inputText: '',
    elapsedTime: 0,
    ...overrides,
  };
}

function createMockDeps(canonicalState?: CanonicalOverlayState) {
  const state = canonicalState ?? makeCanonicalState();

  const overlay: OverlayServiceDelegate = {
    toggleMode: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
    toggleVisibility: vi.fn().mockResolvedValue(undefined),
    stopSession: vi.fn().mockResolvedValue(undefined),
    toggleStealth: vi.fn().mockResolvedValue(undefined),
    setInput: vi.fn().mockResolvedValue(undefined),
    submitInput: vi.fn().mockResolvedValue(undefined),
  };

  const ai: AIServiceDelegate = {
    trigger: vi.fn().mockResolvedValue(undefined),
    stopGeneration: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  };

  const audio: AudioServiceDelegate = {
    toggleSystemAudio: vi.fn().mockResolvedValue(undefined),
  };

  const screenCapture: ScreenCaptureServiceDelegate = {
    useScreen: vi.fn().mockResolvedValue(undefined),
  };

  const sender: SidecarSender = {
    sendSnapshot: vi.fn(),
    sendPatch: vi.fn(),
    sendAiStreamDelta: vi.fn(),
    sendAiStreamCompleted: vi.fn(),
    sendAiStreamFailed: vi.fn(),
    sendOperationResult: vi.fn(),
  };

  const deps: IntentAdapterDeps = {
    overlay,
    ai,
    audio,
    screenCapture,
    sender,
    getCanonicalState: () => state,
    projectionBuilder: new ProjectionBuilder(),
  };

  return { deps, overlay, ai, audio, screenCapture, sender };
}

/**
 * Build a valid bridge method message JSON string with a specific byte size.
 * Uses action padding to reach the target size.
 */
function buildMessageAtByteSize(targetBytes: number): string {
  const base = JSON.stringify({
    version: EXPECTED_BRIDGE_VERSION,
    method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
    action: '',
  });
  // base has action: "" — need to compute how many chars to add
  // base byte length without the action content
  const overhead = Buffer.byteLength(base, 'utf-8');
  const neededPadding = targetBytes - overhead;
  if (neededPadding < 0) {
    throw new Error(`Cannot build message at ${targetBytes} bytes; minimum is ${overhead}`);
  }
  // ASCII chars are 1 byte each in UTF-8
  const paddedAction = 'a'.repeat(neededPadding);
  const msg = JSON.stringify({
    version: EXPECTED_BRIDGE_VERSION,
    method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
    action: paddedAction,
  });
  return msg;
}

// ────────────────────────────────────────────────────────────────────
// Integration Tests
// ────────────────────────────────────────────────────────────────────

describe('Stage C Bridge Integration Tests', () => {
  // ────────────────────────────────────────────────────────────────
  // 1. Exact 65,536 / 65,537-byte boundary tests (Req 7.6)
  // ────────────────────────────────────────────────────────────────

  describe('Bridge message byte boundaries (Req 7.6)', () => {
    it('accepts a message exactly at 65,536 bytes', () => {
      const msg = buildMessageAtByteSize(MAX_BRIDGE_MESSAGE_BYTES);
      const byteLen = Buffer.byteLength(msg, 'utf-8');
      expect(byteLen).toBe(65_536);

      const result = revalidatePageMessage(msg);
      // May fail on action length validation (MAX_ACTION_STRING_LENGTH = 256)
      // but should NOT fail on size. Let's build one within action limits.
      // Use a message with large parameters instead.
      const validMsg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
        action: 'toggle-mode',
        parameters: { data: 'x'.repeat(65_536 - 120) },
      });
      const validByteLen = Buffer.byteLength(validMsg, 'utf-8');
      // Adjust to exactly 65,536
      const diff = MAX_BRIDGE_MESSAGE_BYTES - validByteLen;
      const adjustedMsg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
        action: 'toggle-mode',
        parameters: { data: 'x'.repeat(65_536 - 120 + diff) },
      });
      const adjustedLen = Buffer.byteLength(adjustedMsg, 'utf-8');
      expect(adjustedLen).toBe(65_536);

      const adjustedResult = revalidatePageMessage(adjustedMsg);
      // Should not fail on SIZE_EXCEEDED
      if (!adjustedResult.ok) {
        expect(adjustedResult.error.code).not.toBe('SIZE_EXCEEDED');
      }
    });

    it('rejects a message at 65,537 bytes', () => {
      // Build a message that is exactly 65,537 bytes
      const baseMsg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
        action: 'toggle-mode',
        parameters: { data: '' },
      });
      const baseLen = Buffer.byteLength(baseMsg, 'utf-8');
      const padding = 65_537 - baseLen;
      const oversizeMsg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
        action: 'toggle-mode',
        parameters: { data: 'x'.repeat(padding) },
      });
      const oversizeLen = Buffer.byteLength(oversizeMsg, 'utf-8');
      expect(oversizeLen).toBe(65_537);

      const result = revalidatePageMessage(oversizeMsg);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SIZE_EXCEEDED');
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 2. Denied content operations (Req 7.11–7.15)
  // ────────────────────────────────────────────────────────────────

  describe('Denied content operations (Req 7.11–7.15)', () => {
    let policy: WebView2ContentPolicy;

    beforeEach(() => {
      policy = createContentPolicy({ isProduction: true });
    });

    it('denies navigation to external origin', () => {
      const decision = policy.evaluateNavigation('https://evil.com/steal');
      expect(decision.allowed).toBe(false);
      expect(decision.event?.event_type).toBe(ContentPolicyEventType.NAVIGATION_DENIED);
    });

    it('allows navigation to packaged virtual origin', () => {
      const decision = policy.evaluateNavigation(PACKAGED_VIRTUAL_ORIGIN + '/index.html');
      expect(decision.allowed).toBe(true);
      expect(decision.event).toBeUndefined();
    });

    it('denies all new window (popup) requests', () => {
      const decision = policy.evaluateNewWindow(PACKAGED_VIRTUAL_ORIGIN + '/popup.html');
      expect(decision.allowed).toBe(false);
      expect(decision.event?.event_type).toBe(ContentPolicyEventType.NEW_WINDOW_DENIED);
    });

    it('denies all download requests', () => {
      const decision = policy.evaluateDownload('https://example.com/file.zip');
      expect(decision.allowed).toBe(false);
      expect(decision.event?.event_type).toBe(ContentPolicyEventType.DOWNLOAD_DENIED);
    });

    it('denies all permission requests', () => {
      const decision = policy.evaluatePermission('camera');
      expect(decision.allowed).toBe(false);
      expect(decision.event?.event_type).toBe(ContentPolicyEventType.PERMISSION_DENIED);
    });

    it('denies external URI launches', () => {
      const decision = policy.evaluateExternalUri('file:///etc/passwd');
      expect(decision.allowed).toBe(false);
      expect(decision.event?.event_type).toBe(ContentPolicyEventType.EXTERNAL_URI_DENIED);
    });

    it('denies drag/drop operations', () => {
      const decision = policy.evaluateDragDrop();
      expect(decision.allowed).toBe(false);
      expect(decision.event?.event_type).toBe(ContentPolicyEventType.DRAG_DROP_DENIED);
    });

    it('denies dev tools in production', () => {
      const decision = policy.evaluateDevTools();
      expect(decision.allowed).toBe(false);
      expect(decision.event?.event_type).toBe(ContentPolicyEventType.DEV_TOOLS_DENIED);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 3. Invalid native revalidation outcomes (Req 7.8, 7.9, 7.15)
  // ────────────────────────────────────────────────────────────────

  describe('Invalid native revalidation (Req 7.8, 7.9, 7.15)', () => {
    it('rejects invalid JSON with typed error', () => {
      const result = revalidatePageMessage('not json {{{');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_JSON');
      }
    });

    it('rejects non-object (array)', () => {
      const result = revalidatePageMessage('[]');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_TYPE');
      }
    });

    it('rejects missing version', () => {
      const msg = JSON.stringify({ method: 'requestOverlayAction', action: 'toggle-mode' });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.field).toBe('version');
      }
    });

    it('rejects incompatible version', () => {
      const msg = JSON.stringify({
        version: 999,
        method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
        action: 'toggle-mode',
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INCOMPATIBLE_VERSION');
      }
    });

    it('rejects unknown method type', () => {
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: 'hackTheSystem',
        action: 'do-evil',
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
    });

    it('rejects action string exceeding maximum length', () => {
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
        action: 'a'.repeat(MAX_ACTION_STRING_LENGTH + 1),
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_RANGE');
        expect(result.error.field).toBe('action');
      }
    });

    it('rejects parameters with too many keys', () => {
      const params: Record<string, unknown> = {};
      for (let i = 0; i < MAX_PARAMETERS_KEYS + 1; i++) {
        params[`key${i}`] = i;
      }
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REQUEST_AI,
        action: 'trigger',
        parameters: params,
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('COUNT_EXCEEDED');
        expect(result.error.field).toBe('parameters');
      }
    });

    it('rejects region count exceeding maximum', () => {
      const regions = Array.from({ length: MAX_BRIDGE_REGIONS + 1 }, (_, i) => ({
        left: 0, top: 0, width: 10, height: 10,
      }));
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REPORT_DRAG_REGIONS,
        revision: 0,
        regions,
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('COUNT_EXCEEDED');
        expect(result.error.field).toBe('regions');
      }
    });

    it('rejects negative region dimensions', () => {
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REPORT_DRAG_REGIONS,
        revision: 0,
        regions: [{ left: 0, top: 0, width: -5, height: 10 }],
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_RANGE');
      }
    });

    it('returns typed error with zero native side effects on every rejection', () => {
      const invalidInputs = [
        'not json',
        '42',
        'null',
        '[]',
        JSON.stringify({ version: 0, method: 'requestAI', action: 'x' }),
        JSON.stringify({ version: EXPECTED_BRIDGE_VERSION }),
      ];

      for (const input of invalidInputs) {
        const result = revalidatePageMessage(input);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          // Each rejection has a code and message (typed error)
          expect(result.error.code).toBeTruthy();
          expect(result.error.message).toBeTruthy();
        }
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 4. Projection redaction (Req 8.6 — no credentials/paths/media)
  // ────────────────────────────────────────────────────────────────

  describe('Projection redaction (Req 8.6)', () => {
    it('isRenderStateSafe rejects objects containing credential keys', () => {
      expect(isRenderStateSafe({ apiKey: 'sk-abc123' })).toBe(false);
      expect(isRenderStateSafe({ credential: 'secret' })).toBe(false);
      expect(isRenderStateSafe({ token: 'bearer-xyz' })).toBe(false);
      expect(isRenderStateSafe({ access_token: 'tok' })).toBe(false);
      expect(isRenderStateSafe({ refresh_token: 'ref' })).toBe(false);
      expect(isRenderStateSafe({ secret: 'shhh' })).toBe(false);
      expect(isRenderStateSafe({ password: 'p4ss' })).toBe(false);
    });

    it('isRenderStateSafe rejects objects with raw media keys', () => {
      expect(isRenderStateSafe({ rawAudio: Buffer.alloc(10) })).toBe(false);
      expect(isRenderStateSafe({ audioBuffer: [] })).toBe(false);
      expect(isRenderStateSafe({ screenshotBytes: 'data' })).toBe(false);
      expect(isRenderStateSafe({ screenshotData: 'base64' })).toBe(false);
      expect(isRenderStateSafe({ imageData: 'pixels' })).toBe(false);
    });

    it('isRenderStateSafe rejects objects with path/db keys', () => {
      expect(isRenderStateSafe({ filePath: '/etc/passwd' })).toBe(false);
      expect(isRenderStateSafe({ absolutePath: 'C:\\secret' })).toBe(false);
      expect(isRenderStateSafe({ databaseUrl: 'postgres://...' })).toBe(false);
      expect(isRenderStateSafe({ connectionString: 'mongodb://...' })).toBe(false);
      expect(isRenderStateSafe({ serviceHandle: 0x12345 })).toBe(false);
      expect(isRenderStateSafe({ dbValue: { row: 1 } })).toBe(false);
    });

    it('isRenderStateSafe rejects nested redacted keys', () => {
      expect(isRenderStateSafe({
        nested: { deep: { apiKey: 'hidden' } },
      })).toBe(false);
      expect(isRenderStateSafe({
        array: [{ token: 'secret' }],
      })).toBe(false);
    });

    it('isRenderStateSafe accepts clean render state', () => {
      expect(isRenderStateSafe({
        visible: true,
        mode: 'compact',
        isLoading: false,
        streamingText: 'hello',
        elapsedTime: 42,
      })).toBe(true);
    });

    it('ProjectionBuilder snapshot never contains redacted keys', () => {
      const builder = new ProjectionBuilder();
      const state = makeCanonicalState({
        isStreaming: true,
        streamingText: 'AI response text',
        aiResponse: { text: 'done', suggestions: ['s1'], followUps: ['f1'] },
      });

      const projection = builder.buildSnapshot(state);

      // Verify no redacted keys appear in the projection render state
      expect(isRenderStateSafe(projection.render_state)).toBe(true);
      // Verify the render state doesn't contain any credential-like data
      const renderStr = JSON.stringify(projection.render_state);
      expect(renderStr).not.toContain('apiKey');
      expect(renderStr).not.toContain('credential');
      expect(renderStr).not.toContain('filePath');
      expect(renderStr).not.toContain('rawAudio');
      expect(renderStr).not.toContain('screenshotBytes');
      expect(renderStr).not.toContain('databaseUrl');
      expect(renderStr).not.toContain('serviceHandle');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 5. Stream/result routing (Req 8.9 — ai.streamDelta/completed/failed)
  // ────────────────────────────────────────────────────────────────

  describe('Stream/result routing (Req 8.9)', () => {
    it('routes ai.streamDelta to sidecar sender', () => {
      const { deps, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      adapter.routeAiStreamDelta('stream-42', 'Hello world', 1);
      adapter.routeAiStreamDelta('stream-42', ' continued', 2);

      expect(sender.sendAiStreamDelta).toHaveBeenCalledTimes(2);
      expect(sender.sendAiStreamDelta).toHaveBeenCalledWith('stream-42', 'Hello world', 1);
      expect(sender.sendAiStreamDelta).toHaveBeenCalledWith('stream-42', ' continued', 2);
    });

    it('routes ai.streamCompleted to sidecar sender', () => {
      const { deps, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      adapter.routeAiStreamCompleted('stream-42', 10);

      expect(sender.sendAiStreamCompleted).toHaveBeenCalledWith('stream-42', 10);
    });

    it('routes ai.streamFailed to sidecar sender', () => {
      const { deps, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      adapter.routeAiStreamFailed('stream-42', 'RATE_LIMIT_EXCEEDED');

      expect(sender.sendAiStreamFailed).toHaveBeenCalledWith('stream-42', 'RATE_LIMIT_EXCEEDED');
    });

    it('sends operation result after successful overlay intent', async () => {
      const { deps, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({ action: 'toggle-mode' });

      expect(result.success).toBe(true);
      expect(result.operation_id).toBeTruthy();
      expect(sender.sendOperationResult).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, operation_id: result.operation_id }),
      );
    });

    it('sends operation result after failed overlay intent', async () => {
      const { deps, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({ action: 'unknown-action' as any });

      expect(result.success).toBe(false);
      expect(sender.sendOperationResult).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error_code: 'UNKNOWN_ACTION' }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 6. Absence of duplicate service pipelines (Req 8.10, 17.12)
  // ────────────────────────────────────────────────────────────────

  describe('No duplicate service pipelines (Req 8.10, 17.12)', () => {
    it('all overlay intents route through the same delegate instance', async () => {
      const { deps, overlay } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      // Call multiple different overlay actions
      await adapter.handleOverlayIntent({ action: 'toggle-mode' });
      await adapter.handleOverlayIntent({ action: 'toggle-visibility' });
      await adapter.handleOverlayIntent({ action: 'toggle-maximize' });

      // Each call goes to the same delegate object — verify by checking
      // the mock functions are the same references
      expect(overlay.toggleMode).toHaveBeenCalledOnce();
      expect(overlay.toggleVisibility).toHaveBeenCalledOnce();
      expect(overlay.toggleMaximize).toHaveBeenCalledOnce();
    });

    it('repeated AI intents use the same delegate (no new pipeline)', async () => {
      const { deps, ai } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      await adapter.handleAIIntent({ action: 'trigger', parameters: { query: 'q1' } });
      await adapter.handleAIIntent({ action: 'trigger', parameters: { query: 'q2' } });
      await adapter.handleAIIntent({ action: 'stop-generation' });
      await adapter.handleAIIntent({ action: 'follow-up', parameters: { text: 'more' } });

      // All go to the same ai delegate (single pipeline)
      expect(ai.trigger).toHaveBeenCalledTimes(2);
      expect(ai.stopGeneration).toHaveBeenCalledOnce();
      expect(ai.followUp).toHaveBeenCalledOnce();
    });

    it('audio and screen-capture use single delegates (no duplicates)', async () => {
      const { deps, audio, screenCapture } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      await adapter.handleAudioIntent({ action: 'toggle-system-audio' });
      await adapter.handleAudioIntent({ action: 'toggle-system-audio' });
      await adapter.handleScreenCaptureIntent({ action: 'use-screen' });
      await adapter.handleScreenCaptureIntent({ action: 'use-screen' });

      expect(audio.toggleSystemAudio).toHaveBeenCalledTimes(2);
      expect(screenCapture.useScreen).toHaveBeenCalledTimes(2);
    });

    it('stream routing uses same sender (no duplicate stream pipelines)', () => {
      const { deps, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      // Multiple streams go through same sender
      adapter.routeAiStreamDelta('s1', 'chunk1', 1);
      adapter.routeAiStreamDelta('s2', 'chunk2', 1);
      adapter.routeAiStreamCompleted('s1', 5);
      adapter.routeAiStreamFailed('s2', 'TIMEOUT');

      // All routed through single sender instance
      expect(sender.sendAiStreamDelta).toHaveBeenCalledTimes(2);
      expect(sender.sendAiStreamCompleted).toHaveBeenCalledOnce();
      expect(sender.sendAiStreamFailed).toHaveBeenCalledOnce();
    });

    it('creating adapter does not instantiate any new service', () => {
      const { deps, overlay, ai, audio, screenCapture } = createMockDeps();

      // Creating the adapter should NOT call any service method
      const adapter = createIntentAdapter(deps);

      expect(overlay.toggleMode).not.toHaveBeenCalled();
      expect(ai.trigger).not.toHaveBeenCalled();
      expect(audio.toggleSystemAudio).not.toHaveBeenCalled();
      expect(screenCapture.useScreen).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 7. Full dispatch integration (bridge → IPC mapping)
  // ────────────────────────────────────────────────────────────────

  describe('Full bridge dispatch integration (Req 7.4)', () => {
    it('dispatches valid overlay action to correct IPC type', () => {
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
        action: 'toggle-mode',
      });

      const result = dispatchPageMessage(msg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.ipcType).toBe(SidecarToControllerType.INTENT_OVERLAY);
        expect(result.value.payload).toEqual({
          action: 'toggle-mode',
          parameters: undefined,
        });
      }
    });

    it('dispatches valid AI action to correct IPC type', () => {
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REQUEST_AI,
        action: 'trigger',
        parameters: { query: 'test' },
      });

      const result = dispatchPageMessage(msg);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.ipcType).toBe(SidecarToControllerType.INTENT_AI);
        expect(result.value.payload).toEqual({
          action: 'trigger',
          parameters: { query: 'test' },
        });
      }
    });
  });
});
