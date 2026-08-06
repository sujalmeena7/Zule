// ============================================
// Zule AI — FloatingNavbar
// ============================================
//
// The glassmorphic pill that replaces the existing `.landing-header`
// on the public landing page. Composes the three nav-scoped helpers
// implemented in earlier waves:
//
//   - `Logo3D`         — the 3D-tilted brand mark on the left.
//   - `MagneticLink`   — each of the five nav entries (Features,
//                        How it works, FAQ, Blog, Get Zule). The CTA
//                        receives an extra class so callers can style
//                        it as a button without changing the helper.
//   - `ActiveIndicator`— the sliding pill that aligns with whichever
//                        entry is currently hovered or whose anchor
//                        section is intersecting the viewport center.
//
// Scroll-driven compaction follows the spec verbatim: `useScroll`
// keyed to `heroBottomRef` with `offset: ['end end', 'end start']`
// turns into a continuous `[0, 1]` progress, then `useTransform`
// collapses that into a discrete `compact` flag matching the pure
// helper `isCompact(scrollY, heroBottom) = scrollY >= heroBottom`
// (Property 6 in design.md). The same flag drives a 300 ms
// `[0.16, 1, 0.3, 1]` ease on padding so the visible pill shrinks
// once the hero has fully scrolled past the viewport top.
//
// `isCompact` is a NAMED export so the property-based test in 10.2
// can import it directly without rendering the component.
//
// Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 8.3, 8.4, 8.5, 10.2

import {
  motion,
  useMotionValueEvent,
  useScroll,
  useTransform,
} from 'framer-motion';
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';

import { ActiveIndicator } from './ActiveIndicator';
import { Logo3D } from './Logo3D';
import { MagneticLink } from './MagneticLink';

// --------------------------------------------------------------------------
// Pure helper — discrete compaction flag
// --------------------------------------------------------------------------

/**
 * Pure helper that decides whether the {@link FloatingNavbar} should
 * render in its compact pill form.
 *
 * Returns `true` whenever the current vertical scroll position has
 * reached or passed the bottom edge of the hero section, exactly
 * matching the wording of Requirement 3.3 / 3.4. Exported so the
 * property test in task 10.2 (Property 6) can validate the boolean
 * directly without instantiating React or framer-motion.
 *
 * Requirements: 3.3, 3.4
 */
export function isCompact(scrollY: number, heroBottom: number): boolean {
  return scrollY >= heroBottom;
}

// --------------------------------------------------------------------------
// Static configuration
// --------------------------------------------------------------------------

/** Anchor-driven nav entry ids that map to `<section id="...">` targets. */
export type FloatingNavbarAnchorId = 'features' | 'how-it-works' | 'faq';

/**
 * The three anchor entries are derived from this table so the JSX, the
 * `ActiveIndicator` `sectionIds` prop, and the click handlers all share
 * a single source of truth.
 */
const ANCHOR_ITEMS: ReadonlyArray<{
  id: FloatingNavbarAnchorId;
  label: string;
  href: `#${FloatingNavbarAnchorId}`;
}> = [
  { id: 'features', label: 'Features', href: '#features' },
  { id: 'how-it-works', label: 'How it works', href: '#how-it-works' },
  { id: 'faq', label: 'FAQ', href: '#faq' },
];

/** Section ids the `ActiveIndicator` watches via `IntersectionObserver`. */
const OBSERVED_SECTION_IDS: readonly string[] = ANCHOR_ITEMS.map(
  (item) => item.id,
);

/**
 * Compact/expanded padding values used by the `motion.nav` animation.
 *
 * Two padding pairs (horizontal / vertical) is the same shrink contract
 * called out in design.md — `padding: 12px 24px → 6px 16px` — so the
 * visible pill height *and* width both step down once the hero has
 * scrolled past.
 */
const EXPANDED_PADDING_X = 24;
const EXPANDED_PADDING_Y = 12;
const COMPACT_PADDING_X = 16;
const COMPACT_PADDING_Y = 6;

/**
 * 300 ms transition with the `expo-out`-ish bezier (`[0.16, 1, 0.3, 1]`)
 * from design.md. The duration sits inside the [200, 400] ms band
 * required by Requirement 3.5.
 */
