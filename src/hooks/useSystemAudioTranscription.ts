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
  /** Current interim text from partials. */
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
  /** Guard against concurrent enable() calls racing through async preload. */
  const isEnablingRef = useRef(false);
  const notifyError = useZuleError();

  // Supported when we can capture system audio (getDisplayMedia) AND inference
  // is available. Inference runs in the Electron main process via the
  // preload bridge (`whisperTranscribe`) — so this is desktop-only.
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
    // Release the main-process Whisper session with refcounting (best-effort; ignore errors).
    window.electronAPI?.whisperRelease?.({ pipeline: 'loopback' }).catch(() => undefined);
    setInterimText('');
  }, [cleanupSubscriptions]);

  const disable = useCallback(() => {
    teardown();
    setIsActive(false);
  }, [teardown]);

  const enable = useCallback(async () => {
    if (providerRef.current || isEnablingRef.current) return; // already active or in-flight
    isEnablingRef.current = true;
    if (!isSupported) {
      isEnablingRef.current = false;
      notifyError({ kind: 'transcription.unsupported' });
      return;
    }

    const bridge = window.electronAPI;
    if (!bridge?.whisperTranscribe) {
      isEnablingRef.current = false;
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
      isEnablingRef.current = false;
      notifyError(zuleError);
      setIsActive(false);
      return;
    }
    streamRef.current = stream;

    // If the user stops the share from the OS UI, the audio track ends.
    const audioTrack = stream.getAudioTracks()[0];
    audioTrack?.addEventListener('ended', () => disable());

    // Show the green dot IMMEDIATELY after stream acquisition.
    setIsActive(true);

    // 2. Pre-warm the main-process Whisper models for loopback.
    try {
      await bridge.whisperPreload?.({ pipeline: 'loopback' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[useSystemAudioTranscription] whisper preload failed (will load on-demand):', err);
    }

    // 3. Spin up the Whisper provider in CAPTURE-ONLY mode with partials enabled.
    // The provider internally executes VAD gating and listens to vadSensitivityBus.
    const provider = new WhisperProvider({
      pipelineId: 'loopback',
      partials: { enabled: true },
      speakerId: SYSTEM_SPEAKER_ID,
      speakerRole: 'other',
      language,
      transcribeFn: async (pcm, opts) => {
        const result = await bridge.whisperTranscribe!(pcm, {
          language: opts.language ?? language,
          kind: opts.kind,
          seq: opts.seq,
          pipeline: 'loopback',
          modelId: opts.modelId,
        });
        return result;
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
    unsubscribesRef.current = [offLine, offInterim, offError];

    // 4. Start capture. Inference happens out-of-process per chunk.
    try {
      await provider.start({ stream, language, speakerId: SYSTEM_SPEAKER_ID, speakerRole: 'other' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[useSystemAudioTranscription] enable() failed:', err);
      toast.error('Could not start system-audio transcription. Mic transcription is unaffected.');
      teardown();
      setIsActive(false);
    } finally {
      isEnablingRef.current = false;
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
