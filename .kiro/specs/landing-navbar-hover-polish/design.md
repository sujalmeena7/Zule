# Design Document

## Overview

This navbar-only change replaces the current split hover/indicator timing with one interaction owner in `FloatingNavbar`, reduces indicator travel latency, normalizes measurements into one coordinate space, and layers premium styling onto the existing markup. `LandingPage.tsx`, section content, anchor callbacks, blog navigation, download handling, and hero-driven compaction remain architecturally unchanged.

The dominant workspace language is **TypeScript** (the inspected landing implementation is TypeScript/TSX, with CSS for presentation). Code and test examples therefore use TypeScript.

## Existing Root Cause

The visible lag between FAQ and How it works is the combination of four concrete behaviors:

1. `MagneticLink` emits `onHoverChange(false)` on each child `pointerleave`. `FloatingNavbar.makeHoverHandler` then clears the current id. During an adjacent-link transfer, the old link can clear to `null` before the new link's enter event sets the next id. The existing guard only ignores a late leave after another id already won; it does not prevent the normal leave-first gap.
2. `ActiveIndicator` derives `activeId`, then runs a separate `useLayoutEffect`, then writes a second `target` state. Ownership and geometry therefore update through separate render/state steps while the previous target remains visible.
3. The indicator uses a fixed 300 ms transition. That duration is conspicuous when moving between the narrow FAQ item and the wider How it works item, especially if transitions are interrupted repeatedly.
4. `offsetLeft` is read from a list item whose offset parent is `.floating-navbar-items`, while the indicator is rendered as a sibling of that list and positioned against `.floating-navbar`. This mixes coordinate spaces and makes alignment dependent on logo/gap layout.

`MagneticLink` also registers one window-level `pointermove` listener per link and enables magnetic work without checking whether the device supports hover. This is not the stale-frame cause, but it is unnecessary work on touch-oriented devices.

## Architecture

```text
LandingPage (unchanged integration and callbacks)
└── FloatingNavbar (single interaction owner)
    ├── Logo3D (existing bounded motion; refined state styling)
    ├── links-shell (single geometry coordinate space)
    │   ├── ActiveIndicator (presentational; no observer/state ownership)
    │   └── Link_Group
    │       ├── MagneticLink × 4
    │       └── Get Zule MagneticLink
    └── useScrollActiveTarget (section-center fallback)
```

`FloatingNavbar` owns `hoverTarget`, `focusTarget`, `scrollActiveTarget`, and the resolved `activeTarget`. Delegated pointer and focus handlers live on the Link_Group. `ActiveIndicator` receives one already-resolved geometry object and only renders animation. This removes competing state timelines.

## Components and Interfaces

### `FloatingNavbar.tsx`

Add a shared target type and pure state helpers:

```ts
export type NavTargetId = 'features' | 'how-it-works' | 'faq' | 'blog' | 'download';

export interface NavOwnership {
  hoverTarget: NavTargetId | null;
  focusTarget: NavTargetId | null;
  scrollActiveTarget: FloatingNavbarAnchorId | null;
}

export function resolveActiveTarget(state: NavOwnership): NavTargetId | null {
  return state.focusTarget ?? state.hoverTarget ?? state.scrollActiveTarget;
}
```

Focus takes priority while keyboard navigation is active; hover takes priority over the scroll fallback whenever focus is absent. The scroll observer can update continuously without changing the resolved target during direct interaction.

Replace per-link hover callbacks with delegated handlers on the Link_Group:

- `onPointerOver`: resolve `event.target.closest('[data-nav-id]')` and synchronously commit that id.
- `onPointerOut`: inspect `event.relatedTarget`; when the related node remains inside the Link_Group, do not clear hover. The following `pointerover` commits the adjacent id, so no scroll fallback is rendered between links.
- `onPointerLeave`: clear hover once for the whole Link_Group and resolve the current scroll fallback.
- `onFocusCapture`: commit the focused item's id.
- `onBlurCapture`: retain focus ownership when `relatedTarget` remains in the group; otherwise clear focus and resolve hover or scroll ownership.

