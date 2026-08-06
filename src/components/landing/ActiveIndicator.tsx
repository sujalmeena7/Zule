// ============================================
// Zule AI — ActiveIndicator
// ============================================
//
// The pill-shaped indicator inside the FloatingNavbar that highlights
// the currently hovered or scroll-active nav link. The component owns
// three responsibilities:
//
//   1. A pure selector — `selectActiveTarget` — that picks the target
//      id from `{ hoveredId, sections, viewportCenterY }`. Exported as
//      a NAMED export so the property test in task 9.2 can import it
//      without instantiating the React component.
//   2. An `IntersectionObserver` (keyed to `#features`, `#how-it-works`,
//      `#faq`) plus supplemental scroll/resize listeners that keep the
//      section bounds fresh between threshold crossings.
//   3. A framer-motion `motion.span` with `layoutId="navActiveIndicator"`
//      that animates between targets over 300ms. Under reduced motion
//      the same DOM is rendered as a plain `<span>` with no transition,
//      per Requirement 4.6.
//
// The indicator is positioned absolutely; `itemRefs` are read with
// `offsetLeft` / `offsetWidth` so the indicator's left/width align with
// the active link inside the same offsetParent (the navbar).
//
// Requirements: 4.3, 4.4, 4.6

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type RefObject,
} from 'react';
import { motion } from 'framer-motion';

import { useLandingMotion } from './LandingMotionContext';

/**
 * Vertical extent of a section in viewport coordinates.
 *
 * `top` is inclusive, `bottom` is exclusive so two sections that touch
 * at a shared boundary cannot both claim the same `viewportCenterY`.
 */
export interface Section {
  id: string;
  top: number;
  bottom: number;
}

export interface SelectActiveTargetArgs {
  hoveredId: string | null;
  sections: Section[];
  viewportCenterY: number;
}

/**
 * Pure helper that decides which nav-link id should be marked active.
 *
 * Priority:
 *   1. `hoveredId` wins whenever it is not `null` so an explicit pointer
 *      hover always trumps the scroll-derived target.
 *   2. Otherwise the first section in `sections` whose `[top, bottom)`
 *      bounds contain `viewportCenterY` is returned.
 *   3. Otherwise `null` — no link is active.
 *
 * Validates: Requirements 4.4 (Property 7).
 */
export function selectActiveTarget({
  hoveredId,
  sections,
  viewportCenterY,
}: SelectActiveTargetArgs): string | null {
  if (hoveredId !== null) return hoveredId;
  for (const s of sections) {
    if (viewportCenterY >= s.top && viewportCenterY < s.bottom) {
      return s.id;
    }
  }
  return null;
}

/** Default page anchor sections observed by the navbar indicator. */
const DEFAULT_OBSERVED_SECTION_IDS: readonly string[] = [
  'features',
  'how-it-works',
  'faq',
];

/** Framer-motion transition spec — 300ms sits inside Req 4.3's [200, 400]ms band. */
const INDICATOR_TRANSITION = { duration: 0.3 } as const;

/**
 * Multiple IntersectionObserver thresholds so the indicator updates on
 * every meaningful boundary crossing rather than just enter/exit. The
 * supplemental scroll listener fills in the gaps between thresholds.
 */
const INTERSECTION_THRESHOLDS: readonly number[] = [0, 0.25, 0.5, 0.75, 1];

export interface ActiveIndicatorProps {
  /** Id of the link currently being hovered, or `null` when nothing is hovered. */
  hoveredId: string | null;
  /**
   * Refs to each nav-link DOM node, keyed by item id. The indicator
   * reads `offsetLeft` / `offsetWidth` of the active item's ref to
   * compute its own pixel position.
   */
  itemRefs: Record<string, RefObject<HTMLElement | null>>;
  /**
   * Section ids to watch via `IntersectionObserver`. Defaults to the
   * three landing-page anchor sections.
   */
  sectionIds?: readonly string[];
}

/**
 * Floating pill indicator inside the FloatingNavbar.
 *
 * Renders `null` until a target can be resolved (no hover, no
 * intersecting section, or refs not yet populated).
 *
 * Requirements: 4.3, 4.4, 4.6
 */
export function ActiveIndicator({
  hoveredId,
  itemRefs,
  sectionIds = DEFAULT_OBSERVED_SECTION_IDS,
}: ActiveIndicatorProps): JSX.Element | null {
  const { reducedMotion } = useLandingMotion();

  // Latest viewport-relative bounds of each observed section.
  const [sections, setSections] = useState<Section[]>([]);
  // Viewport center y, refreshed alongside the bounds.
  const [viewportCenterY, setViewportCenterY] = useState<number>(() =>
    typeof window === 'undefined' ? 0 : window.innerHeight / 2,
  );

  // ----------------------------------------------------------------
  // IntersectionObserver + supplemental scroll/resize subscription.
  // ----------------------------------------------------------------
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return;
    }

    const targets: Array<{ id: string; el: HTMLElement }> = [];
    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (el) targets.push({ id, el });
    }
    if (targets.length === 0) return;

    const recompute = (): void => {
      const next: Section[] = targets.map(({ id, el }) => {
        const r = el.getBoundingClientRect();
        return { id, top: r.top, bottom: r.bottom };
      });
      setSections(next);
      setViewportCenterY(window.innerHeight / 2);
    };

    recompute();

    const observer = new IntersectionObserver(recompute, {
      threshold: [...INTERSECTION_THRESHOLDS],
    });
    for (const { el } of targets) observer.observe(el);

    const onScroll = (): void => recompute();
    const onResize = (): void => recompute();

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [sectionIds]);

  // ----------------------------------------------------------------
  // Resolve the active target id via the pure helper.
  // ----------------------------------------------------------------
  const activeId = useMemo<string | null>(
    () => selectActiveTarget({ hoveredId, sections, viewportCenterY }),
    [hoveredId, sections, viewportCenterY],
  );

  // ----------------------------------------------------------------
  // Pixel-perfect position derived from the active link's DOM ref.
  // Re-measured whenever `activeId` changes, the navbar layout shifts
  // (`sections` updates cover scroll/resize), or `itemRefs` rebinds.
  // useLayoutEffect avoids a frame of mispositioned paint.
  // ----------------------------------------------------------------
  const [target, setTarget] = useState<{ left: number; width: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (activeId === null) {
      setTarget(null);
      return;
    }
    const el = itemRefs[activeId]?.current;
    if (!el) {
      setTarget(null);
      return;
    }
    setTarget({ left: el.offsetLeft, width: el.offsetWidth });
  }, [activeId, itemRefs, sections, viewportCenterY]);

  if (target === null) return null;

  // ----------------------------------------------------------------
  // Reduced motion: plain <span>, no transition. (Req 4.6)
  // ----------------------------------------------------------------
  if (reducedMotion) {
    return (
      <span
        className="nav-active-indicator"
        style={{
          position: 'absolute',
          left: target.left,
          width: target.width,
          transition: 'none',
        }}
        aria-hidden="true"
      />
    );
  }

  // ----------------------------------------------------------------
  // Animated path: framer-motion span with shared layoutId so navbar
  // expand/compact transitions also drag the indicator into place.
  // (Req 4.3)
  // ----------------------------------------------------------------
  return (
    <motion.span
      layoutId="navActiveIndicator"
      className="nav-active-indicator"
      animate={{ left: target.left, width: target.width }}
      transition={INDICATOR_TRANSITION}
      style={{ position: 'absolute' }}
      aria-hidden="true"
    />
  );
}

export default ActiveIndicator;
