// ============================================
// Zule AI — selectModel (pure)
// ============================================
//
// Pure tier-selection helper used by `AI_Provider_Router` to resolve a
// concrete `{ providerId, modelId }` from a static `registry` of
// available models given the request's input token count, the active
// `CopilotMode`, and the user's latency/cost/privacy `Profile`.
//
// Implements Requirements 4.10, 29.2, 29.3, 29.4:
//
//   - Requirement 4.10 — `selectModel` is a pure routing function of
//     `(tokens, mode, profile)` with overrideable thresholds, replacing
//     the brittle `gemini-1.5-pro` regex heuristic in `aiProvider.ts`.
//   - Requirement 29.2 — `profile = speed` biases toward the fastest
//     (flash) tier and only escalates to pro when flash cannot fit.
//   - Requirement 29.3 — `profile = cost` picks the cheapest model
//     (lowest `pricePerMTokens.input`) that still fits the token count.
//   - Requirement 29.4 — `profile = privacy` refuses cloud providers and
//     selects only entries whose `providerId === 'ollama'` (the local
//     OpenAI-compatible runtime).
//
// Property 14 (validates 4.10, 29.2, 29.3, 29.4) checks that the
// selected model's `maxInputTokens` is non-decreasing in `tokens` (for
// the same `mode` and `profile`), that the call is deterministic, and
// that profile invariants (privacy → ollama, cost → cheapest, speed →
// flash when feasible) hold.

import type { CopilotMode } from './modePrompts';

/** Latency / cost / privacy profile persisted in `Settings_Store` (Requirement 29.1). */
export type Profile = 'speed' | 'balanced' | 'cost' | 'privacy';

/**
 * Coarse latency tier. `flash` is the fastest, lowest-cost tier
 * (e.g. `gemini-1.5-flash`, `gpt-4o-mini`); `pro` is the higher-capacity,
 * higher-cost tier (e.g. `gemini-1.5-pro`, `gpt-4o`).
 */
export type Tier = 'flash' | 'pro';

/** Stable identifier of the local OpenAI-compatible runtime (Ollama / LM Studio). */
export const LOCAL_PROVIDER_ID = 'ollama';

/** Default token threshold above which `balanced` profile escalates to the `pro` tier. */
export const DEFAULT_BALANCED_TIER_THRESHOLD = 4_000;

/** Per-million-token pricing (USD), mirroring `Capabilities.pricePerMTokens`. */
export interface PricePerMTokens {
  input: number;
  output: number;
}

/** Adapter capability descriptor (subset of `types/ai.ts > Capabilities`). */
export interface Capabilities {
  streaming: boolean;
  imageInput: boolean;
  toolUse: boolean;
  maxInputTokens: number;
  pricePerMTokens?: PricePerMTokens;
}

/**
 * One row in the model registry handed to {@link selectModel}. Each row
 * pairs a `{ providerId, modelId }` with its tier, capacity, capabilities,
 * and prices. The registry is treated as read-only and is not mutated.
 */
export interface ModelEntry {
  providerId: string;
  modelId: string;
  tier: Tier;
  /** Maximum input tokens the model accepts; must be a positive finite integer. */
  maxInputTokens: number;
  capabilities: Capabilities;
  pricePerMTokens: PricePerMTokens;
}

/** Input shape for {@link selectModel}. */
export interface SelectModelInput {
  /** Estimated input token count for the request; non-negative finite integer. */
  tokens: number;
  /** The active `CopilotMode` (kept for future mode-conditional rules; currently advisory). */
  mode: CopilotMode;
  /** The user's latency / cost / privacy profile. */
  profile: Profile;
  /** Static registry of available `{ providerId, modelId }` pairs. Must be non-empty. */
  registry: ReadonlyArray<ModelEntry>;
  /**
   * Token threshold for `balanced` profile: when `tokens <= threshold` the
   * selector prefers `flash`, otherwise it prefers `pro`. Defaults to
   * {@link DEFAULT_BALANCED_TIER_THRESHOLD}.
   */
  balancedTierThreshold?: number;
}

/** Return shape of {@link selectModel}. */
export interface SelectModelOutput {
  providerId: string;
  modelId: string;
  tier: Tier;
  /** Mirror of the chosen entry's `maxInputTokens`. */
  maxInputTokens: number;
  /** Mirror of the chosen entry's `pricePerMTokens`. */
  pricePerMTokens: PricePerMTokens;
}

/** Thrown when the registry cannot satisfy the request (empty, no fitting model, no local model under privacy). */
export class ModelSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelSelectorError';
  }
}

