// ============================================================================
// Zule AI — Auto-Update Service (Main Process)
// ============================================================================
//
// Stateful singleton wrapping `electron-updater`'s `autoUpdater` object.
// Maintains a finite state machine, throttles progress events, emits
// telemetry, and exposes the lifecycle to the renderer via callbacks that
// the IPC layer wires up.
//
// Design decisions:
//   - `autoDownload: false` — user must opt-in before bandwidth is consumed
//   - `autoInstallOnAppQuit: false` — deferred install is user-driven
//   - Dev mode short-circuit — no network calls when `!app.isPackaged`
//   - At most one background check per launch (`startupCheckDone` flag)
//   - Progress throttled to 1–10 events per second
//   - Telemetry emitted via callback (wired to TelemetryModule by IPC layer)
//
// Requirements: 1.1–1.6, 2.3, 2.5, 2.6, 5.3, 8.4, 9.1–9.6

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as semver from 'semver';

const require = createRequire(import.meta.url);
const { app } = require('electron') as typeof import('electron');

// ── Types ────────────────────────────────────────────────────────────────────

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing';

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
  status: UpdateStatus;
  availableVersion: string | null;
  currentVersion: string;
  releaseNotes: string | null;
  progress: DownloadProgress | null;
  error: UpdateError | null;
}

export interface ParsedManifest {
  version: string;
  filename: string;
  size: number;
  hash: string;
}

export type ParseManifestResult =
  | { ok: true; manifest: ParsedManifest }
  | { ok: false; reason: string };

/** Telemetry event kinds emitted by the auto-updater. */
export type UpdateTelemetryEvent =
  | { kind: 'update.checked'; currentVersion: string; trigger: 'startup' | 'manual' }
  | { kind: 'update.available'; currentVersion: string; availableVersion: string }
  | { kind: 'update.downloaded'; availableVersion: string; durationMs: number }
  | { kind: 'update.installed'; currentVersion: string }
  | { kind: 'update.error'; stage: 'check' | 'download' | 'integrity' | 'install'; category: string };

export type StateChangeListener = (state: UpdateState) => void;
export type TelemetryEmitter = (event: UpdateTelemetryEvent) => void;

/** Persisted state for deferred install across restarts. */
export interface PersistedUpdateState {
  deferredInstall: boolean;     // "Install on next quit" was chosen
  availableVersion: string;     // The version that was downloaded
  installerPath: string;        // Relative path to cached installer
  downloadedAt: number;         // Unix timestamp
}

// ── Pure Utility Functions (exported for testing) ────────────────────────────

/**
 * Returns true iff `availableVersion` is strictly greater than
 * `currentVersion` under SemVer 2.0.0 precedence rules, including
 * pre-release identifier comparison.
 *
 * Property 1: Semver comparison correctness
 * Validates: Requirements 1.6, 2.4, 4.9
 */
export function isCandidateUpdate(currentVersion: string, availableVersion: string): boolean {
  const current = semver.parse(currentVersion);
  const available = semver.parse(availableVersion);
  if (!current || !available) return false;
  return semver.gt(available, current);
}

/**
 * Parses a YAML-like manifest string (latest.yml format) and validates
 * that all four required fields are present and well-formed:
 *   - version: valid semver string
 *   - filename (path): non-empty string
 *   - size (fileSize): positive integer
 *   - hash (sha512): non-empty hex or base64 string
 *
 * Property 2: Manifest parsing completeness
 * Validates: Requirements 1.2, 1.3
 */
