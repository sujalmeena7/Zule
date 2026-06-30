// ============================================
// Zule AI — Local Whisper Transcription Provider
// ============================================
//
// Provides local, privacy-preserving speech-to-text using a Whisper-class
// model loaded via `@xenova/transformers` (the same runtime used by the
// Vector_Index for embeddings). Audio never leaves the device.
//
// Key behaviours:
// - (Requirement 2.1) Uses a WebGPU/WASM Whisper-class model in place of
//   the Web Speech API when `transcription.provider = local-whisper`.
// - (Requirement 2.2) Surfaces model download progress through the same
//   progress callback pattern used by `vectorStore.subscribeProgress`
//   (shared `ModelLoader` queue). Supports user-initiated cancel.
// - (Requirement 2.3) First final segment within 4 s on baseline machine
//   (8-core CPU, 16 GB RAM, no dedicated GPU).
// - (Requirement 2.4) Stamps every transcript line with
//   `provider: 'local-whisper'` and the detected language tag.

import { pipeline } from '@huggingface/transformers';
// Configures the shared Transformers.js `env` (vendor model + WASM paths,
// single-threaded backend). Importing here makes Whisper self-sufficient — it
// no longer depends on vectorStore being imported first.
import '../transformersEnv';
import type { TranscriptionLine } from '../../types/transcription';
import type { ZuleError } from '../../types/errors';
import { modelDownloadRegistry } from '../modelDownloadRegistry';
import type { Off, TranscriptionEvent, TranscriptionEventCallback } from './webSpeech';
// VAD gate (Requirements 6.1, 6.2, 6.3, 7.3, 7.4, 10.3) — energy-based
// renderer-side gate inserted between PCM capture and the
// `whisper:transcribe` IPC. The microphone path runs the gate
// per-chunk in `processAccumulatedAudio`. The persisted sensitivity
// setting is read on `start` and live updates are received via
// `vadSensitivityBus`.
import {
  scoreChunk,
  mapSensitivityToThreshold,
  VAD_DISABLE_FOR_TEST,
  type VADSensitivity,
} from './vad';
import { vadSensitivityBus } from './vadSensitivityBus';
import { telemetry } from '../telemetry';
import { database } from '../../data/database';

// ---- Configuration ----

/**
 * Default Whisper model id. Uses the tiny English model for fast cold
 * starts. Users can swap to larger variants (e.g. `Xenova/whisper-small`)
 * via Settings in a future task.
 */
export const DEFAULT_WHISPER_MODEL = 'Xenova/whisper-base.en' as const;

/**
 * Maximum buffer duration in milliseconds. The AudioWorklet accumulates
 * audio and flushes when speech ends (VAD-driven) or when this hard cap
 * is reached (sustained speech without pauses). Replaces the old fixed-
 * interval timer approach for much lower perceived latency.
 */
const DEFAULT_MAX_BUFFER_MS = 3000;

/**
 * URL of the AudioWorkletProcessor script. Served from public/ by Vite
 * in both dev and production (Vite copies public/ → dist/).
 */
const WORKLET_URL = '/pcm-capture-processor.js';

/**
 * Sample rate expected by Whisper models (16 kHz mono).
 */
const TARGET_SAMPLE_RATE = 16000;

/**
 * Robustly probe for a WORKING WebGPU adapter. `'gpu' in navigator` is not
 * enough — it can be true while `requestAdapter()` returns null (no compatible
 * GPU, blocklisted driver, headless/remote session). We must confirm an actual
 * adapter exists before asking Transformers.js to run on WebGPU, otherwise it
 * silently falls through to the WASM backend.
 *
 * Why this matters: the onnxruntime-web WASM backend has a history of *natively
 * crashing* the Electron renderer (the original reason the whole ML stack was
 * stubbed). A native crash cannot be caught by try/catch, so we must avoid
 * reaching the WASM path on machines where it is unstable — see `loadModel`.
 */
async function probeWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
    const adapter = await gpu.requestAdapter();
    return adapter != null;
  } catch {
    return false;
  }
}

// ---- Non-speech token filtering ----

/**
 * Whisper hallucinates bracketed/parenthesised annotation tokens when fed
 * silence or non-speech noise (e.g. `[BLANK_AUDIO]`, `[ Silence ]`, `(music)`,
 * `[Music]`, `[inaudible]`, `[ Pause ]`). These are not real speech and must
 * never reach the transcript or the dictation input field.
 *
 * Strategy: remove any fully-bracketed/parenthesised segment, then trim. If the
 * remaining text is empty (or just punctuation), the caller drops the segment.
 */
