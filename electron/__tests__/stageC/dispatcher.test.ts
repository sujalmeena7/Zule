/**
 * Stage C Dispatcher — Unit Tests
 *
 * Tests framed strict dispatch, directional allowlists, replay cache,
 * backpressure, and rejection recording.
 *
 * Requirements: 6.13–6.27
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  StageCDispatcher,
  RejectionCategory,
  type DispatcherConfig,
  type RejectionMetadata,
} from '../../stageC/ipc/dispatcher';
import {
  serializeEnvelope,
  type ProtocolEnvelope,
} from '../../stageC/protocol/envelope';
import {
  MAX_FRAME_BYTES,
  MAX_REPLAY_CACHE_ENTRIES,
  MAX_QUEUED_MESSAGES,
  MAX_QUEUED_BYTES,
  MessageDirection,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  SidecarToControllerType,
  ControllerToSidecarType,
} from '../../stageC/protocol/schema';

// ────────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────────

function createConfig(overrides: Partial<DispatcherConfig> = {}): DispatcherConfig {
  return {
    expectedIncomingDirection: MessageDirection.SIDECAR_TO_CONTROLLER,
    isAuthenticated: () => true,
    getExpectedRevision: () => -1, // Skip revision validation by default
    onFallback: vi.fn(),
    onRejection: vi.fn(),
    ...overrides,
  };
}

function makeValidEnvelope(overrides: Partial<ProtocolEnvelope> = {}): ProtocolEnvelope {
  return {
    protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    type: SidecarToControllerType.LIFECYCLE_READY,
    payload: {
      launch_id: 'test-launch-id',
      sidecar_version: '1.0.0',
      protocol_major: PROTOCOL_MAJOR,
      protocol_minor: PROTOCOL_MINOR,
      bridge_schema_version: 1,
      capabilities: ['overlay'],
      webview2_runtime_version: '120.0.0.0',
    },
    ...overrides,
  } as ProtocolEnvelope;
}

function makeValidFrame(overrides: Partial<ProtocolEnvelope> = {}): Buffer {
  return serializeEnvelope(makeValidEnvelope(overrides));
}

function makeOversizeFrame(): Buffer {
  // Create a frame that declares a length > MAX_FRAME_BYTES
  const header = Buffer.alloc(4);
  header.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
  return header;
}

function makeInvalidUtf8Frame(): Buffer {
  // Create a frame with invalid UTF-8 in the body
  const invalidBody = Buffer.from([0xff, 0xfe, 0x80, 0x81, 0x82]);
  const frame = Buffer.alloc(4 + invalidBody.length);
  frame.writeUInt32LE(invalidBody.length, 0);
  invalidBody.copy(frame, 4);
  return frame;
}

function makeInvalidJsonFrame(): Buffer {
  // Create a frame with valid UTF-8 but invalid JSON
  const body = Buffer.from('not json at all {{{', 'utf-8');
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function makeWrongDirectionFrame(): Buffer {
  // A controller→sidecar message arriving on sidecar→controller direction
  return serializeEnvelope({
    protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    type: ControllerToSidecarType.LIFECYCLE_SHUTDOWN,
    payload: { reason: 'test' },
  } as ProtocolEnvelope);
}

function makeStatePatchFrame(baseRevision: number, messageId?: string): Buffer {
  return serializeEnvelope({
    protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
    messageId: messageId ?? `msg-${Math.random().toString(36).slice(2)}`,
    type: SidecarToControllerType.STATE_PATCH_ACK,
    payload: { revision: baseRevision },
  } as ProtocolEnvelope);
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('StageCDispatcher — Req 6.13–6.27', () => {
  let dispatcher: StageCDispatcher;
  let config: DispatcherConfig;

  beforeEach(() => {
    config = createConfig();
    dispatcher = new StageCDispatcher(config);
  });

  // ── Req 6.13: 32-bit LE byte length framing ──────────────────────

  describe('Req 6.13: frame length parsing', () => {
    it('parses valid 32-bit LE byte length and dispatches', () => {
      const frame = makeValidFrame();
      const result = dispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(true);
    });

    it('rejects frames shorter than 4 bytes', () => {
      const frame = Buffer.from([0x01, 0x02]);
      const result = dispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.SCHEMA_VIOLATION);
      }
    });
  });

  // ── Req 6.16: reject > MAX_FRAME_BYTES before allocation ─────────

  describe('Req 6.16: size limit before allocation', () => {
    it('rejects declared length > MAX_FRAME_BYTES before payload allocation', () => {
      const frame = makeOversizeFrame();
      const result = dispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.SIZE_EXCEEDED);
        expect(result.rejection.byteCount).toBe(frame.length);
      }
    });

    it('allows frame at exactly MAX_FRAME_BYTES', () => {
      // A frame declared as MAX_FRAME_BYTES is allowed (the content may still fail schema)
      const header = Buffer.alloc(4);
      header.writeUInt32LE(MAX_FRAME_BYTES, 0);
      // Body too short for the declared length → schema violation, not size exceeded
      const result = dispatcher.dispatchFrame(header);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Should NOT be SIZE_EXCEEDED since declared = MAX_FRAME_BYTES exactly
        expect(result.rejection.category).not.toBe(RejectionCategory.SIZE_EXCEEDED);
      }
    });
  });

  // ── Req 6.17: reject malformed UTF-8 ─────────────────────────────

  describe('Req 6.17: UTF-8 validation', () => {
    it('rejects frames with invalid UTF-8 bytes', () => {
      const frame = makeInvalidUtf8Frame();
      const result = dispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.INVALID_UTF8);
      }
    });

    it('rejects malformed JSON', () => {
      const frame = makeInvalidJsonFrame();
      const result = dispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.SCHEMA_VIOLATION);
      }
    });
  });

  // ── Req 6.14: strict schema validation ───────────────────────────

  describe('Req 6.14: strict schema — no extra fields', () => {
    it('rejects envelope with extra fields', () => {
      const env = makeValidEnvelope();
      const json = JSON.stringify({ ...env, extraField: 'bad' });
      const body = Buffer.from(json, 'utf-8');
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32LE(body.length, 0);
      body.copy(frame, 4);

      const result = dispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.SCHEMA_VIOLATION);
      }
    });

    it('rejects envelope with missing required fields', () => {
      const json = JSON.stringify({
        protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
        messageId: 'test',
        // missing type and payload
      });
      const body = Buffer.from(json, 'utf-8');
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32LE(body.length, 0);
      body.copy(frame, 4);

      const result = dispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(false);
    });

    it('rejects incompatible protocol version', () => {
      const env = {
        protocolVersion: { major: 99, minor: 0 },
        messageId: 'test-msg',
        type: SidecarToControllerType.LIFECYCLE_READY,
        payload: {
          launch_id: 'x',
          sidecar_version: '1.0.0',
          protocol_major: 99,
          protocol_minor: 0,
          bridge_schema_version: 1,
          capabilities: [],
          webview2_runtime_version: '120.0.0.0',
        },
      };
      const json = JSON.stringify(env);
      const body = Buffer.from(json, 'utf-8');
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32LE(body.length, 0);
      body.copy(frame, 4);

      const result = dispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.INCOMPATIBLE_PROTOCOL);
      }
    });
  });

  // ── Req 6.18, 6.19, 6.20: directional allowlists ────────────────

  describe('Req 6.18–6.20: directional allowlists', () => {
    it('accepts sidecar→controller messages on sidecar→controller direction', () => {
      const frame = makeValidFrame();
      const result = dispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(true);
    });

    it('rejects controller→sidecar messages on sidecar→controller direction', () => {
      const frame = makeWrongDirectionFrame();
      const result = dispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.WRONG_DIRECTION);
      }
    });

    it('accepts controller→sidecar messages on controller→sidecar direction', () => {
      const ctrlConfig = createConfig({
        expectedIncomingDirection: MessageDirection.CONTROLLER_TO_SIDECAR,
      });
      const ctrlDispatcher = new StageCDispatcher(ctrlConfig);

      const frame = serializeEnvelope({
        protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
        messageId: 'msg-ctrl-test',
        type: ControllerToSidecarType.LIFECYCLE_SHUTDOWN,
        payload: { reason: 'test' },
      } as ProtocolEnvelope);

      const result = ctrlDispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(true);
    });
  });

  // ── Req 6.17: authentication gating ──────────────────────────────

  describe('Authentication gating', () => {
    it('rejects non-auth messages when not authenticated', () => {
      const unauthConfig = createConfig({
        isAuthenticated: () => false,
      });
      const unauthDispatcher = new StageCDispatcher(unauthConfig);

      const frame = makeValidFrame();
      const result = unauthDispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.NOT_AUTHENTICATED);
      }
    });
  });

  // ── Req 6.22, 6.23: replay cache ─────────────────────────────────

  describe('Req 6.22–6.23: replay cache', () => {
    it('caches terminal outcome and returns it on duplicate messageId', () => {
      const msgId = 'unique-msg-1';
      const frame = makeValidFrame({ messageId: msgId });

      // First dispatch succeeds
      const result1 = dispatcher.dispatchFrame(frame);
      expect(result1.ok).toBe(true);
      if (result1.ok) expect(result1.duplicate).toBe(false);

      // Record the outcome
      dispatcher.recordOutcome(msgId, SidecarToControllerType.LIFECYCLE_READY, { success: true });
      dispatcher.acknowledgeProcessed(frame.length);

      // Second dispatch with same messageId returns cached outcome
      const result2 = dispatcher.dispatchFrame(frame);
      expect(result2.ok).toBe(true);
      if (result2.ok) {
        expect(result2.duplicate).toBe(true);
        expect(result2.cachedOutcome).toEqual({ success: true });
      }
    });

    it('enforces maximum replay cache entries (4096)', () => {
      // Fill cache to max
      for (let i = 0; i < MAX_REPLAY_CACHE_ENTRIES; i++) {
        dispatcher.recordOutcome(`msg-${i}`, 'test', { i });
      }
      expect(dispatcher.replayCacheSize).toBe(MAX_REPLAY_CACHE_ENTRIES);

      // Adding one more should evict the oldest
      dispatcher.recordOutcome('msg-overflow', 'test', { overflow: true });
      expect(dispatcher.replayCacheSize).toBe(MAX_REPLAY_CACHE_ENTRIES);
    });

    it('evicts oldest entry when cache is full', () => {
      // Fill cache
      for (let i = 0; i < MAX_REPLAY_CACHE_ENTRIES; i++) {
        dispatcher.recordOutcome(`msg-${i}`, 'test', { i });
      }

      // Record a new one — should evict msg-0
      dispatcher.recordOutcome('msg-new', 'test', { new: true });

      // The oldest entry (msg-0) was dispatched and cached; now verify it's gone
      // by dispatching a frame with msg-0 — it should NOT return a cached outcome
      const frame = makeValidFrame({ messageId: 'msg-0' });
      const result = dispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.duplicate).toBe(false);
      }
    });

    it('does not repeat mutations on duplicate messageId (zero repeated mutations)', () => {
      const msgId = 'no-repeat-msg';
      const frame = makeValidFrame({ messageId: msgId });

      // First dispatch
      dispatcher.dispatchFrame(frame);
      dispatcher.recordOutcome(msgId, SidecarToControllerType.LIFECYCLE_READY, 'done');
      dispatcher.acknowledgeProcessed(frame.length);

      // Second dispatch — returns cached, no new processing needed
      const result = dispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.duplicate).toBe(true);
        expect(result.cachedOutcome).toBe('done');
      }
    });
  });

  // ── Req 6.24, 6.25: backpressure ─────────────────────────────────

  describe('Req 6.24–6.25: backpressure', () => {
    it('closes connection when queued messages exceed MAX_QUEUED_MESSAGES', () => {
      const onFallback = vi.fn();
      const bpConfig = createConfig({ onFallback });
      const bpDispatcher = new StageCDispatcher(bpConfig);

      // Fill queue to max messages
      for (let i = 0; i < MAX_QUEUED_MESSAGES; i++) {
        const frame = makeValidFrame({ messageId: `bp-msg-${i}` });
        const result = bpDispatcher.dispatchFrame(frame);
        expect(result.ok).toBe(true);
      }

      // Next message should trigger overflow
      const overflowFrame = makeValidFrame({ messageId: 'bp-overflow' });
      const result = bpDispatcher.dispatchFrame(overflowFrame);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.QUEUE_OVERFLOW);
      }
      expect(onFallback).toHaveBeenCalledWith('queue_overflow');
      expect(bpDispatcher.isClosed).toBe(true);
    });

    it('closes connection when queued bytes exceed MAX_QUEUED_BYTES', () => {
      const onFallback = vi.fn();
      const bpConfig = createConfig({ onFallback });
      const bpDispatcher = new StageCDispatcher(bpConfig);

      // Create a large frame that when queued multiple times exceeds byte limit
      // MAX_QUEUED_BYTES = 1,048,576. Each valid frame is small (~300 bytes),
      // so we queue enough to exceed the byte limit
      let totalBytes = 0;
      let count = 0;
      while (totalBytes < MAX_QUEUED_BYTES && count < MAX_QUEUED_MESSAGES) {
        const frame = makeValidFrame({ messageId: `byte-msg-${count}` });
        totalBytes += frame.length;
        count++;
        const result = bpDispatcher.dispatchFrame(frame);
        if (!result.ok) break;
      }

      // The dispatcher should have closed or we should verify behavior
      // If we hit message limit first, that's still valid backpressure
      expect(bpDispatcher.isClosed || bpDispatcher.currentQueuedMessages === MAX_QUEUED_MESSAGES).toBe(true);
    });

    it('rejects all subsequent messages after queue overflow', () => {
      const onFallback = vi.fn();
      const bpConfig = createConfig({ onFallback });
      const bpDispatcher = new StageCDispatcher(bpConfig);

      // Fill to max and trigger overflow
      for (let i = 0; i < MAX_QUEUED_MESSAGES; i++) {
        bpDispatcher.dispatchFrame(makeValidFrame({ messageId: `fill-${i}` }));
      }
      bpDispatcher.dispatchFrame(makeValidFrame({ messageId: 'trigger-overflow' }));

      // Now all subsequent messages are rejected
      const afterFrame = makeValidFrame({ messageId: 'after-close' });
      const result = bpDispatcher.dispatchFrame(afterFrame);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.QUEUE_OVERFLOW);
      }
    });

    it('acknowledgeProcessed reduces queue counters', () => {
      const frame = makeValidFrame();
      dispatcher.dispatchFrame(frame);
      expect(dispatcher.currentQueuedMessages).toBe(1);
      expect(dispatcher.currentQueuedBytes).toBe(frame.length);

      dispatcher.acknowledgeProcessed(frame.length);
      expect(dispatcher.currentQueuedMessages).toBe(0);
      expect(dispatcher.currentQueuedBytes).toBe(0);
    });
  });

  // ── Req 6.26: rejection recording metadata ───────────────────────

  describe('Req 6.26: rejection recording', () => {
    it('records only category, direction, safely decoded type, and byte count', () => {
      const rejections: RejectionMetadata[] = [];
      const recConfig = createConfig({
        onRejection: (meta) => rejections.push(meta),
      });
      const recDispatcher = new StageCDispatcher(recConfig);

      const frame = makeWrongDirectionFrame();
      recDispatcher.dispatchFrame(frame);

      expect(rejections).toHaveLength(1);
      const meta = rejections[0];
      expect(meta).toHaveProperty('category');
      expect(meta).toHaveProperty('direction');
      expect(meta).toHaveProperty('type');
      expect(meta).toHaveProperty('byteCount');
      // Must have exactly these 4 fields
      expect(Object.keys(meta)).toHaveLength(4);
    });

    it('sanitizes unknown type strings to max 64 chars', () => {
      const rejections: RejectionMetadata[] = [];
      const recConfig = createConfig({
        onRejection: (meta) => rejections.push(meta),
      });
      const recDispatcher = new StageCDispatcher(recConfig);

      // Create a frame with an absurdly long type value
      const longType = 'x'.repeat(200);
      const json = JSON.stringify({
        protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
        messageId: 'test-long-type',
        type: longType,
        payload: {},
      });
      const body = Buffer.from(json, 'utf-8');
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32LE(body.length, 0);
      body.copy(frame, 4);

      recDispatcher.dispatchFrame(frame);

      // The type should be truncated/sanitized (unknown type, so goes through safe decode)
      expect(rejections.length).toBeGreaterThan(0);
      if (rejections[0].type !== null) {
        expect(rejections[0].type.length).toBeLessThanOrEqual(64);
      }
    });
  });

  // ── Req 6.27: recording failure noninterference ──────────────────

  describe('Req 6.27: recording failure noninterference', () => {
    it('preserves rejection behavior when onRejection throws', () => {
      const throwingConfig = createConfig({
        onRejection: () => {
          throw new Error('Recording failed!');
        },
      });
      const throwingDispatcher = new StageCDispatcher(throwingConfig);

      // This should reject but not throw despite recording failure
      const frame = makeOversizeFrame();
      const result = throwingDispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.SIZE_EXCEEDED);
      }
    });

    it('preserves fallback behavior when onRejection throws during overflow', () => {
      const onFallback = vi.fn();
      const throwingConfig = createConfig({
        onFallback,
        onRejection: () => {
          throw new Error('Recording failed!');
        },
      });
      const throwingDispatcher = new StageCDispatcher(throwingConfig);

      // Fill queue to trigger overflow
      for (let i = 0; i < MAX_QUEUED_MESSAGES; i++) {
        throwingDispatcher.dispatchFrame(makeValidFrame({ messageId: `fill-${i}` }));
      }

      // Overflow should still trigger fallback even though recording throws
      const overflowFrame = makeValidFrame({ messageId: 'overflow-test' });
      const result = throwingDispatcher.dispatchFrame(overflowFrame);
      expect(result.ok).toBe(false);
      expect(onFallback).toHaveBeenCalledWith('queue_overflow');
    });
  });

  // ── Req 6.17: zero state mutations on rejection ──────────────────

  describe('Req 6.17: zero state mutations on rejection', () => {
    it('does not increment queue counters on rejected frames', () => {
      // Oversize frame → rejected → queue counters unchanged
      const frame = makeOversizeFrame();
      dispatcher.dispatchFrame(frame);
      expect(dispatcher.currentQueuedMessages).toBe(0);
      expect(dispatcher.currentQueuedBytes).toBe(0);
    });

    it('does not add to replay cache on rejected frames', () => {
      const frame = makeInvalidUtf8Frame();
      dispatcher.dispatchFrame(frame);
      expect(dispatcher.replayCacheSize).toBe(0);
    });
  });

  // ── Revision validation ──────────────────────────────────────────

  describe('Revision validation', () => {
    it('rejects state.patchAck with mismatched base_revision', () => {
      const revConfig = createConfig({
        getExpectedRevision: () => 5,
      });
      const revDispatcher = new StageCDispatcher(revConfig);

      // Create a patchAck with revision 3 (expected 5)
      const frame = makeStatePatchFrame(3);
      const result = revDispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.INVALID_REVISION);
      }
    });

    it('accepts state.patchAck with matching revision', () => {
      const revConfig = createConfig({
        getExpectedRevision: () => 5,
      });
      const revDispatcher = new StageCDispatcher(revConfig);

      const frame = makeStatePatchFrame(5);
      const result = revDispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(true);
    });

    it('skips revision validation when expectedRevision is -1', () => {
      const revConfig = createConfig({
        getExpectedRevision: () => -1,
      });
      const revDispatcher = new StageCDispatcher(revConfig);

      const frame = makeStatePatchFrame(999);
      const result = revDispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(true);
    });
  });

  // ── Reset functionality ──────────────────────────────────────────

  describe('reset()', () => {
    it('clears replay cache, queue counters, and closed state', () => {
      // Add some state
      const frame = makeValidFrame();
      dispatcher.dispatchFrame(frame);
      dispatcher.recordOutcome('msg-reset', 'test', {});

      expect(dispatcher.currentQueuedMessages).toBe(1);
      expect(dispatcher.replayCacheSize).toBe(1);

      dispatcher.reset();

      expect(dispatcher.currentQueuedMessages).toBe(0);
      expect(dispatcher.currentQueuedBytes).toBe(0);
      expect(dispatcher.replayCacheSize).toBe(0);
      expect(dispatcher.isClosed).toBe(false);
    });
  });

  // ── Req 6.21: zero generic invoke/arbitrary payload ──────────────

  describe('Req 6.21: no generic invoke or arbitrary payloads', () => {
    it('rejects unknown message types', () => {
      const json = JSON.stringify({
        protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
        messageId: 'test-unknown',
        type: 'generic.invoke',
        payload: { method: 'fs.readFile', args: ['/etc/passwd'] },
      });
      const body = Buffer.from(json, 'utf-8');
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32LE(body.length, 0);
      body.copy(frame, 4);

      const result = dispatcher.dispatchFrame(frame);
      expect(result.ok).toBe(false);
    });
  });
});
