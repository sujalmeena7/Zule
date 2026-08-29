// ============================================
// Zule AI — OCR Worker (refactored, task 15.2)
// ============================================
//
// Responsibilities:
//   - Lazy-create a Tesseract.js worker on demand (Req 13.3)
//   - Expose `terminate()` for explicit cleanup when capture stops
//   - Accept a `language` parameter for lazy language-pack loading (Req 13.4)
//   - OcrWatchdog supervises errors: 3 errors in 30s → recreate;
//     subsequent error → disable OCR for the session (Req 20.3)
//   - Warm-start the worker without blocking the critical path (Req 3.1)
//   - Retain worker across stop/start cycles with idle grace period (Req 3.3, 3.4)
//   - Immediate termination on renderer teardown (Req 3.5)
//
// Tesseract workers and core assets are self-hosted (Req 15.7).

import { modelDownloadRegistry } from '../brain/modelDownloadRegistry';
import { telemetry } from '../brain/telemetry';

// Tesseract.js worker + core are served from the application origin
// rather than a third-party CDN (Requirement 15.7). The files are
// mirrored from `node_modules/tesseract.js/dist/worker.min.js` and
// `node_modules/tesseract.js-core/*` into `public/vendor/` by
// `scripts/copy-vendor.mjs`.
const TESSERACT_WORKER_PATH = '/vendor/tesseract/worker.min.js';
const TESSERACT_CORE_PATH = '/vendor/tesseract-core';

// The Worker type from tesseract.js, extracted without a static import
// so the heavy library stays in its own chunk (Requirement 21.1).
type TesseractWorker = {
  recognize(image: unknown): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
};

// ---- Configuration ----

export interface OcrServiceConfig {
  /** Idle grace period in ms before terminating the worker. Default 30_000. */
  idleGracePeriodMs?: number;
}

/** Default idle grace period: 30 seconds. */
const DEFAULT_IDLE_GRACE_PERIOD_MS = 30_000;

/** Module-level config. Updated via `configureOcrService`. */
let serviceConfig: Required<OcrServiceConfig> = {
  idleGracePeriodMs: DEFAULT_IDLE_GRACE_PERIOD_MS,
};

/**
 * Configure the OCR service. Call before using warm-start or grace period.
 */
export function configureOcrService(config: OcrServiceConfig): void {
  serviceConfig = {
    idleGracePeriodMs: config.idleGracePeriodMs ?? DEFAULT_IDLE_GRACE_PERIOD_MS,
  };
}

// ---- Worker lifecycle ----

let workerPromise: Promise<TesseractWorker> | null = null;
let currentLanguage: string = 'eng';

// ---- Idle grace period state ----

let idleTerminationTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Create (or return cached) the OCR worker for the given language.
 * Language packs are loaded lazily on demand (Req 13.4).
 * If the requested language differs from the current one, the worker
 * is terminated and recreated with the new language.
 */
export async function getOcrWorker(language: string = 'eng'): Promise<TesseractWorker> {
  if (workerPromise && language !== currentLanguage) {
    // Language changed — tear down and recreate
    await terminateOcrWorker();
  }

  if (!workerPromise) {
    currentLanguage = language;
    const taskId = `tesseract-${language}`;
    const taskLabel = `OCR Language Pack (${language})`;

    modelDownloadRegistry.upsert({
      id: taskId,
      label: taskLabel,
      status: 'downloading',
      progress: 0,
      loaded: 0,
      total: 0,
    });

    workerPromise = (async () => {
      try {
        // Dynamic import keeps tesseract.js in a separate chunk (Requirement 21.1)
        const { createWorker } = await import('tesseract.js');
        const worker = await createWorker(language, 1, {
          workerPath: TESSERACT_WORKER_PATH,
          corePath: TESSERACT_CORE_PATH,
          logger: (m) => {
            // Tesseract logger emits progress events with shape
            // { status: string; progress: number }
            if (m && typeof m === 'object' && 'progress' in m) {
              const progress = (m as { progress: number }).progress * 100;
              modelDownloadRegistry.upsert({
                id: taskId,
                label: taskLabel,
                status: 'downloading',
                progress,
                loaded: 0,
                total: 0,
              });
            }
          },
        });
        modelDownloadRegistry.upsert({
          id: taskId,
          label: taskLabel,
          status: 'ready',
          progress: 100,
          loaded: 0,
          total: 0,
        });
        return worker as unknown as TesseractWorker;
      } catch (error) {
        modelDownloadRegistry.upsert({
          id: taskId,
          label: taskLabel,
          status: 'error',
          progress: 0,
          loaded: 0,
          total: 0,
          errorMessage: error instanceof Error ? error.message : 'Failed to load OCR',
        });
        throw error;
      }
    })();
  }
  return workerPromise;
}

