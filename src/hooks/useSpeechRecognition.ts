// ============================================
// Zule AI — Speech Recognition Hook
// ============================================

import { useState, useRef, useCallback, useEffect } from 'react';
import toast from 'react-hot-toast';
import type { TranscriptLine } from '../brain/contextManager';
import { speakerManager } from '../brain/speakerManager';



interface SpeechRecognitionHook {
  transcript: TranscriptLine[];
  interimText: string;
  isListening: boolean;
  isSupported: boolean;
  start: () => void;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  clearTranscript: () => void;
}

interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSpeechRecognition(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function useSpeechRecognition(): SpeechRecognitionHook {
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [interimText, setInterimText] = useState('');
  const [isListening, setIsListening] = useState(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const isListeningRef = useRef(false);
  const shouldRestartRef = useRef(false);

  const SpeechRecognitionClass = getSpeechRecognition();
  const isSupported = !!SpeechRecognitionClass;

  const addLine = useCallback((text: string) => {
    // If there was a long pause, we might assume the other person started speaking
    if (speakerManager.checkPossibleSpeakerChange()) {
      // In a real app with diarization, we'd assign automatically. 
      // For now, we rely on the manual toggle or gap detection logic if needed.
    }
    const speakerProfile = speakerManager.getActiveSpeaker();

    const line: TranscriptLine = {
      id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text: text.trim(),
      timestamp: Date.now(),
      isInterim: false,
      speaker: speakerProfile.id as 'user' | 'other',
    };
    setTranscript(prev => [...prev, line]);
  }, []);

  const start = useCallback(() => {
    if (!SpeechRecognitionClass || isListeningRef.current) return;

    const recognition = new SpeechRecognitionClass();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const text = result[0].transcript;
          if (text.trim()) {
            addLine(text);
          }
          setInterimText('');
        } else {
          interim += result[0].transcript;
        }
      }
      if (interim) {
        setInterimText(interim);
      }
    };

    recognition.onend = () => {
      // Auto-restart if we should be listening
      if (shouldRestartRef.current && isListeningRef.current) {
        try {
          recognition.start();
        } catch {
          // May fail if already started
        }
      } else {
        setIsListening(false);
        isListeningRef.current = false;
      }
    };

    recognition.onerror = (event: { error: string }) => {
      console.warn('Speech recognition error:', event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setIsListening(false);
        isListeningRef.current = false;
        shouldRestartRef.current = false;
      }
    };

    recognitionRef.current = recognition;
    shouldRestartRef.current = true;
    isListeningRef.current = true;
    setIsListening(true);

    try {
      recognition.start();
    } catch (e) {
      toast.error('Failed to start speech recognition. Please try again.');
      setIsListening(false);
      isListeningRef.current = false;
    }
  }, [SpeechRecognitionClass, addLine]);

  const stop = useCallback(() => {
    shouldRestartRef.current = false;
    isListeningRef.current = false;
    setIsListening(false);
    setInterimText('');
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Ignore
      }
      recognitionRef.current = null;
    }
  }, []);

  const pause = useCallback(() => {
    shouldRestartRef.current = false;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Ignore
      }
    }
    setIsListening(false);
    isListeningRef.current = false;
  }, []);

  const resume = useCallback(() => {
    if (recognitionRef.current) {
      shouldRestartRef.current = true;
      isListeningRef.current = true;
      setIsListening(true);
      try {
        recognitionRef.current.start();
      } catch {
        // Ignore
      }
    } else {
      start();
    }
  }, [start]);

  const clearTranscript = useCallback(() => {
    setTranscript([]);
    setInterimText('');
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      shouldRestartRef.current = false;
      isListeningRef.current = false;
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          // Ignore
        }
      }
    };
  }, []);

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
  };
}
