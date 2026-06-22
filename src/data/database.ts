// ============================================
// Zule AI — Unified Database Layer (zule-unified, v4)
// ============================================
//
// Single IndexedDB database for the whole application.
//
// Schema (v4):
//   meetings        keyPath: 'id'        idx: startedAt, mode
//   settings        keyPath: 'key'
//   documents       keyPath: 'id'        idx: type, createdAt
//   custom_modes    keyPath: 'id'
//   memory_facts    keyPath: 'id'        idx: meetingId (multiEntry), createdAt
//   telemetry       keyPath: 'id'        idx: at, kind
//   response_cache  keyPath: 'id'        idx: lastUsedAt
//   ratings         keyPath: 'id'        idx: providerId, modelId, createdAt
//   style_profile   keyPath: 'id'
//
// Acceptance criteria covered:
//   - 16.1 — Single `zule-unified` database; legacy `zule-store` removed
//     after a one-time copy on first run at v4.
//   - 16.2 — `onupgradeneeded` runs an idempotent migration sequence
//     covering every previous version (v0/v1/v2/v3 → v4) and the
//     post-open migration (legacy copy + plaintext-key re-encode hook)
//     is safe to run multiple times.
//   - Design §"Migration plan" — the v3→v4 step adds new stores,
//     copies legacy zule-store rows, and re-encodes plaintext API keys
//     as `providers[].apiKeyCipher` after passphrase prompt.
//
// Notes on the apiKey re-encode (Requirement 15.1):
//   The re-encode step needs an unlocked `CryptoVault`, which in turn
//   needs a passphrase prompt — i.e. a user interaction. Doing it
//   inline in `openDB()` would either block the app on first paint or
//   silently skip the security uplift. Instead, the code path is
//   exposed as `migrateApiKeyToProviderCipher(vault)` so the orchestrator
//   can call it on first vault unlock. Until the user unlocks, the
//   plaintext `apiKey` setting remains readable for backwards
//   compatibility with the parts of the codebase that have not yet
//   migrated to `providers[].apiKeyCipher`.

import type { CryptoVault } from '../utils/cryptoVault';
import type { ZuleError } from '../types/errors';
import type { QuantizedVector } from '../brain/vectorMath';
import {
  applyRetention,
  diffRetention,
  DEFAULT_MEETING_MAX_AGE_DAYS,
  DEFAULT_TRANSCRIPT_MAX_LINES,
  type RetentionOptions,
} from './retention';
import {
  applyKBRetention,
  diffKBRetention,
  DEFAULT_KB_RETENTION_CAP,
} from './kbRetention';
import {
  searchChunks,
  DEFAULT_MAX_RESULTS,
  DEFAULT_SIMILARITY_THRESHOLD,
  type KBSearchOptions,
} from './kbSearch';

// --- Interfaces ---

export interface StoredMeeting {
  id: string;
  title: string;
  mode: string;
  startedAt: number;
  endedAt: number;
  duration: number;
  transcript: Array<{ id: string; text: string; timestamp: number; speaker: string; speakerRole?: string; asrConfidence?: number; language?: string; detection?: string; provider?: string }>;
  summary: string;
  /** Tracks summary generation lifecycle (Requirement 27.3). */
  aiSummaryStatus?: 'pending' | 'ok' | 'failed';
  actionItems: Array<{ id: string; text: string; completed: boolean; sourceQuote?: string; sourceLineId?: string; timestamp?: number }>;
  aiSuggestionCount: number;
  fillerCount: number;
  avgConfidence: number;
  wordsPerMinute: number;
  followUpEmail?: string;
  keyFacts?: string[];
}

/**
 * A single Knowledge_Base chunk. Either:
 *   - `vector` is a `number[]` containing the full-precision Float32
 *     embedding (the original / pre-task-5.2 format), or
 *   - `vectorQ` is the int8-quantized form with per-vector min/max
 *     metadata, persisted once the total stored chunk count crosses
 *     `QUANTIZATION_THRESHOLD` (Requirement 6.4).
 *
 * Exactly one of `vector` / `vectorQ` is populated for any chunk
 * `database.addDocument` produces; consumers must defend against legacy
 * rows where `vector` was the only field by treating `vectorQ` as
 * optional. The runtime invariant is enforced by `addDocument`, the
 * search path, and the import validator (`exportImport.ts`).
 */
export interface KBChunk {
  text: string;
  /** Full-precision embedding; absent on quantized rows. */
  vector?: number[];
  /** Int8-quantized embedding; absent on raw rows. */
  vectorQ?: QuantizedVector;
}

export interface KBDocument {
  id: string;
  title: string;
  content: string;
  type: 'resume' | 'project' | 'job-description' | 'notes' | 'sales-script' | 'custom';
  chunks: KBChunk[];
  createdAt: number;
}

export interface CustomMode {
  id: string;
  label: string;
  icon: string;
  description: string;
  systemPrompt: string;
  createdAt: number;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}

export interface ExportedData {
  version: number;
  exportedAt: number;
  meetings: StoredMeeting[];
  settings: SettingRecord[];
  documents: KBDocument[];
  modes: CustomMode[];
}

// --- Provider settings (v4) ---

/**
 * Per-provider configuration persisted under the `providers` setting.
 * `apiKeyCipher` is the base64(IV‖ciphertext) blob produced by
 * `CryptoVault.encrypt` and is only readable while the vault is unlocked.
 */
export interface ProviderConfig {
  id: 'gemini' | 'openai' | 'anthropic' | 'ollama' | 'simulation';
  enabled: boolean;
  priority: number;
  apiKeyCipher?: string;
  baseUrl?: string;
  pricePerMTokens?: { input: number; output: number };
}

// --- Database Constants ---

const DB_NAME = 'zule-unified';
const DB_VERSION = 4;

const LEGACY_DB_NAME = 'zule-store';
const LEGACY_DB_VERSION = 1;

export const STORE_MEETINGS = 'meetings';
export const STORE_SETTINGS = 'settings';
export const STORE_DOCUMENTS = 'documents';
export const STORE_MODES = 'custom_modes';
export const STORE_MEMORY_FACTS = 'memory_facts';
export const STORE_TELEMETRY = 'telemetry';
export const STORE_RESPONSE_CACHE = 'response_cache';
export const STORE_RATINGS = 'ratings';
export const STORE_STYLE_PROFILE = 'style_profile';

const MIGRATION_FLAG_LEGACY_COPY = '__migration.legacyZuleStoreCopied';

// --- Database Connection ---

/**
 * Cached promise for the post-open migration so the legacy-store copy
 * runs at most once per process. Resetting this is exposed via
 * `__resetDatabaseForTests` for unit/property tests.
 */
