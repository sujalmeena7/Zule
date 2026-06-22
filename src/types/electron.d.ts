// ============================================
// Zule AI — Electron API Type Declaration
// ============================================
//
// Augments the global Window interface with the electronAPI
// exposed by the preload script via contextBridge.
// This enables typed access from React hooks without
// importing Electron types directly into the renderer.

import type { IndexedItem, QueryHit } from './vectorIndex';

// ---- Auto-Updater Types ----

export interface DownloadProgress {
  percent: number;       // [0, 100]
  bytesReceived: number;
  totalBytes: number;
}

export interface UpdateError {
  stage: 'check' | 'download' | 'integrity' | 'install';
  category: 'unreachable' | 'timeout' | 'server-error' | 'network' | 'storage' | 'integrity';
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing';
  availableVersion: string | null;
  currentVersion: string;
  releaseNotes: string | null;
  progress: DownloadProgress | null;
  error: UpdateError | null;
}

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

  // Local Whisper transcription (native, main-process)
  whisperPreload?: (opts?: { modelId?: string }) => Promise<boolean>;
  whisperTranscribe?: (
    pcm: Float32Array,
    opts?: { language?: string; modelId?: string },
  ) => Promise<{ text: string }>;
  whisperRelease?: () => Promise<boolean>;

  // Local text embeddings (native, main-process)
  embedPreload?: (opts?: { modelId?: string }) => Promise<boolean>;
  embedGenerate?: (
    text: string,
    opts?: { modelId?: string },
  ) => Promise<{ vector: number[] }>;
  embedGenerateBatch?: (
    texts: string[],
    opts?: { modelId?: string },
  ) => Promise<{ vectors: number[][] }>;

  // Vector_Index (HNSW, native, main-process)
  vectorIndexRebuild?: (items: IndexedItem[], dim: number) => Promise<boolean>;
  vectorIndexAddBatch?: (items: IndexedItem[]) => Promise<boolean>;
  vectorIndexRemove?: (id: string) => Promise<boolean>;
  vectorIndexQuery?: (vector: number[], k: number) => Promise<QueryHit[]>;
  vectorIndexFlush?: () => Promise<boolean>;
  vectorIndexHydrate?: () => Promise<{ count: number; dim: number }>;

  // Auto-Updater (IPC Bridge)
  checkForUpdate?: () => Promise<UpdateState>;
  downloadUpdate?: () => Promise<void>;
  cancelDownload?: () => Promise<void>;
  installUpdate?: () => Promise<void>;
  deferInstall?: () => Promise<void>;
  onUpdateState?: (cb: (state: UpdateState) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