export function stripNonSpeechTokens(text: string): string {
  const cleaned = text
    // Remove [...] and (...) groups (the common annotation forms).
    .replace(/[\[(][^\])]*[\])]/g, ' ')
    // Collapse whitespace.
    .replace(/\s+/g, ' ')
    .trim();

  // If what's left is empty or only punctuation/symbols, treat as silence.
  if (!cleaned || !/[\p{L}\p{N}]/u.test(cleaned)) return '';
  return cleaned;
}

// ---- Progress callback type (same shape as vectorStore) ----

export type WhisperProgressCallback = (progress: {
  status: string;
  name: string;
  file: string;
  progress: number;
  loaded: number;
  total: number;
}) => void;

// ---- WhisperProvider options ----

export interface WhisperProviderOptions {
  /** Whisper model id. Default: `Xenova/whisper-tiny.en`. */
  modelId?: string;
  /** BCP-47 language tag for forced language. Omit for auto-detect. */
  language?: string;
  /** Initial speaker id. */
  speakerId?: string;
  /** Initial speaker role. */
  speakerRole?: 'user' | 'other';
  /**
   * Maximum buffer duration (ms) before the AudioWorklet forces a flush.
   * Default is 3000 ms. Lower values decrease max latency for sustained
   * speech at the cost of more, smaller chunks.
   */
  maxBufferMs?: number;
  /**
   * Try the WebGPU backend before WASM. Defaults to FALSE: the onnxruntime-web
   * WebGPU/JSEP backend natively crashes the Electron renderer on session
   * build (observed on Electron 42, uncatchable), so by default we use the WASM
   * backend only. Set true to force WebGPU first on machines where it's proven
   * stable.
   *
   * NOTE: only relevant when running inference in-renderer (no `transcribeFn`).
   * When a `transcribeFn` is supplied, inference happens out-of-process and
   * this option is ignored.
   */
  preferWebGPU?: boolean;
  /**
   * Inject an external inference function. When provided, the provider does
   * NOT load any in-renderer ML model — it only CAPTURES audio and delegates
   * transcription to this function (one chunk of 16 kHz mono Float32 PCM in,
   * recognised text out). This is how system-audio transcription runs Whisper
   * in the Electron main process (onnxruntime-node) instead of the renderer,
   * which crashes on the WASM/WebGPU engine (0xC0000005).
   */
  transcribeFn?: (pcm: Float32Array, opts: { language: string }) => Promise<string>;
}

// ---- Internal types ----

type WhisperPipeline = (
  audio: Float32Array,
  opts?: {
    language?: string;
    task?: string;
    return_timestamps?: boolean;
  },
) => Promise<{ text: string; chunks?: Array<{ text: string; timestamp: [number, number] }> }>;

// ---- WhisperProvider class ----

/**
 * Local Whisper transcription provider. Loads a Whisper-class model via
 * `@xenova/transformers` and processes audio chunks from a MediaStream.
 *
 * Implements the same event-based interface as `WebSpeechProvider` so that
 * `useTranscription` can dispatch to either without branching logic.
 */
export class WhisperProvider {
  private transcriber: WhisperPipeline | null = null;
  private _isListening = false;
  private _isModelLoaded = false;
  private _isCancelled = false;

  private modelId: string;
  private language: string;
  private speakerId: string;
  private speakerRole: 'user' | 'other';
  private maxBufferMs: number;
  private preferWebGPU: boolean;
  private transcribeFn?: (pcm: Float32Array, opts: { language: string }) => Promise<string>;

  // Audio pipeline
  private mediaStream: MediaStream | null = null;
  /**
   * Whether this provider acquired `mediaStream` itself (via getUserMedia).
   * When false, the stream was supplied externally (e.g. a system-audio
   * loopback stream) and its lifecycle is owned by the caller — teardown
   * must not stop its tracks.
   */
  private _ownsStream = false;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  /** Resolves when the worklet sends 'flush-done' during teardown. */
  private flushResolve: (() => void) | null = null;

