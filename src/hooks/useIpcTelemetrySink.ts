// ============================================================================
// Zule AI — IPC Telemetry Sink Hook
// ============================================================================
//
// Listens for MetricEvent messages forwarded from the main process via the
// existing `ipc-sync-message` channel and routes them to the renderer's
// TelemetryModule for IndexedDB persistence.
//
// This bridges the gap between main-process telemetry emitters (auto-updater,
// vectorIndex) and the renderer-side telemetry sink. The main process sends
// typed MetricEvent objects via `webContents.send('ipc-sync-message', event)`,
// and this hook picks them up and calls `telemetry.emit()`.
//
// Requirements: 9.1, 9.2, 9.3, 9.4, 9.5

import { useEffect } from 'react';
import { telemetry } from '../brain/telemetry';
import type { MetricEvent } from '../brain/telemetry';

/**
 * Known MetricEvent `kind` values that arrive from the main process.
 * Used to discriminate telemetry messages from other sync messages
 * (e.g., SyncMessage variants like 'state-update', 'heartbeat').
 */
const MAIN_PROCESS_METRIC_KINDS = new Set<string>([
  'vectorIndex.query',
  'update.checked',
  'update.available',
  'update.downloaded',
  'update.installed',
  'update.error',
]);

/**
 * Type guard: checks if an unknown message is a MetricEvent forwarded
 * from the main process.
 */
function isMainProcessMetricEvent(msg: unknown): msg is MetricEvent {
  if (!msg || typeof msg !== 'object') return false;
  const candidate = msg as Record<string, unknown>;
  return (
    typeof candidate.kind === 'string' &&
    MAIN_PROCESS_METRIC_KINDS.has(candidate.kind)
  );
}

/**
 * React hook that subscribes to the `onSyncMessage` IPC bridge and
 * forwards main-process MetricEvents to the renderer's TelemetryModule.
 *
 * Mount this once in the dashboard's root component (App or AppContent).
 * It is safe to call in non-Electron environments (no-ops gracefully).
 */
export function useIpcTelemetrySink(): void {
  useEffect(() => {
    const api = typeof window !== 'undefined'
      ? (window as Window & { electronAPI?: { onSyncMessage?: (cb: (msg: unknown) => void) => () => void } }).electronAPI
      : undefined;

    if (!api?.onSyncMessage) return;

    const unsubscribe = api.onSyncMessage((message: unknown) => {
      if (isMainProcessMetricEvent(message)) {
        telemetry.emit(message);
      }
    });

    return unsubscribe;
  }, []);
}
