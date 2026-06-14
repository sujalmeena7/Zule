// ============================================
// Zule AI — Quick Actions Sub-Component
// ============================================

import { MODE_CONFIGS, type CopilotMode } from '../../brain/modePrompts';

interface QuickActionsProps {
  activeMode: CopilotMode;
  onModeChange: (mode: CopilotMode) => void;
}

// Bug Fix #2: Expose all 7 modes (was missing coding-interview, sales-call, behavioral-interview)
const ALL_MODES: CopilotMode[] = [
  'assist',
  'what-should-i-say',
  'follow-up',
  'recap',
  'coding-interview',
  'sales-call',
  'behavioral-interview',
];

export function QuickActions({
  activeMode,
  onModeChange,
}: QuickActionsProps) {
  return (
    <div className="card-quick-actions" role="radiogroup" aria-label="Copilot mode">
      {ALL_MODES.map((mode) => (
        <button
          key={mode}
          className={`quick-action ${activeMode === mode ? 'active' : ''}`}
          onClick={() => onModeChange(mode)}
          role="radio"
          aria-checked={activeMode === mode}
        >
          <span className="qa-icon">{MODE_CONFIGS[mode].icon}</span>
          <span className="qa-label">{MODE_CONFIGS[mode].label}</span>
        </button>
      ))}
    </div>
  );
}
