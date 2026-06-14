// ============================================
// Zule AI — useZuleError hook
// ============================================
//
// Single orchestration-layer site that translates a `ZuleError` into
//   1. a user-facing toast (with the correct ARIA role per the recovery
//      policy table in design.md §Error Handling), and
//   2. a telemetry emit (currently a placeholder — wired up in task 18.x
//      when Telemetry_Module lands).
//
// This eliminates the spread of ad-hoc `console.error` / `alert(...)` calls
// across the codebase (Requirement 18.7) and gives us one place to evolve
// the recovery UX (Requirement 10.7's PendingTaskTracker integrates with
// this hook by `.catch(notifyError)` on its registered promises).
//
// Usage:
//
//   const notifyError = useZuleError();
//   const result = await fetchSomething();
//   if (!result.ok) notifyError(result.error);
//
// or, on a rejection chain:
//
//   pendingTaskTracker.add(saveFacts(...)).catch((e) => notifyError({
//     kind: 'unhandled-rejection',
//     name: e instanceof Error ? e.name : 'Error',
//   }));

import { useCallback } from 'react';
import toast from 'react-hot-toast';
import type { ZuleError } from '../types/errors';

/**
 * `'alert'` toasts surface blocking errors that need user attention
 * (`role="alert"`, `aria-live="assertive"`); `'status'` toasts surface
 * recoverable, non-blocking notifications (`role="status"`,
 * `aria-live="polite"`). The mapping per error kind comes from the
 * Recovery policy table in design.md.
 */
type Severity = 'alert' | 'status';

interface ToastSpec {
  message: string;
  severity: Severity;
  /** When false, the error is logged silently (no toast) — e.g. abort. */
  silent?: boolean;
}

/**
 * Pure mapping from `ZuleError` to the user-visible message + severity.
 * Exported for unit tests and so other surfaces (e.g. the offline banner)
 * can re-use the canonical phrasing.
 */
export function describeZuleError(e: ZuleError): ToastSpec {
  switch (e.kind) {
    // Transcription_Engine -----------------------------------------------
    case 'transcription.permission-denied':
      return {
        message: 'Microphone access was denied. Click to retry.',
        severity: 'alert',
      };
    case 'transcription.permission-revoked':
      return {
        message: 'Microphone access was revoked. Click to resume.',
        severity: 'alert',
      };
    case 'transcription.unsupported':
      return {
        message:
          "This browser doesn't support speech recognition. " +
          'Switch to the local Whisper provider in Settings.',
        severity: 'alert',
      };
    case 'transcription.no-speech':
    case 'transcription.audio-capture':
      // Per recovery policy: logged silently, non-fatal.
      return { message: '', severity: 'status', silent: true };
    case 'transcription.network':
      return {
        message: 'Speech recognition lost network. Retrying…',
        severity: 'status',
      };

    // Screen_Capture_Module ----------------------------------------------
    case 'screen.permission-denied':
      return {
        message: 'Screen sharing was denied.',
        severity: 'alert',
      };
    case 'screen.autoplay-blocked':
      return {
        message:
          'Screen capture could not start because autoplay was blocked. ' +
          'Try again after interacting with the page.',
        severity: 'alert',
      };
    case 'screen.unsupported':
      return {
        message: "This browser doesn't support screen capture.",
        severity: 'alert',
      };

    // OCR_Worker ---------------------------------------------------------
    case 'ocr.worker-failed':
      return {
        message:
          e.consecutiveFailures >= 3
            ? 'Screen text recognition failed repeatedly and has been disabled for this session.'
            : 'Screen text recognition hit a transient error and is restarting.',
        severity: 'status',
      };

    // Vector_Index -------------------------------------------------------
    case 'vector-index.init-failed':
      return {
        message:
          'Could not load the local embedding model after ' +
          `${e.attempts} attempt${e.attempts === 1 ? '' : 's'}. ` +
          'Knowledge-base search and the response cache are unavailable.',
        severity: 'alert',
      };

    // AI_Provider_Router -------------------------------------------------
    case 'provider.network':
      return {
        message: `Network error talking to ${e.providerId}. Retrying…`,
        severity: 'status',
      };
    case 'provider.timeout':
      return {
        message: `${e.providerId} timed out. Retrying…`,
        severity: 'status',
      };
    case 'provider.rate-limited':
      return {
        message:
          `${e.providerId} is rate-limited` +
          (e.retryAfterMs ? ` (retrying in ${Math.ceil(e.retryAfterMs / 1000)}s).` : '.'),
        severity: 'status',
      };
    case 'provider.server-error':
      return {
        message: `${e.providerId} returned a server error (${e.status}).`,
        severity: 'status',
      };
    case 'provider.unauthorized':
      return {
        message:
          `${e.providerId} rejected the API key. ` +
          'Update it in Settings.',
        severity: 'alert',
      };
    case 'provider.aborted':
      // Per recovery policy: silent.
      return { message: '', severity: 'status', silent: true };

    // Persistence --------------------------------------------------------
    case 'storage.quota-exceeded':
      return {
        message:
          'Local storage is full. Delete oldest meetings or knowledge ' +
          'chunks from Settings to free space.',
        severity: 'alert',
      };
    case 'storage.corrupted':
      return {
        message:
          'Local data appears corrupted. Export your data from Settings ' +
          'before resetting.',
        severity: 'alert',
      };
    case 'storage.import-invalid':
      return {
        message: `Import failed: ${e.reason}. No data was changed.`,
        severity: 'alert',
      };

    // CryptoVault --------------------------------------------------------
    case 'crypto.decrypt-failed':
      return {
        message: 'Could not decrypt stored credentials.',
        severity: 'alert',
      };
    case 'crypto.passphrase-wrong':
      return {
        message: 'Wrong passphrase. Please try again.',
        severity: 'alert',
      };

    // Document_Parser ----------------------------------------------------
    case 'document.unsupported-extension':
      return {
        message:
          `"${e.ext}" files are not supported. ` +
          'Use .txt, .md, .json, .pdf or .docx.',
        severity: 'status',
      };
    case 'document.encrypted-pdf':
      return {
        message:
          'This PDF is password-protected and cannot be parsed.',
        severity: 'alert',
      };

    // Cross_Window_Sync --------------------------------------------------
    case 'cross-window.popup-blocked':
      return {
        message:
          'Detached window blocked by the popup blocker. ' +
          'Allow popups for this origin and try again.',
        severity: 'alert',
      };
    case 'cross-window.host-disconnected':
      return {
        message: 'Lost connection to the host window.',
        severity: 'alert',
      };
    case 'cross-window.broadcast-unsupported':
      // Per recovery policy: silent fallback.
      return { message: '', severity: 'status', silent: true };

    // Top-level catch-all ------------------------------------------------
    case 'unhandled-rejection':
      return {
        message: `An unexpected error occurred (${e.name}).`,
        severity: 'status',
      };
  }
}

