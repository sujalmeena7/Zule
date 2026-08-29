// ============================================
// Zule AI — Landing Motion Context
// ============================================
//
// Shared React context that exposes the four runtime motion flags every
// animated surface on the landing page needs to read:
//
//   - `reducedMotion`  — reactive, mirrors `prefers-reduced-motion: reduce`
//   - `tabVisible`     — reactive, mirrors `document.visibilityState`
//   - `lowEndGpu`      — memoized, derived from `devicePixelRatio`,
//                        `navigator.hardwareConcurrency`, and the WebGL
//                        renderer string
//   - `webglAvailable` — memoized, result of a synchronous WebGL probe
//   - `dprCap`         — memoized, `1` under low-end GPU detection else
//                        `min(window.devicePixelRatio, 2)`
//
// Centralising the flags here keeps reduced-motion behaviour coherent
// across the page — if any consumer honours the flag, every consumer
// honours it — and keeps `matchMedia` / `visibilitychange` /
// `getContext('webgl')` subscriptions to exactly one site.
//
// Requirements: 2.1, 2.2, 2.3, 2.4, 2.5

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
  type ReactElement,
} from 'react';

import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useDocumentVisibility } from '../../hooks/useDocumentVisibility';
import { detectWebGL } from './detectWebGL';
import { computeDprCap, detectLowEndGpu } from './detectLowEndGpu';

/**
 * Snapshot of the landing page's motion-related runtime flags.
 *
 * Every animated surface (`Hero3DCanvas`, `MagneticLink`, `Logo3D`,
 * `TiltCard`, `ParallaxLayer`, `ActiveIndicator`) reads from this single
 * source of truth via `useLandingMotion()`.
 */
export interface LandingMotionState {
  /** `true` when the user's OS reports `prefers-reduced-motion: reduce`. */
  reducedMotion: boolean;
  /** `true` when `document.visibilityState !== 'hidden'`. */
  tabVisible: boolean;
  /** `true` when the host environment looks like a low-end GPU. */
  lowEndGpu: boolean;
  /** `true` when a WebGL context can be created at mount. */
  webglAvailable: boolean;
  /** Cap to apply to the R3F canvas `dpr` prop. */
  dprCap: number;
}

/**
 * React context handle. Stays `null` outside the provider so
 * {@link useLandingMotion} can detect misuse and throw a clear error.
 */
export const LandingMotionContext = createContext<LandingMotionState | null>(
  null,
);

interface LandingMotionProviderProps {
  children: ReactNode;
}

/**
 * Provider that computes the {@link LandingMotionState} once at mount,
 * subscribes the reactive flags, and supplies the combined value to
 * every descendant on the landing page.
 *
 * The synchronous probes (`detectWebGL`, `detectLowEndGpu`,
 * `devicePixelRatio`) run inside `useMemo` with an empty dependency
 * array so they execute exactly once per provider mount — the WebGL
 * canvas allocation in particular is not free, and these values are
 * fixed for the lifetime of the browser session.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */
export function LandingMotionProvider({
  children,
}: LandingMotionProviderProps): ReactElement {
  const reducedMotion = useReducedMotion();
  const tabVisible = useDocumentVisibility();

  const webglAvailable = useMemo<boolean>(() => detectWebGL(), []);
  const lowEndGpu = useMemo<boolean>(() => detectLowEndGpu(), []);
  const dprCap = useMemo<number>(() => {
    const dpr =
      typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number'
        ? window.devicePixelRatio
        : 1;
    return computeDprCap(lowEndGpu, dpr);
  }, [lowEndGpu]);

  const value = useMemo<LandingMotionState>(
    () => ({
      reducedMotion,
      tabVisible,
      lowEndGpu,
      webglAvailable,
      dprCap,
    }),
    [reducedMotion, tabVisible, lowEndGpu, webglAvailable, dprCap],
  );

  return (
    <LandingMotionContext.Provider value={value}>
      {children}
    </LandingMotionContext.Provider>
  );
}

/**
 * Hook that returns the active {@link LandingMotionState}.
 *
 * Throws when called outside a {@link LandingMotionProvider} so a
 * forgotten provider surfaces as a loud, immediate error rather than a
 * silent fallback to default motion behaviour.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */
export function useLandingMotion(): LandingMotionState {
  const value = useContext(LandingMotionContext);
  if (value === null) {
    throw new Error(
      'useLandingMotion must be used inside <LandingMotionProvider>',
    );
  }
  return value;
}
