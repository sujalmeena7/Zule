/**
 * Pure state machine modelling the stream-abort lifecycle for FloatingCopilot.
 *
 * State: { currentRequestId, cumulativeText }
 * Actions:
 *   - newRequest(): increment requestId, reset cumulativeText
 *   - token(requestId, text): only apply if requestId === currentRequestId
 *
 * This module exists to be property-tested independently of React.
 * The FloatingCopilot component uses the same logic via requestIdRef.
 *
 * Validates: Requirements 12.1, 12.2
 */

export interface StreamAbortState {
  currentRequestId: number;
  cumulativeText: string;
}

export function initialState(): StreamAbortState {
  return { currentRequestId: 0, cumulativeText: '' };
}

/**
 * Start a new request: increments the request ID and resets cumulative text.
 * Any in-flight tokens from the previous request will be discarded because
 * their requestId will no longer match currentRequestId.
 */
export function newRequest(state: StreamAbortState): StreamAbortState {
  return {
    currentRequestId: state.currentRequestId + 1,
    cumulativeText: '',
  };
}

/**
 * Apply a token. Only updates cumulativeText if the token's requestId matches
 * the current request. Late tokens (from aborted streams) are silently discarded.
 */
export function applyToken(
  state: StreamAbortState,
  tokenRequestId: number,
  text: string
): StreamAbortState {
  if (tokenRequestId !== state.currentRequestId) {
    // Discard: token belongs to an aborted/stale request
    return state;
  }
  return {
    ...state,
    cumulativeText: state.cumulativeText + text,
  };
}
