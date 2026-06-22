// ============================================
// Zule AI — Auto-Update Hook
// ============================================
//
// Subscribes to the Auto_Updater state via the IPC bridge and exposes
// action dispatchers for the update lifecycle.
//
// Gracefully falls back to an inert idle state when running outside
// Electron (web mode) or when the electronAPI methods are unavailable.
//
// Requirements: 4.7, 4.8, 10.6, 11.5

import { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdateState } from '../types/electron';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default state used before any IPC event arrives or in web fallback. */
const DEFAULT_STATE: UpdateState = {
  status: 'idle',
  currentVersion: '0.0.0',
  availableVersion: null,
  releaseNotes: null,
  progress: null,
  error: null,
};

// ─── Return type ─────────────────────────────────────────────────────────────

export interface UseAutoUpdateReturn {
  state: UpdateState;
  dismissed: boolean;
  check: () => void;
  download: () => void;
  cancel: () => void;
  install: () => void;
  defer: () => void;
  dismiss: () => void;
}

// ─── Hook implementation ─────────────────────────────────────────────────────

/**
 * React hook that bridges the renderer to the Auto_Updater main-process service.
 *
 * - Subscribes to `window.electronAPI.onUpdateState` on mount and
 *   unsubscribes on unmount (Requirement 10.6).
 * - Exposes action dispatchers that call the corresponding IPC methods.
 *   All dispatchers are no-ops when `window.electronAPI` is unavailable
 *   (Requirement 11.5 — graceful fallback in web/degraded mode).
 * - Tracks a `dismissed` boolean state that hides the banner until the
 *   next app restart (Requirements 4.7, 4.8 — in-memory only, resets on
 *   restart).
 */
export function useAutoUpdate(): UseAutoUpdateReturn {
  const [state, setState] = useState<UpdateState>(DEFAULT_STATE);
  const [dismissed, setDismissed] = useState(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // ── Subscribe to state events on mount ────────────────────────────────────

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onUpdateState) return;

    unsubscribeRef.current = api.onUpdateState((newState: UpdateState) => {
      setState(newState);
    });

    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, []);

  // ── Action dispatchers ────────────────────────────────────────────────────

  const check = useCallback(() => {
    window.electronAPI?.checkForUpdate?.();
  }, []);

  const download = useCallback(() => {
    window.electronAPI?.downloadUpdate?.();
  }, []);

  const cancel = useCallback(() => {
    window.electronAPI?.cancelDownload?.();
  }, []);

  const install = useCallback(() => {
    window.electronAPI?.installUpdate?.();
  }, []);

  const defer = useCallback(() => {
    window.electronAPI?.deferInstall?.();
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  return { state, dismissed, check, download, cancel, install, defer, dismiss };
}
