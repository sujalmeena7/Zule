/**
 * Stage C IPC — Mutual Challenge-Response Authentication
 *
 * Implements the mutual authentication protocol between App Core (server)
 * and the Stage C Sidecar (client) per the design pseudocode.
 *
 * Flow:
 * 1. Server generates 32-byte challenge → sends AuthChallenge(launch_id, challenge)
 * 2. Client responds with ClientHello(launch_id, client_nonce, proof)
 * 3. Server verifies proof = HMAC-SHA256(credential, "zule-stage-c-client-v1" || challenge || client_nonce || launch_id)
 * 4. Server sends AuthAccepted(server_proof) where server_proof = HMAC-SHA256(credential, "zule-stage-c-server-v1" || client_nonce || challenge || launch_id)
 *
 * Requirements: 6.9–6.12
 */

import * as crypto from 'crypto';

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

/** HMAC domain separator for client proof computation. */
export const CLIENT_PROOF_PREFIX = 'zule-stage-c-client-v1';

/** HMAC domain separator for server proof computation. */
export const SERVER_PROOF_PREFIX = 'zule-stage-c-server-v1';

/** Authentication threshold — emit content-free event if auth exceeds this. */
export const AUTH_THRESHOLD_MS = 2000;

/** Absolute startup deadline — authentication must complete before this. */
export const AUTH_DEADLINE_MS = 3000;

/** Size of the server challenge in bytes. */
export const CHALLENGE_BYTES = 32;

/** Size of expected client nonce in bytes. */
export const CLIENT_NONCE_BYTES = 32;

// ────────────────────────────────────────────────────────────────────
// Authentication Message Types
// ────────────────────────────────────────────────────────────────────

/** Message type identifiers for the authentication sub-protocol. */
export enum AuthMessageType {
  AUTH_CHALLENGE = 'auth.challenge',
  CLIENT_HELLO = 'auth.clientHello',
  AUTH_ACCEPTED = 'auth.accepted',
}

/** Server → Client: initial challenge message. */
export interface AuthChallengeMessage {
  type: AuthMessageType.AUTH_CHALLENGE;
  launch_id: string;
  server_challenge: string; // hex-encoded 32 bytes
}

/** Client → Server: response with proof of credential possession. */
export interface ClientHelloMessage {
  type: AuthMessageType.CLIENT_HELLO;
  launch_id: string;
  client_nonce: string; // hex-encoded 32 bytes
  proof: string; // hex-encoded HMAC-SHA256
  parent_pid: number;
}

/** Server → Client: mutual authentication acceptance with server proof. */
export interface AuthAcceptedMessage {
  type: AuthMessageType.AUTH_ACCEPTED;
  server_proof: string; // hex-encoded HMAC-SHA256
}

/** Union of all authentication messages. */
export type AuthMessage = AuthChallengeMessage | ClientHelloMessage | AuthAcceptedMessage;

// ────────────────────────────────────────────────────────────────────
// Authentication Result
// ────────────────────────────────────────────────────────────────────

export enum AuthResult {
  SUCCESS = 'SUCCESS',
  INVALID_LAUNCH_ID = 'INVALID_LAUNCH_ID',
  INVALID_PROOF = 'INVALID_PROOF',
  INVALID_PARENT = 'INVALID_PARENT',
  INVALID_NONCE = 'INVALID_NONCE',
  INVALID_MESSAGE = 'INVALID_MESSAGE',
  DEADLINE_EXPIRED = 'DEADLINE_EXPIRED',
  CONNECTION_CLOSED = 'CONNECTION_CLOSED',
}

export interface AuthSuccess {
  result: AuthResult.SUCCESS;
  clientNonce: string;
  thresholdExceeded: boolean;
}

export interface AuthFailure {
  result: Exclude<AuthResult, AuthResult.SUCCESS>;
  thresholdExceeded: boolean;
}

export type AuthOutcome = AuthSuccess | AuthFailure;

