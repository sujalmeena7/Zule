// ============================================
// Zule AI — Input Bar Sub-Component
// ============================================

import { useState, useRef, useEffect, type RefObject } from 'react';
import { Zap, MoreHorizontal, Send, Mic, MicOff, Image as ImageIcon } from 'lucide-react';
import { useZuleError } from '../../hooks/useZuleError';
import { WhisperProvider } from '../../brain/transcription/whisper';
import type { TranscriptionLine } from '../../types/transcription';
import type { ZuleError } from '../../types/errors';

interface InputBarProps {
  inputText: string;
  onInputChange: (text: string) => void;
  onSubmit: () => void;
  isLoading: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Optional: handler for the "Use Screen" button. Captures the current
   *  desktop and sends it as image context for the next AI request. When
   *  omitted, the button is hidden (web mode without screen capture). */
  onUseScreen?: () => void;
  /** Optional: whether a screen capture session is currently active.
   *  When true, the Use Screen button shows an "active" state. */
  isScreenActive?: boolean;
  /** Optional: called when in-bar voice dictation starts. The host pauses the
   *  main mic pipeline so the two SpeechRecognition instances don't collide. */
  onDictationStart?: () => void;
  /** Optional: called when in-bar voice dictation ends (any exit path), so the
   *  host can resume the main mic pipeline. */
  onDictationEnd?: () => void;
}

