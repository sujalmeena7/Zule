// ============================================
// Zule AI — Transcript Panel Sub-Component
// ============================================

import type { RefObject } from 'react';
import type { TranscriptionLine } from '../../types/transcription';
import { speakerManager } from '../../brain/speakerManager';

interface TranscriptPanelProps {
  transcript: TranscriptionLine[];
  interimText: string;
  transcriptEndRef: RefObject<HTMLDivElement | null>;
}

export function TranscriptPanel({
  transcript,
  interimText,
  transcriptEndRef,
}: TranscriptPanelProps) {
  if (transcript.length === 0) return null;

  return (
    <div className="card-transcript" role="status" aria-label="Live transcript" aria-live="polite">
      {transcript.slice(-5).map(line => {
        const speaker = speakerManager.getSpeaker(line.speakerId);
        return (
          <div key={line.id} className="transcript-line animate-fade-in" style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', marginBottom: '8px' }}>
            <div 
              style={{ 
                width: '20px', height: '20px', borderRadius: '50%', background: speaker.color, 
                display: 'flex', alignItems: 'center', justifyContent: 'center', 
                fontSize: '10px', fontWeight: 'bold', color: 'white', flexShrink: 0
              }}
            >
              {speaker.avatarInitial}
            </div>
            <span className="transcript-text" style={{ flex: 1 }}>{line.text}</span>
          </div>
        );
      })}
      {interimText && (
        <div className="transcript-line interim" style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', marginBottom: '8px' }}>
          <div 
            style={{ 
              width: '20px', height: '20px', borderRadius: '50%', background: 'var(--border-color)', 
              display: 'flex', alignItems: 'center', justifyContent: 'center', 
              fontSize: '10px', fontWeight: 'bold', color: 'var(--text-secondary)', flexShrink: 0
            }}
          >
            ...
          </div>
          <span className="transcript-text" style={{ flex: 1 }}>{interimText}</span>
        </div>
      )}
      <div ref={transcriptEndRef} />
    </div>
  );
}
