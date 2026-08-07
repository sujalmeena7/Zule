// Zule AI — Per-account data isolation tests
// ============================================
//
// Regression cover for the bug where a freshly created account opened
// onto the previous account's dashboard: every account shared a single
// `zule-unified` IndexedDB, so meetings, Knowledge_Base documents and
// the cached subscription tier bled across sign-ins.
//
// The contract these tests pin down:
//   1. Each uid reads and writes a physically separate database.
//   2. A brand-new account starts empty — no meetings, no documents,
//      no inherited settings.
//   3. Switching back to the original account still finds its data.
//   4. A pre-partitioning (`zule-unified`) install is adopted by the
//      first account to sign in, and by that account only.

import { describe, expect, it, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import {
  database,
  setActiveUser,
  getActiveUserId,
  __resetDatabaseForTests,
  __dbConstantsForTests,
  STORE_MEETINGS,
  STORE_SETTINGS,
  type StoredMeeting,
} from './database';

const UID_A = 'user-alice-123';
const UID_B = 'user-bob-456';

function resetIndexedDB(): void {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  __resetDatabaseForTests();
}

function meeting(id: string, title: string, userId?: string): StoredMeeting {
  return {
    id,
    userId,
    title,
    mode: 'general',
    startedAt: 1_000,
    endedAt: 2_000,
    duration: 1_000,
    transcript: [],
    summary: '',
    actionItems: [],
    aiSuggestionCount: 0,
    fillerCount: 0,
    avgConfidence: 1,
    wordsPerMinute: 100,
  };
}

/** Seed a pre-partitioning `zule-unified` DB holding one meeting. */
function seedSharedDatabase(rows: StoredMeeting[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      __dbConstantsForTests.SHARED_DB_NAME,
      __dbConstantsForTests.DB_VERSION,
    );
    request.onupgradeneeded = () => {
      const db = request.result;
      const meetings = db.createObjectStore(STORE_MEETINGS, { keyPath: 'id' });
      meetings.createIndex('startedAt', 'startedAt', { unique: false });
      db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE_MEETINGS, 'readwrite');
      for (const row of rows) tx.objectStore(STORE_MEETINGS).put(row);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

describe('per-account data isolation', () => {
  beforeEach(() => {
    resetIndexedDB();
  });

  it('gives each account its own database name', () => {
    const { dbNameForUser } = __dbConstantsForTests;
    expect(dbNameForUser(UID_A)).not.toBe(dbNameForUser(UID_B));
    // Neither account may land on the shared pre-partitioning database.
    expect(dbNameForUser(UID_A)).not.toBe(__dbConstantsForTests.SHARED_DB_NAME);
    expect(dbNameForUser(null)).not.toBe(__dbConstantsForTests.SHARED_DB_NAME);
  });

  it('tracks the active account', async () => {
    expect(getActiveUserId()).toBeNull();
    await setActiveUser(UID_A);
    expect(getActiveUserId()).toBe(UID_A);
    await setActiveUser(null);
    expect(getActiveUserId()).toBeNull();
  });

  it('does not show account A meetings to a brand-new account B', async () => {
    await setActiveUser(UID_A);
    await database.saveMeeting(meeting('m1', 'Alice standup', UID_A));
    await database.saveMeeting(meeting('m2', 'Alice 1:1', UID_A));
    expect(await database.getAllMeetings()).toHaveLength(2);

    await setActiveUser(UID_B);
    expect(await database.getAllMeetings()).toEqual([]);
  });

  it('hides meetings that carry no userId tag from other accounts', async () => {
    // Untagged rows were the leak: the old filter passed `!m.userId`,
    // so anything saved without a uid was visible to everyone.
    await setActiveUser(UID_A);
    await database.saveMeeting(meeting('untagged', 'Legacy meeting'));
    expect(await database.getAllMeetings(UID_A)).toHaveLength(1);

    await setActiveUser(UID_B);
    expect(await database.getAllMeetings(UID_B)).toEqual([]);
    expect(await database.getAllMeetings()).toEqual([]);
  });

  it('does not leak Knowledge_Base documents into a new account', async () => {
    await setActiveUser(UID_A);
    await database.addDocument('Alice resume', 'confidential career history', 'resume', [
      { text: 'confidential career history', vector: [0.1, 0.2, 0.3] },
    ]);
    expect(await database.getAllDocuments()).toHaveLength(1);

    await setActiveUser(UID_B);
    expect(await database.getAllDocuments()).toEqual([]);
  });

  it('does not leak settings such as the cached subscription tier', async () => {
    await setActiveUser(UID_A);
    await database.setSetting('subscription_cache', { plan: 'ultra', status: 'active' });
    expect(await database.getSetting('subscription_cache', null)).toEqual({
      plan: 'ultra',
      status: 'active',
    });

    await setActiveUser(UID_B);
    // A fresh account must fall back to the default, not inherit "ultra".
    expect(await database.getSetting('subscription_cache', null)).toBeNull();
  });

  it('preserves each account’s data across a switch back', async () => {
    await setActiveUser(UID_A);
    await database.saveMeeting(meeting('a1', 'Alice meeting', UID_A));

    await setActiveUser(UID_B);
    await database.saveMeeting(meeting('b1', 'Bob meeting', UID_B));

    await setActiveUser(UID_A);
    const alice = await database.getAllMeetings();
    expect(alice.map((m) => m.id)).toEqual(['a1']);

    await setActiveUser(UID_B);
    const bob = await database.getAllMeetings();
    expect(bob.map((m) => m.id)).toEqual(['b1']);
  });

  it('adopts a pre-partitioning install into the first account only', async () => {
    await seedSharedDatabase([meeting('old1', 'Pre-upgrade meeting')]);

    // First account to sign in inherits the existing local data.
    await setActiveUser(UID_A);
    const adopted = await database.getAllMeetings();
    expect(adopted.map((m) => m.title)).toEqual(['Pre-upgrade meeting']);

    // A second, newly created account must start empty.
    await setActiveUser(UID_B);
    expect(await database.getAllMeetings()).toEqual([]);

    // And the claim is stable: re-signing in as A still sees its data,
    // while B stays empty on a repeat sign-in.
    await setActiveUser(UID_A);
    expect(await database.getAllMeetings()).toHaveLength(1);
    await setActiveUser(UID_B);
    expect(await database.getAllMeetings()).toEqual([]);
  });

  it('is a no-op when the same account is re-selected', async () => {
    await setActiveUser(UID_A);
    await database.saveMeeting(meeting('m1', 'Alice meeting', UID_A));
    await setActiveUser(UID_A);
    expect(await database.getAllMeetings()).toHaveLength(1);
  });
});
