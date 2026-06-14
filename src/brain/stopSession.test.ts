// ============================================
// Zule AI — Stop-Session Property Test
// ============================================
//
// Property 62: Stop-session retry preserves persisted meeting
// **Validates: Requirements 27.3**
//
// For all finite sequences of summary attempts where each attempt has
// outcome success | timeout | error, the meeting record persists across
// attempts. After the first attempt, `meeting.aiSummaryStatus ∈
// {pending, ok, failed}`; after a retry that succeeds,
// `aiSummaryStatus === 'ok'` and the meeting still has a non-empty summary.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  applyStopSessionOutcome,
  computeFinalState,
  type SummaryAttemptOutcome,
  type StopSessionMeetingState,
} from './stopSession';

describe('Property 62: Stop-session retry preserves persisted meeting', () => {
  const outcomeArb = fc.constantFrom<SummaryAttemptOutcome>('success', 'timeout', 'error');
  const outcomesArb = fc.array(outcomeArb, { minLength: 1, maxLength: 20 });

  it('meeting is always persisted regardless of outcome sequence', () => {
    fc.assert(
      fc.property(outcomesArb, (outcomes) => {
        const finalState = computeFinalState(true, outcomes);
        // The meeting must always be persisted (Requirement 27.1)
        expect(finalState.persisted).toBe(true);
      }),
    );
  });

  it('transcript is never lost regardless of outcome sequence', () => {
    fc.assert(
      fc.property(outcomesArb, (outcomes) => {
        const finalState = computeFinalState(true, outcomes);
        // The transcript is always preserved
        expect(finalState.hasTranscript).toBe(true);
      }),
    );
  });

  it('aiSummaryStatus is always in {pending, ok, failed} after at least one attempt', () => {
    fc.assert(
      fc.property(outcomesArb, (outcomes) => {
        const finalState = computeFinalState(true, outcomes);
        expect(['pending', 'ok', 'failed']).toContain(finalState.aiSummaryStatus);
      }),
    );
  });

  it('a successful attempt always results in aiSummaryStatus = ok with a summary', () => {
    fc.assert(
      fc.property(
        fc.array(outcomeArb, { minLength: 0, maxLength: 10 }),
        (precedingFailures) => {
          // Simulate: some failures followed by a success
          const outcomes: SummaryAttemptOutcome[] = [...precedingFailures, 'success'];
          const finalState = computeFinalState(true, outcomes);

          expect(finalState.persisted).toBe(true);
          expect(finalState.aiSummaryStatus).toBe('ok');
          expect(finalState.hasSummary).toBe(true);
          expect(finalState.hasTranscript).toBe(true);
        },
      ),
    );
  });

  it('a failed/timeout attempt always results in aiSummaryStatus = failed and meeting still persisted', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<SummaryAttemptOutcome>('timeout', 'error'),
        (failOutcome) => {
          const finalState = computeFinalState(true, [failOutcome]);

          expect(finalState.persisted).toBe(true);
          expect(finalState.aiSummaryStatus).toBe('failed');
          expect(finalState.hasTranscript).toBe(true);
        },
      ),
    );
  });

  it('retry after failure that succeeds sets aiSummaryStatus to ok', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<SummaryAttemptOutcome>('timeout', 'error'), { minLength: 1, maxLength: 5 }),
        (failures) => {
          // Some failures followed by a retry that succeeds
          const outcomes: SummaryAttemptOutcome[] = [...failures, 'success'];
          const finalState = computeFinalState(true, outcomes);

          expect(finalState.persisted).toBe(true);
          expect(finalState.aiSummaryStatus).toBe('ok');
          expect(finalState.hasSummary).toBe(true);
          expect(finalState.hasTranscript).toBe(true);
        },
      ),
    );
  });

  it('state machine transitions are deterministic for any sequence', () => {
    fc.assert(
      fc.property(outcomesArb, (outcomes) => {
        // Running computeFinalState twice yields same result (deterministic)
        const result1 = computeFinalState(true, outcomes);
        const result2 = computeFinalState(true, outcomes);
        expect(result1).toEqual(result2);
      }),
    );
  });

  it('applyStopSessionOutcome preserves transcript through any single transition', () => {
    fc.assert(
      fc.property(
        outcomeArb,
        fc.boolean(),
        (outcome, hasSummary) => {
          const initial: StopSessionMeetingState = {
            persisted: true,
            aiSummaryStatus: 'pending',
            hasTranscript: true,
            hasSummary,
          };
          const next = applyStopSessionOutcome(initial, outcome);
          // Transcript is ALWAYS preserved
          expect(next.hasTranscript).toBe(true);
          // Meeting is ALWAYS persisted
          expect(next.persisted).toBe(true);
        },
      ),
    );
  });

  it('empty transcript meetings also persist correctly', () => {
    fc.assert(
      fc.property(outcomesArb, (outcomes) => {
        const finalState = computeFinalState(false, outcomes);
        // Even with empty transcript, the meeting is persisted
        expect(finalState.persisted).toBe(true);
        expect(finalState.hasTranscript).toBe(false); // empty transcript stays empty
      }),
    );
  });
});
