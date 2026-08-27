// ============================================
// Zule AI — useTranscription Hook
// ============================================
//
// React hook that wraps the WebSpeechProvider and WhisperProvider
// into a clean interface for the Copilot_Engine / FloatingCopilot.
//
// In Electron, it uses WhisperProvider backed by the main-process
// onnxruntime-node engine (offline, 100% reliable, no Google cloud dependency).
// In standard browsers, it uses WebSpeechProvider (Web Speech API).
//
// Exposes: start, stop, pause, resume, isListening, isSupported, on(event, cb)

import { useState, useRef, useCallback, useEffect } from 'react';
import type { TranscriptionLine, TranscriptionProvider } from '../types/transcription';
import type { ZuleError } from '../types/errors';
import { WebSpeechProvider, type Off, type TranscriptionEvent, type TranscriptionEventCallback } from '../brain/transcription/webSpeech';
import { WhisperProvider } from '../brain/transcription/whisper';

export interface UseTranscriptionOptions {
  /** BCP-47 language tag. Default 'en-US'. */
  language?: string;
  /** Transcription provider. Default 'auto'. */
  provider?: TranscriptionProvider | 'auto';
  /** Confidence threshold for filtering low-quality finals. Default 0.30. */
  confidenceThreshold?: number;
  /** Initial speaker id. */
  speakerId?: string;
  /** Initial speaker role. */
  speakerRole?: 'user' | 'other';
}

export interface UseTranscriptionResult {
  /** All final transcript lines produced since start. */
  transcript: TranscriptionLine[];
  /** Current interim (partial) text. */
  interimText: string;
  /** Whether the recognizer is currently active. */
  isListening: boolean;
  /** Whether transcription is supported in this environment. */
  isSupported: boolean;
  /** Start transcription. */
  start: () => Promise<void>;
  /** Stop transcription. Returns flushed interim line if any. */
  stop: () => TranscriptionLine | null;
  /** Pause without flushing. */
  pause: () => void;
  /** Resume after pause. */
  resume: () => void;
  /** Clear transcript history. */
  clearTranscript: () => void;
  /** Register an event listener. Returns unsubscribe function. */
  on: (event: TranscriptionEvent, cb: TranscriptionEventCallback) => Off;
}

export function useTranscription(opts: UseTranscriptionOptions = {}): UseTranscriptionResult {
  const {
    language = 'en-US',
    provider: providerType = 'auto',
    confidenceThreshold = 0.30,
    speakerId = 'speaker-1',
    speakerRole = 'user',
  } = opts;

  const [transcript, setTranscript] = useState<TranscriptionLine[]>([]);
  const [interimText, setInterimText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(() => {
    if (typeof window === 'undefined') return false;
    if (typeof (window as any).electronAPI?.whisperTranscribe === 'function') return true;
    return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  });

  const providerRef = useRef<WebSpeechProvider | WhisperProvider | null>(null);
  const unsubscribesRef = useRef<Off[]>([]);

  // Cleanup provider subscriptions
  const cleanupSubscriptions = useCallback(() => {
    for (const unsub of unsubscribesRef.current) {
      unsub();
    }
    unsubscribesRef.current = [];
  }, []);

  const start = useCallback(async () => {
    // Destroy any existing provider
    if (providerRef.current) {
      providerRef.current.destroy();
      cleanupSubscriptions();
    }

    const bridge = typeof window !== 'undefined' ? (window as any).electronAPI : undefined;
    const hasElectronWhisper = typeof bridge?.whisperTranscribe === 'function';

    const useWhisper =
      providerType === 'local-whisper' ||
      (providerType === 'auto' && hasElectronWhisper) ||
      (providerType === 'web-speech' && hasElectronWhisper);

    let activeProvider: WebSpeechProvider | WhisperProvider;

    if (useWhisper && hasElectronWhisper) {
      try {
        await bridge.whisperPreload?.({});
      } catch (err) {
        console.warn('[useTranscription] Whisper preload failed:', err);
      }

      activeProvider = new WhisperProvider({
        language: language.startsWith('en') ? 'en' : language,
        speakerId,
        speakerRole,
        transcribeFn: async (pcm) => {
          const { text } = await bridge.whisperTranscribe(pcm, { language });
          return text;
        },
      });
    } else {
      activeProvider = new WebSpeechProvider({
        language,
        confidenceThreshold,
        speakerId,
        speakerRole,
      });
    }

    providerRef.current = activeProvider;
    setIsSupported(activeProvider.isSupported);

    if (!activeProvider.isSupported) {
      return;
    }

    // Subscribe to events
    const offLine = activeProvider.on('line', ((line: TranscriptionLine) => {
      setTranscript((prev) => [...prev, line]);
      setInterimText('');
    }) as TranscriptionEventCallback);
    const offInterim = activeProvider.on('interim', ((text: string) => {
      setInterimText(text);
    }) as TranscriptionEventCallback);
    const offError = activeProvider.on('error', ((err: ZuleError) => {
      if (err.kind === 'transcription.permission-denied' || err.kind === 'transcription.permission-revoked') {
        setIsListening(false);
      }
      if (err.kind === 'transcription.unsupported') {
        setIsSupported(false);
        setIsListening(false);
      }
      if (err.kind === 'transcription.network') {
        setIsListening(false);
      }
    }) as TranscriptionEventCallback);

    unsubscribesRef.current = [offLine, offInterim, offError];

    try {
      await activeProvider.start({ language, speakerId, speakerRole });
      setIsListening(activeProvider.isListening);
    } catch (err) {
      console.error('[useTranscription] Failed to start provider:', err);
      setIsListening(false);
    }
  }, [language, providerType, confidenceThreshold, speakerId, speakerRole, cleanupSubscriptions]);

  const stop = useCallback((): TranscriptionLine | null => {
    if (!providerRef.current) return null;
    const flushedLine = providerRef.current.stop();
    if (flushedLine) {
      setTranscript((prev) => [...prev, flushedLine]);
    }
    setInterimText('');
    setIsListening(false);
    cleanupSubscriptions();
    return flushedLine;
  }, [cleanupSubscriptions]);

  const pause = useCallback(() => {
    if (providerRef.current) {
      providerRef.current.pause();
      setIsListening(false);
    }
  }, []);

  const resume = useCallback(() => {
    if (providerRef.current) {
      providerRef.current.resume();
      setIsListening(true);
    }
  }, []);

  const clearTranscript = useCallback(() => {
    setTranscript([]);
    setInterimText('');
  }, []);

  const on = useCallback((event: TranscriptionEvent, cb: TranscriptionEventCallback): Off => {
    if (providerRef.current) {
      return providerRef.current.on(event, cb);
    }
    // If no provider yet, return a no-op unsubscribe
    return () => {};
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (providerRef.current) {
        providerRef.current.destroy();
      }
      cleanupSubscriptions();
    };
  }, [cleanupSubscriptions]);

  return {
    transcript,
    interimText,
    isListening,
    isSupported,
    start,
    stop,
    pause,
    resume,
    clearTranscript,
    on,
  };
}
