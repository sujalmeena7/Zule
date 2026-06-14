// ============================================
// Zule AI — Spend Tracker
// ============================================
//
// Pure helper that aggregates token-usage telemetry events into
// per-provider cost summaries over daily, weekly, or monthly periods.
//
// Used by the Spend section in Settings (Requirement 28.3).

import { computeCost, type PricePerMTokens } from './cost';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

/** A stored telemetry event of kind 'tokens' with its timestamp. */
export interface TelemetryTokenEvent {
  kind: 'tokens';
  at: number; // Unix ms timestamp
  promptTokens: number;
  completionTokens: number;
  modelId: string;
  providerId: string;
}

/** The time period over which to aggregate spend. */
export type SpendPeriod = 'day' | 'week' | 'month';

/** A single row in the spend summary table. */
export interface SpendSummary {
  providerId: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  periodStart: number; // Unix ms timestamp for the beginning of the period
}

// ---------------------------------------------------------------------
// Period boundary helpers
// ---------------------------------------------------------------------

/**
 * Returns the start-of-period timestamp (midnight UTC) for a given
 * reference timestamp and period type.
 */
export function getPeriodStart(referenceMs: number, period: SpendPeriod): number {
  const date = new Date(referenceMs);

  switch (period) {
    case 'day': {
      const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      return d.getTime();
    }
    case 'week': {
      // Week starts on Monday (ISO)
      const day = date.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
      const diff = day === 0 ? 6 : day - 1; // days since Monday
      const monday = new Date(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate() - diff,
      ));
      return monday.getTime();
    }
    case 'month': {
      const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
      return d.getTime();
    }
  }
}

// ---------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------

/**
 * Aggregate token-usage telemetry events into per-provider spend
 * summaries for the current period (day, week, or month).
 *
 * Events outside the current period (relative to `now`) are excluded.
 * The prices map provides per-provider pricing; providers without a
 * configured price default to { input: 0, output: 0 }.
 *
 * @param events - Array of token telemetry events
 * @param period - 'day' | 'week' | 'month'
 * @param prices - Map of providerId to PricePerMTokens
 * @param now - Reference timestamp (defaults to Date.now())
 * @returns Array of SpendSummary rows, one per (providerId, modelId)
 */
export function aggregateSpend(
  events: TelemetryTokenEvent[],
  period: SpendPeriod,
  prices: Record<string, PricePerMTokens>,
  now: number = Date.now(),
): SpendSummary[] {
  const periodStart = getPeriodStart(now, period);

  // Filter events within the current period
  const filtered = events.filter(
    (e) => e.kind === 'tokens' && e.at >= periodStart,
  );

  // Group by (providerId, modelId)
  const groups = new Map<string, {
    providerId: string;
    modelId: string;
    promptTokens: number;
    completionTokens: number;
  }>();

  for (const event of filtered) {
    const key = `${event.providerId}::${event.modelId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.promptTokens += event.promptTokens;
      existing.completionTokens += event.completionTokens;
    } else {
      groups.set(key, {
        providerId: event.providerId,
        modelId: event.modelId,
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
      });
    }
  }

  // Compute cost for each group
  const summaries: SpendSummary[] = [];
  for (const group of groups.values()) {
    const pricePerMTokens = prices[group.providerId] ?? { input: 0, output: 0 };
    const cost = computeCost({
      promptTokens: group.promptTokens,
      completionTokens: group.completionTokens,
      pricePerMTokens,
    });
    summaries.push({
      providerId: group.providerId,
      modelId: group.modelId,
      promptTokens: group.promptTokens,
      completionTokens: group.completionTokens,
      cost,
      periodStart,
    });
  }

  // Sort by cost descending for display
  summaries.sort((a, b) => b.cost - a.cost);

  return summaries;
}