let postOpenMigrationPromise: Promise<void> | null = null;

/**
 * Serialize all calls to {@link migrateLegacyZuleStore} so a background
 * post-open invocation and a foreground explicit invocation cannot
 * race each other on the same legacy database. While one call is in
 * flight any concurrent call awaits its result instead of starting a
 * second copy/delete pass.
 */
let inFlightLegacyMigration: Promise<{
  copiedMeetings: number;
  copiedSettings: number;
  alreadyApplied: boolean;
}> | null = null;

function applyUpgrade(
  db: IDBDatabase,
  tx: IDBTransaction,
  oldVersion: number,
): void {
  // -------- v0 → v1: create base stores with their indexes --------
  if (oldVersion < 1) {
    const meetingsStore = db.createObjectStore(STORE_MEETINGS, { keyPath: 'id' });
    meetingsStore.createIndex('startedAt', 'startedAt', { unique: false });
    meetingsStore.createIndex('mode', 'mode', { unique: false });

    db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });

    const documentsStore = db.createObjectStore(STORE_DOCUMENTS, { keyPath: 'id' });
    documentsStore.createIndex('type', 'type', { unique: false });
    documentsStore.createIndex('createdAt', 'createdAt', { unique: false });
  }

  // -------- v1 → v2: ensure indexes exist on legacy v1 databases --------
  if (oldVersion >= 1 && oldVersion < 2) {
    const meetingsStore = tx.objectStore(STORE_MEETINGS);
    if (!meetingsStore.indexNames.contains('startedAt')) {
      meetingsStore.createIndex('startedAt', 'startedAt', { unique: false });
    }
    if (!meetingsStore.indexNames.contains('mode')) {
      meetingsStore.createIndex('mode', 'mode', { unique: false });
    }

    const documentsStore = tx.objectStore(STORE_DOCUMENTS);
    if (!documentsStore.indexNames.contains('type')) {
      documentsStore.createIndex('type', 'type', { unique: false });
    }
    if (!documentsStore.indexNames.contains('createdAt')) {
      documentsStore.createIndex('createdAt', 'createdAt', { unique: false });
    }
  }

  // -------- v2 → v3: add custom modes store --------
  if (oldVersion < 3) {
    if (!db.objectStoreNames.contains(STORE_MODES)) {
      db.createObjectStore(STORE_MODES, { keyPath: 'id' });
    }
  }

  // -------- v3 → v4: add memory/telemetry/cache/ratings/style-profile --------
  if (oldVersion < 4) {
    if (!db.objectStoreNames.contains(STORE_MEMORY_FACTS)) {
      const memoryStore = db.createObjectStore(STORE_MEMORY_FACTS, { keyPath: 'id' });
      // `meetingIds` is an array per design.md §Memory_Store; multiEntry
      // makes per-meeting recall an indexed lookup.
      memoryStore.createIndex('meetingIds', 'source.meetingIds', {
        unique: false,
        multiEntry: true,
      });
      memoryStore.createIndex('createdAt', 'createdAt', { unique: false });
    }

    if (!db.objectStoreNames.contains(STORE_TELEMETRY)) {
      const telemetryStore = db.createObjectStore(STORE_TELEMETRY, { keyPath: 'id' });
      telemetryStore.createIndex('at', 'at', { unique: false });
      telemetryStore.createIndex('kind', 'kind', { unique: false });
    }

    if (!db.objectStoreNames.contains(STORE_RESPONSE_CACHE)) {
      const cacheStore = db.createObjectStore(STORE_RESPONSE_CACHE, { keyPath: 'id' });
      cacheStore.createIndex('lastUsedAt', 'lastUsedAt', { unique: false });
    }

    if (!db.objectStoreNames.contains(STORE_RATINGS)) {
      const ratingsStore = db.createObjectStore(STORE_RATINGS, { keyPath: 'id' });
      ratingsStore.createIndex('providerId', 'providerId', { unique: false });
      ratingsStore.createIndex('modelId', 'modelId', { unique: false });
      ratingsStore.createIndex('createdAt', 'createdAt', { unique: false });
    }

    if (!db.objectStoreNames.contains(STORE_STYLE_PROFILE)) {
      // Single-row store keyed by 'id' (always 'default').
      db.createObjectStore(STORE_STYLE_PROFILE, { keyPath: 'id' });
    }
  }
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = (event.target as IDBOpenDBRequest).transaction;
      if (!tx) {
        // Should be unreachable in any conforming IDB implementation.
        return;
      }
      applyUpgrade(db, tx, event.oldVersion);
    };

    request.onsuccess = () => {
      const db = request.result;
      // Run the post-open migration off-thread so we never block the
      // caller awaiting `openDB()` on legacy-copy I/O. Errors are logged
      // to the console — the unified DB itself is still usable.
      runPostOpenMigrations().catch((error) => {
        console.error('[database] Post-open migration failed:', error);
      });
      resolve(db);
    };

    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      // Another tab holds an older version. Resolving with an error
      // keeps the surface contract simple; the orchestrator surfaces
      // a recoverable error to the user.
      reject(new Error('IndexedDB upgrade blocked by another tab'));
    };
  });
}

// --- Post-open migrations -----------------------------------------------

/**
 * Run migrations that cannot run inside `onupgradeneeded` because they
 * require cross-database I/O (e.g. copying from the legacy `zule-store`).
 *
 * Idempotency:
 *   - The legacy-store copy is gated on a flag persisted in the unified
 *     DB so subsequent process starts skip the work entirely.
 *   - Even without the flag the copy is safe to repeat: it uses `put`
 *     semantics and will not duplicate rows whose primary key already
 *     exists in the unified DB.
 *   - The legacy DB is deleted after a successful copy so subsequent
 *     runs find no rows to migrate.
 */
function runPostOpenMigrations(): Promise<void> {
  if (postOpenMigrationPromise) return postOpenMigrationPromise;
  postOpenMigrationPromise = (async () => {
    try {
      await migrateLegacyZuleStore();
    } catch (error) {
      console.error('[database] Legacy zule-store migration failed:', error);
    }
  })();
  return postOpenMigrationPromise;
}

/**
 * Detect whether a database with the given name exists. Falls back to
 * `false` on hosts where `indexedDB.databases()` is unavailable; in
 * that case `migrateLegacyZuleStore` will skip the work to avoid
 * accidentally creating an empty legacy DB on every page load.
 */
