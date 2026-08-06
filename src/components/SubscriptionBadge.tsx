// ============================================
// Zule AI — Subscription Badge
// ============================================
// Small pill badge displayed in the sidebar showing the
// user's current plan. Clickable to manage subscription.

import { Zap, Crown, Sparkles } from 'lucide-react';
import { useSubscription } from '../context/SubscriptionContext';
import type { SubscriptionPlan } from '../types/subscription';

const BADGE_CONFIG: Record<SubscriptionPlan, {
  label: string;
  icon: typeof Zap;
  className: string;
}> = {
  free: { label: 'Free', icon: Sparkles, className: 'sub-badge sub-badge--free' },
  pro: { label: 'Pro', icon: Zap, className: 'sub-badge sub-badge--pro' },
  ultra: { label: 'Ultra', icon: Crown, className: 'sub-badge sub-badge--ultra' },
};

export function SubscriptionBadge() {
  const { plan } = useSubscription();
  const config = BADGE_CONFIG[plan];
  const Icon = config.icon;

  const handleClick = () => {
    window.location.hash = '#pricing';
  };

  return (
    <button
      className={config.className}
      onClick={handleClick}
      title={plan === 'free' ? 'Upgrade your plan' : 'Manage subscription'}
      style={{ cursor: 'pointer' }}
    >
      <Icon size={12} />
      <span>{config.label}</span>
      {plan === 'free' && <span className="sub-badge-upgrade">Upgrade</span>}
      {plan !== 'free' && <span className="sub-badge-upgrade">Manage</span>}
    </button>
  );
}
