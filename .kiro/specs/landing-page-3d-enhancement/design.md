# Design Document

## Overview

This feature layers a single react-three-fiber (R3F) hero canvas, a floating glassmorphic navbar, and a set of CSS 3D / parallax polish effects onto the existing `LandingPage`. The architecture is built around three constraints that come straight from the requirements:

1. **The 3D bundle is opt-in.** `three`, `@react-three/fiber`, and `@react-three/drei` are loaded via `React.lazy` so they never enter the initial route chunk (Req 2.6, 11.3).
2. **Motion is a runtime feature flag.** A `useReducedMotion` hook gates rotation, magnetic translation, tilt, and parallax. A `useDocumentVisibility` hook gates the R3F render loop. Both feed a single `motionState` object that every animated component reads (Req 2.1-2.3, 4.5-4.6, 5.3, 6.5).
3. **WebGL availability is detected before mount.** A synchronous probe runs before `LazyHero3DCanvas` is rendered; on failure the canvas is omitted and the existing static hero copy stands alone (Req 2.5, 9.2).

The existing tools ticker, How-It-Works, FAQ, and footer sections are not restructured. They keep their current DOM, animations, and copy. The polish work for those sections is limited to CSS perspective containers and a parallax wrapper around `AnimatedMockup`, applied via the same motion-gating mechanism (Req 6.3-6.5, 7.1-7.5).

## Architecture

```
LandingPage (orchestrator)
├── motion context: { reducedMotion, tabVisible, lowEndGpu, webglAvailable }
│
├── FloatingNavbar                          ← replaces .landing-header
│   ├── Logo3D                              ← CSS 3D, hover-driven
│   ├── MagneticLink × N                    ← framer-motion translate
│   ├── ActiveIndicator                     ← framer-motion layoutId
│   └── DownloadCTA                         ← unchanged wiring
│
├── HeroSection
│   ├── <Suspense fallback={null}>
│   │     └── LazyHero3DCanvas              ← React.lazy, R3F
│   │           └── HeroGeometry            ← icosahedron, MeshTransmissionMaterial
│   ├── Existing headline + subtitle + CTAs (unchanged DOM)
│   └── Existing bg-orb layer (kept; lives in front of canvas at lower z)
│
├── ToolsTickerSection                      ← unchanged
├── StatsSection
│   └── ParallaxLayer wrapping <AnimatedMockup>
├── HowItWorksSection                       ← unchanged
├── FeaturesSection
│   └── TiltCard × N wrapping each .bento-card
├── FAQSection                              ← unchanged
├── BottomCTASection                        ← wrapped in perspective container
└── Footer                                  ← unchanged
```

A single React context, `LandingMotionContext`, hangs off `LandingPage` and supplies the four motion flags to every animated descendant. Components never re-read `matchMedia` or `document.visibilityState` directly; they consume the context. This keeps reduced-motion behavior coherent across the page (if one component honors it, all do) and keeps test surfaces small.

### Render-time decision flow

```
LandingPage mount
  │
  ├─ probe WebGL  ─────────────┐
  ├─ read prefers-reduced-motion
  ├─ read hardwareConcurrency, devicePixelRatio
  └─ subscribe to visibilitychange
                                │
                                ▼
              build motionState (immutable per render)
                                │
                                ▼
        webglAvailable && !reducedMotion?
                ├── yes → mount <LazyHero3DCanvas/>
                └── no  → omit canvas; hero renders as today
```

The probe is synchronous, runs once at mount, and its result is memoized. The `reducedMotion` and `tabVisible` flags are reactive; their changes update the canvas via R3F's `useFrame` skip pattern rather than by unmounting the canvas, so the bundle is not torn down on transient state changes.

## Components and Interfaces

### `Hero3DCanvas` (lazy-loaded)

**File**: `src/components/landing/Hero3DCanvas.tsx`

The only file in the project that imports from `three`, `@react-three/fiber`, or `@react-three/drei` (Req 11.2). Exported as the default export so `React.lazy` can pull it as a separate chunk.

