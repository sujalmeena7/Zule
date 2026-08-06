/**
 * Stage C IPC — Authenticator Unit Tests
 *
 * Tests the mutual challenge-response authentication protocol.
 *
 * Requirements: 6.9–6.12
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  StageCAuthenticator,
  AuthMessageType,
  AuthResult,
  computeClientProof,
  computeServerProof,
  isValidHex,
  validateClientHello,
  isAuthenticationMessage,
  shouldAcceptMessage,
  bootstrapInfoFromRecord,
  AUTH_THRESHOLD_MS,
  AUTH_DEADLINE_MS,
  CHALLENGE_BYTES,
  CLIENT_NONCE_BYTES,
  CLIENT_PROOF_PREFIX,
  SERVER_PROOF_PREFIX,
  type AuthConnection,
  type BootstrapInfo,
  type AuthMessage,
  type ClientHelloMessage,
  type AuthChallengeMessage,
} from '../../../stageC/ipc/authenticator';

import * as crypto from 'crypto';

// ────────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────────

function makeBootstrap(overrides?: Partial<BootstrapInfo>): BootstrapInfo {
  return {
    launch_id: 'test-launch-id-abc123',
    credential: crypto.randomBytes(32).toString('hex'),
    parent_pid: 1234,
    ...overrides,
  };
}

function makeValidClientNonce(): string {
  return crypto.randomBytes(CLIENT_NONCE_BYTES).toString('hex');
}

/**
 * Creates a mock connection that responds correctly to authentication.
 */
function makeMockConnection(opts?: {
  clientHello?: Partial<ClientHelloMessage> | null;
  bootstrap?: BootstrapInfo;
  serverChallenge?: string;
  closed?: boolean;
  receiveDelay?: number;
}): AuthConnection {
  const messages: AuthMessage[] = [];
  let closed = opts?.closed ?? false;

  return {
    send(message: AuthMessage) {
      if (closed) throw new Error('Connection closed');
      messages.push(message);
    },
    async receive(deadlineMs: number): Promise<AuthMessage | null> {
      if (closed) return null;
      if (opts?.receiveDelay && opts.receiveDelay > deadlineMs) {
        return null;
      }
      if (opts?.receiveDelay) {
        await new Promise(r => setTimeout(r, opts.receiveDelay));
      }

      if (opts?.clientHello === null) return null;

      // Build a valid ClientHello from the sent challenge
      const challengeMsg = messages[0] as AuthChallengeMessage;
      const bootstrap = opts?.bootstrap ?? makeBootstrap();
      const clientNonce = makeValidClientNonce();
      const serverChallenge = challengeMsg?.server_challenge ?? opts?.serverChallenge ?? '';

      const proof = computeClientProof(
        bootstrap.credential,
        serverChallenge,
        clientNonce,
        bootstrap.launch_id,
      );

      const hello: ClientHelloMessage = {
        type: AuthMessageType.CLIENT_HELLO,
        launch_id: bootstrap.launch_id,
        client_nonce: clientNonce,
        proof,
        parent_pid: bootstrap.parent_pid,
        ...(opts?.clientHello ?? {}),
      };

      return hello;
    },
    close() { closed = true; },
    get connected() { return !closed; },
  };
}

// ────────────────────────────────────────────────────────────────────
// HMAC Computation Tests
// ────────────────────────────────────────────────────────────────────