async function legacyDatabaseExists(): Promise<boolean> {
  const factory = indexedDB as IDBFactory & {
    databases?: () => Promise<{ name?: string; version?: number }[]>;
  };
  if (typeof factory.databases !== 'function') {
    return false;
  }
  try {
    const list = await factory.databases();
    return list.some((d) => d.name === LEGACY_DB_NAME);
  } catch {
    return false;
  }
}

/** Open the legacy DB strictly for read/copy purposes. */
function openLegacyZuleStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DB_NAME, LEGACY_DB_VERSION);
    // The legacy schema (`storage.ts`) had only `meetings` and
    // `settings`. Recreate them on upgrade so a partial / missing legacy
    // DB still resolves cleanly without throwing.
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meetings')) {
        db.createObjectStore('meetings', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function deleteDatabaseByName(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve(); // best-effort
  });
}

function getAllRows<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  if (!db.objectStoreNames.contains(storeName)) {
    return Promise.resolve([]);
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Read meetings + settings from the legacy `zule-store`, copy them
 * into the unified DB without overwriting newer rows, set the
 * `__migration.legacyZuleStoreCopied` flag, and delete the legacy DB.
 *
 * Exported via `__migrateLegacyZuleStoreForTests` so the property test
 * for Property 46 (Requirement 16.2) can call it directly.
 */
export async function migrateLegacyZuleStore(): Promise<{
  copiedMeetings: number;
  copiedSettings: number;
  alreadyApplied: boolean;
}> {
  // Serialize concurrent invocations: the second caller awaits the
  // first caller's result rather than racing against it. This keeps
  // the legacy-DB copy/delete sequence atomic across post-open
  // (background) and explicit (foreground) callers.
  if (inFlightLegacyMigration) return inFlightLegacyMigration;
  inFlightLegacyMigration = (async () => {
    try {
      return await runLegacyMigrationOnce();
    } finally {
      inFlightLegacyMigration = null;
    }
  })();
  return inFlightLegacyMigration;
}

async function runLegacyMigrationOnce(): Promise<{
  copiedMeetings: number;
  copiedSettings: number;
  alreadyApplied: boolean;
}> {
  // Fast path: skip when we already recorded that the legacy copy was
  // applied in a previous session.
  const alreadyApplied = await getSettingInternal<boolean>(
    MIGRATION_FLAG_LEGACY_COPY,
    false,
  );
  if (alreadyApplied) {
    return { copiedMeetings: 0, copiedSettings: 0, alreadyApplied: true };
  }

  if (!(await legacyDatabaseExists())) {
    // No legacy DB present at all — return without setting the flag so
    // that if the legacy DB ever does appear (e.g. an older tab writes
    // it after we boot, or a test seeds it after the first open) a
    // subsequent call still picks it up. The cost of re-checking is a
    // single `indexedDB.databases()` call on the first user action.
    return { copiedMeetings: 0, copiedSettings: 0, alreadyApplied: false };
  }

  const legacyDb = await openLegacyZuleStore();
  let copiedMeetings: number;
  let copiedSettings: number;
  try {
    const legacyMeetings = await getAllRows<StoredMeeting>(legacyDb, 'meetings');
    const legacySettings = await getAllRows<SettingRecord>(legacyDb, 'settings');

    const unifiedDb = await openDB();
    try {
      copiedMeetings = await copyMeetingsIfMissing(unifiedDb, legacyMeetings);
      copiedSettings = await copySettingsIfMissing(unifiedDb, legacySettings);
    } finally {
      unifiedDb.close();
    }
  } finally {
    legacyDb.close();
  }

  // Delete the legacy database after the copy. The flag is set first so
  // a subsequent crash before the delete completes still doesn't cause
  // double-copy (the flag, not the DB's existence, is the authority).
  await setSettingInternal(MIGRATION_FLAG_LEGACY_COPY, true);
  await deleteDatabaseByName(LEGACY_DB_NAME);

  return { copiedMeetings, copiedSettings, alreadyApplied: false };
}

function copyMeetingsIfMissing(
  db: IDBDatabase,
  legacy: StoredMeeting[],
): Promise<number> {
  if (legacy.length === 0) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_MEETINGS, 'readwrite');
    const store = tx.objectStore(STORE_MEETINGS);
    let copied = 0;
    let pending = legacy.length;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      // The transaction's own oncomplete fires after; guard against
      // double-resolving.
    };

    legacy.forEach((meeting) => {
      const probe = store.get(meeting.id);
      probe.onsuccess = () => {
        if (probe.result === undefined) {
          store.put(meeting);
          copied++;
        }
        if (--pending === 0) finish();
      };
      probe.onerror = () => {
        if (--pending === 0) finish();
      };
    });

    tx.oncomplete = () => resolve(copied);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

function copySettingsIfMissing(
  db: IDBDatabase,
  legacy: SettingRecord[],
): Promise<number> {
  if (legacy.length === 0) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SETTINGS, 'readwrite');
    const store = tx.objectStore(STORE_SETTINGS);
    let copied = 0;
    let pending = legacy.length;

    legacy.forEach((setting) => {
      const probe = store.get(setting.key);
      probe.onsuccess = () => {
        if (probe.result === undefined) {
          store.put(setting);
          copied++;
        }
        pending--;
      };
      probe.onerror = () => {
        pending--;
      };
    });

    tx.oncomplete = () => resolve(copied);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));

    // pending is consumed by tx.oncomplete; the local var is only used
    // as a sanity counter.
    void pending;
  });
}

// --- Internal setting helpers (used by migrations to avoid recursion) ---
//
// These talk to the unified DB directly so that calling them from
// inside `runPostOpenMigrations` does not re-enter `openDB`'s
// post-open hook (the cached promise prevents recursion in any case).

async function getSettingInternal<T>(key: string, defaultValue: T): Promise<T> {
  const db = await openDBForInternalUse();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_SETTINGS, 'readonly');
      const request = tx.objectStore(STORE_SETTINGS).get(key);
      request.onsuccess = () => {
        const row = request.result as SettingRecord | undefined;
        resolve((row?.value as T) ?? defaultValue);
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function setSettingInternal<T>(key: string, value: T): Promise<void> {
  const db = await openDBForInternalUse();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_SETTINGS, 'readwrite');
      tx.objectStore(STORE_SETTINGS).put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Open the unified DB without re-triggering the post-open migration.
 * Used by helpers that themselves run inside the post-open migration.
 */
function openDBForInternalUse(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = (event.target as IDBOpenDBRequest).transaction;
      if (!tx) return;
      applyUpgrade(db, tx, event.oldVersion);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
  });
}

// --- Plaintext apiKey → providers[].apiKeyCipher migration --------------