```ts
// Hero3DCanvas.tsx — only place three/r3f/drei is imported
import { Canvas, useFrame } from '@react-three/fiber';
import { MeshTransmissionMaterial, Float } from '@react-three/drei';
import { useRef } from 'react';
import type { Mesh } from 'three';
import { useLandingMotion } from './LandingMotionContext';

const ROTATION_RATE = 0.12; // radians/sec, within [0.05, 0.3] (Req 1.3)
const ACCENT_COLORS = {
  teal:   '#14b8a6',
  indigo: '#6366f1',
  pink:   '#f472b6',
};

function HeroGeometry() {
  const ref = useRef<Mesh>(null);
  const { reducedMotion, tabVisible } = useLandingMotion();

  useFrame((_state, delta) => {
    if (!ref.current) return;
    if (reducedMotion) return;          // Req 2.3
    if (!tabVisible)   return;          // Req 2.1
    ref.current.rotation.y += ROTATION_RATE * delta;
    ref.current.rotation.x += ROTATION_RATE * 0.4 * delta;
  });

  return (
    <Float speed={1} rotationIntensity={0} floatIntensity={0.6}>
      <mesh ref={ref}>
        <icosahedronGeometry args={[1.2, 1]} />
        <MeshTransmissionMaterial
          transmission={1}
          thickness={1.4}
          roughness={0.08}
          chromaticAberration={0.35}     // Req 1.4
          ior={1.35}
          backside
          color={ACCENT_COLORS.indigo}
        />
      </mesh>
    </Float>
  );
}

export default function Hero3DCanvas({ dprCap }: { dprCap: number }) {
  return (
    <Canvas
      className="hero-3d-canvas"
      dpr={[1, dprCap]}                  // Req 2.4
      camera={{ position: [0, 0, 4], fov: 35 }}
      gl={{ antialias: true, powerPreference: 'low-power', alpha: true }}
      frameloop="always"
    >
      <ambientLight intensity={0.4} />
      <directionalLight position={[3, 3, 3]} intensity={0.8} color={ACCENT_COLORS.pink} />
      <directionalLight position={[-3, -2, -1]} intensity={0.5} color={ACCENT_COLORS.teal} />
      <HeroGeometry />
    </Canvas>
  );
}
```

The `Canvas` is absolutely positioned within `.hero-section` at `z-index: 1`; the headline, subtitle, and CTA buttons sit at `z-index: 10` (matching the existing rule) so the geometry stays behind text (Req 1.5).

### `FloatingNavbar`

**File**: `src/components/landing/FloatingNavbar.tsx`

Replaces the existing `.landing-header` JSX in `LandingPage.tsx`. Owns the scroll-driven shrink and hosts the magnetic links, active indicator, and 3D logo.

```ts
type NavItem = { id: 'features' | 'how-it-works' | 'faq' | 'blog'; label: string };

const NAV_ITEMS: NavItem[] = [
  { id: 'features',     label: 'Features' },
  { id: 'how-it-works', label: 'How it works' },
  { id: 'faq',          label: 'FAQ' },
  { id: 'blog',         label: 'Blog' },
];

interface FloatingNavbarProps {
  onBlog: () => void;       // wraps actions.navigateTo('blog')   (Req 8.4)
  onDownload: () => void;   // wraps existing handleDownload      (Req 8.3)
  heroBottomRef: React.RefObject<HTMLElement>; // for scroll compaction
}
```

Shrinkage is driven by framer-motion's `useScroll` keyed to `heroBottomRef`. The animated style object is fed into a single `motion.nav` element whose `layout` prop animates between expanded (`padding: 12px 24px`) and compact (`padding: 6px 16px`) states. The transition spec is `{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }` — 300 ms, well inside [200, 400] (Req 3.5).

### `MagneticLink`

**File**: `src/components/landing/MagneticLink.tsx`

```ts
interface MagneticLinkProps {
  href: string;                       // anchor target (e.g. "#features")
  label: string;
  onClick?: (e: React.MouseEvent) => void;
  onHoverChange?: (hovered: boolean) => void; // for ActiveIndicator
}

const ACTIVATION_RADIUS = 60;         // px (Req 4.1)
const MAX_DISPLACEMENT  = 12;         // px (Req 4.1)
```

