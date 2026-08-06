// ============================================
// Zule AI — Magnetic Link
// ============================================
//
// A navigation link whose visible label translates toward the cursor when
// the cursor is within a fixed activation radius. The visual is bounded
// and gated:
//
//   - Pure helper `computeMagneticOffset` returns `(0, 0)` under reduced
//     motion or when the cursor is further than `ACTIVATION_RADIUS` px
//     from the link's center; otherwise the offset scales toward the
//     cursor with magnitude capped at `MAX_DISPLACEMENT` px.
//   - The component attaches its `window` `pointermove` listener only
//     when `reducedMotion` is false. Under reduced motion the MotionValues
//     hold at `0` and no listener is registered at all.
//   - The leave transition (when the cursor exits the activation radius)
//     runs over 250 ms with an `easeOut` curve.
//   - `onHoverChange` fires when the cursor enters/leaves the link element
//     itself so the parent `ActiveIndicator` can slide to the hovered link.
//
// Requirements: 4.1, 4.2, 4.5

import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { motion, useMotionValue, animate } from 'framer-motion';

import { useLandingMotion } from './LandingMotionContext';

/** Activation radius in CSS pixels (Req 4.1). */
const ACTIVATION_RADIUS = 40;

/** Maximum magnetic displacement in CSS pixels (Req 4.1). */
const MAX_DISPLACEMENT = 4;

/** Leave-transition duration in seconds — within the 150–350 ms band (Req 4.2). */
const LEAVE_DURATION_S = 0.25;

/** Input to {@link computeMagneticOffset}. */
export interface ComputeMagneticOffsetInput {
  /** Horizontal cursor offset from the link's center, in CSS pixels. */
  dx: number;
  /** Vertical cursor offset from the link's center, in CSS pixels. */
  dy: number;
  /** `true` when the user prefers reduced motion. */
  reducedMotion: boolean;
}

/** Result of {@link computeMagneticOffset}. */
export interface MagneticOffset {
  /** Horizontal translation in CSS pixels. */
  x: number;
  /** Vertical translation in CSS pixels. */
  y: number;
}

/**
 * Pure function mapping a cursor offset vector `(dx, dy)` and a reduced
 * motion flag to the magnetic translation that should be applied to the
 * link element.
 *
 * Bounded and gated by design (Property 2 in design.md):
 *
 * 1. Returns `(0, 0)` when `reducedMotion` is `true`.
 * 2. Returns `(0, 0)` when `sqrt(dx² + dy²) > ACTIVATION_RADIUS`.
 * 3. Returns `(0, 0)` when the cursor sits exactly at the link's center
 *    (no direction to translate towards).
 * 4. Otherwise scales the offset toward the cursor so that the resulting
 *    magnitude is `(1 - distance / ACTIVATION_RADIUS) * MAX_DISPLACEMENT`.
 *    This is monotonically decreasing in `distance` and is always within
 *    `[0, MAX_DISPLACEMENT]`.
 *
 * Exported as a named export so the property test in 7.2 can import it
 * directly without rendering the component.
 *
 * Requirements: 4.1, 4.5
 */
export function computeMagneticOffset({
  dx,
  dy,
  reducedMotion,
}: ComputeMagneticOffsetInput): MagneticOffset {
  if (reducedMotion) return { x: 0, y: 0 };

  const distance = Math.sqrt(dx * dx + dy * dy);

  // Outside the activation radius — gated to the rest position.
  if (distance > ACTIVATION_RADIUS) return { x: 0, y: 0 };

  // Cursor sitting exactly on the link's center — no direction to pull
  // toward, and avoids a divide-by-zero in the scale below.
  if (distance === 0) return { x: 0, y: 0 };

  // `t` rises linearly from 0 at the center to 1 at the radius edge, so
  // `(1 - t)` is the proximity factor used to scale the maximum
  // displacement. The division by `distance` normalises `(dx, dy)` into a
  // unit vector before re-scaling, so the resulting magnitude is exactly
  // `(1 - t) * MAX_DISPLACEMENT ∈ [0, MAX_DISPLACEMENT]`.
  const t = distance / ACTIVATION_RADIUS;
  const scale = ((1 - t) * MAX_DISPLACEMENT) / distance;

  return { x: dx * scale, y: dy * scale };
}

