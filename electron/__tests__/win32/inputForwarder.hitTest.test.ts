// ============================================
// Property 15: Forwarded events land on intended element
// ============================================
//
// ∀ CSS rect r inside viewport and scale s:
//   synthesized click at physical centre of r converts to CSS point inside r
//
// **Validates: Requirements 8.1, 8.3**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import { clientToCss, cssToClient } from '../../win32/inputForwarder';

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** CSS rect inside viewport: positive origin, positive dimensions */
const arbCssRect = fc.record({
  x: fc.integer({ min: 0, max: 1000 }),
  y: fc.integer({ min: 0, max: 1000 }),
  width: fc.integer({ min: 1, max: 500 }),
  height: fc.integer({ min: 1, max: 500 }),
});

/** Supported DPI scale factors */
const arbScale = fc.constantFrom(1, 1.25, 1.5, 1.75, 2, 2.5, 3);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 15: Forwarded events land on intended element', () => {
  it('∀ CSS rect r and scale s: physical centre of r converts back to a CSS point inside r', () => {
    fc.assert(
      fc.property(arbCssRect, arbScale, (rect, scale) => {
        // 1. Compute CSS center of the rect
        const cx = Math.floor(rect.x + rect.width / 2);
        const cy = Math.floor(rect.y + rect.height / 2);

        // 2. Convert CSS center to physical coordinates
        const physicalCenter = cssToClient({ x: cx, y: cy }, scale);

        // 3. Convert physical center back to CSS
        const cssPt = clientToCss(physicalCenter, scale);

        // 4. Assert the CSS point lies within the original rect
        return (
          cssPt.x >= rect.x &&
          cssPt.x < rect.x + rect.width &&
          cssPt.y >= rect.y &&
          cssPt.y < rect.y + rect.height
        );
      }),
      { numRuns: 10000 },
    );
  });
});
