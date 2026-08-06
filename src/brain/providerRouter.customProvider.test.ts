// ============================================
// Tests for the AI_Provider_Router additions that serve the
// Custom (OpenAI-compatible) provider
// ============================================
//
// Feature: custom-openai-compatible-provider
//
// Task 7.2: Example tests for `LOCAL_PROVIDER_NAMES` membership and
//           `unregisterAdapter`.
//
// Later tasks append Property 8 (cloud gates), Property 9 (privacy Profile),
// and Property 10 (429 cooldown) to this file, so each concern lives in its
// own top-level `describe`.
//
// **Validates: Requirements 1.5, 2.2**

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { IDBFactory } from 'fake-indexeddb';
import {
  AI_Provider_Router,
  AllProvidersFailedError,
  LOCAL_PROVIDER_NAMES,
  OfflineError,
  VaultLockedError,
} from './providerRouter';
import { CustomOpenAICompatibleAdapter } from './providers/custom';
import {
  LOCAL_PROVIDER_ID,
  ModelSelectorError,
  selectModel,
  type ModelEntry,
} from './modelSelector';
import type { CopilotMode } from './modePrompts';
import {
  database,
  __dbConstantsForTests,
  __resetDatabaseForTests,
  STORE_DOCUMENTS,
  type KBDocument,
  type StoredMeeting,
} from '../data/database';
import type {
  CallOpts,
  Capabilities,
  ProviderAdapter,
  ProviderResponse,
  PromptInput,
  StreamCallbacks,
} from '../types/ai';

// --- Test helpers --------------------------------------------------------
// Deliberately mirrors the harness style of `providerRouter.test.ts` so both
// suites read the same way.

const DEFAULT_CAPABILITIES: Capabilities = {
  streaming: true,
  imageInput: false,
  toolUse: false,
  maxInputTokens: 8_000,
  pricePerMTokens: { input: 0, output: 0 },
};

/**
 * A prompt carrying a complete redaction attestation, so nothing in these
 * tests is blocked by the custom adapter's pre-flight guard for the wrong
 * reason.
 */
const ATTESTED_PROMPT: PromptInput = {
  systemPrompt: 'You are a helpful assistant.',
  userText: 'Hello',
  fullPrompt: 'You are a helpful assistant.\nHello',
  redaction: {
    applied: true,
    ruleCount: 2,
    segmentsTotal: 3,
    segmentsRedacted: 3,
  },
};

function makeSuccessResponse(providerId: string): ProviderResponse {
  return {
    text: `Response from ${providerId}`,
    promptTokens: 10,
    completionTokens: 5,
    modelId: 'test-model',
    providerId,
    isSimulated: false,
    status: 200,
  };
}

/** A fake adapter that records every `complete` / `streamGenerate` call. */
function createMockAdapter(
  name: string,
  opts: { callLog?: string[] } = {},
): ProviderAdapter {
  const callLog = opts.callLog ?? [];

  return {
    name,
    capabilities: DEFAULT_CAPABILITIES,
    countTokens: (text: string) => Math.ceil(text.length / 4),
    complete: vi.fn(async (_prompt: PromptInput, _opts: CallOpts) => {
      callLog.push(`complete:${name}`);
      return makeSuccessResponse(name);
    }),
    streamGenerate: vi.fn(
      async (_prompt: PromptInput, cb: StreamCallbacks, _opts: CallOpts) => {
        callLog.push(`stream:${name}`);
        cb.onToken('Hello');
        cb.onComplete(makeSuccessResponse(name));
      },
    ),
  };
}

/**
 * A real custom adapter with an injected `fetch` that fails the test if it is
 * ever called — these tests assert routing, never egress.
 *
 * `fetchImpl` may be overridden with a spy so a caller can assert *zero*
 * egress directly (`expect(spy).not.toHaveBeenCalled()`) rather than infer it
 * from the absence of a thrown error.
 */