// ────────────────────────────────────────────────────────────────────
// Bootstrap Info — provided by the pipe endpoint (task 20.1)
// ────────────────────────────────────────────────────────────────────

export interface BootstrapInfo {
  /** Unique launch identifier for this sidecar instance. */
  launch_id: string;
  /** 32-byte credential (hex-encoded) shared between server and client. */
  credential: string;
  /** Parent process ID for identity verification. */
  parent_pid: number;
}

/**
 * Creates a BootstrapInfo from the BootstrapRecord produced by namedPipe.ts.
 * Maps camelCase BootstrapRecord fields to the snake_case used in auth messages.
 */
export function bootstrapInfoFromRecord(record: {
  launchId: string;
  credential: string;
  parentPid: number;
}): BootstrapInfo {
  return {
    launch_id: record.launchId,
    credential: record.credential,
    parent_pid: record.parentPid,
  };
}

// ────────────────────────────────────────────────────────────────────
// Connection Abstraction
// ────────────────────────────────────────────────────────────────────

/**
 * Minimal connection interface for authentication.
 * Abstracts the underlying named-pipe transport so the authenticator
 * can be tested without real pipes.
 */
export interface AuthConnection {
  /** Send a serialized authentication message to the peer. */
  send(message: AuthMessage): void;

  /**
   * Receive the next authentication message from the peer.
   * Returns null if the connection closed or the deadline expired.
   */
  receive(deadlineMs: number): Promise<AuthMessage | null>;

  /** Close the connection without side effects. */
  close(): void;

