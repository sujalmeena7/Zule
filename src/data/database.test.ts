// ============================================
// Zule AI — Unified Database (zule-unified, v4) tests
// ============================================
//
// Two layers of tests:
//
//   1. Unit tests that pin down the v4 schema (stores + indexes), the
//      legacy-store migration, and the apiKey re-encode.
//   2. Property test (Property 46, Requirement 16.2): the migration
//      sequence is idempotent across all prior versions — running it
//      a second time on the same starting state produces exactly the
//      same final state.
//
// All tests run against a fresh `fake-indexeddb` factory per test so
// IDBs do not leak state across cases.

import { describe, expect, it, beforeEach } from 'vitest';
import fc from 'fast-check';
import { IDBFactory } from 'fake-indexeddb';

import {
  database,
  migrateLegacyZuleStore,
  migrateApiKeyToProviderCipher,
  __resetDatabaseForTests,
  __dbConstantsForTests,
  STORE_MEETINGS,
  STORE_SETTINGS,
  STORE_DOCUMENTS,
  STORE_MODES,
  STORE_MEMORY_FACTS,
  STORE_TELEMETRY,
  STORE_RESPONSE_CACHE,
  STORE_RATINGS,
  STORE_STYLE_PROFILE,
  type StoredMeeting,
  type ProviderConfig,
} from './database';
import { CryptoVault } from '../utils/cryptoVault';

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Replace the global IDB factory with a fresh one (no leftover DBs). */
function resetIndexedDB(): void {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  __resetDatabaseForTests();
}

/** Open the unified DB with `indexedDB` directly (no module helper). */
function rawOpen(name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      // For DBs we open during seeding we always provide an explicit
      // upgrade callback by name; this default is a no-op safety net.
    };
  });
}

function rawGetAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  if (!db.objectStoreNames.contains(storeName)) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

