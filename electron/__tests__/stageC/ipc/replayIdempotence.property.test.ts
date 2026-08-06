// ============================================
// Zule AI — Replay Idempotence Property-Based Tests
// ============================================
//
// Feature: stealth-window-host, Property 7: Replay idempotence
//
// Generate valid mutating messages and repetition counts greater than one;
// assert one mutation, one service invocation, stable state, and cached
// `duplicate-message` outcomes.
//
// **Validates: Requirements 6.22–6.23**

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';

import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  SidecarToControllerType,
  MessageDirection,
  PAYLOAD_FIELD_SPECS,
} from '../../../stageC/protocol/schema';

import { serializeEnvelope, type ProtocolEnvelope } from '../../../stageC/protocol/envelope';

import {
  StageCDispatcher,
  RejectionCategory,
  type DispatcherConfig,
  type DispatchResult,
} from '../../../stageC/ipc/dispatcher';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** All sidecar→controller message types (typical incoming direction). */
const SIDECAR_MESSAGE_TYPES = Object.values(SidecarToControllerType);

/** Build a valid ProtocolEnvelope for a given sidecar→controller type. */
function buildValidEnvelope(
  type: SidecarToControllerType,
  messageId: string,
): ProtocolEnvelope {
  const spec = PAYLOAD_FIELD_SPECS[type];
  const payload: Record<string, unknown> = {};

  for (const field of spec.required) {
    payload[field] = getPayloadValue(field);
  }

  return {
    protocolVersion: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
    messageId,
    type,
    payload,
  };
}

/** Generates a well-formed payload value for a given field name. */
function getPayloadValue(field: string): unknown {
  switch (field) {
    case 'launch_id':
    case 'sidecar_version':
    case 'webview2_runtime_version':
    case 'action':
    case 'event_type':
    case 'detail':
      return 'test-value';
    case 'revision':
    case 'protocol_major':
      return PROTOCOL_MAJOR;
    case 'protocol_minor':
      return PROTOCOL_MINOR;
    case 'bridge_schema_version':
      return 1;
    case 'capabilities':
      return ['overlay'];
    case 'bounds_dip':
      return { left: 0, top: 0, width: 400, height: 300 };
    case 'enabled':
    case 'success':
    case 'read_back_value':
      return true;
    case 'parameters':
      return {};
    default:
      return 'placeholder';
  }
}

/** Create a fresh authenticated dispatcher configured for sidecar→controller. */
function createDispatcher(): StageCDispatcher {
  const config: DispatcherConfig = {
    expectedIncomingDirection: MessageDirection.SIDECAR_TO_CONTROLLER,
    isAuthenticated: () => true,
    getExpectedRevision: () => -1, // Skip revision validation
    onFallback: () => {},
    onRejection: () => {},
  };
  return new StageCDispatcher(config);
}

// ────────────────────────────────────────────────────────────────────
// Generators
// ────────────────────────────────────────────────────────────────────

/** Generates a random unique message ID. */
const messageIdArb: fc.Arbitrary<string> = fc
  .tuple(fc.hexaString({ minLength: 8, maxLength: 8 }), fc.nat({ max: 999999 }))
  .map(([hex, num]) => `msg-${hex}-${num}`);

/** Generates a valid sidecar→controller message type. */
const sidecarTypeArb: fc.Arbitrary<SidecarToControllerType> = fc.constantFrom(
  ...SIDECAR_MESSAGE_TYPES,
);

/** Generates a repetition count between 2 and 10. */
const repetitionCountArb: fc.Arbitrary<number> = fc.integer({ min: 2, max: 10 });

/** Generates a random outcome value to record in the replay cache. */
const outcomeArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant({ ok: true }),
  fc.constant({ ok: false, error: 'timeout' }),
  fc.record({
    success: fc.boolean(),
    data: fc.string({ minLength: 1, maxLength: 20 }),
  }),
  fc.constant(null),
  fc.integer(),
);

// ────────────────────────────────────────────────────────────────────
// Property Tests
// ────────────────────────────────────────────────────────────────────