/**
 * Placeholder telemetry sink. Replaced by `Telemetry_Module.emit` in
 * task 18.x. Intentionally content-free — only the discriminator and any
 * non-content metadata flow into telemetry (Requirement 19.4, 19.5).
 *
 * The function is exported so tests can spy on it; in production this is
 * the only side-effect besides the toast.
 */
export function emitErrorTelemetryPlaceholder(e: ZuleError): void {
  // Strip any payload fields by re-projecting only `kind` plus the
  // structurally-safe metadata fields. This guards against accidentally
  // adding content-bearing fields to `ZuleError` later — telemetry
  // remains content-free by construction.
  const meta: Record<string, string | number> = { kind: e.kind };
  if ('providerId' in e) meta.providerId = e.providerId;
  if ('status' in e) meta.status = e.status;
  if ('consecutiveFailures' in e) meta.consecutiveFailures = e.consecutiveFailures;
  if ('attempts' in e) meta.attempts = e.attempts;
  if ('ext' in e) meta.ext = e.ext;
  if ('name' in e) meta.name = e.name;

  // Dev-only breadcrumb. Replaced by Telemetry_Module.emit later.
  if (import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.debug('[telemetry:error]', meta);
  }
}

/**
 * Hook returning a stable `notifyError` callback. Always call it with a
 * `ZuleError`; if you have a thrown `unknown`, classify it at the
 * boundary first (or fall back to `{ kind: 'unhandled-rejection', name }`).
 */
export function useZuleError(): (e: ZuleError) => void {
  return useCallback((e: ZuleError) => {
    const spec = describeZuleError(e);
    emitErrorTelemetryPlaceholder(e);

    if (spec.silent || !spec.message) return;

    // react-hot-toast respects `ariaProps` on a per-toast basis. We map
    // 'alert' → role=alert (assertive) and 'status' → role=status (polite)
    // so screen readers honour the recovery policy from design.md.
    const ariaProps =
      spec.severity === 'alert'
        ? { role: 'alert' as const, 'aria-live': 'assertive' as const }
        : { role: 'status' as const, 'aria-live': 'polite' as const };

    if (spec.severity === 'alert') {
      toast.error(spec.message, { ariaProps });
    } else {
      toast(spec.message, { ariaProps });
    }
  }, []);
}