/**
 * Perform OCR on the given image element using the specified language.
 * Language packs are loaded on demand when the worker is created.
 */
export async function recognizeText(
  image: HTMLCanvasElement | HTMLVideoElement,
  language: string = 'eng',
): Promise<string> {
  const worker = await getOcrWorker(language);
  const { data: { text } } = await worker.recognize(image);
  return text;
}

/**
 * Terminate the current OCR worker, freeing resources.
 * The worker will be recreated lazily on the next `getOcrWorker()` call.
 */
export async function terminateOcrWorker(): Promise<void> {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}

// ---- Warm-start and idle grace period (Req 3.1, 3.3, 3.4, 3.5) ----

/**
 * Warm-start the OCR worker without blocking. Returns immediately.
 * The returned promise resolves when the worker is ready (callers may
 * ignore it on the critical path).
 *
 * If a worker is already initialized or initializing, this is a no-op
 * that returns the existing initialization promise.
 *
 * Cancels any pending idle termination since a new session is starting.
 */
export function warmOcrWorker(language?: string): Promise<void> {
  // Cancel any pending idle termination — a session is restarting
  cancelIdleTermination();

  // If we already have a worker (or one is being created) for the same language,
  // just return the existing promise mapped to void.
  const lang = language ?? 'eng';
  if (workerPromise && lang === currentLanguage) {
    return workerPromise.then(() => undefined);
  }

  // Kick off worker creation without blocking the caller
  return getOcrWorker(lang).then(() => undefined);
}

/**
 * Schedule worker termination after the idle grace period.
 * Cancels any previously scheduled termination (restarts the timer).
 * Called when a capture session stops.
 */
export function scheduleIdleTermination(): void {
  // Cancel any existing timer to avoid double-termination
  cancelIdleTermination();

  idleTerminationTimer = setTimeout(() => {
    idleTerminationTimer = null;
    void terminateOcrWorker();
  }, serviceConfig.idleGracePeriodMs);
}

/**
 * Cancel any pending idle termination (called on session restart).
 * If the worker is still alive, it will be reused.
 */
export function cancelIdleTermination(): void {
  if (idleTerminationTimer !== null) {
    clearTimeout(idleTerminationTimer);
    idleTerminationTimer = null;
  }
}

/**
 * Terminate immediately, ignoring grace period. Called on renderer teardown.
 * Cancels any pending idle termination and terminates the worker right away.
 */
export async function terminateOcrWorkerImmediate(): Promise<void> {
  cancelIdleTermination();
  await terminateOcrWorker();
}

/**
 * Returns whether an idle termination is currently scheduled.
 * Exposed for testing purposes.
 */
export function isIdleTerminationScheduled(): boolean {
  return idleTerminationTimer !== null;
}

/**
 * Returns whether a worker is currently initialized or initializing.
 * Exposed for testing purposes.
 */
export function hasActiveWorker(): boolean {
  return workerPromise !== null;
}

// ---- In-flight OCR deduplication (Req 1.5, 3.2) ----

/** Hash of the frame currently being OCR'd. */
let inFlightHash: Uint8Array | null = null;

/** Shared promise for the in-flight OCR pass. */
let inFlightPromise: Promise<string> | null = null;

/**
 * Compare two Uint8Array byte sequences for equality.
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Recognize text with in-flight deduplication. If a recognize call for the
 * same frame hash is already in progress, the returned promise resolves
 * with the same result (no duplicate Tesseract invocation).
 *
 * This satisfies Req 1.5: reuse in-flight OCR pass rather than starting a
 * second pass over the same frame.
 *
 * Req 3.2 is already satisfied by `getOcrWorker` which stores and reuses
 * `workerPromise` — concurrent callers await the same initialization promise.
 */
