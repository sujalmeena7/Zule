// ============================================
// Zule AI — Hero 3D Canvas
// ============================================
//
// The single react-three-fiber surface on the landing page. This file is
// the *only* module in the project that statically imports `three`,
// `@react-three/fiber`, or `@react-three/drei` (Req 11.2); combined with
// the `vendor-three` manualChunk in `vite.config.ts` and the
// `React.lazy` import site in `LandingPage.tsx`, that guarantees the 3D
// dependencies never enter the initial landing route chunk (Req 2.6,
// Req 11.3).
//
// The exported default is the `Canvas` host. A pure helper
// `computeRotationDelta` (named export) drives the per-frame rotation
// increment so the rotation-rate invariant (Req 1.3) and the
// reduced-motion / tab-visibility gating (Req 2.1, 2.2, 2.3) can be
// verified by property tests at the math layer without booting WebGL.
//
// Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 9.3,
//               10.1, 11.2

// react-refresh only handles files that export components exclusively;
// `computeRotationDelta` is co-located here intentionally so the
// property test in task 6.2 can import it without pulling in `three`.
/* eslint-disable react-refresh/only-export-components */

import { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float } from '@react-three/drei';
import type { Mesh } from 'three';

import { useLandingMotion } from './LandingMotionContext';

/**
 * Base rotation rate in radians per second.
 *
 * Chosen at 0.12 rad/s so the per-frame increment lands comfortably
 * inside the `[0.05 * dt, 0.3 * dt]` band required by Req 1.3 (and
 * verified by Property 1).
 */
const ROTATION_RATE_PER_SECOND = 0.12;

/**
 * Accent palette pulled from the landing-page Color_System
 * (`--accent-teal`, `--accent-indigo`, `--accent-pink`). Inlined here as
 * literals because the R3F scene graph cannot consume CSS custom
 * properties directly. Kept in sync with the tokens declared in
 * `src/components/LandingPage.css` (Req 10.1).
 */
const ACCENT_COLORS = {
  teal: '#14b8a6',
  indigo: '#6366f1',
  pink: '#f472b6',
} as const;

/**
 * Inputs to {@link computeRotationDelta}.
 */
export interface RotationGate {
  /** `true` when the user's OS reports `prefers-reduced-motion: reduce`. */
  reducedMotion: boolean;
  /** `true` when `document.visibilityState !== 'hidden'`. */
  tabVisible: boolean;
}

/**
 * Pure per-frame rotation increment.
 *
 * Returns `0` when either gate is active so the {@link HeroGeometry}
 * stays stationary under reduced motion (Req 2.3) or while the tab is
 * hidden (Req 2.1, 2.2). Otherwise returns a value in the closed
 * interval `[0.05 * dt, 0.3 * dt]` — Req 1.3 requires a rotation rate
 * in `[0.05, 0.3]` rad/s, and multiplying by `dt` converts that to a
 * per-frame increment that scales correctly with the frame interval.
 *
 * The function is fully pure: no DOM access, no R3F state, no
 * randomness. Property 1 in `design.md` quantifies over this contract.
 *
 * Requirements: 1.3, 2.1, 2.2, 2.3
 */
export function computeRotationDelta(
  dt: number,
  { reducedMotion, tabVisible }: RotationGate,
): number {
  if (reducedMotion) return 0;
  if (!tabVisible) return 0;
  return ROTATION_RATE_PER_SECOND * dt;
}

/**
 * Inner scene mesh. Kept as a separate component so the `useFrame` hook
 * lives inside the R3F render tree (it cannot be called from the
 * {@link Hero3DCanvas} host component which sits outside the Canvas).
 *
 * Visual design:
 *   - `icosahedronGeometry` with one subdivision for a faceted-but-not-
 *     polygonal silhouette (Req 1.2).
 *   - `MeshTransmissionMaterial` configured with transmission,
 *     thickness, chromatic aberration, IOR, and `backside` so the
 *     surface reads as refractive translucent glass with the colored
 *     fringing required by Req 1.4.
 *   - Wrapped in `<Float>` so the mesh idles with a slight bob; the
 *     bob is purely positional and is independent of the rotation
 *     increment that Property 1 quantifies over.
 *
 * Requirements: 1.2, 1.3, 1.4, 2.1, 2.2, 2.3
 */
