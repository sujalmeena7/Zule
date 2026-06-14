// ============================================
// Zule AI — Shared HTTP utilities for provider adapters
// ============================================
//
// Every cloud and local-runtime adapter (Gemini, OpenAI, Anthropic, Ollama,
// Simulation) routes its outbound HTTP traffic through this module so that
// timeout, abort honouring, and retry-with-jitter behaviour stay uniform
// across providers. Centralising these concerns is what makes Provider_
// Adapters thin data-plane shims (design.md §3. AI_Provider_Router).
//
// Defaults (Requirement 4.4 and 4.5):
//   - Streaming requests:     12 000 ms per-request timeout
//   - Non-streaming requests:  6 000 ms per-request timeout
//   - Retry: up to 3 attempts (initial + 2 retries), 500 ms initial delay,
//            ±20% jitter, cumulative wait capped at 8 000 ms.
//
// All exported functions are pure with respect to their inputs (the random
// source, sleep, and `fetch` are injectable via the options bag) so the
// retry classifier and timeout semantics are property-testable without
// real wall-clock dependencies (Property 10).

import type { ProviderRequestKind } from './types';

// --- Per-request timeout budgets (Requirement 4.4) ---

export const DEFAULT_NON_STREAMING_TIMEOUT_MS = 6_000;
export const DEFAULT_STREAMING_TIMEOUT_MS = 12_000;

// --- Retry-with-jitter parameters (Requirement 4.5) ---

/**
 * Maximum total attempts including the initial call. The current adapter
 * surface treats the initial call as attempt 1, so this value of 3 means
 * one initial call plus up to two retries before giving up.
 */
export const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_INITIAL_DELAY_MS = 500;
/** Symmetric jitter ratio: actual delay falls in `[base * (1 - r), base * (1 + r)]`. */
export const RETRY_JITTER_RATIO = 0.2;
export const RETRY_CUMULATIVE_CAP_MS = 8_000;

// --- fetchWithTimeout ----------------------------------------------------

export interface FetchWithTimeoutOptions {
  /**
   * Per-request timeout in milliseconds. Defaults to
   * `DEFAULT_STREAMING_TIMEOUT_MS` when `kind === 'streaming'`, otherwise
   * `DEFAULT_NON_STREAMING_TIMEOUT_MS`.
   */
  timeoutMs?: number;
  /**
   * Caller-supplied abort signal. When this signal aborts, the underlying
   * `fetch` is cancelled within one event-loop tick, satisfying
   * Requirement 4.7's 200 ms upper bound.
   */
  signal?: AbortSignal;
  /** Selects the default timeout when `timeoutMs` is omitted. */
  kind?: ProviderRequestKind;
  /**
   * Injectable `fetch` for tests. Defaults to `globalThis.fetch`. Reading the
   * global lazily keeps the helper resilient to test code that swaps
   * `globalThis.fetch` per test (vi.fn replacements).
   */
  fetchImpl?: typeof fetch;
}

/**
 * Wraps `fetch` with an internal `AbortController` so the request is aborted
 * when either the per-request timeout elapses or the caller's signal aborts.
 *
 * Semantics:
 * - If `opts.timeoutMs` ms elapse before the response is received, the
 *   underlying fetch is aborted and this function rejects with a
 *   `DOMException` whose `name === 'AbortError'`. (Property 10.)
 * - If the caller-supplied signal aborts, the underlying fetch is aborted
 *   and the rejection propagates the caller's abort reason (the standard
 *   `AbortError` when no reason was supplied).
 * - Otherwise the fetch resolves normally with its `Response`.
 *
 * The internal controller is the signal we pass to `fetch`; observers (e.g.
 * the streaming reader) can rely on `signal.aborted === true` after either
 * abort path triggers.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: FetchWithTimeoutOptions,
): Promise<Response> {
  const timeoutMs =
    opts?.timeoutMs ??
    (opts?.kind === 'streaming'
      ? DEFAULT_STREAMING_TIMEOUT_MS
      : DEFAULT_NON_STREAMING_TIMEOUT_MS);

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `fetchWithTimeout: timeoutMs must be a positive finite number, received ${timeoutMs}`,
    );
  }

  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const callerSignal = opts?.signal ?? init?.signal ?? null;

  // Forward an existing caller-side abort immediately.
  let onCallerAbort: (() => void) | undefined;
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      onCallerAbort = () => controller.abort(callerSignal.reason);
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  // Arm the timeout watchdog. Track `timedOut` in closure so the catch block
  // can normalise the rejection to a recognisable AbortError regardless of
  // what `fetch` happens to surface for an aborted signal in this runtime.
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (!controller.signal.aborted) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      // Normalise: callers (and Property 10) can branch on `name === 'AbortError'`.
      throw new DOMException(
        `Request timed out after ${timeoutMs} ms`,
        'AbortError',
      );
    }
    throw err;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (callerSignal && onCallerAbort) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }
}

// --- retryWithJitter -----------------------------------------------------

export interface RetryWithJitterOptions {
  /** Maximum total attempts. Default `RETRY_MAX_ATTEMPTS` (3). */
  attempts?: number;
  /** Base delay before the first retry. Default `RETRY_INITIAL_DELAY_MS` (500). */
  initialDelayMs?: number;
  /** Symmetric jitter ratio. Default `RETRY_JITTER_RATIO` (0.20). */
  jitterRatio?: number;
  /** Cumulative-wait cap across all retries. Default `RETRY_CUMULATIVE_CAP_MS` (8 000). */
  cumulativeCapMs?: number;
  /** Caller abort signal; when aborted, the loop exits and re-throws. */
  signal?: AbortSignal;
  /** Classifier: returns `true` if `err` should trigger another attempt. */
  isRetryable?: (err: unknown) => boolean;
  /** Random number provider in `[0, 1)`. Injectable for property tests. */
  random?: () => number;
  /** Sleep impl. Default uses `setTimeout` and rejects early on abort. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Runs `fn` up to `attempts` times with exponential backoff and ±jitter
 * between attempts. Stops as soon as `fn` resolves, the caller signal aborts,
 * `isRetryable(err)` returns `false`, or the cumulative wait would exceed
 * `cumulativeCapMs`.
 *
 * The `attempt` argument passed to `fn` is zero-based: 0 for the initial
 * call, 1 for the first retry, and so on.
 */
