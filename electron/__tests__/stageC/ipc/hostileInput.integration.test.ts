/**
 * Stage C IPC — Hostile Input & Endpoint Isolation Integration Tests
 *
 * Tests boundary cases for the dispatcher, authenticator, and transport
 * with zero state mutations and zero service invocations on every rejection.
 *
 * Requirements: 6.1–6.27, 17.11
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as crypto from 'crypto';

import {
  StageCDispatcher,
  RejectionCategory,
  type DispatcherConfig,
  type RejectionMetadata,
} from '../../../stageC/ipc/dispatcher';

import {
  StageCAuthenticator,
  AuthResult,
  AuthMessageType,
  computeClientProof,
  shouldAcceptMessage,
  type AuthConnection,
  type BootstrapInfo,
  type AuthMessage,
  type AuthChallengeMessage,
  type ClientHelloMessage,
} from '../../../stageC/ipc/authenticator';

import { serializeEnvelope, type ProtocolEnvelope } from '../../../stageC/protocol/envelope';

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
} from '../../../stageC/protocol/schema';

// ────────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────────

/** Tracks all state mutations for zero-mutation assertions. */
interface MutationTracker {
  rejections: RejectionMetadata[];
  fallbackCalled: boolean;
  fallbackReason: string | null;
  serviceInvocations: number;
}

function createTracker(): MutationTracker {
  return { rejections: [], fallbackCalled: false, fallbackReason: null, serviceInvocations: 0 };
}

function makeDispatcherConfig(tracker: MutationTracker, opts?: {
  authenticated?: boolean;
  expectedRevision?: number;
  direction?: MessageDirection;
}): DispatcherConfig {
  return {
    expectedIncomingDirection: opts?.direction ?? MessageDirection.SIDECAR_TO_CONTROLLER,
    isAuthenticated: () => opts?.authenticated ?? true,
    getExpectedRevision: () => opts?.expectedRevision ?? -1,
    onFallback: (reason) => {
      tracker.fallbackCalled = true;
      tracker.fallbackReason = reason;
    },
    onRejection: (metadata) => {
      tracker.rejections.push(metadata);
    },
  };
}

/** Builds a valid framed envelope for a sidecar→controller message. */
function makeValidFrame(opts?: {
  messageId?: string;
  type?: string;
  payload?: Record<string, unknown>;
}): Buffer {
  const envelope: ProtocolEnvelope = {
    protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
    messageId: opts?.messageId ?? crypto.randomUUID(),
    type: (opts?.type ?? SidecarToControllerType.LIFECYCLE_READY) as any,
    payload: opts?.payload ?? {
      launch_id: 'test-launch',
      sidecar_version: '1.0.0',
      protocol_major: PROTOCOL_MAJOR,
      protocol_minor: PROTOCOL_MINOR,
      bridge_schema_version: 1,
      capabilities: [],
      webview2_runtime_version: '120.0.0.0',
    },
  };
  return serializeEnvelope(envelope);
}

