// ============================================
// Property 12: Coordinate conversion round-trip
// ============================================
//
// ∀ integer client points p with |p.x|,|p.y| ≤ 32767 and
// scale ∈ {1, 1.25, 1.5, 1.75, 2, 2.5, 3}:
//   cssToClient(clientToCss(p, s), s) = p within 1 px, both monotonic
//
// **Validates: Requirements 8.1, 8.3**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import { clientToCss, cssToClient } from '../../win32/inputForwarder';

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** Integer coordinate in [-32767, 32767] */
const arbCoord = fc.integer({ min: -32767, max: 32767 });

/** Supported DPI scale factors */
const arbScale = fc.constantFrom(1, 1.25, 1.5, 1.75, 2, 2.5, 3);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 12: Coordinate conversion round-trip', () => {
  it('∀ integer client points p and scale s: cssToClient(clientToCss(p, s), s) = p within 1 px', () => {
    fc.assert(
      fc.property(arbCoord, arbCoord, arbScale, (x, y, scale) => {
        const p = { x, y };
        const css = clientToCss(p, scale);
        const roundTripped = cssToClient(css, scale);

        const dx = Math.abs(roundTripped.x - p.x);
        const dy = Math.abs(roundTripped.y - p.y);

        return dx <= 1 && dy <= 1;
      }),
      { numRuns: 10000 },
    );
  });

  it('∀ p1.x < p2.x and scale s: clientToCss is monotonic in x', () => {
    fc.assert(
      fc.property(arbCoord, arbCoord, arbScale, (x1, x2, scale) => {
        // Ensure x1 < x2
        fc.pre(x1 < x2);

        const css1 = clientToCss({ x: x1, y: 0 }, scale);
        const css2 = clientToCss({ x: x2, y: 0 }, scale);

        return css1.x <= css2.x;
      }),
      { numRuns: 10000 },
    );
  });

  it('∀ p1.y < p2.y and scale s: clientToCss is monotonic in y', () => {
    fc.assert(
      fc.property(arbCoord, arbCoord, arbScale, (y1, y2, scale) => {
        // Ensure y1 < y2
        fc.pre(y1 < y2);

        const css1 = clientToCss({ x: 0, y: y1 }, scale);
        const css2 = clientToCss({ x: 0, y: y2 }, scale);

        return css1.y <= css2.y;
      }),
      { numRuns: 10000 },
    );
  });

  it('∀ p1.x < p2.x and scale s: cssToClient is monotonic in x', () => {
    fc.assert(
      fc.property(arbCoord, arbCoord, arbScale, (x1, x2, scale) => {
        fc.pre(x1 < x2);

        const client1 = cssToClient({ x: x1, y: 0 }, scale);
        const client2 = cssToClient({ x: x2, y: 0 }, scale);

        return client1.x <= client2.x;
      }),
      { numRuns: 10000 },
    );
  });

  it('∀ p1.y < p2.y and scale s: cssToClient is monotonic in y', () => {
    fc.assert(
      fc.property(arbCoord, arbCoord, arbScale, (y1, y2, scale) => {
        fc.pre(y1 < y2);

        const client1 = cssToClient({ x: 0, y: y1 }, scale);
        const client2 = cssToClient({ x: 0, y: y2 }, scale);

        return client1.y <= client2.y;
      }),
      { numRuns: 10000 },
    );
  });
});