  // Event system
  private listeners: Map<TranscriptionEvent, Set<TranscriptionEventCallback>> = new Map();
  private progressListeners: Set<WhisperProgressCallback> = new Set();

  // Line counter for unique ids
  private lineCounter = 0;

  // ---- VAD gate state (Requirements 6.1, 6.2, 6.3, 7.3, 7.4, 10.3) ----
  /**
   * Speech threshold in `[0, 1]` used by `scoreChunk`. Initialised from
   * the documented default (`medium`) and overwritten in `start()` from
   * the persisted `vadSensitivity` setting. Mutated synchronously by the
   * `vadSensitivityBus` subscriber so live changes apply to the next
   * chunk without restarting capture (Requirement 7.4).
   */
  private speechThreshold: number = mapSensitivityToThreshold('medium');
  /**
   * Unsubscribe callback for the active `vadSensitivityBus` subscription.
   * Set in `start()` and called from `stop()` so live sensitivity
   * listeners are released on teardown.
   */
  private vadUnsubscribe: (() => void) | null = null;

  constructor(opts: WhisperProviderOptions = {}) {
    this.modelId = opts.modelId ?? DEFAULT_WHISPER_MODEL;
    this.language = opts.language ?? 'en';
    this.speakerId = opts.speakerId ?? 'speaker-1';
    this.speakerRole = opts.speakerRole ?? 'user';
    this.maxBufferMs = opts.maxBufferMs ?? DEFAULT_MAX_BUFFER_MS;
    this.preferWebGPU = opts.preferWebGPU ?? false;
    this.transcribeFn = opts.transcribeFn;
  }

  // ---- Public getters ----

  get isListening(): boolean {
    return this._isListening;
  }

  get isModelLoaded(): boolean {
    return this._isModelLoaded;
  }

  /**
   * Whether the local Whisper provider is supported in this environment.
   * Requires WebAssembly support (for ONNX runtime). WebGPU is preferred
   * but not mandatory — WASM fallback is always available.
   */
  get isSupported(): boolean {
    return typeof WebAssembly !== 'undefined';
  }

  // ---- Progress subscription ----

  /**
   * Subscribe to model download/load progress. Returns an unsubscribe
   * function. Progress events use the same shape as the embedding model
   * loader so the `ModelLoader` component can display both.
   */
  subscribeProgress(cb: WhisperProgressCallback): () => void {
    this.progressListeners.add(cb);
    return () => {
      this.progressListeners.delete(cb);
    };
  }

  private dispatchProgress(data: {
    status: string;
    name: string;
    file: string;
    progress: number;
    loaded: number;
    total: number;
  }): void {
    for (const listener of this.progressListeners) {
      listener(data);
    }

    // Feed the unified ModelLoader queue (Requirement 20.4)
    if (data.status === 'downloading' || data.status === 'progress') {
      modelDownloadRegistry.upsert({
        id: 'whisper-model',
        label: 'Whisper Speech Model',
        status: 'downloading',
        progress: data.progress ?? 0,
        loaded: data.loaded ?? 0,
        total: data.total ?? 0,
        cancel: () => this.cancelDownload(),
      });
    } else if (data.status === 'ready') {
      modelDownloadRegistry.upsert({
        id: 'whisper-model',
        label: 'Whisper Speech Model',
        status: 'ready',
        progress: 100,
        loaded: data.total ?? 0,
        total: data.total ?? 0,
      });
    }
  }

  // ---- Event system ----

  on(event: TranscriptionEvent, cb: TranscriptionEventCallback): Off {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(cb);
    return () => {
      this.listeners.get(event)?.delete(cb);
    };
  }

  private emit(event: TranscriptionEvent, ...args: unknown[]): void {
    const cbs = this.listeners.get(event);
    if (!cbs) return;
    for (const cb of cbs) {
      (cb as (...a: unknown[]) => void)(...args);
    }
  }

  // ---- Model loading ----

