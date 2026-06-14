// Property-based + unit tests for selectModel.
//
// **Property 14: Model selection is monotonic in input tokens**
//
// *For all* `(tokens, mode, profile, registry)` such that the registry
// is well-formed (a non-empty mix of `flash` and `pro` entries with
// `max(flash maxInputTokens) <= min(pro maxInputTokens)`, an `ollama`
// entry whose capacity covers the largest sampled token count, and
// `tokens` bounded by the largest fitting capacity for the active
// profile), the following hold:
//
//   1. Capacity covers tokens:
//        `selectModel({ tokens, ... }).maxInputTokens >= tokens`.
//   2. Monotonic in tokens: for `tokens1 <= tokens2` with the same
//        `(mode, profile, registry)`,
//        `selectModel(tokens1).maxInputTokens <= selectModel(tokens2).maxInputTokens`.
//   3. Determinism: repeated calls with the same input return equal
//        outputs.
//   4. Profile invariants:
//        - `speed`   → returned tier is the lowest available that fits;
//                      a `flash` entry is chosen whenever any flash fits.
//        - `cost`    → no other fitting entry has a strictly lower
//                      `pricePerMTokens.input` (cheapest fits).
//        - `privacy` → returned `providerId === 'ollama'`
//                      (Requirement 29.4: cloud providers are refused).
//
// **Validates: Requirements 4.10, 29.2, 29.3, 29.4**

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  DEFAULT_BALANCED_TIER_THRESHOLD,
  LOCAL_PROVIDER_ID,
  ModelSelectorError,
  selectModel,
  type ModelEntry,
  type Profile,
} from './modelSelector';
import type { CopilotMode } from './modePrompts';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const profileArb: fc.Arbitrary<Profile> = fc.constantFrom<Profile>(
  'speed',
  'balanced',
  'cost',
  'privacy',
);

const modeArb: fc.Arbitrary<CopilotMode> = fc.constantFrom<CopilotMode>(
  'assist',
  'what-should-i-say',
  'follow-up',
  'recap',
  'coding-interview',
  'sales-call',
  'behavioral-interview',
);

const cloudProviderArb = fc.constantFrom<string>(
  'gemini',
  'openai',
  'anthropic',
);

const priceArb = () =>
  fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true });

/**
 * A well-formed registry for monotonicity testing:
 *
 *   - `flashCount` flash models with capacities in [1, 8000]
 *   - `proCount` pro models with capacities in [maxFlashCapacity, 200_000]
 *   - one `ollama` flash entry that *always fits* the test's largest
 *     token count (so privacy is exercisable)
 *   - one `ollama` pro entry larger than every cloud pro entry
 *
 * Returning `{ registry, capUpper }` lets the property bind `tokens` to
 * `[0, capUpper]` so a fitting model always exists, regardless of profile.
 */