function HeroGeometry() {
  const coreRef = useRef<Mesh>(null);
  const wireRef = useRef<Mesh>(null);
  const { reducedMotion, tabVisible } = useLandingMotion();

  useFrame((_state, dt) => {
    const delta = computeRotationDelta(dt, { reducedMotion, tabVisible });
    if (delta === 0) return;
    if (coreRef.current) {
      coreRef.current.rotation.y += delta;
      coreRef.current.rotation.x += delta * 0.6;
    }
    // Wireframe rotates in the opposite direction for a subtle parallax
    // between the faceted core and its glowing edge silhouette.
    if (wireRef.current) {
      wireRef.current.rotation.y -= delta * 0.9;
      wireRef.current.rotation.z += delta * 0.5;
    }
  });

  return (
    // Orb sits at world origin. Vertical placement within the hero is
    // handled by CSS positioning of the `<canvas>` element itself
    // (see `.hero-3d-canvas` in `landing-3d.css`) so the orb can't be
    // clipped by the camera frustum.
    <Float speed={1.2} rotationIntensity={0} floatIntensity={0.5}>
      {/* Inner faceted crystal — `detail=0` gives the classic 20-face
          d20 silhouette so the icosahedron reads as obviously 3D.
          `flatShading` makes the facets distinct rather than smooth.
          Iridescence + clearcoat give a colorful prismatic surface
          without needing an HDR environment map. */}
      <mesh ref={coreRef} scale={1.0}>
        <icosahedronGeometry args={[1.0, 0]} />
        <meshPhysicalMaterial
          color="#6366f1"
          emissive="#7c3aed"
          emissiveIntensity={0.45}
          metalness={0.5}
          roughness={0.2}
          iridescence={1}
          iridescenceIOR={1.4}
          iridescenceThicknessRange={[100, 800]}
          clearcoat={1}
          clearcoatRoughness={0.05}
          flatShading
        />
      </mesh>
      {/* Outer wireframe shell — slightly larger to avoid z-fighting,
          traces the icosahedron edges as glowing pink-violet lines. */}
      <mesh ref={wireRef} scale={1.08}>
        <icosahedronGeometry args={[1.0, 0]} />
        <meshBasicMaterial
          color="#f0abfc"
          wireframe
          transparent
          opacity={0.5}
        />
      </mesh>
    </Float>
  );
}

/**
 * Props for {@link Hero3DCanvas}.
 */
export interface Hero3DCanvasProps {
  /**
   * Upper bound for the Canvas's device pixel ratio. Caller is
   * responsible for clamping (typically via `computeDprCap` from
   * `detectLowEndGpu.ts`) so this surface stays at `1×` on low-end
   * GPUs (Req 2.4).
   */
  dprCap: number;
}

/**
 * Hero 3D canvas host.
 *
 * Default export so `React.lazy(() => import('./Hero3DCanvas'))` in
 * `LandingPage.tsx` pulls this module — and its entire `three` /
 * `@react-three/fiber` / `@react-three/drei` transitive closure — into
 * a separate async chunk (Req 2.6, Req 11.3).
 *
 * Positioning, z-index, and pointer-events are handled by the
 * `.hero-3d-canvas` class in `landing-3d.css`; this component is
 * responsible only for the WebGL surface itself.
 *
 * Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 2.4, 9.3, 10.1, 11.2
 */
export default function Hero3DCanvas({
  dprCap,
}: Hero3DCanvasProps) {
  return (
    <Canvas
      className="hero-3d-canvas"
      dpr={[1, dprCap]}
      camera={{ position: [0, 0, 4], fov: 35 }}
      gl={{ powerPreference: 'low-power', alpha: true, antialias: true }}
      frameloop="always"
    >
      <ambientLight intensity={0.8} />
      {/* Rim lights tinted with the accent palette (Req 1.4, Req 10.1).
          High intensities + the material's `iridescence` + `clearcoat`
          stand in for an HDR environment, giving the surface its
          colorful glassy character without a network fetch. */}
      <directionalLight position={[3, 3, 3]} intensity={2.4} color={ACCENT_COLORS.pink} />
      <directionalLight position={[-3, -2, -1]} intensity={1.8} color={ACCENT_COLORS.teal} />
      <directionalLight position={[0, -3, 2]} intensity={1.4} color={ACCENT_COLORS.indigo} />
      <pointLight position={[2, 0, 3]} intensity={1.5} color="#ffffff" />
      <HeroGeometry />
    </Canvas>
  );
}
