// ============================================
// Zule AI — Web Speech Transcription Provider
// ============================================
//
// Wraps the browser's Web Speech API into the Transcription_Engine interface.
// Uses `RestartSupervisor` from `src/brain/restartSupervisor.ts` for bounded
// restart with exponential backoff.
//
// Key behaviours implemented here:
// - Bounded restart on `onend` while `shouldRestart` (Requirement 1.2, 1.3)
// - Confidence filter: drop final results below threshold (Requirement 1.7)
// - Interim flush on stop: emit non-empty interim as final (Requirement 1.6)
// - Permission watcher via `navigator.permissions.query` (Requirement 1.8)
// - BCP-47 language at start time (Requirement 1.9)
// - Surface 'unsupported' when SpeechRecognition is undefined (Requirement 1.10)
// - Non-fatal error handling for no-speech and audio-capture (Requirement 1.4)
// - Permission-denied / service-not-allowed stops and clears restart (Requirement 1.5)

import { RestartSupervisor } from '../restartSupervisor';
import type { TranscriptionLine } from '../../types/transcription';
import type { ZuleError } from '../../types/errors';

// Web Speech API types — these may not be available in all TS lib configurations.
// We declare minimal interfaces here for type safety when the DOM lib doesn't
// expose them.

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEventLocal {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEventLocal {
  error: string;
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLocal) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLocal) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

// ---- Pure helper functions (extracted for property-testing) ----

/**
 * Flush interim text on stop. Returns the flushed line if interim is non-empty,
 * or null otherwise.
 *
 * Property 3: For any non-empty interim text present when stop() is called,
 * exactly one final line is emitted with that text. If interim is empty, no
 * extra line is emitted.
 */
