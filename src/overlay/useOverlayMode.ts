// ============================================
// Zule AI — Overlay Mode Hook
// ============================================
//
// Manages the three-state overlay window sizing (Cluely parity):
//
//   - Compact   : 380×80   — just the control capsule
//   - Expanded  : 480×320  — capsule + tabs/chips/input bar (no answer area)
//   - Maximized : 480×680  — full panel with scrollable AI response area
//
// State transitions:
//   - Compact → Expanded:  user clicks the chevron on the capsule
//   - Expanded → Maximized: automatic when an AI response arrives or
//     streaming starts; OR user clicks the corner expand icon
//   - Maximized → Expanded: user clicks the corner restore icon
//   - Any → Compact:        user clicks the capsule chevron in expanded/max mode
//
// Each transition is sequenced with the renderer's resize event so the
// CSS animation never runs while the native window is mid-resize (which
// is what causes the visible jitter we hit earlier in this work).
//
// Compact_Mode: 380×80, shows only control capsule
// Expanded_Mode: 480×320, shows control bar + chips + input
// Maximized_Mode: 480×680, shows scrollable response area + chips + input

import { useState, useCallback, useRef } from 'react';
import { useElectronBridge, isElectron } from '../hooks/useElectronBridge';

export type OverlayMode = 'compact' | 'expanded' | 'maximized';

// JITTER FIX: All modes use the same width (480px). Changing width during
// mode transitions caused the OverlayManager to re-center the window
// horizontally, which shifted the X position and made the capsule jitter.
// Only height changes between modes — the capsule never moves sideways.
export const COMPACT_WIDTH = 480;
export const COMPACT_HEIGHT = 80;
// Expanded = compact card (header + chips + input, NO scroll body).
// Maximized = full card with scroll body visible for AI responses.
export const EXPANDED_WIDTH = 480;
export const EXPANDED_HEIGHT = 400;
export const MAXIMIZED_WIDTH = 480;
export const MAXIMIZED_HEIGHT = 680;

/** Must match the CSS transition duration of `.native-overlay-mode .suggestion-card`. */
const CARD_TRANSITION_MS = 280;

function sizeFor(mode: OverlayMode): { width: number; height: number } {
  switch (mode) {
    case 'compact':
      return { width: COMPACT_WIDTH, height: COMPACT_HEIGHT };
    case 'expanded':
      return { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT };
    case 'maximized':
      return { width: MAXIMIZED_WIDTH, height: MAXIMIZED_HEIGHT };
  }
}

export interface UseOverlayModeResult {
  /** Current overlay mode. */
  mode: OverlayMode;
  /** True when in compact mode. */
  isCompact: boolean;
  /** True when in expanded mode (mid-size, no big response area). */
  isExpanded: boolean;
  /** True when in maximized mode (full panel with response area). */
  isMaximized: boolean;
  /** Toggle between compact and expanded (capsule chevron). */
  toggleMode: () => void;
  /** Toggle between expanded and maximized (card corner button). */
  toggleMaximize: () => void;
  /** Set mode explicitly. */
  setMode: (mode: OverlayMode) => void;
  /** The current aria-live announcement text for mode transitions. */
  modeAnnouncement: string;
}

/**
 * React hook that manages compact/expanded/maximized overlay mode transitions.
 *
 * In Electron, mode changes call `resizeOverlay(width, height)` and sequence
 * the native resize with the React state change so the CSS animation runs on
 * a fully-painted surface (no jitter, no layout pop).
 *
 * @param initialMode - Starting mode (defaults to 'compact')
 */
export function useOverlayMode(initialMode: OverlayMode = 'compact'): UseOverlayModeResult {
  const [mode, setModeState] = useState<OverlayMode>(initialMode);
  const [modeAnnouncement, setModeAnnouncement] = useState('');
  const shrinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { api } = useElectronBridge();

  const setMode = useCallback(
    (newMode: OverlayMode) => {
      setModeState((prev) => {
        if (prev === newMode) return prev;

        const electron = isElectron();
        const { width, height } = sizeFor(newMode);

        // Decide whether the renderer's CSS animation should run BEFORE
        // or AFTER the native resize. Rule of thumb:
        //   - Growing (compact → expanded, expanded → maximized): resize
        //     first, then animate the new content in.
        //   - Shrinking (maximized → expanded, expanded → compact):
        //     animate content out first, then resize down.
        const prevSize = sizeFor(prev);
        const isGrowing = height > prevSize.height || width > prevSize.width;

        if (isGrowing) {
          if (electron) {
            // Resize the window first, then update state synchronously.
            // Previous approach used requestAnimationFrame to defer the
            // state update, but rAF is unreliable in Electron overlay
            // windows and silently failed — the mode never switched to
            // 'maximized', keeping the scroll body hidden forever.
            api.resizeOverlay(width, height);
          }
          setModeAnnouncement(announcementFor(newMode));
          return newMode; // Update state immediately
        }

        // Shrinking: animate card out, then resize.
        setModeAnnouncement(announcementFor(newMode));
        if (electron) {
          if (shrinkTimerRef.current) clearTimeout(shrinkTimerRef.current);
          shrinkTimerRef.current = setTimeout(() => {
            api.resizeOverlay(width, height);
            shrinkTimerRef.current = null;
          }, CARD_TRANSITION_MS);
        }
        return newMode;
      });
    },
    [api],
  );

  const toggleMode = useCallback(() => {
    // Capsule chevron: cycles compact ↔ expanded (preserves max state by
    // rolling back to expanded first if currently maximized).
    setMode(mode === 'compact' ? 'expanded' : 'compact');
  }, [mode, setMode]);

  const toggleMaximize = useCallback(() => {
    // Card corner button: cycles expanded ↔ maximized.
    setMode(mode === 'maximized' ? 'expanded' : 'maximized');
  }, [mode, setMode]);

  return {
    mode,
    isCompact: mode === 'compact',
    isExpanded: mode === 'expanded',
    isMaximized: mode === 'maximized',
    toggleMode,
    toggleMaximize,
    setMode,
    modeAnnouncement,
  };
}

function announcementFor(mode: OverlayMode): string {
  switch (mode) {
    case 'compact':
      return 'Compact mode';
    case 'expanded':
      return 'Expanded mode';
    case 'maximized':
      return 'Maximized mode';
  }
}
