# Implementation Plan: Landing Page 3D Enhancement

## Overview

Convert the design into incremental, testable code changes. Start with isolated foundations (dependencies, motion hooks, environment detection, CSS tokens), then build the leaf components (Hero3DCanvas, MagneticLink, Logo3D, ActiveIndicator, TiltCard, ParallaxLayer) against the shared motion context, then assemble them inside FloatingNavbar, and finally wire everything into `LandingPage.tsx` without disturbing the existing tools ticker, How-It-Works, FAQ, and footer sections. Property-based tests sit next to the helpers that compute bounded values (rotations, displacements, compaction flag) so violations are caught at the math layer before they reach the DOM.

## Tasks

- [x] 1. Set up dependencies and bundler configuration
  - [x] 1.1 Add three/@react-three/fiber/@react-three/drei to `package.json` dependencies
    - Pin to current stable versions and run install so the lockfile updates
    - Confirm the packages resolve in the Vite + Electron build pipelines
    - _Requirements: 11.1_

  - [x] 1.2 Add a `vendor-three` manual chunk in `vite.config.ts`
    - Extend the existing `manualChunks` function to route `three`, `@react-three/fiber`, and `@react-three/drei` (and their transitive deps) into a `vendor-three` chunk
    - Verify the chunk only loads when `Hero3DCanvas` is imported by inspecting `dist/assets/` after `vite build`
    - _Requirements: 2.6, 11.3_

- [x] 2. Implement motion hooks under `src/hooks/`
  - [x] 2.1 Implement `useReducedMotion`
    - Read `prefers-reduced-motion: reduce` via `matchMedia`, default `false` when `window` is unavailable
    - Subscribe to `change` and clean up on unmount
    - _Requirements: 2.3, 4.5, 4.6, 5.3, 6.5_

  - [ ]* 2.2 Unit test `useReducedMotion`
    - Mock `matchMedia` to assert initial value, change propagation, and listener cleanup
    - _Requirements: 2.3_

  - [x] 2.3 Implement `useDocumentVisibility`
    - Read `document.visibilityState`, default `true` outside browser
    - Subscribe to `visibilitychange` and clean up on unmount
    - _Requirements: 2.1, 2.2_

  - [ ]* 2.4 Unit test `useDocumentVisibility`
    - Spy on `document.addEventListener`/`removeEventListener`, simulate visibility transitions
    - _Requirements: 2.1, 2.2_

- [x] 3. Implement runtime environment detection under `src/components/landing/`
  - [x] 3.1 Implement `detectWebGL` in `src/components/landing/detectWebGL.ts`
    - Try `webgl2`, `webgl`, then `experimental-webgl`; swallow exceptions and return `false`
    - Return `false` when `window` is undefined
    - _Requirements: 2.5, 9.2_

  - [ ]* 3.2 Unit test `detectWebGL`
    - Stub `HTMLCanvasElement.prototype.getContext` to cover success, `null` return, and thrown exception
    - _Requirements: 2.5, 9.2_

  - [x] 3.3 Implement `detectLowEndGpu` in `src/components/landing/detectLowEndGpu.ts`
    - Combine `devicePixelRatio > 1 && hardwareConcurrency <= 4` with a software-renderer string match (`SwiftShader|llvmpipe|software`) via `WEBGL_debug_renderer_info`
    - Export a `computeDprCap(lowEndGpu, dpr)` helper that returns `1` when `lowEndGpu` is true, otherwise `min(dpr, 2)`
    - _Requirements: 2.4_

  - [ ]* 3.4 Property test `computeDprCap` low-end GPU bound
    - **Property 8: DPR cap under low-end GPU detection**
    - **Validates: Requirements 2.4**
    - fast-check generator: arbitrary positive `devicePixelRatio` and `hardwareConcurrency`; assert that whenever `detectLowEndGpu` returns `true`, `computeDprCap(...) <= 1`

