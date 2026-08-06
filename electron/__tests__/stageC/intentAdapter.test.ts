/**
 * Stage C — Intent Adapter Tests
 *
 * Verifies that the intent adapter:
 * - Routes allowlisted intents to existing Electron services
 * - Validates action types and parameters before invoking services
 * - Updates canonical state only after validated execution
 * - Projects state without credentials, raw media, screenshot bytes,
 *   unrestricted paths, or database values
 * - Routes AI stream events to the sidecar
 * - Sends operation results after each intent
 * - Creates ZERO duplicate service pipelines
 *
 * Requirements: 8.1–8.10
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  IntentAdapter,
  createIntentAdapter,
  type IntentAdapterDeps,
  type OverlayServiceDelegate,
  type AIServiceDelegate,
  type AudioServiceDelegate,
  type ScreenCaptureServiceDelegate,
  type SidecarSender,
  type OverlayIntent,
  type AIIntent,
  type AudioIntent,
  type ScreenCaptureIntent,
} from '../../stageC/intentAdapter';
import { ProjectionBuilder, type CanonicalOverlayState } from '../../stageC/projectionBuilder';
import { OverlayMode } from '../../stageC/protocol/schema';

// ────────────────────────────────────────────────────────────────────
// Test Fixtures
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

function createMockDeps(canonicalState?: CanonicalOverlayState): {
  deps: IntentAdapterDeps;
  overlay: jest.Mocked<OverlayServiceDelegate>;
  ai: jest.Mocked<AIServiceDelegate>;
  audio: jest.Mocked<AudioServiceDelegate>;
  screenCapture: jest.Mocked<ScreenCaptureServiceDelegate>;
  sender: jest.Mocked<SidecarSender>;
  getState: () => CanonicalOverlayState;
} {
  const state = canonicalState ?? makeCanonicalState();

  const overlay: any = {
    toggleMode: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
    toggleVisibility: vi.fn().mockResolvedValue(undefined),
    stopSession: vi.fn().mockResolvedValue(undefined),
    toggleStealth: vi.fn().mockResolvedValue(undefined),
    setInput: vi.fn().mockResolvedValue(undefined),
    submitInput: vi.fn().mockResolvedValue(undefined),
  };

  const ai: any = {
    trigger: vi.fn().mockResolvedValue(undefined),
    stopGeneration: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  };

  const audio: any = {
    toggleSystemAudio: vi.fn().mockResolvedValue(undefined),
  };

  const screenCapture: any = {
    useScreen: vi.fn().mockResolvedValue(undefined),
  };

  const sender: any = {
    sendSnapshot: vi.fn(),
    sendPatch: vi.fn(),
    sendAiStreamDelta: vi.fn(),
    sendAiStreamCompleted: vi.fn(),
    sendAiStreamFailed: vi.fn(),
    sendOperationResult: vi.fn(),
  };

  const getState = () => state;

  const deps: IntentAdapterDeps = {
    overlay,
    ai,
    audio,
    screenCapture,
    sender,
    getCanonicalState: getState,
    projectionBuilder: new ProjectionBuilder(),
  };

  return { deps, overlay, ai, audio, screenCapture, sender, getState };
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('IntentAdapter', () => {
  describe('Overlay Intent Routing (Req 8.4, 8.8)', () => {
    it('routes toggle-mode to overlay service', async () => {
      const { deps, overlay, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({ action: 'toggle-mode' });

      expect(result.success).toBe(true);
      expect(overlay.toggleMode).toHaveBeenCalledOnce();
      expect(sender.sendOperationResult).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
    });

    it('routes toggle-maximize to overlay service', async () => {
      const { deps, overlay } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({ action: 'toggle-maximize' });

      expect(result.success).toBe(true);
      expect(overlay.toggleMaximize).toHaveBeenCalledOnce();
    });

    it('routes set-mode with valid mode parameter', async () => {
      const { deps, overlay } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({
        action: 'set-mode',
        parameters: { mode: 'expanded' },
      });

      expect(result.success).toBe(true);
      expect(overlay.setMode).toHaveBeenCalledWith('expanded');
    });

    it('routes toggle-visibility to overlay service', async () => {
      const { deps, overlay } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({ action: 'toggle-visibility' });

      expect(result.success).toBe(true);
      expect(overlay.toggleVisibility).toHaveBeenCalledOnce();
    });

    it('routes stop-session to overlay service', async () => {
      const { deps, overlay } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({ action: 'stop-session' });

      expect(result.success).toBe(true);
      expect(overlay.stopSession).toHaveBeenCalledOnce();
    });

    it('routes toggle-stealth with enabled parameter', async () => {
      const { deps, overlay } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({
        action: 'toggle-stealth',
        parameters: { enabled: false },
      });

      expect(result.success).toBe(true);
      expect(overlay.toggleStealth).toHaveBeenCalledWith(false);
    });

    it('routes set-input with text parameter', async () => {
      const { deps, overlay } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({
        action: 'set-input',
        parameters: { text: 'hello world' },
      });

      expect(result.success).toBe(true);
      expect(overlay.setInput).toHaveBeenCalledWith('hello world');
    });

    it('routes submit-input with text parameter', async () => {
      const { deps, overlay } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({
        action: 'submit-input',
        parameters: { text: 'tell me about TypeScript' },
      });

      expect(result.success).toBe(true);
      expect(overlay.submitInput).toHaveBeenCalledWith('tell me about TypeScript');
    });
  });

  describe('Overlay Intent Validation (Req 8.4)', () => {
    it('rejects unknown overlay actions', async () => {
      const { deps, overlay, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({
        action: 'delete-everything' as any,
      });

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('UNKNOWN_ACTION');
      // Service must NOT be called
      expect(overlay.toggleMode).not.toHaveBeenCalled();
      expect(overlay.toggleMaximize).not.toHaveBeenCalled();
      expect(sender.sendOperationResult).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error_code: 'UNKNOWN_ACTION' }),
      );
    });

    it('rejects set-mode with missing mode parameter', async () => {
      const { deps, overlay } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({
        action: 'set-mode',
        parameters: {},
      });

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('INVALID_PARAMETERS');
      expect(overlay.setMode).not.toHaveBeenCalled();
    });

    it('rejects set-mode with invalid mode value', async () => {
      const { deps, overlay } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({
        action: 'set-mode',
        parameters: { mode: 'fullscreen' },
      });

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('INVALID_PARAMETERS');
      expect(overlay.setMode).not.toHaveBeenCalled();
    });

    it('rejects toggle-stealth without enabled parameter', async () => {
      const { deps, overlay } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({
        action: 'toggle-stealth',
        parameters: {},
      });

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('INVALID_PARAMETERS');
      expect(overlay.toggleStealth).not.toHaveBeenCalled();
    });

    it('rejects submit-input without text parameter', async () => {
      const { deps, overlay } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({
        action: 'submit-input',
      });

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('INVALID_PARAMETERS');
      expect(overlay.submitInput).not.toHaveBeenCalled();
    });
  });

  describe('AI Intent Routing (Req 8.5, 8.10)', () => {
    it('routes trigger to existing AI service', async () => {
      const { deps, ai } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleAIIntent({ action: 'trigger' });

      expect(result.success).toBe(true);
      expect(ai.trigger).toHaveBeenCalledWith(undefined);
    });

    it('routes trigger with query to existing AI service', async () => {
      const { deps, ai } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleAIIntent({
        action: 'trigger',
        parameters: { query: 'explain this code' },
      });

      expect(result.success).toBe(true);
      expect(ai.trigger).toHaveBeenCalledWith('explain this code');
    });

    it('routes stop-generation to existing AI service', async () => {
      const { deps, ai } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleAIIntent({ action: 'stop-generation' });

      expect(result.success).toBe(true);
      expect(ai.stopGeneration).toHaveBeenCalledOnce();
    });

    it('routes follow-up to existing AI service', async () => {
      const { deps, ai } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleAIIntent({
        action: 'follow-up',
        parameters: { text: 'can you elaborate?' },
      });

      expect(result.success).toBe(true);
      expect(ai.followUp).toHaveBeenCalledWith('can you elaborate?');
    });

    it('rejects unknown AI actions', async () => {
      const { deps, ai } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleAIIntent({
        action: 'hack-openai' as any,
      });

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('UNKNOWN_ACTION');
      expect(ai.trigger).not.toHaveBeenCalled();
      expect(ai.stopGeneration).not.toHaveBeenCalled();
      expect(ai.followUp).not.toHaveBeenCalled();
    });

    it('rejects follow-up without text parameter', async () => {
      const { deps, ai } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleAIIntent({
        action: 'follow-up',
        parameters: {},
      });

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('INVALID_PARAMETERS');
      expect(ai.followUp).not.toHaveBeenCalled();
    });
  });

  describe('Audio Intent Routing (Req 8.5, 8.10)', () => {
    it('routes toggle-system-audio to existing audio service', async () => {
      const { deps, audio } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleAudioIntent({ action: 'toggle-system-audio' });

      expect(result.success).toBe(true);
      expect(audio.toggleSystemAudio).toHaveBeenCalledOnce();
    });

    it('rejects unknown audio actions', async () => {
      const { deps, audio } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleAudioIntent({
        action: 'start-recording' as any,
      });

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('UNKNOWN_ACTION');
      expect(audio.toggleSystemAudio).not.toHaveBeenCalled();
    });
  });

  describe('Screen-Capture Intent Routing (Req 8.5, 8.10)', () => {
    it('routes use-screen to existing capture service', async () => {
      const { deps, screenCapture } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleScreenCaptureIntent({ action: 'use-screen' });

      expect(result.success).toBe(true);
      expect(screenCapture.useScreen).toHaveBeenCalledOnce();
    });

    it('rejects unknown screen-capture actions', async () => {
      const { deps, screenCapture } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleScreenCaptureIntent({
        action: 'capture-all-screens' as any,
      });

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('UNKNOWN_ACTION');
      expect(screenCapture.useScreen).not.toHaveBeenCalled();
    });
  });

  describe('Canonical State Ownership (Req 8.1, 8.8)', () => {
    it('does not update state when validation fails', async () => {
      const { deps, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      await adapter.handleOverlayIntent({ action: 'invalid-action' as any });

      // No snapshot or patch sent — state was not updated
      expect(sender.sendSnapshot).not.toHaveBeenCalled();
      expect(sender.sendPatch).not.toHaveBeenCalled();
    });

    it('does not update state when execution fails', async () => {
      const { deps, overlay, sender } = createMockDeps();
      overlay.toggleMode.mockRejectedValueOnce(new Error('service error'));
      const adapter = createIntentAdapter(deps);

      await adapter.handleOverlayIntent({ action: 'toggle-mode' });

      // No snapshot/patch sent on failure
      expect(sender.sendSnapshot).not.toHaveBeenCalled();
      expect(sender.sendPatch).not.toHaveBeenCalled();
    });

    it('projects state only after successful execution', async () => {
      const { deps, overlay, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      await adapter.handleOverlayIntent({ action: 'toggle-mode' });

      // State was projected (snapshot on first call since no previous state)
      expect(sender.sendSnapshot).toHaveBeenCalled();
      expect(overlay.toggleMode).toHaveBeenCalledOnce();
    });
  });

  describe('State Projection Safety (Req 8.6)', () => {
    it('projects snapshot without sensitive data', () => {
      const { deps, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      adapter.sendFullSnapshot();

      expect(sender.sendSnapshot).toHaveBeenCalledOnce();
      const projection = sender.sendSnapshot.mock.calls[0][0];
      expect(projection.render_state).not.toHaveProperty('apiKey');
      expect(projection.render_state).not.toHaveProperty('credential');
      expect(projection.render_state).not.toHaveProperty('rawAudio');
      expect(projection.render_state).not.toHaveProperty('screenshotBytes');
      expect(projection.render_state).not.toHaveProperty('filePath');
      expect(projection.render_state).not.toHaveProperty('databaseUrl');
      expect(projection.render_state).not.toHaveProperty('serviceHandle');
    });

    it('projects correct structure in snapshot', () => {
      const state = makeCanonicalState({
        visible: true,
        mode: OverlayMode.EXPANDED,
        isStreaming: true,
        streamingText: 'hello',
      });
      const { deps, sender } = createMockDeps(state);
      const adapter = createIntentAdapter(deps);

      adapter.sendFullSnapshot();

      const projection = sender.sendSnapshot.mock.calls[0][0];
      expect(projection.revision).toBe(1);
      expect(projection.visibility_requested).toBe(true);
      expect(projection.mode).toBe('expanded');
      expect(projection.render_state.isStreaming).toBe(true);
      expect(projection.render_state.streamingText).toBe('hello');
    });

    it('increments revision monotonically', () => {
      const { deps, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      adapter.sendFullSnapshot();
      adapter.sendFullSnapshot();
      adapter.sendFullSnapshot();

      expect(sender.sendSnapshot.mock.calls[0][0].revision).toBe(1);
      expect(sender.sendSnapshot.mock.calls[1][0].revision).toBe(2);
      expect(sender.sendSnapshot.mock.calls[2][0].revision).toBe(3);
    });
  });

  describe('AI Stream Routing (Req 8.9)', () => {
    it('forwards stream delta to sidecar', () => {
      const { deps, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      adapter.routeAiStreamDelta('stream-1', 'Hello', 1);

      expect(sender.sendAiStreamDelta).toHaveBeenCalledWith('stream-1', 'Hello', 1);
    });

    it('forwards stream completed to sidecar', () => {
      const { deps, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      adapter.routeAiStreamCompleted('stream-1', 42);

      expect(sender.sendAiStreamCompleted).toHaveBeenCalledWith('stream-1', 42);
    });

    it('forwards stream failed to sidecar', () => {
      const { deps, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      adapter.routeAiStreamFailed('stream-1', 'RATE_LIMIT');

      expect(sender.sendAiStreamFailed).toHaveBeenCalledWith('stream-1', 'RATE_LIMIT');
    });
  });

  describe('Operation Results (Req 8.9)', () => {
    it('sends operation result with unique id on success', async () => {
      const { deps, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({ action: 'toggle-mode' });

      expect(result.operation_id).toBeTruthy();
      expect(result.success).toBe(true);
      expect(sender.sendOperationResult).toHaveBeenCalledWith(result);
    });

    it('sends operation result with error code on failure', async () => {
      const { deps, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({ action: 'bad' as any });

      expect(result.operation_id).toBeTruthy();
      expect(result.success).toBe(false);
      expect(result.error_code).toBe('UNKNOWN_ACTION');
      expect(sender.sendOperationResult).toHaveBeenCalledWith(result);
    });

    it('generates unique operation ids across multiple intents', async () => {
      const { deps } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      const r1 = await adapter.handleOverlayIntent({ action: 'toggle-mode' });
      const r2 = await adapter.handleOverlayIntent({ action: 'toggle-visibility' });
      const r3 = await adapter.handleAIIntent({ action: 'trigger' });

      expect(r1.operation_id).not.toBe(r2.operation_id);
      expect(r2.operation_id).not.toBe(r3.operation_id);
    });
  });

  describe('No Duplicate Pipelines (Req 8.10)', () => {
    it('routes to same service delegate for repeated intents', async () => {
      const { deps, overlay } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      await adapter.handleOverlayIntent({ action: 'toggle-mode' });
      await adapter.handleOverlayIntent({ action: 'toggle-mode' });

      // Same delegate called twice — no new pipeline created
      expect(overlay.toggleMode).toHaveBeenCalledTimes(2);
    });

    it('does not create separate AI pipeline for sidecar', async () => {
      const { deps, ai } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      await adapter.handleAIIntent({ action: 'trigger', parameters: { query: 'test' } });

      // Only the existing AI delegate is called
      expect(ai.trigger).toHaveBeenCalledWith('test');
    });
  });

  describe('Projection Reset (reconnect)', () => {
    it('resets projection state for reconnect', () => {
      const { deps, sender } = createMockDeps();
      const adapter = createIntentAdapter(deps);

      // Build initial state
      adapter.sendFullSnapshot();
      expect(sender.sendSnapshot).toHaveBeenCalledOnce();

      // Reset
      adapter.resetProjection();

      // Next call must produce a full snapshot again
      adapter.sendFullSnapshot();
      // Revision continues monotonically even after reset
      expect(sender.sendSnapshot.mock.calls[1][0].revision).toBe(2);
    });
  });

  describe('Execution Failure Handling', () => {
    it('returns EXECUTION_FAILED when overlay service throws', async () => {
      const { deps, overlay, sender } = createMockDeps();
      overlay.stopSession.mockRejectedValueOnce(new Error('session not active'));
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleOverlayIntent({ action: 'stop-session' });

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('EXECUTION_FAILED');
      expect(sender.sendSnapshot).not.toHaveBeenCalled();
    });

    it('returns EXECUTION_FAILED when AI service throws', async () => {
      const { deps, ai } = createMockDeps();
      ai.trigger.mockRejectedValueOnce(new Error('provider error'));
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleAIIntent({ action: 'trigger' });

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('EXECUTION_FAILED');
    });

    it('returns EXECUTION_FAILED when audio service throws', async () => {
      const { deps, audio } = createMockDeps();
      audio.toggleSystemAudio.mockRejectedValueOnce(new Error('no device'));
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleAudioIntent({ action: 'toggle-system-audio' });

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('EXECUTION_FAILED');
    });

    it('returns EXECUTION_FAILED when screen capture throws', async () => {
      const { deps, screenCapture } = createMockDeps();
      screenCapture.useScreen.mockRejectedValueOnce(new Error('no permission'));
      const adapter = createIntentAdapter(deps);

      const result = await adapter.handleScreenCaptureIntent({ action: 'use-screen' });

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('EXECUTION_FAILED');
    });
  });
});