function assertNonNegativeFiniteInt(value: number, label: string): void {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(value)
  ) {
    throw new RangeError(
      `selectModel: ${label} must be a non-negative finite integer (received ${String(value)}).`,
    );
  }
}

function assertValidEntry(m: ModelEntry, idx: number): void {
  if (!m || typeof m !== 'object') {
    throw new RangeError(`selectModel: registry[${idx}] is not an object.`);
  }
  if (typeof m.providerId !== 'string' || m.providerId.length === 0) {
    throw new RangeError(`selectModel: registry[${idx}].providerId must be a non-empty string.`);
  }
  if (typeof m.modelId !== 'string' || m.modelId.length === 0) {
    throw new RangeError(`selectModel: registry[${idx}].modelId must be a non-empty string.`);
  }
  if (m.tier !== 'flash' && m.tier !== 'pro') {
    throw new RangeError(`selectModel: registry[${idx}].tier must be 'flash' or 'pro'.`);
  }
  if (
    typeof m.maxInputTokens !== 'number' ||
    !Number.isFinite(m.maxInputTokens) ||
    m.maxInputTokens <= 0 ||
    !Number.isInteger(m.maxInputTokens)
  ) {
    throw new RangeError(`selectModel: registry[${idx}].maxInputTokens must be a positive finite integer.`);
  }
  if (
    !m.pricePerMTokens ||
    typeof m.pricePerMTokens.input !== 'number' ||
    typeof m.pricePerMTokens.output !== 'number' ||
    !Number.isFinite(m.pricePerMTokens.input) ||
    !Number.isFinite(m.pricePerMTokens.output) ||
    m.pricePerMTokens.input < 0 ||
    m.pricePerMTokens.output < 0
  ) {
    throw new RangeError(
      `selectModel: registry[${idx}].pricePerMTokens must have non-negative finite { input, output } numbers.`,
    );
  }
}

/**
 * Stable ordering used for tie-breaking. Sorting on `maxInputTokens` first
 * means "smallest fitting model" reduces to "first fitting entry after
 * filter", which keeps every selection branch deterministic regardless of
 * the caller's registry ordering.
 */
function compareForFit(a: ModelEntry, b: ModelEntry): number {
  if (a.maxInputTokens !== b.maxInputTokens) return a.maxInputTokens - b.maxInputTokens;
  if (a.modelId !== b.modelId) return a.modelId < b.modelId ? -1 : 1;
  if (a.providerId !== b.providerId) return a.providerId < b.providerId ? -1 : 1;
  return 0;
}

/** Compare two entries by cost: cheapest input price first, then output, then capacity, then ids. */
function compareForCost(a: ModelEntry, b: ModelEntry): number {
  if (a.pricePerMTokens.input !== b.pricePerMTokens.input) {
    return a.pricePerMTokens.input - b.pricePerMTokens.input;
  }
  if (a.pricePerMTokens.output !== b.pricePerMTokens.output) {
    return a.pricePerMTokens.output - b.pricePerMTokens.output;
  }
  return compareForFit(a, b);
}

function fits(m: ModelEntry, tokens: number): boolean {
  return m.maxInputTokens >= tokens;
}

function toOutput(m: ModelEntry): SelectModelOutput {
  return {
    providerId: m.providerId,
    modelId: m.modelId,
    tier: m.tier,
    maxInputTokens: m.maxInputTokens,
    pricePerMTokens: { input: m.pricePerMTokens.input, output: m.pricePerMTokens.output },
  };
}

function pickSmallestFitting(
  candidates: ReadonlyArray<ModelEntry>,
  tokens: number,
): ModelEntry | null {
  // `candidates` is assumed pre-sorted by `compareForFit` (asc).
  for (const m of candidates) {
    if (fits(m, tokens)) return m;
  }
  return null;
}

function pickCheapestFitting(
  candidates: ReadonlyArray<ModelEntry>,
  tokens: number,
): ModelEntry | null {
  let best: ModelEntry | null = null;
  for (const m of candidates) {
    if (!fits(m, tokens)) continue;
    if (best === null || compareForCost(m, best) < 0) best = m;
  }
  return best;
}