Implementation: a `motion.a` whose `x` and `y` MotionValues are driven by a `pointermove` listener on `window`. The listener computes the vector from the element's center to the cursor; if the magnitude is greater than `ACTIVATION_RADIUS`, both MotionValues are animated to `0`. Otherwise displacement is scaled linearly:

```ts
const t = Math.min(distance / ACTIVATION_RADIUS, 1);
const scale = (1 - t) * MAX_DISPLACEMENT / distance;
x.set(dx * scale);
y.set(dy * scale);
```

The leave transition uses `animate(x, 0, { duration: 0.25, ease: 'easeOut' })`, 250 ms (Req 4.2). When `reducedMotion` is true the listener is not attached at all, so MotionValues stay at `0` (Req 4.5).

### `ActiveIndicator`

**File**: `src/components/landing/ActiveIndicator.tsx`

Sits inside `FloatingNavbar` as a sibling of the links. Uses framer-motion's `layoutId="navActiveIndicator"` so the indicator pill animates between target links automatically.

The target is computed by:

1. The currently hovered link, if any (controlled via `onHoverChange` from each `MagneticLink`).
2. Otherwise, the link whose anchor section is currently intersecting the viewport center, derived from an `IntersectionObserver` keyed to `#features`, `#how-it-works`, `#faq`.

Under reduced motion, `layout` is replaced with manual `style` updates and no transition (Req 4.6).

### `Logo3D`

**File**: `src/components/landing/Logo3D.tsx`

Pure CSS 3D — no R3F. Wraps `<img src="./favicon.svg" />` in a `motion.div` with `transformStyle: 'preserve-3d'` and `perspective: 600px`. `pointermove` over the element maps cursor offset to `rotateX`/`rotateY` in `[-15°, +15°]` (Req 5.1). Leave transition is 250 ms (Req 5.2). Disabled entirely under reduced motion (Req 5.3).

### `TiltCard`

**File**: `src/components/landing/TiltCard.tsx`

Wraps each `.bento-card` without changing its content. Same pointer-driven rotation math as `Logo3D`, but capped at ±8° (Req 6.1) and uses the bento card's bounding rect for the cursor offset reference. Leave transition 250 ms (Req 6.2). The wrapping `.bento-grid` gets `perspective: 1200px` via CSS (Req 6.4).

```ts
interface TiltCardProps {
  children: React.ReactNode;
  className?: string;       // forwarded to the inner card so existing styles apply
  maxTiltDeg?: number;      // defaults to 8
}
```

### `ParallaxLayer`

**File**: `src/components/landing/ParallaxLayer.tsx`

Generic wrapper that translates its child on the Y axis as a function of scroll position. Uses framer-motion's `useScroll({ target, offset: ['start end', 'end start'] })` and `useTransform` to map progress `[0, 1] → [-MAX, +MAX]` px. Used only on `AnimatedMockup` in the stats section with `MAX = 20` so the total swing is 40 px (Req 6.3). Disabled (returns plain `<div>`) under reduced motion (Req 6.5).

## Lazy-loading Strategy

`Hero3DCanvas` is imported via `React.lazy` and rendered inside `<Suspense fallback={null}>`. The decision to mount it is gated by `webglAvailable`:

```ts
// LandingPage.tsx
import { lazy, Suspense } from 'react';
const Hero3DCanvas = lazy(() => import('./landing/Hero3DCanvas'));

// inside render
{webglAvailable && (
  <Suspense fallback={null}>
    <Hero3DCanvas dprCap={lowEndGpu ? 1 : Math.min(window.devicePixelRatio, 2)} />
  </Suspense>
)}
```

Because `Hero3DCanvas.tsx` is the only file in the project that statically imports `three`/`@react-three/fiber`/`@react-three/drei`, Vite/Rollup will place its entire transitive closure into a separate async chunk. The existing `manualChunks` function in `vite.config.ts` is extended to add an explicit `vendor-three` chunk so the lazy load is observable and stable across builds:

