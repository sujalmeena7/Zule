/**
 * Stage C IPC — Framed Strict Dispatch
 *
 * Implements:
 * - Frame parsing: 32-bit LE byte length, reject > MAX_FRAME_BYTES before allocation
 * - UTF-8/JSON validation: strict UTF-8 before JSON parsing
 * - Strict schema dispatch: exact schema, correct protocol version, valid message type
 * - Directional allowlists: validate incoming message types match expected direction
 * - Revision validation: for state patches, validate base_revision matches expected
 * - Replay cache: store terminal outcomes by messageId (max MAX_REPLAY_CACHE_ENTRIES)
 * - Backpressure: track queued messages/bytes, close on overflow, begin fallback
 * - Rejection recording: only category, direction, safely decoded type, byte count
 * - Noninterference: if recording fails, preserve rejection/fallback behavior
 *
 * Requirements: 6.13–6.27
 */

import {
  MAX_FRAME_BYTES,
  MAX_REPLAY_CACHE_ENTRIES,
  MAX_QUEUED_MESSAGES,
  MAX_QUEUED_BYTES,
  MessageDirection,
  ValidationErrorCode,
  CONTROLLER_TO_SIDECAR_TYPES,
  SIDECAR_TO_CONTROLLER_TYPES,
  validateMessageDirection,
  type AllowedMessageType,
} from '../protocol/schema';

import {
  readFrameLength,
  validateFrameSize,
  isStrictUtf8,
  deserializeEnvelope,
  type ProtocolEnvelope,
} from '../protocol/envelope';

import { shouldAcceptMessage } from './authenticator';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

/** Categories for rejection recording (Req 6.26). */
export enum RejectionCategory {
  SIZE_EXCEEDED = 'SIZE_EXCEEDED',
  INVALID_UTF8 = 'INVALID_UTF8',
  INVALID_JSON = 'INVALID_JSON',
  SCHEMA_VIOLATION = 'SCHEMA_VIOLATION',
  WRONG_DIRECTION = 'WRONG_DIRECTION',
  INCOMPATIBLE_PROTOCOL = 'INCOMPATIBLE_PROTOCOL',
  INVALID_REVISION = 'INVALID_REVISION',
  DUPLICATE_MESSAGE = 'DUPLICATE_MESSAGE',
  NOT_AUTHENTICATED = 'NOT_AUTHENTICATED',
  QUEUE_OVERFLOW = 'QUEUE_OVERFLOW',
  UNKNOWN_TYPE = 'UNKNOWN_TYPE',
}

/** Safe rejection metadata (Req 6.26): only category, direction, decoded type, byte count. */
export interface RejectionMetadata {
  category: RejectionCategory;
  direction: MessageDirection | null;
  type: string | null;
  byteCount: number;
}

/** Result of dispatching a frame. */
export type DispatchResult =
  | { ok: true; envelope: ProtocolEnvelope; duplicate: false }
  | { ok: true; envelope: ProtocolEnvelope; duplicate: true; cachedOutcome: unknown }
  | { ok: false; rejection: RejectionMetadata };

/** Terminal outcome stored in replay cache. */
export interface CachedOutcome {
  messageId: string;
  type: string;
  outcome: unknown;
}

/** Callback invoked when the connection must be closed and fallback initiated. */
export type FallbackCallback = (reason: string) => void;

/** Callback invoked to record a rejection event. May throw; failures are non-interfering. */
export type RejectionRecorder = (metadata: RejectionMetadata) => void;

// ────────────────────────────────────────────────────────────────────
// Dispatcher Configuration
// ────────────────────────────────────────────────────────────────────

export interface DispatcherConfig {
  /** The direction messages are expected from (e.g., sidecar→controller means incoming is sidecar messages). */
  expectedIncomingDirection: MessageDirection;

  /** Whether the connection is authenticated. Called per-dispatch for live state. */
  isAuthenticated: () => boolean;

