// ============================================
// Zule AI — Suggestion Card Sub-Component
// ============================================

import { useState, useEffect } from 'react';
import { Sparkles, Loader2, AlertTriangle, ThumbsUp, ThumbsDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { motion, AnimatePresence } from 'framer-motion';
import type { AIResponse } from '../../brain/aiProvider';
import type { CitationInfo } from '../../brain/contextManager';
import { saveRating, type RatingValue } from '../../brain/ratings';

interface SuggestionCardProps {
  isLoading: boolean;
  isStreaming: boolean;
  streamingText: string;
  /**
   * A thinking model's chain-of-thought, streamed while it works out the
   * answer. Not the answer, and never rendered as one — but on a hard problem
   * this is the only thing arriving for tens of seconds, so it drives a live
   * progress readout in place of the static "Thinking..." spinner.
   */
  reasoningText?: string;
  aiResponse: AIResponse | null;
  onTriggerAI: (query: string) => void;
  /** Provider id for rating attribution (defaults to 'unknown'). */
  providerId?: string;
  /** Model id for rating attribution (defaults to 'unknown'). */
  modelId?: string;
  /** Modalities used in the latest context window (Requirement 23.4, 8.4). */
  modalitiesUsed?: ('audio' | 'screen' | 'knowledge' | 'memory' | 'keyframe' | 'screenText')[];
  /** Citation info for knowledge/memory chips (Requirements 5.5, 24.2). */
  citations?: CitationInfo[];
  /** Optional handler for citation chip clicks (e.g., navigate to meeting detail). */
  onCitationClick?: (citation: CitationInfo) => void;
}

export function SuggestionCard({
  isLoading,
  isStreaming,
  streamingText,
  reasoningText = '',
  aiResponse,
  onTriggerAI,
  providerId = 'unknown',
  modelId = 'unknown',
  modalitiesUsed,
  citations,
  onCitationClick,
}: SuggestionCardProps) {
  const [userRating, setUserRating] = useState<RatingValue | null>(null);

  const handleRate = (rating: RatingValue) => {
    if (userRating === rating) return; // already rated same
    setUserRating(rating);
    saveRating(providerId, modelId, rating).catch((err) => {
      console.error('[SuggestionCard] Failed to save rating:', err);
    });
  };

  // Reset rating when response changes
  const [lastResponseText, setLastResponseText] = useState<string | null>(null);
  useEffect(() => {
    const currentText = aiResponse?.text ?? null;
    if (currentText !== lastResponseText) {
      setLastResponseText(currentText);
      if (userRating !== null) {
        setUserRating(null);
      }
    }
  }, [aiResponse?.text]);

  // Wall-clock for the in-flight request. A thinking model can spend a minute
  // before its first answer token, and a spinner alone gives the user no way to
  // judge whether that is normal or whether the request died — a number that
  // keeps moving does.
  const [waitSeconds, setWaitSeconds] = useState(0);
  // Collapsed by default. This is an interview overlay: the reasoning trace is
  // long, restates the question, and is not what the user is trying to read.
  const [showReasoning, setShowReasoning] = useState(false);
  useEffect(() => {
    if (!isLoading) {
      setWaitSeconds(0);
      return;
    }
    const startedAt = Date.now();
    // 500ms so the displayed second is never more than half a second stale;
    // the value itself is floored to whole seconds to avoid a jittery readout.
    const id = setInterval(() => {
      setWaitSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [isLoading]);

  // Reasoning arrives as characters, but "tokens" is the unit users see quoted
  // for these models. ~4 chars/token is the usual English approximation and is
  // only ever used for a progress readout, never for billing or budgeting.
  const reasoningTokens = reasoningText ? Math.round(reasoningText.length / 4) : 0;
  // The tail is what the model is working on *now*, which is the part that
  // signals progress. The head is minutes-old context by the time it matters.
  const reasoningTail = reasoningText.slice(-600);

  return (
    <>
      {/* AI Suggestion */}
      <div className="card-suggestion" aria-live="polite" aria-atomic="false">
        <AnimatePresence mode="wait">
          {isLoading ? (
            <motion.div 
              key="loading"
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              className="suggestion-loading"
            >
              <motion.div
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
              >
                <Loader2 size={18} className="spinner" />
              </motion.div>
              <span>
                {reasoningTokens > 0
                  ? `Reasoning · ${waitSeconds}s · ${reasoningTokens} tokens`
                  : waitSeconds >= 2
                    ? `Thinking... ${waitSeconds}s`
                    : 'Thinking...'}
              </span>
              {reasoningTail && (
                <button
                  type="button"
                  className="reasoning-toggle"
                  onClick={() => setShowReasoning((v) => !v)}
                  aria-expanded={showReasoning}
                >
                  {showReasoning ? 'hide' : 'show'}
                </button>
              )}
            </motion.div>
          ) : isStreaming && streamingText ? (
            <motion.div 
              key="streaming"
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              className="suggestion-text streaming"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {streamingText}
              </ReactMarkdown>
              <span className="streaming-cursor" />
            </motion.div>
          ) : aiResponse ? (
            <motion.div 
              key="response"
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              className="suggestion-text markdown-content"
            >
              {aiResponse.isSimulated && (
                <div className="simulation-warning">
                  <AlertTriangle size={14} className="sim-icon" />
                  <span><strong>Simulation Mode:</strong> Add your Gemini API key in Settings for real AI responses.</span>
                </div>
              )}
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {aiResponse.text}
              </ReactMarkdown>
            </motion.div>
          ) : (
            <motion.div 
              key="placeholder"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="suggestion-placeholder"
            >
              <Sparkles size={16} />
              <span>Start speaking or ask a question to get AI suggestions...</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/*
          The live reasoning tail. Rendered as plain text, not markdown: a
          chain-of-thought is full of half-written code fences and list markers
          that a markdown renderer would either swallow or reflow on every
          chunk. `aria-hidden` because the status line above already announces
          progress politely — reading the whole trace aloud would be hostile.
        */}
        {isLoading && showReasoning && reasoningTail && (
          <pre className="reasoning-trace" aria-hidden="true"><span>{reasoningTail}</span></pre>
        )}
      </div>

      {/* Modality badges and citation chips (Requirements 23.4, 5.5, 24.2) */}
      {aiResponse && !isStreaming && modalitiesUsed && modalitiesUsed.length > 0 && (
        <div className="card-modality-badges" aria-label="Sources used">
          {modalitiesUsed.includes('audio') && (
            <span className="modality-badge modality-audio">🎤 Audio</span>
          )}
          {modalitiesUsed.includes('screen') && (
            <span className="modality-badge modality-screen">🖥 Screen</span>
          )}
          {modalitiesUsed.includes('knowledge') && (
            <span className="modality-badge modality-knowledge">📚 Knowledge</span>
          )}
          {modalitiesUsed.includes('memory') && (
            <span className="modality-badge modality-memory">🧠 Memory</span>
          )}
          {modalitiesUsed.includes('keyframe') && (
            <span className="modality-badge modality-screen">📷 Keyframe</span>
          )}
          {modalitiesUsed.includes('screenText') && (
            <span className="modality-badge modality-screen">📝 Screen Text</span>
          )}
          {citations && citations.length > 0 && (
            <>
              <span className="modality-divider" aria-hidden="true" />
              {citations.map((citation) => (
                <button
                  key={citation.citationId}
                  className={`citation-chip ${citation.label === '[MEMORY]' ? 'citation-memory' : 'citation-knowledge'}`}
                  onClick={() => onCitationClick?.(citation)}
                  aria-label={`Citation ${citation.citationId}`}
                  title={
                    citation.label === '[MEMORY]' && citation.source?.meetingId
                      ? `From meeting ${citation.source.meetingId}`
                      : citation.label === '[KNOWLEDGE]' && citation.source?.docId
                        ? `From document ${citation.source.docId}`
                        : `Citation ${citation.citationId}`
                  }
                >
                  {citation.citationId}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {/* Rating buttons (visible when a response is displayed) */}
      {aiResponse && !isStreaming && (
        <div className="card-rating" role="group" aria-label="Rate this response">
          <button
            className={`rating-btn${userRating === 'up' ? ' active' : ''}`}
            onClick={() => handleRate('up')}
            aria-label="Thumbs up"
            aria-pressed={userRating === 'up'}
          >
            <ThumbsUp size={14} />
          </button>
          <button
            className={`rating-btn${userRating === 'down' ? ' active' : ''}`}
            onClick={() => handleRate('down')}
            aria-label="Thumbs down"
            aria-pressed={userRating === 'down'}
          >
            <ThumbsDown size={14} />
          </button>
        </div>
      )}

      {/* Follow-up suggestions */}
      {aiResponse && aiResponse.followUps && aiResponse.followUps.length > 0 && (
        <div className="card-followups">
          {aiResponse.followUps.map((fu, i) => (
            <button
              key={i}
              className="followup-chip"
              onClick={() => onTriggerAI(fu)}
            >
              {fu}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