/**
 * Re-encode the legacy plaintext `apiKey` setting (Gemini-only, written
 * by the pre-vault code path) into `providers[id=gemini].apiKeyCipher`.
 *
 * Must be called with an unlocked `CryptoVault`. Idempotent: once the
 * plaintext setting is removed the function is a no-op on every
 * subsequent call.
 *
 * This step is intentionally separated from `openDB()` because it
 * requires a passphrase prompt, which is a UI-driven operation. The
 * orchestrator should call this on first vault unlock; until then the
 * plaintext `apiKey` setting remains readable for backwards compat.
 *
 * Returns:
 *   - `{ migrated: false }` when there is nothing to do (no plaintext
 *     key, or the vault is locked).
 *   - `{ migrated: true, providerId: 'gemini' }` after a successful
 *     re-encode.
 */
export async function migrateApiKeyToProviderCipher(
  vault: CryptoVault,
): Promise<
  | { migrated: false; reason: 'vault-locked' | 'no-plaintext-key' }
  | { migrated: true; providerId: 'gemini' }
> {
  if (vault.isLocked) {
    return { migrated: false, reason: 'vault-locked' };
  }

  const plaintext = await database.getSetting<string>('apiKey', '');
  if (!plaintext || plaintext.trim().length === 0) {
    return { migrated: false, reason: 'no-plaintext-key' };
  }

  const enc = await vault.encrypt(plaintext);
  if (!enc.ok) {
    return { migrated: false, reason: 'vault-locked' };
  }

  const providers = await database.getSetting<ProviderConfig[]>('providers', []);
  const updated: ProviderConfig[] = [...providers];
  const idx = updated.findIndex((p) => p.id === 'gemini');
  if (idx >= 0) {
    updated[idx] = { ...updated[idx], apiKeyCipher: enc.value };
  } else {
    updated.push({
      id: 'gemini',
      enabled: true,
      priority: 0,
      apiKeyCipher: enc.value,
    });
  }
  await database.setSetting('providers', updated);

  // Drop the plaintext key. Subsequent reads of `apiKey` return ''.
  await database.setSetting('apiKey', '');

  return { migrated: true, providerId: 'gemini' };
}

