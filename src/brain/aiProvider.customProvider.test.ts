// ============================================
// Integration check: Settings → IndexedDB → Provider_Sync → AI_Provider_Router
// ============================================
//
// Feature: custom-openai-compatible-provider
//
// Task 9.2: drive the real `ensureProvidersSynced` over a real fake-IndexedDB
// `providers` row and observe the real router.
//
// **Validates: Requirements 1.4, 1.5**
//
// Honesty notes on the harness — `ensureProvidersSynced` and the singleton
// router are both module-private, so the test drives the public entry point
// (`generateAIResponse`) and observes the *real* `AI_Provider_Router` instance:
//
//   - `AI_Provider_Router.prototype.{registerAdapter,unregisterAdapter,setPriority}`
//     are spied with call-through, so the router's own logic still runs. The
//     spies are used to capture the singleton instance and the call sequence,
//     never to fake behaviour.
//   - The post-sync assertions read the router's actual internal adapter map
//     and priority list through a cast, so a passing test means the adapter is
//     genuinely registered/removed — not merely that a mock was invoked.
//   - `globalThis.fetch` is replaced by a throwing spy: the whole flow must
//     complete with zero HTTP egress (the request is served by the local
//     simulation adapter, which sits first in the priority list).
//
// Each test resets the module registry and installs a fresh `IDBFactory`, so
// the module-level `lastSyncedConfigHash` / `registeredNames` state in
// `aiProvider.ts` starts clean.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { ContextWindow } from './contextManager';
import type { ProviderConfig } from '../data/database';
import type { AI_Provider_Router as RouterType } from './providerRouter';
import type { ProviderAdapter } from '../types/ai';

// --- Fixtures ------------------------------------------------------------

const BASE_URL = 'https://gateway.example.com/v1';
const MODEL_ID = 'meta-llama/llama-3.1-8b-instruct';
/**
 * `secureKeyStorage.encryptApiKey` falls back to a `plain:`-prefixed value
 * when Electron's `safeStorage` bridge is absent (which it is under jsdom),
 * and `decryptApiKey` round-trips that form. So this is exactly the shape the
 * Settings panel persists in this environment — no keystore stubbing needed.
 */
const STORED_CIPHER = 'plain:sk-integration-test-credential';

/** A complete, enabled custom entry sitting last in the failover order. */
function enabledProviders(): ProviderConfig[] {
  return [
    { id: 'simulation', enabled: true, priority: 1 },
    {
      id: 'custom',
      enabled: true,
      priority: 6,
      baseUrl: BASE_URL,
      modelId: MODEL_ID,
      apiKeyCipher: STORED_CIPHER,
    },
  ];
}

/** The same entry with `enabled` flipped off; every other value identical. */
function disabledProviders(): ProviderConfig[] {
  return enabledProviders().map((p) =>
    p.id === 'custom' ? { ...p, enabled: false } : { ...p },
  );
}

/**
 * A prompt with no redaction attestation. Harmless here: the simulation
 * adapter answers first, and if anything ever did route to the custom adapter
 * its `assertRedacted` pre-flight would throw before any `fetch`.
 */
function promptWindow(): ContextWindow {
  return {
    systemPrompt: 'You are a helpful assistant.',
    knowledgeContext: '',
    transcriptContext: '',
    screenContext: '',
    userQuery: 'Summarise the last minute.',
    fullPrompt: 'You are a helpful assistant.\nSummarise the last minute.',
  };
}

// --- Router observation --------------------------------------------------

interface RouterInternals {
  adapters: Map<string, ProviderAdapter>;
  priority: string[];
}

interface Harness {
  /** The singleton router `aiProvider.ts` holds. */
  router: () => RouterType;
  registeredNames: () => string[];
  priorityList: () => string[];
  setPriorityCalls: string[][];
  unregisterCalls: Array<{ name: string; wasPresent: boolean }>;
  registerCalls: string[];
  fetchSpy: ReturnType<typeof vi.fn>;
}