/**
 * Pure model-selection function. Given a non-empty `registry` and the
 * user's `profile`, returns one `{ providerId, modelId, tier, ... }`
 * whose `maxInputTokens >= tokens`.
 *
 * Selection rules:
 *
 *  - `speed`    — prefer the `flash` tier (fastest, lowest latency); fall
 *                 back to `pro` only when no `flash` entry fits the token
 *                 count. Within a tier, the smallest fitting model wins
 *                 (smaller flash → faster TTFT).
 *  - `cost`     — pick the cheapest fitting entry by
 *                 `pricePerMTokens.input` (then `output`, then capacity,
 *                 then ids), regardless of tier.
 *  - `privacy`  — restrict candidates to `providerId === 'ollama'`
 *                 (Requirement 29.4: refuse cloud providers); among local
 *                 entries, the smallest fitting one wins.
 *  - `balanced` — when `tokens <= balancedTierThreshold` (default
 *                 {@link DEFAULT_BALANCED_TIER_THRESHOLD}), prefer
 *                 `flash`; otherwise prefer `pro`. Falls back to the
 *                 other tier when the preferred tier has no fitting
 *                 entry.
 *
 * The function is **pure**: same inputs always produce the same output,
 * the registry is not mutated, and there is no I/O or randomness.
 *
 * Throws {@link ModelSelectorError} if:
 *   - `registry` is empty, or
 *   - no entry in the (possibly profile-filtered) registry has
 *     `maxInputTokens >= tokens`, or
 *   - `profile === 'privacy'` and no `ollama` entry exists in the
 *     registry.
 *
 * Throws {@link RangeError} if `tokens` or any registry field is invalid.
 */
export function selectModel(input: SelectModelInput): SelectModelOutput {
  const { tokens, profile, registry } = input;
  const balancedTierThreshold =
    input.balancedTierThreshold ?? DEFAULT_BALANCED_TIER_THRESHOLD;

  assertNonNegativeFiniteInt(tokens, 'tokens');
  assertNonNegativeFiniteInt(balancedTierThreshold, 'balancedTierThreshold');

  if (!Array.isArray(registry) || registry.length === 0) {
    throw new ModelSelectorError('selectModel: registry is empty.');
  }
  registry.forEach(assertValidEntry);

  if (
    profile !== 'speed' &&
    profile !== 'balanced' &&
    profile !== 'cost' &&
    profile !== 'privacy'
  ) {
    throw new RangeError(
      `selectModel: profile must be one of 'speed' | 'balanced' | 'cost' | 'privacy' (received ${String(profile)}).`,
    );
  }

  // Stable ordering: every branch consumes a sorted view so the caller's
  // registry order never affects the selection.
  const ordered = [...registry].sort(compareForFit);

  // ── privacy ─────────────────────────────────────────────────────────
  // Requirement 29.4: refuse cloud providers; only `ollama` is acceptable.
  if (profile === 'privacy') {
    const local = ordered.filter((m) => m.providerId === LOCAL_PROVIDER_ID);
    if (local.length === 0) {
      throw new ModelSelectorError(
        `selectModel: profile='privacy' requires a '${LOCAL_PROVIDER_ID}' provider in the registry.`,
      );
    }
    const chosen = pickSmallestFitting(local, tokens);
    if (chosen === null) {
      throw new ModelSelectorError(
        `selectModel: no '${LOCAL_PROVIDER_ID}' model has maxInputTokens >= ${tokens}.`,
      );
    }
    return toOutput(chosen);
  }

  // ── cost ────────────────────────────────────────────────────────────
  // Requirement 29.3: cheapest fitting model wins, regardless of tier.
  if (profile === 'cost') {
    const chosen = pickCheapestFitting(ordered, tokens);
    if (chosen === null) {
      throw new ModelSelectorError(
        `selectModel: no model in registry has maxInputTokens >= ${tokens}.`,
      );
    }
    return toOutput(chosen);
  }

  // ── speed / balanced ────────────────────────────────────────────────
  // Tier preference: speed always prefers flash (Requirement 29.2);
  // balanced prefers flash up to `balancedTierThreshold`, then pro.
  const preferredTier: Tier =
    profile === 'speed'
      ? 'flash'
      : tokens <= balancedTierThreshold
        ? 'flash'
        : 'pro';

  const preferred = ordered.filter((m) => m.tier === preferredTier);
  const preferredChoice = pickSmallestFitting(preferred, tokens);
  if (preferredChoice !== null) return toOutput(preferredChoice);

  // Fallback to the other tier when the preferred tier has nothing fitting.
  const fallbackTier: Tier = preferredTier === 'flash' ? 'pro' : 'flash';
  const fallback = ordered.filter((m) => m.tier === fallbackTier);
  const fallbackChoice = pickSmallestFitting(fallback, tokens);
  if (fallbackChoice !== null) return toOutput(fallbackChoice);

  throw new ModelSelectorError(
    `selectModel: no model in registry has maxInputTokens >= ${tokens}.`,
  );
}