```ts
// vite.config.ts (added inside manualChunks)
if (id.includes('node_modules/three') ||
    id.includes('node_modules/@react-three/fiber') ||
    id.includes('node_modules/@react-three/drei')) {
  return 'vendor-three';
}
```

This satisfies Req 2.6 and Req 11.3: the initial landing route chunk no longer contains `three`, and the `vendor-three` chunk is only requested when `Hero3DCanvas` is imported.

## WebGL Detection and Fallback

```ts
// src/components/landing/detectWebGL.ts
export function detectWebGL(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl');
    if (!gl) return false;

    // Detect software renderers — flag them as low-end (handled separately)
    return true;
  } catch {
    return false;
  }
}
```

Called once inside a `useMemo` in `LandingPage`. When the result is `false`:

- `Hero3DCanvas` is never imported (no lazy chunk fetched, Req 2.5 + 9.2).
- The existing `.bg-orb` decorative layer continues to render — the hero copy is the same as before this feature shipped.
- No error is thrown; the hero section just renders the existing DOM.

An additional safety net: `Hero3DCanvas` is wrapped in the existing `ErrorBoundary` (already present in the project at `src/components/ErrorBoundary.tsx`) so a runtime WebGL context loss is caught and replaced with `null` rather than tearing down the whole page.

## Motion Hooks

### `useReducedMotion`

```ts
// src/hooks/useReducedMotion.ts
import { useEffect, useState } from 'react';

export function useReducedMotion(): boolean {
  const get = () =>
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const [reduced, setReduced] = useState<boolean>(get);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = () => setReduced(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return reduced;
}
```

framer-motion's existing `<MotionConfig reducedMotion="user">` covers most `motion.*` components automatically. The hook exists for non-framer-motion code paths (the R3F `useFrame`, the magnetic pointer math, the parallax `useTransform`) that need an explicit boolean.

### `useDocumentVisibility`

```ts
// src/hooks/useDocumentVisibility.ts
import { useEffect, useState } from 'react';

export function useDocumentVisibility(): boolean {
  const [visible, setVisible] = useState<boolean>(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'
  );
  useEffect(() => {
    const handler = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);
  return visible;
}
```

The R3F `useFrame` callback short-circuits on `!tabVisible`, which pauses geometry updates. The `Canvas`'s default `frameloop="always"` still ticks at low frequency under the hood, but no scene work happens. If the canvas were unmounted instead, returning to the tab would force a re-compile of the GLSL shaders, so we keep it mounted and just skip work.

## Low-End GPU Detection

```ts
// src/components/landing/detectLowEndGpu.ts
export function detectLowEndGpu(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const dpr  = window.devicePixelRatio ?? 1;
  const conc = navigator.hardwareConcurrency ?? 8;
  const ratioHint = dpr > 1 && conc <= 4;        // Req: Low_End_GPU glossary

  // Software-rendered WebGL contexts present as SwiftShader / llvmpipe.
  let software = false;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? gl?.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
    software = typeof renderer === 'string' && /SwiftShader|llvmpipe|software/i.test(renderer);
  } catch {
    /* no-op */
  }

  return ratioHint || software;
}
```

Result feeds the `dprCap` prop on `Hero3DCanvas`. When `lowEndGpu === true`, `dprCap = 1` (Req 2.4); otherwise `dprCap = min(window.devicePixelRatio, 2)`. The probe is run once at mount and memoized — `navigator.hardwareConcurrency` and `devicePixelRatio` don't change at runtime.

## CSS Architecture

### Where new tokens live

All shared tokens added by this feature go into `src/components/LandingPage.css` so the existing `.landing-container` cascade picks them up. No new global stylesheet is introduced. Per-component flourishes (the magnetic link transform, the 3D logo perspective, the canvas absolute positioning) live in a co-located stylesheet at `src/components/landing/landing-3d.css`, imported from `LandingPage.tsx` alongside the existing `LandingPage.css`.

New tokens (Req 10.4):

