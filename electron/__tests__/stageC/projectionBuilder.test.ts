/**
 * Stage C — Projection Builder Tests
 *
 * Verifies that the projection builder:
 * - Builds safe OverlayProjection snapshots (redacting sensitive data)
 * - Computes incremental patches between revisions
 * - Monotonically increments revision numbers
 * - Never includes credentials, raw audio, screenshots, paths, handles, or DB values
 *
 * Requirements: 8.1–8.6, 8.9
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ProjectionBuilder,
  buildSafeRenderState,
  isRenderStateSafe,
  type CanonicalOverlayState,
} from '../../stageC/projectionBuilder';
import { OverlayMode } from '../../stageC/protocol/schema';

// ────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────

function makeState(overrides?: Partial<CanonicalOverlayState>): CanonicalOverlayState {
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

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('ProjectionBuilder', () => {
  let builder: ProjectionBuilder;

  beforeEach(() => {
    builder = new ProjectionBuilder();
  });

  describe('buildSnapshot', () => {
    it('builds a complete snapshot from canonical state', () => {
      const state = makeState({ visible: true, mode: OverlayMode.EXPANDED });
      const snapshot = builder.buildSnapshot(state);

      expect(snapshot.revision).toBe(1);
      expect(snapshot.visibility_requested).toBe(true);
      expect(snapshot.mode).toBe('expanded');
      expect(snapshot.bounds_dip).toEqual({ left: 100, top: 50, width: 400, height: 300 });
      expect(snapshot.capture_protection).toBe(true);
      expect(snapshot.render_state).toBeDefined();
    });

    it('increments revision monotonically on each snapshot', () => {
      const state = makeState();

      const s1 = builder.buildSnapshot(state);
      const s2 = builder.buildSnapshot(state);
      const s3 = builder.buildSnapshot(state);

      expect(s1.revision).toBe(1);
      expect(s2.revision).toBe(2);
      expect(s3.revision).toBe(3);
    });

    it('includes safe render state fields in snapshot', () => {
      const state = makeState({
        isStreaming: true,
        streamingText: 'Generating response...',
        isLoading: false,
        isSystemAudioActive: true,
        inputText: 'hello',
        elapsedTime: 42,
      });

      const snapshot = builder.buildSnapshot(state);

      expect(snapshot.render_state.isStreaming).toBe(true);
      expect(snapshot.render_state.streamingText).toBe('Generating response...');
      expect(snapshot.render_state.isLoading).toBe(false);
      expect(snapshot.render_state.isSystemAudioActive).toBe(true);
      expect(snapshot.render_state.inputText).toBe('hello');
      expect(snapshot.render_state.elapsedTime).toBe(42);
    });

    it('includes AI response in snapshot when present', () => {
      const state = makeState({
        aiResponse: {
          text: 'Here is the answer.',
          suggestions: ['Do this', 'Try that'],
          followUps: ['Tell me more'],
        },
      });

      const snapshot = builder.buildSnapshot(state);

      expect(snapshot.render_state.aiResponse).toEqual({
        text: 'Here is the answer.',
        suggestions: ['Do this', 'Try that'],
        followUps: ['Tell me more'],
      });
    });

    it('sets aiResponse to null when none', () => {
      const state = makeState({ aiResponse: null });
      const snapshot = builder.buildSnapshot(state);

      expect(snapshot.render_state.aiResponse).toBeNull();
    });
  });

  describe('buildPatch', () => {
    it('returns null when no previous state exists', () => {
      const state = makeState();
      const patch = builder.buildPatch(state);

      expect(patch).toBeNull();
    });

    it('returns null when nothing changed', () => {
      const state = makeState();
      builder.buildSnapshot(state);
      const patch = builder.buildPatch(state);

      expect(patch).toBeNull();
    });

    it('detects visibility change', () => {
      const state1 = makeState({ visible: true });
      builder.buildSnapshot(state1);

      const state2 = makeState({ visible: false });
      const patch = builder.buildPatch(state2);

      expect(patch).not.toBeNull();
      expect(patch!.base_revision).toBe(1);
      expect(patch!.next_revision).toBe(2);
      expect(patch!.visibility_requested).toBe(false);
    });

    it('detects mode change', () => {
      const state1 = makeState({ mode: OverlayMode.COMPACT });
      builder.buildSnapshot(state1);

      const state2 = makeState({ mode: OverlayMode.MAXIMIZED });
      const patch = builder.buildPatch(state2);

      expect(patch).not.toBeNull();
      expect(patch!.mode).toBe('maximized');
    });

    it('detects bounds change', () => {
      const state1 = makeState();
      builder.buildSnapshot(state1);

      const state2 = makeState({
        bounds_dip: { left: 200, top: 100, width: 500, height: 400 },
      });
      const patch = builder.buildPatch(state2);

      expect(patch).not.toBeNull();
      expect(patch!.bounds_dip).toEqual({ left: 200, top: 100, width: 500, height: 400 });
    });

    it('detects capture_protection change', () => {
      const state1 = makeState({ capture_protection: true });
      builder.buildSnapshot(state1);

      const state2 = makeState({ capture_protection: false });
      const patch = builder.buildPatch(state2);

      expect(patch).not.toBeNull();
      expect(patch!.capture_protection).toBe(false);
    });

    it('detects render state changes', () => {
      const state1 = makeState({ isStreaming: false, streamingText: '' });
      builder.buildSnapshot(state1);

      const state2 = makeState({ isStreaming: true, streamingText: 'partial' });
      const patch = builder.buildPatch(state2);

      expect(patch).not.toBeNull();
      expect(patch!.render_state_patch).toBeDefined();
      expect(patch!.render_state_patch!.isStreaming).toBe(true);
      expect(patch!.render_state_patch!.streamingText).toBe('partial');
    });

    it('increments revision on each patch', () => {
      builder.buildSnapshot(makeState({ inputText: 'a' }));
      const p1 = builder.buildPatch(makeState({ inputText: 'b' }));
      const p2 = builder.buildPatch(makeState({ inputText: 'c' }));

      expect(p1!.base_revision).toBe(1);
      expect(p1!.next_revision).toBe(2);
      expect(p2!.base_revision).toBe(2);
      expect(p2!.next_revision).toBe(3);
    });
  });

  describe('reset', () => {
    it('forces full snapshot after reset (no patch)', () => {
      const state = makeState();
      builder.buildSnapshot(state);
      builder.reset();

      const patch = builder.buildPatch(makeState({ inputText: 'changed' }));
      // After reset, buildPatch returns null because there's no previous state
      expect(patch).toBeNull();
    });

    it('continues monotonic revision after reset', () => {
      builder.buildSnapshot(makeState());
      builder.buildSnapshot(makeState());
      // Revision is 2 here
      builder.reset();
      const snapshot = builder.buildSnapshot(makeState());
      // Revision continues from 2 → 3
      expect(snapshot.revision).toBe(3);
    });
  });

  describe('Sensitive Data Redaction (Req 8.6)', () => {
    it('buildSafeRenderState excludes sensitive fields by design', () => {
      const state = makeState();
      const renderState = buildSafeRenderState(state);

      // These fields should never appear in a safe render state
      expect(renderState).not.toHaveProperty('apiKey');
      expect(renderState).not.toHaveProperty('credential');
      expect(renderState).not.toHaveProperty('rawAudio');
      expect(renderState).not.toHaveProperty('screenshotBytes');
      expect(renderState).not.toHaveProperty('filePath');
      expect(renderState).not.toHaveProperty('databaseUrl');
      expect(renderState).not.toHaveProperty('serviceHandle');
      expect(renderState).not.toHaveProperty('password');
      expect(renderState).not.toHaveProperty('token');
    });

    it('isRenderStateSafe detects redacted keys', () => {
      expect(isRenderStateSafe({ visible: true, mode: 'compact' })).toBe(true);
      expect(isRenderStateSafe({ apiKey: 'sk-xxx' })).toBe(false);
      expect(isRenderStateSafe({ credential: 'secret' })).toBe(false);
      expect(isRenderStateSafe({ rawAudio: Buffer.from([]) })).toBe(false);
      expect(isRenderStateSafe({ screenshotBytes: 'data' })).toBe(false);
      expect(isRenderStateSafe({ filePath: '/etc/secrets' })).toBe(false);
      expect(isRenderStateSafe({ databaseUrl: 'postgres://...' })).toBe(false);
      expect(isRenderStateSafe({ serviceHandle: 42 })).toBe(false);
    });

    it('isRenderStateSafe detects nested redacted keys', () => {
      expect(isRenderStateSafe({ data: { nested: { apiKey: 'x' } } })).toBe(false);
      expect(isRenderStateSafe({ arr: [{ token: 'y' }] })).toBe(false);
    });

    it('isRenderStateSafe passes safe nested objects', () => {
      expect(isRenderStateSafe({
        data: { nested: { value: 42 } },
        list: [1, 2, 3],
      })).toBe(true);
    });
  });

  describe('Projection does not contain raw media or paths', () => {
    it('snapshot render_state has only reviewed fields', () => {
      const state = makeState({
        isStreaming: true,
        streamingText: 'AI says...',
        aiResponse: { text: 'done', suggestions: ['a'], followUps: ['b'] },
      });

      const snapshot = builder.buildSnapshot(state);
      const keys = Object.keys(snapshot.render_state);

      // Only these fields should exist in a projection
      const allowedKeys = new Set([
        'visible', 'mode', 'captureProtection',
        'isSystemAudioActive', 'isLoading', 'isStreaming',
        'streamingText', 'inputText', 'elapsedTime', 'aiResponse',
      ]);

      for (const key of keys) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    });
  });
});