const wellFormedRegistryArb = fc
  .record({
    flashCaps: fc.array(fc.integer({ min: 256, max: 8_000 }), {
      minLength: 1,
      maxLength: 4,
    }),
    proCapDeltas: fc.array(fc.integer({ min: 8_000, max: 200_000 }), {
      minLength: 1,
      maxLength: 4,
    }),
    flashPrices: fc.array(
      fc.record({ input: priceArb(), output: priceArb() }),
      { minLength: 1, maxLength: 4 },
    ),
    proPrices: fc.array(
      fc.record({ input: priceArb(), output: priceArb() }),
      { minLength: 1, maxLength: 4 },
    ),
    cloudFlashProviders: fc.array(cloudProviderArb, {
      minLength: 1,
      maxLength: 4,
    }),
    cloudProProviders: fc.array(cloudProviderArb, {
      minLength: 1,
      maxLength: 4,
    }),
    ollamaCap: fc.integer({ min: 200_000, max: 1_000_000 }),
    ollamaProCap: fc.integer({ min: 200_000, max: 1_000_000 }),
    ollamaPriceInput: priceArb(),
    ollamaPriceOutput: priceArb(),
    ollamaProPriceInput: priceArb(),
    ollamaProPriceOutput: priceArb(),
  })
  .map((r) => {
    const flashEntries: ModelEntry[] = r.flashCaps.map((cap, i) => ({
      providerId: r.cloudFlashProviders[i % r.cloudFlashProviders.length],
      modelId: `flash-${i}-${cap}`,
      tier: 'flash' as const,
      maxInputTokens: cap,
      capabilities: {
        streaming: true,
        imageInput: false,
        toolUse: false,
        maxInputTokens: cap,
        pricePerMTokens: r.flashPrices[i % r.flashPrices.length],
      },
      pricePerMTokens: r.flashPrices[i % r.flashPrices.length],
    }));

    const maxFlashCap = Math.max(...r.flashCaps);

    const proEntries: ModelEntry[] = r.proCapDeltas.map((delta, i) => {
      const cap = maxFlashCap + delta;
      return {
        providerId: r.cloudProProviders[i % r.cloudProProviders.length],
        modelId: `pro-${i}-${cap}`,
        tier: 'pro' as const,
        maxInputTokens: cap,
        capabilities: {
          streaming: true,
          imageInput: true,
          toolUse: true,
          maxInputTokens: cap,
          pricePerMTokens: r.proPrices[i % r.proPrices.length],
        },
        pricePerMTokens: r.proPrices[i % r.proPrices.length],
      };
    });

    const maxProCap = Math.max(...proEntries.map((p) => p.maxInputTokens));

    // ollama flash and pro both placed above every cloud pro to guarantee
    // privacy can fit any token count up to `capUpper` below.
    const ollamaFlashCap = Math.max(r.ollamaCap, maxProCap + 1_000);
    const ollamaProCap = Math.max(r.ollamaProCap, ollamaFlashCap + 1_000);

    const ollamaFlash: ModelEntry = {
      providerId: LOCAL_PROVIDER_ID,
      modelId: `ollama-flash-${ollamaFlashCap}`,
      tier: 'flash',
      maxInputTokens: ollamaFlashCap,
      capabilities: {
        streaming: true,
        imageInput: false,
        toolUse: false,
        maxInputTokens: ollamaFlashCap,
        pricePerMTokens: {
          input: r.ollamaPriceInput,
          output: r.ollamaPriceOutput,
        },
      },
      pricePerMTokens: {
        input: r.ollamaPriceInput,
        output: r.ollamaPriceOutput,
      },
    };

    const ollamaPro: ModelEntry = {
      providerId: LOCAL_PROVIDER_ID,
      modelId: `ollama-pro-${ollamaProCap}`,
      tier: 'pro',
      maxInputTokens: ollamaProCap,
      capabilities: {
        streaming: true,
        imageInput: false,
        toolUse: true,
        maxInputTokens: ollamaProCap,
        pricePerMTokens: {
          input: r.ollamaProPriceInput,
          output: r.ollamaProPriceOutput,
        },
      },
      pricePerMTokens: {
        input: r.ollamaProPriceInput,
        output: r.ollamaProPriceOutput,
      },
    };

    const registry: ModelEntry[] = [
      ...flashEntries,
      ...proEntries,
      ollamaFlash,
      ollamaPro,
    ];

    // The smallest "always-fits" cap across all profiles is the smallest
    // ollama capacity (privacy is the most restrictive). Bound test tokens
    // a hair below it so a fitting model always exists.
    const capUpper = ollamaFlashCap - 1;

    return { registry, capUpper };
  });

const tokenPairArb = wellFormedRegistryArb.chain(({ registry, capUpper }) =>
  fc
    .tuple(
      fc.integer({ min: 0, max: capUpper }),
      fc.integer({ min: 0, max: capUpper }),
    )
    .map(([a, b]) => ({
      registry,
      tokens1: Math.min(a, b),
      tokens2: Math.max(a, b),
    })),
);

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