describe('computeClientProof', () => {
  it('produces a 64-char hex string (32 bytes)', () => {
    const credential = crypto.randomBytes(32).toString('hex');
    const challenge = crypto.randomBytes(32).toString('hex');
    const nonce = crypto.randomBytes(32).toString('hex');
    const launchId = 'launch-123';

    const proof = computeClientProof(credential, challenge, nonce, launchId);
    expect(proof).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(proof)).toBe(true);
  });

  it('uses CLIENT_PROOF_PREFIX domain separator', () => {
    const credential = crypto.randomBytes(32).toString('hex');
    const challenge = crypto.randomBytes(32).toString('hex');
    const nonce = crypto.randomBytes(32).toString('hex');
    const launchId = 'launch-xyz';

    // Manually compute expected value
    const key = Buffer.from(credential, 'hex');
    const data = Buffer.concat([
      Buffer.from(CLIENT_PROOF_PREFIX, 'utf-8'),
      Buffer.from(challenge, 'hex'),
      Buffer.from(nonce, 'hex'),
      Buffer.from(launchId, 'utf-8'),
    ]);
    const expected = crypto.createHmac('sha256', key).update(data).digest('hex');

    const actual = computeClientProof(credential, challenge, nonce, launchId);
    expect(actual).toBe(expected);
  });

  it('produces different results for different credentials', () => {
    const challenge = crypto.randomBytes(32).toString('hex');
    const nonce = crypto.randomBytes(32).toString('hex');
    const launchId = 'launch-1';

    const proof1 = computeClientProof(crypto.randomBytes(32).toString('hex'), challenge, nonce, launchId);
    const proof2 = computeClientProof(crypto.randomBytes(32).toString('hex'), challenge, nonce, launchId);
    expect(proof1).not.toBe(proof2);
  });

  it('produces different results for different launch IDs', () => {
    const credential = crypto.randomBytes(32).toString('hex');
    const challenge = crypto.randomBytes(32).toString('hex');
    const nonce = crypto.randomBytes(32).toString('hex');

    const proof1 = computeClientProof(credential, challenge, nonce, 'launch-a');
    const proof2 = computeClientProof(credential, challenge, nonce, 'launch-b');
    expect(proof1).not.toBe(proof2);
  });
});

describe('computeServerProof', () => {
  it('produces a 64-char hex string (32 bytes)', () => {
    const credential = crypto.randomBytes(32).toString('hex');
    const clientNonce = crypto.randomBytes(32).toString('hex');
    const challenge = crypto.randomBytes(32).toString('hex');
    const launchId = 'launch-456';

    const proof = computeServerProof(credential, clientNonce, challenge, launchId);
    expect(proof).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(proof)).toBe(true);
  });

  it('uses SERVER_PROOF_PREFIX domain separator', () => {
    const credential = crypto.randomBytes(32).toString('hex');
    const clientNonce = crypto.randomBytes(32).toString('hex');
    const challenge = crypto.randomBytes(32).toString('hex');
    const launchId = 'launch-789';

    const key = Buffer.from(credential, 'hex');
    const data = Buffer.concat([
      Buffer.from(SERVER_PROOF_PREFIX, 'utf-8'),
      Buffer.from(clientNonce, 'hex'),
      Buffer.from(challenge, 'hex'),
      Buffer.from(launchId, 'utf-8'),
    ]);
    const expected = crypto.createHmac('sha256', key).update(data).digest('hex');

    const actual = computeServerProof(credential, clientNonce, challenge, launchId);
    expect(actual).toBe(expected);
  });

  it('is different from client proof with same inputs', () => {
    const credential = crypto.randomBytes(32).toString('hex');
    const nonce = crypto.randomBytes(32).toString('hex');
    const challenge = crypto.randomBytes(32).toString('hex');
    const launchId = 'launch-diff';

    const clientProof = computeClientProof(credential, challenge, nonce, launchId);
    const serverProof = computeServerProof(credential, nonce, challenge, launchId);
    expect(clientProof).not.toBe(serverProof);
  });
});

// ────────────────────────────────────────────────────────────────────
// Validation Helper Tests
// ────────────────────────────────────────────────────────────────────

describe('isValidHex', () => {
  it('accepts valid hex of expected length', () => {
    expect(isValidHex('aa'.repeat(32), 32)).toBe(true);
    expect(isValidHex('0123456789abcdef'.repeat(4), 32)).toBe(true);
  });

  it('rejects non-string values', () => {
    expect(isValidHex(123, 32)).toBe(false);
    expect(isValidHex(null, 32)).toBe(false);
    expect(isValidHex(undefined, 32)).toBe(false);
  });

  it('rejects wrong length', () => {
    expect(isValidHex('aa'.repeat(16), 32)).toBe(false);
    expect(isValidHex('aa'.repeat(33), 32)).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidHex('zz'.repeat(32), 32)).toBe(false);
    expect(isValidHex('GG' + 'aa'.repeat(31), 32)).toBe(false);
  });
});