/** Props for {@link MagneticLink}. */
export interface MagneticLinkProps {
  /** Anchor target (e.g. `'#features'`). */
  href: string;
  /** Visible link label. */
  label: string;
  /**
   * Click handler — receives the original React mouse event so the
   * caller can `preventDefault()` for smooth-scroll anchors or `navigateTo`
   * routing without re-implementing the wiring here.
   */
  onClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  /**
   * Fired with `true` when the cursor enters the link's bounding box and
   * `false` when it leaves. Consumed by `ActiveIndicator` to slide the
   * pill to whichever link is currently hovered.
   */
  onHoverChange?: (hovered: boolean) => void;
  /** Additional class names appended after the base `.magnetic-link`. */
  className?: string;
}

/**
 * Floating-navbar nav link with magnetic hover behaviour.
 *
 * Listener strategy: a single `pointermove` listener is attached to
 * `window` (rather than the element) so the offset can be computed from
 * any cursor position, including positions slightly outside the link's
 * own bounding rect. The listener is *only* attached when the user has
 * not requested reduced motion (Req 4.5).
 *
 * Animation strategy: while the cursor sits inside the activation radius
 * the MotionValues are set imperatively each frame (no easing — the
 * value already changes smoothly as the cursor moves). When the cursor
 * crosses out of the radius the MotionValues are animated back to 0 with
 * a 250 ms `easeOut` curve (Req 4.2). We only kick off that leave
 * animation on the *transition* from inside → outside, so we don't churn
 * new animations every pointer event while the cursor wanders the page.
 *
 * Requirements: 4.1, 4.2, 4.5
 */
export function MagneticLink({
  href,
  label,
  onClick,
  onHoverChange,
  className,
}: MagneticLinkProps): JSX.Element {
  const anchorRef = useRef<HTMLAnchorElement | null>(null);
  const { reducedMotion } = useLandingMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  // Tracks whether the cursor was inside the activation radius on the
  // previous pointer event. Used to fire the leave animation exactly
  // once when the cursor crosses out.
  const wasInsideRef = useRef(false);

  useEffect(() => {
    if (reducedMotion) {
      // Reduced motion: make sure any in-flight translation is cleared
      // and skip the listener entirely. Belt-and-suspenders alongside
      // the gating inside `computeMagneticOffset`.
      x.set(0);
      y.set(0);
      wasInsideRef.current = false;
      return;
    }

    const handlePointerMove = (event: PointerEvent): void => {
      const el = anchorRef.current;
      if (el === null) return;

      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dx = event.clientX - centerX;
      const dy = event.clientY - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance > ACTIVATION_RADIUS) {
        // Outside the radius — animate back to rest, but only on the
        // first event after the cursor left, to avoid restarting the
        // animation on every subsequent pointer event.
        if (wasInsideRef.current) {
          animate(x, 0, { duration: LEAVE_DURATION_S, ease: 'easeOut' });
          animate(y, 0, { duration: LEAVE_DURATION_S, ease: 'easeOut' });
          wasInsideRef.current = false;
        }
        return;
      }

      const offset = computeMagneticOffset({ dx, dy, reducedMotion: false });
      x.set(offset.x);
      y.set(offset.y);
      wasInsideRef.current = true;
    };

    window.addEventListener('pointermove', handlePointerMove);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
    };
  }, [reducedMotion, x, y]);

  const composedClassName =
    className === undefined || className.length === 0
      ? 'magnetic-link'
      : `magnetic-link ${className}`;

  return (
    <motion.a
      ref={anchorRef}
      href={href}
      className={composedClassName}
      style={{ x, y }}
      onClick={onClick}
      onPointerEnter={() => onHoverChange?.(true)}
      onPointerLeave={() => onHoverChange?.(false)}
    >
      {label}
    </motion.a>
  );
}

export default MagneticLink;
