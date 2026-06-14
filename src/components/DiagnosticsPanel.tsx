// ============================================
// Zule AI — Diagnostics Panel (Requirement 19.2)
// ============================================
//
// Renders the most-recent 24 hours of telemetry events in a
// chronological list grouped by event kind, with counts per kind
// and a "Clear Telemetry" action.

import { useState, useEffect, useCallback } from 'react';
import { Activity, Trash2, RefreshCw } from 'lucide-react';
import { telemetry, type StoredTelemetryEvent, type MetricEvent } from '../brain/telemetry';
import toast from 'react-hot-toast';

/** All known metric event kinds for display purposes. */
const EVENT_KIND_LABELS: Record<MetricEvent['kind'], string> = {
  'ttft': 'Time to First Token',
  'totalLatency': 'Total Latency',
  'retry': 'Retry',
  'cache.hit': 'Cache Hit',
  'cache.miss': 'Cache Miss',
  'transcript.drop': 'Transcript Drop',
  'ocr.skipped': 'OCR Skipped',
  'embedding.cache': 'Embedding Cache',
  'memory.size': 'Memory Size',
  'tokens': 'Token Usage',
  'error': 'Error',
  'latency.degraded': 'Latency Degraded',
};

/** Badge colors per event kind for visual grouping. */
const EVENT_KIND_COLORS: Record<MetricEvent['kind'], string> = {
  'ttft': '#60a5fa',
  'totalLatency': '#818cf8',
  'retry': '#f59e0b',
  'cache.hit': '#34d399',
  'cache.miss': '#fb7185',
  'transcript.drop': '#f97316',
  'ocr.skipped': '#a78bfa',
  'embedding.cache': '#2dd4bf',
  'memory.size': '#a3e635',
  'tokens': '#67e8f9',
  'error': '#ef4444',
  'latency.degraded': '#fbbf24',
};

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export function DiagnosticsPanel() {
  const [events, setEvents] = useState<StoredTelemetryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const data = await telemetry.query(TWENTY_FOUR_HOURS_MS);
      // Sort chronologically (most recent first)
      data.sort((a, b) => b.at - a.at);
      setEvents(data);
    } catch (err) {
      console.error('[DiagnosticsPanel] Failed to load telemetry:', err);
      toast.error('Failed to load telemetry data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const handleClear = useCallback(async () => {
    setClearing(true);
    try {
      await telemetry.clearAll();
      setEvents([]);
      toast.success('Telemetry cleared.');
    } catch (err) {
      console.error('[DiagnosticsPanel] Failed to clear telemetry:', err);
      toast.error('Failed to clear telemetry.');
    } finally {
      setClearing(false);
    }
  }, []);

  // Compute counts per kind
  const countsByKind = events.reduce<Record<string, number>>((acc, ev) => {
    acc[ev.kind] = (acc[ev.kind] || 0) + 1;
    return acc;
  }, {});

  // Group events by kind for the detailed list
  const groupedByKind = events.reduce<Record<string, StoredTelemetryEvent[]>>((acc, ev) => {
    if (!acc[ev.kind]) acc[ev.kind] = [];
    acc[ev.kind].push(ev);
    return acc;
  }, {});

  const sortedKinds = Object.keys(groupedByKind).sort();

  return (
    <div className="settings page-container">
      <h1 className="settings-title animate-slide-up">Diagnostics</h1>

      {/* Summary Counts */}
      <section className="settings-section glass-card animate-slide-up">
        <div className="section-header">
          <Activity size={18} />
          <h2>Last 24 Hours — Summary</h2>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
            <button
              className="btn-secondary"
              onClick={loadEvents}
              disabled={loading}
              style={{ padding: '6px 14px', fontSize: '0.78rem' }}
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
            <button
              className="btn-secondary"
              onClick={handleClear}
              disabled={clearing || events.length === 0}
              style={{ padding: '6px 14px', fontSize: '0.78rem', color: '#ef4444' }}
            >
              <Trash2 size={14} />
              Clear Telemetry
            </button>
          </div>
        </div>

        {loading ? (
          <p style={{ color: 'var(--text-secondary)', padding: '16px 0' }}>Loading telemetry…</p>
        ) : events.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', padding: '16px 0' }}>
            No telemetry events recorded in the last 24 hours.
          </p>
        ) : (
          <div className="diagnostics-counts" style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '12px' }}>
            {Object.entries(countsByKind)
              .sort(([, a], [, b]) => b - a)
              .map(([kind, count]) => (
                <div
                  key={kind}
                  className="diagnostics-count-badge"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 12px',
                    borderRadius: '8px',
                    background: 'rgba(255,255,255,0.04)',
                    border: `1px solid ${EVENT_KIND_COLORS[kind as MetricEvent['kind']] || '#64748b'}`,
                    fontSize: '0.8rem',
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: EVENT_KIND_COLORS[kind as MetricEvent['kind']] || '#64748b',
                    }}
                  />
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {EVENT_KIND_LABELS[kind as MetricEvent['kind']] || kind}
                  </span>
                  <span style={{ fontWeight: 600 }}>{count}</span>
                </div>
              ))}
          </div>
        )}
      </section>

      {/* Grouped Event Details */}
      {!loading && events.length > 0 && (
        <section className="settings-section glass-card animate-slide-up" style={{ animationDelay: '0.05s' }}>
          <div className="section-header">
            <Activity size={18} />
            <h2>Events by Kind</h2>
            <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
              {events.length} total event{events.length !== 1 ? 's' : ''}
            </span>
          </div>

          {sortedKinds.map((kind) => (
            <details key={kind} className="diagnostics-kind-group" style={{ marginBottom: '12px' }}>
              <summary
                style={{
                  cursor: 'pointer',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  background: 'rgba(255,255,255,0.02)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontSize: '0.85rem',
                  listStyle: 'none',
                }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: EVENT_KIND_COLORS[kind as MetricEvent['kind']] || '#64748b',
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontWeight: 500 }}>
                  {EVENT_KIND_LABELS[kind as MetricEvent['kind']] || kind}
                </span>
                <span style={{ color: 'var(--text-secondary)', marginLeft: 'auto' }}>
                  {groupedByKind[kind].length}
                </span>
              </summary>
              <div
                style={{
                  maxHeight: '300px',
                  overflowY: 'auto',
                  marginTop: '8px',
                  paddingLeft: '18px',
                }}
              >
                <table
                  style={{
                    width: '100%',
                    fontSize: '0.75rem',
                    borderCollapse: 'collapse',
                  }}
                >
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                      <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-secondary)' }}>
                        Time
                      </th>
                      <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-secondary)' }}>
                        Details
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupedByKind[kind].map((ev) => (
                      <tr
                        key={ev.id}
                        style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                      >
                        <td
                          style={{
                            padding: '4px 8px',
                            whiteSpace: 'nowrap',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          {new Date(ev.at).toLocaleTimeString()}
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          {formatEventDetails(ev)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </section>
      )}
    </div>
  );
}

/** Format the relevant details for a telemetry event row. */
function formatEventDetails(ev: StoredTelemetryEvent): string {
  const kind = ev.kind as MetricEvent['kind'];
  switch (kind) {
    case 'ttft':
    case 'totalLatency':
      return `${ev.ms}ms — ${ev.modelId} (${ev.providerId})`;
    case 'retry':
      return `${ev.count} retries — ${ev.providerId}`;
    case 'cache.hit':
      return `similarity: ${(ev.similarity as number)?.toFixed(3) ?? '—'}`;
    case 'cache.miss':
      return '—';
    case 'transcript.drop':
      return `reason: ${ev.reason}`;
    case 'ocr.skipped':
      return `reason: ${ev.reason}`;
    case 'embedding.cache':
      return `outcome: ${ev.outcome}`;
    case 'memory.size':
      return `${ev.chunks} chunks`;
    case 'tokens':
      return `prompt: ${ev.promptTokens}, completion: ${ev.completionTokens} — ${ev.modelId}`;
    case 'error':
      return `${ev.name}: ${ev.message}`;
    case 'latency.degraded':
      return 'Latency budget exceeded';
    default:
      return JSON.stringify(ev);
  }
}