describe('validateClientHello', () => {
  it('accepts a valid ClientHello', () => {
    const msg: ClientHelloMessage = {
      type: AuthMessageType.CLIENT_HELLO,
      launch_id: 'test-id',
      client_nonce: crypto.randomBytes(32).toString('hex'),
      proof: crypto.randomBytes(32).toString('hex'),
      parent_pid: 1234,
    };
    expect(validateClientHello(msg)).toBe(true);
  });

  it('rejects null', () => {
    expect(validateClientHello(null)).toBe(false);
  });

  it('rejects wrong type field', () => {
    expect(validateClientHello({
      type: 'wrong',
      launch_id: 'id',
      client_nonce: 'aa'.repeat(32),
      proof: 'bb'.repeat(32),
      parent_pid: 1,
    })).toBe(false);
  });

  it('rejects non-integer parent_pid', () => {
    expect(validateClientHello({
      type: AuthMessageType.CLIENT_HELLO,
      launch_id: 'id',
      client_nonce: 'aa'.repeat(32),
      proof: 'bb'.repeat(32),
      parent_pid: 1.5,
    })).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// Authentication Message Gating Tests
// ────────────────────────────────────────────────────────────────────

describe('isAuthenticationMessage', () => {
  it('identifies auth.challenge as authentication', () => {
    expect(isAuthenticationMessage({ type: AuthMessageType.AUTH_CHALLENGE })).toBe(true);
  });

  it('identifies auth.clientHello as authentication', () => {
    expect(isAuthenticationMessage({ type: AuthMessageType.CLIENT_HELLO })).toBe(true);
  });

  it('identifies auth.accepted as authentication', () => {
    expect(isAuthenticationMessage({ type: AuthMessageType.AUTH_ACCEPTED })).toBe(true);
  });

  it('rejects protocol messages', () => {
    expect(isAuthenticationMessage({ type: 'state.snapshot' })).toBe(false);
    expect(isAuthenticationMessage({ type: 'lifecycle.ready' })).toBe(false);
  });

  it('rejects null and non-objects', () => {
    expect(isAuthenticationMessage(null)).toBe(false);
    expect(isAuthenticationMessage('string')).toBe(false);
    expect(isAuthenticationMessage(123)).toBe(false);
  });
});

describe('shouldAcceptMessage', () => {
  it('accepts auth messages before authentication', () => {
    expect(shouldAcceptMessage(false, { type: AuthMessageType.CLIENT_HELLO })).toBe(true);
  });

  it('rejects protocol messages before authentication', () => {
    expect(shouldAcceptMessage(false, { type: 'state.snapshot' })).toBe(false);
  });

  it('accepts protocol messages after authentication', () => {
    expect(shouldAcceptMessage(true, { type: 'state.snapshot' })).toBe(true);
  });

  it('rejects auth messages after authentication', () => {
    expect(shouldAcceptMessage(true, { type: AuthMessageType.CLIENT_HELLO })).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// StageCAuthenticator Tests
// ────────────────────────────────────────────────────────────────────

describe('StageCAuthenticator', () => {
  let authenticator: StageCAuthenticator;

  beforeEach(() => {
    authenticator = new StageCAuthenticator();
  });

  describe('successful authentication', () => {
    it('completes authentication with valid credentials', async () => {
      const bootstrap = makeBootstrap();
      const sentMessages: AuthMessage[] = [];
      let receivedChallenge: AuthChallengeMessage | null = null;

      const connection: AuthConnection = {
        send(msg) { sentMessages.push(msg); receivedChallenge = msg as AuthChallengeMessage; },
        async receive() {
          const clientNonce = makeValidClientNonce();
          const proof = computeClientProof(
            bootstrap.credential,
            receivedChallenge!.server_challenge,
            clientNonce,
            bootstrap.launch_id,
          );
          return {
            type: AuthMessageType.CLIENT_HELLO,
            launch_id: bootstrap.launch_id,
            client_nonce: clientNonce,
            proof,
            parent_pid: bootstrap.parent_pid,
          } as ClientHelloMessage;
        },
        close() {},
        get connected() { return true; },
      };

      const result = await authenticator.authenticate(connection, bootstrap);
      expect(result.result).toBe(AuthResult.SUCCESS);
      expect(authenticator.authenticated).toBe(true);
      expect(authenticator.canDispatch()).toBe(true);
    });

    it('sends AuthChallenge as the first message', async () => {
      const bootstrap = makeBootstrap();
      const sentMessages: AuthMessage[] = [];

      const connection: AuthConnection = {
        send(msg) { sentMessages.push(msg); },
        async receive() {
          const challenge = (sentMessages[0] as AuthChallengeMessage).server_challenge;
          const clientNonce = makeValidClientNonce();
          const proof = computeClientProof(
            bootstrap.credential,
            challenge,
            clientNonce,
            bootstrap.launch_id,
          );
          return {
            type: AuthMessageType.CLIENT_HELLO,
            launch_id: bootstrap.launch_id,
            client_nonce: clientNonce,
            proof,
            parent_pid: bootstrap.parent_pid,
          } as ClientHelloMessage;
        },
        close() {},
        get connected() { return true; },
      };

      await authenticator.authenticate(connection, bootstrap);

      expect(sentMessages[0]).toMatchObject({
        type: AuthMessageType.AUTH_CHALLENGE,
        launch_id: bootstrap.launch_id,
      });
      // Challenge is 32 bytes = 64 hex chars
      expect((sentMessages[0] as AuthChallengeMessage).server_challenge).toHaveLength(64);
    });

    it('sends AuthAccepted with correct server proof', async () => {
      const bootstrap = makeBootstrap();
      const sentMessages: AuthMessage[] = [];
      let clientNonceUsed = '';

      const connection: AuthConnection = {
        send(msg) { sentMessages.push(msg); },
        async receive() {
          const challenge = (sentMessages[0] as AuthChallengeMessage).server_challenge;
          clientNonceUsed = makeValidClientNonce();
          const proof = computeClientProof(
            bootstrap.credential, challenge, clientNonceUsed, bootstrap.launch_id,
          );
          return {
            type: AuthMessageType.CLIENT_HELLO,
            launch_id: bootstrap.launch_id,
            client_nonce: clientNonceUsed,
            proof,
            parent_pid: bootstrap.parent_pid,
          } as ClientHelloMessage;
        },
        close() {},
        get connected() { return true; },
      };

      await authenticator.authenticate(connection, bootstrap);

      // Second sent message should be AuthAccepted
      expect(sentMessages[1]).toMatchObject({ type: AuthMessageType.AUTH_ACCEPTED });

      // Verify server proof is correct
      const expectedServerProof = computeServerProof(
        bootstrap.credential,
        clientNonceUsed,
        (sentMessages[0] as AuthChallengeMessage).server_challenge,
        bootstrap.launch_id,
      );
      expect((sentMessages[1] as any).server_proof).toBe(expectedServerProof);
    });

    it('returns clientNonce on success', async () => {
      const bootstrap = makeBootstrap();
      const sentMessages: AuthMessage[] = [];
      const fixedNonce = crypto.randomBytes(32).toString('hex');

      const connection: AuthConnection = {
        send(msg) { sentMessages.push(msg); },
        async receive() {
          const challenge = (sentMessages[0] as AuthChallengeMessage).server_challenge;
          const proof = computeClientProof(
            bootstrap.credential, challenge, fixedNonce, bootstrap.launch_id,
          );
          return {
            type: AuthMessageType.CLIENT_HELLO,
            launch_id: bootstrap.launch_id,
            client_nonce: fixedNonce,
            proof,
            parent_pid: bootstrap.parent_pid,
          } as ClientHelloMessage;
        },
        close() {},
        get connected() { return true; },
      };

      const result = await authenticator.authenticate(connection, bootstrap);
      expect(result.result).toBe(AuthResult.SUCCESS);
      if (result.result === AuthResult.SUCCESS) {
        expect(result.clientNonce).toBe(fixedNonce);
      }
    });
  });

  describe('authentication failures — Req 6.11', () => {
    it('rejects mismatched launch_id and closes connection', async () => {
      const bootstrap = makeBootstrap();
      let closed = false;
      const sentMessages: AuthMessage[] = [];

      const connection: AuthConnection = {
        send(msg) { sentMessages.push(msg); },
        async receive() {
          const challenge = (sentMessages[0] as AuthChallengeMessage).server_challenge;
          const nonce = makeValidClientNonce();
          const proof = computeClientProof(
            bootstrap.credential, challenge, nonce, bootstrap.launch_id,
          );
          return {
            type: AuthMessageType.CLIENT_HELLO,
            launch_id: 'wrong-launch-id',
            client_nonce: nonce,
            proof,
            parent_pid: bootstrap.parent_pid,
          } as ClientHelloMessage;
        },
        close() { closed = true; },
        get connected() { return !closed; },
      };

      const result = await authenticator.authenticate(connection, bootstrap);
      expect(result.result).toBe(AuthResult.INVALID_LAUNCH_ID);
      expect(closed).toBe(true);
      expect(authenticator.authenticated).toBe(false);
      expect(authenticator.canDispatch()).toBe(false);
    });

    it('rejects invalid proof and closes connection', async () => {
      const bootstrap = makeBootstrap();
      let closed = false;
      const sentMessages: AuthMessage[] = [];

      const connection: AuthConnection = {
        send(msg) { sentMessages.push(msg); },
        async receive() {
          return {
            type: AuthMessageType.CLIENT_HELLO,
            launch_id: bootstrap.launch_id,
            client_nonce: makeValidClientNonce(),
            proof: crypto.randomBytes(32).toString('hex'), // wrong proof
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

    it('rejects wrong parent_pid and closes connection', async () => {
      const bootstrap = makeBootstrap({ parent_pid: 9999 });
      let closed = false;
      const sentMessages: AuthMessage[] = [];

      const connection: AuthConnection = {
        send(msg) { sentMessages.push(msg); },
        async receive() {
          const challenge = (sentMessages[0] as AuthChallengeMessage).server_challenge;
          const nonce = makeValidClientNonce();
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
    });

    it('rejects invalid message format and closes connection', async () => {
      let closed = false;
      const bootstrap = makeBootstrap();

      const connection: AuthConnection = {
        send() {},
        async receive() {
          return { type: 'garbage', foo: 'bar' } as any;
        },
        close() { closed = true; },
        get connected() { return !closed; },
      };

      const result = await authenticator.authenticate(connection, bootstrap);
      expect(result.result).toBe(AuthResult.INVALID_MESSAGE);
      expect(closed).toBe(true);
    });

    it('returns CONNECTION_CLOSED when receive returns null and disconnected', async () => {
      const bootstrap = makeBootstrap();

      const connection: AuthConnection = {
        send() {},
        async receive() { return null; },
        close() {},
        get connected() { return false; },
      };

      const result = await authenticator.authenticate(connection, bootstrap);
      expect(result.result).toBe(AuthResult.CONNECTION_CLOSED);
    });
  });

  describe('deadline enforcement — Req 6.10', () => {
    it('returns DEADLINE_EXPIRED when receive exceeds deadline', async () => {
      const bootstrap = makeBootstrap();

      const connection: AuthConnection = {
        send() {},
        async receive(deadlineMs: number) {
          // Simulate timeout by returning null (deadline expired)
          return null;
        },
        close() {},
        get connected() { return true; },
      };

      const result = await authenticator.authenticate(connection, bootstrap, undefined, 100);
      expect(result.result).toBe(AuthResult.DEADLINE_EXPIRED);
    });

    it('returns DEADLINE_EXPIRED when startTime already past deadline', async () => {
      const bootstrap = makeBootstrap();

      const connection: AuthConnection = {
        send() {},
        async receive() { return null; },
        close() {},
        get connected() { return true; },
      };

      // Pass a deadline of 0ms so it's already expired
      const result = await authenticator.authenticate(connection, bootstrap, undefined, 0);
      expect(result.result).toBe(AuthResult.DEADLINE_EXPIRED);
    });
  });

  describe('threshold event — Req 6.10', () => {
    it('calls threshold callback when auth takes > 2s', async () => {
      vi.useFakeTimers();
      const bootstrap = makeBootstrap();
      let thresholdCalled = false;
      const sentMessages: AuthMessage[] = [];

      const connection: AuthConnection = {
        send(msg) { sentMessages.push(msg); },
        async receive(deadlineMs: number) {
          // Advance time past threshold
          vi.advanceTimersByTime(AUTH_THRESHOLD_MS + 100);
          const challenge = (sentMessages[0] as AuthChallengeMessage).server_challenge;
          const nonce = makeValidClientNonce();
          const proof = computeClientProof(
            bootstrap.credential, challenge, nonce, bootstrap.launch_id,
          );
          return {
            type: AuthMessageType.CLIENT_HELLO,
            launch_id: bootstrap.launch_id,
            client_nonce: nonce,
            proof,
            parent_pid: bootstrap.parent_pid,
          } as ClientHelloMessage;
        },
        close() {},
        get connected() { return true; },
      };

      const resultPromise = authenticator.authenticate(
        connection, bootstrap, () => { thresholdCalled = true; }, 5000,
      );

      // Process pending timers
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.result).toBe(AuthResult.SUCCESS);
      expect(result.thresholdExceeded).toBe(true);
      expect(thresholdCalled).toBe(true);
      vi.useRealTimers();
    });
  });

  describe('zero side effects on failure — Req 6.11', () => {
    it('performs zero state mutations on invalid proof', async () => {
      const bootstrap = makeBootstrap();
      let sendCount = 0;
      let closed = false;

      const connection: AuthConnection = {
        send() { sendCount++; },
        async receive() {
          return {
            type: AuthMessageType.CLIENT_HELLO,
            launch_id: bootstrap.launch_id,
            client_nonce: makeValidClientNonce(),
            proof: 'ff'.repeat(32), // wrong proof
            parent_pid: bootstrap.parent_pid,
          } as ClientHelloMessage;
        },
        close() { closed = true; },
        get connected() { return !closed; },
      };

      await authenticator.authenticate(connection, bootstrap);

      // Only one message sent (the challenge), no AuthAccepted
      expect(sendCount).toBe(1);
      expect(closed).toBe(true);
      expect(authenticator.authenticated).toBe(false);
    });

    it('does not send AuthAccepted on invalid launch_id', async () => {
      const bootstrap = makeBootstrap();
      const sentMessages: AuthMessage[] = [];
      let closed = false;

      const connection: AuthConnection = {
        send(msg) { sentMessages.push(msg); },
        async receive() {
          return {
            type: AuthMessageType.CLIENT_HELLO,
            launch_id: 'wrong-id',
            client_nonce: makeValidClientNonce(),
            proof: 'aa'.repeat(32),
            parent_pid: bootstrap.parent_pid,
          } as ClientHelloMessage;
        },
        close() { closed = true; },
        get connected() { return !closed; },
      };

      await authenticator.authenticate(connection, bootstrap);
      // Only challenge sent, no accepted message
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].type).toBe(AuthMessageType.AUTH_CHALLENGE);
    });
  });

  describe('reset', () => {
    it('clears authenticated state', async () => {
      const bootstrap = makeBootstrap();
      const sentMessages: AuthMessage[] = [];

      const connection: AuthConnection = {
        send(msg) { sentMessages.push(msg); },
        async receive() {
          const challenge = (sentMessages[0] as AuthChallengeMessage).server_challenge;
          const nonce = makeValidClientNonce();
          const proof = computeClientProof(
            bootstrap.credential, challenge, nonce, bootstrap.launch_id,
          );
          return {
            type: AuthMessageType.CLIENT_HELLO,
            launch_id: bootstrap.launch_id,
            client_nonce: nonce,
            proof,
            parent_pid: bootstrap.parent_pid,
          } as ClientHelloMessage;
        },
        close() {},
        get connected() { return true; },
      };

      await authenticator.authenticate(connection, bootstrap);
      expect(authenticator.authenticated).toBe(true);

      authenticator.reset();
      expect(authenticator.authenticated).toBe(false);
      expect(authenticator.canDispatch()).toBe(false);
      expect(authenticator.serverChallenge).toBeNull();
    });
  });

  describe('send failure handling', () => {
    it('returns CONNECTION_CLOSED if send throws on challenge', async () => {
      const bootstrap = makeBootstrap();

      const connection: AuthConnection = {
        send() { throw new Error('pipe broken'); },
        async receive() { return null; },
        close() {},
        get connected() { return false; },
      };

      const result = await authenticator.authenticate(connection, bootstrap);
      expect(result.result).toBe(AuthResult.CONNECTION_CLOSED);
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// bootstrapInfoFromRecord Tests
// ────────────────────────────────────────────────────────────────────

describe('bootstrapInfoFromRecord', () => {
  it('maps camelCase BootstrapRecord fields to snake_case BootstrapInfo', () => {
    const record = {
      launchId: 'abc-123-def',
      credential: 'ff'.repeat(32),
      parentPid: 4567,
    };

    const info = bootstrapInfoFromRecord(record);
    expect(info.launch_id).toBe('abc-123-def');
    expect(info.credential).toBe('ff'.repeat(32));
    expect(info.parent_pid).toBe(4567);
  });
});
