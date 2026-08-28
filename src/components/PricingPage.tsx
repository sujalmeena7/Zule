// ============================================
// Zule AI — Pricing Page
// ============================================
// Beautiful pricing page with three tier cards,
// monthly/annual toggle, and Razorpay checkout CTA.
// For paid users, shows a subscription management panel.

import { useState } from 'react';
import { ArrowLeft, Check, X, Sparkles, CreditCard, Calendar, ShieldCheck, ExternalLink, Zap, Crown, Gift } from 'lucide-react';
import { useSubscription } from '../context/SubscriptionContext';
import { useZule } from '../context/ZuleContext';
import {
  type SubscriptionPlan,
  type BillingInterval,
  PLAN_CONFIGS,
} from '../types/subscription';
import './PricingPage.css';

// --- Feature list for each tier ---

interface FeatureItem {
  text: string;
  included: boolean;
  highlight?: boolean;
}

const FREE_FEATURES: FeatureItem[] = [
  { text: 'Stealth overlay (undetectable!)', included: true, highlight: true },
  { text: '3 meetings/day (30 min each)', included: true },
  { text: '20 AI responses/day', included: true },
  { text: 'Assist & Recap modes', included: true },
  { text: '3 Knowledge Base documents', included: true },
  { text: '7-day meeting history', included: true },
  { text: 'Flash AI model', included: true },
  { text: 'Export transcripts', included: false },
  { text: 'Coaching metrics', included: false },
  { text: 'Custom copilot modes', included: false },
];

const PRO_FEATURES: FeatureItem[] = [
  { text: 'Stealth overlay (undetectable!)', included: true, highlight: true },
  { text: 'Unlimited meetings & duration', included: true, highlight: true },
  { text: 'Unlimited AI responses', included: true, highlight: true },
  { text: 'All 7 copilot modes', included: true },
  { text: '50 Knowledge Base documents', included: true },
  { text: '90-day meeting history', included: true },
  { text: 'Flash + Pro AI models', included: true },
  { text: 'Export transcripts (MD, TXT, PDF)', included: true },
  { text: 'Coaching metrics & analytics', included: true },
  { text: 'Up to 5 custom copilot modes', included: true },
  { text: 'Bring your own API keys', included: true },
  { text: 'Priority email support', included: true },
];

const ULTRA_FEATURES: FeatureItem[] = [
  { text: 'Everything in Pro', included: true, highlight: true },
  { text: 'Unlimited Knowledge Base', included: true, highlight: true },
  { text: 'Unlimited meeting history', included: true, highlight: true },
  { text: 'Unlimited custom modes', included: true },
  { text: 'Multi-language transcription', included: true },
  { text: 'Speaker diarization', included: true },
  { text: 'Real-time translation', included: true },
  { text: 'Local Ollama model support', included: true },
  { text: 'Advanced analytics dashboard', included: true },
  { text: 'Team sharing & collaboration', included: true },
  { text: 'API & webhook access', included: true },
  { text: 'Early access to new features', included: true },
];

const TIER_FEATURES: Record<SubscriptionPlan, FeatureItem[]> = {
  free: FREE_FEATURES,
  pro: PRO_FEATURES,
  ultra: ULTRA_FEATURES,
};

const TIER_ICONS: Record<SubscriptionPlan, typeof Zap> = {
  free: Gift,
  pro: Zap,
  ultra: Crown,
};

// --- Subscription Management Panel (for paid users) ---

