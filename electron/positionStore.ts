// ============================================
// Zule AI — Position Store
// ============================================
//
// Persists overlay window bounds per display to a JSON file in userData.
// Handles missing/corrupt files gracefully and debounces writes.

import fs from 'node:fs';
import path from 'node:path';

// ── Interfaces ───────────────────────────────────────────────────────────────

export interface PersistedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  mode: 'compact' | 'expanded';
  alwaysOnTop: boolean;
  contentProtection: boolean;
}

export interface PositionStoreData {
  version: 1;
  displays: Record<string, PersistedBounds>;
}

/** Error indication emitted when persistence fails. */
export interface PersistenceError {
  code: 'PERSIST_FAILED';
  message: string;
}

// ── Default Data ─────────────────────────────────────────────────────────────

function createDefaultData(): PositionStoreData {
  return { version: 1, displays: {} };
}

// ── PositionStore Class ──────────────────────────────────────────────────────

const FLUSH_DEBOUNCE_MS = 500;

export class PositionStore {
  private filePath: string;
  private data: PositionStoreData;
  private dirty: boolean = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastError: PersistenceError | null = null;

  /** Optional error callback — notified on I/O failure. */
  onError: ((error: PersistenceError) => void) | null = null;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, 'overlay-positions.json');
    this.data = createDefaultData();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Load from disk. Returns default if file missing or corrupt.
   * Safe to call multiple times — always replaces in-memory data.
   */
  load(): PositionStoreData {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);

      if (this.isValidStoreData(parsed)) {
        this.data = parsed;
      } else {
        // File exists but structure is invalid — treat as corrupt
        console.warn(
          `[PositionStore] Invalid data structure in ${this.filePath}, using defaults`
        );
        this.data = createDefaultData();
        this.dirty = true; // Will overwrite corrupt file on next flush
      }
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        // File missing — expected on first run
        this.data = createDefaultData();
      } else if (err instanceof SyntaxError) {
        // Invalid JSON — corrupt file
        console.warn(
          `[PositionStore] Corrupt JSON in ${this.filePath}, using defaults`
        );
        this.data = createDefaultData();
        this.dirty = true; // Overwrite on next flush
      } else {
        // Other read errors (permissions, etc.)
        console.warn(
          `[PositionStore] Failed to read ${this.filePath}:`,
          err
        );
        this.data = createDefaultData();
      }
    }

    return this.data;
  }

  /** Get bounds for a specific display. */
  get(displayId: string): PersistedBounds | undefined {
    return this.data.displays[displayId];
  }

  /** Set bounds for a display and schedule a debounced write. */
  set(displayId: string, bounds: PersistedBounds): void {
    this.data.displays[displayId] = bounds;
    this.dirty = true;
    this.scheduleFlush();
  }

  /** Flush pending writes to disk. No-op if not dirty. */
  async flush(): Promise<void> {
    this.cancelScheduledFlush();

    if (!this.dirty) {
      return;
    }

    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const json = JSON.stringify(this.data, null, 2);
      fs.writeFileSync(this.filePath, json, 'utf-8');
      this.dirty = false;
      this.lastError = null;
    } catch (err: unknown) {
      // Retain in-memory state, emit error, will retry on next flush
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[PositionStore] Write failed: ${message}`);

      this.lastError = {
        code: 'PERSIST_FAILED',
        message: `Failed to write position store: ${message}`,
      };

      if (this.onError) {
        this.onError(this.lastError);
      }
    }
  }

  /** Remove entry for a display. */
  remove(displayId: string): void {
    if (displayId in this.data.displays) {
      delete this.data.displays[displayId];
      this.dirty = true;
      this.scheduleFlush();
    }
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  /** Whether there are unsaved changes. */
  get isDirty(): boolean {
    return this.dirty;
  }

  /** The last persistence error, if any. */
  get error(): PersistenceError | null {
    return this.lastError;
  }

  /** The full store data (read-only snapshot). */
  get storeData(): PositionStoreData {
    return this.data;
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.flushTimer !== null) {
      return; // Already scheduled
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private cancelScheduledFlush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private isValidStoreData(data: unknown): data is PositionStoreData {
    if (typeof data !== 'object' || data === null) return false;
    const obj = data as Record<string, unknown>;
    if (obj.version !== 1) return false;
    if (typeof obj.displays !== 'object' || obj.displays === null) return false;
    return true;
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
