/**
 * Stage C Bridge — Native Bridge Unit Tests
 *
 * Tests authoritative native revalidation, one-to-one method→IPC mapping,
 * and event→callback mapping.
 *
 * Requirements: 7.4–7.9, 7.15
 */

import { describe, it, expect } from 'vitest';
import {
  revalidatePageMessage,
  methodToIpcPayload,
  ipcToEventMessage,
  dispatchPageMessage,
  METHOD_TO_IPC_TYPE,
  IPC_TYPE_TO_EVENT,
  MAX_BRIDGE_REGIONS,
  MAX_ACTION_STRING_LENGTH,
  MAX_PARAMETERS_KEYS,
  EXPECTED_BRIDGE_VERSION,
} from '../../../stageC/bridge/nativeBridge';
import {
  BridgeMethodType,
  BridgeEventType,
} from '../../../stageC/protocol/bridge';
import {
  SidecarToControllerType,
  ControllerToSidecarType,
  MAX_BRIDGE_MESSAGE_BYTES,
} from '../../../stageC/protocol/schema';

// ────────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────────

function validOverlayActionMsg(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: EXPECTED_BRIDGE_VERSION,
    method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
    action: 'toggle-mode',
    ...overrides,
  });
}

function validAIMsg(): string {
  return JSON.stringify({
    version: EXPECTED_BRIDGE_VERSION,
    method: BridgeMethodType.REQUEST_AI,
    action: 'trigger',
    parameters: { query: 'hello' },
  });
}

function validAudioMsg(): string {
  return JSON.stringify({
    version: EXPECTED_BRIDGE_VERSION,
    method: BridgeMethodType.REQUEST_AUDIO,
    action: 'toggle-system-audio',
  });
}

function validScreenCaptureMsg(): string {
  return JSON.stringify({
    version: EXPECTED_BRIDGE_VERSION,
    method: BridgeMethodType.REQUEST_SCREEN_CAPTURE,
    action: 'use-screen',
  });
}

function validDragRegionsMsg(count = 2): string {
  const regions = Array.from({ length: count }, (_, i) => ({
    left: i * 10,
    top: 0,
    width: 10,
    height: 20,
  }));
  return JSON.stringify({
    version: EXPECTED_BRIDGE_VERSION,
    method: BridgeMethodType.REPORT_DRAG_REGIONS,
    revision: 1,
    regions,
  });
}

function validInteractiveRegionsMsg(): string {
  return JSON.stringify({
    version: EXPECTED_BRIDGE_VERSION,
    method: BridgeMethodType.REPORT_INTERACTIVE_REGIONS,
    revision: 5,
    regions: [{ left: 0, top: 0, width: 100, height: 50 }],
  });
}

// ────────────────────────────────────────────────────────────────────
// Revalidation Tests
// ────────────────────────────────────────────────────────────────────