- [x] 4. Implement the shared landing motion context
  - [x] 4.1 Create `src/components/landing/LandingMotionContext.tsx`
    - Export `LandingMotionState`, `LandingMotionContext`, `LandingMotionProvider`, and `useLandingMotion`
    - Provider memoizes `webglAvailable`, `lowEndGpu`, and `dprCap`; subscribes hooks for `reducedMotion` and `tabVisible`
    - Throw in `useLandingMotion` when called outside the provider
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 5. Add CSS tokens and the landing-3d stylesheet
  - [x] 5.1 Add new tokens to `src/components/LandingPage.css`
    - Add `--accent-teal`, `--accent-indigo`, `--accent-pink`, `--nav-bg`, `--nav-border`, `--nav-blur`, `--perspective-card`, `--perspective-cta`, `--shadow-float` inside `.landing-container`
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 5.2 Create `src/components/landing/landing-3d.css`
    - Define `.hero-3d-canvas` absolute positioning + `z-index: 1` + `pointer-events: none`
    - Define `.floating-navbar` (fixed, centered via translateX, backdrop blur via `var(--nav-blur)`, pill radius, `z-index: 200`)
    - Define `.bento-grid` and `.bottom-cta-section` perspective using `var(--perspective-card)` and `var(--perspective-cta)`
    - Define `.tilt-card`, `.logo-3d`, `.magnetic-link` `transform-style` and `will-change`
    - Add a `@media (prefers-reduced-motion: reduce)` block that zeroes transforms on the four animated classes
    - _Requirements: 3.1, 3.2, 6.4, 10.2, 10.4_

- [x] 6. Implement the Hero 3D canvas
  - [x] 6.1 Implement `src/components/landing/Hero3DCanvas.tsx`
    - Default export so `React.lazy` can pull a separate chunk; only file that imports `three`/`@react-three/fiber`/`@react-three/drei`
    - Inner `HeroGeometry` uses `icosahedronGeometry`, `MeshTransmissionMaterial` (transmission, thickness, chromaticAberration, ior, backside), accent-colored directional lights for rim
    - Export a pure helper `computeRotationDelta(dt, { reducedMotion, tabVisible })` that returns `0` when gated and a value in `[0.05*dt, 0.3*dt]` otherwise; `useFrame` calls this helper
    - `Canvas` props: `dpr={[1, dprCap]}`, `gl={{ powerPreference: 'low-power', alpha: true, antialias: true }}`, camera `{ position: [0, 0, 4], fov: 35 }`
    - Use relative asset references only (no absolute web URLs)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 9.3, 10.1, 11.2_

  - [ ]* 6.2 Property test `computeRotationDelta` gating and bounds
    - **Property 1: Per-frame rotation gating**
    - **Validates: Requirements 1.3, 2.1, 2.2, 2.3**
    - fast-check generators: `dt ∈ (0, 1]`, arbitrary booleans for `reducedMotion`, `tabVisible`; assert `=== 0` when either gate active, else value `∈ [0.05*dt, 0.3*dt]`

- [x] 7. Implement the magnetic link
  - [x] 7.1 Implement `src/components/landing/MagneticLink.tsx`
    - Export pure helper `computeMagneticOffset({ dx, dy, reducedMotion })` returning `{ x, y }`; returns `(0, 0)` when `reducedMotion` is true or `sqrt(dx²+dy²) > 60`, else scales toward cursor with magnitude capped at 12
    - Component attaches a `window` `pointermove` listener only when `reducedMotion` is false; animates `motion.a` `x`/`y` MotionValues; leave transition `{ duration: 0.25, ease: 'easeOut' }`
    - Expose `onHoverChange` for the ActiveIndicator
    - _Requirements: 4.1, 4.2, 4.5_

  - [ ]* 7.2 Property test `computeMagneticOffset` bounds and gating
    - **Property 2: Magnetic link translation is bounded and gated**
    - **Validates: Requirements 4.1, 4.5**
    - fast-check generators: arbitrary `dx`, `dy` floats and arbitrary `reducedMotion`; assert `(0,0)` when gated or radius > 60, and magnitude ≤ 12 always

- [x] 8. Implement the 3D logo
  - [x] 8.1 Implement `src/components/landing/Logo3D.tsx`
    - Export pure helper `computeLogoRotation({ offsetX, offsetY, width, height, reducedMotion })` returning `{ rotX, rotY }` in degrees, clamped to `[-15, 15]`, zeroed under reduced motion
    - Component wraps `<img src="./favicon.svg" />` in `motion.div` with `transformStyle: 'preserve-3d'`, applies pointer-driven `rotateX`/`rotateY`, leave transition `{ duration: 0.25 }`
    - _Requirements: 5.1, 5.2, 5.3, 9.3_

  - [ ]* 8.2 Property test `computeLogoRotation` bounds and gating
    - **Property 3: Logo 3D rotation is bounded and gated**
    - **Validates: Requirements 5.1, 5.3**
    - fast-check generators: arbitrary `offsetX/offsetY/width/height` and `reducedMotion` boolean; assert `(0,0)` when gated, else `|rotX| ≤ 15 && |rotY| ≤ 15`