export function InputBar({
  inputText,
  onInputChange,
  onSubmit,
  isLoading,
  inputRef,
  onUseScreen,
  isScreenActive,
  onDictationStart,
  onDictationEnd,
}: InputBarProps) {
  const [isVoiceTyping, setIsVoiceTyping] = useState(false);
  const recognitionRef = useRef<any>(null);
  const whisperRef = useRef<WhisperProvider | null>(null);
  const inputTextRef = useRef(inputText);
  const notifyError = useZuleError();
  // Guard so onDictationEnd fires exactly once per dictation session, no
  // matter which exit path (manual stop / onend / onerror / unmount) runs.
  const dictationActiveRef = useRef(false);

  inputTextRef.current = inputText;

  // Signal the host that dictation ended (idempotent — only fires if active).
  const endDictation = () => {
    if (dictationActiveRef.current) {
      dictationActiveRef.current = false;
      onDictationEnd?.();
    }
  };
  // Keep a ref to endDictation so the unmount cleanup always sees the latest
  // onDictationEnd without re-running the effect.
  const endDictationRef = useRef(endDictation);
  endDictationRef.current = endDictation;

  // Append a recognised phrase to the input field.
  const appendTranscript = (text: string) => {
    const t = text.trim();
    if (!t) return;
    onInputChange(inputTextRef.current + (inputTextRef.current ? ' ' : '') + t);
  };

  // Stop voice recognition on unmount and release the main mic pipeline.
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      whisperRef.current?.destroy();
      whisperRef.current = null;
      endDictationRef.current();
    };
  }, []);

  // Stop whichever dictation engine is active and reset UI/host state.
  const stopDictation = () => {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
    if (whisperRef.current) {
      whisperRef.current.destroy();
      whisperRef.current = null;
    }
    setIsVoiceTyping(false);
    endDictation();
  };

  // In Electron, the Web Speech API constructs but cannot actually transcribe
  // (Chromium's recognizer relies on Google's private cloud endpoint, which is
  // absent in Electron) — so dictation must run through the local Whisper model
  // that already powers system-audio transcription. The WhisperProvider opens
  // the mic itself and delegates inference to the main process over IPC.
  const startWhisperDictation = async (): Promise<boolean> => {
    const bridge = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (typeof bridge?.whisperTranscribe !== 'function') return false;

    try {
      await bridge.whisperPreload?.({});
    } catch {
      notifyError({ kind: 'transcription.audio-capture' });
      return false;
    }

    const provider = new WhisperProvider({
      speakerId: 'speaker-1',
      speakerRole: 'user',
      language: 'en',
      transcribeFn: async (pcm) => {
        const { text } = await bridge.whisperTranscribe!(pcm, { language: 'en' });
        return text;
      },
    });

    provider.on('line', ((line: TranscriptionLine) => appendTranscript(line.text)) as any);
    provider.on('error', ((e: ZuleError) => {
      notifyError(e);
      stopDictation();
    }) as any);

    // Pause the main mic pipeline *before* opening our own capture so the two
    // never share the microphone concurrently.
    dictationActiveRef.current = true;
    onDictationStart?.();

    try {
      await provider.start({ language: 'en', speakerId: 'speaker-1', speakerRole: 'user' });
      whisperRef.current = provider;
      setIsVoiceTyping(true);
      return true;
    } catch {
      provider.destroy();
      notifyError({ kind: 'transcription.audio-capture' });
      setIsVoiceTyping(false);
      endDictation();
      return true; // handled (don't fall through to Web Speech in Electron)
    }
  };

  const toggleVoiceTyping = async () => {
    if (isVoiceTyping) {
      stopDictation();
      return;
    }

    // Prefer local Whisper when the Electron bridge is present.
    if (await startWhisperDictation()) return;

    // Browser fallback: Web Speech API.
    try {
      // @ts-ignore - SpeechRecognition is not fully typed
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        // Replaces previous `alert(...)` with the central toast pipeline
        // (Requirement 18.7).
        notifyError({ kind: 'transcription.unsupported' });
        return;
      }

      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onresult = (event: any) => {
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          }
        }
        if (finalTranscript) {
          appendTranscript(finalTranscript);
        }
      };

      recognition.onerror = () => {
        notifyError({ kind: 'transcription.audio-capture' });
        setIsVoiceTyping(false);
        endDictation();
      };

      recognition.onend = () => {
        setIsVoiceTyping(false);
        endDictation();
      };

      // Pause the main mic pipeline *before* starting our own recognizer so
      // the two SpeechRecognition instances never share the mic concurrently.
      dictationActiveRef.current = true;
      onDictationStart?.();

      recognition.start();
      recognitionRef.current = recognition;
      setIsVoiceTyping(true);
    } catch (e) {
      notifyError({ kind: 'transcription.audio-capture' });
      setIsVoiceTyping(false);
      endDictation();
    }
  };

  return (
    <div className="card-input-bar">
      <div className="input-wrapper">
        <input
          ref={inputRef}
          type="text"
          className="copilot-input"
          placeholder="Ask about your screen or conversation, or  Ctrl ↵  for Assist"
          value={inputText}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              onSubmit();
            } else if (e.key === 'Enter' && !e.shiftKey) {
              onSubmit();
            }
          }}
        />
      </div>
      <div className="input-toolbar">
        <div className="input-toolbar-left">
          {onUseScreen && (
            <button
              className={`use-screen-btn ${isScreenActive ? 'is-active' : ''}`}
              onClick={onUseScreen}
              aria-label="Use screen as context"
              aria-pressed={isScreenActive}
              title="Use Screen — capture the current desktop and ask the AI about it"
            >
              <ImageIcon size={12} />
              <span>Use Screen</span>
            </button>
          )}
          <span className="smart-badge">
            <Zap size={12} />
            <span>Smart</span>
          </span>
          <button className="toolbar-more-btn" aria-label="More options">
            <MoreHorizontal size={14} />
          </button>
          <button 
            className={`toolbar-more-btn ${isVoiceTyping ? 'recording' : ''}`}
            onClick={() => { void toggleVoiceTyping(); }}
            title="Voice Type Command"
            aria-label={isVoiceTyping ? 'Stop voice typing' : 'Start voice typing'}
          >
            {isVoiceTyping ? <MicOff size={14} color="#ef4444" /> : <Mic size={14} />}
          </button>
        </div>
        <button
          className="input-send-btn"
          onClick={onSubmit}
          disabled={isLoading}
          aria-label="Send message"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
