// ============================================
// Zule AI — Cross_Window_Sync v2 property-based tests
// ============================================
//
// Tests for the pure helper functions extracted from useCrossWindowSync.
// These validate the core sync protocol invariants without needing React
// or a real BroadcastChannel.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { shouldAcceptMessage, detectHostLoss } from './useCrossWindowSync';

// ─── 20.2 Property test: receivers reject regressing versions ────────────────
// Property 32: Cross-window receivers reject regressing versions
// **Validates: Requirements 11.1**

describe('shouldAcceptMessage (Property 32: Cross-window receivers reject regressing versions)', () => {
  it('accepts messages with version >= lastApplied', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        (lastApplied, delta) => {
          const incoming = lastApplied + delta;
          expect(shouldAcceptMessage(lastApplied, incoming)).toBe(true);
        },
      ),
    );
  });

  it('rejects messages with version < lastApplied', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (lastApplied, gap) => {
          const incoming = lastApplied - gap;
          // incoming is strictly less than lastApplied
          expect(shouldAcceptMessage(lastApplied, incoming)).toBe(false);
        },
      ),
    );
  });

  it('for any sequence of versions, applying in order and then receiving a past version rejects', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 10_000 }), { minLength: 2, maxLength: 50 }),
        (versions) => {
          // Simulate a receiver processing messages in order
          let lastApplied = 0;
          const sorted = [...versions].sort((a, b) => a - b);

          // Apply all versions in ascending order
          for (const v of sorted) {
            if (shouldAcceptMessage(lastApplied, v)) {
              lastApplied = v;
            }
          }

          // After applying the max, any version below it should be rejected
          const maxVersion = sorted[sorted.length - 1];
          if (maxVersion > 0) {
            const staleVersion = maxVersion - 1;
            expect(shouldAcceptMessage(lastApplied, staleVersion)).toBe(false);
          }
        },
      ),
    );
  });

  it('accepts messages with version equal to lastApplied (idempotent re-delivery)', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), (version) => {
        expect(shouldAcceptMessage(version, version)).toBe(true);
      }),
    );
  });
});

// ─── 20.3 Property test: heartbeat-based host-loss detection ─────────────────
// Property 33: Heartbeat-based host-loss detection
// **Validates: Requirements 11.3, 11.6**

describe('detectHostLoss (Property 33: Heartbeat-based host-loss detection)', () => {
  it('detects host loss when elapsed time exceeds timeout', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100_000_000 }), // lastHeartbeatAt
        fc.integer({ min: 1, max: 100_000 }), // extra ms beyond timeout
        fc.integer({ min: 1, max: 60_000 }), // timeoutMs
        (lastHeartbeatAt, extra, timeoutMs) => {
          const now = lastHeartbeatAt + timeoutMs + extra;
          expect(detectHostLoss(lastHeartbeatAt, now, timeoutMs)).toBe(true);
        },
      ),
    );
  });

  it('does not detect host loss when elapsed time is within timeout', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100_000_000 }), // lastHeartbeatAt
        fc.integer({ min: 0, max: 60_000 }), // timeoutMs
        (lastHeartbeatAt, timeoutMs) => {
          // now is exactly at lastHeartbeatAt + timeoutMs (boundary: not exceeded)
          const now = lastHeartbeatAt + timeoutMs;
          expect(detectHostLoss(lastHeartbeatAt, now, timeoutMs)).toBe(false);
        },
      ),
    );
  });

  it('with default timeout (15000ms), detects loss after 15001ms', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100_000_000 }), // lastHeartbeatAt
        fc.integer({ min: 1, max: 100_000 }), // extra ms
        (lastHeartbeatAt, extra) => {
          const now = lastHeartbeatAt + 15_000 + extra;
          expect(detectHostLoss(lastHeartbeatAt, now)).toBe(true);
        },
      ),
    );
  });

  it('with default timeout (15000ms), does not detect loss at or before 15000ms', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100_000_000 }), // lastHeartbeatAt
        fc.integer({ min: 0, max: 15_000 }), // elapsed (0 to 15000)
        (lastHeartbeatAt, elapsed) => {
          const now = lastHeartbeatAt + elapsed;
          expect(detectHostLoss(lastHeartbeatAt, now)).toBe(false);
        },
      ),
    );
  });

  it('host loss is transitive: once detected, any later timestamp also detects', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100_000_000 }), // lastHeartbeatAt
        fc.integer({ min: 15_001, max: 200_000 }), // first detection time
        fc.nat({ max: 100_000 }), // additional time after first detection
        (lastHeartbeatAt, firstDetection, additionalTime) => {
          const now1 = lastHeartbeatAt + firstDetection;
          const now2 = now1 + additionalTime;
          // If detected at now1, must also be detected at now2
          if (detectHostLoss(lastHeartbeatAt, now1)) {
            expect(detectHostLoss(lastHeartbeatAt, now2)).toBe(true);
          }
        },
      ),
    );
  });
});
