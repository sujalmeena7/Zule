# Implementation Plan: Landing Navbar Hover Polish

## Overview

Refactor the existing TypeScript/React navbar incrementally: centralize pointer/focus/scroll ownership in `FloatingNavbar`, normalize indicator measurements inside one links shell, make `ActiveIndicator` a fast presentational animation, gate magnetic work by input capability, then apply navbar-scoped premium styling and focused regression tests. Preserve every existing destination, callback, hero compaction rule, and non-navbar landing component.

## Tasks

- [ ] 1. Centralize navbar interaction ownership in `FloatingNavbar.tsx`
  - [x] 1.1 Add the shared target model and pure active-target resolver
    - Define `NavTargetId`, `NavOwnership`, and `resolveActiveTarget` with focus → hover → scroll precedence.
    - Keep the existing nav item ids, labels, hrefs, and `FloatingNavbarProps` callback contract unchanged.
    - _Requirements: 1.2, 1.5, 1.6, 6.2, 8.1, 8.2, 8.3_

  - [-] 1.2 Replace per-link hover clearing with Link_Group event delegation
    - Handle pointer over/out/leave at the list boundary and use `relatedTarget` containment so adjacent transfers never clear to scroll state.
    - Handle focus/blur capture at the same boundary and expose `data-active`/`aria-current` states without changing native anchor activation.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 4.1, 4.2, 4.6, 6.1, 6.2, 6.6_

  - [ ]* 1.3 Write property test for interaction target precedence
    - **Property 1: Interaction target precedence**
    - Generate optional focus, hover, and scroll ids and assert the exact resolver ordering.
    - **Validates: Requirements 1.2, 1.5, 1.6, 6.2**

  - [ ]* 1.4 Write property test for adjacent transfer ownership
    - **Property 2: Adjacent transfer preserves direct ownership**
    - Generate distinct source/destination ids and arbitrary scroll fallback ids; assert no null or scroll command appears during an in-group transfer.
    - **Validates: Requirements 1.3**

- [ ] 2. Normalize and reactively maintain indicator geometry
  - [-] 2.1 Add the links shell and relative geometry helper in `FloatingNavbar.tsx`
    - Render the indicator and link list in a shared positioned shell.
    - Add `IndicatorGeometry` and `toIndicatorGeometry` based on target and shell bounding rectangles.
    - Commit `{ id, x, width }` atomically in a layout effect before paint.
    - _Requirements: 2.1, 2.3, 2.4, 2.7_

  - [~] 2.2 Move scroll-active fallback and remeasurement ownership into `FloatingNavbar`
    - Preserve viewport-center section selection for Features, How it works, and FAQ.
    - Remeasure on target, compact state, ResizeObserver, viewport resize, and font readiness; hide geometry for missing or mobile-hidden targets.
    - _Requirements: 1.4, 1.5, 2.6, 5.3, 5.5, 8.4_

  - [ ]* 2.3 Write property test for normalized indicator geometry
    - **Property 3: Relative indicator geometry is exact**
    - Generate finite shell/target rectangles with positive widths and assert exact relative x and width results.
    - **Validates: Requirements 2.3, 2.4**

  - [ ]* 2.4 Write property test for rapid latest-target convergence
    - **Property 4: Rapid retargeting converges on the latest target**
    - Generate sequences of at least three ids and assert only the newest destination survives without an in-group fallback command.
    - **Validates: Requirements 2.5**

- [ ] 3. Make `ActiveIndicator` presentational and responsive
  - [~] 3.1 Refactor `ActiveIndicator.tsx` to consume resolved geometry
    - Remove section observation, active-id selection, item refs, secondary target ownership, and `layoutId` behavior.
    - Animate transform x and width with an interruptible 140 ms transition; use zero duration in reduced motion.
    - Keep one indicator DOM node and hide the node when geometry is null.
    - _Requirements: 1.5, 2.1, 2.2, 2.4, 2.5, 5.3, 7.1_

  - [ ]* 3.2 Add focused component tests for indicator timing and remeasurement
    - Verify movement starts by the next frame, settles by 180 ms, aligns within 1 px, retargets during interrupted transfers, and reacts to resize/compaction.
    - Verify pointer leave restores the current scroll target and reduced motion updates immediately.
    - _Requirements: 1.1, 1.4, 2.1, 2.2, 2.3, 2.5, 2.6, 7.1_

- [ ] 4. Gate and stabilize `MagneticLink`
  - [~] 4.1 Remove child hover ownership and add input-capability gating
    - Remove `onHoverChange`; let the Link_Group own hover state.
    - Attach pointer tracking only for hover-capable fine pointers outside reduced motion.
    - Cancel return animations during cleanup and direct retargeting while preserving the 60 px radius and 12 px displacement bound.
    - _Requirements: 2.7, 5.6, 7.2, 8.5_

  - [ ]* 4.2 Write property test for bounded and gated magnetic response
    - **Property 5: Magnetic response remains bounded and gated**
    - Generate signed finite cursor vectors and capability/motion flags; assert magnitude ≤12 px and exact zero when gated.
    - **Validates: Requirements 2.7, 5.6, 7.2, 8.5**