export function recognizeTextDeduped(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  frameHash: Uint8Array,
  language?: string,
): Promise<string> {
  // If there's an in-flight OCR pass for the same frame, reuse it
  if (inFlightHash && inFlightPromise && bytesEqual(frameHash, inFlightHash)) {
    // Emit telemetry for the deduped case — duration is 0 since we're
    // reusing an in-flight pass rather than starting a new one (Req 9.2).
    const dedupedStart = performance.now();
    return inFlightPromise.then((text) => {
      telemetry.emit({
        kind: 'screen.ocrComplete',
        durationMs: Math.round(performance.now() - dedupedStart),
        deduped: true,
      });
      return text;
    });
  }

  // Start a new OCR pass
  inFlightHash = frameHash;
  const ocrStart = performance.now();
  const promise = (async () => {
    const worker = await getOcrWorker(language);
    const { data: { text } } = await worker.recognize(canvas);
    return text;
  })();

  // Wrap the promise so we clear dedup state on completion (success or failure)
  inFlightPromise = promise.finally(() => {
    // Only clear if this is still the active in-flight pass
    // (a newer call may have already replaced it)
    if (inFlightHash && bytesEqual(inFlightHash, frameHash)) {
      inFlightHash = null;
      inFlightPromise = null;
    }
  }).then((text) => {
    // Emit telemetry for completed OCR pass (Req 9.2)
    telemetry.emit({
      kind: 'screen.ocrComplete',
      durationMs: Math.round(performance.now() - ocrStart),
      deduped: false,
    });
    return text;
  });

  return inFlightPromise;
}

/**
 * Reset the in-flight deduplication state. Exposed for testing purposes only.
 * @internal
 */
export function _resetDedupState(): void {
  inFlightHash = null;
  inFlightPromise = null;
}

/**
 * Forcibly reset all worker state. Exposed for testing purposes only.
 * Use when workerPromise may be in a rejected state that terminateOcrWorker
 * cannot clean up.
 * @internal
 */
export function _resetWorkerState(): void {
  workerPromise = null;
  currentLanguage = 'eng';
  cancelIdleTermination();
  inFlightHash = null;
  inFlightPromise = null;
}

// ---- OCR Watchdog ----

export type OcrWatchdogState = 'active' | 'recreated' | 'disabled';

export interface OcrWatchdogOptions {
  /** Maximum consecutive errors before recreation. Default 3. */
  maxErrors?: number;
  /** Time window in ms for consecutive errors. Default 30_000. */
  windowMs?: number;
  /** Returns the current time in ms. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Supervises the OCR worker lifecycle (Requirement 20.3).
 *
 * Behaviour:
 * - Tracks consecutive errors within a sliding window of `windowMs` (default 30s).
 * - After `maxErrors` (default 3) consecutive errors within the window:
 *   terminates and recreates the worker once.
 * - On the *next* error after a recreate: disables OCR for the session.
 * - `reset()` returns the watchdog to `active` state (for new sessions).
 * - `recordSuccess()` clears the error window.
 */
export class OcrWatchdog {
  private _state: OcrWatchdogState = 'active';
  private errorTimestamps: number[] = [];
  private readonly maxErrors: number;
  private readonly windowMs: number;
  private readonly nowFn: () => number;

  constructor(opts: OcrWatchdogOptions = {}) {
    this.maxErrors = opts.maxErrors ?? 3;
    this.windowMs = opts.windowMs ?? 30_000;
    this.nowFn = opts.now ?? Date.now;
  }

  /** Current watchdog state. */
  get state(): OcrWatchdogState {
    return this._state;
  }

  /** Number of errors tracked in the current window. */
  get consecutiveFailures(): number {
    return this.errorTimestamps.length;
  }

  /**
   * Record a successful OCR operation. Clears the error window.
   */
  recordSuccess(): void {
    this.errorTimestamps = [];
  }

  /**
   * Record an OCR error. Returns the new state and whether the caller
   * should recreate the worker or disable OCR.
   */
  recordError(t?: number): {
    state: OcrWatchdogState;
    action: 'continue' | 'recreate' | 'disable';
  } {
    if (this._state === 'disabled') {
      return { state: 'disabled', action: 'disable' };
    }

    const time = t ?? this.nowFn();

    if (this._state === 'recreated') {
      // Already recreated once — any subsequent error disables OCR
      this._state = 'disabled';
      return { state: 'disabled', action: 'disable' };
    }

    // State is 'active' — track errors within the window
    this.errorTimestamps.push(time);

    // Prune errors outside the window
    const windowStart = time - this.windowMs;
    this.errorTimestamps = this.errorTimestamps.filter((ts) => ts >= windowStart);

    if (this.errorTimestamps.length >= this.maxErrors) {
      // Threshold reached — terminate and recreate once
      this._state = 'recreated';
      this.errorTimestamps = [];
      return { state: 'recreated', action: 'recreate' };
    }

    return { state: 'active', action: 'continue' };
  }

  /**
   * Reset the watchdog for a new session.
   */
  reset(): void {
    this._state = 'active';
    this.errorTimestamps = [];
  }
}