export function flushOnStop(
  transcript: TranscriptionLine[],
  interim: string,
  opts: { speakerId: string; speakerRole: 'user' | 'other'; language: string },
): TranscriptionLine[] {
  const trimmed = interim.trim();
  if (trimmed === '') return transcript;

  const flushedLine: TranscriptionLine = {
    id: `t-flush-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text: trimmed,
    timestamp: Date.now(),
    isInterim: false,
    speakerId: opts.speakerId,
    speakerRole: opts.speakerRole,
    detection: 'manual',
    detectionConfidence: 1,
    asrConfidence: 0,
    language: opts.language,
    provider: 'web-speech',
  };

  return [...transcript, flushedLine];
}

/**
 * Apply confidence filter to a batch of final transcript lines.
 * Lines with asrConfidence >= threshold pass through; lines below are dropped.
 *
 * Property 4: For any sequence of final results, those with confidence < threshold
 * are dropped; those >= threshold pass through unchanged.
 *
 * Returns { kept, droppedCount }.
 */
export function applyConfidenceFilter(
  lines: TranscriptionLine[],
  threshold: number,
): { kept: TranscriptionLine[]; droppedCount: number } {
  const kept: TranscriptionLine[] = [];
  let droppedCount = 0;

  for (const line of lines) {
    if (line.asrConfidence >= threshold) {
      kept.push(line);
    } else {
      droppedCount++;
    }
  }

  return { kept, droppedCount };
}

// ---- Event types ----

export type TranscriptionEvent = 'line' | 'interim' | 'error' | 'permission';
export type Off = () => void;

export type TranscriptionEventCallback =
  | ((line: TranscriptionLine) => void)
  | ((interim: string) => void)
  | ((error: ZuleError) => void)
  | ((status: 'granted' | 'denied' | 'prompt') => void);

export interface WebSpeechProviderOptions {
  /** Confidence threshold for final results. Default 0.30. */
  confidenceThreshold?: number;
  /** BCP-47 language tag. Default 'en-US'. */
  language?: string;
  /** Current speaker id. */
  speakerId?: string;
  /** Current speaker role. */
  speakerRole?: 'user' | 'other';
}

// ---- Helpers for browser API detection ----

function getSpeechRecognitionConstructor(): (new () => SpeechRecognitionInstance) | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

// ---- WebSpeechProvider class ----

export class WebSpeechProvider {
  private recognition: SpeechRecognitionInstance | null = null;
  private supervisor: RestartSupervisor;
  private shouldRestart = false;
  private currentInterim = '';
  private _isListening = false;
  private _isSupported: boolean;
  private permissionStatus: PermissionStatus | null = null;

  private language: string;
  private confidenceThreshold: number;
  private speakerId: string;
  private speakerRole: 'user' | 'other';

  private listeners: Map<TranscriptionEvent, Set<TranscriptionEventCallback>> = new Map();

  constructor(opts: WebSpeechProviderOptions = {}) {
    this.language = opts.language ?? 'en-US';
    this.confidenceThreshold = opts.confidenceThreshold ?? 0.30;
    this.speakerId = opts.speakerId ?? 'speaker-1';
    this.speakerRole = opts.speakerRole ?? 'user';
    this._isSupported = getSpeechRecognitionConstructor() !== null;
    this.supervisor = new RestartSupervisor();
  }

  get isListening(): boolean {
    return this._isListening;
  }

  get isSupported(): boolean {
    return this._isSupported;
  }

  /**
   * Register an event listener. Returns an unsubscribe function.
   */
  on(event: TranscriptionEvent, cb: TranscriptionEventCallback): Off {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(cb);
    return () => {
      this.listeners.get(event)?.delete(cb);
    };
  }

  /**
   * Start the recognizer. Applies BCP-47 language.
   * Surfaces 'unsupported' error if SpeechRecognition is not available.
   */
  async start(opts?: { language?: string; speakerId?: string; speakerRole?: 'user' | 'other' }): Promise<void> {
    if (opts?.language) this.language = opts.language;
    if (opts?.speakerId) this.speakerId = opts.speakerId;
    if (opts?.speakerRole) this.speakerRole = opts.speakerRole;

    const SpeechRecognitionCtor = getSpeechRecognitionConstructor();
    if (!SpeechRecognitionCtor) {
      this._isSupported = false;
      this.emit('error', { kind: 'transcription.unsupported' } as ZuleError);
      return;
    }

    this.supervisor = new RestartSupervisor();
    this.shouldRestart = true;
    this.currentInterim = '';

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.language;
    recognition.maxAlternatives = 1;

    this.setupRecognitionHandlers(recognition);
    this.recognition = recognition;

    try {
      recognition.start();
      this._isListening = true;
    } catch {
      this._isListening = false;
      this.emit('error', { kind: 'transcription.audio-capture' } as ZuleError);
    }

    // Set up permission watcher
    this.watchPermission();
  }

  /**
   * Stop the recognizer. Flushes non-empty interim text as a final line.
   * Returns the flushed line if any, or null.
   */
  stop(): TranscriptionLine | null {
    this.shouldRestart = false;
    this._isListening = false;

    let flushedLine: TranscriptionLine | null = null;

    // Flush interim text if non-empty
    const trimmed = this.currentInterim.trim();
    if (trimmed !== '') {
      flushedLine = {
        id: `t-flush-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        text: trimmed,
        timestamp: Date.now(),
        isInterim: false,
        speakerId: this.speakerId,
        speakerRole: this.speakerRole,
        detection: 'manual',
        detectionConfidence: 1,
        asrConfidence: 0,
        language: this.language,
        provider: 'web-speech',
      };
      this.emit('line', flushedLine);
    }

    this.currentInterim = '';

    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // Ignore
      }
      this.recognition = null;
    }

    this.unwatchPermission();
    return flushedLine;
  }

  /**
   * Pause recognition. Does not flush interim.
   */
  pause(): void {
    this.shouldRestart = false;
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // Ignore
      }
    }
    this._isListening = false;
  }

  /**
   * Resume recognition after a pause.
   */
  resume(): void {
    if (this.recognition) {
      this.shouldRestart = true;
      this._isListening = true;
      try {
        this.recognition.start();
      } catch {
        // May already be started; attempt a fresh start
        this.start({ language: this.language, speakerId: this.speakerId, speakerRole: this.speakerRole });
      }
    } else {
      this.start({ language: this.language, speakerId: this.speakerId, speakerRole: this.speakerRole });
    }
  }

  /**
   * Update speaker info for subsequent lines.
   */
  setSpeaker(speakerId: string, speakerRole: 'user' | 'other'): void {
    this.speakerId = speakerId;
    this.speakerRole = speakerRole;
  }

  /**
   * Destroy the provider, cleaning up all resources.
   */
  destroy(): void {
    this.stop();
    this.listeners.clear();
  }

  // ---- Private methods ----

  private setupRecognitionHandlers(recognition: SpeechRecognitionInstance): void {
    recognition.onresult = (event: SpeechRecognitionEventLocal) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const alternative = result[0];
          const text = alternative.transcript.trim();
          if (!text) continue;

          const confidence = alternative.confidence;

          // Confidence filter: drop low-confidence finals
          if (confidence < this.confidenceThreshold) {
            // Counted as dropped in telemetry (caller's responsibility)
            continue;
          }

          // Record a successful final result (clears supervisor)
          this.supervisor.recordFinal();

          const line: TranscriptionLine = {
            id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            text,
            timestamp: Date.now(),
            isInterim: false,
            speakerId: this.speakerId,
            speakerRole: this.speakerRole,
            detection: 'manual',
            detectionConfidence: 1,
            asrConfidence: confidence,
            language: this.language,
            provider: 'web-speech',
          };
          this.emit('line', line);
          this.currentInterim = '';
        } else {
          this.currentInterim = result[0].transcript;
          this.emit('interim', this.currentInterim);
        }
      }
    };

    recognition.onend = () => {
      if (this.shouldRestart && this._isListening) {
        const decision = this.supervisor.recordRestart();
        if (decision.state === 'paused') {
          this._isListening = false;
          this.shouldRestart = false;
          this.emit('error', { kind: 'transcription.network', recoverable: true } as ZuleError);
          return;
        }
        // Delay and restart
        setTimeout(() => {
          if (this.shouldRestart && this.recognition) {
            try {
              this.recognition.start();
            } catch {
              // May fail; let next onend handle
            }
          }
        }, decision.delayMs);
      } else {
        this._isListening = false;
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEventLocal) => {
      const error = event.error;
      switch (error) {
        case 'not-allowed':
        case 'service-not-allowed':
          // Fatal: stop and clear restart
          this.shouldRestart = false;
          this._isListening = false;
          this.recognition = null;
          this.emit('error', { kind: 'transcription.permission-denied' } as ZuleError);
          break;
        case 'no-speech':
          // Non-fatal: log and continue
          this.emit('error', { kind: 'transcription.no-speech' } as ZuleError);
          break;
        case 'audio-capture':
          // Non-fatal: log and continue
          this.emit('error', { kind: 'transcription.audio-capture' } as ZuleError);
          break;
        default:
          // Treat as network/recoverable
          this.emit('error', { kind: 'transcription.network', recoverable: true } as ZuleError);
          break;
      }
    };
  }

  private async watchPermission(): Promise<void> {
    try {
      const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      this.permissionStatus = status;
      status.addEventListener('change', this.handlePermissionChange);
    } catch {
      // Permissions API not available in all browsers
    }
  }

  private unwatchPermission(): void {
    if (this.permissionStatus) {
      this.permissionStatus.removeEventListener('change', this.handlePermissionChange);
      this.permissionStatus = null;
    }
  }

  private handlePermissionChange = (): void => {
    if (this.permissionStatus) {
      const state = this.permissionStatus.state;
      this.emit('permission', state);

      if (state === 'denied') {
        // Permission revoked mid-session
        this.shouldRestart = false;
        this._isListening = false;
        if (this.recognition) {
          try {
            this.recognition.stop();
          } catch {
            // Ignore
          }
          this.recognition = null;
        }
        this.emit('error', { kind: 'transcription.permission-revoked' } as ZuleError);
      }
    }
  };

  private emit(event: TranscriptionEvent, ...args: unknown[]): void {
    const cbs = this.listeners.get(event);
    if (cbs) {
      for (const cb of cbs) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (cb as (...a: any[]) => void)(...args);
        } catch {
          // Don't let a listener error crash the provider
        }
      }
    }
  }
}