describe('Provider_Sync integration: Settings → IndexedDB → router', () => {
  beforeEach(() => {
    // Fresh in-memory IDB and a fresh module graph per test.
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Install the call-through spies, then import `aiProvider` so its singleton
   * router is constructed inside the same (freshly reset) module registry.
   */
  async function bootstrap(): Promise<
    Harness & { generateAIResponse: typeof import('./aiProvider').generateAIResponse;
                subscribeProviderDiagnostics: typeof import('./aiProvider').subscribeProviderDiagnostics }
  > {
    const routerModule = await import('./providerRouter');
    const proto = routerModule.AI_Provider_Router.prototype;

    let captured: RouterType | undefined;
    const registerCalls: string[] = [];
    const unregisterCalls: Array<{ name: string; wasPresent: boolean }> = [];
    const setPriorityCalls: string[][] = [];

    const originalRegister = proto.registerAdapter;
    const originalUnregister = proto.unregisterAdapter;
    const originalSetPriority = proto.setPriority;

    vi.spyOn(proto, 'registerAdapter').mockImplementation(function (
      this: RouterType,
      adapter: ProviderAdapter,
    ) {
      captured = this;
      registerCalls.push(adapter.name);
      return originalRegister.call(this, adapter);
    });

    vi.spyOn(proto, 'unregisterAdapter').mockImplementation(function (
      this: RouterType,
      name: string,
    ) {
      captured = this;
      const wasPresent = originalUnregister.call(this, name);
      unregisterCalls.push({ name, wasPresent });
      return wasPresent;
    });

    vi.spyOn(proto, 'setPriority').mockImplementation(function (
      this: RouterType,
      order: string[],
    ) {
      captured = this;
      setPriorityCalls.push([...order]);
      return originalSetPriority.call(this, order);
    });

    // Zero-egress witness: any real network attempt fails the test.
    const fetchSpy = vi.fn(async () => {
      throw new Error('unexpected HTTP egress during Provider_Sync integration test');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const aiProvider = await import('./aiProvider');

    const internals = (): RouterInternals => {
      if (!captured) throw new Error('router instance was never observed');
      return captured as unknown as RouterInternals;
    };

    return {
      router: () => {
        if (!captured) throw new Error('router instance was never observed');
        return captured;
      },
      registeredNames: () => [...internals().adapters.keys()],
      priorityList: () => [...internals().priority],
      registerCalls,
      unregisterCalls,
      setPriorityCalls,
      fetchSpy,
      generateAIResponse: aiProvider.generateAIResponse,
      subscribeProviderDiagnostics: aiProvider.subscribeProviderDiagnostics,
    };
  }

  it('registers the custom adapter last in the priority list, then removes it on disable without touching the persisted record', async () => {
    const { database, __resetDatabaseForTests } = await import('../data/database');
    __resetDatabaseForTests();

    // --- Settings save: a complete, enabled custom configuration ----------
    await database.setSetting('providers', enabledProviders());

    const harness = await bootstrap();
    const { CustomOpenAICompatibleAdapter } = await import('./providers/custom');

    // --- First sync (driven through the public entry point) ---------------
    await harness.generateAIResponse(promptWindow());

    // Requirement 1.4 (positive direction): an enabled, complete entry is
    // registered under the `custom` id and takes the last failover position.
    expect(harness.registeredNames()).toContain('custom');
    expect(harness.router()).toBeDefined();
    const adapter = (harness.router() as unknown as RouterInternals).adapters.get('custom');
    expect(adapter).toBeInstanceOf(CustomOpenAICompatibleAdapter);
    expect(adapter?.name).toBe('custom');

    const priorityAfterEnable = harness.priorityList();
    expect(priorityAfterEnable).toContain('custom');
    expect(priorityAfterEnable[priorityAfterEnable.length - 1]).toBe('custom');
    expect(harness.setPriorityCalls.at(-1)).toEqual(['simulation', 'custom']);

    // The request was served locally; nothing left the machine.
    expect(harness.fetchSpy).not.toHaveBeenCalled();

    // --- Settings save: the same entry, disabled --------------------------
    await database.setSetting('providers', disabledProviders());

    const diagnostics: Array<{ kind: string; providerId: string }> = [];
    const unsubscribe = harness.subscribeProviderDiagnostics((d) => {
      diagnostics.push({ kind: d.kind, providerId: d.providerId });
    });

    // The byte-for-byte baseline of the persisted row, taken *after* the save
    // and *before* the re-sync (Requirement 1.5: Provider_Sync never writes).
    const persistedBefore = JSON.stringify(
      await database.getSetting<ProviderConfig[]>('providers', []),
    );

    // --- Re-sync (the config hash changed, so the short-circuit lifts) ----
    await harness.generateAIResponse(promptWindow());
    unsubscribe();

    // Requirement 1.5: the adapter is gone from the router and from the
    // priority list, and the removal was reported as a configuration error.
    expect(harness.unregisterCalls).toEqual(
      expect.arrayContaining([{ name: 'custom', wasPresent: true }]),
    );
    expect(harness.registeredNames()).not.toContain('custom');
    expect(harness.priorityList()).not.toContain('custom');
    expect(harness.setPriorityCalls.at(-1)).toEqual(['simulation']);
    expect(diagnostics).toEqual([
      { kind: 'custom.disabled-while-registered', providerId: 'custom' },
    ]);

    // Requirement 1.5: the persisted record is byte-identical.
    const persistedAfter = JSON.stringify(
      await database.getSetting<ProviderConfig[]>('providers', []),
    );
    expect(persistedAfter).toBe(persistedBefore);
    expect(JSON.parse(persistedAfter)).toEqual(disabledProviders());

    // Still zero egress across both syncs.
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });
});
