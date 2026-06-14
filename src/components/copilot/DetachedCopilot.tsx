import { useEffect, useRef } from 'react';
import { useCrossWindowSync } from '../../hooks/useCrossWindowSync';
import { TranscriptPanel } from './TranscriptPanel';
import { SuggestionCard } from './SuggestionCard';
import { CoachingBar } from './CoachingBar';


export function DetachedCopilot() {
  const { state, broadcastAction } = useCrossWindowSync('client');
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.transcript, state.interimText]);

  if (!state.activeMode) {
    return (
      <div className="copilot-workspace">
        <div className="copilot-main">
          <div className="empty-state">
            <p>Waiting for host connection...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="copilot-workspace">
      <div className="copilot-main">
        {/* Transcript Panel */}
        <TranscriptPanel
          transcript={state.transcript || []}
          interimText={state.interimText || ''}
          transcriptEndRef={transcriptEndRef}
        />

        {/* AI Suggestion Panel */}
        <SuggestionCard
          isLoading={state.isLoading || false}
          isStreaming={state.isStreaming || false}
          streamingText={state.streamingText || ''}
          aiResponse={state.aiResponse}
          onTriggerAI={(query) => broadcastAction('TRIGGER_AI', query)}
        />
      </div>

      {/* Coaching Sidebar */}
      <div className="copilot-sidebar">
        <CoachingBar
          coaching={state.coaching}
          elapsedTime={state.elapsedTime || 0}

          onClose={() => {}}
        />
      </div>
    </div>
  );
}