const NAV_TRANSITION = {
  duration: 0.3,
  ease: [0.16, 1, 0.3, 1],
} as const;

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export interface FloatingNavbarProps {
  /** Wraps `actions.navigateTo('blog')` in the host. (Req 8.4) */
  onBlog: () => void;
  /** Wraps the existing OS-aware `handleDownload`. (Req 8.3) */
  onDownload: () => void;
  /** Smooth-scrolls to one of the anchor sections. (Req 8.5) */
  onAnchor: (id: FloatingNavbarAnchorId) => void;
  /**
   * Ref to the hero section element. Used as the `target` of
   * `useScroll` so the compaction trigger is computed relative to the
   * hero's bottom edge rather than an absolute pixel value.
   */
  heroBottomRef: RefObject<HTMLElement | null>;
}

/**
 * The floating glassmorphic navbar.
 *
 * Layout: a `motion.nav.floating-navbar` (positioned and styled in
 * `landing-3d.css`) wraps the `Logo3D`, a `<ul>` of five
 * `MagneticLink` entries, and a single `ActiveIndicator`. The
 * indicator is positioned absolutely against each link's bounding
 * box via `itemRefs`, so it slides smoothly between targets on hover
 * and on scroll-derived section changes.
 *
 * Compaction: `useScroll` keyed to `heroBottomRef` produces a
 * `[0, 1]` progress that reaches `1` exactly when the hero's bottom
 * edge crosses the viewport top — equivalent to `scrollY >= heroBottom`,
 * the contract enforced by the pure helper {@link isCompact}.
 * `useTransform` projects that progress into a discrete `0|1`
 * MotionValue, and `useMotionValueEvent` mirrors it into local React
 * state so the `animate` prop on `motion.nav` can drive a styled
 * transition between expanded and compact padding values.
 *
 * Click wiring: anchor entries call `preventDefault` and delegate to
 * the `onAnchor` callback from the host so the existing smooth-scroll
 * handler stays the single source of scroll behaviour. Blog and
 * "Get Zule" delegate to `onBlog` / `onDownload` the same way; they
 * are still rendered as `MagneticLink` so all five entries get the
 * same hover treatment per the task description.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 8.3, 8.4, 8.5, 10.2
 */
