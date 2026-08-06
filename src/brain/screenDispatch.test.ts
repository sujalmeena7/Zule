// ============================================
// Zule AI — Screen Dispatch Logic Tests
// ============================================
//
// Unit tests for the OCR skip decision logic.
// Validates: Requirements 2.1, 2.2, 2.3, 2.4

import { describe, it, expect } from 'vitest';
import { shouldSkipOcr } from './screenDispatch';

describe('shouldSkipOcr', () => {
  it('returns not-applicable when screen is not armed', () => {
    expect(
      shouldSkipOcr({
        screenArmed: false,
        isVisionAdapter: true,
        keyframeAvailable: true,
      }),
    ).toBe('not-applicable');
  });

  it('returns not-applicable when screen is not armed and text-only adapter', () => {
    expect(
      shouldSkipOcr({
        screenArmed: false,
        isVisionAdapter: false,
        keyframeAvailable: false,
      }),
    ).toBe('not-applicable');
  });

  // Req 2.1: Vision adapter + keyframe available → skip OCR
  it('skips OCR when vision adapter AND keyframe is available', () => {
    expect(
      shouldSkipOcr({
        screenArmed: true,
        isVisionAdapter: true,
        keyframeAvailable: true,
      }),
    ).toBe('skip');
  });

  // Req 2.3: Vision adapter + keyframe failure → fall back to OCR
  it('requires OCR when vision adapter but keyframe is NOT available', () => {
    expect(
      shouldSkipOcr({
        screenArmed: true,
        isVisionAdapter: true,
        keyframeAvailable: false,
      }),
    ).toBe('required');
  });

  // Req 2.2: Text_Only_Adapter always needs OCR
  it('requires OCR when text-only adapter (keyframe available)', () => {
    expect(
      shouldSkipOcr({
        screenArmed: true,
        isVisionAdapter: false,
        keyframeAvailable: true,
      }),
    ).toBe('required');
  });

  it('requires OCR when text-only adapter (keyframe not available)', () => {
    expect(
      shouldSkipOcr({
        screenArmed: true,
        isVisionAdapter: false,
        keyframeAvailable: false,
      }),
    ).toBe('required');
  });

  // Req 2.4: Adapter change from Vision to Text_Only mid-session
  // After change, isVisionAdapter becomes false → OCR required
  it('requires OCR after adapter change from Vision to Text_Only', () => {
    // First call: vision adapter with keyframe → skip
    const beforeChange = shouldSkipOcr({
      screenArmed: true,
      isVisionAdapter: true,
      keyframeAvailable: true,
    });
    expect(beforeChange).toBe('skip');

    // After change: text-only adapter → required
    const afterChange = shouldSkipOcr({
      screenArmed: true,
      isVisionAdapter: false,
      keyframeAvailable: true,
    });
    expect(afterChange).toBe('required');
  });
});