- [ ] 5. Implement the navbar-only premium visual system
  - [x] 5.1 Refine navbar tokens in `LandingPage.css`
    - Update `--nav-blur` to 22 px and add scoped surface, edge, inset, ambient-shadow, directional-shadow, indicator, and accent-glow tokens.
    - Reuse the existing teal, indigo, pink, text, and background color system.
    - _Requirements: 3.2, 3.3, 3.4, 6.4, 6.5_

  - [~] 5.2 Upgrade navbar styles in `landing-3d.css`
    - Build two translucent premium surface layers with a one-pixel edge, ambient/directional depth, and restrained accent glow.
    - Add the luminous indicator fill/edge/inset treatment plus high-emphasis active links and readable idle links.
    - Add the automatic opaque `@supports not` fallback without changing non-navbar landing selectors.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2_

  - [~] 5.3 Refine logo and CTA states
    - Add idle, hover, and focus-visible edge/glow states for the logo surface where focus semantics apply.
    - Add distinct CTA idle styling plus bounded elevation, highlight, and glow states; retain non-motion feedback under reduced motion.
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 7.3, 7.4_

  - [ ]* 5.4 Add visual-state and fallback tests
    - Assert premium layers, blur range, edge/shadow tokens, indicator treatment, active/idle emphasis, logo/CTA states, and opaque fallback declarations.
    - Use focused screenshots only if the existing Playwright configuration supports stable navbar snapshots.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [ ] 6. Preserve responsive, accessibility, routing, and compaction behavior
  - [~] 6.1 Complete responsive and reduced-motion navbar rules
    - Preserve the 720 px mobile behavior with logo and CTA visible, desktop links/indicator hidden, and no horizontal overflow.
    - Restore all controls immediately on desktop entry; suppress decorative pointer transforms on coarse/no-hover inputs.
    - Keep color, active, and focus feedback while removing transform/interpolation motion.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 7.1, 7.2, 7.3, 7.4_

  - [~] 6.2 Preserve semantic controls and callback wiring
    - Keep Features, How it works, FAQ, Blog, and Get Zule destinations/callbacks unchanged.
    - Preserve hero-boundary compaction and avoid edits to `LandingPage.tsx` or non-navbar landing architecture unless a type-only integration adjustment is unavoidable.
    - _Requirements: 6.3, 6.6, 8.1, 8.2, 8.3, 8.4, 8.6, 8.7_

  - [ ]* 6.3 Write property test for the preserved compaction boundary
    - **Property 6: Navbar compaction boundary remains stable**
    - Generate finite scroll and hero-bottom values and assert compact mode is equivalent to `scrollY >= heroBottom`.
    - **Validates: Requirements 8.4**

  - [ ]* 6.4 Add component regression and accessibility tests
    - Test exact anchor/blog/download callbacks, keyboard focus parity, native activation, active/idle cleanup, reduced-motion feedback, and responsive visibility.
    - Run axe checks and explicit contrast assertions for 4.5:1 text and 3:1 focus/state boundaries.
    - Add a LandingPage smoke assertion that the hierarchy outside the navbar remains unchanged.
    - _Requirements: 4.6, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.4, 8.1, 8.2, 8.3, 8.6, 8.8_

  - [ ]* 6.5 Add a focused Playwright navbar interaction test
    - Repeatedly transfer between FAQ and How it works, then sweep across three or more links; verify no stale fallback frame and final geometry within 1 px by 180 ms.
    - Verify group-leave scroll fallback, representative mobile widths, no horizontal overflow, keyboard traversal, coarse-pointer behavior where emulatable, and reduced motion.
    - _Requirements: 1.1, 1.3, 1.4, 2.1, 2.2, 2.3, 2.5, 5.1, 5.5, 6.1, 6.2, 7.1, 8.8_

- [~] 7. Checkpoint - validate the focused navbar change
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional automated tests and can be skipped for a faster implementation pass.
- Property tests must run at least 100 iterations and use the tag `Feature: landing-navbar-hover-polish, Property N: [property title]`.
- Implementation work is limited to navbar components, navbar-scoped tokens/styles, and focused tests; no other landing sections are redesigned.
- The plan intentionally preserves the existing `LandingPage` callback wiring and landing architecture.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "5.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "3.1", "4.1"] },
    { "id": 3, "tasks": ["3.2", "4.2", "5.2", "5.3"] },
    { "id": 4, "tasks": ["5.4", "6.1", "6.2", "6.3"] },
    { "id": 5, "tasks": ["6.4", "6.5"] },
    { "id": 6, "tasks": ["7"] }
  ]
}
```