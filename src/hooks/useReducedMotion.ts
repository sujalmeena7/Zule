// ============================================
// Zule AI — Reduced Motion Preference Hook
// ============================================
//
// Reactively tracks the `prefers-reduced-motion: reduce` media query so
// landing-page surfaces (R3F hero, magnetic links, tilt cards, parallax)
// can gate animation behind an explicit boolean. framer-motion's
// `<MotionConfig reducedMotion="user">` covers `motion.*` components on
// its own, this hook exists for the non-framer code paths (R3F
// `useFrame`, imperative pointer math) that still need to read the
// preference directly.
//
// Defaults to `false` when `window` is unavailable (SSR / Node).
//
// Requirements: 2.3, 4.5, 4.6, 5.3, 6.5

import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function readPreference(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(QUERY).matches;
}

/**
 * React hook that reactively tracks the user's `prefers-reduced-motion`
 * setting.
 *
 * Subscribes to the media query's `change` event so toggling the OS-level
 * preference at runtime propagates to consumers, and cleans up the
 * listener on unmount.
 *
 * @returns `true` when the user prefers reduced motion, otherwise `false`.
 *
 * Requirements:
 *   - 2.3: Hero geometry holds a static pose under reduced motion.
 *   - 4.5: Magnetic links do not translate under reduced motion.
 *   - 4.6: Active indicator updates without transition under reduced motion.
 *   - 5.3: 3D logo does not rotate on hover under reduced motion.
 *   - 6.5: Tilt and parallax are disabled under reduced motion.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(readPreference);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia(QUERY);
    const handler = (event: MediaQueryListEvent) => setReduced(event.matches);

    // Older Safari exposes `addListener` / `removeListener` only.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);

  return reduced;
}