describe('revalidatePageMessage', () => {
  describe('valid messages', () => {
    it('accepts a valid requestOverlayAction message', () => {
      const result = revalidatePageMessage(validOverlayActionMsg());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.method).toBe(BridgeMethodType.REQUEST_OVERLAY_ACTION);
        expect(result.value.action).toBe('toggle-mode');
      }
    });

    it('accepts a valid requestAI message', () => {
      const result = revalidatePageMessage(validAIMsg());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.method).toBe(BridgeMethodType.REQUEST_AI);
      }
    });

    it('accepts a valid requestAudio message', () => {
      const result = revalidatePageMessage(validAudioMsg());
      expect(result.ok).toBe(true);
    });

    it('accepts a valid requestScreenCapture message', () => {
      const result = revalidatePageMessage(validScreenCaptureMsg());
      expect(result.ok).toBe(true);
    });

    it('accepts valid reportDragRegions', () => {
      const result = revalidatePageMessage(validDragRegionsMsg());
      expect(result.ok).toBe(true);
    });

    it('accepts valid reportInteractiveRegions', () => {
      const result = revalidatePageMessage(validInteractiveRegionsMsg());
      expect(result.ok).toBe(true);
    });
  });

  describe('size rejection (Req 7.6)', () => {
    it('rejects messages exceeding MAX_BRIDGE_MESSAGE_BYTES', () => {
      const largeAction = 'x'.repeat(MAX_BRIDGE_MESSAGE_BYTES);
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
        action: largeAction,
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SIZE_EXCEEDED');
      }
    });
  });

  describe('version validation (Req 7.7)', () => {
    it('rejects missing version', () => {
      const msg = JSON.stringify({
        method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
        action: 'toggle-mode',
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_VERSION');
      }
    });

    it('rejects version = 0', () => {
      const result = revalidatePageMessage(validOverlayActionMsg({ version: 0 }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_VERSION');
      }
    });

    it('rejects incompatible version', () => {
      const result = revalidatePageMessage(validOverlayActionMsg({ version: 999 }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INCOMPATIBLE_VERSION');
      }
    });

    it('rejects non-integer version', () => {
      const result = revalidatePageMessage(validOverlayActionMsg({ version: 1.5 }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_VERSION');
      }
    });
  });

  describe('exact field validation (Req 7.7)', () => {
    it('rejects unknown fields', () => {
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
        action: 'toggle-mode',
        extraField: true,
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
    });

    it('rejects missing required fields', () => {
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
        // action is missing
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
    });

    it('rejects unknown method', () => {
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: 'unknownMethod',
        action: 'foo',
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
    });
  });

  describe('type validation (Req 7.7)', () => {
    it('rejects non-string action', () => {
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
        action: 123,
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
    });

    it('rejects non-array regions', () => {
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REPORT_DRAG_REGIONS,
        revision: 1,
        regions: 'not an array',
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
    });
  });

  describe('range and count validation (Req 7.7)', () => {
    it('rejects regions exceeding MAX_BRIDGE_REGIONS', () => {
      const result = revalidatePageMessage(validDragRegionsMsg(MAX_BRIDGE_REGIONS + 1));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('COUNT_EXCEEDED');
      }
    });

    it('rejects negative revision', () => {
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REPORT_DRAG_REGIONS,
        revision: -1,
        regions: [],
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
    });

    it('rejects region with negative width', () => {
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REPORT_DRAG_REGIONS,
        revision: 0,
        regions: [{ left: 0, top: 0, width: -10, height: 20 }],
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_RANGE');
      }
    });

    it('rejects region with out-of-bounds coordinates', () => {
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REPORT_DRAG_REGIONS,
        revision: 0,
        regions: [{ left: 40000, top: 0, width: 10, height: 20 }],
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_RANGE');
      }
    });

    it('rejects action exceeding MAX_ACTION_STRING_LENGTH', () => {
      const msg = JSON.stringify({
        version: EXPECTED_BRIDGE_VERSION,
        method: BridgeMethodType.REQUEST_OVERLAY_ACTION,
        action: 'x'.repeat(MAX_ACTION_STRING_LENGTH + 1),
      });
      const result = revalidatePageMessage(msg);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_RANGE');
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
      }
    });
  });

  describe('invalid JSON and non-object (Req 7.15 - untrusted)', () => {
    it('rejects invalid JSON', () => {
      const result = revalidatePageMessage('not json at all{{{');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_JSON');
      }
    });

    it('rejects array as message', () => {
      const result = revalidatePageMessage('[1,2,3]');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_TYPE');
      }
    });

    it('rejects null', () => {
      const result = revalidatePageMessage('null');
      expect(result.ok).toBe(false);
    });
  });

  describe('zero native side effects on failure (Req 7.9)', () => {
    it('returns typed error without throwing', () => {
      const badInputs = [
        '',
        'null',
        '{"version": 1}',
        '{"version": 1, "method": "evil"}',
        JSON.stringify({ version: 1, method: 'requestOverlayAction' }), // missing action
      ];

      for (const input of badInputs) {
        const result = revalidatePageMessage(input);
        // Should not throw, and should return error result
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toHaveProperty('code');
          expect(result.error).toHaveProperty('message');
        }
      }
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// Method → IPC Mapping Tests (Req 7.4)
// ────────────────────────────────────────────────────────────────────

describe('methodToIpcPayload', () => {
  it('maps requestOverlayAction to intent.overlay', () => {
    const msg = JSON.parse(validOverlayActionMsg());
    const result = methodToIpcPayload(msg);
    expect(result.type).toBe(SidecarToControllerType.INTENT_OVERLAY);
    expect(result.payload).toEqual({ action: 'toggle-mode', parameters: undefined });
  });

  it('maps requestAI to intent.ai', () => {
    const msg = JSON.parse(validAIMsg());
    const result = methodToIpcPayload(msg);
    expect(result.type).toBe(SidecarToControllerType.INTENT_AI);
    expect(result.payload).toEqual({ action: 'trigger', parameters: { query: 'hello' } });
  });

  it('maps requestAudio to intent.audio', () => {
    const msg = JSON.parse(validAudioMsg());
    const result = methodToIpcPayload(msg);
    expect(result.type).toBe(SidecarToControllerType.INTENT_AUDIO);
    expect(result.payload).toEqual({ action: 'toggle-system-audio', parameters: undefined });
  });

  it('maps requestScreenCapture to intent.screenCapture', () => {
    const msg = JSON.parse(validScreenCaptureMsg());
    const result = methodToIpcPayload(msg);
    expect(result.type).toBe(SidecarToControllerType.INTENT_SCREEN_CAPTURE);
    expect(result.payload).toEqual({ action: 'use-screen', parameters: undefined });
  });

  it('maps reportDragRegions to surface.boundsChanged with type=drag', () => {
    const msg = JSON.parse(validDragRegionsMsg());
    const result = methodToIpcPayload(msg);
    expect(result.type).toBe(SidecarToControllerType.SURFACE_BOUNDS_CHANGED);
    expect((result.payload as any).type).toBe('drag');
    expect((result.payload as any).revision).toBe(1);
    expect((result.payload as any).regions).toHaveLength(2);
  });

  it('maps reportInteractiveRegions to surface.boundsChanged with type=interactive', () => {
    const msg = JSON.parse(validInteractiveRegionsMsg());
    const result = methodToIpcPayload(msg);
    expect(result.type).toBe(SidecarToControllerType.SURFACE_BOUNDS_CHANGED);
    expect((result.payload as any).type).toBe('interactive');
    expect((result.payload as any).revision).toBe(5);
  });

  it('provides one-to-one coverage for all 6 bridge methods', () => {
    const allMethods = Object.values(BridgeMethodType);
    expect(allMethods).toHaveLength(6);
    for (const method of allMethods) {
      expect(METHOD_TO_IPC_TYPE[method]).toBeDefined();
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Event → Bridge Callback Mapping Tests
// ────────────────────────────────────────────────────────────────────

describe('ipcToEventMessage', () => {
  it('maps state.snapshot to onStateSnapshot', () => {
    const result = ipcToEventMessage(ControllerToSidecarType.STATE_SNAPSHOT, {
      revision: 3,
      visibility_requested: true,
      bounds_dip: { left: 0, top: 0, width: 400, height: 200 },
      mode: 'compact',
      capture_protection: false,
      render_state: { visible: true, mode: 'compact' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.event).toBe(BridgeEventType.ON_STATE_SNAPSHOT);
      expect((result.value as any).revision).toBe(3);
      expect((result.value as any).state).toEqual({ visible: true, mode: 'compact' });
    }
  });

  it('maps state.patch to onStatePatch', () => {
    const result = ipcToEventMessage(ControllerToSidecarType.STATE_PATCH, {
      base_revision: 3,
      next_revision: 4,
      render_state_patch: { isLoading: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.event).toBe(BridgeEventType.ON_STATE_PATCH);
      expect((result.value as any).base_revision).toBe(3);
      expect((result.value as any).next_revision).toBe(4);
      expect((result.value as any).patch).toEqual({ isLoading: true });
    }
  });

  it('maps operation.result to onOperationResult', () => {
    const result = ipcToEventMessage(ControllerToSidecarType.OPERATION_RESULT, {
      operation_id: 'op-123',
      success: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.event).toBe(BridgeEventType.ON_OPERATION_RESULT);
      expect((result.value as any).operation_id).toBe('op-123');
      expect((result.value as any).success).toBe(true);
    }
  });

  it('maps operation.result with error_code and data', () => {
    const result = ipcToEventMessage(ControllerToSidecarType.OPERATION_RESULT, {
      operation_id: 'op-456',
      success: false,
      error_code: 'AI_UNAVAILABLE',
      data: { reason: 'timeout' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as any).error_code).toBe('AI_UNAVAILABLE');
      expect((result.value as any).data).toEqual({ reason: 'timeout' });
    }
  });

  it('returns error for unmapped IPC types', () => {
    const result = ipcToEventMessage(ControllerToSidecarType.LIFECYCLE_SHUTDOWN, {
      reason: 'quit',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNMAPPED_EVENT');
    }
  });

  it('provides one-to-one coverage for all 3 bridge events', () => {
    const mappedEvents = Object.values(IPC_TYPE_TO_EVENT);
    expect(mappedEvents).toHaveLength(3);
    expect(mappedEvents).toContain(BridgeEventType.ON_STATE_SNAPSHOT);
    expect(mappedEvents).toContain(BridgeEventType.ON_STATE_PATCH);
    expect(mappedEvents).toContain(BridgeEventType.ON_OPERATION_RESULT);
  });
});

// ────────────────────────────────────────────────────────────────────
// Full Dispatch Tests
// ────────────────────────────────────────────────────────────────────

describe('dispatchPageMessage', () => {
  it('revalidates and maps a valid message', () => {
    const result = dispatchPageMessage(validOverlayActionMsg());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ipcType).toBe(SidecarToControllerType.INTENT_OVERLAY);
      expect(result.value.payload).toEqual({ action: 'toggle-mode', parameters: undefined });
    }
  });

  it('returns error for invalid messages without side effects', () => {
    const result = dispatchPageMessage('invalid');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_JSON');
    }
  });
});
