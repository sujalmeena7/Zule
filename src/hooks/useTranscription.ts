// ============================================
// Zule AI — useTranscription Hook
// ============================================
//
// React hook that wraps the WebSpeechProvider (and future Whisper provider)
// into a clean interface for the Copilot_Engine / FloatingCopilot.
//
// Replaces `useSpeechRecognition.ts` with a provider-pluggable design.
//
// Exposes: start, stop, pause, resume, isListening, isSupported, on(event, cb)
//
// Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10

import { useState, useRef, useCallback, useEffect } from 'react';
import type { TranscriptionLine, TranscriptionProvider } from '../types/transcription';
import type { ZuleError } from '../types/errors';
import { WebSpeechProvider, type Off, type TranscriptionEvent, type TranscriptionEventCallback } from '../brain/transcription/webSpeech';

export interface UseTranscriptionOptions {
  /** BCP-47 language tag. Default 'en-US'. */
  language?: string;
  /** Transcription provider. Default 'web-speech'. */
  provider?: TranscriptionProvider;
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
  /** Whether Web Speech API is supported in this browser. */
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
    provider: _providerType = 'web-speech',
    confidenceThreshold = 0.30,
    speakerId = 'speaker-1',
    speakerRole = 'user',
  } = opts;

  const [transcript, setTranscript] = useState<TranscriptionLine[]>([]);
  const [interimText, setInterimText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(true);

  const providerRef = useRef<WebSpeechProvider | null>(null);
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

    const webProvider = new WebSpeechProvider({
      language,
      confidenceThreshold,
      speakerId,
      speakerRole,
    });

    providerRef.current = webProvider;
    setIsSupported(webProvider.isSupported);

    if (!webProvider.isSupported) {
      return;
    }

    // Subscribe to events
    const offLine = webProvider.on('line', ((line: TranscriptionLine) => {
      setTranscript((prev) => [...prev, line]);
      setInterimText('');
    }) as TranscriptionEventCallback);
    const offInterim = webProvider.on('interim', ((text: string) => {
      setInterimText(text);
    }) as TranscriptionEventCallback);
    const offError = webProvider.on('error', ((err: ZuleError) => {
      if (err.kind === 'transcription.permission-denied' || err.kind === 'transcription.permission-revoked') {
        setIsListening(false);
      }
      if (err.kind === 'transcription.unsupported') {
        setIsSupported(false);
        setIsListening(false);
      }
      if (err.kind === 'transcription.network') {
        // Supervisor paused — surface recoverable error
        setIsListening(false);
      }
    }) as TranscriptionEventCallback);

    unsubscribesRef.current = [offLine, offInterim, offError];

    await webProvider.start({ language, speakerId, speakerRole });
    setIsListening(webProvider.isListening);
  }, [language, confidenceThreshold, speakerId, speakerRole, cleanupSubscriptions]);

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
