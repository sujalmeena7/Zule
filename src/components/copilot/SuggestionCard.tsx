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
  aiResponse: AIResponse | null;
  onTriggerAI: (query: string) => void;
  /** Provider id for rating attribution (defaults to 'unknown'). */
  providerId?: string;
  /** Model id for rating attribution (defaults to 'unknown'). */
  modelId?: string;
  /** Modalities used in the latest context window (Requirement 23.4). */
  modalitiesUsed?: ('audio' | 'screen' | 'knowledge' | 'memory')[];
  /** Citation info for knowledge/memory chips (Requirements 5.5, 24.2). */
  citations?: CitationInfo[];
  /** Optional handler for citation chip clicks (e.g., navigate to meeting detail). */
  onCitationClick?: (citation: CitationInfo) => void;
}

export function SuggestionCard({
  isLoading,
  isStreaming,
  streamingText,
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
              <Loader2 size={18} className="spinner" />
              <span>Thinking...</span>
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
