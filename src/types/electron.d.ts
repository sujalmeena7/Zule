// ============================================
// Zule AI — Electron API Type Declaration
// ============================================
//
// Augments the global Window interface with the electronAPI
// exposed by the preload script via contextBridge.
// This enables typed access from React hooks without
// importing Electron types directly into the renderer.

export interface ElectronAPI {
  platform: 'win32' | 'darwin' | 'linux';
  isElectron: true;

  // Content Protection (Phase 2)
  setContentProtection: (enabled: boolean) => Promise<boolean>;

  // Unified stealth toggle (both windows)
  toggleVisibilityProtection: (enabled: boolean) => Promise<boolean>;

  // Dual-Mode Overlay Transition
  switchToOverlay: () => Promise<boolean>;

  // Window Control
  setAlwaysOnTop: (enabled: boolean) => Promise<boolean>;
  setIgnoreMouseEvents: (ignore: boolean, options?: { forward?: boolean }) => Promise<void>;
  startOverlay: () => Promise<boolean>;
  stopOverlay: () => Promise<boolean>;
  toggleOverlay: () => Promise<boolean>;
  resizeOverlay: (width: number, height: number) => Promise<boolean>;
  moveOverlay: (x: number, y: number) => Promise<boolean>;
  getOverlayBounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>;

  // IPC Communication (Phase 3)
  sendSyncMessage: (message: unknown) => void;
  onSyncMessage: (callback: (message: unknown) => void) => () => void;

  // Error Notifications
  onOverlayError: (callback: (error: { code: string; message: string }) => void) => () => void;

  // Global Shortcuts (Phase 3)
  onGlobalShortcut: (callback: (shortcutId: string) => void) => () => void;

  // Authentication
  loginViaBrowser?: () => Promise<string>;

  // Native Screen Capture (Phase 3)
  getDesktopSources: () => Promise<
    Array<{
      id: string;
      name: string;
      thumbnail: string;
    }>
  >;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