  /** Current expected base revision for state patches (-1 to skip revision validation). */
  getExpectedRevision: () => number;

  /** Called when the connection must close due to queue overflow. */
  onFallback: FallbackCallback;

  /** Called to record a rejection event. May throw; failures are ignored (Req 6.27). */
  onRejection?: RejectionRecorder;
}

// ────────────────────────────────────────────────────────────────────
// Dispatcher Class
// ────────────────────────────────────────────────────────────────────

/**
 * StageC IPC Dispatcher — strict frame parsing, validation, replay, and backpressure.
 *
 * All rejections produce zero state mutations and zero service invocations.
 */
export class StageCDispatcher {
  private readonly config: DispatcherConfig;

  /** Replay cache: messageId → terminal outcome. Bounded by MAX_REPLAY_CACHE_ENTRIES. */
  private readonly replayCache = new Map<string, CachedOutcome>();

  /** LRU order for replay cache eviction. */
  private readonly replayCacheOrder: string[] = [];

  /** Count of currently queued messages. */
  private queuedMessageCount = 0;

  /** Aggregate byte count of currently queued messages. */
  private queuedByteCount = 0;

  /** Whether the dispatcher has been closed due to overflow. */
  private closed = false;

  constructor(config: DispatcherConfig) {
    this.config = config;
  }

  // ──────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────

  /** Whether the dispatcher is closed (queue overflow triggered fallback). */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Current queued message count. */
  get currentQueuedMessages(): number {
    return this.queuedMessageCount;
  }

  /** Current aggregate queued bytes. */
  get currentQueuedBytes(): number {
    return this.queuedByteCount;
  }

  /** Current replay cache size. */
  get replayCacheSize(): number {
    return this.replayCache.size;
  }