function SubscriptionManagementPanel() {
  const { plan, status, billingInterval, currentPeriodEnd, cancelAtPeriodEnd } = useSubscription();
  const config = PLAN_CONFIGS[plan];
  const PlanIcon = plan === 'ultra' ? Crown : Zap;

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'N/A';
    try {
      return new Date(dateStr).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  const getStatusTone = (): 'good' | 'bad' | 'warn' => {
    if (cancelAtPeriodEnd) return 'warn';
    switch (status) {
      case 'active':
      case 'authenticated':
        return 'good';
      case 'cancelled':
      case 'expired':
        return 'bad';
      default:
        return 'warn';
    }
  };

  const getStatusLabel = () => {
    if (cancelAtPeriodEnd) return 'Cancels at period end';
    switch (status) {
      case 'active':
      case 'authenticated':
        return 'Active';
      case 'cancelled':
        return 'Cancelled';
      case 'past_due':
        return 'Past due';
      default:
        return status;
    }
  };

  const price = billingInterval === 'annual' ? config.priceAnnual : config.priceMonthly;
  const statusTone = getStatusTone();

  return (
    <div className="sub-mgmt-panel">
      <div className="sub-mgmt-content">
        {/* Plan info header */}
        <div className="sub-mgmt-header">
          <div className={`sub-mgmt-plan-icon-wrapper ${plan === 'ultra' ? 'ultra' : ''}`}>
            <PlanIcon size={22} strokeWidth={1.75} />
          </div>
          <div className="sub-mgmt-plan-info">
            <div className="sub-mgmt-plan-name-row">
              <h2 className="sub-mgmt-plan-name">{config.name}</h2>
              <span className={`sub-mgmt-status-badge tone-${statusTone}`}>
                <span className="sub-mgmt-status-dot" />
                {getStatusLabel()}
              </span>
            </div>
            <p className="sub-mgmt-plan-tagline">{config.tagline}</p>
          </div>
        </div>

        {/* Details grid */}
        <div className="sub-mgmt-details-grid">
          <div className="sub-mgmt-detail-card">
            <CreditCard size={16} className="sub-mgmt-detail-icon" strokeWidth={1.75} />
            <div className="sub-mgmt-detail-text">
              <span className="sub-mgmt-detail-label">Current price</span>
              <span className="sub-mgmt-detail-value">₹{price.toLocaleString('en-IN')}<span className="sub-mgmt-detail-unit">/mo</span></span>
            </div>
          </div>

          <div className="sub-mgmt-detail-card">
            <Calendar size={16} className="sub-mgmt-detail-icon" strokeWidth={1.75} />
            <div className="sub-mgmt-detail-text">
              <span className="sub-mgmt-detail-label">Billing cycle</span>
              <span className="sub-mgmt-detail-value sub-mgmt-capitalize">{billingInterval || 'Monthly'}</span>
            </div>
          </div>

          <div className="sub-mgmt-detail-card">
            <Calendar size={16} className="sub-mgmt-detail-icon" strokeWidth={1.75} />
            <div className="sub-mgmt-detail-text">
              <span className="sub-mgmt-detail-label">Next billing date</span>
              <span className="sub-mgmt-detail-value">{formatDate(currentPeriodEnd)}</span>
            </div>
          </div>

          <div className="sub-mgmt-detail-card">
            <ShieldCheck size={16} className="sub-mgmt-detail-icon" strokeWidth={1.75} />
            <div className="sub-mgmt-detail-text">
              <span className="sub-mgmt-detail-label">Plan features</span>
              <span className="sub-mgmt-detail-value">{TIER_FEATURES[plan].filter(f => f.included).length} included</span>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="sub-mgmt-actions">
          {plan === 'pro' && (
            <button
              className="sub-mgmt-action-btn sub-mgmt-upgrade-btn"
              onClick={() => {
                const el = document.getElementById('pricing-cards-section');
                el?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              <Crown size={15} strokeWidth={1.75} />
              Upgrade to Ultra
            </button>
          )}
          <button
            className="sub-mgmt-action-btn sub-mgmt-invoice-btn"
            onClick={() => {
              // Open Razorpay subscription management portal
              // Usually handled by customer portal link. We'll use a generic support link for this example or if you have a specific portal URL you can put it here.
              // For Razorpay, merchants typically create a customer portal link or handle it via API.
              // If you don't have a direct portal link, this button can just say "Contact Support to Manage" or point to a specific route.
              // For now, we'll open the external URL if it exists, or just alert.
              if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
                // If you have a specific Razorpay Hosted Page URL or Customer Portal URL, put it here.
                // For this demo, let's just show an alert or open a dummy URL.
                 window.alert("To cancel or modify your payment method, please contact support or check your email for the Razorpay subscription link.");
              }
            }}
          >
            <ExternalLink size={14} strokeWidth={1.75} />
            Manage billing
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Main Pricing Page ---

export function PricingPage() {
  const { plan: currentPlan, upgradeTo } = useSubscription();
  const { actions } = useZule();
  const [interval, setInterval] = useState<BillingInterval>('monthly');
  const [isUpgrading, setIsUpgrading] = useState<SubscriptionPlan | null>(null);



  const handleUpgrade = async (plan: SubscriptionPlan) => {
    if (plan === 'free' || plan === currentPlan) return;
    setIsUpgrading(plan);
    try {
      await upgradeTo(plan, interval);
    } finally {
      setIsUpgrading(null);
    }
  };

  const getPrice = (plan: SubscriptionPlan) => {
    const config = PLAN_CONFIGS[plan];
    return interval === 'monthly' ? config.priceMonthly : config.priceAnnual;
  };

  const getCtaLabel = (plan: SubscriptionPlan) => {
    if (plan === currentPlan) return 'Current plan';
    if (plan === 'free') return 'Downgrade';
    return 'Upgrade now';
  };

  const getCtaClass = (plan: SubscriptionPlan) => {
    if (plan === currentPlan) return 'current';
    if (plan === 'pro') return 'primary';
    if (plan === 'ultra') return 'primary';
    return 'secondary';
  };

  const tiers: SubscriptionPlan[] = ['free', 'pro', 'ultra'];
  const isPaidUser = currentPlan !== 'free';

  return (
    <div className="pricing-page">
      {/* Back button */}
      <button
        className="pricing-back-btn"
        onClick={() => actions.navigateTo('settings')}
      >
        <ArrowLeft size={16} />
        Back
      </button>

      {/* Subscription Management Panel (paid users only) */}
      {isPaidUser && <SubscriptionManagementPanel />}

      {/* Header */}
      <header className="pricing-header" style={isPaidUser ? { marginTop: 32 } : undefined}>
        <div className="pricing-badge">
          <Sparkles size={14} />
          {isPaidUser ? 'Manage your plan' : 'Simple pricing'}
        </div>
        <h1 className="pricing-title">
          {isPaidUser ? (
            <>Compare <span className="gradient-text">plans</span></>
          ) : (
            <>Choose your <span className="gradient-text">superpower</span></>
          )}
        </h1>
        <p className="pricing-subtitle">
          {isPaidUser
            ? 'View your current features or upgrade to unlock more power.'
            : 'All plans include the stealth overlay that competitors charge ₹12,000/mo for. Start free, upgrade when you need more.'}
        </p>
      </header>

      {/* Billing toggle */}
      <div className="billing-toggle-container">
        <button
          type="button"
          className={`billing-toggle-btn ${interval === 'monthly' ? 'active' : ''}`}
          onClick={() => setInterval('monthly')}
        >
          Monthly
        </button>
        <button
          type="button"
          className={`billing-toggle-btn ${interval === 'annual' ? 'active' : ''}`}
          onClick={() => setInterval('annual')}
        >
          Annual
          <span className="billing-save-badge">SAVE 20%</span>
        </button>
      </div>

      {/* Tier cards */}
      <div className="pricing-cards" id="pricing-cards-section">
        {tiers.map(tier => {
          const config = PLAN_CONFIGS[tier];
          const price = getPrice(tier);
          const features = TIER_FEATURES[tier];
          const isFeatured = tier === 'pro';
          const TierIcon = TIER_ICONS[tier];

          return (
            <div
              key={tier}
              className={`pricing-card ${isFeatured ? 'featured' : ''} ${tier === currentPlan ? 'current-plan' : ''}`}
            >
              {isFeatured && (
                <div className="pricing-card-popular">Most Popular</div>
              )}

              {tier === currentPlan && (
                <div className="pricing-card-current-badge">Your Plan</div>
              )}

              <div className={`pricing-card-icon ${tier}`}>
                <TierIcon size={20} strokeWidth={1.75} />
              </div>
              <h2 className="pricing-card-name">{config.name}</h2>
              <p className="pricing-card-tagline">{config.tagline}</p>

              <div className="pricing-card-price">
                <span className="pricing-card-currency">₹</span>
                <span className="pricing-card-amount">
                  {price === 0 ? '0' : price.toLocaleString('en-IN')}
                </span>
                {price > 0 && <span className="pricing-card-period">/mo</span>}
              </div>

              <p className="pricing-card-annual-note">
                {tier !== 'free' && interval === 'annual' ? (
                  <>
                    <span className="strikethrough">
                      ₹{config.priceMonthly.toLocaleString('en-IN')}/mo
                    </span>
                    billed annually at ₹{Math.round(config.priceAnnual * 12).toLocaleString('en-IN')}
                  </>
                ) : tier !== 'free' ? (
                  'billed monthly'
                ) : (
                  'Free forever'
                )}
              </p>

              <div className="tier-footer" style={{ marginTop: 'auto' }}>
                <button
                  className={`pricing-card-cta ${getCtaClass(tier)}`}
                  onClick={() => handleUpgrade(tier)}
                  disabled={tier === currentPlan || isUpgrading !== null}
                  style={isUpgrading === tier ? { opacity: 0.7, cursor: 'wait' } : {}}
                >
                  {isUpgrading === tier ? 'Processing...' : getCtaLabel(tier)}
                </button>
              </div>

              <ul className="pricing-card-features">
                {features.map((f, i) => (
                  <li
                    key={i}
                    className={`pricing-card-feature ${!f.included ? 'disabled' : ''}`}
                  >
                    {f.included ? (
                      <Check size={14} className="check" />
                    ) : (
                      <X size={14} className="cross" />
                    )}
                    <span className={f.highlight ? 'feature-highlight' : ''}>
                      {f.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {/* Comparison banner */}
      <div className="pricing-comparison">
        <div className="pricing-comparison-badge">
          <ShieldCheck size={14} />
          <span>Stealth Advantage</span>
        </div>
        <h3 className="pricing-comparison-title">
          Why choose Zule over Cluely?
        </h3>
        <p className="pricing-comparison-text">
          Competitors charge up to <span className="highlight">$149.99/mo</span> for their
          stealth overlay. We include it <span className="highlight">free on every plan</span>.
          Our Pro plan gives you more real-time assistance and intelligence at a fraction of the price.
          That's up to <span className="highlight">87% cheaper</span> with zero compromise on privacy.
        </p>
      </div>
    </div>
  );
}