// --- Vector_Index removal notifier ----------------------------------------
//
// Every code path in this module that deletes one or more chunk rows from
// `STORE_DOCUMENTS` must also notify the main-process Vector_Index so its
// in-memory HNSW graph drops the matching label entries (Requirement 2.6).
// The Vector_Index keys each entry by `${docId}#${chunkIndex}` — the same
// canonical id format used by `vectorIndexHydration.ts::chunkIndexId` and
// by the upload-time insert path in `Settings.handleAddDocument`. The
// formula is intentionally inlined here rather than imported, because
// `vectorIndexHydration.ts` already imports from this module and a back-
// import would create a circular dependency. The two sites must stay in
// sync; the comment in `chunkIndexId` documents the convention.
//
// Failures are swallowed: a missing bridge (e.g. running outside Electron)
// or a main-process error must never block the IndexedDB delete from
// being reported as successful. The renderer-side linear-scan fallback in
// `database.search` plus the self-healing rebuild in
// `hydrateVectorIndexOnBoot` together guarantee correctness even if a
// `vectorIndex:remove` call is dropped on the floor.
async function notifyVectorIndexRemove(
  docId: string,
  chunkCount: number,
): Promise<void> {
  if (chunkCount <= 0) return;
  if (typeof window === 'undefined') return;
  const remove = window.electronAPI?.vectorIndexRemove;
  if (typeof remove !== 'function') return;

  const calls: Array<Promise<unknown>> = [];
  for (let i = 0; i < chunkCount; i++) {
    // Mirror of `vectorIndexHydration.ts::chunkIndexId(docId, i)`.
    const id = `${docId}#${i}`;
    calls.push(
      remove(id).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[database] vectorIndex:remove failed for ${id}:`,
          err,
        );
      }),
    );
  }
  await Promise.allSettled(calls);
}

// --- ID Generation ---

function generateId(): string {
  return `zule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Unified Database API ---

export const database = {
  // =====================
  // Meetings
  // =====================

  async saveMeeting(meeting: StoredMeeting): Promise<void> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MEETINGS, 'readwrite');
        tx.objectStore(STORE_MEETINGS).put(meeting);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      console.error('[database] Failed to save meeting:', error);
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        console.error('[database] Storage quota exceeded. Consider deleting old meetings.');
      }
      throw error;
    }
  },

  async getMeeting(id: string): Promise<StoredMeeting | undefined> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MEETINGS, 'readonly');
        const request = tx.objectStore(STORE_MEETINGS).get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('[database] Failed to get meeting:', error);
      throw error;
    }
  },

  async getAllMeetings(): Promise<StoredMeeting[]> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MEETINGS, 'readonly');
        const request = tx.objectStore(STORE_MEETINGS).getAll();
        request.onsuccess = () => {
          const meetings = request.result as StoredMeeting[];
          meetings.sort((a, b) => b.startedAt - a.startedAt);
          resolve(meetings);
        };
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('[database] Failed to get all meetings:', error);
      throw error;
    }
  },

  async deleteMeeting(id: string): Promise<void> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MEETINGS, 'readwrite');
        tx.objectStore(STORE_MEETINGS).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      console.error('[database] Failed to delete meeting:', error);
      throw error;
    }
  },

  // =====================
  // Settings
  // =====================

  async getSetting<T>(key: string, defaultValue: T): Promise<T> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SETTINGS, 'readonly');
        const request = tx.objectStore(STORE_SETTINGS).get(key);
        request.onsuccess = () => {
          resolve(request.result?.value ?? defaultValue);
        };
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('[database] Failed to get setting:', error);
      throw error;
    }
  },

  async setSetting<T>(key: string, value: T): Promise<void> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SETTINGS, 'readwrite');
        tx.objectStore(STORE_SETTINGS).put({ key, value });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      console.error('[database] Failed to set setting:', error);
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        console.error('[database] Storage quota exceeded.');
      }
      throw error;
    }
  },

  // =====================
  // Custom Modes
  // =====================

  async saveCustomMode(mode: CustomMode): Promise<void> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MODES, 'readwrite');
        tx.objectStore(STORE_MODES).put(mode);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      console.error('[database] Failed to save custom mode:', error);
      throw error;
    }
  },

  async getAllCustomModes(): Promise<CustomMode[]> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MODES, 'readonly');
        const request = tx.objectStore(STORE_MODES).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('[database] Failed to get custom modes:', error);
      throw error;
    }
  },

  async deleteCustomMode(id: string): Promise<void> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_MODES, 'readwrite');
        tx.objectStore(STORE_MODES).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      console.error('[database] Failed to delete custom mode:', error);
      throw error;
    }
  },

  // =====================
  // Documents (Knowledge Base)
  // =====================

  /**
   * Persist a new Knowledge_Base document and its chunk vectors.
   *
   * Vector compaction (Requirement 6.4):
   *   When the total stored chunk count across all documents reaches
   *   `QUANTIZATION_THRESHOLD` (1 000), every newly-stored chunk vector
   *   is converted to its int8 representation via
   *   `vectorStore.quantizeForStorage`. Existing chunks are left in
   *   their original encoding — the audit's retention pass evicts them
   *   over time (task 5.3 / Requirement 6.6). Search transparently
   *   dequantizes either form.
   *
   * Inputs are still accepted as `Array<{ text; vector: number[] }>`
   * so the caller (e.g. `Settings.tsx` upload flow,
   * `summaryEngine.saveFacts`) does not need to know about the
   * encoding policy.
   */
  async addDocument(
    title: string,
    content: string,
    type: KBDocument['type'],
    chunks: Array<{ text: string; vector: number[] }>,
  ): Promise<KBDocument> {
    try {
      const db = await openDB();
      const { vectorStore } = await import('../brain/vectorStore');

      // Count chunks already in the Knowledge_Base so we can decide,
      // chunk by chunk, whether to apply int8 quantization. The count
      // increments as we go: the second chunk of a batch sees the
      // (originalCount + 1) as its threshold input.
      const existingCount = await this.countDocumentChunks();

      const storedChunks: KBChunk[] = chunks.map((c, i) => {
        const decision = vectorStore.quantizeForStorage(
          c.vector,
          existingCount + i,
        );
        if (decision.kind === 'quantized') {
          return { text: c.text, vectorQ: decision.vectorQ };
        }
        return { text: c.text, vector: decision.vector };
      });

      const doc: KBDocument = {
        id: generateId(),
        title,
        content,
        type,
        chunks: storedChunks,
        createdAt: Date.now(),
      };
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_DOCUMENTS, 'readwrite');
        tx.objectStore(STORE_DOCUMENTS).put(doc);
        tx.oncomplete = () => resolve(doc);
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      console.error('[database] Failed to add document:', error);
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        console.error('[database] Storage quota exceeded. Consider removing old documents.');
      }
      throw error;
    }
  },

  /**
   * Total chunk count across every persisted document. Used by
   * {@link addDocument} to decide whether to quantize vectors before
   * write (Requirement 6.4) and by tests / telemetry to inspect the
   * Knowledge_Base footprint without materializing every chunk's text.
   */
  async countDocumentChunks(): Promise<number> {
    const docs = await this.getAllDocuments();
    let n = 0;
    for (const doc of docs) n += doc.chunks.length;
    return n;
  },

  async removeDocument(id: string): Promise<void> {
    try {
      const db = await openDB();

      // Read the document's chunk count and delete it inside a single
      // readwrite transaction so the two operations are atomic. We need
      // the chunk count to drive the `vectorIndex:remove` notifications
      // below (Requirement 2.6) — once the row is gone there is no way
      // to recover the per-chunk ids that were registered with the
      // main-process Vector_Index. Issuing both ops on the same
      // transaction guarantees the count corresponds to the row that
      // is actually being removed.
      const chunkCount = await new Promise<number>((resolve, reject) => {
        const tx = db.transaction(STORE_DOCUMENTS, 'readwrite');
        const store = tx.objectStore(STORE_DOCUMENTS);
        let count = 0;
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          const existing = getReq.result as KBDocument | undefined;
          count = existing?.chunks?.length ?? 0;
        };
        getReq.onerror = () => reject(getReq.error);
        // `delete` is idempotent — issuing it for an absent key is a
        // no-op, matching the pre-existing contract.
        store.delete(id);
        tx.oncomplete = () => resolve(count);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
      });

      // (Requirement 2.6) Notify the main-process Vector_Index that
      // every chunk of this document has been removed. Fire-and-forget
      // per chunk index; failures here cannot fail the removal.
      await notifyVectorIndexRemove(id, chunkCount);

      // (Requirement 6.7) Drop every cached query embedding so a search
      // that was about to return chunks from the deleted document
      // cannot do so via a stale LRU hit. The cache holds query vectors
      // keyed by query text, not chunk references, so we cannot
      // selectively invalidate; clearing the whole cache is the
      // conservative correct move and is what the design specifies.
      try {
        const { vectorStore } = await import('../brain/vectorStore');
        vectorStore.invalidateQueryCache();
      } catch (cacheError) {
        // Cache invalidation is a hygiene step, not a correctness
        // gate — the chunks themselves are already gone from
        // IndexedDB. Log and continue so the caller sees the original
        // delete as successful.
        // eslint-disable-next-line no-console
        console.error(
          '[database] Failed to invalidate query cache after removeDocument:',
          cacheError,
        );
      }
    } catch (error) {
      console.error('[database] Failed to remove document:', error);
      throw error;
    }
  },

  async getAllDocuments(): Promise<KBDocument[]> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_DOCUMENTS, 'readonly');
        const request = tx.objectStore(STORE_DOCUMENTS).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('[database] Failed to get all documents:', error);
      throw error;
    }
  },

  /**
   * Cosine-similarity search over the Knowledge_Base.
   *
   * (Requirement 6.5) Both the cosine threshold and `maxResults` are
   * configurable through the optional `opts` object — defaults are
   * pinned in `kbSearch.ts` (0.40 / 5). The pure ranking algorithm
   * lives in {@link searchChunks} so it can be exercised by Property
   * 17 without requiring a real Transformers.js pipeline.
   *
   * Two search paths share this entry point (Requirements 2.1, 2.2,
   * 4.2, 4.4):
   *
   *   - **ANN path** — when the live chunk count is at or above
   *     `QUANTIZATION_THRESHOLD` and the `vectorIndex:query` IPC bridge
   *     is reachable, the query embedding is shipped to the main-process
   *     HNSW graph. Hits come back as stable `${docId}#${chunkIndex}`
   *     ids (the same convention {@link buildIndexedItemsFromDocuments}
   *     uses on insert) which we map back to the original chunk text.
   *   - **Linear-scan fallback** — for smaller Knowledge_Bases, or when
   *     the ANN bridge is unavailable, the call falls through to the
   *     legacy `searchChunks` linear scan in `kbSearch.ts`. This keeps
   *     the existing `kbSearch.test.ts` assertions intact
   *     (Requirements 4.4, 9.2) and is naturally pure (no
   *     `dequantizeFromStorage` invocation, satisfying Property 12).
   *
   * For source-compatibility with the legacy `search(query, maxResults)`
   * call shape (still used by `contextManager.ts` until task 10 lands),
   * the second argument may also be a plain `number`, which is treated
   * as `{ maxResults }`.
   */
  async search(
    query: string,
    opts?: KBSearchOptions | number,
  ): Promise<string[]> {
    if (!query.trim()) return [];
    try {
      const { vectorStore, QUANTIZATION_THRESHOLD } = await import(
        '../brain/vectorStore'
      );
      // Embed the query through the existing `embed:generate` channel
      // (delegated from `vectorStore.generateEmbedding` when the IPC
      // bridge is present, with the renderer-side LRU on top — design
      // §"Components and Interfaces / Vector_Index Service").
      const queryVector = await vectorStore.generateEmbedding(query);

      const allDocs = await this.getAllDocuments();

      const resolvedOpts: KBSearchOptions =
        typeof opts === 'number'
          ? { maxResults: opts }
          : opts ?? {};

      const threshold =
        resolvedOpts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
      const maxResultsRaw = resolvedOpts.maxResults ?? DEFAULT_MAX_RESULTS;
      const maxResults =
        Number.isFinite(maxResultsRaw) && maxResultsRaw > 0
          ? Math.floor(maxResultsRaw)
          : 0;
      if (maxResults === 0) return [];

      // Total live chunk count drives the ANN/linear-scan switch. The
      // walk is cheap (just `chunks.length` per document) and avoids
      // pulling in `kbRetention.totalChunkCount` purely for the policy
      // gate.
      let totalChunks = 0;
      for (const doc of allDocs) totalChunks += doc.chunks.length;

      const queryBridge =
        typeof window !== 'undefined'
          ? window.electronAPI?.vectorIndexQuery
          : undefined;

      // ── ANN path (Requirements 2.1, 2.2, 4.2) ────────────────────
      // Above the quantization threshold and with the IPC bridge
      // present, route the query through the HNSW graph in the main
      // process. The hit ids match the `${docId}#${chunkIndex}` form
      // produced by `buildIndexedItemsFromDocuments` on insert/rebuild.
      if (
        totalChunks >= QUANTIZATION_THRESHOLD &&
        typeof queryBridge === 'function'
      ) {
        try {
          const hits = await queryBridge(queryVector, maxResults);
          if (hits.length > 0) {
            const idToText = new Map<string, string>();
            for (const doc of allDocs) {
              for (let i = 0; i < doc.chunks.length; i++) {
                idToText.set(`${doc.id}#${i}`, doc.chunks[i].text);
              }
            }
            const out: string[] = [];
            for (const hit of hits) {
              if (hit.score < threshold) continue;
              const text = idToText.get(hit.id);
              if (typeof text === 'string') out.push(text);
              if (out.length >= maxResults) break;
            }
            return out;
          }
          // hits.length === 0 falls through to the linear scan as a
          // safety net: a not-yet-hydrated index (e.g. boot hydration
          // still in flight) would otherwise return no results despite
          // the KB having relevant content.
        } catch (annErr) {
          console.warn(
            '[database.search] ANN query failed; falling back to linear scan:',
            annErr,
          );
        }
      }

      // ── Linear-scan fallback (Requirements 4.4, 9.2) ─────────────
      // Untouched legacy path — preserves the existing `kbSearch.ts`
      // contract and, crucially, is the only branch exercised when the
      // KB is below `QUANTIZATION_THRESHOLD` (Property 12: never invokes
      // `dequantizeFromStorage` for chunks stored as raw `vector`).
      return searchChunks(
        allDocs,
        queryVector,
        // Decode whichever encoding the chunk was persisted in. New
        // rows (after the QUANTIZATION_THRESHOLD crossover) carry
        // `vectorQ`; legacy rows still carry `vector` (Requirement 6.4).
        (chunk) => {
          if (chunk.vector && chunk.vector.length > 0) return chunk.vector;
          if (chunk.vectorQ && chunk.vectorQ.data.length > 0) {
            return vectorStore.dequantizeFromStorage({
              kind: 'quantized',
              vectorQ: chunk.vectorQ,
            });
          }
          return null;
        },
        (a, b) => vectorStore.calculateCosineSimilarity(a, b),
        resolvedOpts,
      );
    } catch (e) {
      console.error('Vector search failed:', e);
      return [];
    }
  },

  // =====================
  // Style Profile (single-row store, keyed by 'default')
  // =====================
  //
  // Used by the `StyleProfileStore` (design §11) to persist the
  // running personalization profile (Requirement 22.4). The store is
  // keyed by `id` and contains at most one row.

  async getStyleProfileRow(id: string): Promise<unknown | undefined> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_STYLE_PROFILE, 'readonly');
        const request = tx.objectStore(STORE_STYLE_PROFILE).get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('[database] Failed to get style profile:', error);
      throw error;
    }
  },

  async getAllStyleProfiles<T = unknown>(): Promise<T[]> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_STYLE_PROFILE, 'readonly');
        const request = tx.objectStore(STORE_STYLE_PROFILE).getAll();
        request.onsuccess = () => resolve(request.result as T[]);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('[database] Failed to get all style profiles:', error);
      throw error;
    }
  },

  async putStyleProfile<T extends { id: string }>(row: T): Promise<void> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_STYLE_PROFILE, 'readwrite');
        tx.objectStore(STORE_STYLE_PROFILE).put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      console.error('[database] Failed to put style profile:', error);
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        console.error('[database] Storage quota exceeded.');
      }
      throw error;
    }
  },

  async deleteStyleProfile(id: string): Promise<void> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_STYLE_PROFILE, 'readwrite');
        tx.objectStore(STORE_STYLE_PROFILE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      console.error('[database] Failed to delete style profile:', error);
      throw error;
    }
  },

  // =====================
  // Telemetry
  // =====================

  async putTelemetryEvent<T extends { id: string }>(row: T): Promise<void> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_TELEMETRY, 'readwrite');
        tx.objectStore(STORE_TELEMETRY).put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      console.error('[database] Failed to put telemetry event:', error);
      throw error;
    }
  },

  async queryTelemetryEvents<T = unknown>(sinceTimestamp: number): Promise<T[]> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_TELEMETRY, 'readonly');
        const store = tx.objectStore(STORE_TELEMETRY);
        const index = store.index('at');
        const range = IDBKeyRange.lowerBound(sinceTimestamp, false);
        const request = index.getAll(range);
        request.onsuccess = () => resolve(request.result as T[]);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('[database] Failed to query telemetry events:', error);
      throw error;
    }
  },

  async clearTelemetry(): Promise<void> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_TELEMETRY, 'readwrite');
        tx.objectStore(STORE_TELEMETRY).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      console.error('[database] Failed to clear telemetry:', error);
      throw error;
    }
  },

  // =====================
  // Import / Export
  // =====================

  async exportData(): Promise<ExportedData> {
    try {
      const db = await openDB();

      const meetings = await new Promise<StoredMeeting[]>((resolve, reject) => {
        const tx = db.transaction(STORE_MEETINGS, 'readonly');
        const request = tx.objectStore(STORE_MEETINGS).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      const settings = await new Promise<SettingRecord[]>((resolve, reject) => {
        const tx = db.transaction(STORE_SETTINGS, 'readonly');
        const request = tx.objectStore(STORE_SETTINGS).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      const documents = await new Promise<KBDocument[]>((resolve, reject) => {
        const tx = db.transaction(STORE_DOCUMENTS, 'readonly');
        const request = tx.objectStore(STORE_DOCUMENTS).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      const modes = await new Promise<CustomMode[]>((resolve, reject) => {
        const tx = db.transaction(STORE_MODES, 'readonly');
        const request = tx.objectStore(STORE_MODES).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      return {
        version: DB_VERSION,
        exportedAt: Date.now(),
        meetings,
        settings,
        documents,
        modes,
      };
    } catch (error) {
      console.error('[database] Failed to export data:', error);
      throw error;
    }
  },

  async importData(data: ExportedData): Promise<void> {
    try {
      const db = await openDB();

      const tx = db.transaction([STORE_MEETINGS, STORE_SETTINGS, STORE_DOCUMENTS, STORE_MODES], 'readwrite');

      if (data.meetings && Array.isArray(data.meetings)) {
        const store = tx.objectStore(STORE_MEETINGS);
        for (const meeting of data.meetings) store.put(meeting);
      }

      if (data.settings && Array.isArray(data.settings)) {
        const store = tx.objectStore(STORE_SETTINGS);
        for (const setting of data.settings) store.put(setting);
      }

      if (data.documents && Array.isArray(data.documents)) {
        const store = tx.objectStore(STORE_DOCUMENTS);
        for (const doc of data.documents) store.put(doc);
      }

      if (data.modes && Array.isArray(data.modes)) {
        const store = tx.objectStore(STORE_MODES);
        for (const mode of data.modes) store.put(mode);
      }

      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      console.error('[database] Failed to import data:', error);
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        console.error('[database] Storage quota exceeded during import.');
      }
      throw error;
    }
  },

  // =====================
  // Retention & quota recovery
  // =====================
  //
  // Background sweep + UI-callable quota-recovery helpers backing
  // Requirement 16.4 ("delete oldest meetings" / "delete oldest
  // knowledge chunks" actions) and Requirement 16.5 (background
  // retention rules). The pure logic lives in `./retention.ts`; the
  // methods here are thin IndexedDB wrappers.

  /**
   * Run the retention sweep against the current `meetings` store.
   *
   * Loads every meeting, runs `applyRetention`, then deletes overdue
   * meetings and re-`put`s truncated ones inside a single readwrite
   * transaction so the operation is atomic from the caller's
   * perspective. Returns counts so the caller (Settings UI, scheduled
   * sweep) can show a confirmation toast.
   *
   * If `opts` is omitted the function pulls `meetingMaxAgeDays` and
   * `transcriptMaxLines` from the `retention` setting (falling back to
   * the defaults from Requirement 16.5: 365 days / 50 000 lines).
   */
  async enforceRetention(opts?: Partial<RetentionOptions>): Promise<{
    deletedMeetings: number;
    truncatedMeetings: number;
  }> {
    const settings = await this.getSetting<{
      meetingMaxAgeDays?: number;
      transcriptMaxLines?: number;
    }>('retention', {});

    const resolvedOpts: RetentionOptions = {
      maxAgeDays:
        opts?.maxAgeDays ??
        settings.meetingMaxAgeDays ??
        DEFAULT_MEETING_MAX_AGE_DAYS,
      maxLines:
        opts?.maxLines ??
        settings.transcriptMaxLines ??
        DEFAULT_TRANSCRIPT_MAX_LINES,
      now: opts?.now ?? Date.now(),
    };

    const before = await this.getAllMeetings();
    const after = applyRetention(before, resolvedOpts);
    const { deletedIds, truncatedMeetings } = diffRetention(before, after);

    if (deletedIds.length === 0 && truncatedMeetings.length === 0) {
      return { deletedMeetings: 0, truncatedMeetings: 0 };
    }

    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_MEETINGS, 'readwrite');
      const store = tx.objectStore(STORE_MEETINGS);
      for (const id of deletedIds) store.delete(id);
      for (const meeting of truncatedMeetings) store.put(meeting);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });

    return {
      deletedMeetings: deletedIds.length,
      truncatedMeetings: truncatedMeetings.length,
    };
  },

  /**
   * Quota-recovery helper exposed to the UI when a write fails with
   * `storage.quota-exceeded` (Requirement 16.4). Deletes the `n`
   * meetings with the oldest `startedAt`. `n` is clamped to
   * `[0, totalMeetings]`. Returns the number of meetings actually
   * deleted.
   */
  async deleteOldestMeetings(n: number): Promise<number> {
    if (!Number.isFinite(n) || n <= 0) return 0;
    const all = await this.getAllMeetings();
    // `getAllMeetings` returns newest-first, so reverse to get
    // oldest-first.
    const oldest = [...all].reverse().slice(0, Math.floor(n));
    if (oldest.length === 0) return 0;

    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_MEETINGS, 'readwrite');
      const store = tx.objectStore(STORE_MEETINGS);
      for (const m of oldest) store.delete(m.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
    return oldest.length;
  },

  /**
   * Enforce the Knowledge_Base chunk-cap retention rule
   * (Requirement 6.6).
   *
   * Loads every document, runs {@link applyKBRetention} to determine
   * which documents should be evicted, and deletes them inside a
   * single readwrite transaction so the operation is atomic from the
   * caller's perspective. Returns counts so the orchestrator (or a
   * future Settings UI) can surface a confirmation toast.
   *
   * Eviction priority (mirrored from `applyKBRetention`):
   *   1. Oldest documents whose `type` is in `KB_AUTO_EVICTABLE_TYPES`
   *      ({notes, sales-script}, the in-app proxies for the design's
   *      `meeting-fact` type).
   *   2. If still over cap, oldest documents across all remaining
   *      types by `createdAt` ascending.
   *
   * If `cap` is omitted the method pulls the configured value from the
   * `kbRetention` setting (`{ chunkCap?: number }`); if that too is
   * absent it falls back to {@link DEFAULT_KB_RETENTION_CAP}.
   *
   * Pure logic (`applyKBRetention`) lives in `./kbRetention.ts` so
   * Property 19 (Requirement 6.6) tests it without touching IndexedDB.
   */
  async enforceKBRetention(cap?: number): Promise<{
    evictedDocuments: number;
    evictedChunks: number;
  }> {
    const settings = await this.getSetting<{ chunkCap?: number }>(
      'kbRetention',
      {},
    );
    const resolvedCap =
      cap ?? settings.chunkCap ?? DEFAULT_KB_RETENTION_CAP;

    const before = await this.getAllDocuments();
    const after = applyKBRetention(before, resolvedCap);
    const { evictedIds } = diffKBRetention(before, after);

    if (evictedIds.length === 0) {
      return { evictedDocuments: 0, evictedChunks: 0 };
    }

    // Compute chunk count *before* the delete so the return value is
    // accurate even if `getAllDocuments` is queried after the delete.
    const evictedSet = new Set(evictedIds);
    let evictedChunks = 0;
    for (const doc of before) {
      if (evictedSet.has(doc.id)) evictedChunks += doc.chunks?.length ?? 0;
    }

    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_DOCUMENTS, 'readwrite');
      const store = tx.objectStore(STORE_DOCUMENTS);
      for (const id of evictedIds) store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });

    // (Requirement 2.6) Notify the main-process Vector_Index that
    // every chunk of every evicted document has been removed. The
    // `before` snapshot still carries chunk counts even though the
    // rows have just been deleted from IndexedDB.
    for (const doc of before) {
      if (!evictedSet.has(doc.id)) continue;
      await notifyVectorIndexRemove(doc.id, doc.chunks?.length ?? 0);
    }

    // (Requirement 6.7) Document deletion invalidates cached query
    // results referencing chunks from those documents. The query
    // cache is keyed by query text, not by chunk reference, so we
    // clear the whole cache rather than inspecting individual entries.
    try {
      const { vectorStore } = await import('../brain/vectorStore');
      vectorStore.invalidateQueryCache();
    } catch (cacheError) {
      // eslint-disable-next-line no-console
      console.error(
        '[database] Failed to invalidate query cache after enforceKBRetention:',
        cacheError,
      );
    }

    return {
      evictedDocuments: evictedIds.length,
      evictedChunks,
    };
  },

  /**
   * Quota-recovery helper exposed to the UI when a write fails with
   * `storage.quota-exceeded` (Requirement 16.4). Deletes oldest
   * documents (by `createdAt` ascending) until at least `n` chunks
   * have been removed across all deleted documents, or until the
   * Knowledge_Base is empty.
   *
   * We delete whole documents rather than mutating per-document chunk
   * arrays because individual chunks have no stable identity in the
   * persisted schema and mutating a document mid-flight would corrupt
   * the cosine-similarity index in the Vector_Index (task 5.2 / 5.3).
   *
   * Returns the number of documents deleted and the total chunks
   * removed so the caller can decide whether to retry the original
   * write.
   */
  async deleteOldestKnowledgeChunks(n: number): Promise<{
    deletedDocuments: number;
    deletedChunks: number;
  }> {
    if (!Number.isFinite(n) || n <= 0) {
      return { deletedDocuments: 0, deletedChunks: 0 };
    }
    const all = await this.getAllDocuments();
    // `getAllDocuments` returns insertion order; sort ascending by
    // `createdAt` to find the oldest.
    const oldestFirst = [...all].sort((a, b) => a.createdAt - b.createdAt);

    const target = Math.floor(n);
    const toDelete: KBDocument[] = [];
    let removedChunks = 0;
    for (const doc of oldestFirst) {
      if (removedChunks >= target) break;
      toDelete.push(doc);
      removedChunks += doc.chunks?.length ?? 0;
    }

    if (toDelete.length === 0) {
      return { deletedDocuments: 0, deletedChunks: 0 };
    }

    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_DOCUMENTS, 'readwrite');
      const store = tx.objectStore(STORE_DOCUMENTS);
      for (const d of toDelete) store.delete(d.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });

    // (Requirement 2.6) Notify the main-process Vector_Index that
    // every chunk of every quota-evicted document has been removed.
    for (const doc of toDelete) {
      await notifyVectorIndexRemove(doc.id, doc.chunks?.length ?? 0);
    }

    return { deletedDocuments: toDelete.length, deletedChunks: removedChunks };
  },

  // =====================
  // Ratings
  // =====================

  async putRating<T extends { id: string }>(record: T): Promise<void> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_RATINGS, 'readwrite');
        tx.objectStore(STORE_RATINGS).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      console.error('[database] Failed to put rating:', error);
      throw error;
    }
  },

  async getAllRatings<T = unknown>(): Promise<T[]> {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_RATINGS, 'readonly');
        const request = tx.objectStore(STORE_RATINGS).getAll();
        request.onsuccess = () => resolve(request.result as T[]);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('[database] Failed to get all ratings:', error);
      throw error;
    }
  },
};

