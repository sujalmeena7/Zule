// ============================================
// Zule AI — TiltCard
// ============================================
//
// CSS 3D pointer-driven tilt wrapper used to give the bento feature
// cards a subtle depth response on hover. The wrapping element rotates
// up to ±`maxTiltDeg` (default 8°) on X and Y, returns to neutral over
// 250 ms when the pointer leaves, and stays flat under reduced motion.
//
// Requirements: 6.1, 6.2, 6.5, 10.3

import { motion } from 'framer-motion';
import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type ReactElement,
} from 'react';

import { useLandingMotion } from './LandingMotionContext';

/**
 * Input shape consumed by {@link computeTiltRotation}.
 *
 * `offsetX` / `offsetY` are cursor coordinates relative to the card's
 * top-left corner (i.e. `event.clientX - rect.left`). `width` / `height`
 * are the card's bounding rect dimensions. `reducedMotion` short-circuits
 * to `(0, 0)` regardless of the cursor position.
 */
export interface ComputeTiltRotationInput {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  maxTiltDeg?: number;
  reducedMotion: boolean;
}

/**
 * Result of {@link computeTiltRotation} — the X and Y rotations to apply
 * to the card in degrees.
 */
export interface TiltRotation {
  rotX: number;
  rotY: number;
}

/**
 * Clamp `value` into the inclusive range `[min, max]`. NaN-safe — any
 * non-finite input collapses to `0` so a buggy bounding rect can't leak
 * an invalid rotation into the DOM.
 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Pure helper that maps a cursor offset within a card's bounding rect
 * to a `{ rotX, rotY }` pair in degrees, clamped to
 * `[-maxTiltDeg, +maxTiltDeg]` on each axis.
 *
 * - When `reducedMotion` is `true`, returns `{ rotX: 0, rotY: 0 }`
 *   regardless of the cursor position. (Requirement 6.5)
 * - When the card's `width` or `height` is non-positive, the cursor
 *   position is undefined, so the helper also collapses to neutral.
 * - The cursor-to-rotation mapping inverts the Y axis (cursor near the
 *   top of the card tilts the top edge away from the viewer), matching
 *   the conventional "card lifts toward the cursor" interaction.
 *
 * Exported so the property-based test in task 12.2 can validate the
 * bounded-and-gated invariant without rendering the component.
 *
 * Requirements: 6.1, 6.5
 */
export function computeTiltRotation({
  offsetX,
  offsetY,
  width,
  height,
  maxTiltDeg = 8,
  reducedMotion,
}: ComputeTiltRotationInput): TiltRotation {
  if (reducedMotion) return { rotX: 0, rotY: 0 };
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { rotX: 0, rotY: 0 };
  }
  if (width <= 0 || height <= 0) return { rotX: 0, rotY: 0 };

  // Use the absolute value of `maxTiltDeg` so a caller passing a
  // negative bound can't invert the clamp range — the magnitude is what
  // matters per Requirement 6.1.
  const bound = Math.abs(maxTiltDeg);

  const halfW = width / 2;
  const halfH = height / 2;

  // Normalized cursor position in [-1, 1] when inside the rect; can
  // exceed that range if the pointer is tracked outside (e.g. between
  // pointermove and pointerleave). The clamp below handles the overflow.
  const nx = (offsetX - halfW) / halfW;
  const ny = (offsetY - halfH) / halfH;

  const rotY = clamp(nx * bound, -bound, bound);
  const rotX = clamp(-ny * bound, -bound, bound);

  return { rotX, rotY };
}

/**
 * Props for {@link TiltCard}.
 *
 * `className` is forwarded onto the wrapping `motion.div` so callers can
 * stack existing styles (notably `.bento-card`) on top of the
 * `.tilt-card` transform context defined in `landing-3d.css`.
 */
export interface TiltCardProps {
  children: ReactNode;
  /** Forwarded to the wrapper so callers can keep `.bento-card` etc. */
  className?: string;
  /** Maximum tilt magnitude in degrees per axis. Defaults to 8°. */
  maxTiltDeg?: number;
}

/**
 * Wrapper component that tilts its children in response to pointer
 * movement, using {@link computeTiltRotation} for the math.
 *
 * - Listens for `pointermove` on the wrapper itself (not `window`) so
 *   only the hovered card reacts; `pointerleave` resets to neutral.
 * - Under reduced motion, the listener is still attached but is a no-op
 *   because {@link computeTiltRotation} short-circuits — the component
 *   never updates state, so framer-motion never animates.
 *   (Requirement 6.5)
 * - The leave transition uses `{ duration: 0.25 }` so the return to
 *   `(0, 0)` lands inside the 200–400 ms band from Requirement 6.2.
 * - `className` is forwarded so wrapping a `.bento-card` keeps its
 *   existing background, border, and typography styles intact.
 *   (Requirement 10.3)
 *
 * Requirements: 6.1, 6.2, 6.5, 10.3
 */
export function TiltCard({
  children,
  className,
  maxTiltDeg = 8,
}: TiltCardProps): ReactElement {
  const { reducedMotion } = useLandingMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [{ rotX, rotY }, setRotation] = useState<TiltRotation>({
    rotX: 0,
    rotY: 0,
  });

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (reducedMotion) return;
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const next = computeTiltRotation({
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        width: rect.width,
        height: rect.height,
        maxTiltDeg,
        reducedMotion,
      });
      setRotation(next);
    },
    [maxTiltDeg, reducedMotion],
  );

  const handlePointerLeave = useCallback(() => {
    setRotation({ rotX: 0, rotY: 0 });
  }, []);

  const composedClassName = className
    ? `tilt-card ${className}`
    : 'tilt-card';

  return (
    <motion.div
      ref={ref}
      className={composedClassName}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      style={{ transformStyle: 'preserve-3d' }}
      animate={{ rotateX: rotX, rotateY: rotY }}
      transition={{ duration: 0.25 }}
    >
      {children}
    </motion.div>
  );
}

export default TiltCard;