export function parseManifest(yamlString: string): ParseManifestResult {
  if (!yamlString || typeof yamlString !== 'string') {
    return { ok: false, reason: 'Empty or invalid input' };
  }

  // Simple YAML key-value parser for latest.yml format
  // electron-builder produces a flat YAML with top-level keys
  const lines = yamlString.split('\n');
  const fields: Record<string, string> = {};

  // Track nested file entries (latest.yml has `files:` array with `url`, `sha512`, `size`)
  let inFiles = false;
  let currentFileUrl = '';
  let currentFileSha512 = '';
  let currentFileSize = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Detect top-level key: value pairs
    const topMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (topMatch && !line.startsWith(' ') && !line.startsWith('\t')) {
      const [, key, value] = topMatch;
      if (key === 'files') {
        inFiles = true;
        continue;
      }
      inFiles = false;
      fields[key] = value.trim();
      continue;
    }

    // Inside files array (indented items)
    if (inFiles) {
      const itemMatch = trimmed.match(/^-?\s*(\w+):\s*(.+)$/);
      if (itemMatch) {
        const [, key, value] = itemMatch;
        if (key === 'url') currentFileUrl = value.trim();
        else if (key === 'sha512') currentFileSha512 = value.trim();
        else if (key === 'size') currentFileSize = value.trim();
      }
    }
  }

  // Extract version
  const version = fields['version'];
  if (!version || !semver.valid(version)) {
    return { ok: false, reason: 'Missing or invalid version field' };
  }

  // Extract filename — from `path` field or first file entry's `url`
  const filename = fields['path'] || currentFileUrl;
  if (!filename) {
    return { ok: false, reason: 'Missing filename/path field' };
  }

  // Extract size — from `size` field or file entry size
  const sizeStr = fields['size'] || currentFileSize;
  const size = parseInt(sizeStr, 10);
  if (!sizeStr || isNaN(size) || size <= 0 || !Number.isInteger(size)) {
    return { ok: false, reason: 'Missing or invalid size field' };
  }

  // Extract hash — from `sha512` field or file entry sha512
  const hash = fields['sha512'] || currentFileSha512;
  if (!hash || hash.length === 0) {
    return { ok: false, reason: 'Missing or invalid hash field' };
  }

  return {
    ok: true,
    manifest: { version, filename, size, hash },
  };
}

/**
 * Verifies integrity of downloaded installer bytes against expected
 * hash (SHA-512, base64) and expected size.
 *
 * Returns true iff both conditions hold:
 *   1. `bytes.length === expectedSize`
 *   2. `sha512(bytes) === expectedHash` (base64 comparison)
 *
 * Property 3: Integrity verification rejects invalid artefacts
 * Validates: Requirements 1.4, 1.5, 5.8, 8.3
 */
export function verifyIntegrity(
  bytes: Buffer | Uint8Array,
  expectedHash: string,
  expectedSize: number,
): boolean {
  // Size check
  if (bytes.length !== expectedSize) {
    return false;
  }

  // Hash check (SHA-512, base64-encoded — electron-builder default)
  const computedHash = crypto
    .createHash('sha512')
    .update(bytes)
    .digest('base64');

  return computedHash === expectedHash;
}

// ── Progress Throttle ────────────────────────────────────────────────────────

/**
 * Creates a progress throttle that ensures:
 * - At most 10 events per second (minimum 100ms between emissions)
 * - At least 1 event per second (forces emission after 1000ms of silence)
 *
 * Property 11: Progress throttle respects frequency bounds
 * Validates: Requirements 5.3, 10.7
 */
export interface ProgressThrottle {
  push(progress: DownloadProgress): void;
  flush(): void;
  reset(): void;
}

export function createProgressThrottle(
  onEmit: (progress: DownloadProgress) => void,
): ProgressThrottle {
  let lastEmitTime = 0;
  let pendingProgress: DownloadProgress | null = null;
  let guaranteeTimer: ReturnType<typeof setTimeout> | null = null;

  const MIN_INTERVAL_MS = 100;  // max 10 events/sec
  const MAX_SILENCE_MS = 1000;  // at least 1 event/sec

  function emit(progress: DownloadProgress): void {
    lastEmitTime = Date.now();
    pendingProgress = null;
    clearGuaranteeTimer();
    onEmit(progress);
  }

  function clearGuaranteeTimer(): void {
    if (guaranteeTimer !== null) {
      clearTimeout(guaranteeTimer);
      guaranteeTimer = null;
    }
  }

  function scheduleGuaranteeTimer(): void {
    clearGuaranteeTimer();
    guaranteeTimer = setTimeout(() => {
      if (pendingProgress) {
        emit(pendingProgress);
      }
    }, MAX_SILENCE_MS);
  }

  return {
    push(progress: DownloadProgress): void {
      const now = Date.now();
      const elapsed = now - lastEmitTime;

      if (elapsed >= MIN_INTERVAL_MS) {
        // Enough time has passed — emit immediately
        emit(progress);
      } else {
        // Too soon — buffer and schedule guarantee timer
        pendingProgress = progress;
        if (guaranteeTimer === null) {
          scheduleGuaranteeTimer();
        }
      }
    },

    flush(): void {
      if (pendingProgress) {
        emit(pendingProgress);
      }
      clearGuaranteeTimer();
    },

    reset(): void {
      lastEmitTime = 0;
      pendingProgress = null;
      clearGuaranteeTimer();
    },
  };
}

// ── Auto-Update Service Class ────────────────────────────────────────────────