const baseRegistry: ModelEntry[] = [
  {
    providerId: 'gemini',
    modelId: 'gemini-1.5-flash',
    tier: 'flash',
    maxInputTokens: 8_000,
    capabilities: {
      streaming: true,
      imageInput: false,
      toolUse: false,
      maxInputTokens: 8_000,
      pricePerMTokens: { input: 0.075, output: 0.3 },
    },
    pricePerMTokens: { input: 0.075, output: 0.3 },
  },
  {
    providerId: 'gemini',
    modelId: 'gemini-1.5-pro',
    tier: 'pro',
    maxInputTokens: 200_000,
    capabilities: {
      streaming: true,
      imageInput: true,
      toolUse: true,
      maxInputTokens: 200_000,
      pricePerMTokens: { input: 1.25, output: 5 },
    },
    pricePerMTokens: { input: 1.25, output: 5 },
  },
  {
    providerId: 'openai',
    modelId: 'gpt-4o-mini',
    tier: 'flash',
    maxInputTokens: 4_000,
    capabilities: {
      streaming: true,
      imageInput: false,
      toolUse: false,
      maxInputTokens: 4_000,
      pricePerMTokens: { input: 0.15, output: 0.6 },
    },
    pricePerMTokens: { input: 0.15, output: 0.6 },
  },
  {
    providerId: 'openai',
    modelId: 'gpt-4o',
    tier: 'pro',
    maxInputTokens: 128_000,
    capabilities: {
      streaming: true,
      imageInput: true,
      toolUse: true,
      maxInputTokens: 128_000,
      pricePerMTokens: { input: 2.5, output: 10 },
    },
    pricePerMTokens: { input: 2.5, output: 10 },
  },
  {
    providerId: LOCAL_PROVIDER_ID,
    modelId: 'llama3.1-8b',
    tier: 'flash',
    maxInputTokens: 8_000,
    capabilities: {
      streaming: true,
      imageInput: false,
      toolUse: false,
      maxInputTokens: 8_000,
      pricePerMTokens: { input: 0, output: 0 },
    },
    pricePerMTokens: { input: 0, output: 0 },
  },
  {
    providerId: LOCAL_PROVIDER_ID,
    modelId: 'llama3.1-70b',
    tier: 'pro',
    maxInputTokens: 32_000,
    capabilities: {
      streaming: true,
      imageInput: false,
      toolUse: true,
      maxInputTokens: 32_000,
      pricePerMTokens: { input: 0, output: 0 },
    },
    pricePerMTokens: { input: 0, output: 0 },
  },
];

