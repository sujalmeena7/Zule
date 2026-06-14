// ============================================
// Zule AI — Input Bar Sub-Component
// ============================================

import { useState, useRef, type RefObject } from 'react';
import { Zap, MoreHorizontal, Send, Mic, MicOff, Image as ImageIcon } from 'lucide-react';
import { useZuleError } from '../../hooks/useZuleError';

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
}

export function InputBar({
  inputText,
  onInputChange,
  onSubmit,
  isLoading,
  inputRef,
  onUseScreen,
  isScreenActive,
}: InputBarProps) {
  const [isVoiceTyping, setIsVoiceTyping] = useState(false);
  const recognitionRef = useRef<any>(null);
  const notifyError = useZuleError();

  const toggleVoiceTyping = () => {
    if (isVoiceTyping) {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      setIsVoiceTyping(false);
      return;
    }

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
          onInputChange(inputText + (inputText ? ' ' : '') + finalTranscript.trim());
        }
      };

      recognition.onerror = (event: any) => {
        notifyError({ kind: 'transcription.audio-capture' });
        setIsVoiceTyping(false);
      };

      recognition.onend = () => {
        setIsVoiceTyping(false);
      };

      recognition.start();
      recognitionRef.current = recognition;
      setIsVoiceTyping(true);
    } catch (e) {
      notifyError({ kind: 'transcription.audio-capture' });
      setIsVoiceTyping(false);
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
            onClick={toggleVoiceTyping}
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
