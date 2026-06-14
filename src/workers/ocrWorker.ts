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
//
// Tesseract workers and core assets are self-hosted (Req 15.7).

import { modelDownloadRegistry } from '../brain/modelDownloadRegistry';

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

// ---- Worker lifecycle ----

let workerPromise: Promise<TesseractWorker> | null = null;
let currentLanguage: string = 'eng';

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