/** Seed the legacy `zule-store` DB (storage.ts schema) directly. */
async function seedLegacyZuleStore(rows: {
  meetings?: StoredMeeting[];
  settings?: { key: string; value: unknown }[];
}): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('zule-store', 1);
    request.onupgradeneeded = () => {
      const upgrading = request.result;
      if (!upgrading.objectStoreNames.contains('meetings')) {
        upgrading.createObjectStore('meetings', { keyPath: 'id' });
      }
      if (!upgrading.objectStoreNames.contains('settings')) {
        upgrading.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['meetings', 'settings'], 'readwrite');
    if (rows.meetings) {
      for (const m of rows.meetings) tx.objectStore('meetings').put(m);
    }
    if (rows.settings) {
      for (const s of rows.settings) tx.objectStore('settings').put(s);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/**
 * Seed the unified DB at an arbitrary prior version (1 / 2 / 3) so
 * the property test can exercise the full upgrade path.
 *
 * The schema at each historical version mirrors what `applyUpgrade`
 * would have produced when stepping up to that version.
 */
async function seedUnifiedAtVersion(
  version: 1 | 2 | 3,
  rows: { meetings?: StoredMeeting[]; settings?: { key: string; value: unknown }[] },
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(__dbConstantsForTests.DB_NAME, version);
    request.onupgradeneeded = (event) => {
      const upgrading = request.result;
      const oldVersion = event.oldVersion;
      if (oldVersion < 1) {
        const meetings = upgrading.createObjectStore('meetings', { keyPath: 'id' });
        if (version >= 2) {
          meetings.createIndex('startedAt', 'startedAt', { unique: false });
          meetings.createIndex('mode', 'mode', { unique: false });
        }
        upgrading.createObjectStore('settings', { keyPath: 'key' });
        const documents = upgrading.createObjectStore('documents', { keyPath: 'id' });
        if (version >= 2) {
          documents.createIndex('type', 'type', { unique: false });
          documents.createIndex('createdAt', 'createdAt', { unique: false });
        }
      }
      if (oldVersion < 3 && version >= 3) {
        if (!upgrading.objectStoreNames.contains('custom_modes')) {
          upgrading.createObjectStore('custom_modes', { keyPath: 'id' });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['meetings', 'settings'], 'readwrite');
    if (rows.meetings) {
      for (const m of rows.meetings) tx.objectStore('meetings').put(m);
    }
    if (rows.settings) {
      for (const s of rows.settings) tx.objectStore('settings').put(s);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Read every store relevant to the migration into a sorted snapshot. */
async function snapshotUnifiedDB(): Promise<{
  meetings: StoredMeeting[];
  settings: { key: string; value: unknown }[];
  storeNames: string[];
}> {
  const db = await rawOpen(__dbConstantsForTests.DB_NAME);
  try {
    const meetings = await rawGetAll<StoredMeeting>(db, STORE_MEETINGS);
    const settings = await rawGetAll<{ key: string; value: unknown }>(db, STORE_SETTINGS);
    const storeNames = Array.from(db.objectStoreNames).sort();
    return {
      meetings: meetings.sort((a, b) => a.id.localeCompare(b.id)),
      settings: settings.sort((a, b) => a.key.localeCompare(b.key)),
      storeNames,
    };
  } finally {
    db.close();
  }
}

function makeMeeting(id: string, startedAt = 0): StoredMeeting {
  return {
    id,
    title: `Meeting ${id}`,
    mode: 'assist',
    startedAt,
    endedAt: startedAt + 1000,
    duration: 1000,
    transcript: [],
    summary: '',
    actionItems: [],
    aiSuggestionCount: 0,
    fillerCount: 0,
    avgConfidence: 0,
    wordsPerMinute: 0,
  };
}

// ---------------------------------------------------------------------
// Per-test isolation
// ---------------------------------------------------------------------

beforeEach(() => {
  resetIndexedDB();
});

// ---------------------------------------------------------------------
// Schema (Requirement 16.1, design.md §"Migration plan")
// ---------------------------------------------------------------------

describe('zule-unified v4 — schema', () => {
  it('creates all v4 stores on a fresh database', async () => {
    // Forcing an open path through the public API ensures the upgrade
    // handler runs end-to-end.
    await database.getAllMeetings();
    const snap = await snapshotUnifiedDB();
    expect(snap.storeNames).toEqual(
      [
        STORE_MEETINGS,
        STORE_SETTINGS,
        STORE_DOCUMENTS,
        STORE_MODES,
        STORE_MEMORY_FACTS,
        STORE_TELEMETRY,
        STORE_RESPONSE_CACHE,
        STORE_RATINGS,
        STORE_STYLE_PROFILE,
      ].sort(),
    );
  });

  it('creates the documented indexes', async () => {
    await database.getAllMeetings();
    const db = await rawOpen(__dbConstantsForTests.DB_NAME);
    try {
      const meetingsTx = db.transaction(STORE_MEETINGS, 'readonly');
      const meetings = meetingsTx.objectStore(STORE_MEETINGS);
      expect(Array.from(meetings.indexNames).sort()).toEqual(['mode', 'startedAt']);

      const docsTx = db.transaction(STORE_DOCUMENTS, 'readonly');
      const docs = docsTx.objectStore(STORE_DOCUMENTS);
      expect(Array.from(docs.indexNames).sort()).toEqual(['createdAt', 'type']);

      const memoryTx = db.transaction(STORE_MEMORY_FACTS, 'readonly');
      const memory = memoryTx.objectStore(STORE_MEMORY_FACTS);
      expect(Array.from(memory.indexNames).sort()).toEqual(['createdAt', 'meetingIds']);

      const telemetryTx = db.transaction(STORE_TELEMETRY, 'readonly');
      const telemetry = telemetryTx.objectStore(STORE_TELEMETRY);
      expect(Array.from(telemetry.indexNames).sort()).toEqual(['at', 'kind']);
    } finally {
      db.close();
    }
  });

  it('upgrades a v1 database to v4 in place without losing rows', async () => {
    const meeting = makeMeeting('legacy-1', 1);
    await seedUnifiedAtVersion(1, { meetings: [meeting] });

    // Force the unified DB through openDB → applies v1→v2→v3→v4 upgrade.
    const got = await database.getMeeting('legacy-1');
    expect(got?.id).toBe('legacy-1');
    const snap = await snapshotUnifiedDB();
    expect(snap.storeNames).toContain(STORE_MEMORY_FACTS);
    expect(snap.storeNames).toContain(STORE_RESPONSE_CACHE);
  });

  it('upgrades a v3 database to v4 in place without losing rows', async () => {
    const meeting = makeMeeting('v3-1', 2);
    await seedUnifiedAtVersion(3, { meetings: [meeting] });

    const got = await database.getMeeting('v3-1');
    expect(got?.id).toBe('v3-1');
    const snap = await snapshotUnifiedDB();
    expect(snap.storeNames).toContain(STORE_TELEMETRY);
    expect(snap.storeNames).toContain(STORE_STYLE_PROFILE);
  });
});

// ---------------------------------------------------------------------
// Legacy zule-store migration (Requirement 16.1)
// ---------------------------------------------------------------------

describe('zule-unified v4 — legacy zule-store migration', () => {
  it('copies meetings from zule-store, then deletes the legacy database', async () => {
    const m1 = makeMeeting('legacy-A', 100);
    const m2 = makeMeeting('legacy-B', 200);
    await seedLegacyZuleStore({
      meetings: [m1, m2],
      settings: [{ key: 'apiKey', value: 'plaintext-key' }],
    });

    // Run migration explicitly — the public API also runs it
    // implicitly on first open, but the explicit form makes the test
    // assertion deterministic.
    const result = await migrateLegacyZuleStore();
    expect(result.copiedMeetings).toBe(2);
    expect(result.copiedSettings).toBeGreaterThanOrEqual(1);

    // The unified DB now contains the legacy rows.
    const all = await database.getAllMeetings();
    expect(all.map((m) => m.id).sort()).toEqual(['legacy-A', 'legacy-B']);
    expect(await database.getSetting<string>('apiKey', '')).toBe('plaintext-key');

    // The legacy DB has been deleted.
    const remaining = await indexedDB.databases();
    expect(remaining.find((d) => d.name === 'zule-store')).toBeUndefined();
  });

  it('skips when there is no legacy database (no creation side-effect)', async () => {
    const result = await migrateLegacyZuleStore();
    expect(result.copiedMeetings).toBe(0);
    expect(result.copiedSettings).toBe(0);

    // Migration sets the flag in the unified DB but never creates the legacy DB.
    const remaining = await indexedDB.databases();
    expect(remaining.find((d) => d.name === 'zule-store')).toBeUndefined();
  });

  it('does not overwrite a unified row that already shares an id', async () => {
    // Pre-seed the unified DB with a meeting under id "shared".
    const newer = makeMeeting('shared', 999);
    newer.title = 'NEW';
    await database.saveMeeting(newer);

    // Legacy DB has a different (older) row under the same id.
    const older = makeMeeting('shared', 1);
    older.title = 'OLD';
    await seedLegacyZuleStore({ meetings: [older] });

    const result = await migrateLegacyZuleStore();
    expect(result.copiedMeetings).toBe(0); // collision skipped

    const got = await database.getMeeting('shared');
    expect(got?.title).toBe('NEW');
  });

  it('is a no-op on a second call (already-applied flag)', async () => {
    const m = makeMeeting('once', 1);
    await seedLegacyZuleStore({ meetings: [m] });

    const first = await migrateLegacyZuleStore();
    expect(first.alreadyApplied).toBe(false);
    expect(first.copiedMeetings).toBe(1);

    const second = await migrateLegacyZuleStore();
    expect(second.alreadyApplied).toBe(true);
    expect(second.copiedMeetings).toBe(0);
  });
});

// ---------------------------------------------------------------------
// apiKey → providers[].apiKeyCipher migration (Requirement 15.1, 16.2)
// ---------------------------------------------------------------------

describe('zule-unified v4 — apiKey re-encode', () => {
  it('returns vault-locked when the vault is not unlocked', async () => {
    await database.setSetting('apiKey', 'plaintext-key');
    const vault = new CryptoVault();
    const result = await migrateApiKeyToProviderCipher(vault);
    expect(result.migrated).toBe(false);
    if (!result.migrated) expect(result.reason).toBe('vault-locked');

    // The plaintext setting is preserved while we wait for unlock.
    expect(await database.getSetting<string>('apiKey', '')).toBe('plaintext-key');
  });

  it('moves a plaintext apiKey into providers[id=gemini].apiKeyCipher and clears the plaintext', async () => {
    await database.setSetting('apiKey', 'AIza-secret-123');

    const vault = new CryptoVault();
    const unlocked = await vault.unlock('passphrase');
    expect(unlocked.ok).toBe(true);

    const result = await migrateApiKeyToProviderCipher(vault);
    expect(result.migrated).toBe(true);
    if (!result.migrated) return;
    expect(result.providerId).toBe('gemini');

    expect(await database.getSetting<string>('apiKey', '')).toBe('');
    const providers = await database.getSetting<ProviderConfig[]>('providers', []);
    const gemini = providers.find((p) => p.id === 'gemini');
    expect(gemini).toBeDefined();
    expect(gemini?.apiKeyCipher).toBeDefined();
    expect(gemini?.apiKeyCipher).not.toBe('AIza-secret-123');

    // Round-trip: decrypting with the same vault recovers the secret.
    const dec = await vault.decrypt(gemini!.apiKeyCipher!);
    expect(dec.ok).toBe(true);
    if (dec.ok) expect(dec.value).toBe('AIza-secret-123');
  });

  it('is idempotent — calling twice with no plaintext key reports nothing to do', async () => {
    await database.setSetting('apiKey', 'k');
    const vault = new CryptoVault();
    await vault.unlock('p');

    const first = await migrateApiKeyToProviderCipher(vault);
    expect(first.migrated).toBe(true);

    const second = await migrateApiKeyToProviderCipher(vault);
    expect(second.migrated).toBe(false);
    if (!second.migrated) expect(second.reason).toBe('no-plaintext-key');
  });

  it('preserves an existing gemini provider entry (only sets apiKeyCipher)', async () => {
    await database.setSetting<ProviderConfig[]>('providers', [
      {
        id: 'gemini',
        enabled: true,
        priority: 0,
        baseUrl: 'https://example.test',
        pricePerMTokens: { input: 0.075, output: 0.3 },
      },
    ]);
    await database.setSetting('apiKey', 'k');

    const vault = new CryptoVault();
    await vault.unlock('p');
    await migrateApiKeyToProviderCipher(vault);

    const providers = await database.getSetting<ProviderConfig[]>('providers', []);
    const g = providers.find((p) => p.id === 'gemini')!;
    expect(g.baseUrl).toBe('https://example.test');
    expect(g.pricePerMTokens).toEqual({ input: 0.075, output: 0.3 });
    expect(g.apiKeyCipher).toBeDefined();
  });
});

// ---------------------------------------------------------------------
// Property 46 — Migration is idempotent
// Validates: Requirements 16.2
// ---------------------------------------------------------------------
//
// Statement: For any starting state in {legacy zule-store rows} ×
// {unified DB at version v ∈ {none, 1, 2, 3}} × {existing unified rows},
// the final state after running the migration once is equal to the final
// state after running the migration twice.
//
// We snapshot the meetings + settings + store names that the migration
// touches and assert deep-equal. Because the unified DB sets a
// `__migration.legacyZuleStoreCopied` flag during the first run, the
// second run is a no-op fast-path; this is the operational expression
// of idempotence.

describe('zule-unified v4 — Property 46: Migration is idempotent across all prior versions', () => {
  it('snapshot(open) === snapshot(open ; open) for any starting version and any seeded rows', async () => {
    const meetingArb: fc.Arbitrary<StoredMeeting> = fc
      .record({
        id: fc.stringMatching(/^[a-z0-9-]{1,16}$/).filter((s) => s.length > 0),
        startedAt: fc.integer({ min: 0, max: 10_000 }),
      })
      .map(({ id, startedAt }) => makeMeeting(id, startedAt));

    const settingArb = fc.record({
      key: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_.-]{0,31}$/),
      value: fc.oneof(
        fc.string({ maxLength: 32 }),
        fc.integer(),
        fc.boolean(),
        fc.constant(null),
      ) as fc.Arbitrary<unknown>,
    });

    await fc.assert(
      fc.asyncProperty(
        // Optional starting unified-DB version.
        fc.option(fc.constantFrom<1 | 2 | 3>(1, 2, 3), { nil: undefined }),
        // Optional rows in the unified DB at that starting version.
        fc.uniqueArray(meetingArb, { maxLength: 4, selector: (m) => m.id }),
        // Optional rows in the legacy zule-store DB.
        fc.uniqueArray(meetingArb, { maxLength: 4, selector: (m) => m.id }),
        // Optional settings in the legacy zule-store DB. Filter out the
        // internal migration-flag key so the property's snapshot focuses
        // on user data; the flag is asserted separately below.
        fc
          .uniqueArray(settingArb, { maxLength: 3, selector: (s) => s.key })
          .map((arr) =>
            arr.filter(
              (s) => s.key !== __dbConstantsForTests.MIGRATION_FLAG_LEGACY_COPY,
            ),
          ),
        async (priorVersion, unifiedRows, legacyRows, legacySettings) => {
          // Each property iteration starts from a clean factory so
          // database state from a previous shrink does not bleed in.
          resetIndexedDB();

          // ---- Seed the starting state ----------------------------
          if (priorVersion !== undefined) {
            await seedUnifiedAtVersion(priorVersion, { meetings: unifiedRows });
          } else if (unifiedRows.length > 0) {
            // No prior version: write through the v4 API so the
            // unified DB exists with the rows the test expects.
            for (const m of unifiedRows) {
              await database.saveMeeting(m);
            }
          }

          if (legacyRows.length > 0 || legacySettings.length > 0) {
            await seedLegacyZuleStore({
              meetings: legacyRows,
              settings: legacySettings,
            });
          }

          // ---- Run the migration once and snapshot ---------------
          await migrateLegacyZuleStore();
          const snapAfterFirst = await snapshotUnifiedDB();

          // The legacy DB must be gone after a successful first run
          // when there was anything to copy; if there was nothing,
          // the function still records the flag without creating it.
          const legacyAfterFirst = await indexedDB.databases();
          expect(
            legacyAfterFirst.find((d) => d.name === 'zule-store'),
          ).toBeUndefined();

          // ---- Run the migration again and snapshot --------------
          // Drop the cached promise so the second call really executes
          // the function body (including the alreadyApplied fast-path).
          __resetDatabaseForTests();
          const second = await migrateLegacyZuleStore();
          // The second call must be a clean no-op.
          expect(second.copiedMeetings).toBe(0);
          expect(second.copiedSettings).toBe(0);

          const snapAfterSecond = await snapshotUnifiedDB();

          // ---- Idempotence assertion ------------------------------
          expect(snapAfterSecond.storeNames).toEqual(snapAfterFirst.storeNames);
          expect(snapAfterSecond.meetings).toEqual(snapAfterFirst.meetings);

          // Compare settings ignoring the internal migration flag —
          // its presence is itself the idempotency witness, not a
          // semantic change to user data.
          const stripFlag = (
            arr: { key: string; value: unknown }[],
          ): { key: string; value: unknown }[] =>
            arr.filter(
              (s) => s.key !== __dbConstantsForTests.MIGRATION_FLAG_LEGACY_COPY,
            );
          expect(stripFlag(snapAfterSecond.settings)).toEqual(
            stripFlag(snapAfterFirst.settings),
          );
        },
      ),
      // Each iteration touches IndexedDB through fake-indexeddb several
      // times; keep the run count in line with the I/O cost while
      // still sampling the (priorVersion × rows × legacy) space.
      { numRuns: 24 },
    );
  }, 60_000);
});

// Suppress unused-import warnings when the deleteDB helper is unused.
void deleteDB;