- [x] 9. Implement the active indicator
  - [x] 9.1 Implement `src/components/landing/ActiveIndicator.tsx`
    - Export pure helper `selectActiveTarget({ hoveredId, sections, viewportCenterY })` returning the section id whose vertical bounds contain `viewportCenterY`, or the `hoveredId` when set, or `null`
    - Component uses framer-motion `layoutId="navActiveIndicator"` with `transition: { duration: 0.3 }`; under reduced motion, falls back to plain style updates with no transition
    - Subscribes to an `IntersectionObserver` keyed to `#features`, `#how-it-works`, `#faq`
    - _Requirements: 4.3, 4.4, 4.6_

  - [ ]* 9.2 Property test `selectActiveTarget`
    - **Property 7: Active indicator targets the intersecting section**
    - **Validates: Requirements 4.4**
    - fast-check generators: arbitrary non-overlapping section bounds, arbitrary `viewportCenterY`, optional `hoveredId`; assert returned id matches the containing section, or `hoveredId` when present, or `null` when none contains

- [x] 10. Implement the floating navbar
  - [x] 10.1 Implement `src/components/landing/FloatingNavbar.tsx`
    - Export pure helper `isCompact(scrollY, heroBottom)` returning `scrollY >= heroBottom`
    - Render five entries (Features, How it works, FAQ, Blog, Get Zule); compose `Logo3D`, `MagneticLink` per nav item, `ActiveIndicator`
    - Use `useScroll({ target: heroBottomRef, offset: ['end end', 'end start'] })` with `useTransform` to drive `compact`; transition `{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }`
    - Wire props: `onBlog`, `onDownload`, `onAnchor(id)`, `heroBottomRef`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 8.3, 8.4, 8.5, 10.2_

  - [ ]* 10.2 Property test `isCompact`
    - **Property 6: Navbar compaction matches scroll position**
    - **Validates: Requirements 3.3, 3.4**
    - fast-check generators: arbitrary `scrollY` and `heroBottom`; assert returned boolean equals `scrollY >= heroBottom`

  - [ ]* 10.3 Unit test `FloatingNavbar` wiring
    - Render with mocked handlers; click "Get Zule" → asserts `onDownload`; click "Blog" → asserts `onBlog`; click "Features"/"How it works"/"FAQ" → asserts `onAnchor` with the correct id
    - Assert all five entries from Req 3.6 are present
    - _Requirements: 3.6, 8.3, 8.4, 8.5_

- [x] 11. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Implement polish components
  - [x] 12.1 Implement `src/components/landing/TiltCard.tsx`
    - Export pure helper `computeTiltRotation({ offsetX, offsetY, width, height, maxTiltDeg = 8, reducedMotion })` returning `{ rotX, rotY }` clamped to `[-maxTiltDeg, +maxTiltDeg]` and zeroed under reduced motion
    - Component wraps children, attaches pointer listener; leave transition `{ duration: 0.25 }`; forwards `className` so existing `.bento-card` styles still apply
    - _Requirements: 6.1, 6.2, 6.5, 10.3_

  - [ ]* 12.2 Property test `computeTiltRotation` bounds and gating
    - **Property 4: Bento card tilt is bounded and gated**
    - **Validates: Requirements 6.1, 6.5**
    - fast-check generators: arbitrary cursor offsets and `reducedMotion`; assert `(0,0)` when gated, else `|rotX| ≤ 8 && |rotY| ≤ 8`

  - [x] 12.3 Implement `src/components/landing/ParallaxLayer.tsx`
    - Export pure helper `computeParallaxOffset(progress, { max = 20, reducedMotion })` returning `0` under reduced motion, else `(progress * 2 - 1) * max` so the swing covers up to 40 px
    - Component uses `useScroll({ target, offset: ['start end', 'end start'] })` and `useTransform`; returns plain `<div>` when reduced motion is active
    - _Requirements: 6.3, 6.5, 10.3_

  - [ ]* 12.4 Property test `computeParallaxOffset` bounds and gating
    - **Property 5: Parallax displacement is bounded and gated**
    - **Validates: Requirements 6.3, 6.5**
    - fast-check generators: arbitrary scroll progress and `reducedMotion`; assert `0` when gated, else `|translateY| ≤ 40`

