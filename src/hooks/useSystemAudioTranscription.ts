// ============================================
// Zule AI — useSystemAudioTranscription Hook
// ============================================
//
// Second transcription pipeline that captures *system audio* (loopback) and
// runs it through the local WhisperProvider. This lets Zule hear the remote
// party in a call — the voice coming out of the speakers/headphones — which
// the microphone never carries.
//
// Kept deliberately separate from `useTranscription` (the microphone /
// WebSpeech pipeline) so that:
//   - the load-bearing mic path is never destabilised by this opt-in feature,
//   - Whisper's large-model download + failure semantics stay isolated, and
//   - any failure here degrades gracefully to mic-only (never throws out).
//
// Lines produced here are tagged `speakerRole: 'other'` / `speaker-2` so the
// Question_Detector treats them as the remote party (it short-circuits on the
// user's own speech). The consumer merges these lines with the mic transcript.

import { useState, useRef, useCallback, useEffect } from 'react';
import type { TranscriptionLine } from '../types/transcription';
import type { ZuleError } from '../types/errors';
import { WhisperProvider } from '../brain/transcription/whisper';
import type { Off, TranscriptionEventCallback } from '../brain/transcription/webSpeech';
import { acquireLoopbackStream, LoopbackError } from '../brain/transcription/loopbackAudio';
import {
  scoreChunk,
  mapSensitivityToThreshold,
  VAD_DISABLE_FOR_TEST,
  type VADSensitivity,
  type VADResult,
} from '../brain/transcription/vad';
import { vadSensitivityBus } from '../brain/transcription/vadSensitivityBus';
import { telemetry } from '../brain/telemetry';
import { database } from '../data/database';
import { useZuleError } from './useZuleError';
import toast from 'react-hot-toast';

/** Speaker assigned to system-audio (the remote party). */
const SYSTEM_SPEAKER_ID = 'speaker-2';

export interface UseSystemAudioTranscriptionOptions {
  /** BCP-47 / language tag forwarded to Whisper. Defaults to 'en'. */
  language?: string;
}

export interface UseSystemAudioTranscriptionResult {
  /** Final lines produced from system audio (role 'other'). */
  lines: TranscriptionLine[];
  /** Current interim placeholder (Whisper emits '...' while processing). */
  interimText: string;
  /** Whether the loopback pipeline is currently capturing. */
  isActive: boolean;
  /** Whether system-audio transcription is possible in this environment. */
  isSupported: boolean;
  /** Acquire loopback + load model + start. User-action only. */
  enable: () => Promise<void>;
  /** Stop capture and tear down the pipeline. */
  disable: () => void;
  /** Pause processing without tearing down. */
  pause: () => void;
  /** Resume after pause. */
  resume: () => void;
  /** Clear accumulated lines. */
  clearLines: () => void;
}

