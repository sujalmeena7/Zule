// ============================================
// Zule AI — ParallaxLayer
// ============================================
//
// Generic wrapper that translates its child on the Y axis as a function
// of the layer's scroll progress through the viewport. Used by the
// stats section to give `AnimatedMockup` a subtle parallax response as
// the user scrolls past it.
//
// The pure helper `computeParallaxOffset` maps a `[0, 1]` progress
// value to a `[-max, +max]` pixel displacement (default `max = 20`, so
// the total swing covers 40 px per Requirement 6.3). When reduced
// motion is active the component returns a plain `<div>` and the helper
// returns `0` — no scroll listener, no `motion.*` element, no
// transform — so the layer is identical to its non-animated baseline.
//
// Requirements: 6.3, 6.5, 10.3

import { motion, useScroll, useTransform } from 'framer-motion';
import { useRef, type CSSProperties, type ReactNode ,
  type ReactElement,
} from 'react';

import { useLandingMotion } from './LandingMotionContext';

/**
 * Options accepted by {@link computeParallaxOffset}.
 *
 * `max` is the half-amplitude of the swing in pixels (defaults to 20,
 * giving a total 40 px range per Requirement 6.3). `reducedMotion`
 * short-circuits to `0` regardless of the progress value.
 */
export interface ComputeParallaxOffsetOptions {
  max?: number;
  reducedMotion: boolean;
}

/**
 * Pure helper that maps a normalized scroll progress in `[0, 1]` to a
 * Y translation in pixels.
 *
 * - When `reducedMotion` is `true`, returns `0` regardless of the
 *   progress value. (Requirement 6.5)
 * - Otherwise returns `(progress * 2 - 1) * |max|` so:
 *     progress = 0   → -max  (element entering the viewport sits low)
 *     progress = 0.5 →  0    (element centered, no offset)
 *     progress = 1   → +max  (element leaving the viewport sits high)
 * - The total swing is `2 * |max|` (40 px with the default), matching
 *   the bounded-displacement contract in Requirement 6.3.
 * - Non-finite `progress` collapses to `0` so a stray `NaN` from the
 *   scroll layer can never leak into the DOM transform.
 *
 * Exported so the property-based test in task 12.4 can validate the
 * bounded-and-gated invariant without rendering the component.
 *
 * Requirements: 6.3, 6.5
 */
export function computeParallaxOffset(
  progress: number,
  { max = 20, reducedMotion }: ComputeParallaxOffsetOptions,
): number {
  if (reducedMotion) return 0;
  if (!Number.isFinite(progress)) return 0;
  // Take the magnitude of `max` so a caller passing a negative bound
  // can't invert the swing direction — the spec talks about a bounded
  // displacement, not a signed one.
  const bound = Math.abs(max);
  return (progress * 2 - 1) * bound;
}

/**
 * Props for {@link ParallaxLayer}.
 */
export interface ParallaxLayerProps {
  children: ReactNode;
  /**
   * Half-amplitude of the Y swing in pixels. The total swing is
   * `2 * maxPx` (defaults to 40 px). Used by the stats section with
   * `maxPx={20}` per Requirement 6.3.
   */
  maxPx?: number;
  /** Forwarded onto the wrapper so callers can keep existing styles. */
  className?: string;
  /** Inline style overrides; merged ahead of the parallax transform. */
  style?: CSSProperties;
}

/**
 * Inner component that performs the actual scroll-driven animation.
 * Always rendered with reduced motion `false` — the outer
 * {@link ParallaxLayer} short-circuits to a static `<div>` before this
 * mounts, so `useScroll` / `useTransform` are only called when an
 * animation is genuinely expected. Splitting the implementation in two
 * keeps the rules-of-hooks invariant intact when `reducedMotion` flips
 * at runtime: one subtree unmounts and the other mounts rather than
 * the same component reordering its hook calls.
 */
function ParallaxLayerMotion({
  children,
  maxPx = 20,
  className,
  style,
}: Required<Pick<ParallaxLayerProps, 'children'>> &
  Omit<ParallaxLayerProps, 'children'>): ReactElement {
  const ref = useRef<HTMLDivElement>(null);

  // `['start end', 'end start']` means: progress is 0 when the layer's
  // top edge hits the viewport bottom, and 1 when its bottom edge hits
  // the viewport top — i.e. the layer is tracked across its full pass
  // through the viewport.
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start end', 'end start'],
  });

  // Drive the y MotionValue through the pure helper so the math is
  // identical between the component and its property-based test.
  const y = useTransform(scrollYProgress, (progress) =>
    computeParallaxOffset(progress, { max: maxPx, reducedMotion: false }),
  );

  const composedClassName = className
    ? `parallax-layer ${className}`
    : 'parallax-layer';

  return (
    <motion.div
      ref={ref}
      className={composedClassName}
      style={{ ...style, y }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Wrapper that applies a bounded, scroll-driven Y parallax to its
 * children.
 *
 * Behavior:
 * - Under reduced motion, returns a plain `<div>` with the same
 *   `className` and `style` so the visual baseline (positioning,
 *   layout) is preserved and no scroll listener is attached.
 *   (Requirement 6.5)
 * - Otherwise tracks the layer's scroll progress through the viewport
 *   and translates the content on the Y axis between `-maxPx` and
 *   `+maxPx` (defaults to ±20 px → 40 px total swing per
 *   Requirement 6.3).
 * - `className` is forwarded so callers can stack their own styling on
 *   top of the `.parallax-layer` `will-change` hint declared in
 *   `landing-3d.css`. (Requirement 10.3)
 *
 * Requirements: 6.3, 6.5, 10.3
 */
export function ParallaxLayer({
  children,
  maxPx = 20,
  className,
  style,
}: ParallaxLayerProps): ReactElement {
  const { reducedMotion } = useLandingMotion();

  if (reducedMotion) {
    const composedClassName = className
      ? `parallax-layer ${className}`
      : 'parallax-layer';
    return (
      <div className={composedClassName} style={style}>
        {children}
      </div>
    );
  }

  return (
    <ParallaxLayerMotion maxPx={maxPx} className={className} style={style}>
      {children}
    </ParallaxLayerMotion>
  );
}

export default ParallaxLayer;
