// ============================================
// Zule AI — Electron Preload Script
// ============================================
//
// Exposes a secure API bridge from the main process to the renderer
// via contextBridge. This is the ONLY way the React app communicates
// with Electron APIs (no nodeIntegration, full contextIsolation).

import { contextBridge, ipcRenderer } from 'electron';
import type { IndexedItem, QueryHit } from '../src/types/vectorIndex';

// ── Type-safe API exposed to the renderer (Main Window Only) ───────────────

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

  // ── External URLs & Window Focus ──────────────────────────────────────────

  /** Open a URL in the system browser (used for payment checkout). */
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('open-external', url),

  /** Bring the Electron main window back to the foreground. */
  focusWindow: (): Promise<void> =>
    ipcRenderer.invoke('focus-window'),

  /** Request overlay focus for keyboard input (e.g. when an input is tapped).
   *  On Windows this installs a low-level keyboard hook to forward keystrokes
   *  without activating the overlay window (no focus loss for the fg app). */
  requestOverlayFocus: (): void =>
    ipcRenderer.send('overlay-request-focus'),

  /** Signal that the overlay input has been blurred. Uninstalls the keyboard
   *  hook so keystrokes flow normally to the foreground application again. */
  blurOverlay: (): void =>
    ipcRenderer.send('overlay-blur'),

  /** Listen for keystrokes forwarded from the low-level keyboard hook.
   *  Returns an unsubscribe function. */
  onOverlayKey: (callback: (key: { type: string; char?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, key: { type: string; char?: string }) =>
      callback(key);
    ipcRenderer.on('overlay-key', handler);
    return () => ipcRenderer.removeListener('overlay-key', handler);
  },

  /** Capture the desktop using BitBlt. Returns `ok: false` with
   *  `reason: 'capture-protected'` when the foreground window has display affinity
   *  set — this path cannot see through it, so it declines rather than returning a
   *  frame of the window behind. */
  captureDesktopBitBlt: (): Promise<{
    ok: boolean;
    base64?: string;
    reason?: string;
    bytes?: number;
    width?: number;
    height?: number;
  }> => ipcRenderer.invoke('capture-desktop-bitblt'),

  /** Extract text from the foreground window using Windows UI Automation
   *  (accessibility API). Bypasses display affinity — reads the UI tree directly. */
  extractForegroundText: (): Promise<{ ok: boolean; text?: string; reason?: string }> =>
    ipcRenderer.invoke('extract-foreground-text'),

  // ── Secure Storage (OS-backed encryption for provider API keys) ──────────

  /** Whether OS-level key encryption (safeStorage) is available on this machine. */
  secureStorageIsAvailable: (): Promise<boolean> =>
    ipcRenderer.invoke('secureStorage:isAvailable'),

  /** Encrypt a string via the OS credential store; returns a base64 blob. */
  secureStorageEncrypt: (plaintext: string): Promise<string> =>
    ipcRenderer.invoke('secureStorage:encrypt', plaintext),

  /** Decrypt a base64 blob previously produced by secureStorageEncrypt. */
  secureStorageDecrypt: (ciphertext: string): Promise<string> =>
    ipcRenderer.invoke('secureStorage:decrypt', ciphertext),

  // ── Authentication ────────────────────────────────────────────────────────

  /** Opens the default system browser to securely log in via Google OAuth. Returns the Google idToken. */
  loginViaBrowser: (): Promise<string> => ipcRenderer.invoke('login-via-browser'),

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

  // ── Local Whisper transcription (native, main-process) ───────────────────
  // System-audio inference runs in the main process via onnxruntime-node (the
  // renderer's WASM/WebGPU engine crashes — 0xC0000005). The renderer captures
  // 16 kHz mono Float32 PCM and ships chunks here.

  /** Pre-warm the Whisper model (call when the user enables system audio). */
  whisperPreload: (opts?: {
    pipeline?: 'loopback' | 'microphone' | string;
    modelId?: string;
  }): Promise<boolean> => ipcRenderer.invoke('whisper:preload', opts),

  /** Transcribe one PCM chunk; returns the recognised text and latency metrics. */
  whisperTranscribe: (
    pcm: Float32Array,
    opts?: {
      language?: string;
      modelId?: string;
      kind?: 'final' | 'partial';
      seq?: number;
      pipeline?: 'loopback' | 'microphone';
    },
  ): Promise<{ text: string; queueMs?: number; inferMs?: number }> =>
    ipcRenderer.invoke('whisper:transcribe', pcm, opts),

  /** Release the Whisper model/session (call when system audio is disabled). */
  whisperRelease: (opts?: {
    pipeline?: 'loopback' | 'microphone' | string;
  }): Promise<boolean> => ipcRenderer.invoke('whisper:release', opts),

  // ── Local text embeddings (native, main-process) ─────────────────────────
  // The embedding model also runs in the main process (renderer onnxruntime-web
  // crashes — 0xC0000005). vectorStore delegates inference here.

  /** Pre-warm the embedding model. */
  embedPreload: (opts?: { modelId?: string }): Promise<boolean> =>
    ipcRenderer.invoke('embed:preload', opts),

  /** Generate a normalized embedding for `text`; returns the vector. */
  embedGenerate: (
    text: string,
    opts?: { modelId?: string },
  ): Promise<{ vector: number[] }> =>
    ipcRenderer.invoke('embed:generate', text, opts),

  /**
   * Generate normalized embeddings for a batch of texts in a single IPC.
   * Output length equals `texts.length`; whitespace-only or empty entries
   * receive a zero-length vector at their original position. Falls through
   * to the existing single-text extractor inside the main-process chain so
   * the native session is never re-entered concurrently.
   */
  embedGenerateBatch: (
    texts: string[],
    opts?: { modelId?: string },
  ): Promise<{ vectors: number[][] }> =>
    ipcRenderer.invoke('embed:generateBatch', texts, opts),

  // ── Vector_Index (HNSW, native, main-process) ────────────────────────────
  // The HNSW graph lives in the main process beside the embedding model so
  // upload-time inserts skip an extra IPC trip. The renderer is a thin
  // client that ships Float32 `number[]` vectors and id strings; the
  // service owns label assignment, deletion via `markDelete`, and
  // snapshot persistence under `<userData>/vector-index.bin`.

  /**
   * Rebuild the entire Vector_Index from a fresh enumeration of every
   * Knowledge_Base chunk. Called on cold start whenever the snapshot is
   * missing or corrupt.
   */
  vectorIndexRebuild: (items: IndexedItem[], dim: number): Promise<boolean> =>
    ipcRenderer.invoke('vectorIndex:rebuild', items, dim),

  /** Insert (or upsert) a batch of chunk embeddings into the index. */
  vectorIndexAddBatch: (items: IndexedItem[]): Promise<boolean> =>
    ipcRenderer.invoke('vectorIndex:addBatch', items),

  /** Mark a chunk as deleted so it stops appearing in query results. */
  vectorIndexRemove: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('vectorIndex:remove', id),

  /**
   * Query the index for the top-`k` nearest chunks to `vector`. Returns at
   * most `min(k, n)` hits in non-increasing score order. Returns `[]` and
   * emits a typed `vector-index.query-invalid` diagnostic when `k <= 0`
   * or `vector.length` mismatches the index dimension.
   */
  vectorIndexQuery: (vector: number[], k: number): Promise<QueryHit[]> =>
    ipcRenderer.invoke('vectorIndex:query', vector, k),

  /** Force a synchronous flush of the in-memory index to disk. */
  vectorIndexFlush: (): Promise<boolean> =>
    ipcRenderer.invoke('vectorIndex:flush'),

  /**
   * Cold-start hydration probe. Runs `preloadVectorIndex` on the main side
   * and returns the live in-memory state. The renderer uses the returned
   * `count` to decide whether to follow up with `vectorIndex:rebuild` from
   * the IndexedDB chunks (Requirements 3.1, 3.2): a `count` of `0` paired
   * with a non-empty Knowledge_Base means the persisted snapshot was
   * missing or corrupt and a rebuild is required.
   */
  vectorIndexHydrate: (): Promise<{ count: number; dim: number }> =>
    ipcRenderer.invoke('vectorIndex:hydrate'),

  // ── Auto-Updater ─────────────────────────────────────────────────────────

  /** Trigger a manual update check; resolves with the resulting state. */
  checkForUpdate: (): Promise<unknown> =>
    ipcRenderer.invoke('update:check'),

  /** Start downloading the installer for a previously identified candidate version. */
  downloadUpdate: (): Promise<void> =>
    ipcRenderer.invoke('update:download'),

  /** Cancel an installer download that is currently in progress. */
  cancelDownload: (): Promise<void> =>
    ipcRenderer.invoke('update:cancel'),

  /** Trigger "restart and install" of the downloaded installer. */
  installUpdate: (): Promise<void> =>
    ipcRenderer.invoke('update:install'),

  /** Defer installation to the next user-initiated application exit. */
  deferInstall: (): Promise<void> =>
    ipcRenderer.invoke('update:defer'),

  /** Subscribe to Auto_Updater state transitions. Returns an unsubscribe function. */
  onUpdateState: (callback: (state: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) =>
      callback(state);
    ipcRenderer.on('update:state', handler);
    return () => ipcRenderer.removeListener('update:state', handler);
  },

  // ── Phone Camera Input (LAN server) ───────────────────────────────────────

  /** Start the local phone camera HTTP server and get connection info with QR URL. */
  startPhoneServer: (): Promise<{ port: number; localIp: string; qrUrl: string }> =>
    ipcRenderer.invoke('phone-server-start'),

  /** Stop the local phone camera HTTP server. */
  stopPhoneServer: (): Promise<void> =>
    ipcRenderer.invoke('phone-server-stop'),

  /** Listen for photos sent from the phone browser. */
  onPhoneImage: (
    callback: (data: { base64: string; mimeType: string }) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { base64: string; mimeType: string },
    ) => callback(data);
    ipcRenderer.on('phone-image-received', handler);
    return () => ipcRenderer.removeListener('phone-image-received', handler);
  },

  /** Stream AI-generated answer to connected phone(s). */
  sendAnswerToPhone: (data: {
    id?: string;
    text: string;
    question?: string;
    mode?: string;
    model?: string;
    timestamp?: number;
  }): Promise<{ sent: number; seq: number }> =>
    ipcRenderer.invoke('phone-send-answer', data),
};

// Expose the API to the renderer's window object
contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// ── TypeScript declaration for the renderer ──────────────────────────────────
// This type is consumed by src/hooks/useElectronBridge.ts
export type ElectronAPI = typeof electronAPI;
