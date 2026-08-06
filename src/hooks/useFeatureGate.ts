// ============================================
// Zule AI — useFeatureGate Hook
// ============================================
// Checks if a specific feature is available on the current
// subscription plan. Returns gate status + upgrade info.

import { useMemo } from 'react';
import { useSubscription } from '../context/SubscriptionContext';
import {
  type GatedFeature,
  type SubscriptionPlan,
  getMinimumPlan,
  getPlanConfig,
} from '../types/subscription';

export interface FeatureGateResult {
  /** Whether the feature is allowed on the current plan. */
  allowed: boolean;
  /** The user's current plan. */
  currentPlan: SubscriptionPlan;
  /** The minimum plan required for this feature (null if no plan includes it). */
  requiredPlan: SubscriptionPlan | null;
  /** Whether an upgrade is needed. */
  upgradeRequired: boolean;
  /** Human-readable label for the required plan. */
  requiredPlanLabel: string;
}

/**
 * Hook that checks if a gated feature is available on the current plan.
 *
 * @example
 * ```tsx
 * const { allowed, upgradeRequired, requiredPlanLabel } = useFeatureGate('export.transcripts');
 * if (!allowed) return <UpgradePrompt plan={requiredPlanLabel} />;
 * ```
 */
export function useFeatureGate(feature: GatedFeature): FeatureGateResult {
  const { plan, isFeatureAvailable } = useSubscription();

  return useMemo(() => {
    const allowed = isFeatureAvailable(feature);
    const requiredPlan = getMinimumPlan(feature);
    const requiredPlanLabel = requiredPlan ? getPlanConfig(requiredPlan).name : 'N/A';

    return {
      allowed,
      currentPlan: plan,
      requiredPlan,
      upgradeRequired: !allowed && requiredPlan !== null,
      requiredPlanLabel,
    };
  }, [plan, feature, isFeatureAvailable]);
}