function createRealCustomAdapter(
  fetchImpl?: typeof fetch,
): CustomOpenAICompatibleAdapter {
  return new CustomOpenAICompatibleAdapter({
    baseUrl: 'https://gateway.example.com/v1',
    modelId: 'some-model',
    apiKey: 'sk-test-key-1234567890',
    fetchImpl:
      fetchImpl ??
      ((async () => {
        throw new Error('fetch must not be called by these tests');
      }) as unknown as typeof fetch),
    telemetrySink: () => {},
  });
}

// --- LOCAL_PROVIDER_NAMES invariant --------------------------------------

describe('LOCAL_PROVIDER_NAMES membership invariant', () => {
  // The single most important regression guard in this feature. Every cloud
  // gate in the router (vault-locked, offline, 429 cooldown) keys off *non*-
  // membership here, so a remote gateway inside this set would ship transcript
  // content off-device while the app believes it is offline.
  //
  // **Validates: Requirements 2.2**

  it('is exactly {ollama, simulation}', () => {
    expect(LOCAL_PROVIDER_NAMES).toEqual(new Set(['ollama', 'simulation']));
    expect(LOCAL_PROVIDER_NAMES.size).toBe(2);
    expect(LOCAL_PROVIDER_NAMES.has('ollama')).toBe(true);
    expect(LOCAL_PROVIDER_NAMES.has('simulation')).toBe(true);
  });

  it('does not contain the custom provider id', () => {
    expect(LOCAL_PROVIDER_NAMES.has('custom')).toBe(false);
  });

  it('is unchanged after the custom adapter is registered', () => {
    const router = new AI_Provider_Router();
    const custom = createRealCustomAdapter();

    expect(custom.name).toBe('custom');

    router.registerAdapter(custom);
    router.setPriority(['ollama', 'custom']);

    expect(LOCAL_PROVIDER_NAMES).toEqual(new Set(['ollama', 'simulation']));
    expect(LOCAL_PROVIDER_NAMES.has('custom')).toBe(false);
  });

  it('is unchanged after the custom adapter is registered and removed', () => {
    const router = new AI_Provider_Router();
    router.registerAdapter(createRealCustomAdapter());
    router.unregisterAdapter('custom');

    expect(LOCAL_PROVIDER_NAMES).toEqual(new Set(['ollama', 'simulation']));
  });
});

// --- unregisterAdapter ---------------------------------------------------

