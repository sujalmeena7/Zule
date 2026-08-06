// ============================================
// Zule AI — Document Visibility Hook
// ============================================
//
// Tracks `document.visibilityState` via the `visibilitychange` event.
// Used by the landing page 3D enhancement to pause the react-three-fiber
// render loop while the tab is hidden so the GPU and battery stay idle.
//
// Outside a browser environment (SSR / Node tests where `document` is not
// defined) the hook returns `true` so consumers default to the visible /
// rendering path.
//
// Requirements: 2.1, 2.2 (landing-page-3d-enhancement)

import { useEffect, useState } from 'react';

/**
 * Read the current visibility once, defaulting to `true` when `document`
 * is not available (server-side rendering, Node-based unit tests).
 */
function readVisibility(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

/**
 * React hook that reactively tracks whether the document is currently visible.
 *
 * Returns `true` when the tab is visible and `false` when it is hidden.
 * Subscribes to `visibilitychange` on mount and cleans up on unmount.
 *
 * @returns `boolean` — `true` when `document.visibilityState !== 'hidden'`.
 *
 * Requirements (landing-page-3d-enhancement):
 *   - 2.1: WHILE the Tab_Hidden_State is active, the Hero_3D_Canvas suspends its render loop.
 *   - 2.2: WHEN the Tab_Hidden_State becomes inactive, the Hero_3D_Canvas resumes its render loop.
 */
export function useDocumentVisibility(): boolean {
  const [visible, setVisible] = useState<boolean>(readVisibility);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handler = (): void => {
      setVisible(document.visibilityState !== 'hidden');
    };

    document.addEventListener('visibilitychange', handler);
    return () => {
      document.removeEventListener('visibilitychange', handler);
    };
  }, []);

  return visible;
}