```css
/* in LandingPage.css, inside .landing-container */
--accent-teal:   #14b8a6;
--accent-indigo: #6366f1;
--accent-pink:   #f472b6;
--nav-bg:        rgba(20, 20, 32, 0.55);
--nav-border:    rgba(255, 255, 255, 0.10);
--nav-blur:      14px;
--perspective-card: 1200px;
--perspective-cta:  900px;
--shadow-float: 0 12px 40px -16px rgba(0, 0, 0, 0.6),
                0 0  60px -20px rgba(99, 102, 241, 0.25);
```

### Perspective containers

```css
/* landing-3d.css */
.bento-grid          { perspective: var(--perspective-card); }
.bottom-cta-section  { perspective: var(--perspective-cta);  }
.tilt-card           { transform-style: preserve-3d; will-change: transform; }
.logo-3d             { perspective: 600px; transform-style: preserve-3d; }
```

The `perspective` values 1200 px and 900 px both sit inside the [800, 1600] band (Req 6.4).

### Floating navbar

```css
.floating-navbar {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);                /* Req 3.1 */
  background: var(--nav-bg);                  /* Req 3.2, 10.2 */
  border: 1px solid var(--nav-border);
  backdrop-filter: blur(var(--nav-blur));
  -webkit-backdrop-filter: blur(var(--nav-blur));
  border-radius: 999px;
  box-shadow: var(--shadow-float);
  z-index: 200;
}
```

### Reduced motion fallbacks

`landing-3d.css` includes a `@media (prefers-reduced-motion: reduce)` block that zeroes out the `transform` on `.tilt-card`, `.logo-3d`, `.magnetic-link`, and the parallax wrapper. Belt and suspenders alongside the JS gating, so a hover that lands during a media-query transition can't briefly tilt the card.

### Canvas positioning

```css
.hero-3d-canvas {
  position: absolute;
  inset: 0;
  z-index: 1;                                 /* below headline (z=10) */
  pointer-events: none;                       /* keep clicks on copy */
}
```

## Files Modified and Added

### Modified

- `src/components/LandingPage.tsx`
  - Replaces the inline `<header>...<nav>...` block with `<FloatingNavbar />`.
  - Wraps each `.bento-card` in `<TiltCard>`.
  - Wraps `<AnimatedMockup />` in `<ParallaxLayer>`.
  - Adds `<LandingMotionProvider>` at the top of the return tree.
  - Adds `<Suspense><LazyHero3DCanvas /></Suspense>` inside `.hero-section` when `webglAvailable`.
  - Existing scroll anchors (`#features`, `#how-it-works`, `#faq`), `handleDownload`, `handleGetStarted`, and `actions.navigateTo('blog')` are untouched and reused via props (Req 8.1-8.6).

- `src/components/LandingPage.css`
  - Adds the new CSS custom properties listed above.
  - Adds a `.landing-header-wrapper { display: none; }` rule so the existing header stops rendering once `FloatingNavbar` is wired (kept around briefly during diff review, then removed).

- `vite.config.ts`
  - Adds the `vendor-three` rule to `manualChunks`.

- `package.json`
  - Adds `three`, `@react-three/fiber`, `@react-three/drei` to `dependencies` (Req 11.1).

### Added

- `src/components/landing/Hero3DCanvas.tsx` — the only R3F surface.
- `src/components/landing/FloatingNavbar.tsx`
- `src/components/landing/MagneticLink.tsx`
- `src/components/landing/ActiveIndicator.tsx`
- `src/components/landing/Logo3D.tsx`
- `src/components/landing/TiltCard.tsx`
- `src/components/landing/ParallaxLayer.tsx`
- `src/components/landing/LandingMotionContext.tsx` — provider + `useLandingMotion` hook.
- `src/components/landing/detectWebGL.ts`
- `src/components/landing/detectLowEndGpu.ts`
- `src/components/landing/landing-3d.css`
- `src/hooks/useReducedMotion.ts`
- `src/hooks/useDocumentVisibility.ts`

### Untouched (intentionally)

- `src/components/FAQSection.tsx`
- `src/components/AnimatedMockup.tsx` — wrapped externally, never modified.
- The tools ticker JSX, the How-It-Works JSX, and the footer JSX inside `LandingPage.tsx`. Only their wrapping context (`LandingMotionProvider`) changes (Req 7.1-7.5).

## Integration Points with framer-motion