The existing `onAnchor`, `onBlog`, `onDownload`, `heroBottomRef`, nav labels, hrefs, and click handlers remain unchanged. Add `aria-current="location"` only to an anchor-backed scroll target when no direct interaction target overrides it; active visual state is exposed with `data-active` on each item.

Move section observation out of `ActiveIndicator` into a local `useScrollActiveTarget` hook in `FloatingNavbar.tsx` (or a co-located helper if file size requires extraction). Preserve viewport-center selection for `features`, `how-it-works`, and `faq`. Observer/scroll updates only write `scrollActiveTarget`.

## Data Models

### Geometry model

Wrap the indicator and `<ul>` in `.floating-navbar-links-shell { position: relative; }`. Measure both target and shell with `getBoundingClientRect` and normalize them:

```ts
export interface IndicatorGeometry {
  id: NavTargetId;
  x: number;
  width: number;
}

export function toIndicatorGeometry(
  id: NavTargetId,
  shell: Pick<DOMRect, 'left'>,
  target: Pick<DOMRect, 'left' | 'width'>,
): IndicatorGeometry {
  return { id, x: target.left - shell.left, width: target.width };
}
```

A `useLayoutEffect` measures the resolved target and commits the complete `{ id, x, width }` object before paint. The same function runs on active-target changes, compact-mode changes, `ResizeObserver` notifications for the shell/active item, viewport resize, and `document.fonts.ready` where supported. Hidden mobile items produce `null` geometry, which hides the indicator.

### `ActiveIndicator.tsx`

Convert `ActiveIndicator` into a presentational component:

```ts
interface ActiveIndicatorProps {
  geometry: IndicatorGeometry | null;
  reducedMotion: boolean;
}
```

Remove `IntersectionObserver`, section state, viewport state, `itemRefs`, `activeId` selection, and `layoutId`. Render one `motion.span` at `left: 0` and animate `x` plus `width`. Use an interruptible 140 ms tween with `[0.2, 0.8, 0.2, 1]`; a newly supplied geometry retargets from the current visual value rather than queueing an old destination. Reduced motion uses duration `0`. CSS sets `will-change: transform, width`.

This design starts movement in the same committed frame, settles below the 180 ms requirement, and permits width and position to animate independently while guaranteeing exact final geometry.

### `MagneticLink.tsx`

Keep `computeMagneticOffset`, the 60 px activation radius, and 12 px magnitude bound. Remove `onHoverChange`; ownership now belongs to the Link_Group. Add a `canHover` input sourced from `matchMedia('(hover: hover) and (pointer: fine)')`. Attach pointer tracking only when `canHover && !reducedMotion`. Cancel in-flight `animate` controls during cleanup and when direct tracking resumes so a prior return-to-zero animation cannot pull against the pointer.

Retain semantic anchors and existing click callbacks. Add `data-active`/`aria-current` passthrough so high-emphasis and focus states are styled without changing destinations.

### `Logo3D.tsx`

Preserve the existing component contract and bounded rotation helper. Add navbar-scoped hover styling and focus-visible styling when an interactive `onClick` use supplies focusability; do not invent a new route or modify landing navigation. Reduced motion snaps transforms to zero while retaining non-motion glow/edge feedback.

## CSS Design (`landing-3d.css` and existing navbar tokens)

Only navbar selectors and navbar custom properties change. Hero canvas, tilt cards, parallax, sections, and footer rules remain untouched.

