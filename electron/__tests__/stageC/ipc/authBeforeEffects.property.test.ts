// ============================================
// Zule AI — Authentication Before Effects Property Test
// ============================================
//
// Feature: stealth-window-host
// Property 5: Authentication before effects
//
// Generate every noncurrent credential and altered launch/proof/challenge/
// nonce/parent combination; assert connection closure and unchanged
// canonical, surface, and service counters.
//
// **Validates: Requirements 6.4, 6.9–6.12**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import * as crypto from 'crypto';

import {
  StageCAuthenticator,
  AuthMessageType,
  AuthResult,
  computeClientProof,
  CHALLENGE_BYTES,
  CLIENT_NONCE_BYTES,
  type AuthConnection,
  type AuthMessage,
  type BootstrapInfo,
  type ClientHelloMessage,
  type AuthChallengeMessage,
} from '../../../stageC/ipc/authenticator';

// ────────────────────────────────────────────────────────────────────
// Helpers & Counters
// ────────────────────────────────────────────────────────────────────

/** Counters that track state mutations and service invocations. */
interface EffectCounters {
  /** Number of AuthAccepted messages sent (service invocations). */
  authAcceptedSent: number;
  /** Number of non-challenge messages sent. */
  nonChallengeSent: number;
  /** Whether connection.close() was called. */
  connectionClosed: boolean;
}

function makeBootstrap(): BootstrapInfo {
  return {
    launch_id: crypto.randomBytes(16).toString('hex'),
    credential: crypto.randomBytes(32).toString('hex'),
    parent_pid: 12345,
  };
}

/**
 * Creates a connection that captures effects (sent messages, close calls)
 * and responds with the provided ClientHello message on receive.
 */
