// ============================================
// Zule AI — Online Status Hook
// ============================================
//
// Tracks `navigator.onLine` via `online` and `offline` window events.
// Returns the current connectivity state so the application can
// gracefully degrade to local providers when offline.
//
// Requirements: 20.1, 20.2

import { useState, useEffect, useSyncExternalStore, useCallback } from 'react';

// ─── External store approach (React 18+) ─────────────────────────────────────

function subscribe(callback: () => void): () => void {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

function getSnapshot(): boolean {
  return navigator.onLine;
}

function getServerSnapshot(): boolean {
  // During SSR, assume online.
  return true;
}

/**
 * React hook that reactively tracks the browser's online/offline status.
 *
 * Uses `useSyncExternalStore` for tear-free reads of `navigator.onLine`
 * in response to the window `online` and `offline` events.
 *
 * @returns `{ isOnline: boolean }` — `true` when the browser reports connectivity.
 *
 * Requirements:
 *   - 20.1: Display offline banner when `navigator.onLine === false`.
 *   - 20.2: Continue local operations (KB retrieval, local Whisper) while offline.
 */
export function useOnlineStatus(): { isOnline: boolean } {
  const isOnline = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { isOnline };
}