- Raise `--nav-blur` from 14 px to 22 px and add navbar-specific surface, edge, inset, ambient-shadow, directional-shadow, indicator, and glow tokens under `.landing-container`.
- Build the Premium_Surface from the `.floating-navbar` base plus `::before` and `::after` translucent layers. Keep pseudo-elements behind content and `pointer-events: none`.
- Use a one-pixel gradient edge, a soft ambient shadow, a tighter directional shadow below the pill, and low-opacity indigo/teal glow. Glow must not reduce text contrast.
- Style `.nav-active-indicator` with a translucent gradient, one-pixel edge, inset top highlight, and restrained outer glow.
- Style `[data-active='true'] > .magnetic-link` as high emphasis. Idle links retain a verified readable muted color.
- Refine CTA idle/hover/focus-visible states with a premium light gradient, subtle inner highlight, elevation, and bounded transform. Refine the logo shell with edge/glow states.
- Add `@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))` to automatically select an opaque surface fallback.
- Add `@media (hover: none), (pointer: coarse)` to suppress magnetic/decorative hover transforms while keeping active/focus colors.
- Preserve the existing 720 px breakpoint: only logo and CTA remain visible, no hidden-link indicator renders, and max-width/padding prevent horizontal overflow.
- Extend the reduced-motion block to disable indicator, CTA, and logo transform transitions without suppressing color or focus state.

Contrast values are verified with automated axe checks plus explicit computed-color assertions where axe cannot inspect translucent compositing reliably. Target ratios are 4.5:1 for text and 3:1 for focus/state boundaries.

## State and Timing Flow

```text
pointerover/focusin on item
  → derive NavTargetId from closest data-nav-id
  → commit owner state
  → resolve focus ?? hover ?? scroll
  → layout-effect measure target relative to links-shell
  → commit one IndicatorGeometry object
  → paint starts/retargets ≤140 ms animation

pointerout to another item
  → relatedTarget is still inside Link_Group
  → keep current hover owner (no null/fallback commit)
  → next pointerover commits new owner

pointerleave Link_Group
  → hoverTarget = null
  → resolve focusTarget or Scroll_Active_Target
  → measure and retarget before paint
```

Rapid transfers do not queue animations. Framer Motion receives only the newest geometry prop; interruption starts from the current rendered transform and width.

## Error Handling

| Condition | Handling |
| --- | --- |
| Target ref missing or hidden | Return `null` geometry and hide the indicator. |
| `relatedTarget` is `null` | Treat as leaving the Link_Group and fall back to focus/scroll. |
| `ResizeObserver` unavailable | Remeasure on active id, compact state, window resize, and font readiness. |
| `document.fonts` unavailable | Skip font subscription; normal layout/resize measurement remains. |
| Backdrop filter unsupported | Automatic opaque high-contrast surface via `@supports not`. |
| Coarse pointer/no hover | No magnetic listener; click and keyboard behavior remain. |
| Reduced motion enabled mid-transition | Retarget current geometry with zero-duration transition and reset transforms. |
| No viewport-center section | `scrollActiveTarget = null`; hide indicator unless focus/hover owns it. |

## Files Changed

- `src/components/landing/FloatingNavbar.tsx`: central ownership, delegated pointer/focus events, scroll fallback, geometry measurement, active data attributes.
- `src/components/landing/ActiveIndicator.tsx`: presentational geometry animation with responsive and reduced-motion transitions.
- `src/components/landing/MagneticLink.tsx`: remove hover ownership callback; gate magnetic tracking by input capability and cancel stale controls.
- `src/components/landing/Logo3D.tsx`: only if required for focus-state passthrough and reduced-motion-safe premium states.
- `src/components/landing/landing-3d.css`: navbar-only premium surface, indicator, link, CTA, logo, responsive, fallback, and motion rules.
- `src/components/LandingPage.css`: navbar custom-property refinements only.
- `src/components/landing/__tests__/FloatingNavbar.test.tsx`: ownership, routing, keyboard, responsive, and reduced-motion component tests.
- `src/components/landing/__tests__/navIndicator.property.test.ts`: pure ownership/geometry/latest-target properties.
- `e2e/landing-navbar.spec.ts` or the existing landing e2e location: focused pointer-transfer, geometry, visual-state, and accessibility checks.