  /**
   * Dispatch a raw frame buffer.
   *
   * Performs all validation in strict order:
   * 1. Parse 32-bit LE length, reject > MAX_FRAME_BYTES before allocation
   * 2. Validate strict UTF-8 before JSON parsing
   * 3. Parse envelope with exact-schema validation
   * 4. Check authentication gating
   * 5. Validate directional allowlist
   * 6. Check replay cache for duplicate messageId
   * 7. Validate revision for state patches
   * 8. Apply backpressure checks
   *
   * Returns DispatchResult on success or rejection metadata on failure.
   * Every rejection has zero state mutations and zero service invocations.
   */
  dispatchFrame(frame: Buffer): DispatchResult {
    if (this.closed) {
      const rejection = this.makeRejection(
        RejectionCategory.QUEUE_OVERFLOW,
        null,
        null,
        frame.length,
      );
      this.safeRecordRejection(rejection);
      return { ok: false, rejection };
    }

    const byteCount = frame.length;

    // Step 1: Parse 32-bit LE length and validate before allocation
    const declaredLength = readFrameLength(frame);
    if (declaredLength === null) {
      const rejection = this.makeRejection(
        RejectionCategory.SCHEMA_VIOLATION,
        null,
        null,
        byteCount,
      );
      this.safeRecordRejection(rejection);
      return { ok: false, rejection };
    }

    const sizeResult = validateFrameSize(declaredLength);
    if (!sizeResult.valid) {
      const rejection = this.makeRejection(
        RejectionCategory.SIZE_EXCEEDED,
        null,
        null,
        byteCount,
      );
      this.safeRecordRejection(rejection);
      return { ok: false, rejection };
    }

    // Step 2: Validate strict UTF-8 on the body portion
    const body = frame.subarray(4, 4 + declaredLength);
    if (body.length < declaredLength) {
      const rejection = this.makeRejection(
        RejectionCategory.SCHEMA_VIOLATION,
        null,
        null,
        byteCount,
      );
      this.safeRecordRejection(rejection);
      return { ok: false, rejection };
    }

    if (!isStrictUtf8(body)) {
      const rejection = this.makeRejection(
        RejectionCategory.INVALID_UTF8,
        null,
        null,
        byteCount,
      );
      this.safeRecordRejection(rejection);
      return { ok: false, rejection };
    }

    // Step 3: Deserialize envelope with full schema validation
    const deserResult = deserializeEnvelope(frame);
    if (deserResult.envelope === null) {
      // Determine rejection category from validation errors
      const category = this.categorizeValidationErrors(deserResult.errors);
      // Try to safely decode type from body for metadata
      const safeType = this.safeDecodeType(body);
      const rejection = this.makeRejection(category, null, safeType, byteCount);
      this.safeRecordRejection(rejection);
      return { ok: false, rejection };
    }

    const envelope = deserResult.envelope;

    // Step 4: Check authentication gating
    const authenticated = this.config.isAuthenticated();
    if (!shouldAcceptMessage(authenticated, { type: envelope.type })) {
      const rejection = this.makeRejection(
        RejectionCategory.NOT_AUTHENTICATED,
        this.config.expectedIncomingDirection,
        envelope.type,
        byteCount,
      );
      this.safeRecordRejection(rejection);
      return { ok: false, rejection };
    }

    // Step 5: Validate directional allowlist
    const directionResult = validateMessageDirection(
      envelope.type,
      this.config.expectedIncomingDirection,
    );
    if (!directionResult.valid) {
      const rejection = this.makeRejection(
        RejectionCategory.WRONG_DIRECTION,
        this.config.expectedIncomingDirection,
        envelope.type,
        byteCount,
      );
      this.safeRecordRejection(rejection);
      return { ok: false, rejection };
    }

    // Step 6: Check replay cache
    const cachedEntry = this.replayCache.get(envelope.messageId);
    if (cachedEntry !== undefined) {
      // Duplicate messageId — return cached outcome with zero repeated mutations
      const rejection = this.makeRejection(
        RejectionCategory.DUPLICATE_MESSAGE,
        this.config.expectedIncomingDirection,
        envelope.type,
        byteCount,
      );
      this.safeRecordRejection(rejection);
      return { ok: true, envelope, duplicate: true, cachedOutcome: cachedEntry.outcome };
    }

    // Step 7: Validate revision for state patches
    if (envelope.type === 'state.patch' || envelope.type === 'state.patchAck') {
      const expectedRevision = this.config.getExpectedRevision();
      if (expectedRevision >= 0) {
        const payload = envelope.payload as Record<string, unknown>;
        const baseRevision = payload.base_revision ?? payload.revision;
        if (typeof baseRevision === 'number' && baseRevision !== expectedRevision) {
          const rejection = this.makeRejection(
            RejectionCategory.INVALID_REVISION,
            this.config.expectedIncomingDirection,
            envelope.type,
            byteCount,
          );
          this.safeRecordRejection(rejection);
          return { ok: false, rejection };
        }
      }
    }

    // Step 8: Backpressure check
    if (
      this.queuedMessageCount >= MAX_QUEUED_MESSAGES ||
      this.queuedByteCount + byteCount > MAX_QUEUED_BYTES
    ) {
      this.closed = true;
      const rejection = this.makeRejection(
        RejectionCategory.QUEUE_OVERFLOW,
        this.config.expectedIncomingDirection,
        envelope.type,
        byteCount,
      );
      this.safeRecordRejection(rejection);
      // Begin fallback — close connection
      try {
        this.config.onFallback('queue_overflow');
      } catch {
        // Noninterference: fallback callback failure does not suppress rejection
      }
      return { ok: false, rejection };
    }

    // Enqueue: track message count and bytes
    this.queuedMessageCount++;
    this.queuedByteCount += byteCount;

    return { ok: true, envelope, duplicate: false };
  }