- `MotionConfig reducedMotion="user"` at `App.tsx` already covers every `motion.*` element on the landing page. `FloatingNavbar`, `MagneticLink`, `ActiveIndicator`, `TiltCard`, `ParallaxLayer` are all framer-motion-based and inherit that config — they automatically degrade to `transition: { duration: 0 }` under reduced motion. The explicit JS gating is for the non-framer paths (pointermove listeners, R3F `useFrame`).
- `ActiveIndicator` uses `layoutId="navActiveIndicator"` so framer-motion handles the slide animation (Req 4.3). Duration is set to 300 ms in `transition` to land in [200, 400].
- `FloatingNavbar` uses `useScroll({ target: heroSectionRef, offset: ['end end', 'end start'] })` and `useTransform` to drive a `compact` boolean. The boolean is animated via a `layout` transition with `duration: 0.3`.
- `ParallaxLayer` uses `useScroll` + `useTransform` directly.
- Magnetic translation uses imperative `useMotionValue` + `animate()` rather than `useTransform`, because the cursor source is not a scroll value.

## Data Models

```ts
// LandingMotionContext.tsx
export interface LandingMotionState {
  reducedMotion:   boolean;     // tracks prefers-reduced-motion
  tabVisible:      boolean;     // tracks document.visibilityState
  lowEndGpu:       boolean;     // memoized detection
  webglAvailable:  boolean;     // memoized detection
  dprCap:          number;      // 1 when lowEndGpu, else min(devicePixelRatio, 2)
}

export const LandingMotionContext = createContext<LandingMotionState | null>(null);
export const useLandingMotion = (): LandingMotionState => {
  const v = useContext(LandingMotionContext);
  if (!v) throw new Error('useLandingMotion must be used inside <LandingMotionProvider>');
  return v;
};
```

No persisted state, no IPC, no backend. Every field is derived from browser APIs at mount time, with `reducedMotion` and `tabVisible` reactive via `matchMedia`/`visibilitychange` listeners.

## Error Handling

| Failure mode                              | Detection                           | Behavior                                                                           | Requirement |
| ----------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- | ----------- |
| WebGL context creation fails              | `detectWebGL()` returns `false`     | Skip `<Hero3DCanvas>` mount entirely; hero renders existing copy + bg orbs         | 2.5, 9.2    |
| WebGL context lost after mount            | R3F propagates error                | Caught by `<ErrorBoundary>` wrapping the lazy import; renders `null` for canvas    | 2.5         |
| R3F bundle fails to load (network)        | `React.lazy` rejection              | Same `<ErrorBoundary>` falls back to `null`                                        | 2.5         |
| `matchMedia` not available (SSR / Node)   | Hook initializer guards `window`    | Defaults: `reducedMotion=false`, `tabVisible=true`                                 | 2.3         |
| `navigator.hardwareConcurrency` missing   | Default `8` in detection            | Treated as high-end                                                                | 2.4         |
| Electron renderer w/o WebGL               | Same path as 2.5                    | Same fallback                                                                      | 9.2         |
| Absolute web-only URLs                    | Code review + e2e under Electron    | All asset references use `./favicon.svg` style relative URLs (already convention)  | 9.3         |

## Testing Strategy

**Unit / component tests** (Vitest + Testing Library)

- `detectWebGL`: returns `false` when `canvas.getContext` returns `null`; returns `true` otherwise.
- `detectLowEndGpu`: every combination of `devicePixelRatio` and `hardwareConcurrency` maps to the documented boolean.
- `useReducedMotion`, `useDocumentVisibility`: respond to events; clean up listeners.
- `FloatingNavbar`: renders all five anchor targets; primary CTA dispatches the same `handleDownload` call as the existing nav (smoke).
- `MagneticLink`: with reduced motion forced, no pointer listener is attached (asserted via spy on `addEventListener`).
- `LandingPage`: when `detectWebGL` returns `false`, the `Hero3DCanvas` module is never imported (asserted via `vi.mock` spy on the lazy factory).

**Property-based tests** (fast-check, already a devDependency)

