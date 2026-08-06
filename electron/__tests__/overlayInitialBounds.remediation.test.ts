import { describe, expect, it } from 'vitest';
import { resolveInitialOverlayBounds } from '../edgeSnap';

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

describe('overlay initial bounds remediation', () => {
  it('moves a legacy Stage A child-coordinate position away from the exact upper-left corner', () => {
    expect(resolveInitialOverlayBounds(
      { x: 0, y: 0, width: 480, height: 80 },
      workArea,
    )).toEqual({ x: 720, y: 20, width: 480, height: 80 });
  });

  it('preserves an ordinary saved position after work-area clamping', () => {
    expect(resolveInitialOverlayBounds(
      { x: 250, y: 180, width: 480, height: 400 },
      workArea,
    )).toEqual({ x: 250, y: 180, width: 480, height: 400 });
  });

  it('uses the normal compact top-centred default when no saved bounds exist', () => {
    expect(resolveInitialOverlayBounds(undefined, workArea)).toEqual({
      x: 720,
      y: 20,
      width: 480,
      height: 80,
    });
  });
});
