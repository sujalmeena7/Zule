// ============================================
// Zule AI — Upgrade Modal
// ============================================
// Shown when a free user hits a limit (e.g. 4th meeting,
// 21st AI response). Highlights what they're missing and
// offers one-click upgrade via Razorpay.

import { useCallback } from 'react';
import { X, Check, Zap } from 'lucide-react';
import { type GatedFeature, getMinimumPlan, getPlanConfig } from '../types/subscription';
import './UpgradeModal.css';

export interface UpgradeModalProps {
  /** What triggered the modal. */
  reason: 'meeting-limit' | 'ai-response-limit' | 'kb-doc-limit' | 'feature-locked';
  /** If reason is 'feature-locked', which feature? */
  feature?: GatedFeature;
  /** Custom message override. */
  message?: string;
  /** Called when the modal is dismissed. */
  onClose: () => void;
}

const REASON_CONFIG: Record<string, { icon: string; title: string; message: string; highlights: string[] }> = {
  'meeting-limit': {
    icon: '🚀',
    title: 'Meeting limit reached',
    message: "You've used all 3 free meetings today. Upgrade to Pro for unlimited meetings with no duration caps.",
    highlights: [
      'Unlimited meetings per day',
      'No duration limits',
      'All 7 copilot modes',
      'Coaching metrics & analytics',
    ],
  },
  'ai-response-limit': {
    icon: '🧠',
    title: 'AI response limit reached',
    message: "You've used all 20 free AI responses today. Upgrade to Pro for unlimited AI assistance.",
    highlights: [
      'Unlimited AI responses',
      'Access to Pro AI models',
      'Bring your own API keys',
      'Custom copilot modes',
    ],
  },
  'kb-doc-limit': {
    icon: '📚',
    title: 'Document limit reached',
    message: "You've reached the 3-document limit. Upgrade to Pro for up to 50 documents, or Ultra for unlimited.",
    highlights: [
      'Up to 50 docs (Pro) or unlimited (Ultra)',
      'Better context-aware responses',
      'Export transcripts',
      'Priority support',
    ],
  },
  'feature-locked': {
    icon: '🔒',
    title: 'Pro feature',
    message: 'This feature is available on a paid plan. Upgrade to unlock it.',
    highlights: [
      'All copilot modes unlocked',
      'Coaching metrics & analytics',
      'Export & sharing',
      'Priority support',
    ],
  },
};

export function UpgradeModal({ reason, feature, message, onClose }: UpgradeModalProps) {
  const config = REASON_CONFIG[reason] ?? REASON_CONFIG['feature-locked'];

  // If a specific feature is locked, customize the title
  const title = feature
    ? `Upgrade to ${getPlanConfig(getMinimumPlan(feature) ?? 'pro').name}`
    : config.title;

  const handleViewPricing = useCallback(() => {
    onClose();
    // Navigate to pricing page via hash
    window.location.hash = '#pricing';
  }, [onClose]);

  return (
    <div className="upgrade-modal-backdrop" onClick={onClose}>
      <div className="upgrade-modal" onClick={e => e.stopPropagation()}>
        <button className="upgrade-modal-close" onClick={onClose}>
          <X size={18} />
        </button>

        <span className="upgrade-modal-icon">{config.icon}</span>
        <h2 className="upgrade-modal-title">{title}</h2>
        <p className="upgrade-modal-message">{message ?? config.message}</p>

        <ul className="upgrade-modal-feature-list">
          {config.highlights.map((h, i) => (
            <li key={i} className="upgrade-modal-feature">
              <Check size={14} className="icon" />
              {h}
            </li>
          ))}
        </ul>

        <div className="upgrade-modal-actions">
          <button className="upgrade-modal-btn secondary" onClick={onClose}>
            Maybe later
          </button>
          <button className="upgrade-modal-btn primary" onClick={handleViewPricing}>
            <Zap size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
            View plans
          </button>
        </div>
      </div>
    </div>
  );
}
