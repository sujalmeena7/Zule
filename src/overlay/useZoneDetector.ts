// src/overlay/useZoneDetector.ts
// ============================================
// Zule AI — Zone Detector Integration Hook
// ============================================
//
// RAF-throttled mousemove listener that classifies the cursor position
// as interactive or pass-through using the pure classifyZone/shouldEmitIPC
// functions, then calls setIgnoreMouseEvents via the Renderer_Bridge
// only on state transitions.
//
// ── Performance Guarantees ──────────────────────────────────────────────────
// - Evaluations throttled to ≤60/s via requestAnimationFrame (Req 14.2)
// - IPC emitted only on state transitions via shouldEmitIPC (Req 14.3)
// - When enabled=false, no listeners attached, no bridge calls (Req 14.3)
// - When cursor is outside the overlay window, no mousemove fires on this
//   document, so no bridge methods are invoked per frame (Req 14.3)

import { useEffect, useRef, useCallback } from 'react';
import { classifyZone, shouldEmitIPC } from './zoneDetector';
import type { ZoneClassification, ZoneDetectorState } from './zoneDetector';
import { useElectronBridge } from '../hooks/useElectronBridge';

export interface UseZoneDetectorOptions {
  /** Whether the zone detector is active (overlay is visible and cursor is relevant). */
  enabled: boolean;
  /** Whether the user is currently dragging the overlay window. */
  isDragging: boolean;
  /** Whether a modal element (dropdown, menu) is open over the overlay. */
  isModalOpen: boolean;
}

/**
 * React hook that integrates the zone detector with the Electron bridge.
 *
 * Attaches a `mousemove` listener to `document` when enabled. Uses
 * `requestAnimationFrame` to throttle evaluations to at most once per
 * frame (~60/s). On each evaluation, classifies the element under the
 * cursor and emits `setIgnoreMouseEvents` IPC only on state transitions.
 *
 * When disabled, no listeners are attached and no bridge methods are called.
 */
export function useZoneDetector(options: UseZoneDetectorOptions): void {
  const { enabled, isDragging, isModalOpen } = options;
  const { api } = useElectronBridge();

  // Track the current zone classification across evaluations.
  const currentZoneRef = useRef<ZoneClassification>('pass-through');

  // Track pending RAF handle so we only schedule one per frame.
  const rafHandleRef = useRef<number | null>(null);

  // Store the latest mouse coordinates for the RAF callback.
  const lastCoordsRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Keep options in a ref so the RAF callback always sees the latest values
  // without needing to re-create the listener on every option change.
  const optionsRef = useRef<UseZoneDetectorOptions>(options);
  optionsRef.current = options;

  const evaluate = useCallback(() => {
    rafHandleRef.current = null;

    const { x, y } = lastCoordsRef.current;
    const opts = optionsRef.current;

    // Determine the element under the cursor.
    const element = document.elementFromPoint(x, y);

    // Build the state for classification.
    const state: ZoneDetectorState = {
      isDragging: opts.isDragging,
      isModalOpen: opts.isModalOpen,
      currentZone: currentZoneRef.current,
    };

    // Classify the zone.
    const newZone = classifyZone(element, state);

    // Emit IPC only on state transitions.
    if (shouldEmitIPC(currentZoneRef.current, newZone)) {
      if (newZone === 'pass-through') {
        api.setIgnoreMouseEvents(true, { forward: true });
      } else {
        api.setIgnoreMouseEvents(false);
      }
      currentZoneRef.current = newZone;
    }
  }, [api]);

  useEffect(() => {
    if (!enabled) {
      // When disabled, do not attach listeners or call bridge methods.
      // Cancel any pending RAF.
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current);
        rafHandleRef.current = null;
      }
      return;
    }

    const handleMouseMove = (event: MouseEvent) => {
      // Store latest coordinates for the RAF callback.
      lastCoordsRef.current = { x: event.clientX, y: event.clientY };

      // Only schedule one RAF at a time — this throttles to ~60 evaluations/s.
      if (rafHandleRef.current === null) {
        rafHandleRef.current = requestAnimationFrame(evaluate);
      }
    };

    document.addEventListener('mousemove', handleMouseMove);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current);
        rafHandleRef.current = null;
      }
    };
  }, [enabled, evaluate]);
}