function makeTrackedConnection(
  clientHello: ClientHelloMessage | null,
  counters: EffectCounters,
): AuthConnection {
  let closed = false;

  return {
    send(message: AuthMessage) {
      if (closed) throw new Error('Connection closed');
      if (message.type === AuthMessageType.AUTH_ACCEPTED) {
        counters.authAcceptedSent++;
      }
      if (message.type !== AuthMessageType.AUTH_CHALLENGE) {
        counters.nonChallengeSent++;
      }
    },
    async receive(_deadlineMs: number): Promise<AuthMessage | null> {
      if (closed) return null;
      return clientHello;
    },
    close() {
      closed = true;
      counters.connectionClosed = true;
    },
    get connected() {
      return !closed;
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Generators
// ────────────────────────────────────────────────────────────────────

/** Generates a valid 32-byte hex credential (64 hex chars). */
const credentialArb = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(
  (bytes) => Buffer.from(bytes).toString('hex'),
);

/** Generates a valid 32-byte hex nonce (64 hex chars). */
const validNonceArb = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(
  (bytes) => Buffer.from(bytes).toString('hex'),
);

/** Generates a valid launch_id string. */
const launchIdArb = fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
  minLength: 8,
  maxLength: 32,
});

/** Generates a valid parent PID. */
const parentPidArb = fc.integer({ min: 1, max: 65535 });

/**
 * Alters exactly one byte of a hex-encoded buffer to produce a different value.
 * Guarantees the result differs from the original.
 */
const alterOneByteArb = (original: string): fc.Arbitrary<string> => {
  const byteLength = original.length / 2;
  return fc.record({
    position: fc.integer({ min: 0, max: byteLength - 1 }),
    delta: fc.integer({ min: 1, max: 255 }),
  }).map(({ position, delta }) => {
    const buf = Buffer.from(original, 'hex');
    buf[position] = (buf[position] + delta) % 256;
    return buf.toString('hex');
  });
};

/**
 * Generates an invalid client nonce:
 * - Wrong length (not 64 hex chars / 32 bytes)
 * - Invalid hex characters
 * - Empty string
 */
const invalidNonceArb = fc.oneof(
  // Too short (1-31 bytes as hex)
  fc.integer({ min: 1, max: 31 }).chain((len) =>
    fc.uint8Array({ minLength: len, maxLength: len }).map(
      (bytes) => Buffer.from(bytes).toString('hex'),
    ),
  ),
  // Too long (33-64 bytes as hex)
  fc.integer({ min: 33, max: 64 }).chain((len) =>
    fc.uint8Array({ minLength: len, maxLength: len }).map(
      (bytes) => Buffer.from(bytes).toString('hex'),
    ),
  ),
  // Contains non-hex characters
  fc.stringOf(fc.constantFrom(...'ghijklmnopqrstuvwxyz!@#$%^&*'.split('')), {
    minLength: 64,
    maxLength: 64,
  }),
  // Empty
  fc.constant(''),
);

// ────────────────────────────────────────────────────────────────────
// Tamper strategy enum for combined generation
// ────────────────────────────────────────────────────────────────────

enum TamperKind {
  WRONG_CREDENTIAL = 'WRONG_CREDENTIAL',
  WRONG_LAUNCH_ID = 'WRONG_LAUNCH_ID',
  WRONG_PARENT_PID = 'WRONG_PARENT_PID',
  WRONG_PROOF = 'WRONG_PROOF',
  WRONG_NONCE = 'WRONG_NONCE',
  COMBINED = 'COMBINED',
}

// ────────────────────────────────────────────────────────────────────
// Property Test
// ────────────────────────────────────────────────────────────────────

describe('Stage C Authentication — Property Tests', () => {
  describe('Property 5: Authentication before effects', () => {
    it('wrong credential: connection closed, zero AuthAccepted, canDispatch false', () => {
      fc.assert(
        fc.asyncProperty(
          credentialArb,
          launchIdArb,
          parentPidArb,
          validNonceArb,
          async (credential, launchId, parentPid, clientNonce) => {
            const bootstrap: BootstrapInfo = {
              launch_id: launchId,
              credential,
              parent_pid: parentPid,
            };

            // Generate a different credential (alter one byte)
            const wrongCredential = (() => {
              const buf = Buffer.from(credential, 'hex');
              buf[0] = (buf[0] + 1) % 256;
              return buf.toString('hex');
            })();

            // Compute proof with the wrong credential
            const serverChallenge = crypto.randomBytes(CHALLENGE_BYTES).toString('hex');

            const counters: EffectCounters = {
              authAcceptedSent: 0,
              nonChallengeSent: 0,
              connectionClosed: false,
            };

            // Build a connection where we intercept the challenge and compute a proof with wrong cred
            let capturedChallenge = '';
            let closed = false;

            const connection: AuthConnection = {
              send(msg: AuthMessage) {
                if (closed) throw new Error('closed');
                if (msg.type === AuthMessageType.AUTH_CHALLENGE) {
                  capturedChallenge = (msg as AuthChallengeMessage).server_challenge;
                }
                if (msg.type === AuthMessageType.AUTH_ACCEPTED) {
                  counters.authAcceptedSent++;
                }
                if (msg.type !== AuthMessageType.AUTH_CHALLENGE) {
                  counters.nonChallengeSent++;
                }
              },
              async receive() {
                if (closed) return null;
                // Compute proof with the WRONG credential
                const proof = computeClientProof(
                  wrongCredential,
                  capturedChallenge,
                  clientNonce,
                  launchId,
                );
                return {
                  type: AuthMessageType.CLIENT_HELLO,
                  launch_id: launchId,
                  client_nonce: clientNonce,
                  proof,
                  parent_pid: parentPid,
                } as ClientHelloMessage;
              },
              close() {
                closed = true;
                counters.connectionClosed = true;
              },
              get connected() { return !closed; },
            };

            const authenticator = new StageCAuthenticator();
            const result = await authenticator.authenticate(connection, bootstrap);

            // **Validates: Req 6.11** — connection closed
            expect(counters.connectionClosed).toBe(true);
            // **Validates: Req 6.11** — zero service invocations (no AuthAccepted sent)
            expect(counters.authAcceptedSent).toBe(0);
            expect(counters.nonChallengeSent).toBe(0);
            // **Validates: Req 6.9** — authenticator remains unauthenticated
            expect(authenticator.canDispatch()).toBe(false);
            expect(authenticator.authenticated).toBe(false);
            // Result must indicate a failure
            expect(result.result).toBe(AuthResult.INVALID_PROOF);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('wrong launch_id: connection closed, zero AuthAccepted, canDispatch false', () => {
      fc.assert(
        fc.asyncProperty(
          credentialArb,
          launchIdArb,
          launchIdArb,
          parentPidArb,
          validNonceArb,
          async (credential, correctLaunchId, wrongLaunchId, parentPid, clientNonce) => {
            // Ensure wrong launch_id is actually different
            fc.pre(wrongLaunchId !== correctLaunchId);

            const bootstrap: BootstrapInfo = {
              launch_id: correctLaunchId,
              credential,
              parent_pid: parentPid,
            };

            const counters: EffectCounters = {
              authAcceptedSent: 0,
              nonChallengeSent: 0,
              connectionClosed: false,
            };

            let capturedChallenge = '';
            let closed = false;

            const connection: AuthConnection = {
              send(msg: AuthMessage) {
                if (closed) throw new Error('closed');
                if (msg.type === AuthMessageType.AUTH_CHALLENGE) {
                  capturedChallenge = (msg as AuthChallengeMessage).server_challenge;
                }
                if (msg.type === AuthMessageType.AUTH_ACCEPTED) {
                  counters.authAcceptedSent++;
                }
                if (msg.type !== AuthMessageType.AUTH_CHALLENGE) {
                  counters.nonChallengeSent++;
                }
              },
              async receive() {
                if (closed) return null;
                // Compute proof correctly but send wrong launch_id in the message
                const proof = computeClientProof(
                  credential,
                  capturedChallenge,
                  clientNonce,
                  correctLaunchId,
                );
                return {
                  type: AuthMessageType.CLIENT_HELLO,
                  launch_id: wrongLaunchId,
                  client_nonce: clientNonce,
                  proof,
                  parent_pid: parentPid,
                } as ClientHelloMessage;
              },
              close() {
                closed = true;
                counters.connectionClosed = true;
              },
              get connected() { return !closed; },
            };

            const authenticator = new StageCAuthenticator();
            const result = await authenticator.authenticate(connection, bootstrap);

            expect(counters.connectionClosed).toBe(true);
            expect(counters.authAcceptedSent).toBe(0);
            expect(counters.nonChallengeSent).toBe(0);
            expect(authenticator.canDispatch()).toBe(false);
            expect(result.result).toBe(AuthResult.INVALID_LAUNCH_ID);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('wrong parent PID: connection closed, zero AuthAccepted, canDispatch false', () => {
      fc.assert(
        fc.asyncProperty(
          credentialArb,
          launchIdArb,
          parentPidArb,
          parentPidArb,
          validNonceArb,
          async (credential, launchId, correctPid, wrongPid, clientNonce) => {
            fc.pre(wrongPid !== correctPid);

            const bootstrap: BootstrapInfo = {
              launch_id: launchId,
              credential,
              parent_pid: correctPid,
            };

            const counters: EffectCounters = {
              authAcceptedSent: 0,
              nonChallengeSent: 0,
              connectionClosed: false,
            };

            let capturedChallenge = '';
            let closed = false;

            const connection: AuthConnection = {
              send(msg: AuthMessage) {
                if (closed) throw new Error('closed');
                if (msg.type === AuthMessageType.AUTH_CHALLENGE) {
                  capturedChallenge = (msg as AuthChallengeMessage).server_challenge;
                }
                if (msg.type === AuthMessageType.AUTH_ACCEPTED) {
                  counters.authAcceptedSent++;
                }
                if (msg.type !== AuthMessageType.AUTH_CHALLENGE) {
                  counters.nonChallengeSent++;
                }
              },
              async receive() {
                if (closed) return null;
                const proof = computeClientProof(
                  credential,
                  capturedChallenge,
                  clientNonce,
                  launchId,
                );
                return {
                  type: AuthMessageType.CLIENT_HELLO,
                  launch_id: launchId,
                  client_nonce: clientNonce,
                  proof,
                  parent_pid: wrongPid,
                } as ClientHelloMessage;
              },
              close() {
                closed = true;
                counters.connectionClosed = true;
              },
              get connected() { return !closed; },
            };

            const authenticator = new StageCAuthenticator();
            const result = await authenticator.authenticate(connection, bootstrap);

            expect(counters.connectionClosed).toBe(true);
            expect(counters.authAcceptedSent).toBe(0);
            expect(counters.nonChallengeSent).toBe(0);
            expect(authenticator.canDispatch()).toBe(false);
            expect(result.result).toBe(AuthResult.INVALID_PARENT);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('wrong proof (altered HMAC): connection closed, zero AuthAccepted, canDispatch false', () => {
      fc.assert(
        fc.asyncProperty(
          credentialArb,
          launchIdArb,
          parentPidArb,
          validNonceArb,
          fc.integer({ min: 0, max: 31 }),
          fc.integer({ min: 1, max: 255 }),
          async (credential, launchId, parentPid, clientNonce, bytePos, delta) => {
            const bootstrap: BootstrapInfo = {
              launch_id: launchId,
              credential,
              parent_pid: parentPid,
            };

            const counters: EffectCounters = {
              authAcceptedSent: 0,
              nonChallengeSent: 0,
              connectionClosed: false,
            };

            let capturedChallenge = '';
            let closed = false;

            const connection: AuthConnection = {
              send(msg: AuthMessage) {
                if (closed) throw new Error('closed');
                if (msg.type === AuthMessageType.AUTH_CHALLENGE) {
                  capturedChallenge = (msg as AuthChallengeMessage).server_challenge;
                }
                if (msg.type === AuthMessageType.AUTH_ACCEPTED) {
                  counters.authAcceptedSent++;
                }
                if (msg.type !== AuthMessageType.AUTH_CHALLENGE) {
                  counters.nonChallengeSent++;
                }
              },
              async receive() {
                if (closed) return null;
                // Compute correct proof then alter one byte
                const correctProof = computeClientProof(
                  credential,
                  capturedChallenge,
                  clientNonce,
                  launchId,
                );
                const proofBuf = Buffer.from(correctProof, 'hex');
                proofBuf[bytePos] = (proofBuf[bytePos] + delta) % 256;
                const tamperedProof = proofBuf.toString('hex');

                return {
                  type: AuthMessageType.CLIENT_HELLO,
                  launch_id: launchId,
                  client_nonce: clientNonce,
                  proof: tamperedProof,
                  parent_pid: parentPid,
                } as ClientHelloMessage;
              },
              close() {
                closed = true;
                counters.connectionClosed = true;
              },
              get connected() { return !closed; },
            };

            const authenticator = new StageCAuthenticator();
            const result = await authenticator.authenticate(connection, bootstrap);

            expect(counters.connectionClosed).toBe(true);
            expect(counters.authAcceptedSent).toBe(0);
            expect(counters.nonChallengeSent).toBe(0);
            expect(authenticator.canDispatch()).toBe(false);
            expect(result.result).toBe(AuthResult.INVALID_PROOF);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('invalid client nonce (wrong format/length): connection closed, zero AuthAccepted, canDispatch false', () => {
      fc.assert(
        fc.asyncProperty(
          credentialArb,
          launchIdArb,
          parentPidArb,
          invalidNonceArb,
          async (credential, launchId, parentPid, badNonce) => {
            const bootstrap: BootstrapInfo = {
              launch_id: launchId,
              credential,
              parent_pid: parentPid,
            };

            const counters: EffectCounters = {
              authAcceptedSent: 0,
              nonChallengeSent: 0,
              connectionClosed: false,
            };

            let closed = false;

            const connection: AuthConnection = {
              send(msg: AuthMessage) {
                if (closed) throw new Error('closed');
                if (msg.type === AuthMessageType.AUTH_ACCEPTED) {
                  counters.authAcceptedSent++;
                }
                if (msg.type !== AuthMessageType.AUTH_CHALLENGE) {
                  counters.nonChallengeSent++;
                }
              },
              async receive() {
                if (closed) return null;
                // Send ClientHello with bad nonce — this will fail validateClientHello
                return {
                  type: AuthMessageType.CLIENT_HELLO,
                  launch_id: launchId,
                  client_nonce: badNonce,
                  proof: crypto.randomBytes(32).toString('hex'),
                  parent_pid: parentPid,
                } as ClientHelloMessage;
              },
              close() {
                closed = true;
                counters.connectionClosed = true;
              },
              get connected() { return !closed; },
            };

            const authenticator = new StageCAuthenticator();
            const result = await authenticator.authenticate(connection, bootstrap);

            // Invalid nonce causes INVALID_MESSAGE (fails validateClientHello)
            expect(counters.connectionClosed).toBe(true);
            expect(counters.authAcceptedSent).toBe(0);
            expect(counters.nonChallengeSent).toBe(0);
            expect(authenticator.canDispatch()).toBe(false);
            expect(result.result).toBe(AuthResult.INVALID_MESSAGE);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('combined tamper (multiple fields wrong): connection closed, zero AuthAccepted, canDispatch false', () => {
      // Generate cases where multiple fields are tampered simultaneously
      fc.assert(
        fc.asyncProperty(
          credentialArb,
          launchIdArb,
          parentPidArb,
          validNonceArb,
          fc.record({
            tamperLaunchId: fc.boolean(),
            tamperParentPid: fc.boolean(),
            tamperProof: fc.boolean(),
          }),
          launchIdArb,
          parentPidArb,
          async (credential, launchId, parentPid, clientNonce, tamperFlags, altLaunchId, altPid) => {
            // Ensure at least one tamper is active
            fc.pre(tamperFlags.tamperLaunchId || tamperFlags.tamperParentPid || tamperFlags.tamperProof);
            // Ensure alt values differ
            fc.pre(!tamperFlags.tamperLaunchId || altLaunchId !== launchId);
            fc.pre(!tamperFlags.tamperParentPid || altPid !== parentPid);

            const bootstrap: BootstrapInfo = {
              launch_id: launchId,
              credential,
              parent_pid: parentPid,
            };

            const counters: EffectCounters = {
              authAcceptedSent: 0,
              nonChallengeSent: 0,
              connectionClosed: false,
            };

            let capturedChallenge = '';
            let closed = false;

            const connection: AuthConnection = {
              send(msg: AuthMessage) {
                if (closed) throw new Error('closed');
                if (msg.type === AuthMessageType.AUTH_CHALLENGE) {
                  capturedChallenge = (msg as AuthChallengeMessage).server_challenge;
                }
                if (msg.type === AuthMessageType.AUTH_ACCEPTED) {
                  counters.authAcceptedSent++;
                }
                if (msg.type !== AuthMessageType.AUTH_CHALLENGE) {
                  counters.nonChallengeSent++;
                }
              },
              async receive() {
                if (closed) return null;

                const msgLaunchId = tamperFlags.tamperLaunchId ? altLaunchId : launchId;
                const msgParentPid = tamperFlags.tamperParentPid ? altPid : parentPid;

                // Compute proof with correct values (proof tamper makes it wrong)
                let proof = computeClientProof(
                  credential,
                  capturedChallenge,
                  clientNonce,
                  launchId,
                );

                if (tamperFlags.tamperProof) {
                  // Flip the first byte of the proof
                  const buf = Buffer.from(proof, 'hex');
                  buf[0] = (buf[0] + 1) % 256;
                  proof = buf.toString('hex');
                }

                return {
                  type: AuthMessageType.CLIENT_HELLO,
                  launch_id: msgLaunchId,
                  client_nonce: clientNonce,
                  proof,
                  parent_pid: msgParentPid,
                } as ClientHelloMessage;
              },
              close() {
                closed = true;
                counters.connectionClosed = true;
              },
              get connected() { return !closed; },
            };

            const authenticator = new StageCAuthenticator();
            const result = await authenticator.authenticate(connection, bootstrap);

            // Regardless of which field(s) are tampered:
            expect(counters.connectionClosed).toBe(true);
            expect(counters.authAcceptedSent).toBe(0);
            expect(counters.nonChallengeSent).toBe(0);
            expect(authenticator.canDispatch()).toBe(false);
            expect(result.result).not.toBe(AuthResult.SUCCESS);
          },
        ),
        { numRuns: 150 },
      );
    });
  });
});