  /**
   * Record a terminal outcome for a processed message (for replay cache).
   * Must be called after a message is fully processed.
   */
  recordOutcome(messageId: string, type: string, outcome: unknown): void {
    if (this.replayCache.has(messageId)) {
      return; // Already cached
    }

    // Enforce cache size limit
    if (this.replayCache.size >= MAX_REPLAY_CACHE_ENTRIES) {
      // Evict oldest entry (FIFO)
      const oldestId = this.replayCacheOrder.shift();
      if (oldestId !== undefined) {
        this.replayCache.delete(oldestId);
      }
    }

    this.replayCache.set(messageId, { messageId, type, outcome });
    this.replayCacheOrder.push(messageId);
  }

  /**
   * Acknowledge that a message has been dequeued and processed.
   * Reduces the queued message count and byte total.
   */
  acknowledgeProcessed(byteCount: number): void {
    this.queuedMessageCount = Math.max(0, this.queuedMessageCount - 1);
    this.queuedByteCount = Math.max(0, this.queuedByteCount - byteCount);
  }

  /**
   * Reset the dispatcher state (e.g., on disconnect).
   */
  reset(): void {
    this.replayCache.clear();
    this.replayCacheOrder.length = 0;
    this.queuedMessageCount = 0;
    this.queuedByteCount = 0;
    this.closed = false;
  }

  // ──────────────────────────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────────────────────────

  /** Construct a RejectionMetadata with only safe fields (Req 6.26). */
  private makeRejection(
    category: RejectionCategory,
    direction: MessageDirection | null,
    type: string | null,
    byteCount: number,
  ): RejectionMetadata {
    return {
      category,
      direction,
      type: type !== null ? this.sanitizeType(type) : null,
      byteCount,
    };
  }

  /**
   * Safely record a rejection. If recording fails, preserve rejection/fallback (Req 6.27).
   */
  private safeRecordRejection(metadata: RejectionMetadata): void {
    if (!this.config.onRejection) return;
    try {
      this.config.onRejection(metadata);
    } catch {
      // Noninterference: recording failure does not alter rejection or fallback behavior (Req 6.27)
    }
  }

  /**
   * Sanitize a type string for safe recording.
   * Only record known type values or truncate/replace unknown ones.
   */
  private sanitizeType(type: string): string {
    if (CONTROLLER_TO_SIDECAR_TYPES.has(type) || SIDECAR_TO_CONTROLLER_TYPES.has(type)) {
      return type;
    }
    // For unknown types, record only the first 64 characters (safely decoded)
    if (type.length > 64) {
      return type.substring(0, 64);
    }
    return type;
  }

  /**
   * Attempt to safely decode the 'type' field from raw JSON body bytes.
   * Returns null if decoding fails. Never throws.
   */
  private safeDecodeType(body: Buffer): string | null {
    try {
      const text = body.toString('utf-8');
      const parsed = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string') {
        return parsed.type;
      }
    } catch {
      // Cannot decode — return null
    }
    return null;
  }

  /**
   * Categorize validation errors into a rejection category.
   */
  private categorizeValidationErrors(
    errors: Array<{ code: string; message: string; field?: string }>,
  ): RejectionCategory {
    if (errors.length === 0) return RejectionCategory.SCHEMA_VIOLATION;

    const firstCode = errors[0].code;
    switch (firstCode) {
      case ValidationErrorCode.SIZE_EXCEEDED:
        return RejectionCategory.SIZE_EXCEEDED;
      case ValidationErrorCode.INCOMPATIBLE_PROTOCOL:
        return RejectionCategory.INCOMPATIBLE_PROTOCOL;
      case ValidationErrorCode.WRONG_DIRECTION:
        return RejectionCategory.WRONG_DIRECTION;
      case ValidationErrorCode.UNKNOWN_MESSAGE_TYPE:
        return RejectionCategory.UNKNOWN_TYPE;
      case ValidationErrorCode.INVALID_REVISION:
        return RejectionCategory.INVALID_REVISION;
      default:
        return RejectionCategory.SCHEMA_VIOLATION;
    }
  }
}
