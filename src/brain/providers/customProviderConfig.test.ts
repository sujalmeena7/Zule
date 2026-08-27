// ============================================
// Zule AI — Custom provider config helper tests
// ============================================
//
// Feature: custom-openai-compatible-provider, Property 3: The entry list holds exactly one initialised Custom_Provider
//
// *For any* persisted provider array (including arrays with zero, one, or
// several `custom` entries and arbitrary priority values), the merged entry list
// SHALL contain exactly one entry whose id is `custom`; when the input contained
// none, that entry SHALL have `enabled === false`, an empty Base_URL, an empty
// Model_ID, no API_Key cipher, a priority within `[MIN_PRIORITY, MAX_PRIORITY]`
// that is greater than or equal to every other entry's priority, and the last
// position in the returned array.
//
// "Lower priority than every other entry" (Requirement 1.7) means *lowest
// precedence*: the numerically greatest priority **and** last position in the
// failover order. Because `mergeCustomEntry` clamps `max(existing) + 1` to
// `MAX_PRIORITY` (design.md §2), strict inequality is unsatisfiable once an
// existing entry already sits at `MAX_PRIORITY`; last position is what breaks
// the tie, exactly as `planProviderSync` orders on equal priorities. Strict
// inequality is still asserted on the normal path, where no existing entry is at
// `MAX_PRIORITY`.
//
// **Validates: Requirements 1.1, 1.7**

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import type { ProviderConfig } from '../../data/database';
import type { CustomField } from './customProviderConfig';
import {
  buildCustomConfigForSave,
  CUSTOM_PROVIDER_ID,
  looksLikeThinkingModel,
  MAX_PRIORITY,
  MIN_PRIORITY,
  mergeCustomEntry,
  planProviderSync,
} from './customProviderConfig';
import { normalizeBaseUrl } from './endpointValidator';

// ── Generators ──────────────────────────────────────────────────────────────
// The input space is "any persisted `providers` array". `priority` is documented
// on `ProviderConfig` as a 1-based integer in [1, 10], so priorities are drawn
// across that whole range including both bounds. Custom entries are generated
// already-populated so the de-duplication branch is exercised alongside the
// initialisation branch.

const NON_CUSTOM_IDS = ['gemini', 'openai', 'anthropic', 'ollama', 'simulation'] as const;

const arbPriority = fc.integer({ min: MIN_PRIORITY, max: MAX_PRIORITY });

const arbNonCustomEntry: fc.Arbitrary<ProviderConfig> = fc
  .tuple(fc.constantFrom(...NON_CUSTOM_IDS), fc.boolean(), arbPriority, fc.option(fc.string({ maxLength: 8 }), { nil: undefined }))
  .map(([id, enabled, priority, apiKeyCipher]) => {
    const entry: ProviderConfig = { id, enabled, priority };
    if (apiKeyCipher !== undefined) entry.apiKeyCipher = apiKeyCipher;
    return entry;
  });

const arbCustomEntry: fc.Arbitrary<ProviderConfig> = fc
  .tuple(
    fc.boolean(),
    arbPriority,
    fc.constantFrom('', 'https://openrouter.ai/api/v1', 'http://localhost:1234/v1'),
    fc.constantFrom('', 'llama-3.1-8b', 'gpt-4o-mini'),
    fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
  )
  .map(([enabled, priority, baseUrl, modelId, apiKeyCipher]) => {
    const entry: ProviderConfig = { id: CUSTOM_PROVIDER_ID, enabled, priority, baseUrl, modelId };
    if (apiKeyCipher !== undefined) entry.apiKeyCipher = apiKeyCipher;
    return entry;
  });

/** Arrays holding zero, one, or several `custom` entries in arbitrary positions. */
const arbSavedArray: fc.Arbitrary<ProviderConfig[]> = fc.array(
  fc.oneof(
    { weight: 4, arbitrary: arbNonCustomEntry },
    { weight: 2, arbitrary: arbCustomEntry },
  ),
  { maxLength: 8 },
);

// ── Property 3 ──────────────────────────────────────────────────────────────