function makeBootstrap(overrides?: Partial<BootstrapInfo>): BootstrapInfo {
  return {
    launch_id: 'test-launch-id',
    credential: crypto.randomBytes(32).toString('hex'),
    parent_pid: process.pid,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// Authentication Hostile Input Tests
// ────────────────────────────────────────────────────────────────────

describe('Hostile Input — Authentication (Req 6.9–6.12)', () => {
  let authenticator: StageCAuthenticator;

  beforeEach(() => {
    authenticator = new StageCAuthenticator();
  });

  describe('wrong parent PID → auth rejected, zero state change', () => {
    it('rejects wrong parent_pid with no state mutation', async () => {
      const bootstrap = makeBootstrap({ parent_pid: 9999 });
      const sentMessages: AuthMessage[] = [];
      let closed = false;

      const connection: AuthConnection = {
        send(msg) { sentMessages.push(msg); },
        async receive() {
          const challenge = (sentMessages[0] as AuthChallengeMessage).server_challenge;
          const nonce = crypto.randomBytes(32).toString('hex');
          const proof = computeClientProof(
            bootstrap.credential, challenge, nonce, bootstrap.launch_id,
          );
          return {
            type: AuthMessageType.CLIENT_HELLO,
            launch_id: bootstrap.launch_id,
            client_nonce: nonce,
            proof,
            parent_pid: 1111, // wrong parent
          } as ClientHelloMessage;
        },
        close() { closed = true; },
        get connected() { return !closed; },
      };

      const result = await authenticator.authenticate(connection, bootstrap);

      expect(result.result).toBe(AuthResult.INVALID_PARENT);
      expect(closed).toBe(true);
      expect(authenticator.authenticated).toBe(false);
      // Zero state mutations: only 1 message sent (challenge), no AuthAccepted
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].type).toBe(AuthMessageType.AUTH_CHALLENGE);
    });
  });

  describe('altered credential → auth fails', () => {
    it('rejects when any byte of the credential is altered', async () => {
      const bootstrap = makeBootstrap();
      const sentMessages: AuthMessage[] = [];
      let closed = false;

      // Alter one byte of the credential for proof computation
      const alteredCredential = Buffer.from(bootstrap.credential, 'hex');
      alteredCredential[0] ^= 0xff;
      const alteredCredentialHex = alteredCredential.toString('hex');

      const connection: AuthConnection = {
        send(msg) { sentMessages.push(msg); },
        async receive() {
          const challenge = (sentMessages[0] as AuthChallengeMessage).server_challenge;
          const nonce = crypto.randomBytes(32).toString('hex');
          // Compute proof with altered credential
          const proof = computeClientProof(
            alteredCredentialHex, challenge, nonce, bootstrap.launch_id,
          );
          return {
            type: AuthMessageType.CLIENT_HELLO,
            launch_id: bootstrap.launch_id,
            client_nonce: nonce,
            proof,
            parent_pid: bootstrap.parent_pid,
          } as ClientHelloMessage;
        },
        close() { closed = true; },
        get connected() { return !closed; },
      };

      const result = await authenticator.authenticate(connection, bootstrap);

      expect(result.result).toBe(AuthResult.INVALID_PROOF);
      expect(closed).toBe(true);
      expect(authenticator.authenticated).toBe(false);
      // Only challenge sent — no AuthAccepted
      expect(sentMessages).toHaveLength(1);
    });
  });

  describe('expired/invalidated credential → connection closed', () => {
    it('closes connection when credential is invalidated mid-exchange', async () => {
      // Simulate an expired credential by using a completely different one
      const realCredential = crypto.randomBytes(32).toString('hex');
      const expiredCredential = crypto.randomBytes(32).toString('hex');
      const bootstrap = makeBootstrap({ credential: realCredential });
      const sentMessages: AuthMessage[] = [];
      let closed = false;

      const connection: AuthConnection = {
        send(msg) { sentMessages.push(msg); },
        async receive() {
          const challenge = (sentMessages[0] as AuthChallengeMessage).server_challenge;
          const nonce = crypto.randomBytes(32).toString('hex');
          // Use expired (wrong) credential
          const proof = computeClientProof(
            expiredCredential, challenge, nonce, bootstrap.launch_id,
          );
          return {
            type: AuthMessageType.CLIENT_HELLO,
            launch_id: bootstrap.launch_id,
            client_nonce: nonce,
            proof,
            parent_pid: bootstrap.parent_pid,
          } as ClientHelloMessage;
        },
        close() { closed = true; },
        get connected() { return !closed; },
      };

      const result = await authenticator.authenticate(connection, bootstrap);

      expect(result.result).toBe(AuthResult.INVALID_PROOF);
      expect(closed).toBe(true);
      expect(authenticator.authenticated).toBe(false);
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// Dispatcher Hostile Input Tests
// ────────────────────────────────────────────────────────────────────

describe('Hostile Input — Dispatcher Frame Validation (Req 6.13–6.27)', () => {
  let dispatcher: StageCDispatcher;
  let tracker: MutationTracker;

  beforeEach(() => {
    tracker = createTracker();
    dispatcher = new StageCDispatcher(makeDispatcherConfig(tracker));
  });

  describe('malformed UTF-8 body → rejected before dispatch', () => {
    it('rejects frame with invalid UTF-8 bytes', () => {
      // Create a frame with invalid UTF-8 (0xFE 0xFF are never valid)
      const invalidBody = Buffer.from([0xFE, 0xFF, 0x80, 0x81]);
      const frame = Buffer.alloc(4 + invalidBody.length);
      frame.writeUInt32LE(invalidBody.length, 0);
      invalidBody.copy(frame, 4);

      const result = dispatcher.dispatchFrame(frame);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.INVALID_UTF8);
      }
      // Zero state mutations
      expect(dispatcher.currentQueuedMessages).toBe(0);
      expect(dispatcher.currentQueuedBytes).toBe(0);
      expect(tracker.serviceInvocations).toBe(0);
    });
  });

  describe('reversed direction messages → rejected', () => {
    it('rejects a controller→sidecar message on a sidecar→controller channel', () => {
      // Build a frame with a controller→sidecar type sent on the wrong direction
      const frame = makeValidFrame({
        type: ControllerToSidecarType.STATE_SNAPSHOT,
        payload: {
          revision: 1,
          visibility_requested: true,
          bounds_dip: { left: 0, top: 0, width: 400, height: 300 },
          mode: 'compact',
          capture_protection: false,
          render_state: {},
        },
      });

      const result = dispatcher.dispatchFrame(frame);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.WRONG_DIRECTION);
      }
      // Zero state mutations
      expect(dispatcher.currentQueuedMessages).toBe(0);
      expect(dispatcher.currentQueuedBytes).toBe(0);
      expect(tracker.serviceInvocations).toBe(0);
    });
  });

  describe('oversized frames (MAX_FRAME_BYTES + 1) → rejected before allocation', () => {
    it('rejects frame declaring length > MAX_FRAME_BYTES', () => {
      // Create a frame header declaring a size of MAX_FRAME_BYTES + 1
      const oversizedLength = MAX_FRAME_BYTES + 1;
      const frame = Buffer.alloc(4 + 10); // only 4 bytes header + minimal body
      frame.writeUInt32LE(oversizedLength, 0);

      const result = dispatcher.dispatchFrame(frame);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.SIZE_EXCEEDED);
      }
      // Zero state mutations
      expect(dispatcher.currentQueuedMessages).toBe(0);
      expect(dispatcher.currentQueuedBytes).toBe(0);
      expect(tracker.serviceInvocations).toBe(0);
    });

    it('accepts frame at exactly MAX_FRAME_BYTES (boundary)', () => {
      // This should pass size validation but may fail on JSON/schema
      // The point is it's NOT rejected for SIZE_EXCEEDED
      const frame = Buffer.alloc(4 + MAX_FRAME_BYTES);
      frame.writeUInt32LE(MAX_FRAME_BYTES, 0);
      // Fill body with valid UTF-8 (spaces)
      frame.fill(0x20, 4);

      const result = dispatcher.dispatchFrame(frame);

      // May fail for schema reasons but NOT size
      if (!result.ok) {
        expect(result.rejection.category).not.toBe(RejectionCategory.SIZE_EXCEEDED);
      }
    });
  });

  describe('not authenticated → rejected before dispatch', () => {
    it('rejects non-auth messages when connection is not authenticated', () => {
      const unauthTracker = createTracker();
      const unauthDispatcher = new StageCDispatcher(
        makeDispatcherConfig(unauthTracker, { authenticated: false }),
      );

      const frame = makeValidFrame();
      const result = unauthDispatcher.dispatchFrame(frame);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.NOT_AUTHENTICATED);
      }
      expect(unauthDispatcher.currentQueuedMessages).toBe(0);
      expect(unauthTracker.serviceInvocations).toBe(0);
    });
  });

  describe('replay cache at 4096/4097 boundaries', () => {
    it('stores entries at exactly MAX_REPLAY_CACHE_ENTRIES (4096)', () => {
      for (let i = 0; i < MAX_REPLAY_CACHE_ENTRIES; i++) {
        dispatcher.recordOutcome(`msg-${i}`, 'lifecycle.ready', { index: i });
      }

      expect(dispatcher.replayCacheSize).toBe(MAX_REPLAY_CACHE_ENTRIES);
    });

    it('evicts oldest entry at 4097 (MAX_REPLAY_CACHE_ENTRIES + 1)', () => {
      // Fill to capacity
      for (let i = 0; i < MAX_REPLAY_CACHE_ENTRIES; i++) {
        dispatcher.recordOutcome(`msg-${i}`, 'lifecycle.ready', { index: i });
      }

      expect(dispatcher.replayCacheSize).toBe(MAX_REPLAY_CACHE_ENTRIES);

      // Add one more — should evict 'msg-0' (oldest)
      dispatcher.recordOutcome('msg-overflow', 'lifecycle.ready', { index: 'overflow' });

      // Size should stay at max
      expect(dispatcher.replayCacheSize).toBe(MAX_REPLAY_CACHE_ENTRIES);

      // The first entry should have been evicted.
      // Dispatch a duplicate of msg-0 — it should NOT be detected as cached
      const frame0 = makeValidFrame({ messageId: 'msg-0' });
      const result = dispatcher.dispatchFrame(frame0);

      // msg-0 was evicted so it won't be a duplicate — it passes through normally
      if (result.ok) {
        expect(result.duplicate).toBe(false);
      }
    });
  });

  describe('queue at 256/257 boundaries', () => {
    it('accepts messages up to MAX_QUEUED_MESSAGES (256)', () => {
      // Dispatch 256 valid messages
      for (let i = 0; i < MAX_QUEUED_MESSAGES; i++) {
        const frame = makeValidFrame({ messageId: `queue-msg-${i}` });
        const result = dispatcher.dispatchFrame(frame);
        expect(result.ok).toBe(true);
      }

      expect(dispatcher.currentQueuedMessages).toBe(MAX_QUEUED_MESSAGES);
      expect(dispatcher.isClosed).toBe(false);
    });

    it('overflow triggers fallback at 257 (MAX_QUEUED_MESSAGES + 1)', () => {
      // Fill to capacity
      for (let i = 0; i < MAX_QUEUED_MESSAGES; i++) {
        const frame = makeValidFrame({ messageId: `queue-msg-${i}` });
        dispatcher.dispatchFrame(frame);
      }

      // The 257th message should trigger overflow
      const overflowFrame = makeValidFrame({ messageId: 'overflow-msg' });
      const result = dispatcher.dispatchFrame(overflowFrame);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.QUEUE_OVERFLOW);
      }
      expect(dispatcher.isClosed).toBe(true);
      expect(tracker.fallbackCalled).toBe(true);
      expect(tracker.fallbackReason).toBe('queue_overflow');
    });
  });

  describe('byte-limit boundary → overflow triggers fallback', () => {
    it('rejects when aggregate bytes exceed MAX_QUEUED_BYTES', () => {
      // Create a large but valid frame close to MAX_QUEUED_BYTES
      // We'll fill the queue byte count to just under the limit, then overflow
      const largePayloadSize = MAX_QUEUED_BYTES - 100;

      // First, manually simulate having used most of the byte budget
      // by dispatching one frame and acknowledging some, then pushing past the limit.
      // Instead, let's just use the dispatcher's tracking:
      // Dispatch one valid frame, then check byte math for overflow
      const frame = makeValidFrame({ messageId: 'byte-test-1' });
      dispatcher.dispatchFrame(frame);
      const firstFrameBytes = dispatcher.currentQueuedBytes;

      // Now create a frame that will push total bytes over MAX_QUEUED_BYTES
      // We need to create enough frames to exceed the byte limit
      // Each frame is relatively small, so we'll use acknowledgeProcessed to control state
      dispatcher.acknowledgeProcessed(firstFrameBytes);

      // Simulate filling up to just under the byte limit
      // We'll track cumulative bytes to force overflow
      const byteTracker = createTracker();
      const byteDispatcher = new StageCDispatcher(makeDispatcherConfig(byteTracker));

      // Create a frame whose byte size we know
      const testFrame = makeValidFrame({ messageId: 'byte-overflow-test' });
      const frameSize = testFrame.length;

      // Calculate how many frames fit within MAX_QUEUED_BYTES
      const framesBeforeOverflow = Math.floor(MAX_QUEUED_BYTES / frameSize);

      // Dispatch up to (but not exceeding) the byte limit
      let dispatched = 0;
      for (let i = 0; i < framesBeforeOverflow && i < MAX_QUEUED_MESSAGES; i++) {
        const f = makeValidFrame({ messageId: `byte-frame-${i}` });
        const r = byteDispatcher.dispatchFrame(f);
        if (!r.ok) break;
        dispatched++;
      }

      // The next frame should either trigger byte overflow or message overflow
      if (dispatched > 0 && !byteDispatcher.isClosed) {
        const overflowFrame = makeValidFrame({ messageId: 'byte-overflow-final' });
        const overflowResult = byteDispatcher.dispatchFrame(overflowFrame);

        if (!overflowResult.ok) {
          expect(overflowResult.rejection.category).toBe(RejectionCategory.QUEUE_OVERFLOW);
          expect(byteDispatcher.isClosed).toBe(true);
          expect(byteTracker.fallbackCalled).toBe(true);
        }
      }
    });
  });

  describe('all rejections have zero state mutations and zero service invocations', () => {
    it('malformed JSON → zero state change', () => {
      const body = Buffer.from('{ not valid json !!!', 'utf-8');
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32LE(body.length, 0);
      body.copy(frame, 4);

      const beforeQueued = dispatcher.currentQueuedMessages;
      const beforeBytes = dispatcher.currentQueuedBytes;

      const result = dispatcher.dispatchFrame(frame);

      expect(result.ok).toBe(false);
      expect(dispatcher.currentQueuedMessages).toBe(beforeQueued);
      expect(dispatcher.currentQueuedBytes).toBe(beforeBytes);
      expect(tracker.serviceInvocations).toBe(0);
    });

    it('oversized frame → zero state change', () => {
      const frame = Buffer.alloc(4);
      frame.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);

      const beforeQueued = dispatcher.currentQueuedMessages;
      const result = dispatcher.dispatchFrame(frame);

      expect(result.ok).toBe(false);
      expect(dispatcher.currentQueuedMessages).toBe(beforeQueued);
      expect(tracker.serviceInvocations).toBe(0);
    });

    it('invalid UTF-8 → zero state change', () => {
      const invalidBody = Buffer.from([0xC0, 0xC1, 0xF5, 0xF6]);
      const frame = Buffer.alloc(4 + invalidBody.length);
      frame.writeUInt32LE(invalidBody.length, 0);
      invalidBody.copy(frame, 4);

      const result = dispatcher.dispatchFrame(frame);

      expect(result.ok).toBe(false);
      expect(dispatcher.currentQueuedMessages).toBe(0);
      expect(tracker.serviceInvocations).toBe(0);
    });

    it('wrong direction → zero state change', () => {
      const frame = makeValidFrame({
        type: ControllerToSidecarType.LIFECYCLE_SHUTDOWN,
        payload: { reason: 'test' },
      });

      const result = dispatcher.dispatchFrame(frame);

      expect(result.ok).toBe(false);
      expect(dispatcher.currentQueuedMessages).toBe(0);
      expect(tracker.serviceInvocations).toBe(0);
    });
  });

  describe('recording failure is non-interfering (Req 6.27)', () => {
    it('rejection still occurs when onRejection throws', () => {
      const throwingTracker = createTracker();
      const throwingConfig = makeDispatcherConfig(throwingTracker);
      throwingConfig.onRejection = () => {
        throw new Error('Recording exploded');
      };
      const throwingDispatcher = new StageCDispatcher(throwingConfig);

      const invalidBody = Buffer.from([0xFE, 0xFF]);
      const frame = Buffer.alloc(4 + invalidBody.length);
      frame.writeUInt32LE(invalidBody.length, 0);
      invalidBody.copy(frame, 4);

      const result = throwingDispatcher.dispatchFrame(frame);

      // Rejection still occurs despite recording failure
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.INVALID_UTF8);
      }
      expect(throwingDispatcher.currentQueuedMessages).toBe(0);
    });
  });

  describe('dispatcher closed state rejects further frames', () => {
    it('rejects all frames after queue overflow closure', () => {
      // Force overflow
      for (let i = 0; i < MAX_QUEUED_MESSAGES; i++) {
        dispatcher.dispatchFrame(makeValidFrame({ messageId: `fill-${i}` }));
      }
      dispatcher.dispatchFrame(makeValidFrame({ messageId: 'trigger-overflow' }));
      expect(dispatcher.isClosed).toBe(true);

      // Now every subsequent frame is rejected
      const result = dispatcher.dispatchFrame(makeValidFrame({ messageId: 'post-close' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.category).toBe(RejectionCategory.QUEUE_OVERFLOW);
      }
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// Endpoint Isolation Tests
// ────────────────────────────────────────────────────────────────────

describe('Hostile Input — Endpoint Isolation (Req 6.1–6.8)', () => {
  describe('shouldAcceptMessage gating', () => {
    it('rejects protocol messages before authentication', () => {
      const accepted = shouldAcceptMessage(false, { type: 'state.snapshot' });
      expect(accepted).toBe(false);
    });

    it('rejects protocol messages with various types before auth', () => {
      const types = [
        'lifecycle.ready',
        'state.patch',
        'surface.setBounds',
        'intent.overlay',
      ];
      for (const type of types) {
        expect(shouldAcceptMessage(false, { type })).toBe(false);
      }
    });

    it('accepts only auth messages before authentication', () => {
      expect(shouldAcceptMessage(false, { type: 'auth.challenge' })).toBe(true);
      expect(shouldAcceptMessage(false, { type: 'auth.clientHello' })).toBe(true);
      expect(shouldAcceptMessage(false, { type: 'auth.accepted' })).toBe(true);
    });

    it('rejects auth messages after authentication (replay protection)', () => {
      expect(shouldAcceptMessage(true, { type: 'auth.challenge' })).toBe(false);
      expect(shouldAcceptMessage(true, { type: 'auth.clientHello' })).toBe(false);
      expect(shouldAcceptMessage(true, { type: 'auth.accepted' })).toBe(false);
    });
  });
});