describe('selectModel (unit)', () => {
  it('speed picks a flash tier when any flash fits', () => {
    const out = selectModel({
      tokens: 1_000,
      mode: 'assist',
      profile: 'speed',
      registry: baseRegistry,
    });
    expect(out.tier).toBe('flash');
    expect(out.maxInputTokens).toBeGreaterThanOrEqual(1_000);
  });

  it('speed escalates to pro when no flash fits', () => {
    const out = selectModel({
      tokens: 50_000,
      mode: 'assist',
      profile: 'speed',
      registry: baseRegistry,
    });
    expect(out.tier).toBe('pro');
    expect(out.maxInputTokens).toBeGreaterThanOrEqual(50_000);
  });

  it('speed picks the smallest fitting flash among multiple flashes', () => {
    // gpt-4o-mini (4_000) is smaller than gemini-1.5-flash (8_000); both fit 1_000.
    const out = selectModel({
      tokens: 1_000,
      mode: 'assist',
      profile: 'speed',
      registry: baseRegistry,
    });
    expect(out.maxInputTokens).toBe(4_000);
    expect(out.modelId).toBe('gpt-4o-mini');
  });

  it('cost picks the cheapest fitting model regardless of tier', () => {
    // Local llama models are free (input=0); they should win on cost.
    const out = selectModel({
      tokens: 1_000,
      mode: 'assist',
      profile: 'cost',
      registry: baseRegistry,
    });
    expect(out.providerId).toBe(LOCAL_PROVIDER_ID);
    expect(out.pricePerMTokens.input).toBe(0);
  });

  it('cost picks the cheapest non-zero entry when only paid models fit', () => {
    // 50_000 tokens excludes both ollama flash and gemini-1.5-flash and ollama-70b (32k).
    const out = selectModel({
      tokens: 50_000,
      mode: 'assist',
      profile: 'cost',
      registry: baseRegistry,
    });
    // Only gemini-1.5-pro (200k, $1.25) and gpt-4o (128k, $2.5) fit.
    // Cheapest: gemini-1.5-pro at $1.25 input.
    expect(out.modelId).toBe('gemini-1.5-pro');
    expect(out.pricePerMTokens.input).toBe(1.25);
  });

  it('privacy returns only ollama entries', () => {
    const out = selectModel({
      tokens: 1_000,
      mode: 'assist',
      profile: 'privacy',
      registry: baseRegistry,
    });
    expect(out.providerId).toBe(LOCAL_PROVIDER_ID);
  });

  it('privacy throws when no ollama entry exists', () => {
    const cloudOnly = baseRegistry.filter(
      (m) => m.providerId !== LOCAL_PROVIDER_ID,
    );
    expect(() =>
      selectModel({
        tokens: 1_000,
        mode: 'assist',
        profile: 'privacy',
        registry: cloudOnly,
      }),
    ).toThrow(ModelSelectorError);
  });

  it('privacy throws when no ollama entry has enough capacity', () => {
    // 100_000 exceeds llama3.1-70b (32_000); cloud larger models are refused.
    expect(() =>
      selectModel({
        tokens: 100_000,
        mode: 'assist',
        profile: 'privacy',
        registry: baseRegistry,
      }),
    ).toThrow(ModelSelectorError);
  });

  it('balanced prefers flash below the threshold', () => {
    const out = selectModel({
      tokens: DEFAULT_BALANCED_TIER_THRESHOLD - 1,
      mode: 'assist',
      profile: 'balanced',
      registry: baseRegistry,
    });
    expect(out.tier).toBe('flash');
  });

  it('balanced prefers pro above the threshold', () => {
    const out = selectModel({
      tokens: DEFAULT_BALANCED_TIER_THRESHOLD + 1,
      mode: 'assist',
      profile: 'balanced',
      registry: baseRegistry,
    });
    expect(out.tier).toBe('pro');
  });

  it('balanced honours an explicit threshold override', () => {
    const out = selectModel({
      tokens: 5_000,
      mode: 'assist',
      profile: 'balanced',
      registry: baseRegistry,
      balancedTierThreshold: 6_000,
    });
    expect(out.tier).toBe('flash');
  });

  it('throws on empty registry', () => {
    expect(() =>
      selectModel({
        tokens: 100,
        mode: 'assist',
        profile: 'balanced',
        registry: [],
      }),
    ).toThrow(ModelSelectorError);
  });

  it('throws on negative or non-integer tokens', () => {
    expect(() =>
      selectModel({
        tokens: -1,
        mode: 'assist',
        profile: 'speed',
        registry: baseRegistry,
      }),
    ).toThrow(RangeError);
    expect(() =>
      selectModel({
        tokens: 1.5,
        mode: 'assist',
        profile: 'speed',
        registry: baseRegistry,
      }),
    ).toThrow(RangeError);
  });

  it('throws when no model in registry fits the request (non-privacy)', () => {
    const tinyRegistry: ModelEntry[] = [
      {
        providerId: 'gemini',
        modelId: 'tiny',
        tier: 'flash',
        maxInputTokens: 100,
        capabilities: {
          streaming: true,
          imageInput: false,
          toolUse: false,
          maxInputTokens: 100,
          pricePerMTokens: { input: 1, output: 1 },
        },
        pricePerMTokens: { input: 1, output: 1 },
      },
    ];
    expect(() =>
      selectModel({
        tokens: 1_000,
        mode: 'assist',
        profile: 'cost',
        registry: tinyRegistry,
      }),
    ).toThrow(ModelSelectorError);
  });

  it('does not mutate the registry', () => {
    const snapshot = JSON.stringify(baseRegistry);
    selectModel({
      tokens: 1_000,
      mode: 'assist',
      profile: 'speed',
      registry: baseRegistry,
    });
    expect(JSON.stringify(baseRegistry)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Property tests — Property 14
// ---------------------------------------------------------------------------

describe('selectModel (property — Property 14)', () => {
  it('selected maxInputTokens >= tokens (capacity covers request)', () => {
    fc.assert(
      fc.property(
        fc.tuple(wellFormedRegistryArb, modeArb, profileArb).chain(
          ([{ registry, capUpper }, mode, profile]) =>
            fc.tuple(
              fc.constant({ registry, mode, profile }),
              fc.integer({ min: 0, max: capUpper }),
            ),
        ),
        ([{ registry, mode, profile }, tokens]) => {
          const out = selectModel({ tokens, mode, profile, registry });
          return out.maxInputTokens >= tokens;
        },
      ),
    );
  });

  it('is monotonic in tokens for the same (mode, profile, registry)', () => {
    fc.assert(
      fc.property(
        fc.tuple(modeArb, profileArb, tokenPairArb),
        ([mode, profile, { registry, tokens1, tokens2 }]) => {
          const a = selectModel({
            tokens: tokens1,
            mode,
            profile,
            registry,
          });
          const b = selectModel({
            tokens: tokens2,
            mode,
            profile,
            registry,
          });
          return a.maxInputTokens <= b.maxInputTokens;
        },
      ),
    );
  });

  it('is deterministic: same input → equal output', () => {
    fc.assert(
      fc.property(
        fc.tuple(wellFormedRegistryArb, modeArb, profileArb).chain(
          ([{ registry, capUpper }, mode, profile]) =>
            fc.tuple(
              fc.constant({ registry, mode, profile }),
              fc.integer({ min: 0, max: capUpper }),
            ),
        ),
        ([{ registry, mode, profile }, tokens]) => {
          const a = selectModel({ tokens, mode, profile, registry });
          const b = selectModel({ tokens, mode, profile, registry });
          return (
            a.providerId === b.providerId &&
            a.modelId === b.modelId &&
            a.tier === b.tier &&
            a.maxInputTokens === b.maxInputTokens &&
            a.pricePerMTokens.input === b.pricePerMTokens.input &&
            a.pricePerMTokens.output === b.pricePerMTokens.output
          );
        },
      ),
    );
  });

  it('privacy → selected providerId is the local runtime', () => {
    fc.assert(
      fc.property(
        fc.tuple(wellFormedRegistryArb, modeArb).chain(
          ([{ registry, capUpper }, mode]) =>
            fc.tuple(
              fc.constant({ registry, mode }),
              fc.integer({ min: 0, max: capUpper }),
            ),
        ),
        ([{ registry, mode }, tokens]) => {
          const out = selectModel({
            tokens,
            mode,
            profile: 'privacy',
            registry,
          });
          return out.providerId === LOCAL_PROVIDER_ID;
        },
      ),
    );
  });

  it('speed → flash tier whenever any flash fits the request', () => {
    fc.assert(
      fc.property(
        fc.tuple(wellFormedRegistryArb, modeArb).chain(
          ([{ registry, capUpper }, mode]) =>
            fc.tuple(
              fc.constant({ registry, mode }),
              fc.integer({ min: 0, max: capUpper }),
            ),
        ),
        ([{ registry, mode }, tokens]) => {
          const out = selectModel({
            tokens,
            mode,
            profile: 'speed',
            registry,
          });
          const anyFlashFits = registry.some(
            (m) => m.tier === 'flash' && m.maxInputTokens >= tokens,
          );
          return anyFlashFits ? out.tier === 'flash' : out.tier === 'pro';
        },
      ),
    );
  });

  it('cost → no other fitting entry has a strictly lower input price', () => {
    fc.assert(
      fc.property(
        fc.tuple(wellFormedRegistryArb, modeArb).chain(
          ([{ registry, capUpper }, mode]) =>
            fc.tuple(
              fc.constant({ registry, mode }),
              fc.integer({ min: 0, max: capUpper }),
            ),
        ),
        ([{ registry, mode }, tokens]) => {
          const out = selectModel({
            tokens,
            mode,
            profile: 'cost',
            registry,
          });
          const fittingPrices = registry
            .filter((m) => m.maxInputTokens >= tokens)
            .map((m) => m.pricePerMTokens.input);
          const minFittingPrice = Math.min(...fittingPrices);
          return out.pricePerMTokens.input === minFittingPrice;
        },
      ),
    );
  });
});