export class AutoUpdateService {
  private state: UpdateState;
  private listeners: Set<StateChangeListener> = new Set();
  private telemetryEmitter: TelemetryEmitter | null = null;
  private progressThrottle: ProgressThrottle;
  private downloadStartTime: number = 0;

  /** At most one background check per launch */
  private startupCheckDone: boolean = false;

  /** "Install on next quit" flag */
  public deferredInstall: boolean = false;

  /** Whether app.isPackaged (false in dev mode) */
  private readonly isPackaged: boolean;

  /** Path to the userData directory for persistence */
  private readonly userDataPath: string;

  /** Reference to electron-updater's autoUpdater (null in dev mode) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private autoUpdater: any = null;

  constructor() {
    this.isPackaged = app.isPackaged;
    this.userDataPath = app.getPath('userData');

    this.state = {
      status: 'idle',
      availableVersion: null,
      currentVersion: app.getVersion(),
      releaseNotes: null,
      progress: null,
      error: null,
    };

    this.progressThrottle = createProgressThrottle((progress) => {
      this.state = { ...this.state, progress };
      this.broadcast();
    });

    // On cold start, check persisted state for successful install detection
    this.loadPersistedState();

    // Only wire up electron-updater in packaged builds
    if (this.isPackaged) {
      this.initAutoUpdater();
    }
  }

  // ── Initialization ─────────────────────────────────────────────────────

  private initAutoUpdater(): void {
    try {
      // electron-updater is a CJS module
      const { autoUpdater } = require('electron-updater');
      this.autoUpdater = autoUpdater;

      // Configure: user-driven flow
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;

      // Wire up events
      autoUpdater.on('error', (err: Error) => {
        this.handleError(err);
      });

      autoUpdater.on('checking-for-update', () => {
        // State already set by checkForUpdate()
      });

      autoUpdater.on('update-available', (info: { version: string; releaseNotes?: string }) => {
        const availableVersion = info.version;

        if (!isCandidateUpdate(this.state.currentVersion, availableVersion)) {
          // Not actually newer — treat as "no update"
          this.transitionTo('idle');
          return;
        }

        this.state = {
          ...this.state,
          status: 'available',
          availableVersion,
          releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
          progress: null,
          error: null,
        };
        this.broadcast();

        this.emitTelemetry({
          kind: 'update.available',
          currentVersion: this.state.currentVersion,
          availableVersion,
        });
      });

      autoUpdater.on('update-not-available', () => {
        this.transitionTo('idle');
      });

      autoUpdater.on('download-progress', (progress: { percent: number; transferred: number; total: number }) => {
        const dp: DownloadProgress = {
          percent: Math.round(Math.min(100, Math.max(0, progress.percent))),
          bytesReceived: progress.transferred,
          totalBytes: progress.total,
        };
        this.progressThrottle.push(dp);
      });

      autoUpdater.on('update-downloaded', () => {
        this.progressThrottle.flush();
        const durationMs = this.downloadStartTime > 0
          ? Date.now() - this.downloadStartTime
          : 0;

        this.state = {
          ...this.state,
          status: 'ready',
          progress: null,
          error: null,
        };
        this.broadcast();

        if (this.state.availableVersion) {
          this.emitTelemetry({
            kind: 'update.downloaded',
            availableVersion: this.state.availableVersion,
            durationMs,
          });
        }
      });
    } catch (err) {
      console.warn(
        `[autoUpdateService] Failed to initialize electron-updater: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ── State Management ───────────────────────────────────────────────────

  private transitionTo(status: UpdateStatus): void {
    this.state = {
      ...this.state,
      status,
      progress: status === 'idle' ? null : this.state.progress,
      error: status === 'idle' ? null : this.state.error,
    };
    this.broadcast();
  }

  private broadcast(): void {
    const snapshot = { ...this.state };
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Listener errors must not break the service
      }
    }
  }

  private handleError(err: Error): void {
    const previousStatus = this.state.status;
    const stage = this.inferErrorStage(previousStatus);
    const category = this.inferErrorCategory(err);

    const error: UpdateError = { stage, category };

    // Errors transition back to the previous actionable state:
    // - checking → idle
    // - downloading → available
    const recoveryStatus: UpdateStatus =
      previousStatus === 'downloading' ? 'available' : 'idle';

    this.state = {
      ...this.state,
      status: recoveryStatus,
      error,
      progress: null,
    };
    this.progressThrottle.reset();
    this.broadcast();

    this.emitTelemetry({
      kind: 'update.error',
      stage,
      category,
    });
  }

  private inferErrorStage(status: UpdateStatus): UpdateError['stage'] {
    switch (status) {
      case 'checking': return 'check';
      case 'downloading': return 'download';
      case 'ready':
      case 'installing': return 'install';
      default: return 'check';
    }
  }

  private inferErrorCategory(err: Error): UpdateError['category'] {
    const msg = err.message.toLowerCase();
    if (msg.includes('enotfound') || msg.includes('econnrefused') || msg.includes('unreachable')) {
      return 'unreachable';
    }
    if (msg.includes('timeout') || msg.includes('etimedout')) {
      return 'timeout';
    }
    if (msg.includes('5') && (msg.includes('http') || msg.includes('server'))) {
      return 'server-error';
    }
    if (msg.includes('enospc') || msg.includes('no space') || msg.includes('storage')) {
      return 'storage';
    }
    if (msg.includes('integrity') || msg.includes('hash') || msg.includes('checksum')) {
      return 'integrity';
    }
    return 'network';
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /** Get the current update state snapshot. */
  getState(): UpdateState {
    return { ...this.state };
  }

