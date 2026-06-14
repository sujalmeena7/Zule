// ============================================
// Zule AI — Electron Bridge Hook
// ============================================
//
// Provides typed access to the Electron API exposed by the preload script.
// Falls back gracefully to no-ops when running as a web app, keeping
// the app dual-mode (browser + desktop).

import { useMemo } from 'react';
import type { ElectronAPI } from '../types/electron.d';

/** Check if we're running inside Electron. */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.isElectron;
}

/** No-op fallback API for browser mode. */
const browserFallback: ElectronAPI = {
  platform: 'win32',
  isElectron: true, // type requires true, but we flag via isElectronEnv
  setContentProtection: async () => false,
  setAlwaysOnTop: async () => false,
  setIgnoreMouseEvents: async () => {},
  startOverlay: async () => false,
  stopOverlay: async () => false,
  toggleOverlay: async () => false,
  resizeOverlay: async () => false,
  moveOverlay: async () => false,
  getOverlayBounds: async () => null,
  sendSyncMessage: () => {},
  onSyncMessage: () => () => {},
  onOverlayError: () => () => {},
  onGlobalShortcut: () => () => {},
  getDesktopSources: async () => [],
};

export interface UseElectronBridgeResult {
  /** Whether the app is running inside Electron. */
  isElectronEnv: boolean;
  /** The Electron API (real or no-op fallback). */
  api: ElectronAPI;
}

/**
 * React hook that provides typed access to the Electron bridge.
 *
 * When running in a browser, all methods are no-ops that return
 * safe defaults. This lets all components call bridge methods
 * without conditional checks everywhere.
 *
 * @example
 * ```tsx
 * const { isElectronEnv, api } = useElectronBridge();
 * if (isElectronEnv) {
 *   api.setContentProtection(true);
 * }
 * ```
 */
export function useElectronBridge(): UseElectronBridgeResult {
  return useMemo(() => {
    const electronEnv = isElectron();
    return {
      isElectronEnv: electronEnv,
      api: electronEnv ? window.electronAPI! : browserFallback,
    };
  }, []);
}