describe('Stage C IPC — Property Tests', () => {
  // Feature: stealth-window-host, Property 7: Replay idempotence
  describe('Property 7: Replay idempotence', () => {
    it('first dispatch succeeds, replays return cached duplicate-message outcomes', () => {
      fc.assert(
        fc.property(
          sidecarTypeArb,
          messageIdArb,
          repetitionCountArb,
          outcomeArb,
          (type, messageId, reps, outcome) => {
            const dispatcher = createDispatcher();
            const envelope = buildValidEnvelope(type, messageId);
            const frame = serializeEnvelope(envelope);

            // First dispatch — should succeed as non-duplicate
            const firstResult = dispatcher.dispatchFrame(frame);
            expect(firstResult.ok).toBe(true);
            if (!firstResult.ok) return;
            expect(firstResult.duplicate).toBe(false);

            // Capture the queue counter after first dispatch
            const queuedAfterFirst = dispatcher.currentQueuedMessages;
            expect(queuedAfterFirst).toBe(1);

            // Record the outcome (simulates message processing completion)
            dispatcher.recordOutcome(messageId, type, outcome);

            // Replay the same message `reps` times — all should return duplicate
            for (let i = 0; i < reps; i++) {
              const replayResult = dispatcher.dispatchFrame(frame);

              // **Validates: Requirement 6.22** — repeated messageId returns duplicate-message
              expect(replayResult.ok).toBe(true);
              if (!replayResult.ok) return;
              expect(replayResult.duplicate).toBe(true);

              // **Validates: Requirement 6.22** — cached outcome is returned
              if (replayResult.duplicate) {
                expect(replayResult.cachedOutcome).toEqual(outcome);
              }
            }

            // **Validates: Requirement 6.22** — zero repeated mutations
            // Queue counter should NOT have incremented beyond 1 (replays don't enqueue)
            expect(dispatcher.currentQueuedMessages).toBe(queuedAfterFirst);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('cached outcomes are stable and identical on each replay', () => {
      fc.assert(
        fc.property(
          sidecarTypeArb,
          messageIdArb,
          repetitionCountArb,
          outcomeArb,
          (type, messageId, reps, outcome) => {
            const dispatcher = createDispatcher();
            const envelope = buildValidEnvelope(type, messageId);
            const frame = serializeEnvelope(envelope);

            // Dispatch once
            const firstResult = dispatcher.dispatchFrame(frame);
            expect(firstResult.ok).toBe(true);
            if (!firstResult.ok) return;
            expect(firstResult.duplicate).toBe(false);

            // Record outcome
            dispatcher.recordOutcome(messageId, type, outcome);

            // Collect all cached outcomes across replays
            const cachedOutcomes: unknown[] = [];
            for (let i = 0; i < reps; i++) {
              const replayResult = dispatcher.dispatchFrame(frame);
              expect(replayResult.ok).toBe(true);
              if (replayResult.ok && replayResult.duplicate) {
                cachedOutcomes.push(replayResult.cachedOutcome);
              }
            }

            // **Validates: Requirements 6.22–6.23** — outcomes are stable
            // All cached outcomes must be identical to each other and to original outcome
            expect(cachedOutcomes.length).toBe(reps);
            for (const cached of cachedOutcomes) {
              expect(cached).toEqual(outcome);
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    it('queue counter increments exactly once regardless of replay count', () => {
      fc.assert(
        fc.property(
          sidecarTypeArb,
          messageIdArb,
          repetitionCountArb,
          outcomeArb,
          (type, messageId, reps, outcome) => {
            const dispatcher = createDispatcher();
            const envelope = buildValidEnvelope(type, messageId);
            const frame = serializeEnvelope(envelope);

            // Verify initial state
            expect(dispatcher.currentQueuedMessages).toBe(0);
            expect(dispatcher.currentQueuedBytes).toBe(0);

            // First dispatch — enqueues
            const firstResult = dispatcher.dispatchFrame(frame);
            expect(firstResult.ok).toBe(true);

            const messagesAfterFirst = dispatcher.currentQueuedMessages;
            const bytesAfterFirst = dispatcher.currentQueuedBytes;
            expect(messagesAfterFirst).toBe(1);
            expect(bytesAfterFirst).toBe(frame.length);

            // Record outcome
            dispatcher.recordOutcome(messageId, type, outcome);

            // Replay multiple times — queue state must NOT change
            for (let i = 0; i < reps; i++) {
              dispatcher.dispatchFrame(frame);
              // **Validates: Requirement 6.22** — zero repeated mutations (queue unchanged)
              expect(dispatcher.currentQueuedMessages).toBe(messagesAfterFirst);
              expect(dispatcher.currentQueuedBytes).toBe(bytesAfterFirst);
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    it('multiple distinct messages each cache independently without cross-contamination', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(sidecarTypeArb, messageIdArb, outcomeArb),
            { minLength: 2, maxLength: 8 },
          ),
          repetitionCountArb,
          (messages, reps) => {
            // Ensure unique messageIds
            const uniqueIds = new Set(messages.map(([, id]) => id));
            fc.pre(uniqueIds.size === messages.length);

            const dispatcher = createDispatcher();

            // Dispatch all messages once and record outcomes
            for (const [type, messageId, outcome] of messages) {
              const envelope = buildValidEnvelope(type, messageId);
              const frame = serializeEnvelope(envelope);

              const result = dispatcher.dispatchFrame(frame);
              expect(result.ok).toBe(true);
              if (!result.ok) return;
              expect(result.duplicate).toBe(false);

              dispatcher.recordOutcome(messageId, type, outcome);
            }

            const queuedAfterAll = dispatcher.currentQueuedMessages;
            expect(queuedAfterAll).toBe(messages.length);

            // Replay each message — verify each returns its own cached outcome
            for (const [type, messageId, expectedOutcome] of messages) {
              const envelope = buildValidEnvelope(type, messageId);
              const frame = serializeEnvelope(envelope);

              for (let i = 0; i < reps; i++) {
                const replayResult = dispatcher.dispatchFrame(frame);
                expect(replayResult.ok).toBe(true);
                if (replayResult.ok && replayResult.duplicate) {
                  // Each message should return its own outcome, not another's
                  expect(replayResult.cachedOutcome).toEqual(expectedOutcome);
                }
              }
            }

            // Queue counter unchanged from replays
            // **Validates: Requirements 6.22–6.23**
            expect(dispatcher.currentQueuedMessages).toBe(queuedAfterAll);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