The properties defined below are translated to fast-check tests under `src/components/landing/__tests__/`. Generators cover scroll positions, cursor positions, frame deltas, and motion-state combinations. Minimum 100 iterations per property.

**Integration tests** (Playwright)

- Landing page boots under both `vite preview` and Electron preview without runtime errors (Req 9.1).
- The five anchor links scroll to their targets (Req 8.5).
- CTA buttons open the GitHub release URL in a new tab (Req 8.1, 8.3, 8.6).

**Build-time checks**

- Inspect `dist/assets/` after `vite build` and confirm a `vendor-three*.js` chunk exists and the entry chunk does not contain `three` (Req 2.6, 11.3).


## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Configuration, single-render structural assertions, and DOM-presence checks are intentionally captured as example-based unit and integration tests (described in **Testing Strategy** above) rather than as properties. The properties below cover the requirements whose behavior varies meaningfully with input and where universal quantification adds coverage value.

### Property 1: Per-frame rotation gating

*For any* frame delta `dt > 0` and any motion state `{ reducedMotion, tabVisible }`, the per-frame rotation increment applied by `HeroGeometry` is exactly zero whenever `reducedMotion` is true or `tabVisible` is false, and otherwise lies in `[0.05 * dt, 0.3 * dt]` on the rotated axis.

**Validates: Requirements 1.3, 2.1, 2.2, 2.3**

### Property 2: Magnetic link translation is bounded and gated

*For any* cursor offset vector `(dx, dy)` and any `reducedMotion` flag, the magnetic translation `(tx, ty)` returned by the magnetic offset function satisfies: `(tx, ty) = (0, 0)` whenever `reducedMotion` is true or `sqrt(dx^2 + dy^2) > 60`, and `sqrt(tx^2 + ty^2) ≤ 12` in all cases.

**Validates: Requirements 4.1, 4.5**

### Property 3: Logo 3D rotation is bounded and gated

*For any* cursor offset within the logo's bounding rect and any `reducedMotion` flag, the computed `(rotX, rotY)` returned by the logo rotation function satisfies: `(rotX, rotY) = (0, 0)` whenever `reducedMotion` is true, and `|rotX| ≤ 15` and `|rotY| ≤ 15` (degrees) in all cases.

**Validates: Requirements 5.1, 5.3**

### Property 4: Bento card tilt is bounded and gated

*For any* cursor offset within a bento card's bounding rect and any `reducedMotion` flag, the computed `(rotX, rotY)` returned by the tilt function satisfies: `(rotX, rotY) = (0, 0)` whenever `reducedMotion` is true, and `|rotX| ≤ 8` and `|rotY| ≤ 8` (degrees) in all cases.

**Validates: Requirements 6.1, 6.5**

### Property 5: Parallax displacement is bounded and gated

*For any* scroll progress `p` and any `reducedMotion` flag, the computed parallax `translateY` returned by `ParallaxLayer` satisfies: `translateY = 0` whenever `reducedMotion` is true, and `|translateY| ≤ 40` (pixels) in all cases.

**Validates: Requirements 6.3, 6.5**

### Property 6: Navbar compaction matches scroll position

*For any* scroll position `scrollY` and any `heroBottom` offset, the navbar's `compact` flag equals `(scrollY ≥ heroBottom)`.

**Validates: Requirements 3.3, 3.4**

### Property 7: Active indicator targets the intersecting section

*For any* list of section bounding boxes and any viewport center `y`, the active indicator's target id equals the id of the section whose vertical bounds contain `y`, or `null` when no section contains `y` and no link is hovered.

**Validates: Requirements 4.4**

### Property 8: DPR cap under low-end GPU detection

*For any* tuple `(devicePixelRatio, hardwareConcurrency, softwareRenderer)` for which `detectLowEndGpu` returns `true`, the `dprCap` value passed to `Hero3DCanvas` satisfies `dprCap ≤ 1`.

**Validates: Requirements 2.4**

### Property 9: WebGL unavailability never throws

*For any* boolean `webglAvailable` value, rendering `LandingPage` completes without throwing, and a `canvas` element is present in the hero section if and only if `webglAvailable` is `true`.

**Validates: Requirements 2.5, 9.2**