// --- Storage error classification --------------------------------------

/**
 * Map a thrown value coming out of any `database.*` write into a typed
 * `ZuleError` so call sites can pass it straight to `useZuleError`
 * without re-implementing the `instanceof DOMException` dance.
 *
 * Returns `null` for errors that are not storage-related so callers can
 * fall back to their own handling. The `storage.quota-exceeded` variant
 * is what the Settings recovery actions
 * (`database.deleteOldestMeetings` / `deleteOldestKnowledgeChunks`)
 * are designed to recover from (Requirement 16.4).
 */
export function classifyStorageError(error: unknown): ZuleError | null {
  if (error instanceof DOMException) {
    if (error.name === 'QuotaExceededError') {
      return { kind: 'storage.quota-exceeded' };
    }
    if (
      error.name === 'NotFoundError' ||
      error.name === 'InvalidStateError' ||
      error.name === 'DataError'
    ) {
      return { kind: 'storage.corrupted' };
    }
  }
  return null;
}

// --- Test-only exports --------------------------------------------------

/**
 * Reset cached migration state so a fresh `IDBFactory` (e.g. between
 * test cases) does not see a stale "already migrated" promise.
 *
 * This export exists for tests; it is a no-op in production code paths.
 */
export function __resetDatabaseForTests(): void {
  postOpenMigrationPromise = null;
  inFlightLegacyMigration = null;
}

/** Stable export of constants/internals used by the property test. */
export const __dbConstantsForTests = {
  DB_NAME,
  DB_VERSION,
  LEGACY_DB_NAME,
  LEGACY_DB_VERSION,
  MIGRATION_FLAG_LEGACY_COPY,
};