export function useSystemAudioTranscription(
  opts: UseSystemAudioTranscriptionOptions = {},
): UseSystemAudioTranscriptionResult {
  const { language = 'en' } = opts;

  const [lines, setLines] = useState<TranscriptionLine[]>([]);
  const [interimText, setInterimText] = useState('');
  const [isActive, setIsActive] = useState(false);

  const providerRef = useRef<WhisperProvider | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const unsubscribesRef = useRef<Off[]>([]);
  /**
   * Effective `speechThreshold` used by the VAD gate for the next chunk.
   * Held in a ref (not state) so the wrapped `transcribeFn` reads the
   * latest value without triggering re-renders, and so a
   * `vadSensitivityBus` event applied mid-capture takes effect on the
   * next chunk without tearing down audio (Requirement 7.4 /
   * Property 18). Default `medium` matches the un-gated baseline
   * (Requirement 7.6) and is overwritten in `enable` from the
   * persisted setting before the provider starts.
   */
  const speechThresholdRef = useRef<number>(mapSensitivityToThreshold('medium'));
  const notifyError = useZuleError();

  // Supported when we can capture system audio (getDisplayMedia) AND inference
  // is available. Inference now runs in the Electron main process via the
  // preload bridge (`whisperTranscribe`) — so this is desktop-only. The
  // renderer's own WASM/WebGPU engine crashes (0xC0000005), so we never use it.
  const whisperBridge =
    typeof window !== 'undefined' ? window.electronAPI?.whisperTranscribe : undefined;
  const isSupported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    !!navigator.mediaDevices.getDisplayMedia &&
    typeof whisperBridge === 'function';

  const cleanupSubscriptions = useCallback(() => {
    for (const unsub of unsubscribesRef.current) unsub();
    unsubscribesRef.current = [];
  }, []);

  /** Tear down the provider and the owned loopback stream. */
  const teardown = useCallback(() => {
    cleanupSubscriptions();
    if (providerRef.current) {
      providerRef.current.destroy();
      providerRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    // Release the main-process Whisper session (best-effort; ignore errors).
    window.electronAPI?.whisperRelease?.().catch(() => undefined);
    setInterimText('');
  }, [cleanupSubscriptions]);

  const disable = useCallback(() => {
    teardown();
    setIsActive(false);
  }, [teardown]);

  const enable = useCallback(async () => {
    if (providerRef.current) return; // already active
    if (!isSupported) {
      notifyError({ kind: 'transcription.unsupported' });
      return;
    }

    const bridge = window.electronAPI;
    if (!bridge?.whisperTranscribe) {
      notifyError({ kind: 'transcription.unsupported' });
      setIsActive(false);
      return;
    }

    // 1. Acquire the system-audio loopback stream (may prompt / be declined).
    let stream: MediaStream;
    try {
      stream = await acquireLoopbackStream();
    } catch (err) {
      const zuleError: ZuleError =
        err instanceof LoopbackError ? err.zuleError : { kind: 'transcription.audio-capture' };
      notifyError(zuleError);
      setIsActive(false);
      return;
    }
    streamRef.current = stream;

    // If the user stops the share from the OS UI, the audio track ends.
    const audioTrack = stream.getAudioTracks()[0];
    audioTrack?.addEventListener('ended', () => disable());

    // 2. Pre-warm the main-process Whisper model. This is where loading happens
    //    now (native onnxruntime-node), NOT in the renderer. ~760 ms cold.
    try {
      await bridge.whisperPreload?.({});
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[useSystemAudioTranscription] whisper preload failed:', err);
      toast.error(
        'Could not load the local speech model. Mic transcription is unaffected.',
      );
      teardown();
      setIsActive(false);
      return;
    }

    // 3. Spin up the Whisper provider in CAPTURE-ONLY mode: it captures the
    //    loopback stream and delegates every audio chunk to the main process
    //    over IPC. No in-renderer ML model is loaded (the renderer's WASM/
    //    WebGPU engine crashes — 0xC0000005).
    //
    //    The `transcribeFn` is the single point at which the loopback
    //    pipeline crosses into `whisper:transcribe`, so the VAD gate
    //    (design.md §"VAD Module" / Requirements 5.1–5.6) is applied
    //    here, immediately before the IPC call.

    // Hydrate the gate threshold from the persisted Settings row
    // (Requirement 7.3 / Property 17). A corrupt or missing value falls
    // back to `medium` — the documented default (Requirement 7.6).
    try {
      const persisted = await database.getSetting<VADSensitivity>(
        'vadSensitivity',
        'medium',
      );
      const sensitivity: VADSensitivity =
        persisted === 'low' || persisted === 'medium' || persisted === 'high'
          ? persisted
          : 'medium';
      speechThresholdRef.current = mapSensitivityToThreshold(sensitivity);
    } catch {
      // IndexedDB unavailable in this environment — keep the default.
      speechThresholdRef.current = mapSensitivityToThreshold('medium');
    }

    // Live sensitivity changes from Settings flow in here. The listener
    // mutates the ref so the next chunk's gate uses the new threshold
    // without restarting capture (Requirement 7.4 / Property 18). The
    // returned unsubscribe is registered alongside the provider event
    // unsubscribes so teardown clears it exactly once.
    const offVadBus = vadSensitivityBus.subscribe((event) => {
      speechThresholdRef.current = mapSensitivityToThreshold(event.value);
    });

    const provider = new WhisperProvider({
      speakerId: SYSTEM_SPEAKER_ID,
      speakerRole: 'other',
      language,
      transcribeFn: async (pcm) => {
        // VAD gate. The kill-switch lets the existing
        // `useSystemAudioTranscription` integration tests keep their
        // assertions unchanged (Requirement 9.3): when enabled the gate
        // is bypassed and every chunk is forwarded.
        if (!VAD_DISABLE_FOR_TEST.enabled) {
          let result: VADResult | undefined;
          let cause: 'threw' | 'invalid-score' | null = null;
          try {
            result = scoreChunk(pcm, {
              speechThreshold: speechThresholdRef.current,
            });
          } catch {
            cause = 'threw';
          }

          // Validate the score. Even though `scoreChunk` is documented
          // to return a number in `[0, 1]`, treat its output as untrusted
          // — Requirement 5.5 / Property 15 says we must forward the
          // chunk and emit a typed error on NaN, out-of-range, or an
          // undefined return.
          if (cause === null) {
            const score = result?.score;
            if (
              !result ||
              typeof score !== 'number' ||
              !Number.isFinite(score) ||
              score < 0 ||
              score > 1
            ) {
              cause = 'invalid-score';
            }
          }

          if (cause !== null) {
            // Safe-by-default: open the gate, log the typed failure,
            // and fall through to the IPC so a broken VAD never
            // silently suppresses transcription.
            telemetry.emit({
              kind: 'error',
              name: 'transcription.vad-failed',
              message:
                cause === 'threw'
                  ? 'VAD threw during scoreChunk for loopback chunk'
                  : 'VAD returned an invalid score for loopback chunk',
              stack: '',
              breadcrumb: ['useSystemAudioTranscription', 'loopback', cause],
            });
          } else if (result && !result.isSpeech) {
            // Sub-threshold chunk — skip the IPC, count it once, and
            // suppress the interim placeholder that
            // `WhisperProvider.processAccumulatedAudio` already emitted
            // for this chunk so the consumer never sees a `…` for
            // silence (Requirements 5.2, 5.6 / Properties 13, 21).
            // React batches the two `setInterimText` calls in the same
            // microtask, so only the cleared value is rendered.
            telemetry.emit({ kind: 'vad.skipped', pipeline: 'loopback' });
            setInterimText('');
            return '';
          }
        }

        const { text } = await bridge.whisperTranscribe!(pcm, { language });
        return text;
      },
    });
    providerRef.current = provider;

    const offLine = provider.on('line', ((line: TranscriptionLine) => {
      setLines((prev) => [...prev, line]);
      setInterimText('');
    }) as TranscriptionEventCallback);
    const offInterim = provider.on('interim', ((text: string) => {
      setInterimText(text);
    }) as TranscriptionEventCallback);
    const offError = provider.on('error', ((e: ZuleError) => {
      notifyError(e);
    }) as TranscriptionEventCallback);
    unsubscribesRef.current = [offLine, offInterim, offError, offVadBus];

    // 4. Start capture. Inference happens out-of-process per chunk.
    try {
      await provider.start({ stream, language, speakerId: SYSTEM_SPEAKER_ID, speakerRole: 'other' });
      setIsActive(true);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[useSystemAudioTranscription] enable() failed:', err);
      toast.error('Could not start system-audio transcription. Mic transcription is unaffected.');
      teardown();
      setIsActive(false);
    }
  }, [isSupported, language, disable, teardown, notifyError]);

  const pause = useCallback(() => {
    providerRef.current?.pause();
  }, []);

  const resume = useCallback(() => {
    providerRef.current?.resume();
  }, []);

  const clearLines = useCallback(() => {
    setLines([]);
    setInterimText('');
  }, []);

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      teardown();
    };
  }, [teardown]);

  // Consumers observe results via `lines` / `interimText` — no event
  // passthrough is exposed.

  return {
    lines,
    interimText,
    isActive,
    isSupported,
    enable,
    disable,
    pause,
    resume,
    clearLines,
  };
}
