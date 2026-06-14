/**
 * Property test: manual submit aborts in-flight stream and discards late tokens
 * Property 36: For any sequence of (submit, abort, new-submit), after an abort
 * the cumulative text is never extended by tokens from the aborted stream.
 *
 * **Validates: Requirements 12.2**
 *
 * Models the pure state machine:
 *   State: { currentRequestId, cumulativeText }
 *   On new request: increment requestId, reset cumulativeText
 *   On token(requestId, text): only apply if requestId === currentRequestId
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { initialState, newRequest, applyToken, type StreamAbortState } from './streamAbort';

// Action types for the state machine
type Action =
  | { type: 'newRequest' }
  | { type: 'token'; requestId: number; text: string };

/**
 * Arbitrary that generates a sequence of actions where tokens reference
 * various request IDs (both current and stale).
 */
function actionArbitrary(maxRequestId: number): fc.Arbitrary<Action> {
  return fc.oneof(
    fc.constant<Action>({ type: 'newRequest' }),
    fc.record<{ type: 'token'; requestId: number; text: string }>({
      type: fc.constant('token' as const),
      requestId: fc.nat({ max: Math.max(maxRequestId, 5) }),
      text: fc.string({ minLength: 1, maxLength: 20 }),
    })
  );
}

function runActions(actions: Action[]): StreamAbortState {
  let state = initialState();
  for (const action of actions) {
    if (action.type === 'newRequest') {
      state = newRequest(state);
    } else {
      state = applyToken(state, action.requestId, action.text);
    }
  }
  return state;
}

describe('streamAbort state machine', () => {
  it('Property 36: after newRequest, tokens from previous requestId are discarded', () => {
    fc.assert(
      fc.property(
        // Generate a sequence: some tokens for request N, then a newRequest, then
        // interleaved tokens for both old and new request IDs
        fc.nat({ max: 10 }).chain((preTokenCount) =>
          fc.tuple(
            // Tokens before newRequest (for request 1)
            fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 0, maxLength: preTokenCount }),
            // Tokens that arrive AFTER newRequest but with OLD requestId (stale tokens)
            fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 0, maxLength: 10 }),
            // Tokens for the NEW request (current requestId)
            fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 0, maxLength: 10 })
          )
        ),
        ([preTokens, staleTokens, freshTokens]) => {
          let state = initialState();

          // Start first request
          state = newRequest(state);
          const firstRequestId = state.currentRequestId;

          // Deliver tokens for first request
          for (const text of preTokens) {
            state = applyToken(state, firstRequestId, text);
          }

          // Manual submit: start new request (aborts the first)
          state = newRequest(state);
          const secondRequestId = state.currentRequestId;

          // After newRequest, cumulativeText is reset
          expect(state.cumulativeText).toBe('');

          // Late tokens from aborted stream arrive — they must be discarded
          for (const text of staleTokens) {
            state = applyToken(state, firstRequestId, text);
          }

          // cumulativeText must still be empty (only fresh tokens accepted)
          expect(state.cumulativeText).toBe('');

          // Fresh tokens for the new request
          for (const text of freshTokens) {
            state = applyToken(state, secondRequestId, text);
          }

          // cumulativeText contains only fresh tokens
          expect(state.cumulativeText).toBe(freshTokens.join(''));
        }
      ),
      { numRuns: 500 }
    );
  });

  it('Property 36 (generalized): for any action sequence, cumulativeText only contains tokens from the current requestId', () => {
    fc.assert(
      fc.property(
        fc.array(actionArbitrary(10), { minLength: 1, maxLength: 50 }),
        (actions) => {
          let state = initialState();
          // Track which tokens were applied for the CURRENT request
          let expectedText = '';

          for (const action of actions) {
            if (action.type === 'newRequest') {
              state = newRequest(state);
              expectedText = '';
            } else {
              const prevState = state;
              state = applyToken(state, action.requestId, action.text);
              if (action.requestId === prevState.currentRequestId) {
                expectedText += action.text;
              }
            }
          }

          // The cumulative text must exactly equal the tokens applied
          // to the current request — no stale tokens leaked in
          expect(state.cumulativeText).toBe(expectedText);
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('newRequest always increments the requestId', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100 }),
        (n) => {
          let state = initialState();
          for (let i = 0; i < n; i++) {
            const prev = state.currentRequestId;
            state = newRequest(state);
            expect(state.currentRequestId).toBe(prev + 1);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('tokens with non-matching requestId never modify cumulativeText', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.nat({ max: 100 }),
        (text, offset) => {
          let state = initialState();
          state = newRequest(state);
          const currentId = state.currentRequestId;

          // Use a stale ID (anything != currentId)
          const staleId = currentId + offset + 1;
          const prevText = state.cumulativeText;
          state = applyToken(state, staleId, text);

          expect(state.cumulativeText).toBe(prevText);
        }
      ),
      { numRuns: 500 }
    );
  });
});
