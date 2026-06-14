// ============================================
// Zule AI — Spend Panel
// ============================================
//
// Displays daily/weekly/monthly token usage and estimated cost per
// provider. Rendered as a section within Settings (Requirement 28.3).

import { useState, useEffect, useCallback } from 'react';
import { DollarSign } from 'lucide-react';
import { database } from '../data/database';
import type { ProviderConfig } from '../data/database';
import {
  aggregateSpend,
  type SpendPeriod,
  type SpendSummary,
  type TelemetryTokenEvent,
} from '../brain/spendTracker';
import type { PricePerMTokens } from '../brain/cost';

// Provider display names (matches Settings.tsx)
const PROVIDER_LABELS: Record<string, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  simulation: 'Simulation',
};

const PERIOD_LABELS: Record<SpendPeriod, string> = {
  day: 'Today',
  week: 'This Week',
  month: 'This Month',
};

function formatCost(usd: number): string {
  if (usd < 0.01 && usd > 0) return '< $0.01';
  return `$${usd.toFixed(4)}`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

export function SpendPanel() {
  const [period, setPeriod] = useState<SpendPeriod>('day');
  const [summaries, setSummaries] = useState<SpendSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSpendData = useCallback(async (selectedPeriod: SpendPeriod) => {
    setLoading(true);
    try {
      // Query telemetry events for the relevant time range
      const rangeMs = selectedPeriod === 'day'
        ? 24 * 60 * 60 * 1000
        : selectedPeriod === 'week'
          ? 7 * 24 * 60 * 60 * 1000
          : 31 * 24 * 60 * 60 * 1000;

      const events = await database.queryTelemetryEvents<TelemetryTokenEvent>(
        Date.now() - rangeMs,
      );

      // Filter to only 'tokens' events
      const tokenEvents = events.filter(
        (e): e is TelemetryTokenEvent => e.kind === 'tokens',
      );

      // Load provider price configs
      const providers = await database.getSetting<ProviderConfig[]>('providers', []);
      const prices: Record<string, PricePerMTokens> = {};
      for (const p of providers) {
        if (p.pricePerMTokens) {
          prices[p.id] = p.pricePerMTokens;
        }
      }

      const results = aggregateSpend(tokenEvents, selectedPeriod, prices);
      setSummaries(results);
    } catch (err) {
      console.error('[SpendPanel] Failed to load spend data:', err);
      setSummaries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSpendData(period);
  }, [period, loadSpendData]);

  const totalCost = summaries.reduce((sum, s) => sum + s.cost, 0);
  const totalPrompt = summaries.reduce((sum, s) => sum + s.promptTokens, 0);
  const totalCompletion = summaries.reduce((sum, s) => sum + s.completionTokens, 0);

  return (
    <section className="settings-section glass-card animate-slide-up" style={{ animationDelay: '0.32s' }}>
      <div className="section-header">
        <DollarSign size={18} />
        <h2>Spend</h2>
      </div>

      <p className="section-desc">
        Token usage and estimated cost per provider. Configure per-model pricing in the AI Providers section above.
      </p>

      {/* Period selector */}
      <div className="spend-period-selector" role="radiogroup" aria-label="Spend period">
        {(['day', 'week', 'month'] as const).map((p) => (
          <button
            key={p}
            className={`spend-period-btn ${period === p ? 'active' : ''}`}
            onClick={() => setPeriod(p)}
            role="radio"
            aria-checked={period === p}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>

      {/* Summary total */}
      <div className="spend-total">
        <span className="spend-total-label">Total ({PERIOD_LABELS[period]})</span>
        <span className="spend-total-value">{formatCost(totalCost)}</span>
        <span className="spend-total-tokens">
          {formatTokens(totalPrompt)} prompt · {formatTokens(totalCompletion)} completion
        </span>
      </div>

      {/* Breakdown table */}
      {loading ? (
        <div className="spend-loading">Loading spend data…</div>
      ) : summaries.length === 0 ? (
        <div className="spend-empty">
          <p>No token usage recorded for {PERIOD_LABELS[period].toLowerCase()}.</p>
        </div>
      ) : (
        <div className="spend-table-wrapper">
          <table className="spend-table" aria-label="Provider spend breakdown">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
                <th className="spend-num">Prompt Tokens</th>
                <th className="spend-num">Completion Tokens</th>
                <th className="spend-num">Est. Cost</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((row) => (
                <tr key={`${row.providerId}-${row.modelId}`}>
                  <td>{PROVIDER_LABELS[row.providerId] ?? row.providerId}</td>
                  <td className="spend-model">{row.modelId}</td>
                  <td className="spend-num">{formatTokens(row.promptTokens)}</td>
                  <td className="spend-num">{formatTokens(row.completionTokens)}</td>
                  <td className="spend-num spend-cost">{formatCost(row.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
