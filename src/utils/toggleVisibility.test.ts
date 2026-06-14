/**
 * Property test: hide-toggle is symmetric
 * Property 35: For any state (visible/hidden), toggling hide and then toggling
 * show returns to the original state. Model as a pure function:
 * `toggleVisibility(isHidden): boolean` where `toggle(toggle(x)) === x`.
 *
 * **Validates: Requirements 12.4**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { toggleVisibility } from './toggleVisibility';

describe('toggleVisibility — Property 35: hide-toggle is symmetric', () => {
  it('toggle is an involution: toggle(toggle(x)) === x for all boolean x', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        (isHidden) => {
          const toggled = toggleVisibility(isHidden);
          const toggledBack = toggleVisibility(toggled);
          expect(toggledBack).toBe(isHidden);
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('toggle always flips the state', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        (isHidden) => {
          const result = toggleVisibility(isHidden);
          expect(result).toBe(!isHidden);
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('applying toggle N times returns to original iff N is even', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.nat({ max: 100 }),
        (initial, n) => {
          let state = initial;
          for (let i = 0; i < n; i++) {
            state = toggleVisibility(state);
          }
          if (n % 2 === 0) {
            expect(state).toBe(initial);
          } else {
            expect(state).toBe(!initial);
          }
        }
      ),
      { numRuns: 1000 }
    );
  });
});
