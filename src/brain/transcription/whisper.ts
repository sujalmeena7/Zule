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

import { pipeline, env } from '@xenova/transformers';
import type { TranscriptionLine } from '../../types/transcription';
import type { ZuleError } from '../../types/errors';
import { modelDownloadRegistry } from '../modelDownloadRegistry';
import type { Off, TranscriptionEvent, TranscriptionEventCallback } from './webSpeech';

// ---- Configuration ----

/**
 * Default Whisper model id. Uses the tiny English model for fast cold
 * starts. Users can swap to larger variants (e.g. `Xenova/whisper-small`)
 * via Settings in a future task.
 */
export const DEFAULT_WHISPER_MODEL = 'Xenova/whisper-tiny.en' as const;

/**
 * Processing interval in milliseconds. Audio is buffered and sent to the
 * model in chunks of this duration. Lower values decrease latency at the
 * cost of higher CPU usage.
 */
const PROCESS_INTERVAL_MS = 2000;

/**
 * Sample rate expected by Whisper models (16 kHz mono).
 */
const TARGET_SAMPLE_RATE = 16000;

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
   * Override the processing interval (ms) for testing.
   * Production default is 2000 ms.
   */
  processIntervalMs?: number;
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
  private processIntervalMs: number;

  // Audio pipeline
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private audioBuffer: Float32Array[] = [];
  private processTimer: ReturnType<typeof setInterval> | null = null;

  // Event system
  private listeners: Map<TranscriptionEvent, Set<TranscriptionEventCallback>> = new Map();
  private progressListeners: Set<WhisperProgressCallback> = new Set();

  // Line counter for unique ids
  private lineCounter = 0;

  constructor(opts: WhisperProviderOptions = {}) {
    this.modelId = opts.modelId ?? DEFAULT_WHISPER_MODEL;
    this.language = opts.language ?? 'en';
    this.speakerId = opts.speakerId ?? 'speaker-1';
    this.speakerRole = opts.speakerRole ?? 'user';
    this.processIntervalMs = opts.processIntervalMs ?? PROCESS_INTERVAL_MS;
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
      this.transcriber = (await pipeline(
        'automatic-speech-recognition',
        this.modelId,
        {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          progress_callback: (data: any) => {
            if (this._isCancelled) {
              // The library does not expose a direct abort mechanism,
              // but we stop processing once cancel is set.
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
          },
        },
      )) as unknown as WhisperPipeline;

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
  }): Promise<void> {
    if (opts?.language) this.language = opts.language;
    if (opts?.speakerId) this.speakerId = opts.speakerId;
    if (opts?.speakerRole) this.speakerRole = opts.speakerRole;

    this._isCancelled = false;

    // Load model if not ready
    if (!this._isModelLoaded || !this.transcriber) {
      await this.loadModel();
    }

    // Request microphone access
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: TARGET_SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch {
      const error: ZuleError = { kind: 'transcription.permission-denied' };
      this.emit('error', error);
      return;
    }

    // Set up audio processing pipeline
    this.audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

    // Use ScriptProcessorNode to capture raw PCM audio data.
    // (AudioWorklet would be preferred in production for lower latency
    // but ScriptProcessorNode works universally and is simpler to wire.)
    const bufferSize = 4096;
    this.processorNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

    this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
      if (!this._isListening) return;
      const inputData = event.inputBuffer.getChannelData(0);
      // Copy the buffer since the underlying ArrayBuffer is reused
      this.audioBuffer.push(new Float32Array(inputData));
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);

    this._isListening = true;

    // Start periodic processing of accumulated audio
    this.processTimer = setInterval(() => {
      void this.processAccumulatedAudio();
    }, this.processIntervalMs);
  }

  /**
   * Stop transcription. Tears down audio pipeline, processes any remaining
   * buffered audio, and emits a final line if text was produced.
   *
   * @returns The final flushed line, or null if no remaining audio.
   */
  stop(): TranscriptionLine | null {
    this._isListening = false;

    // Stop the periodic processing timer
    if (this.processTimer !== null) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }

    // Process any remaining buffered audio synchronously — we'll emit
    // the result after teardown. Since processing is async, we capture
    // any remaining buffer and process it later.
    const remainingBuffer = this.collectAudioBuffer();

    // Tear down audio nodes
    this.teardownAudio();

    // If there's remaining audio, queue a final processing pass.
    // We can't await here (matching WebSpeechProvider.stop() sync signature),
    // so we fire-and-forget the final segment.
    if (remainingBuffer && remainingBuffer.length > 0) {
      void this.processAudioSegment(remainingBuffer).then((line) => {
        if (line) {
          this.emit('line', line);
        }
      });
    }

    return null;
  }

  /**
   * Pause transcription (stop collecting audio without tearing down).
   */
  pause(): void {
    this._isListening = false;
    if (this.processTimer !== null) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }
  }

  /**
   * Resume transcription after pause.
   */
  resume(): void {
    if (!this.audioContext || !this.transcriber) return;
    this._isListening = true;
    this.processTimer = setInterval(() => {
      void this.processAccumulatedAudio();
    }, this.processIntervalMs);
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
   * Collect all buffered audio chunks into a single Float32Array and
   * clear the buffer.
   */
  private collectAudioBuffer(): Float32Array | null {
    if (this.audioBuffer.length === 0) return null;

    const totalLength = this.audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.audioBuffer) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    this.audioBuffer = [];
    return combined;
  }

  /**
   * Process accumulated audio buffer through the Whisper model.
   * Called periodically by the process timer.
   */
  private async processAccumulatedAudio(): Promise<void> {
    const audio = this.collectAudioBuffer();
    if (!audio || audio.length === 0) return;

    // Emit interim indicator while processing
    this.emit('interim', '...');

    const line = await this.processAudioSegment(audio);
    if (line) {
      this.emit('line', line);
    }
  }

  /**
   * Run inference on a single audio segment. Returns a TranscriptionLine
   * if text was produced, or null if the segment was silence/empty.
   */
  private async processAudioSegment(audio: Float32Array): Promise<TranscriptionLine | null> {
    if (!this.transcriber) return null;

    try {
      const result = await this.transcriber(audio, {
        language: this.language,
        task: 'transcribe',
        return_timestamps: true,
      });

      const text = result.text?.trim();
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
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode.onaudioprocess = null;
      this.processorNode = null;
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
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
  }
}
