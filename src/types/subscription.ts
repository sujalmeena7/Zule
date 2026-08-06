// ============================================
// Zule AI — Subscription Types
// ============================================
// Type definitions for subscription tiers, feature gates,
// usage limits, and plan metadata. Used by SubscriptionContext,
// useFeatureGate, and all feature-gated UI components.

// --- Plan Tiers ---

/** The three subscription tiers. */
export type SubscriptionPlan = 'free' | 'pro' | 'ultra';

/** Subscription lifecycle status (mirrors Razorpay statuses). */
export type SubscriptionStatus =
  | 'active'
  | 'cancelled'
  | 'paused'
  | 'created'
  | 'authenticated'
  | 'expired'
  | 'pending'
  | 'past_due';

/** Billing interval for paid plans. */
export type BillingInterval = 'monthly' | 'annual';

// --- Features ---

/** Every feature that can be gated by subscription tier. */
export type GatedFeature =
  // Copilot
  | 'copilot.mode.assist'
  | 'copilot.mode.recap'
  | 'copilot.mode.what-should-i-say'
  | 'copilot.mode.follow-up'
  | 'copilot.mode.coding-interview'
  | 'copilot.mode.sales-call'
  | 'copilot.mode.behavioral-interview'
  | 'copilot.custom-modes'
  // Knowledge Base
  | 'kb.upload'
  | 'kb.unlimited-docs'
  // Transcription
  | 'transcription.unlimited'
  | 'transcription.multi-language'
  | 'transcription.speaker-diarization'
  | 'transcription.real-time-translation'
  // AI
  | 'ai.unlimited-responses'
  | 'ai.pro-models'
  | 'ai.local-models'
  | 'ai.byok'
  // Export & History
  | 'export.transcripts'
  | 'history.unlimited'
  // Analytics
  | 'coaching.metrics'
  | 'analytics.advanced'
  // Misc
  | 'team.sharing'
  | 'api.access'
  | 'support.priority'
  | 'early-access';

// --- Limits ---

/** Numeric limits that vary by plan. */
export interface PlanLimits {
  /** Max meetings per day (Infinity for unlimited). */
  meetingsPerDay: number;
  /** Max meeting duration in minutes (Infinity for unlimited). */
  meetingDurationMinutes: number;
  /** Max AI copilot responses per day (Infinity for unlimited). */
  aiResponsesPerDay: number;
  /** Max Knowledge Base documents (Infinity for unlimited). */
  kbDocuments: number;
  /** Max custom copilot modes (Infinity for unlimited). */
  customModes: number;
  /** Meeting history retention in days (Infinity for unlimited). */
  historyRetentionDays: number;
}

// --- Plan Metadata ---

/** Full metadata for a subscription plan. */
export interface PlanConfig {
  id: SubscriptionPlan;
  name: string;
  tagline: string;
  /** Monthly price in USD. 0 for free tier. */
  priceMonthly: number;
  /** Annual price per month in USD. 0 for free tier. */
  priceAnnual: number;
  features: Set<GatedFeature>;
  limits: PlanLimits;
  /** Razorpay plan ID for monthly billing. null for free tier. */
  razorpayPlanIdMonthly: string | null;
  /** Razorpay plan ID for annual billing. null for free tier. */
  razorpayPlanIdAnnual: string | null;
}

// --- Free plan copilot modes ---
const FREE_MODES: GatedFeature[] = [
  'copilot.mode.assist',
  'copilot.mode.recap',
];

// --- Pro plan copilot modes (all built-in) ---
const PRO_MODES: GatedFeature[] = [
  ...FREE_MODES,
  'copilot.mode.what-should-i-say',
  'copilot.mode.follow-up',
  'copilot.mode.coding-interview',
  'copilot.mode.sales-call',
  'copilot.mode.behavioral-interview',
];

// --- Plan configs ---

