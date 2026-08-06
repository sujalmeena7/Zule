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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
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
// Shared target model — interaction ownership
// --------------------------------------------------------------------------

/**
 * Every navigable element in the navbar. The three anchor entries share
 * ids with {@link FloatingNavbarAnchorId}; `blog` and `download` extend
 * the union so pointer/focus interactions cover the full link group.
 *
 * Requirements: 1.2, 1.5, 1.6, 6.2, 8.1, 8.2, 8.3
 */
export type NavTargetId =
  | 'features'
  | 'how-it-works'
  | 'faq'
  | 'blog'
  | 'download';

/**
 * Ownership channels for the three distinct input sources that compete
 * for active-indicator control.
 *
 * - `focusTarget` — keyboard navigation; highest priority.
 * - `hoverTarget` — pointer enter within the link group.
 * - `scrollActiveTarget` — viewport-center section observation fallback.
 *
 * Requirements: 1.2, 1.5, 1.6, 6.2
 */
export interface NavOwnership {
  hoverTarget: NavTargetId | null;
  focusTarget: NavTargetId | null;
  scrollActiveTarget: FloatingNavbarAnchorId | null;
}

/**
 * Pure resolver that selects the single active target from the three
 * ownership channels using focus → hover → scroll precedence.
 *
 * Focus takes priority while keyboard navigation is active; hover takes
 * priority over the scroll fallback whenever focus is absent. The scroll
 * observer can update continuously without changing the resolved target
 * during direct interaction.
 *
 * Requirements: 1.2, 1.5, 1.6, 6.2
 */
export function resolveActiveTarget(state: NavOwnership): NavTargetId | null {
  return state.focusTarget ?? state.hoverTarget ?? state.scrollActiveTarget;
}

// --------------------------------------------------------------------------
// Indicator geometry model
// --------------------------------------------------------------------------

/**
 * Resolved geometry for the active indicator, expressed relative to the
 * links shell coordinate space. The shell is a positioned container that
 * wraps both the link list and the indicator, so `x` and `width` are
 * exact pixel offsets within that shared parent.
 *
 * Requirements: 2.1, 2.3, 2.4, 2.7
 */
export interface IndicatorGeometry {
  /** The nav target this geometry was measured for. */
  id: NavTargetId;
  /** Horizontal offset of the target relative to the shell's left edge. */
  x: number;
  /** Width of the target element in CSS pixels. */
  width: number;
}

/**
 * Pure helper that converts absolute bounding-client-rect measurements
 * into shell-relative indicator geometry.
 *
 * By subtracting the shell's `left` from the target's `left`, the
 * resulting `x` is always relative to the shell regardless of the
 * shell's position in the viewport. This eliminates the coordinate-space
 * mismatch that occurred when `offsetLeft` was measured against a
 * different offset parent than the indicator's own container.
 *
 * Requirements: 2.3, 2.4
 */