export function FloatingNavbar({
  onBlog,
  onDownload,
  onAnchor,
  heroBottomRef,
}: FloatingNavbarProps): JSX.Element {
  // ----------------------------------------------------------------
  // Scroll-driven compaction.
  // ----------------------------------------------------------------
  const { scrollYProgress } = useScroll({
    target: heroBottomRef,
    // 'end end' → bottom of hero at bottom of viewport (progress 0).
    // 'end start' → bottom of hero at top of viewport (progress 1).
    // Progress 1 is therefore the moment `scrollY === heroBottom`,
    // mirroring the contract of `isCompact(scrollY, heroBottom)`.
    offset: ['end end', 'end start'],
  });

  // `useTransform` projects the continuous progress into the discrete
  // compaction flag (`0 | 1`). Threshold of `>= 1` matches the helper.
  const compactMv = useTransform(scrollYProgress, (progress) =>
    progress >= 1 ? 1 : 0,
  );

  const [compact, setCompact] = useState<boolean>(false);

  useMotionValueEvent(compactMv, 'change', (latest) => {
    setCompact(latest === 1);
  });

  // ----------------------------------------------------------------
  // Refs for each nav entry — consumed by ActiveIndicator to pixel-
  // align the sliding pill with whichever entry is currently active.
  // ----------------------------------------------------------------
  const featuresRef = useRef<HTMLLIElement | null>(null);
  const howItWorksRef = useRef<HTMLLIElement | null>(null);
  const faqRef = useRef<HTMLLIElement | null>(null);
  const blogRef = useRef<HTMLLIElement | null>(null);
  const downloadRef = useRef<HTMLLIElement | null>(null);

  // `Record<string, RefObject<HTMLElement | null>>` matches the prop
  // shape exported by `ActiveIndicator`. Memoized so the indicator's
  // internal `useLayoutEffect` doesn't refire on every parent render.
  const itemRefs = useMemo<Record<string, RefObject<HTMLElement | null>>>(
    () => ({
      features: featuresRef,
      'how-it-works': howItWorksRef,
      faq: faqRef,
      blog: blogRef,
      download: downloadRef,
    }),
    [],
  );

  // ----------------------------------------------------------------
  // Hover tracking — fed into ActiveIndicator's `hoveredId` prop.
  // We only clear the state if the leaving link was the one currently
  // tracked, so a quick pointer move between adjacent links never
  // produces a blank frame where no link is highlighted.
  // ----------------------------------------------------------------
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const makeHoverHandler = useCallback(
    (id: string) => (hovered: boolean) => {
      setHoveredId((prev) => {
        if (hovered) return id;
        return prev === id ? null : prev;
      });
    },
    [],
  );

  // ----------------------------------------------------------------
  // Click wiring — every callback `preventDefault`s so the browser
  // doesn't perform its own (potentially full-page) navigation; the
  // host-supplied prop handles routing or smooth scroll.
  // ----------------------------------------------------------------
  const makeAnchorClick = useCallback(
    (id: FloatingNavbarAnchorId) =>
      (event: ReactMouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        onAnchor(id);
      },
    [onAnchor],
  );

  const handleBlogClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      onBlog();
    },
    [onBlog],
  );

  const handleDownloadClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      onDownload();
    },
    [onDownload],
  );

  // ----------------------------------------------------------------
  // Render. The class composition adds `floating-navbar--compact`
  // when the compact flag is set so callers can layer additional
  // CSS-only adjustments (e.g. font-size shrink) without re-reading
  // the same scroll progress.
  // ----------------------------------------------------------------
  const navClassName = compact
    ? 'floating-navbar floating-navbar--compact'
    : 'floating-navbar';

  return (
    <motion.nav
      className={navClassName}
      data-compact={compact ? 'true' : 'false'}
      aria-label="Primary navigation"
      animate={{
        paddingTop: compact ? COMPACT_PADDING_Y : EXPANDED_PADDING_Y,
        paddingBottom: compact ? COMPACT_PADDING_Y : EXPANDED_PADDING_Y,
        paddingLeft: compact ? COMPACT_PADDING_X : EXPANDED_PADDING_X,
        paddingRight: compact ? COMPACT_PADDING_X : EXPANDED_PADDING_X,
      }}
      transition={NAV_TRANSITION}
    >
      <Logo3D className="floating-navbar-logo" />

      <ul className="floating-navbar-items">
        {ANCHOR_ITEMS.map((item) => {
          // Picking the right ref per item keeps the JSX flat without
          // an extra map<ref> indirection.
          const ref =
            item.id === 'features'
              ? featuresRef
              : item.id === 'how-it-works'
                ? howItWorksRef
                : faqRef;
          return (
            <li
              key={item.id}
              ref={ref}
              className="floating-navbar-item"
              data-nav-id={item.id}
            >
              <MagneticLink
                href={item.href}
                label={item.label}
                onClick={makeAnchorClick(item.id)}
                onHoverChange={makeHoverHandler(item.id)}
              />
            </li>
          );
        })}

        <li
          ref={blogRef}
          className="floating-navbar-item"
          data-nav-id="blog"
        >
          <MagneticLink
            href="#"
            label="Blog"
            onClick={handleBlogClick}
            onHoverChange={makeHoverHandler('blog')}
          />
        </li>

        <li
          ref={downloadRef}
          className="floating-navbar-item floating-navbar-item--cta"
          data-nav-id="download"
        >
          <MagneticLink
            href="#"
            label="Get Zule"
            className="floating-navbar-cta"
            onClick={handleDownloadClick}
            onHoverChange={makeHoverHandler('download')}
          />
        </li>
      </ul>

      <ActiveIndicator
        hoveredId={hoveredId}
        itemRefs={itemRefs}
        sectionIds={OBSERVED_SECTION_IDS}
      />
    </motion.nav>
  );
}

export default FloatingNavbar;