- [x] 13. Integrate into `LandingPage.tsx`
  - [x] 13.1 Add `LandingMotionProvider` and lazy Hero3DCanvas
    - Wrap the return tree in `<LandingMotionProvider>`
    - Import `Hero3DCanvas` via `React.lazy`; render inside `<Suspense fallback={null}>` and the existing `ErrorBoundary`, gated by `webglAvailable`
    - Pass `dprCap` derived from `computeDprCap(lowEndGpu, devicePixelRatio)`
    - Import `landing-3d.css` alongside existing `LandingPage.css`
    - _Requirements: 1.1, 1.5, 1.6, 2.4, 2.5, 2.6, 9.1, 9.2, 11.3_

  - [x] 13.2 Replace the inline `<header>...<nav>...</nav></header>` with `<FloatingNavbar />`
    - Wire `onDownload` to the existing `handleDownload`, `onBlog` to `actions.navigateTo('blog')`, `onAnchor` to the existing smooth-scroll handlers for `#features`, `#how-it-works`, `#faq`
    - Pass a `heroBottomRef` attached to the existing hero section element
    - Preserve the existing tools ticker, How-It-Works, FAQ, and footer DOM unchanged
    - _Requirements: 3.6, 7.1, 7.2, 7.3, 7.4, 7.5, 8.2, 8.3, 8.4, 8.5_

  - [x] 13.3 Wrap polish surfaces inside `LandingPage.tsx`
    - Wrap each `.bento-card` in `<TiltCard>` without modifying card content
    - Wrap `<AnimatedMockup />` in `<ParallaxLayer maxPx={20}>` inside the stats section
    - Apply `.bento-grid` and `.bottom-cta-section` class hooks so the perspective rules in `landing-3d.css` apply
    - Keep existing download/CTA wiring for the bottom CTA download button
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.6, 10.3_

  - [ ]* 13.4 Property test: `LandingPage` rendering under both webgl states never throws
    - **Property 9: WebGL unavailability never throws**
    - **Validates: Requirements 2.5, 9.2**
    - fast-check generator: arbitrary `webglAvailable` boolean; mock `detectWebGL` to return that value; render `LandingPage` and assert no throw and that a `<canvas>` element is present in the hero section iff `webglAvailable` is `true`

  - [ ]* 13.5 Smoke test CTA and anchor wiring
    - Mount `LandingPage` with mocked handlers; assert hero download button, "See how it works", `FloatingNavbar` "Get Zule", `FloatingNavbar` "Blog", and bottom CTA download button each invoke the expected actions
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

- [x] 14. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional tests that can be skipped for a faster MVP but are recommended for production.
- Property-based tests are placed next to the pure helpers (`computeRotationDelta`, `computeMagneticOffset`, `computeLogoRotation`, `computeTiltRotation`, `computeParallaxOffset`, `isCompact`, `selectActiveTarget`, `computeDprCap`) so the bounded-and-gated invariants from the design are verified at the math layer.
- The only file that statically imports `three`, `@react-three/fiber`, or `@react-three/drei` is `Hero3DCanvas.tsx`; combined with the `vendor-three` manualChunk this guarantees the 3D bundle stays out of the initial chunk.
- Existing sections (tools ticker, How-It-Works, FAQ, footer) are intentionally left unchanged in DOM and behavior; the polish work touches only their wrapping context.
- All routing and CTA wiring (download URL, `actions.navigateTo`, anchor scroll) is reused as-is and passed into `FloatingNavbar` via props.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1", "2.3", "3.1", "3.3", "5.1", "5.2"] },
    { "id": 1, "tasks": ["2.2", "2.4", "3.2", "3.4", "4.1"] },
    { "id": 2, "tasks": ["6.1", "7.1", "8.1", "9.1", "12.1", "12.3"] },
    { "id": 3, "tasks": ["6.2", "7.2", "8.2", "9.2", "10.1", "12.2", "12.4"] },
    { "id": 4, "tasks": ["10.2", "10.3", "13.1"] },
    { "id": 5, "tasks": ["13.2"] },
    { "id": 6, "tasks": ["13.3"] },
    { "id": 7, "tasks": ["13.4", "13.5"] }
  ]
}
```