export async function retryWithJitter<T>(
  fn: (attempt: number) => Promise<T>,
  opts?: RetryWithJitterOptions,
): Promise<T> {
  const attempts = opts?.attempts ?? RETRY_MAX_ATTEMPTS;
  const initialDelayMs = opts?.initialDelayMs ?? RETRY_INITIAL_DELAY_MS;
  const jitterRatio = opts?.jitterRatio ?? RETRY_JITTER_RATIO;
  const cumulativeCapMs = opts?.cumulativeCapMs ?? RETRY_CUMULATIVE_CAP_MS;
  const isRetryable = opts?.isRetryable ?? isRetryableError;
  const random = opts?.random ?? Math.random;
  const sleep = opts?.sleep ?? defaultSleep;
  const callerSignal = opts?.signal;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(
      `retryWithJitter: attempts must be a positive integer, received ${attempts}`,
    );
  }

  let cumulativeWaitMs = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (callerSignal?.aborted) {
      throw callerSignal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === attempts - 1;
      if (isLastAttempt || !isRetryable(err)) throw err;

      // Exponential backoff: 500, 1000, 2000, 4000, ...
      const baseDelay = initialDelayMs * Math.pow(2, attempt);
      // Symmetric jitter factor in [1 - r, 1 + r).
      const jitterFactor = 1 + (random() * 2 - 1) * jitterRatio;
      const delayMs = Math.max(0, Math.floor(baseDelay * jitterFactor));

      // Hard cap on cumulative wait — give up rather than sleep past the cap.
      if (cumulativeWaitMs + delayMs > cumulativeCapMs) throw err;

      cumulativeWaitMs += delayMs;
      await sleep(delayMs, callerSignal);
    }
  }
  // Unreachable: the final iteration always throws or returns above.
  throw lastError;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// --- Default retry classifier --------------------------------------------

/**
 * Default `isRetryable` used by `retryWithJitter`.
 *
 * Retries on:
 *   - `TypeError` — fetch's transport-level failure ("Failed to fetch", TLS,
 *     DNS, connection reset, etc.).
 *   - HTTP status in `{429, 500, 502, 503, 504}` (Requirement 4.5).
 *
 * Does NOT retry on:
 *   - `AbortError` — caller cancellation and per-request timeouts must be
 *     handled by the router's failover path (Requirement 4.3), not by
 *     re-issuing the same request to the same provider.
 *   - 4xx other than 429 — non-transient client errors.
 */
export function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  // Aborts are surfaced verbatim; the router treats them as failover signals.
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'AbortError') return false;

  // Network / transport-level failure from `fetch`.
  if (err instanceof TypeError) return true;

  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status === 500 || status === 502 || status === 503 || status === 504) {
      return true;
    }
  }

  return false;
}

// --- Retry-After parsing -------------------------------------------------

/**
 * Parses an HTTP `Retry-After` header value into a non-negative millisecond
 * delta. Supports both the seconds form (`"42"`) and the HTTP-date form
 * (`"Wed, 21 Oct 2015 07:28:00 GMT"`). Returns `null` for empty, malformed,
 * or missing values so the caller can fall back to its default backoff.
 */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Numeric "delay-seconds" form.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
  }

  // HTTP-date form.
  const ts = Date.parse(trimmed);
  if (!Number.isNaN(ts)) {
    const delta = ts - Date.now();
    return delta > 0 ? delta : 0;
  }

  return null;
}