  /** Whether the connection is still open. */
  readonly connected: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Threshold Event Callback
// ────────────────────────────────────────────────────────────────────

/**
 * Content-free threshold event emitter.
 * Called when authentication exceeds AUTH_THRESHOLD_MS but has not yet failed.
 */
export type ThresholdEventEmitter = () => void;

// ────────────────────────────────────────────────────────────────────
// HMAC Computation
// ────────────────────────────────────────────────────────────────────

/**
 * Computes the client proof HMAC.
 * proof = HMAC-SHA256(credential, "zule-stage-c-client-v1" || server_challenge || client_nonce || launch_id)
 */
export function computeClientProof(
  credential: string,
  serverChallenge: string,
  clientNonce: string,
  launchId: string,
): string {
  const key = Buffer.from(credential, 'hex');
  const data = Buffer.concat([
    Buffer.from(CLIENT_PROOF_PREFIX, 'utf-8'),
    Buffer.from(serverChallenge, 'hex'),
    Buffer.from(clientNonce, 'hex'),
    Buffer.from(launchId, 'utf-8'),
  ]);
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

/**
 * Computes the server proof HMAC.
 * proof = HMAC-SHA256(credential, "zule-stage-c-server-v1" || client_nonce || server_challenge || launch_id)
 */
export function computeServerProof(
  credential: string,
  clientNonce: string,
  serverChallenge: string,
  launchId: string,
): string {
  const key = Buffer.from(credential, 'hex');
  const data = Buffer.concat([
    Buffer.from(SERVER_PROOF_PREFIX, 'utf-8'),
    Buffer.from(clientNonce, 'hex'),
    Buffer.from(serverChallenge, 'hex'),
    Buffer.from(launchId, 'utf-8'),
  ]);
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

// ────────────────────────────────────────────────────────────────────
// Validation Helpers
// ────────────────────────────────────────────────────────────────────

/** Validates that a hex string is exactly the expected byte length. */
export function isValidHex(value: unknown, expectedBytes: number): boolean {
  if (typeof value !== 'string') return false;
  if (value.length !== expectedBytes * 2) return false;
  return /^[0-9a-f]+$/i.test(value);
}

/** Validates a ClientHello message structure. */
export function validateClientHello(msg: unknown): msg is ClientHelloMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return (
    obj.type === AuthMessageType.CLIENT_HELLO &&
    typeof obj.launch_id === 'string' &&
    isValidHex(obj.client_nonce, CLIENT_NONCE_BYTES) &&
    isValidHex(obj.proof, 32) && // SHA-256 = 32 bytes
    typeof obj.parent_pid === 'number' &&
    Number.isInteger(obj.parent_pid)
  );
}

// ────────────────────────────────────────────────────────────────────
// Server-Side Authenticator
// ────────────────────────────────────────────────────────────────────

/**
 * StageCAuthenticator — Server-side mutual authentication.
 *
 * Implements the PROCEDURE Authenticate(connection, bootstrap) from the design.
 * This is the App Core (Electron) side that:
 * 1. Generates and sends the challenge
 * 2. Validates the client's proof
 * 3. Sends the server proof
 * 4. Marks the connection authenticated
 *
 * Enforces:
 * - 2-second threshold event (content-free) inside the absolute startup deadline
 * - Connection closure on any validation failure with zero state mutations
 * - Only authentication messages accepted before authentication completes
 */
export class StageCAuthenticator {
  private _authenticated = false;
  private _serverChallenge: string | null = null;
  private _startTime: number | null = null;

  /** Whether this connection has been successfully authenticated. */
  get authenticated(): boolean {
    return this._authenticated;
  }

  /** The server challenge generated during this authentication attempt. */
  get serverChallenge(): string | null {
    return this._serverChallenge;
  }

  /**
   * Execute the full mutual authentication handshake.
   *
   * @param connection - The transport connection to authenticate
   * @param bootstrap - Launch credentials and identity info
   * @param onThresholdExceeded - Called (once) if auth takes >2s
   * @param startDeadlineMs - Absolute deadline from launch start (default 3000ms)
   * @returns AuthOutcome indicating success or typed failure
   */
  async authenticate(
    connection: AuthConnection,
    bootstrap: BootstrapInfo,
    onThresholdExceeded?: ThresholdEventEmitter,
    startDeadlineMs: number = AUTH_DEADLINE_MS,
  ): Promise<AuthOutcome> {
    this._authenticated = false;
    this._startTime = Date.now();

    // Step 1: Generate server challenge
    this._serverChallenge = crypto.randomBytes(CHALLENGE_BYTES).toString('hex');

    // Step 2: Send AuthChallenge
    const challengeMsg: AuthChallengeMessage = {
      type: AuthMessageType.AUTH_CHALLENGE,
      launch_id: bootstrap.launch_id,
      server_challenge: this._serverChallenge,
    };

    try {
      connection.send(challengeMsg);
    } catch {
      return { result: AuthResult.CONNECTION_CLOSED, thresholdExceeded: false };
    }

    // Step 3: Set up threshold timer
    let thresholdExceeded = false;
    let thresholdTimer: ReturnType<typeof setTimeout> | null = null;

    if (onThresholdExceeded) {
      thresholdTimer = setTimeout(() => {
        thresholdExceeded = true;
        onThresholdExceeded();
      }, AUTH_THRESHOLD_MS);
    }

    try {
      // Step 4: Receive ClientHello before deadline
      const remainingMs = startDeadlineMs - (Date.now() - this._startTime);
      if (remainingMs <= 0) {
        return { result: AuthResult.DEADLINE_EXPIRED, thresholdExceeded };
      }

      const response = await connection.receive(remainingMs);

      // Check threshold after receive returns
      if (!thresholdExceeded && this._startTime && (Date.now() - this._startTime) > AUTH_THRESHOLD_MS) {
        thresholdExceeded = true;
        if (onThresholdExceeded) onThresholdExceeded();
      }

      if (response === null) {
        if (!connection.connected) {
          return { result: AuthResult.CONNECTION_CLOSED, thresholdExceeded };
        }
        return { result: AuthResult.DEADLINE_EXPIRED, thresholdExceeded };
      }

      // Step 5: Validate message is a ClientHello
      if (!validateClientHello(response)) {
        connection.close();
        return { result: AuthResult.INVALID_MESSAGE, thresholdExceeded };
      }

      const clientHello = response as ClientHelloMessage;

      // Step 6: Verify launch_id matches
      if (clientHello.launch_id !== bootstrap.launch_id) {
        connection.close();
        return { result: AuthResult.INVALID_LAUNCH_ID, thresholdExceeded };
      }

      // Step 7: Verify parent identity
      if (clientHello.parent_pid !== bootstrap.parent_pid) {
        connection.close();
        return { result: AuthResult.INVALID_PARENT, thresholdExceeded };
      }

      // Step 8: Verify client nonce format
      if (!isValidHex(clientHello.client_nonce, CLIENT_NONCE_BYTES)) {
        connection.close();
        return { result: AuthResult.INVALID_NONCE, thresholdExceeded };
      }

      // Step 9: Verify client proof
      const expectedProof = computeClientProof(
        bootstrap.credential,
        this._serverChallenge,
        clientHello.client_nonce,
        bootstrap.launch_id,
      );

      if (!crypto.timingSafeEqual(
        Buffer.from(clientHello.proof, 'hex'),
        Buffer.from(expectedProof, 'hex'),
      )) {
        connection.close();
        return { result: AuthResult.INVALID_PROOF, thresholdExceeded };
      }

      // Step 10: Compute and send server proof
      const serverProof = computeServerProof(
        bootstrap.credential,
        clientHello.client_nonce,
        this._serverChallenge,
        bootstrap.launch_id,
      );

      const acceptedMsg: AuthAcceptedMessage = {
        type: AuthMessageType.AUTH_ACCEPTED,
        server_proof: serverProof,
      };

      try {
        connection.send(acceptedMsg);
      } catch {
        return { result: AuthResult.CONNECTION_CLOSED, thresholdExceeded };
      }

      // Step 11: Mark connection authenticated
      this._authenticated = true;

      return {
        result: AuthResult.SUCCESS,
        clientNonce: clientHello.client_nonce,
        thresholdExceeded,
      };
    } finally {
      if (thresholdTimer !== null) {
        clearTimeout(thresholdTimer);
      }
    }
  }

  /**
   * Gate for non-authentication message dispatch.
   * Returns true only if the connection is authenticated.
   * Non-authenticated connections must not receive dispatched messages.
   */
  canDispatch(): boolean {
    return this._authenticated;
  }

  /**
   * Resets the authenticator state.
   * Used when a connection is closed and credentials invalidated.
   */
  reset(): void {
    this._authenticated = false;
    this._serverChallenge = null;
    this._startTime = null;
  }
}

// ────────────────────────────────────────────────────────────────────
// Pre-Authentication Dispatch Guard
// ────────────────────────────────────────────────────────────────────

/**
 * Checks if an incoming message is an authentication message.
 * Only authentication messages are accepted before authentication completes.
 */
export function isAuthenticationMessage(msg: unknown): boolean {
  if (typeof msg !== 'object' || msg === null) return false;
  const obj = msg as Record<string, unknown>;
  return (
    obj.type === AuthMessageType.AUTH_CHALLENGE ||
    obj.type === AuthMessageType.CLIENT_HELLO ||
    obj.type === AuthMessageType.AUTH_ACCEPTED
  );
}

/**
 * Validates that a message should be accepted given the current authentication state.
 * - Before auth: only authentication messages are accepted
 * - After auth: only non-authentication (protocol) messages are accepted
 *
 * Returns true if the message should be processed, false if it should be rejected.
 */
export function shouldAcceptMessage(
  authenticated: boolean,
  msg: unknown,
): boolean {
  const isAuth = isAuthenticationMessage(msg);
  if (!authenticated) {
    // Before authentication: accept only auth messages
    return isAuth;
  }
  // After authentication: accept only non-auth (protocol) messages
  return !isAuth;
}
