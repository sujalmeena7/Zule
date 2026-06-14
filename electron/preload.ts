// ============================================
// Zule AI — Electron Preload Script
// ============================================
//
// Exposes a secure API bridge from the main process to the renderer
// via contextBridge. This is the ONLY way the React app communicates
// with Electron APIs (no nodeIntegration, full contextIsolation).

import { contextBridge, ipcRenderer } from 'electron';

// ── Type-safe API exposed to the renderer ────────────────────────────────────

const electronAPI = {
  /** Identifier so the React app can detect Electron environment. */
  platform: process.platform as 'win32' | 'darwin' | 'linux',

  /** Whether we're running inside Electron (always true from this preload). */
  isElectron: true as const,

  // ── Content Protection (Phase 2) ─────────────────────────────────────────

  /** Toggle screen-share invisibility for the overlay window. */
  setContentProtection: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('set-content-protection', enabled),

  /**
   * Toggle screen-capture invisibility for BOTH the dashboard and overlay
   * windows in one call. Returns false if the underlying OS API threw on
   * the dashboard window (typically a transient Windows GPU-driver error);
   * the overlay attempt is reported separately via `onOverlayError`.
   */
  toggleVisibilityProtection: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('toggle-visibility-protection', enabled),

  // ── Window Control ───────────────────────────────────────────────────────

  /** Toggle always-on-top for the overlay. */
  setAlwaysOnTop: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('set-always-on-top', enabled),

  /** Toggle click-through for the overlay window. Accepts optional forward flag for zone detection. */
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward?: boolean }): Promise<void> =>
    ipcRenderer.invoke('set-ignore-mouse-events', ignore, options),

  /** Create and show the overlay window (called when user starts a copilot session). */
  startOverlay: (): Promise<boolean> =>
    ipcRenderer.invoke('start-overlay'),

  /** Close and destroy the overlay window (called when user stops a copilot session). */
  stopOverlay: (): Promise<boolean> =>
    ipcRenderer.invoke('stop-overlay'),

  /** Show or hide the overlay window. */
  toggleOverlay: (): Promise<boolean> =>
    ipcRenderer.invoke('toggle-overlay'),

  /** Resize the overlay window. */
  resizeOverlay: (width: number, height: number): Promise<boolean> =>
    ipcRenderer.invoke('resize-overlay', width, height),

  /** Move the overlay window to a new position. */
  moveOverlay: (x: number, y: number): Promise<boolean> =>
    ipcRenderer.invoke('move-overlay', x, y),

  /** Get the current overlay window bounds. */
  getOverlayBounds: (): Promise<{ x: number; y: number; width: number; height: number } | null> =>
    ipcRenderer.invoke('get-overlay-bounds'),

  // ── Dual-Mode Overlay Transition (dual-mode-overlay-window-fix) ──────────

  /**
   * Atomically switch the existing dashboard BrowserWindow into Mode 2
   * (compact, frameless, transparent, always-on-top overlay). Forwards only
   * the literal channel `'switch-to-overlay'` to the main process.
   */
  switchToOverlay: (): Promise<boolean> =>
    ipcRenderer.invoke('switch-to-overlay'),

  // ── IPC Communication (Phase 3) ──────────────────────────────────────────

  /** Send a sync message to all windows (cross-window IPC). */
  sendSyncMessage: (message: unknown): void =>
    ipcRenderer.send('ipc-sync-message', message),

  /** Listen for sync messages from other windows. */
  onSyncMessage: (callback: (message: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: unknown) =>
      callback(message);
    ipcRenderer.on('ipc-sync-message', handler);
    // Return cleanup function
    return () => ipcRenderer.removeListener('ipc-sync-message', handler);
  },

  // ── Error Notifications ───────────────────────────────────────────────────

  /** Listen for overlay error events from the main process. */
  onOverlayError: (callback: (error: { code: string; message: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: { code: string; message: string }) =>
      callback(error);
    ipcRenderer.on('overlay-error', handler);
    return () => ipcRenderer.removeListener('overlay-error', handler);
  },

  // ── Global Shortcuts (Phase 3) ───────────────────────────────────────────

  /** Listen for global shortcut events from the main process. */
  onGlobalShortcut: (callback: (shortcutId: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, shortcutId: string) =>
      callback(shortcutId);
    ipcRenderer.on('global-shortcut', handler);
    return () => ipcRenderer.removeListener('global-shortcut', handler);
  },

  // ── Native Screen Capture (Phase 3) ──────────────────────────────────────

  /** Get available screen/window sources for native capture. */
  getDesktopSources: (): Promise<
    Array<{
      id: string;
      name: string;
      thumbnail: string; // base64 data URL
    }>
  > => ipcRenderer.invoke('get-desktop-sources'),
};

// Expose the API to the renderer's window object
contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// ── TypeScript declaration for the renderer ──────────────────────────────────
// This type is consumed by src/hooks/useElectronBridge.ts
export type ElectronAPI = typeof electronAPI;