`LandingPage.tsx` requires no behavioral change because the current props already preserve all required callbacks and the hero reference.

## Testing Strategy

Use Vitest 3.2.4, React Testing Library 16.1.0, fast-check 3.23.2, and the existing Playwright/axe stack.

- **Unit/component tests:** delegated pointerover/out behavior, group leave fallback, focus precedence/fallback, missing refs, compact remeasurement, reduced-motion transition, hover-capability gating, exact callback wiring, and mobile visibility.
- **Property tests:** target-resolution precedence, adjacent-transfer ownership, normalized geometry, rapid latest-target convergence, and magnetic displacement bounds. Run each property for at least 100 generated cases and label tests with `Feature: landing-navbar-hover-polish, Property N: ...`.
- **Browser tests:** move the pointer repeatedly between FAQ and How it works and across three-plus links; assert no fallback frame, final geometry within 1 px, settlement by 180 ms, no horizontal overflow at representative mobile widths, keyboard parity, reduced-motion behavior, and axe results.
- **Regression validation:** targeted Vitest files, targeted Playwright navbar spec, `npm run build`, and diagnostics for modified TypeScript/CSS files. No landing sections outside the navbar are edited.

## Property Reflection

The prework identified overlapping ownership properties for hover precedence, focus precedence, empty ownership, and focus-leave fallback. These are consolidated into Property 1 because one ordered resolver (`focus ?? hover ?? scroll`) implies all four outcomes. Geometry alignment and different-width final-state checks are consolidated into Property 3. Magnetic text bounds, no-hover capability gating, reduced-motion gating, and the existing 12 px invariant are consolidated into Property 5. Rapid transfer remains separate from pairwise transfer because interrupted sequences of three or more targets exercise latest-command convergence rather than only null-gap prevention. Timing, CSS appearance, accessibility ratios, routing, and responsive rendering remain example/browser tests because randomized inputs provide little additional value.

## Correctness Properties

*A property is a characteristic or behavior that must hold across all valid executions. These properties bridge the human-readable requirements and executable property-based tests.*

### Property 1: Interaction target precedence

For any combination of `focusTarget`, `hoverTarget`, and `scrollActiveTarget`, `resolveActiveTarget` returns `focusTarget` when focus exists, otherwise returns `hoverTarget` when hover exists, otherwise returns `scrollActiveTarget`, and otherwise returns `null`.

**Validates: Requirements 1.2, 1.5, 1.6, 6.2**

### Property 2: Adjacent transfer preserves direct ownership

For any two distinct valid navbar target ids and any scroll-active target, processing a pointer transfer whose related target remains inside the Link_Group never emits the scroll-active target or `null` between the source and destination ownership states.

**Validates: Requirements 1.3**

### Property 3: Relative indicator geometry is exact

For any finite shell-left coordinate and any visible target rectangle with positive finite width, `toIndicatorGeometry` returns `x = target.left - shell.left` and `width = target.width`; therefore the settled geometry for targets of any label width matches the newest target geometry within one CSS pixel after browser rounding.

**Validates: Requirements 2.3, 2.4**

### Property 4: Rapid retargeting converges on the latest target

For any sequence of three or more valid navbar target ids received before prior transitions settle, the ownership and indicator command model retains only the most recent target as the destination and does not insert a scroll-active fallback command while the pointer remains inside the Link_Group.

**Validates: Requirements 2.5**

### Property 5: Magnetic response remains bounded and gated

For any finite pointer offset vector and any input capability and reduced-motion state, magnetic displacement has magnitude at most 12 CSS pixels with signed axis components; displacement is exactly zero when reduced motion is active or hover/fine-pointer capability is absent.

**Validates: Requirements 2.7, 5.6, 7.2, 8.5**

### Property 6: Navbar compaction boundary remains stable

For any finite vertical scroll position and hero-bottom offset, the compact state is true exactly when the scroll position is greater than or equal to the hero-bottom offset.

**Validates: Requirements 8.4**