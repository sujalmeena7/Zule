// ============================================
// Zule AI — Coaching Bar Sub-Component
// ============================================

import type { SentimentResult } from '../../brain/sentimentAnalyzer';

interface CoachingBarProps {
  coaching: SentimentResult | null;
  elapsedTime: number;
  onClose: () => void;
}

export function CoachingBar({
  coaching,
  elapsedTime,
  onClose,
}: CoachingBarProps) {
  if (!coaching || elapsedTime <= 5) return null;

  return (
    <div className="card-coaching" aria-live="polite" aria-label="Speech coaching metrics">
      <div className="coaching-item">
        <span className="coaching-label">Fillers</span>
        <span className={`coaching-value ${coaching.fillerCount > 10 ? 'bad' : coaching.fillerCount > 5 ? 'warn' : 'good'}`}>
          {coaching.fillerCount}
        </span>
      </div>
      <div className="coaching-divider" />
      <div className="coaching-item">
        <span className="coaching-label">Pace</span>
        <span className={`coaching-value ${coaching.wordsPerMinute > 180 ? 'bad' : coaching.wordsPerMinute < 90 ? 'warn' : 'good'}`}>
          {coaching.wordsPerMinute} wpm
        </span>
      </div>
      <div className="coaching-divider" />
      <div className="coaching-item">
        <span className="coaching-label">Confidence</span>
        <span className={`coaching-value ${coaching.confidenceScore < 50 ? 'bad' : coaching.confidenceScore < 75 ? 'warn' : 'good'}`}>
          {coaching.confidenceScore}/100
        </span>
      </div>
      <button className="coaching-close" onClick={onClose} aria-label="Close coaching bar">×</button>
    </div>
  );
}