  /** Register a state-change listener. Returns an unsubscribe function. */
  onStateChange(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Set the telemetry emitter callback. */
  setTelemetryEmitter(emitter: TelemetryEmitter): void {
    this.telemetryEmitter = emitter;
  }

  /**
   * Check for updates. In dev mode, short-circuits to idle.
   * For startup checks, ensures at most one per launch.
   */
  async checkForUpdate(trigger: 'startup' | 'manual' = 'manual'): Promise<UpdateState> {
    // Dev mode short-circuit (Requirement 2.6)
    if (!this.isPackaged) {
      return this.getState();
    }

    // At most one background check per launch (Requirement 2.3)
    if (trigger === 'startup' && this.startupCheckDone) {
      return this.getState();
    }

    if (trigger === 'startup') {
      this.startupCheckDone = true;
    }

    // Cannot check while already in a non-idle state (except idle or available)
    if (this.state.status !== 'idle' && this.state.status !== 'available') {
      return this.getState();
    }

    this.transitionTo('checking');

    this.emitTelemetry({
      kind: 'update.checked',
      currentVersion: this.state.currentVersion,
      trigger,
    });

    try {
      if (this.autoUpdater) {
        await this.autoUpdater.checkForUpdates();
      }
    } catch (err) {
      this.handleError(err instanceof Error ? err : new Error(String(err)));
    }

    return this.getState();
  }

  /**
   * Start downloading the available update.
   * Only valid when status is 'available'.
   */
  async downloadUpdate(): Promise<void> {
    if (!this.isPackaged || !this.autoUpdater) return;
    if (this.state.status !== 'available') {
      throw new Error('No update available to download');
    }

    this.downloadStartTime = Date.now();
    this.progressThrottle.reset();
    this.transitionTo('downloading');

    try {
      await this.autoUpdater.downloadUpdate();
    } catch (err) {
      this.handleError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Cancel an in-progress download.
   * Returns the state to 'available'.
   */
  async cancelDownload(): Promise<void> {
    if (!this.isPackaged) return;
    if (this.state.status !== 'downloading') {
      throw new Error('No download in progress');
    }

    try {
      // electron-updater exposes cancellationToken on the download promise
      if (this.autoUpdater?.cancellationToken) {
        this.autoUpdater.cancellationToken.cancel();
      }
    } catch {
      // Best effort
    }

    this.progressThrottle.reset();
    this.state = {
      ...this.state,
      status: 'available',
      progress: null,
      error: null,
    };
    this.broadcast();
  }

  /**
   * Quit and install the downloaded update.
   * Only valid when status is 'ready'.
   */
  async installUpdate(): Promise<void> {
    if (!this.isPackaged || !this.autoUpdater) return;
    if (this.state.status !== 'ready') {
      throw new Error('No update ready to install');
    }

    this.transitionTo('installing');

    this.emitTelemetry({
      kind: 'update.installed',
      currentVersion: this.state.currentVersion,
    });

    try {
      // isSilent = true, isForceRunAfter = true
      this.autoUpdater.quitAndInstall(true, true);
    } catch (err) {
      this.handleError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Defer installation to next quit.
   * Sets the deferredInstall flag and persists state for cross-restart survival.
   */
  deferInstall(): void {
    if (this.state.status !== 'ready') return;
    this.deferredInstall = true;
    this.persistState();
    // Transition to idle so the banner hides
    this.transitionTo('idle');
  }

  /**
   * Called on app.before-quit when quit is user-initiated.
   * If deferredInstall is set (in-memory flag from current session),
   * launches installer.
   * Only acts on user-initiated quit — not on crash/abnormal termination.
   * The in-memory flag is NOT restored from persisted state on cold start,
   * so a crash followed by a quit won't auto-install. (Requirement 6.6)
   * Requirements: 6.4, 6.6
   */
  handleBeforeQuit(): void {
    if (!this.isPackaged || !this.autoUpdater) return;

    // Only honor the in-memory flag set during this session's deferInstall()
    if (this.deferredInstall) {
      try {
        this.autoUpdater.quitAndInstall(true, true);
      } catch {
        // Best effort — app is quitting anyway
      }
    }
  }

  /**
   * Abort any in-progress download (called during shutdown).
   * Must complete within 2 seconds.
   */
  abortDownload(): void {
    if (this.state.status === 'downloading') {
      try {
        if (this.autoUpdater?.cancellationToken) {
          this.autoUpdater.cancellationToken.cancel();
        }
      } catch {
        // Best effort
      }
      this.progressThrottle.reset();
    }
  }

  // ── Persistence ────────────────────────────────────────────────────────

  /** File name for persisted update state. */
  private static readonly STATE_FILE = 'update-state.json';

  /**
   * Write the deferred-install state to disk.
   * Called when the user chooses "Install on next quit".
   * Requirements: 6.3, 6.4
   */
  persistState(): void {
    const filePath = path.join(this.userDataPath, AutoUpdateService.STATE_FILE);
    const data: PersistedUpdateState = {
      deferredInstall: true,
      availableVersion: this.state.availableVersion ?? '',
      installerPath: '', // Relative path — electron-updater manages the cache
      downloadedAt: Date.now(),
    };
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn(
        `[autoUpdateService] Failed to persist update state: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Read persisted state on cold start.
   * If currentVersion matches the availableVersion from the file,
   * the install succeeded — emit telemetry and clear the file.
   * If versions don't match (abnormal termination or not yet installed),
   * preserve the file but do NOT auto-launch the installer.
   * Requirements: 6.6, 9.4
   */
  loadPersistedState(): void {
    const filePath = path.join(this.userDataPath, AutoUpdateService.STATE_FILE);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const persisted: PersistedUpdateState = JSON.parse(raw);

      if (
        persisted &&
        persisted.deferredInstall &&
        persisted.availableVersion &&
        persisted.availableVersion === this.state.currentVersion
      ) {
        // The install succeeded — current version matches the version we downloaded.
        // Emit telemetry and clear the file.
        this.emitTelemetry({
          kind: 'update.installed',
          currentVersion: this.state.currentVersion,
        });
        this.clearPersistedState();
      }
      // If versions don't match, we do NOT set deferredInstall.
      // The file persists (installer preserved) but is not auto-launched
      // on next quit — safe against abnormal termination. (Requirement 6.6)
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        // No persisted state — normal case on first launch or after cleanup
        return;
      }
      // Corrupt file or other read error — treat as no persisted state
      console.warn(
        `[autoUpdateService] Failed to read persisted state: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Delete the persisted state file after a successful install
   * (version comparison confirmed the install happened).
   * Requirements: 9.4
   */
  clearPersistedState(): void {
    const filePath = path.join(this.userDataPath, AutoUpdateService.STATE_FILE);
    try {
      fs.unlinkSync(filePath);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        // Already gone — not an error
        return;
      }
      console.warn(
        `[autoUpdateService] Failed to clear persisted state: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ── Telemetry ──────────────────────────────────────────────────────────

  private emitTelemetry(event: UpdateTelemetryEvent): void {
    if (this.telemetryEmitter) {
      try {
        this.telemetryEmitter(event);
      } catch {
        // Telemetry must never break the update flow
      }
    }
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

// ── Singleton ────────────────────────────────────────────────────────────────

let serviceInstance: AutoUpdateService | null = null;

/**
 * Get or create the singleton AutoUpdateService instance.
 * Lazy-initialized to keep it off the synchronous startup path (Req 8.4).
 */
export function getAutoUpdateService(): AutoUpdateService {
  if (!serviceInstance) {
    serviceInstance = new AutoUpdateService();
  }
  return serviceInstance;
}

/**
 * Reset the singleton (for testing purposes only).
 */
export function resetAutoUpdateService(): void {
  serviceInstance = null;
}