describe('Property 3: The entry list holds exactly one initialised Custom_Provider', () => {
  it('merges to exactly one custom entry, initialised to lowest precedence when absent', () => {
    fc.assert(
      fc.property(arbSavedArray, (saved) => {
        const merged = mergeCustomEntry(saved);

        const customEntries = merged.filter((entry) => entry.id === CUSTOM_PROVIDER_ID);
        expect(customEntries).toHaveLength(1);
        const custom = customEntries[0];

        const savedCustom = saved.filter((entry) => entry.id === CUSTOM_PROVIDER_ID);
        if (savedCustom.length > 0) {
          // Several occurrences de-duplicate to the first, unchanged.
          expect(custom).toEqual(savedCustom[0]);
          return;
        }

        // Input contained none: the appended entry is disabled and empty.
        expect(custom.enabled).toBe(false);
        expect(custom.baseUrl).toBe('');
        expect(custom.modelId).toBe('');
        expect(custom.apiKeyCipher).toBeUndefined();

        // ... and sits at the lowest precedence.
        const others = merged.filter((entry) => entry !== custom);

        // (a) Numerically greatest priority, up to the MAX_PRIORITY clamp.
        for (const other of others) {
          expect(custom.priority).toBeGreaterThanOrEqual(other.priority);
        }

        // (b) Last position in the failover order — the tie-breaker when the
        //     clamp forces an equal priority.
        expect(merged[merged.length - 1]).toBe(custom);

        // (c) Always a valid persisted priority.
        expect(custom.priority).toBeGreaterThanOrEqual(MIN_PRIORITY);
        expect(custom.priority).toBeLessThanOrEqual(MAX_PRIORITY);

        // (d) Normal path: with headroom below the clamp, the priority is
        //     strictly greater than every other entry's.
        if (!others.some((other) => other.priority >= MAX_PRIORITY)) {
          for (const other of others) {
            expect(custom.priority).toBeGreaterThan(other.priority);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
// Feature: custom-openai-compatible-provider, Property 4: Save round-trip preserves the four persisted values
//
// *For any* valid draft (arbitrary enabled flag, integer priority in [1, 10],
// absolute http(s) Base_URL decorated with arbitrary leading/trailing whitespace
// and trailing slashes, and arbitrary Model_ID with surrounding whitespace),
// persisting the draft and re-loading it SHALL yield the same enabled flag, the
// same priority, the normalised Base_URL, and the trimmed Model_ID; and saving
// the re-loaded values again SHALL be a fixed point.
//
// The four persisted values are the ones Requirement 1.3 says re-opening the
// panel must display. "Persisting and re-loading" is modelled as a JSON
// round-trip, because `providers` is a single JSON-array row in the settings
// store — no IndexedDB is needed to exercise it.
//
// The oracle for the Base_URL is independent of `normalizeBaseUrl`: the
// generator builds a canonical base (already trimmed, no trailing `/`) and then
// decorates it, so the expected value is the canonical form the generator
// started from rather than a second call to the function under test. The same
// trick gives the Model_ID oracle.
//
// **Validates: Requirements 1.3**

const arbWhitespace = fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), {
  maxLength: 3,
});

const arbHost = fc.constantFrom(
  'example.com',
  'localhost:1234',
  'api.groq.com',
  '127.0.0.1:8080',
  'openrouter.ai',
);

const arbPathSegment = fc.stringOf(fc.constantFrom('a', 'b', 'z', '1', '9', '-', '_', 'v'), {
  minLength: 1,
  maxLength: 6,
});

/** An absolute http(s) URL that is already normalised: trimmed, no trailing `/`. */
const arbCanonicalBaseUrl = fc
  .tuple(fc.constantFrom('http', 'https'), arbHost, fc.array(arbPathSegment, { maxLength: 3 }))
  .map(
    ([scheme, host, segments]) =>
      `${scheme}://${host}${segments.map((segment) => `/${segment}`).join('')}`,
  );

/** The canonical base plus the decoration Requirement 1.3 says must be stripped. */
const arbBaseUrlDraft = fc
  .tuple(arbCanonicalBaseUrl, arbWhitespace, arbWhitespace, fc.integer({ min: 0, max: 3 }))
  .map(([canonical, lead, trail, slashes]) => ({
    canonical,
    draft: `${lead}${canonical}${'/'.repeat(slashes)}${trail}`,
  }));

/** An arbitrary Model_ID (possibly empty) wrapped in arbitrary whitespace. */
const arbModelIdDraft = fc
  .tuple(fc.string({ maxLength: 40 }).map((raw) => raw.trim()), arbWhitespace, arbWhitespace)
  .map(([core, lead, trail]) => ({ core, draft: `${lead}${core}${trail}` }));

/**
 * Either "retain the stored cipher" (blank draft) or a fresh credential whose
 * cipher the caller has already produced — the two shapes the panel submits.
 */
const arbApiKeySubmission = fc.oneof(
  fc.constant<{ apiKeyDraft: string; apiKeyCipher?: string }>({ apiKeyDraft: '' }),
  fc
    .string({ minLength: 1, maxLength: 64 })
    .map((key) => ({ apiKeyDraft: key, apiKeyCipher: `cipher(${key.length})` })),
);

describe('Property 4: Save round-trip preserves the four persisted values', () => {
  it('persists the enabled flag, priority, normalised Base_URL, and trimmed Model_ID, and re-saving is a fixed point', () => {
    fc.assert(
      fc.property(
        arbCustomEntry,
        fc.boolean(),
        arbPriority,
        arbBaseUrlDraft,
        arbModelIdDraft,
        arbApiKeySubmission,
        (previous, enabled, priority, baseUrl, modelId, apiKey) => {
          const saved = buildCustomConfigForSave({
            previous,
            enabled,
            priority,
            baseUrlDraft: baseUrl.draft,
            modelIdDraft: modelId.draft,
            apiKeyDraft: apiKey.apiKeyDraft,
            apiKeyCipher: apiKey.apiKeyCipher,
          });

          // A valid draft is never rejected.
          expect(saved.ok).toBe(true);
          if (!saved.ok) return;

          // Persist and re-load: `providers` is a JSON array row.
          const reloaded = JSON.parse(JSON.stringify([saved.config]))[0] as ProviderConfig;

          expect(reloaded.id).toBe(CUSTOM_PROVIDER_ID);
          expect(reloaded.enabled).toBe(enabled);
          expect(reloaded.priority).toBe(priority);
          expect(reloaded.baseUrl).toBe(baseUrl.canonical);
          expect(reloaded.modelId).toBe(modelId.core);

          // Re-saving exactly what the re-opened panel displays — with a blank
          // API_Key draft, which retains the stored cipher — changes nothing.
          const resaved = buildCustomConfigForSave({
            previous: reloaded,
            enabled: reloaded.enabled,
            priority: reloaded.priority,
            baseUrlDraft: reloaded.baseUrl ?? '',
            modelIdDraft: reloaded.modelId ?? '',
            apiKeyDraft: '',
          });

          expect(resaved.ok).toBe(true);
          if (!resaved.ok) return;
          expect(resaved.config).toEqual(reloaded);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: custom-openai-compatible-provider, Property 7: Provider_Sync's plan is a total, non-mutating function of configuration
//
// *For any* provider configuration array and *for any* set of currently
// registered adapter names, `planProviderSync` SHALL produce a plan in which:
// `custom` appears in `register` and in `priority` if and only if its entry is
// enabled and its trimmed Base_URL, decrypted API_Key, and trimmed Model_ID are
// all non-blank; `custom` appears in `unregister` with a
// `disabled-while-registered` diagnostic if and only if it is currently
// registered and its entry is disabled; a `config-incomplete` diagnostic whose
// `missing` set equals exactly the set of blank required fields is present if
// and only if the entry is enabled with at least one blank field; and in every
// case the input configuration objects SHALL be unmodified.
//
// The oracle is computed from the inputs alone, using `normalizeBaseUrl` (pinned
// independently by Property 1) to decide Base_URL usability: per design.md §2 an
// unparseable or unsupported-scheme Base_URL is unusable in exactly the same way
// a blank one is — there is no endpoint to send to either way — so it counts
// towards `missing`. Totality is asserted by calling the planner on hostile
// inputs (whitespace-only fields, unparseable URLs, non-integer priorities,
// duplicate custom entries) and requiring it not to throw; non-mutation by a
// `JSON.stringify` snapshot of every input taken before the call.
//
// **Validates: Requirements 1.4, 1.5, 1.6**

const ALL_PROVIDER_IDS = [...NON_CUSTOM_IDS, CUSTOM_PROVIDER_ID] as const;

/**
 * A custom entry drawn from the awkward end of the input space: whitespace-only
 * fields, an unparseable Base_URL, an unsupported scheme, a trailing slash, and
 * priorities outside the documented integer range.
 */
const arbEdgeCustomEntry: fc.Arbitrary<ProviderConfig> = fc
  .tuple(
    fc.boolean(),
    fc.oneof(arbPriority, fc.constantFrom(0, -3, 2.5, Number.NaN)),
    fc.constantFrom('', '   ', '\t\n', 'not a url', 'ftp://files.example.com', 'https://a.example/v1/'),
    fc.constantFrom('', '  ', '\n', 'llama-3.1-70b'),
    fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
  )
  .map(([enabled, priority, baseUrl, modelId, apiKeyCipher]) => {
    const entry: ProviderConfig = { id: CUSTOM_PROVIDER_ID, enabled, priority, baseUrl, modelId };
    if (apiKeyCipher !== undefined) entry.apiKeyCipher = apiKeyCipher;
    return entry;
  });

/** Any persisted array, including several custom entries and hostile values. */
const arbPlanConfigs: fc.Arbitrary<ProviderConfig[]> = fc.array(
  fc.oneof(
    { weight: 4, arbitrary: arbNonCustomEntry },
    { weight: 3, arbitrary: arbCustomEntry },
    { weight: 3, arbitrary: arbEdgeCustomEntry },
  ),
  { maxLength: 8 },
);

/**
 * A decrypted credential: usable more often than not, so the enabled-and-complete
 * `register` branch is reached rather than only the skip branches. `''` models
 * both "no cipher stored" and "cipher failed to decrypt".
 */
const arbDecryptedKey = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('sk-live-abcdef123456', 'gw_key_0000000000') },
  { weight: 1, arbitrary: fc.constantFrom('', '   ', '\t\n') },
);

/** Keys keyed by provider id; any subset of the ids may be present. */
const arbDecryptedKeys: fc.Arbitrary<Record<string, string>> = fc
  .record(
    Object.fromEntries(ALL_PROVIDER_IDS.map((id) => [id, arbDecryptedKey])) as Record<
      string,
      fc.Arbitrary<string>
    >,
    { requiredKeys: [] },
  )
  // `requiredKeys: []` widens every value to `string | undefined`; drop the absent
  // keys so the record matches `planProviderSync`'s `Record<string, string>` while
  // still exercising "any subset of the ids may be present".
  .map((partial) => {
    const keys: Record<string, string> = {};
    for (const [id, value] of Object.entries(partial)) {
      if (typeof value === 'string') keys[id] = value;
    }
    return keys;
  });

/** The adapter names the router currently holds. */
const arbRegistered: fc.Arbitrary<string[]> = fc.subarray([...ALL_PROVIDER_IDS]);

describe("Property 7: Provider_Sync's plan is a total, non-mutating function of configuration", () => {
  it('registers, unregisters, and diagnoses the custom entry exactly as its configuration dictates, without mutating its inputs', () => {
    fc.assert(
      fc.property(arbPlanConfigs, arbDecryptedKeys, arbRegistered, (configs, decryptedKeys, registeredNames) => {
        const registered = new Set(registeredNames);

        // Snapshots for the non-mutation clause (Requirement 1.5).
        const configsSnapshot = JSON.stringify(configs);
        const keysSnapshot = JSON.stringify(decryptedKeys);
        const registeredSnapshot = JSON.stringify([...registered]);

        // Totality: never throws for any of these inputs.
        const plan = planProviderSync(configs, decryptedKeys, registered);

        // --- Oracle, computed from the inputs alone -------------------------
        const entry = configs.find((config) => config.id === CUSTOM_PROVIDER_ID);
        const key = decryptedKeys[CUSTOM_PROVIDER_ID] ?? '';
        const isRegistered = registered.has(CUSTOM_PROVIDER_ID);
        const enabled = Boolean(entry) && entry!.enabled !== false;

        const expectedMissing: string[] = [];
        if (enabled) {
          if (!normalizeBaseUrl(entry!.baseUrl ?? '').ok) expectedMissing.push('baseUrl');
          if (key.trim().length === 0) expectedMissing.push('apiKey');
          if ((entry!.modelId ?? '').trim().length === 0) expectedMissing.push('modelId');
        }
        const shouldRegister = enabled && expectedMissing.length === 0;

        const inRegister = plan.register.includes(CUSTOM_PROVIDER_ID);
        const inPriority = plan.priority.includes(CUSTOM_PROVIDER_ID);
        const inUnregister = plan.unregister.includes(CUSTOM_PROVIDER_ID);
        const disabledDiagnostics = plan.diagnostics.filter(
          (d) => d.kind === 'custom.disabled-while-registered',
        );
        const incompleteDiagnostics = plan.diagnostics.filter(
          (d): d is { kind: 'custom.config-incomplete'; missing: CustomField[] } =>
            d.kind === 'custom.config-incomplete',
        );

        // Requirements 1.4, 1.6: registered and prioritised iff enabled and complete.
        expect(inRegister).toBe(shouldRegister);
        expect(inPriority).toBe(shouldRegister);

        // Requirement 1.5: unregistered with its diagnostic iff disabled while registered.
        expect(inUnregister).toBe(!enabled && isRegistered);
        expect(disabledDiagnostics).toHaveLength(!enabled && isRegistered ? 1 : 0);

        // Requirement 1.6: the incomplete diagnostic names exactly the blank fields.
        if (enabled && expectedMissing.length > 0) {
          expect(incompleteDiagnostics).toHaveLength(1);
          expect(incompleteDiagnostics[0].missing).toEqual(expectedMissing);
        } else {
          expect(incompleteDiagnostics).toHaveLength(0);
        }

        // Non-mutation: every input is byte-identical after the call.
        expect(JSON.stringify(configs)).toBe(configsSnapshot);
        expect(JSON.stringify(decryptedKeys)).toBe(keysSnapshot);
        expect(JSON.stringify([...registered])).toBe(registeredSnapshot);

        // Determinism: equal inputs produce deeply equal plans.
        expect(planProviderSync(configs, decryptedKeys, registered)).toEqual(plan);
      }),
      { numRuns: 100 },
    );
  });
});

// ── The optional fast model ─────────────────────────────────────────────────
//
// `fastModelId` is the one Custom_Provider text field that can be blank without
// the configuration being incomplete: blank means "send every dispatch to
// `modelId`", which is the behaviour that predates the field. The tests below
// pin that asymmetry, because getting it wrong would refuse to register a
// perfectly usable endpoint for the sake of an optional input.

describe('Custom_Provider fast model — an optional field, never a gate', () => {
  const COMPLETE: ProviderConfig = {
    id: CUSTOM_PROVIDER_ID,
    enabled: true,
    priority: 6,
    baseUrl: 'https://openrouter.ai/api/v1',
    modelId: 'qwen-thinking',
  };
  const KEYS = { [CUSTOM_PROVIDER_ID]: 'sk-abcdef123456' };

  it('registers with no fast model at all, and never names it as missing', () => {
    for (const fastModelId of [undefined, '', '   ', '\t\n']) {
      const entry: ProviderConfig = { ...COMPLETE };
      if (fastModelId !== undefined) entry.fastModelId = fastModelId;

      const plan = planProviderSync([entry], KEYS, new Set());
      expect(plan.register).toContain(CUSTOM_PROVIDER_ID);
      expect(
        plan.diagnostics.filter((d) => d.kind === 'custom.config-incomplete'),
      ).toHaveLength(0);
    }
  });

  it('carries a trimmed fast model through to the registration decision', () => {
    const plan = planProviderSync(
      [{ ...COMPLETE, fastModelId: '  qwen-instruct \n' }],
      KEYS,
      new Set(),
    );
    expect(plan.register).toContain(CUSTOM_PROVIDER_ID);
  });

  it('persists a trimmed fast model, and leaves it untouched when no draft is supplied', () => {
    const previous: ProviderConfig = { ...COMPLETE, fastModelId: 'qwen-instruct' };

    const saved = buildCustomConfigForSave({
      previous,
      enabled: true,
      priority: 6,
      baseUrlDraft: 'https://openrouter.ai/api/v1',
      modelIdDraft: 'qwen-thinking',
      fastModelIdDraft: '  other-instruct  ',
      apiKeyDraft: '',
    });
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.config.fastModelId).toBe('other-instruct');

    // A caller that predates the field omits the draft entirely; that must not
    // silently erase what the User already configured.
    const untouched = buildCustomConfigForSave({
      previous,
      enabled: true,
      priority: 6,
      baseUrlDraft: 'https://openrouter.ai/api/v1',
      modelIdDraft: 'qwen-thinking',
      apiKeyDraft: '',
    });
    expect(untouched.ok).toBe(true);
    if (untouched.ok) expect(untouched.config.fastModelId).toBe('qwen-instruct');
  });

  it('clears the stored fast model when the draft is explicitly blank', () => {
    const saved = buildCustomConfigForSave({
      previous: { ...COMPLETE, fastModelId: 'qwen-instruct' },
      enabled: true,
      priority: 6,
      baseUrlDraft: 'https://openrouter.ai/api/v1',
      modelIdDraft: 'qwen-thinking',
      fastModelIdDraft: '   ',
      apiKeyDraft: '',
    });
    // Emptying the input is how the User says "go back to one model", so a blank
    // draft has to be honoured rather than read as "no opinion".
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.config.fastModelId).toBe('');
  });
});

describe('looksLikeThinkingModel', () => {
  it('flags the deliberating variants and leaves ordinary ids alone', () => {
    for (const id of [
      'qwen/qwen3-vl-235b-a22b-thinking',
      'deepseek/deepseek-r1',
      'Qwen/QwQ-32B-Preview',
      'openai/o1-mini',
      'some-reasoning-model',
    ]) {
      expect(looksLikeThinkingModel(id)).toBe(true);
    }

    for (const id of [
      'qwen/qwen3-vl-235b-a22b-instruct',
      'meta-llama/llama-3.1-8b-instruct',
      'gpt-4o-mini',
      '',
    ]) {
      expect(looksLikeThinkingModel(id)).toBe(false);
    }
  });
});