export function toIndicatorGeometry(
  id: NavTargetId,
  shell: Pick<DOMRect, 'left'>,
  target: Pick<DOMRect, 'left' | 'width'>,
): IndicatorGeometry {
  return { id, x: target.left - shell.left, width: target.width };
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
  // Links shell ref and indicator geometry.
  //
  // The shell is a positioned <div> that wraps the <ul> and the
  // ActiveIndicator. Measuring both the active target and the shell
  // with getBoundingClientRect and subtracting shell.left gives us
  // exact relative x/width — no offset-parent mismatch.
  //
  // The useLayoutEffect fires before paint so the indicator geometry
  // is committed atomically as a complete { id, x, width } object.
  //
  // Requirements: 2.1, 2.3, 2.4, 2.7
  // ----------------------------------------------------------------
  const shellRef = useRef<HTMLDivElement | null>(null);
  // Indicator geometry is committed before paint by the useLayoutEffect below.
  // It will be consumed by ActiveIndicator once task 3.1 refactors it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [indicatorGeometry, setIndicatorGeometry] =
    useState<IndicatorGeometry | null>(null);

  // ----------------------------------------------------------------
  // Interaction ownership — delegated at the Link_Group (<ul>) level.
  //
  // hoverTarget: set by pointerover on any [data-nav-id] descendant.
  //   Cleared only on pointerleave of the entire group (not on
  //   individual pointerout when the related target stays inside).
  //
  // focusTarget: set by focusin (capture phase) on any [data-nav-id]
  //   descendant. Cleared only when focus leaves the group entirely.
  //
  // The resolved active target uses focus → hover → scroll precedence
  // via resolveActiveTarget.
  //
  // Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 4.1, 4.2, 4.6, 6.1, 6.2
  // ----------------------------------------------------------------
  const [hoverTarget, setHoverTarget] = useState<NavTargetId | null>(null);
  const [focusTarget, setFocusTarget] = useState<NavTargetId | null>(null);

  // Ref to the Link_Group (<ul>) for containment checks.
  const linkGroupRef = useRef<HTMLUListElement | null>(null);

  /**
   * Resolve a NavTargetId from the closest [data-nav-id] ancestor of
   * a given event target node. Returns null if the node is not inside
   * a nav item.
   */
  const resolveNavId = useCallback(
    (node: EventTarget | null): NavTargetId | null => {
      if (!(node instanceof HTMLElement)) return null;
      const item = node.closest<HTMLElement>('[data-nav-id]');
      if (!item) return null;
      return (item.dataset.navId as NavTargetId) ?? null;
    },
    [],
  );

  /**
   * Returns true when `node` is contained within the Link_Group.
   */
  const isInsideLinkGroup = useCallback(
    (node: EventTarget | null): boolean => {
      if (!linkGroupRef.current || !(node instanceof Node)) return false;
      return linkGroupRef.current.contains(node);
    },
    [],
  );

  // --- Pointer event delegation ---

  const handlePointerOver = useCallback(
    (event: ReactPointerEvent<HTMLUListElement>) => {
      const id = resolveNavId(event.target);
      if (id) setHoverTarget(id);
    },
    [resolveNavId],
  );

  const handlePointerOut = useCallback(
    (event: ReactPointerEvent<HTMLUListElement>) => {
      // If the pointer is moving to another element still inside the
      // Link_Group, don't clear hover — the next pointerover will set
      // the new target. This eliminates the null-gap between adjacent
      // link transfers.
      if (isInsideLinkGroup(event.relatedTarget)) return;
      // relatedTarget is null or outside the group — treat as leave.
      setHoverTarget(null);
    },
    [isInsideLinkGroup],
  );

  const handlePointerLeave = useCallback(
    () => {
      setHoverTarget(null);
    },
    [],
  );

  // --- Focus event delegation (capture phase) ---

  const handleFocusCapture = useCallback(
    (event: ReactFocusEvent<HTMLUListElement>) => {
      const id = resolveNavId(event.target);
      if (id) setFocusTarget(id);
    },
    [resolveNavId],
  );

  const handleBlurCapture = useCallback(
    (event: ReactFocusEvent<HTMLUListElement>) => {
      // Retain focus ownership when relatedTarget remains in the group.
      if (isInsideLinkGroup(event.relatedTarget)) return;
      setFocusTarget(null);
    },
    [isInsideLinkGroup],
  );

  // --- Resolved active target ---
  // This is the "winning" target that ActiveIndicator uses. The
  // resolveActiveTarget function implements focus → hover → scroll
  // precedence. scrollActiveTarget currently comes from ActiveIndicator's
  // internal observer; it is passed here as null until task 2.2 migrates
  // that observer into this component.
  const scrollActiveTarget: FloatingNavbarAnchorId | null = null;

  const resolvedActiveTarget = resolveActiveTarget({
    focusTarget,
    hoverTarget,
    scrollActiveTarget,
  });

  // Legacy hoveredId — still passed to ActiveIndicator for the existing
  // indicator logic (until task 3.1 refactors it to consume geometry).
  // The new delegated hoverTarget supersedes the per-link makeHoverHandler
  // for ownership, but we keep the prop for visual continuity.
  const hoveredId = resolvedActiveTarget;

  // ----------------------------------------------------------------
  // Geometry measurement — useLayoutEffect before paint.
  //
  // Whenever the resolved active target changes, we measure both the
  // shell and the target element with getBoundingClientRect and commit
  // the complete { id, x, width } geometry atomically. Running in a
  // layout effect ensures the indicator position is ready before the
  // browser paints, avoiding a stale frame.
  //
  // The full remeasurement logic (ResizeObserver, compact state, font
  // readiness) is added in task 2.2. This effect handles the core
  // target-change measurement path.
  //
  // Requirements: 2.1, 2.3, 2.4, 2.7
  // ----------------------------------------------------------------
  useLayoutEffect(() => {
    if (resolvedActiveTarget === null) {
      setIndicatorGeometry(null);
      return;
    }

    const shellEl = shellRef.current;
    if (!shellEl) {
      setIndicatorGeometry(null);
      return;
    }

    const targetRef = itemRefs[resolvedActiveTarget];
    const targetEl = targetRef?.current;
    if (!targetEl) {
      setIndicatorGeometry(null);
      return;
    }

    const shellRect = shellEl.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();

    setIndicatorGeometry(
      toIndicatorGeometry(resolvedActiveTarget, shellRect, targetRect),
    );
  }, [resolvedActiveTarget, itemRefs]);

  // Legacy makeHoverHandler — retained on MagneticLink so the existing
  // onHoverChange prop is not removed yet (that's task 4.1). These
  // callbacks are now no-ops for ownership; the Link_Group delegation
  // above is the source of truth.
  const makeHoverHandler = useCallback(
    () => () => {
      // Intentionally no-op: ownership is now delegated at the group level.
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

      <div ref={shellRef} className="floating-navbar-links-shell">
        <ul
          ref={linkGroupRef}
          className="floating-navbar-items"
          onPointerOver={handlePointerOver}
          onPointerOut={handlePointerOut}
          onPointerLeave={handlePointerLeave}
          onFocusCapture={handleFocusCapture}
          onBlurCapture={handleBlurCapture}
        >
        {ANCHOR_ITEMS.map((item) => {
          // Picking the right ref per item keeps the JSX flat without
          // an extra map<ref> indirection.
          const ref =
            item.id === 'features'
              ? featuresRef
              : item.id === 'how-it-works'
                ? howItWorksRef
                : faqRef;

          // data-active marks the currently resolved active target.
          const isActive = resolvedActiveTarget === item.id;
          // aria-current="location" only applies to scroll-derived
          // active anchors (not hover/focus targets).
          const isScrollActive =
            !focusTarget && !hoverTarget && scrollActiveTarget === item.id;

          return (
            <li
              key={item.id}
              ref={ref}
              className="floating-navbar-item"
              data-nav-id={item.id}
              data-active={isActive ? 'true' : undefined}
              aria-current={isScrollActive ? 'location' : undefined}
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
          data-active={resolvedActiveTarget === 'blog' ? 'true' : undefined}
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
          data-active={resolvedActiveTarget === 'download' ? 'true' : undefined}
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
      </div>
    </motion.nav>
  );
}

export default FloatingNavbar;
