// ============================================
// Zule AI — Screen Dispatch Logic
// ============================================
//
// Pure decision functions for the screen-context dispatch path.
// Determines whether OCR should be invoked based on adapter type
// and keyframe availability (Requirements 2.1, 2.2, 2.3, 2.4).
//
// These functions are stateless and easily testable — the actual
// I/O (keyframe capture, OCR invocation) is performed by the caller
// (FloatingCopilot.triggerAI) based on the decisions returned here.

/**
 * Input describing the current adapter and keyframe state for a
 * screen-context request.
 */
export interface OcrDecisionInput {
  /** Whether screen context is armed (capture active + user opted in). */
  screenArmed: boolean;
  /** Whether the active adapter supports image input (Vision_Adapter). */
  isVisionAdapter: boolean;
  /** Whether a valid keyframe was successfully obtained. */
  keyframeAvailable: boolean;
}

/**
 * The OCR decision result:
 * - `skip`: OCR should NOT be invoked (Vision_Adapter with keyframe).
 * - `required`: OCR MUST be invoked (Text_Only_Adapter or keyframe failure).
 * - `not-applicable`: Screen context is not armed; OCR decision is moot.
 */
export type OcrDecision = 'skip' | 'required' | 'not-applicable';

/**
 * Determine whether OCR should be invoked for a screen-context request.
 *
 * Property 4 (design document): OCR is skipped if and only if the active
 * adapter is a Vision_Adapter AND a valid Keyframe is available. In all
 * other cases (Text_Only_Adapter, or Vision_Adapter with keyframe failure),
 * OCR SHALL be invoked.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4
 */
export function shouldSkipOcr(input: OcrDecisionInput): OcrDecision {
  if (!input.screenArmed) {
    return 'not-applicable';
  }

  if (input.isVisionAdapter && input.keyframeAvailable) {
    // Req 2.1: Vision adapter with valid keyframe → skip OCR
    return 'skip';
  }

  // Req 2.2: Text_Only_Adapter always needs OCR
  // Req 2.3: Vision adapter with keyframe failure needs OCR fallback
  // Req 2.4: After adapter change to Text_Only, OCR resumes
  return 'required';
}