describe('AI_Provider_Router.unregisterAdapter', () => {
  // Requirement 1.5: a Custom_Provider_Adapter whose config has been disabled
  // must be removed so that no subsequent request can be routed to it.
  //
  // **Validates: Requirements 1.5**

  it('returns true for a registered adapter and false on a second call', () => {
    const router = new AI_Provider_Router();
    router.registerAdapter(createMockAdapter('custom'));

    expect(router.unregisterAdapter('custom')).toBe(true);
    expect(router.unregisterAdapter('custom')).toBe(false);
  });

  it('returns false for an adapter that was never registered', () => {
    const router = new AI_Provider_Router();
    expect(router.unregisterAdapter('custom')).toBe(false);
  });

  it('performs zero invocations of the removed adapter on a later completion', async () => {
    const router = new AI_Provider_Router();
    const callLog: string[] = [];
    const custom = createMockAdapter('custom', { callLog });

    router.registerAdapter(custom);
    router.registerAdapter(createMockAdapter('simulation', { callLog }));
    router.setPriority(['custom', 'simulation']);
    router.setVaultLocked(false);

    expect(router.unregisterAdapter('custom')).toBe(true);

    const result = await router.complete(ATTESTED_PROMPT);

    expect(result.providerId).toBe('simulation');
    expect(callLog).toEqual(['complete:simulation']);
    expect(custom.complete).not.toHaveBeenCalled();
  });

  it('performs zero invocations of the removed adapter on a later stream', async () => {
    const router = new AI_Provider_Router();
    const callLog: string[] = [];
    const custom = createMockAdapter('custom', { callLog });

    router.registerAdapter(custom);
    router.registerAdapter(createMockAdapter('simulation', { callLog }));
    router.setPriority(['custom', 'simulation']);
    router.setVaultLocked(false);

    router.unregisterAdapter('custom');

    await router.stream(ATTESTED_PROMPT, {
      onToken: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    expect(callLog).toEqual(['stream:simulation']);
    expect(custom.streamGenerate).not.toHaveBeenCalled();
  });

  it('drops the name from the priority list, so a re-registered adapter is tried last', async () => {
    const router = new AI_Provider_Router();
    const callLog: string[] = [];

    router.registerAdapter(createMockAdapter('custom', { callLog }));
    router.registerAdapter(createMockAdapter('simulation', { callLog }));
    router.setPriority(['custom', 'simulation']);
    router.setVaultLocked(false);

    router.unregisterAdapter('custom');
    // Re-register without touching the priority list. If `custom` were still
    // listed there it would be tried first again; because `unregisterAdapter`
    // removed it, it can only be appended after the listed adapters.
    router.registerAdapter(createMockAdapter('custom', { callLog }));

    await router.complete(ATTESTED_PROMPT);

    expect(callLog).toEqual(['complete:simulation']);
  });

  it('leaves other registered adapters and their order untouched', async () => {
    const router = new AI_Provider_Router();
    const callLog: string[] = [];

    router.registerAdapter(createMockAdapter('custom', { callLog }));
    router.registerAdapter(createMockAdapter('gemini', { callLog }));
    router.registerAdapter(createMockAdapter('ollama', { callLog }));
    router.setPriority(['custom', 'gemini', 'ollama']);
    router.setVaultLocked(false);

    router.unregisterAdapter('custom');

    const result = await router.complete(ATTESTED_PROMPT);

    expect(result.providerId).toBe('gemini');
    expect(callLog).toEqual(['complete:gemini']);
  });
});

// --- Property 8: the cloud gates -----------------------------------------

/**
 * The other adapter names a scenario may register alongside `custom`.
 * Deliberately mixes both allowlisted local names with three cloud names, so
 * the generated priority orderings interleave gated and un-gated adapters.
 */
const OTHER_ADAPTER_NAMES = [
  'ollama',
  'simulation',
  'gemini',
  'openai',
  'anthropic',
] as const;

/** The settings key standing in for the persisted screen text. */
const SCREEN_TEXT_KEY = 'lastScreenText';
const SEEDED_SCREEN_TEXT = 'Screen: invoice 4111 1111 1111 1111 for Acme';

function seededMeeting(): StoredMeeting {
  return {
    id: 'meeting-property-8',
    title: 'Acme renewal call',
    mode: 'sales',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_600_000,
    duration: 600,
    transcript: [
      {
        id: 'line-1',
        text: 'Our budget for the renewal is confidential.',
        timestamp: 1_700_000_010_000,
        speaker: 'Them',
      },
      {
        id: 'line-2',
        text: 'Reach me at ada@example.com after the call.',
        timestamp: 1_700_000_020_000,
        speaker: 'Me',
      },
    ],
    summary: '',
    actionItems: [],
    aiSuggestionCount: 0,
    fillerCount: 0,
    avgConfidence: 0.9,
    wordsPerMinute: 120,
  };
}

function seededDocument(): KBDocument {
  return {
    id: 'doc-property-8',
    title: 'Acme runbook',
    content: 'Knowledge_Base excerpt: Acme deal terms and internal pricing.',
    type: 'notes',
    chunks: [
      {
        text: 'Knowledge_Base excerpt: Acme deal terms and internal pricing.',
        vector: [0.1, 0.2, 0.3],
      },
    ],
    createdAt: 1_699_999_000_000,
  };
}

/**
 * Writes a Knowledge_Base row directly. `database.addDocument` would pull the
 * Transformers.js quantizer into this suite for no benefit — the row's content
 * is all this property needs.
 */
async function seedDocumentRow(doc: KBDocument): Promise<void> {
  // Force the module to create the schema before we open a second connection.
  await database.getAllDocuments();

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(
      __dbConstantsForTests.DB_NAME,
      __dbConstantsForTests.DB_VERSION,
    );
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_DOCUMENTS, 'readwrite');
    tx.objectStore(STORE_DOCUMENTS).put(doc);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  db.close();
}

interface GateScenario {
  /** Registration order; also the priority list, so both orders coincide. */
  priority: string[];
  vaultLocked: boolean;
  offline: boolean;
  entryPoint: 'complete' | 'stream';
}

/**
 * Any registration set that includes `custom`, in any priority ordering, with
 * at least one gate closed, entered through either `complete` or `stream`.
 */
const gateScenarioArb: fc.Arbitrary<GateScenario> = fc
  .subarray([...OTHER_ADAPTER_NAMES])
  .chain((others) => {
    const registered = [...others, 'custom'];
    return fc.record({
      priority: fc.shuffledSubarray(registered, {
        minLength: registered.length,
        maxLength: registered.length,
      }),
      vaultLocked: fc.boolean(),
      offline: fc.boolean(),
      entryPoint: fc.constantFrom<'complete' | 'stream'>('complete', 'stream'),
    });
  })
  // A gate state in which the vault is locked OR there is no connectivity.
  .filter((s) => s.vaultLocked || s.offline);

describe('Cloud gates block the Custom_Provider', () => {
  beforeEach(async () => {
    // Fresh in-memory IDB per test so the local-state snapshot is deterministic.
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB =
      new IDBFactory();
    __resetDatabaseForTests();

    await database.saveMeeting(seededMeeting());
    await database.setSetting(SCREEN_TEXT_KEY, SEEDED_SCREEN_TEXT);
    await seedDocumentRow(seededDocument());

    // The router logs every gate skip; 100 runs of that is noise.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The machine-checkable reading of "retain the unsent transcript text,
   * screen text, and Knowledge_Base excerpts in local storage unmodified".
   */
  async function snapshotLocalState(): Promise<string> {
    const [meetings, documents, screenText] = await Promise.all([
      database.getAllMeetings(),
      database.getAllDocuments(),
      database.getSetting<string>(SCREEN_TEXT_KEY, ''),
    ]);
    return JSON.stringify({ meetings, documents, screenText });
  }

  // Feature: custom-openai-compatible-provider, Property 8: Cloud gates block the
  // Custom_Provider with zero invocations and zero egress
  //
  // **Validates: Requirements 2.2, 2.3, 2.4, 2.5**
  it('never invokes the custom adapter, never issues a request, and refuses with the vault-locked or offline cause', async () => {
    await fc.assert(
      fc.asyncProperty(gateScenarioArb, async (scenario) => {
        const { priority, vaultLocked, offline, entryPoint } = scenario;

        // The zero-egress witness: the adapter's injected fetch.
        const fetchSpy = vi.fn(async () => {
          throw new Error('egress while a cloud gate is closed');
        });
        const custom = createRealCustomAdapter(
          fetchSpy as unknown as typeof fetch,
        );
        const completeSpy = vi.spyOn(custom, 'complete');
        const streamSpy = vi.spyOn(custom, 'streamGenerate');

        const callLog: string[] = [];
        const router = new AI_Provider_Router();
        for (const name of priority) {
          router.registerAdapter(
            name === 'custom' ? custom : createMockAdapter(name, { callLog }),
          );
        }
        router.setPriority(priority);
        router.setVaultLocked(vaultLocked);
        router.setOffline(offline);

        const before = await snapshotLocalState();
        // Guard against a vacuous "unmodified" clause: the snapshot really
        // does carry transcript, screen, and Knowledge_Base content.
        expect(before).toContain('confidential');
        expect(before).toContain(SEEDED_SCREEN_TEXT);
        expect(before).toContain('Knowledge_Base excerpt');

        // The first allowlisted adapter is the only one that can serve the
        // request; the last gated adapter is the one the refusal names.
        const firstLocal = priority.find((n) => LOCAL_PROVIDER_NAMES.has(n));
        const lastGated = [...priority]
          .reverse()
          .find((n) => !LOCAL_PROVIDER_NAMES.has(n));

        let response: ProviderResponse | null = null;
        let thrown: unknown = null;
        try {
          if (entryPoint === 'complete') {
            response = await router.complete(ATTESTED_PROMPT);
          } else {
            await router.stream(ATTESTED_PROMPT, {
              onToken: () => {},
              onComplete: () => {},
              onError: () => {},
            });
          }
        } catch (err) {
          thrown = err;
        }

        // Requirements 2.3, 2.4 — zero invocations and zero HTTP requests.
        expect(completeSpy).not.toHaveBeenCalled();
        expect(streamSpy).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();

        if (firstLocal === undefined) {
          // Requirement 2.5 — no allowlisted adapter remains, so the router
          // rejects with the gate's own error, rethrown verbatim (never
          // wrapped in AllProvidersFailedError).
          expect(thrown).toBeInstanceOf(offline ? OfflineError : VaultLockedError);
          const message = (thrown as Error).message;
          expect(message).toMatch(offline ? /offline/i : /locked/i);
          expect(message).toContain(lastGated);
          expect(callLog).toEqual([]);
        } else {
          // An allowlisted adapter remains, so it serves the request while the
          // gated ones — `custom` among them — are skipped.
          expect(thrown).toBeNull();
          expect(callLog).toEqual([
            `${entryPoint === 'complete' ? 'complete' : 'stream'}:${firstLocal}`,
          ]);
          if (entryPoint === 'complete') {
            expect(response?.providerId).toBe(firstLocal);
          }
        }

        // Requirement 2.5 — the unsent local state is untouched.
        expect(await snapshotLocalState()).toBe(before);
      }),
      { numRuns: 100 },
    );
  });
});

// --- Property 10: the 429 cooldown ---------------------------------------

/** Mirrors the Base_URL `createRealCustomAdapter` configures. */
const CUSTOM_BASE_URL = 'https://gateway.example.com/v1';
const CUSTOM_ENDPOINT = `${CUSTOM_BASE_URL}/chat/completions`;

/** The router's `RATE_LIMIT_COOLDOWN_MS`, restated so the boundary is explicit. */
const COOLDOWN_MS = 300_000;

/**
 * The error shape `throwIfNotOk` in `openAICompatible.ts` produces for a 429:
 * a plain `Error` carrying `providerId` and a numeric `status`. The router's
 * `is429Error` keys on that `status`, so this is what it classifies.
 */
function make429Error(): Error {
  const err = new Error(
    'OpenAICompatibleAdapter[custom]: HTTP 429 Too Many Requests — {"error":"rate limit exceeded"}',
  ) as Error & { providerId: string; status: number };
  err.providerId = 'custom';
  err.status = 429;
  return err;
}

/**
 * A real `CustomOpenAICompatibleAdapter` (so `name` comes from the class under
 * test, not from a string literal) whose transport is short-circuited: each
 * invocation issues exactly one request to the Base_URL through the injected
 * fetch spy and then rejects with the 429 error shape above.
 *
 * The transport is short-circuited rather than driven through a canned 429
 * `Response` because the real path wraps `fetch` in `retryWithJitter`, whose
 * backoff sleeps use `setTimeout`; under `vi.useFakeTimers()` those sleeps
 * would only resolve if the test advanced the very clock whose 300 000 ms
 * boundary is the subject of this property.
 */
function createRateLimitedCustomAdapter(callLog: string[]): {
  adapter: CustomOpenAICompatibleAdapter;
  fetchSpy: ReturnType<typeof vi.fn>;
} {
  // The return value is never read — the short-circuit rejects instead.
  const fetchSpy = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      ({ ok: false, status: 429, statusText: 'Too Many Requests' }) as unknown as Response,
  );
  const adapter = createRealCustomAdapter(fetchSpy as unknown as typeof fetch);

  adapter.complete = async (): Promise<ProviderResponse> => {
    callLog.push('complete:custom');
    await fetchSpy(CUSTOM_ENDPOINT, { method: 'POST' });
    throw make429Error();
  };
  adapter.streamGenerate = async (): Promise<void> => {
    callLog.push('stream:custom');
    await fetchSpy(CUSTOM_ENDPOINT, { method: 'POST' });
    throw make429Error();
  };

  return { adapter, fetchSpy };
}

/**
 * A non-custom adapter that always fails with a transport error. Because a
 * `TypeError` is a failover trigger, the router walks the *whole* priority
 * list on every call, which makes `callLog` an exact record of the attempt
 * order — the observable this property compares before and after the cooldown.
 */
function createFailingAdapter(name: string, callLog: string[]): ProviderAdapter {
  return {
    name,
    capabilities: DEFAULT_CAPABILITIES,
    countTokens: (text: string) => Math.ceil(text.length / 4),
    complete: async (): Promise<ProviderResponse> => {
      callLog.push(`complete:${name}`);
      throw new TypeError('Failed to fetch');
    },
    streamGenerate: async (): Promise<void> => {
      callLog.push(`stream:${name}`);
      throw new TypeError('Failed to fetch');
    },
  };
}

/** Runs one request through the router and returns the thrown error, if any. */
async function runRequest(
  router: AI_Provider_Router,
  entryPoint: 'complete' | 'stream',
): Promise<unknown> {
  try {
    if (entryPoint === 'complete') {
      await router.complete(ATTESTED_PROMPT);
    } else {
      await router.stream(ATTESTED_PROMPT, {
        onToken: () => {},
        onComplete: () => {},
        onError: () => {},
      });
    }
    return null;
  } catch (err) {
    return err;
  }
}

interface CooldownScenario {
  /** Registration order; also the priority list, so both orders coincide. */
  priority: string[];
  /** Offset from the instant the 429 was received. */
  elapsedMs: number;
  entryPoint: 'complete' | 'stream';
}

/**
 * Uniform offsets across the window plus the exact boundary values, so the
 * 300 000 ms edge is hit from both sides rather than only sampled near it.
 */
const elapsedArb = fc.oneof(
  fc.integer({ min: 0, max: 600_000 }),
  fc.constantFrom(0, 1, COOLDOWN_MS - 1, COOLDOWN_MS, COOLDOWN_MS + 1, 600_000),
);

const cooldownScenarioArb: fc.Arbitrary<CooldownScenario> = fc
  .subarray([...OTHER_ADAPTER_NAMES])
  .chain((others) => {
    const registered = [...others, 'custom'];
    return fc.record({
      priority: fc.shuffledSubarray(registered, {
        minLength: registered.length,
        maxLength: registered.length,
      }),
      elapsedMs: elapsedArb,
      entryPoint: fc.constantFrom<'complete' | 'stream'>('complete', 'stream'),
    });
  });

describe('The Custom_Provider 429 cooldown', () => {
  beforeEach(() => {
    // The cooldown boundary is measured on the mocked clock, so `Date.now()`
    // only moves when the test advances it.
    vi.useFakeTimers();
    // The router logs every attempt and every cooldown skip; 100 runs of that
    // is noise.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Feature: custom-openai-compatible-provider, Property 10: A 429 suppresses the
  // Custom_Provider for exactly 300 000 ms and then restores its position
  //
  // **Validates: Requirements 2.7, 2.8**
  it('suppresses the custom adapter for exactly 300 000 ms, then restores its original position', async () => {
    await fc.assert(
      fc.asyncProperty(cooldownScenarioArb, async (scenario) => {
        const { priority, elapsedMs, entryPoint } = scenario;
        const verb = entryPoint === 'complete' ? 'complete' : 'stream';

        const callLog: string[] = [];
        const { adapter: custom, fetchSpy } =
          createRateLimitedCustomAdapter(callLog);

        const router = new AI_Provider_Router();
        for (const name of priority) {
          router.registerAdapter(
            name === 'custom' ? custom : createFailingAdapter(name, callLog),
          );
        }
        router.setPriority(priority);
        // The vault is unlocked and the application reports connectivity, so
        // the cooldown is the only gate in play (Requirement 2.8).
        router.setVaultLocked(false);
        router.setOffline(false);

        const expectedOrder = priority.map((name) => `${verb}:${name}`);

        // --- Phase 1: receive the 429 --------------------------------------
        const beforeFirstCall = Date.now();
        const firstError = await runRequest(router, entryPoint);

        // Every adapter fails, so the router walks the whole list and the log
        // is the attempt order. `custom` really was invoked and really did
        // return 429 — without this the rest of the property is vacuous.
        expect(callLog).toEqual(expectedOrder);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(firstError).toBeInstanceOf(AllProvidersFailedError);

        // Nothing in the call path touches a timer, so the mocked clock has
        // not moved: the cooldown start instant is exactly this instant
        // (Requirement 2.7).
        const receiptInstant = Date.now();
        expect(receiptInstant).toBe(beforeFirstCall);

        // --- Phase 2: t ms after the receipt instant -----------------------
        vi.advanceTimersByTime(elapsedMs);
        expect(Date.now()).toBe(receiptInstant + elapsedMs);

        callLog.length = 0;
        fetchSpy.mockClear();

        const secondError = await runRequest(router, entryPoint);
        expect(secondError).toBeInstanceOf(AllProvidersFailedError);

        if (elapsedMs < COOLDOWN_MS) {
          // Requirement 2.7 — zero invocations of `complete` / `streamGenerate`
          // and zero HTTP requests to the Base_URL during the window.
          expect(callLog).not.toContain(`${verb}:custom`);
          expect(callLog).toEqual(
            expectedOrder.filter((entry) => entry !== `${verb}:custom`),
          );
          expect(fetchSpy).not.toHaveBeenCalled();
        } else {
          // Requirement 2.8 — the adapter is back, at its original position in
          // the same failover order as before the 429.
          expect(callLog).toEqual(expectedOrder);
          expect(callLog.indexOf(`${verb}:custom`)).toBe(
            expectedOrder.indexOf(`${verb}:custom`),
          );
          expect(fetchSpy).toHaveBeenCalledTimes(1);
          expect(fetchSpy).toHaveBeenCalledWith(
            CUSTOM_ENDPOINT,
            expect.objectContaining({ method: 'POST' }),
          );
        }
      }),
      { numRuns: 100 },
    );
  });
});

// --- Property 9: the privacy Profile -------------------------------------

/**
 * `selectModel` needs no change for this feature: its `privacy` branch already
 * filters the registry down to `providerId === LOCAL_PROVIDER_ID` and throws
 * `ModelSelectorError` naming that provider when the filter is empty. This is
 * therefore a regression property over existing behaviour — it becomes
 * load-bearing only because the custom provider's id (`custom`) sits outside
 * the local allowlist.
 */

const MODEL_ID_MODES = [
  'assist',
  'what-should-i-say',
  'follow-up',
  'recap',
  'sales-call',
] as const;

const privacyModeArb: fc.Arbitrary<CopilotMode> =
  fc.constantFrom<CopilotMode>(...MODEL_ID_MODES);

const privacyTierArb = fc.constantFrom<ModelEntry['tier']>('flash', 'pro');

const privacyPriceArb = fc.record({
  input: fc.double({ min: 0, max: 50, noNaN: true, noDefaultInfinity: true }),
  output: fc.double({ min: 0, max: 50, noNaN: true, noDefaultInfinity: true }),
});

interface PrivacyScenario {
  registry: ModelEntry[];
  tokens: number;
  mode: CopilotMode;
}

/**
 * Any registry holding at least one `custom` entry, optional cloud entries, and
 * — in roughly half the runs — zero `ollama` entries, so both clauses of the
 * property are exercised: the ordinary selection (Requirement 2.6) and the
 * no-local-provider refusal (Requirement 2.11). Capacities and token counts
 * overlap deliberately, so the "an ollama entry exists but none fits" corner is
 * generated too.
 */
const privacyScenarioArb: fc.Arbitrary<PrivacyScenario> = fc
  .record({
    customCaps: fc.array(fc.integer({ min: 1_000, max: 400_000 }), {
      minLength: 1,
      maxLength: 3,
    }),
    cloudProviders: fc.array(
      fc.constantFrom('gemini', 'openai', 'anthropic'),
      { minLength: 0, maxLength: 3 },
    ),
    cloudCaps: fc.array(fc.integer({ min: 1_000, max: 400_000 }), {
      minLength: 3,
      maxLength: 3,
    }),
    ollamaCaps: fc.array(fc.integer({ min: 1_000, max: 200_000 }), {
      minLength: 0,
      maxLength: 3,
    }),
    tiers: fc.array(privacyTierArb, { minLength: 9, maxLength: 9 }),
    prices: fc.array(privacyPriceArb, { minLength: 9, maxLength: 9 }),
    tokens: fc.integer({ min: 0, max: 300_000 }),
    mode: privacyModeArb,
  })
  .chain((r) => {
    const entries: ModelEntry[] = [];
    const pick = (i: number) => ({
      tier: r.tiers[i % r.tiers.length],
      price: r.prices[i % r.prices.length],
    });

    r.customCaps.forEach((cap, i) => {
      const { tier, price } = pick(i);
      entries.push({
        providerId: 'custom',
        modelId: `custom-model-${i}`,
        tier,
        maxInputTokens: cap,
        capabilities: {
          streaming: true,
          imageInput: false,
          toolUse: false,
          maxInputTokens: cap,
          pricePerMTokens: price,
        },
        pricePerMTokens: price,
      });
    });

    r.cloudProviders.forEach((providerId, i) => {
      const cap = r.cloudCaps[i % r.cloudCaps.length];
      const { tier, price } = pick(i + 3);
      entries.push({
        providerId,
        modelId: `${providerId}-model-${i}`,
        tier,
        maxInputTokens: cap,
        capabilities: {
          streaming: true,
          imageInput: false,
          toolUse: false,
          maxInputTokens: cap,
          pricePerMTokens: price,
        },
        pricePerMTokens: price,
      });
    });

    r.ollamaCaps.forEach((cap, i) => {
      const { tier, price } = pick(i + 6);
      entries.push({
        providerId: LOCAL_PROVIDER_ID,
        modelId: `local-model-${i}`,
        tier,
        maxInputTokens: cap,
        capabilities: {
          streaming: true,
          imageInput: false,
          toolUse: false,
          maxInputTokens: cap,
          pricePerMTokens: price,
        },
        pricePerMTokens: price,
      });
    });

    // Shuffle so the caller's registry order can never be what makes the
    // property hold.
    return fc
      .shuffledSubarray(entries, {
        minLength: entries.length,
        maxLength: entries.length,
      })
      .map((registry) => ({
        registry: [...registry],
        tokens: r.tokens,
        mode: r.mode,
      }));
  });

describe("The privacy Profile and the Custom_Provider", () => {
  // Feature: custom-openai-compatible-provider, Property 9: The `privacy` Profile
  // never selects the Custom_Provider
  //
  // **Validates: Requirements 2.6, 2.11**
  it('either returns an ollama entry or throws a selection error naming the missing local provider, never returning custom', () => {
    fc.assert(
      fc.property(privacyScenarioArb, ({ registry, tokens, mode }) => {
        // Guard against a vacuous run: every scenario really does offer the
        // custom provider as a candidate.
        expect(registry.some((m) => m.providerId === 'custom')).toBe(true);
        // The custom id must stay outside the local allowlist for the whole
        // property to mean anything.
        expect(LOCAL_PROVIDER_ID).not.toBe('custom');

        const localEntries = registry.filter(
          (m) => m.providerId === LOCAL_PROVIDER_ID,
        );
        const someLocalFits = localEntries.some(
          (m) => m.maxInputTokens >= tokens,
        );

        let selected: ReturnType<typeof selectModel> | null = null;
        let thrown: unknown = null;
        try {
          selected = selectModel({
            tokens,
            mode,
            profile: 'privacy',
            registry,
          });
        } catch (err) {
          thrown = err;
        }

        if (someLocalFits) {
          // Requirement 2.6 — a local entry is available, so it is chosen and
          // no custom entry can be returned.
          expect(thrown).toBeNull();
          expect(selected?.providerId).toBe(LOCAL_PROVIDER_ID);
          expect(selected?.providerId).not.toBe('custom');
        } else {
          // Requirement 2.11 — no usable local entry, so the selector refuses
          // with an error naming the local provider rather than falling back to
          // the custom (or any other cloud) entry.
          expect(selected).toBeNull();
          expect(thrown).toBeInstanceOf(ModelSelectorError);
          expect((thrown as Error).message).toContain(LOCAL_PROVIDER_ID);
        }
      }),
      { numRuns: 100 },
    );
  });
});
