/**
 * Stage C IPC — Transport, Hostile-Input, and Cleanup Validation Suite
 *
 * Validates Stage C5 requirements (6.1–6.27, 13.16, 17.11):
 * - No credential-bearing diagnostics (rejection metadata, fallbacks)
 * - Handle ownership cleanup
 * - Dispatcher cleanup
 * - Auth state cleanup
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as net from 'net';

import {
  StageCDispatcher,
  RejectionCategory,
  type DispatcherConfig,
  type RejectionMetadata,
} from '../../../stageC/ipc/dispatcher';

import {
  StageCAuthenticator,
  AuthMessageType,
  AuthResult,
  computeClientProof,
  type AuthConnection,
  type BootstrapInfo,
  type AuthMessage,
  type ClientHelloMessage,
  type AuthChallengeMessage,
} from '../../../stageC/ipc/authenticator';

import {
  createLaunchEndpoint,
  generateLaunchCredential,
  generateNonces,
  destroyEndpoint,
  MAX_BOOTSTRAP_RECORD_BYTES,
} from '../../../stageC/ipc/namedPipe';

import {
  MAX_FRAME_BYTES,
  MAX_QUEUED_MESSAGES,
  MessageDirection,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  SidecarToControllerType,
} from '../../../stageC/protocol/schema';
import { serializeEnvelope, type ProtocolEnvelope } from '../../../stageC/protocol/envelope';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function makeValidFrame(opts?: { messageId?: string; type?: string; payload?: Record<string, unknown> }): Buffer {
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

function makeBootstrap(): BootstrapInfo {
  return {
    launch_id: 'test-launch',
    credential: crypto.randomBytes(32).toString('hex'),
    parent_pid: process.pid,
  };
}

const endpointsToClean: Array<{ destroy(): void }> = [];
afterEach(() => {
  for (const ep of endpointsToClean) {
    try { ep.destroy(); } catch {}
  }
  endpointsToClean.length = 0;
});

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('Stage C5 Validation Suite', () => {

  describe('Credential-bearing diagnostic check', () => {
    it('ensures rejection metadata and fallback reasons never contain the credential', () => {
      const credential = crypto.randomBytes(32).toString('hex');
      const rejections: RejectionMetadata[] = [];
      let fallbackReason: string | null = null;

      const dispatcher = new StageCDispatcher({
        expectedIncomingDirection: MessageDirection.SIDECAR_TO_CONTROLLER,
        isAuthenticated: () => true,
        getExpectedRevision: () => -1,
        onFallback: (reason) => { fallbackReason = reason; },
        onRejection: (metadata) => { rejections.push(metadata); },
      });

      // Force a rejection containing the credential in a malicious way
      // e.g. payload is way too big
      const maliciousPayload = Buffer.from(`{"credential":"${credential}"}`);
      const frame = Buffer.alloc(4 + maliciousPayload.length);
      frame.writeUInt32LE(maliciousPayload.length, 0);
      maliciousPayload.copy(frame, 4);

      dispatcher.dispatchFrame(frame);

      // Check rejections
      expect(rejections.length).toBeGreaterThan(0);
      for (const rej of rejections) {
        expect(JSON.stringify(rej)).not.toContain(credential);
      }

      // Force fallback (queue overflow)
      for (let i = 0; i < MAX_QUEUED_MESSAGES + 5; i++) {
        dispatcher.dispatchFrame(makeValidFrame({ messageId: `msg-${i}` }));
      }
      expect(fallbackReason).not.toBeNull();
      expect(fallbackReason).not.toContain(credential);
    });
  });

  describe('Handle ownership and endpoint cleanup', () => {
    if (process.platform === 'win32') {
      it('cleans up named pipe server and clears credentials completely', () => {
        const result = createLaunchEndpoint();
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const endpoint = result.endpoint;
        endpointsToClean.push(endpoint);

        const cred = endpoint.bootstrap.credential;
        const sNonce = endpoint.bootstrap.serverNonce;
        const cNonce = endpoint.bootstrap.clientNonce;

        expect(cred).toHaveLength(64);
        expect(endpoint.server.listening).toBe(true);

        // Destroy endpoint
        destroyEndpoint(endpoint);

        expect(endpoint.server.listening).toBe(false);
        expect(endpoint.bootstrap.credential).toBe('');
        expect(endpoint.bootstrap.serverNonce).toBe('');
        expect(endpoint.bootstrap.clientNonce).toBe('');
        expect(endpoint.consumed).toBe(true);
      });
    } else {
      it('skipped on non-Windows', () => {
        expect(true).toBe(true);
      });
    }
  });

  describe('Dispatcher cleanup (freeze on overflow)', () => {
    it('freezes dispatcher state after queue overflow', () => {
      let fallbacks = 0;
      const dispatcher = new StageCDispatcher({
        expectedIncomingDirection: MessageDirection.SIDECAR_TO_CONTROLLER,
        isAuthenticated: () => true,
        getExpectedRevision: () => -1,
        onFallback: () => { fallbacks++; },
        onRejection: () => {},
      });

      // Fill queue exactly
      for (let i = 0; i < MAX_QUEUED_MESSAGES; i++) {
        const res = dispatcher.dispatchFrame(makeValidFrame({ messageId: `msg-${i}` }));
        expect(res.ok).toBe(true);
      }

      // Overflow
      const overflowRes = dispatcher.dispatchFrame(makeValidFrame({ messageId: 'overflow' }));
      expect(overflowRes.ok).toBe(false);
      expect(dispatcher.isClosed).toBe(true);
      expect(fallbacks).toBe(1);

      const beforeQueued = dispatcher.currentQueuedMessages;

      // Further dispatches should fail and not alter state
      const postCloseRes = dispatcher.dispatchFrame(makeValidFrame({ messageId: 'post' }));
      expect(postCloseRes.ok).toBe(false);
      expect(dispatcher.currentQueuedMessages).toBe(beforeQueued);
      expect(fallbacks).toBe(1); // onFallback should only trigger once
    });
  });

  describe('Auth state cleanup', () => {
    it('closes connection on failed auth', async () => {
      const authenticator = new StageCAuthenticator();
      const bootstrap = makeBootstrap();

      let connectionClosed = false;
      const sentMessages: AuthMessage[] = [];

      const connection: AuthConnection = {
        send(msg) { sentMessages.push(msg); },
        async receive() {
          // Provide an invalid client hello
          return {
            type: AuthMessageType.CLIENT_HELLO,
            launch_id: 'wrong-launch-id',
            client_nonce: 'invalid-nonce',
            proof: 'invalid-proof',
            parent_pid: 999,
          } as ClientHelloMessage;
        },
        close() { connectionClosed = true; },
        get connected() { return !connectionClosed; },
      };

      const result = await authenticator.authenticate(connection, bootstrap);
      expect(result.result).toBe(AuthResult.INVALID_MESSAGE);
      expect(connectionClosed).toBe(true);
    });
  });

});
