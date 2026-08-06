// ============================================
// Zule AI — Quick Actions Sub-Component
// ============================================

import { Lock } from 'lucide-react';
import { MODE_CONFIGS, type CopilotMode } from '../../brain/modePrompts';
import type { GatedFeature } from '../../types/subscription';

interface QuickActionsProps {
  activeMode: CopilotMode;
  onModeChange: (mode: CopilotMode) => void;
  isFeatureAvailable: (feature: GatedFeature) => boolean;
  onLockedModeClick: (feature: GatedFeature) => void;
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
  isFeatureAvailable,
  onLockedModeClick,
}: QuickActionsProps) {
  return (
    <div className="card-quick-actions" role="radiogroup" aria-label="Copilot mode">
      {ALL_MODES.map((mode) => {
        const featureKey = `copilot.mode.${mode}` as GatedFeature;
        // 'assist' and 'recap' are free, others might be gated
        const isLocked = !isFeatureAvailable(featureKey);

        return (
          <button
            key={mode}
            className={`quick-action ${activeMode === mode ? 'active' : ''} ${isLocked ? 'locked' : ''}`}
            onClick={() => isLocked ? onLockedModeClick(featureKey) : onModeChange(mode)}
            role="radio"
            aria-checked={activeMode === mode}
          >
            <span className="qa-icon">{MODE_CONFIGS[mode].icon}</span>
            <span className="qa-label">
              {MODE_CONFIGS[mode].label}
              {isLocked && <Lock size={10} style={{ marginLeft: 4, opacity: 0.6 }} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
