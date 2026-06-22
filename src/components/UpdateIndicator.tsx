// ============================================
// Zule AI — Update Indicator Component
// ============================================
//
// Renders a subtle 8px green dot inside the Overlay window when an
// update is ready to install. The dot is non-interactive and positioned
// within the overlay's existing layout without changing outer bounds.
//
// Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7

import type { UpdateState } from '../types/electron';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface UpdateIndicatorProps {
  status: UpdateState['status'];
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Overlay update indicator — a minimal 8px green dot that signals an
 * update is ready to install without interrupting the overlay's primary
 * copilot affordances.
 *
 * - Renders only when `status === 'ready'`.
 * - Uses CSS opacity transition (300ms) to appear/disappear within the
 *   1000ms budget required by Requirements 7.6 and 7.7.
 * - `pointer-events: none` ensures the dot never intercepts clicks
 *   intended for underlying overlay controls (Requirement 7.4).
 * - Positioned within the overlay's existing rendered region with no
 *   effect on outer bounds (Requirement 7.3).
 */
export function UpdateIndicator({ status }: UpdateIndicatorProps) {
  const isReady = status === 'ready';

  return (
    <span
      className="update-indicator"
      aria-label="Update ready to install"
      aria-hidden={!isReady}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: '#4ade80',
        pointerEvents: 'none',
        opacity: isReady ? 1 : 0,
        transition: 'opacity 300ms ease-in-out',
        position: 'absolute',
        top: 4,
        right: 4,
      }}
    />
  );
}
