// ============================================
// Zule AI — Overlay Shell
// ============================================
//
// Thin wrapper that mounts FloatingCopilot inside the native Electron
// overlay window. Sets transparent background, fixed positioning to
// fill the BrowserWindow, and integrates zone detection, focus trap,
// drag regions, and accessibility attributes.
//
// Drag model (Req 4.1, 4.2, 10.4):
//   - The entire overlay viewport is a `-webkit-app-region: drag` zone,
//     so dragging anywhere on the capsule moves the native window.
//   - Specific interactive controls (buttons, inputs, links) inside
//     FloatingCopilot mark themselves as `-webkit-app-region: no-drag`
//     via CSS rules in FloatingCopilot.css so they remain clickable.
//
// Requirements: 10.2, 10.4, 4.1, 4.2, 13.1, 13.6

import { useEffect, useRef, useState } from 'react';
import { FloatingCopilot } from './FloatingCopilot';
import { ErrorBoundary } from './ErrorBoundary';
import { ZuleProvider } from '../context/ZuleContext';
import { AuthProvider } from '../firebase/AuthContext';
import { SubscriptionProvider } from '../context/SubscriptionContext';
import { MotionConfig } from 'framer-motion';
import { useZoneDetector } from '../overlay/useZoneDetector';
import { useFocusTrap } from '../overlay/focusTrap';

/**
 * OverlayShell — mounted as root when the renderer loads with #overlay hash.
 *
 * Renders FloatingCopilot in isolation (no dashboard chrome, no sidebar)
 * with a transparent background so native window transparency works.
 *
 * Integrates:
 * - Zone detector: RAF-throttled mousemove → classifyZone → IPC click-through
 * - Focus trap: Tab/Shift+Tab cycle within overlay when interacting
 * - Drag regions: `-webkit-app-region: drag` on the full viewport, with
 *   `no-drag` applied to interactive controls via CSS in FloatingCopilot.css
 * - Accessibility: role="region", aria-label, data-interactive-zone
 */
export function OverlayShell() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging] = useState(false);
  const [isModalOpen] = useState(false);
  const [isFocusTrapEnabled, setIsFocusTrapEnabled] = useState(false);

  // Zone detector: RAF-throttled mousemove → classifyZone → IPC
  useZoneDetector({
    enabled: true,
    isDragging,
    isModalOpen,
  });

  // Focus trap: Tab/Shift+Tab cycle within overlay when interacting
  useFocusTrap({
    containerRef,
    enabled: isFocusTrapEnabled,
  });

  useEffect(() => {
    // Force body and html to be transparent for the overlay window
    document.documentElement.style.backgroundColor = 'transparent';
    document.body.style.backgroundColor = 'transparent';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.overflow = 'hidden';

    return () => {
      document.documentElement.style.backgroundColor = '';
      document.body.style.backgroundColor = '';
      document.body.style.margin = '';
      document.body.style.padding = '';
      document.body.style.overflow = '';
    };
  }, []);

  // Activate focus trap when user clicks or focuses inside the overlay
  const handleInteractionStart = () => setIsFocusTrapEnabled(true);

  // Deactivate focus trap when overlay loses focus entirely
  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    // Only deactivate if focus moved outside the container
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setIsFocusTrapEnabled(false);
    }
  };

  return (
    <AuthProvider>
      <SubscriptionProvider>
        <ZuleProvider>
          <MotionConfig reducedMotion="user">
            <div
              ref={containerRef}
              className="overlay-shell"
              role="region"
              aria-label="Zule AI copilot"
              data-interactive-zone
              style={{
                position: 'fixed',
                inset: 0,
                width: '100vw',
                height: '100vh',
                background: 'transparent',
                overflow: 'hidden',
              }}
              onMouseDown={handleInteractionStart}
              onFocus={handleInteractionStart}
              onBlur={handleBlur}
            >
              <ErrorBoundary>
                <FloatingCopilot />
              </ErrorBoundary>
            </div>
            {/* Toasts are suppressed in the overlay — errors are logged to
                console only. The overlay must never show transient UI that
                could distract the user during a live session. */}
          </MotionConfig>
        </ZuleProvider>
      </SubscriptionProvider>
    </AuthProvider>
  );
}