export const PLAN_CONFIGS: Record<SubscriptionPlan, PlanConfig> = {
  free: {
    id: 'free',
    name: 'Free',
    tagline: 'Get started with the basics',
    priceMonthly: 0,
    priceAnnual: 0,
    features: new Set<GatedFeature>([
      ...FREE_MODES,
      'kb.upload',
    ]),
    limits: {
      meetingsPerDay: 3,
      meetingDurationMinutes: 30,
      aiResponsesPerDay: 20,
      kbDocuments: 3,
      customModes: 0,
      historyRetentionDays: 7,
    },
    razorpayPlanIdMonthly: null,
    razorpayPlanIdAnnual: null,
  },

  pro: {
    id: 'pro',
    name: 'Pro',
    tagline: 'Unlimited power for professionals',
    priceMonthly: 1499,
    priceAnnual: 1249.17,
    features: new Set<GatedFeature>([
      ...PRO_MODES,
      'copilot.custom-modes',
      'kb.upload',
      'transcription.unlimited',
      'ai.unlimited-responses',
      'ai.pro-models',
      'ai.byok',
      'export.transcripts',
      'coaching.metrics',
      'support.priority',
    ]),
    limits: {
      meetingsPerDay: Infinity,
      meetingDurationMinutes: Infinity,
      aiResponsesPerDay: Infinity,
      kbDocuments: 50,
      customModes: 5,
      historyRetentionDays: 90,
    },
    razorpayPlanIdMonthly: null, // Set after Razorpay plan creation
    razorpayPlanIdAnnual: null,
  },

  ultra: {
    id: 'ultra',
    name: 'Ultra',
    tagline: 'Everything, unlimited, forever',
    priceMonthly: 2499,
    priceAnnual: 2082.5,
    features: new Set<GatedFeature>([
      ...PRO_MODES,
      'copilot.custom-modes',
      'kb.upload',
      'kb.unlimited-docs',
      'transcription.unlimited',
      'transcription.multi-language',
      'transcription.speaker-diarization',
      'transcription.real-time-translation',
      'ai.unlimited-responses',
      'ai.pro-models',
      'ai.local-models',
      'ai.byok',
      'export.transcripts',
      'history.unlimited',
      'coaching.metrics',
      'analytics.advanced',
      'team.sharing',
      'api.access',
      'support.priority',
      'early-access',
    ]),
    limits: {
      meetingsPerDay: Infinity,
      meetingDurationMinutes: Infinity,
      aiResponsesPerDay: Infinity,
      kbDocuments: Infinity,
      customModes: Infinity,
      historyRetentionDays: Infinity,
    },
    razorpayPlanIdMonthly: null,
    razorpayPlanIdAnnual: null,
  },
};

// --- Subscription document (Firestore shape) ---

/** The subscription document stored in Firestore at `users/{uid}/subscription`. */
export interface SubscriptionDoc {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  razorpayCustomerId: string | null;
  razorpaySubscriptionId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  billingInterval: BillingInterval | null;
  createdAt: string;
  updatedAt: string;
}

// --- Usage tracking ---

/** Daily usage counters, keyed by date string (YYYY-MM-DD). */
export interface DailyUsage {
  date: string;
  meetingCount: number;
  aiResponseCount: number;
}

// --- Helpers ---

/** Returns the PlanConfig for the given plan. */
export function getPlanConfig(plan: SubscriptionPlan): PlanConfig {
  return PLAN_CONFIGS[plan];
}

/** Checks if a feature is available on the given plan. */
export function isFeatureAvailable(plan: SubscriptionPlan, feature: GatedFeature): boolean {
  return PLAN_CONFIGS[plan].features.has(feature);
}

/** Returns the limits for the given plan. */
export function getPlanLimits(plan: SubscriptionPlan): PlanLimits {
  return PLAN_CONFIGS[plan].limits;
}

/** Returns the minimum plan required for a feature, or null if no plan includes it. */
export function getMinimumPlan(feature: GatedFeature): SubscriptionPlan | null {
  const order: SubscriptionPlan[] = ['free', 'pro', 'ultra'];
  for (const plan of order) {
    if (PLAN_CONFIGS[plan].features.has(feature)) return plan;
  }
  return null;
}

/** Human-readable plan label with emoji. */
export function getPlanLabel(plan: SubscriptionPlan): string {
  switch (plan) {
    case 'free': return '🆓 Free';
    case 'pro': return '⚡ Pro';
    case 'ultra': return '🏆 Ultra';
  }
}
