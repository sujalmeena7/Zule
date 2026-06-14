// ============================================
// Zule AI — computeCost
// ============================================
//
// Pure helper used by the Telemetry_Module and the Spend tab to translate
// a request's prompt/completion token counts plus the per-million-token
// configured prices into an approximate USD cost.
//
// Implements Requirements 28.1, 28.2, 28.3:
//
//   - Requirement 28.1 — `AI_Provider_Router` records prompt tokens and
//     completion tokens per request; this helper turns those counts into
//     dollars.
//   - Requirement 28.2 — `Settings_Store` lets the user configure
//     per-model `pricePerMTokens.{input, output}`; `Telemetry_Module`
//     multiplies token counts by those prices.
//   - Requirement 28.3 — the Spend tab summarises daily/weekly/monthly
//     cost per provider and per session by summing per-request costs.
//
// The formula, per design.md Property 60:
//
//     cost = (promptTokens / 1e6) * pricePerMTokens.input
//          + (completionTokens / 1e6) * pricePerMTokens.output
//
// Property 60 (validates Requirements 28.1, 28.2, 28.3) checks that the
// result is non-negative on the non-negative input domain and that
// summation across a partition of requests equals the total cost (within
// floating-point tolerance).

/**
 * Per-million-token pricing for a model, mirroring
 * `Capabilities.pricePerMTokens` and `Settings.providers[].pricePerMTokens`
 * in `design.md` (§AI_Provider_Router, §Settings_Store).
 *
 * Both sides are USD per 1 000 000 tokens; non-negative finite numbers.
 */
export interface PricePerMTokens {
  /** USD per 1 000 000 prompt (input) tokens. */
  input: number;
  /** USD per 1 000 000 completion (output) tokens. */
  output: number;
}

/** Input shape for {@link computeCost}. */
export interface ComputeCostInput {
  /** Prompt token count for the request; non-negative finite integer. */
  promptTokens: number;
  /** Completion token count for the request; non-negative finite integer. */
  completionTokens: number;
  /** Per-million-token pricing for the model that served the request. */
  pricePerMTokens: PricePerMTokens;
}

/** Tokens-per-million divisor used by {@link computeCost}. */
export const TOKENS_PER_MILLION = 1_000_000;

function assertNonNegativeFinite(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `computeCost: ${label} must be a non-negative finite number (received ${String(value)}).`,
    );
  }
}

/**
 * Approximate USD cost for a single request, given its prompt and
 * completion token counts and the per-million-token prices configured
 * for the model.
 *
 *     cost = (promptTokens / 1_000_000) * pricePerMTokens.input
 *          + (completionTokens / 1_000_000) * pricePerMTokens.output
 *
 * Inputs must all be non-negative finite numbers; otherwise a
 * `RangeError` is thrown. The function is pure (referentially
 * transparent) and total over the documented domain.
 *
 * @example
 *   computeCost({
 *     promptTokens: 1_000_000,
 *     completionTokens: 500_000,
 *     pricePerMTokens: { input: 3, output: 6 },
 *   }); // → 3 + 3 = 6 USD
 */
export function computeCost(input: ComputeCostInput): number {
  const { promptTokens, completionTokens, pricePerMTokens } = input;

  assertNonNegativeFinite(promptTokens, 'promptTokens');
  assertNonNegativeFinite(completionTokens, 'completionTokens');

  if (
    pricePerMTokens === null ||
    typeof pricePerMTokens !== 'object'
  ) {
    throw new RangeError(
      'computeCost: pricePerMTokens must be an object with non-negative finite { input, output } fields.',
    );
  }

  assertNonNegativeFinite(pricePerMTokens.input, 'pricePerMTokens.input');
  assertNonNegativeFinite(pricePerMTokens.output, 'pricePerMTokens.output');

  const inputCost = (promptTokens / TOKENS_PER_MILLION) * pricePerMTokens.input;
  const outputCost =
    (completionTokens / TOKENS_PER_MILLION) * pricePerMTokens.output;

  return inputCost + outputCost;
}