  /**
   * Load the Whisper model. Surfaces download progress through the shared
   * progress callback pattern. Can be called ahead of `start()` to pre-warm
   * the model.
   *
   * @returns A promise that resolves once the model is loaded or rejects if
   *          loading fails or the user cancels.
   */
  async loadModel(): Promise<void> {
    // Capture-only mode: inference is delegated to an external function (the
    // main-process onnxruntime-node service), so there is no in-renderer model
    // to load. Mark ready and return.
    if (this.transcribeFn) {
      this._isModelLoaded = true;
      return;
    }
    if (this._isModelLoaded && this.transcriber) return;
    if (this._isCancelled) {
      throw new Error('Model download was cancelled');
    }

    this.dispatchProgress({
      status: 'downloading',
      name: this.modelId,
      file: '',
      progress: 0,
      loaded: 0,
      total: 0,
    });

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const progress_callback = (data: any) => {
        if (this._isCancelled) {
          // The library does not expose a direct abort mechanism, but we
          // stop processing once cancel is set.
          return;
        }
        this.dispatchProgress({
          status: data.status ?? 'progress',
          name: data.name ?? this.modelId,
          file: data.file ?? '',
          progress: data.progress ?? 0,
          loaded: data.loaded ?? 0,
          total: data.total ?? 0,
        });
      };

      // Backend selection. We learned the hard way (user testing on Electron
      // 42) that the onnxruntime-web **WebGPU/JSEP** backend NATIVELY CRASHES
      // the renderer the instant it builds a session — independent of model
      // size (both fp32 and q8 crashed). A native GPU crash is uncatchable, so
      // there is no "try WebGPU, catch, fall back" — by the time it throws, the
      // renderer is already dead. Therefore the only safe order is to NOT touch
      // WebGPU by default.
      //
      // Default order: WASM (single-threaded, q8) only. onnxruntime-web 1.22's
      // WASM build is a different binary from the 1.14 one that originally
      // segfaulted, so it is the candidate for a stable on-device backend.
      // WebGPU can be force-enabled via `preferWebGPU` once it's proven stable
      // on a given machine.
      //
      // q8 weights are used on every backend (decoder ~30 MB) and are vendored
      // offline (scripts/fetch-models.mjs).
      type Backend = 'webgpu' | 'wasm';
      const order: Backend[] = [];
      if (this.preferWebGPU) {
        // Opt-in: try WebGPU first (only if an adapter actually exists).
        if (await probeWebGPU()) order.push('webgpu');
      }
      order.push('wasm');

      // eslint-disable-next-line no-console
      console.info(
        `[whisper] backend order: [${order.join(', ')}] ` +
          `(preferWebGPU=${this.preferWebGPU})`,
      );

      let transcriber: WhisperPipeline | null = null;
      let lastErr: unknown = null;
      for (const device of order) {
        try {
          // eslint-disable-next-line no-console
          console.info(`[whisper] loading model on ${device} (q8)…`);
          transcriber = (await pipeline(
            'automatic-speech-recognition',
            this.modelId,
            { device, dtype: 'q8', progress_callback } as Parameters<typeof pipeline>[2],
          )) as unknown as WhisperPipeline;
          // eslint-disable-next-line no-console
          console.info(`[whisper] ${device} model ready.`);
          break;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[whisper] ${device} pipeline init failed:`, err);
          lastErr = err;
          transcriber = null;
        }
      }

      if (!transcriber) {
        throw lastErr instanceof Error
          ? lastErr
          : new Error('whisper:all-backends-failed');
      }

      this.transcriber = transcriber;

      this._isModelLoaded = true;

      this.dispatchProgress({
        status: 'ready',
        name: this.modelId,
        file: '',
        progress: 100,
        loaded: 1,
        total: 1,
      });
    } catch (error) {
      if (this._isCancelled) {
        modelDownloadRegistry.upsert({
          id: 'whisper-model',
          label: 'Whisper Speech Model',
          status: 'cancelled',
          progress: 0,
          loaded: 0,
          total: 0,
        });
        throw new Error('Model download was cancelled');
      }
      // eslint-disable-next-line no-console
      console.error('Failed to load Whisper model:', error);
      modelDownloadRegistry.upsert({
        id: 'whisper-model',
        label: 'Whisper Speech Model',
        status: 'error',
        progress: 0,
        loaded: 0,
        total: 0,
        errorMessage: error instanceof Error ? error.message : 'Failed to load model',
      });
      const zuleError: ZuleError = { kind: 'vector-index.init-failed', attempts: 1 };
      this.emit('error', zuleError);
      throw error;
    }
  }

  /**
   * Cancel an in-progress model download. If the model is already loaded
   * this is a no-op.
   */
  cancelDownload(): void {
    this._isCancelled = true;
    modelDownloadRegistry.upsert({
      id: 'whisper-model',
      label: 'Whisper Speech Model',
      status: 'cancelled',
      progress: 0,
      loaded: 0,
      total: 0,
    });
  }

  // ---- Start/Stop ----

  /**
   * Start transcription. Requests microphone access, loads the model if
   * not already loaded, and begins processing audio chunks.
   */
  async start(opts?: {
    language?: string;
    speakerId?: string;
    speakerRole?: 'user' | 'other';
    /**
     * Externally-supplied audio stream (e.g. a system-audio loopback stream).
     * When provided, the provider transcribes this stream instead of opening
     * the microphone, and does NOT own/stop the stream on teardown.
     */
    stream?: MediaStream;
  }): Promise<void> {
    if (opts?.language) this.language = opts.language;
    if (opts?.speakerId) this.speakerId = opts.speakerId;
    if (opts?.speakerRole) this.speakerRole = opts.speakerRole;

    this._isCancelled = false;

    // Load model if not ready
    if (!this._isModelLoaded || !this.transcriber) {
      await this.loadModel();
    }

    // VAD: read persisted sensitivity and configure the speech threshold
    // (Requirement 7.3). Falls back to `medium` if the setting is missing
    // or the read fails so dictation still works against a sane default.
    try {
      const sensitivity = await database.getSetting<VADSensitivity>(
        'vadSensitivity',
        'medium',
      );
      this.speechThreshold = mapSensitivityToThreshold(sensitivity);
    } catch {
      this.speechThreshold = mapSensitivityToThreshold('medium');
    }

    // VAD: subscribe to live sensitivity changes (Requirement 7.4). The
    // listener mutates `speechThreshold` synchronously so the next
    // captured chunk is judged against the new threshold without
    // restarting audio capture. The unsubscribe is released in `stop()`.
    if (this.vadUnsubscribe !== null) {
      // Defensive: a prior `start()` left a subscription dangling.
      this.vadUnsubscribe();
      this.vadUnsubscribe = null;
    }
    this.vadUnsubscribe = vadSensitivityBus.subscribe((event) => {
      this.speechThreshold = mapSensitivityToThreshold(event.value);
    });

    if (opts?.stream) {
      // Use the supplied stream (caller owns its lifecycle). It is fed into
      // the 16 kHz AudioContext below, which auto-resamples any source rate.
      this.mediaStream = opts.stream;
      this._ownsStream = false;
    } else {
      // Request microphone access — this provider owns the resulting stream.
      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: TARGET_SAMPLE_RATE,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        this._ownsStream = true;
      } catch {
        const error: ZuleError = { kind: 'transcription.permission-denied' };
        this.emit('error', error);
        return;
      }
    }

    // Set up audio processing pipeline with AudioWorklet (off-main-thread).
    // AudioWorklet is supported in Electron 14+ (Chromium 91). Electron 42
    // is our minimum — assert it exists and throw early.
    this.audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });

    if (!this.audioContext.audioWorklet) {
      throw new Error(
        'AudioWorklet is not supported in this environment. ' +
        'Zule requires Electron 14+ (Chromium 91+).',
      );
    }

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

    // Load the PCM capture worklet processor.
    await this.audioContext.audioWorklet.addModule(WORKLET_URL);
    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-capture-processor');

    // Configure the worklet with current settings.
    this.workletNode.port.postMessage({
      type: 'config',
      maxBufferMs: this.maxBufferMs,
    });

    // Handle messages from the worklet (chunks, VAD state, flush-done).
    this.workletNode.port.onmessage = (e: MessageEvent) => {
      this.handleWorkletMessage(e.data);
    };

    // Connect: source → worklet. No destination connection needed —
    // the worklet outputs silence (process() returns true but writes
    // no output).
    this.sourceNode.connect(this.workletNode);

    this._isListening = true;
  }

  /**
   * Stop transcription. Tears down audio pipeline, processes any remaining
   * buffered audio, and emits a final line if text was produced.
   *
   * @returns The final flushed line, or null if no remaining audio.
   */
  stop(): TranscriptionLine | null {
    this._isListening = false;

    // VAD: release the live-sensitivity subscription on teardown
    // (Requirements 7.4 partner — symmetric to the `start()` subscribe).
    if (this.vadUnsubscribe !== null) {
      this.vadUnsubscribe();
      this.vadUnsubscribe = null;
    }

    // Ask the worklet to flush its remaining buffer. The worklet will
    // post { type: 'flush-done' } when finished, which resolves the
    // promise. Guard with a 500ms timeout in case the worklet's
    // process() has stopped being called (stream ended, tab
    // backgrounded, or port already closed).
    if (this.workletNode) {
      const flushPromise = new Promise<void>((resolve) => {
        this.flushResolve = resolve;
        // Safety net: always resolve after 500ms.
        setTimeout(resolve, 500);
      });
      try {
        this.workletNode.port.postMessage({ type: 'flush' });
      } catch {
        // Port may be closed — resolve immediately.
        this.flushResolve?.();
        this.flushResolve = null;
      }
      // Fire-and-forget the teardown after flush completes.
      void flushPromise.then(() => {
        this.flushResolve = null;
        this.teardownAudio();
      });
    } else {
      this.teardownAudio();
    }

    return null;
  }

  /**
   * Pause transcription (stop collecting audio without tearing down).
   * Tells the worklet to stop accumulating samples.
   */
  pause(): void {
    this._isListening = false;
    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ type: 'pause' });
      } catch {
        // Port may be closed — ignore.
      }
    }
  }

  /**
   * Resume transcription after pause.
   * Tells the worklet to start accumulating samples again.
   */
  resume(): void {
    if (!this.audioContext) return;
    // transcribeFn mode doesn't need `this.transcriber`.
    if (!this.transcribeFn && !this.transcriber) return;
    this._isListening = true;
    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ type: 'resume' });
      } catch {
        // Port may be closed — ignore.
      }
    }
  }

  /**
   * Update the current speaker assignment for subsequent lines.
   */
  setSpeaker(speakerId: string, speakerRole: 'user' | 'other'): void {
    this.speakerId = speakerId;
    this.speakerRole = speakerRole;
  }

  /**
   * Full teardown — releases all resources.
   */
  destroy(): void {
    this.stop();
    this.transcriber = null;
    this._isModelLoaded = false;
    this.listeners.clear();
    this.progressListeners.clear();
  }

  // ---- Private audio processing ----

  /**
   * VAD gate (Requirements 6.1, 6.2, 10.3): score `audio` and decide
   * whether to forward it to the `whisper:transcribe` IPC. Returns
   * `true` if the chunk should be transcribed, `false` if it should be
   * silently dropped.
   *
   * Behaviour:
   *   - Honours `VAD_DISABLE_FOR_TEST.enabled` — when true, every chunk
   *     forwards (returns `true`) so the loopback integration tests
   *     keep their assertions (Requirement 9.3 partner).
   *   - Skips the IPC and emits exactly one `vad.skipped` telemetry
   *     event with `pipeline: 'microphone'` per gated chunk
   *     (Requirement 10.3, Property 21).
   *   - On a thrown VAD or an out-of-range score the chunk is forwarded
   *     anyway and a typed `transcription.vad-failed` error event is
   *     emitted. Forwarding-on-failure preserves transcription
   *     correctness if the VAD itself goes wrong (Property 15).
   */
  private vadGate(audio: Float32Array): boolean {
    if (VAD_DISABLE_FOR_TEST.enabled) return true;

    let result: ReturnType<typeof scoreChunk> | null = null;
    try {
      result = scoreChunk(audio, { speechThreshold: this.speechThreshold });
    } catch (err) {
      telemetry.emit({
        kind: 'error',
        name: 'transcription.vad-failed',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error && err.stack ? err.stack : '',
        breadcrumb: ['vad:scoreChunk:threw', 'pipeline:microphone'],
      });
      return true;
    }

    const score = result.score;
    if (
      typeof score !== 'number' ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1
    ) {
      telemetry.emit({
        kind: 'error',
        name: 'transcription.vad-failed',
        message: `invalid VAD score ${String(score)}`,
        stack: '',
        breadcrumb: ['vad:scoreChunk:invalid-score', 'pipeline:microphone'],
      });
      return true;
    }

    if (!result.isSpeech) {
      // Sub-threshold: skip the IPC. Do NOT emit any line/interim event,
      // and crucially do NOT touch `audioContext`, `processorNode`,
      // `mediaStream`, or `_isListening` — Property 16 requires those to
      // remain `===` across consecutive silent chunks (Requirement 6.3).
      telemetry.emit({ kind: 'vad.skipped', pipeline: 'microphone' });
      return false;
    }

    return true;
  }

  /**
   * Handle messages from the AudioWorklet processor. Dispatches chunk
   * processing, VAD state transitions, and flush completion.
   */
  private handleWorkletMessage(data: {
    type: string;
    pcm?: Float32Array;
    isSpeech?: boolean;
    energy?: number;
  }): void {
    switch (data.type) {
      case 'chunk': {
        if (!this._isListening || !data.pcm) return;
        const audio = data.pcm;

        // Secondary VAD gate (Requirement 6.1): the worklet already ran
        // a per-frame energy check, but we run the full median-of-frames
        // gate here too for consistency with the documented VAD contract.
        // Sub-threshold chunks are dropped silently.
        if (!this.vadGate(audio)) return;

        // Emit interim indicator while processing.
        this.emit('interim', '...');

        void this.processAudioSegment(audio).then((line) => {
          if (line) {
            this.emit('line', line);
          }
        });
        break;
      }

      case 'vad': {
        // Surface VAD state transitions to the component tree so
        // FloatingCopilot can show a real-time "speaking" pulse.
        this.emit('vad-state' as TranscriptionEvent, {
          isSpeech: data.isSpeech ?? false,
          energy: data.energy ?? 0,
        });
        break;
      }

      case 'flush-done': {
        // Resolve the teardown promise (see stop()).
        if (this.flushResolve) {
          this.flushResolve();
          this.flushResolve = null;
        }
        break;
      }
    }
  }

  /**
   * Run inference on a single audio segment. Returns a TranscriptionLine
   * if text was produced, or null if the segment was silence/empty.
   */
  private async processAudioSegment(audio: Float32Array): Promise<TranscriptionLine | null> {
    try {
      let text: string | undefined;

      if (this.transcribeFn) {
        // Capture-only mode: delegate inference out-of-process (main-process
        // onnxruntime-node). Returns recognised text directly.
        text = (await this.transcribeFn(audio, { language: this.language }))?.trim();
      } else {
        // In-renderer inference (legacy path).
        if (!this.transcriber) return null;
        const result = await this.transcriber(audio, {
          language: this.language,
          task: 'transcribe',
          return_timestamps: true,
        });
        text = result.text?.trim();
      }

      if (!text) return null;

      // Whisper emits non-speech annotation tokens during silence/noise, e.g.
      // `[BLANK_AUDIO]`, `[ Silence ]`, `(music)`, `[Music]`, `[inaudible]`.
      // Strip them; if nothing meaningful remains, drop the segment so the
      // input field isn't spammed during silence.
      text = stripNonSpeechTokens(text);
      if (!text) return null;

      this.lineCounter++;

      // Detect language from the model output. The tiny.en model always
      // reports English; multilingual models return the detected language.
      // For the .en model variant we hardcode 'en'.
      const detectedLanguage = this.detectLanguage();

      const line: TranscriptionLine = {
        id: `whisper-${Date.now()}-${this.lineCounter}`,
        text,
        timestamp: Date.now(),
        isInterim: false,
        speakerId: this.speakerId,
        speakerRole: this.speakerRole,
        detection: 'manual',
        detectionConfidence: 1,
        asrConfidence: 0.85, // Whisper doesn't expose per-segment confidence easily; use a reasonable default
        language: detectedLanguage,
        provider: 'local-whisper',
      };

      return line;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Whisper inference error:', error);
      return null;
    }
  }

  /**
   * Determine the language tag for emitted lines. For English-only models
   * (ending in `.en`) this always returns `'en'`. For multilingual models
   * it returns the configured language.
   */
  private detectLanguage(): string {
    if (this.modelId.endsWith('.en')) {
      return 'en';
    }
    return this.language;
  }

  /**
   * Tear down audio context, source node, processor node, and media stream.
   */
  private teardownAudio(): void {
    if (this.workletNode) {
      try {
        this.workletNode.port.close();
      } catch {
        // Port may already be closed.
      }
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
    if (this.mediaStream) {
      // Only stop tracks for streams we own. Externally-supplied streams
      // (e.g. system-audio loopback) are torn down by their owner.
      if (this._ownsStream) {
        for (const track of this.mediaStream.getTracks()) {
          track.stop();
        }
      }
      this.mediaStream = null;
      this._ownsStream = false;
    }
  }
}
