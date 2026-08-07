// ============================================
// Zule AI — Subscription Context
// ============================================
// Provides subscription state across the app. Reads from
// Firestore on mount, caches locally in IndexedDB for
// offline use, and re-validates every 6 hours.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { useAuth } from '../firebase/AuthContext';
import {
  type SubscriptionPlan,
  type SubscriptionStatus,
  type BillingInterval,
  type DailyUsage,
  type PlanLimits,
  type GatedFeature,
  isFeatureAvailable as checkFeature,
  getPlanLimits,
} from '../types/subscription';
import { database } from '../data/database';

// --- Revalidation interval: 6 hours ---
const REVALIDATION_MS = 6 * 60 * 60 * 1000;

/**
 * Deployed backend used by packaged builds. Kept in sync with the origin
 * allow-list in `api/createRazorpaySubscription.ts` and the expected
 * renderer origin in `electron/main.ts`.
 */
const PRODUCTION_API_URL = 'https://zuleai.vercel.app';

// --- Today's date in YYYY-MM-DD ---
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// --- Context shape ---

export interface SubscriptionContextType {
  /** Current plan tier. */
  plan: SubscriptionPlan;
  /** Subscription lifecycle status. */
  status: SubscriptionStatus;
  /** Billing interval (monthly/annual), null for free. */
  billingInterval: BillingInterval | null;
  /** End of current billing period, null for free. */
  currentPeriodEnd: string | null;
  /** Whether the user has scheduled cancellation at period end. */
  cancelAtPeriodEnd: boolean;
  /** Whether subscription data is still loading. */
  loading: boolean;
  /** Plan limits for the current tier. */
  limits: PlanLimits;
  /** Today's usage counters. */
  usage: DailyUsage;
  /** Check if a specific feature is available. */
  isFeatureAvailable: (feature: GatedFeature) => boolean;
  /** Check if a numeric limit has been reached. */
  isLimitReached: (limitKey: keyof PlanLimits) => boolean;
  /** Increment a usage counter (meetings or AI responses). */
  incrementUsage: (counter: 'meetingCount' | 'aiResponseCount') => void;
  /** Open Razorpay checkout for a plan upgrade. */
  upgradeTo: (plan: SubscriptionPlan, interval: BillingInterval) => Promise<void>;
  /** Force re-fetch subscription status from Firestore. */
  refresh: () => Promise<void>;
}

const SubscriptionContext = createContext<SubscriptionContextType | null>(null);

// --- Provider ---

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [plan, setPlan] = useState<SubscriptionPlan>('free');
  const [status, setStatus] = useState<SubscriptionStatus>('active');
  const [billingInterval, setBillingInterval] = useState<BillingInterval | null>(null);
  const [currentPeriodEnd, setCurrentPeriodEnd] = useState<string | null>(null);
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [usage, setUsage] = useState<DailyUsage>({ date: todayKey(), meetingCount: 0, aiResponseCount: 0 });

  const revalidateTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const limits = getPlanLimits(plan);

  // --- Fetch subscription from Firestore (or cache) ---
  const fetchSubscription = useCallback(async () => {
    if (!user) {
      setPlan('free');
      setStatus('active');
      setBillingInterval(null);
      setCurrentPeriodEnd(null);
      setCancelAtPeriodEnd(false);
      setLoading(false);
      return;
    }

    try {
      // Try to read from local cache first (IndexedDB via database helper)
      const cached = await database.getSetting<{
        plan: SubscriptionPlan;
        status: SubscriptionStatus;
        billingInterval: BillingInterval | null;
        currentPeriodEnd: string | null;
        cancelAtPeriodEnd: boolean;
        cachedAt: number;
      }>('subscription_cache', null as never);

      if (cached && Date.now() - cached.cachedAt < REVALIDATION_MS) {
        setPlan(cached.plan);
        setStatus(cached.status);
        setBillingInterval(cached.billingInterval);
        setCurrentPeriodEnd(cached.currentPeriodEnd);
        setCancelAtPeriodEnd(cached.cancelAtPeriodEnd);
        setLoading(false);
        // Still fetch from Firestore in background to ensure freshness
      }

      // Fetch from Firestore
      // Uses the Firebase SDK's getDoc. We dynamically import to avoid
      // pulling Firestore into the initial bundle.
      const { getFirestore, doc, getDoc } = await import('firebase/firestore');
      const { default: app } = await import('../firebase/config');
      const db = getFirestore(app);
      const subDoc = await getDoc(doc(db, 'users', user.uid, 'subscription', 'current'));

      if (subDoc.exists()) {
        const data = subDoc.data();
        const fetchedPlan = (['free', 'pro', 'ultra'].includes(data.plan) ? data.plan : 'free') as SubscriptionPlan;

        // Check if subscription is actually active
        const isActive = data.status === 'active' || data.status === 'authenticated';
        const effectivePlan = isActive ? fetchedPlan : 'free';

        setPlan(effectivePlan);
        setStatus(data.status ?? 'active');
        setBillingInterval(data.billingInterval ?? null);
        setCurrentPeriodEnd(data.currentPeriodEnd ?? null);
        setCancelAtPeriodEnd(data.cancelAtPeriodEnd ?? false);

        // Cache locally
        await database.setSetting('subscription_cache', {
          plan: effectivePlan,
          status: data.status ?? 'active',
          billingInterval: data.billingInterval ?? null,
          currentPeriodEnd: data.currentPeriodEnd ?? null,
          cancelAtPeriodEnd: data.cancelAtPeriodEnd ?? false,
          cachedAt: Date.now(),
        });
      } else {
        // No subscription doc — user is on free tier
        setPlan('free');
        setStatus('active');
      }
    } catch (err) {
      console.warn('[SubscriptionContext] Failed to fetch subscription, using cached/default:', err);
      // If we already loaded from cache above, that's fine.
      // If not, we fall back to free.
    } finally {
      setLoading(false);
    }
  }, [user]);

  // --- Load usage counters ---
  const loadUsage = useCallback(async () => {
    const today = todayKey();
    try {
      const stored = await database.getSetting<DailyUsage>('daily_usage', null as never);
      if (stored && stored.date === today) {
        setUsage(stored);
      } else {
        // New day — reset counters
        const fresh: DailyUsage = { date: today, meetingCount: 0, aiResponseCount: 0 };
        await database.setSetting('daily_usage', fresh);
        setUsage(fresh);
      }
    } catch {
      setUsage({ date: today, meetingCount: 0, aiResponseCount: 0 });
    }
  }, []);

  // --- Increment usage ---
  const incrementUsage = useCallback((counter: 'meetingCount' | 'aiResponseCount') => {
    setUsage(prev => {
      const today = todayKey();
      const next: DailyUsage = prev.date === today
        ? { ...prev, [counter]: prev[counter] + 1 }
        : { date: today, meetingCount: 0, aiResponseCount: 0, [counter]: 1 };
      // Persist async — fire and forget
      void database.setSetting('daily_usage', next);
      return next;
    });
  }, []);

  // --- Feature check ---
  const isFeatureAvailable = useCallback((feature: GatedFeature) => {
    return checkFeature(plan, feature);
  }, [plan]);

  // --- Limit check ---
  const isLimitReached = useCallback((limitKey: keyof PlanLimits) => {
    const limit = limits[limitKey];
    if (!Number.isFinite(limit)) return false;
    switch (limitKey) {
      case 'meetingsPerDay':
        return usage.meetingCount >= limit;
      case 'aiResponsesPerDay':
        return usage.aiResponseCount >= limit;
      default:
        return false; // Other limits (docs, history) are checked at the component level
    }
  }, [limits, usage]);

  // --- Upgrade flow (opens Razorpay checkout) ---
  const upgradeTo = useCallback(async (targetPlan: SubscriptionPlan, interval: BillingInterval) => {
    if (!user) return;

    try {
      setLoading(true);
      // Call Vercel Serverless Function to create a Razorpay subscription
      const idToken = await user.getIdToken();

      // Resolve the backend base URL. `VITE_VERCEL_API_URL` is inlined at
      // build time from `.env`, which is gitignored — so a fresh clone or a
      // CI runner builds without it. Falling back to localhost in that case
      // shipped a release whose checkout silently failed against a dev
      // server that users never run, so production defaults to the
      // deployed API and only dev falls back to localhost.
      const apiUrl = import.meta.env.VITE_VERCEL_API_URL
        || (import.meta.env.DEV ? 'http://localhost:3000' : PRODUCTION_API_URL);

      const response = await fetch(`${apiUrl}/api/createRazorpaySubscription`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({ plan: targetPlan, interval })
      });

      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({}));
        const detailedMsg = errorJson.error
          ? errorJson.error
          : `Backend API at ${apiUrl} returned HTTP ${response.status}. Please check Vercel Environment Variables for Razorpay/Firebase.`;
        throw new Error(detailedMsg);
      }

      const result = await response.json();

      // Open Razorpay checkout URL in system browser (Electron)
      if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
        await window.electronAPI.openExternal(result.shortUrl);
      } else {
        window.open(result.shortUrl, '_blank');
      }

      // Start polling Firestore for subscription changes.
      // When the webhook processes the payment, the subscription doc will update.
      // We poll every 5s for up to 5 minutes, then bring the window back.
      const pollInterval = 5000;
      const maxPolls = 60; // 5 minutes
      let pollCount = 0;

      const poller = setInterval(async () => {
        pollCount++;
        try {
          const { getFirestore, doc, getDoc } = await import('firebase/firestore');
          const { default: app } = await import('../firebase/config');
          const db = getFirestore(app);
          const subDoc = await getDoc(doc(db, 'users', user.uid, 'subscription', 'current'));

          if (subDoc.exists()) {
            const data = subDoc.data();
            const isActive = data.status === 'active' || data.status === 'authenticated';
            if (isActive && data.plan && data.plan !== 'free') {
              // Payment succeeded! Update state immediately
              clearInterval(poller);
              const fetchedPlan = (['free', 'pro', 'ultra'].includes(data.plan) ? data.plan : 'free') as SubscriptionPlan;
              setPlan(fetchedPlan);
              setStatus(data.status ?? 'active');
              setBillingInterval(data.billingInterval ?? data.interval ?? interval);
              setCurrentPeriodEnd(data.currentPeriodEnd ?? null);
              setCancelAtPeriodEnd(data.cancelAtPeriodEnd ?? false);

              // Cache locally
              await database.setSetting('subscription_cache', {
                plan: fetchedPlan,
                status: data.status ?? 'active',
                billingInterval: data.billingInterval ?? data.interval ?? interval,
                currentPeriodEnd: data.currentPeriodEnd ?? null,
                cancelAtPeriodEnd: data.cancelAtPeriodEnd ?? false,
                cachedAt: Date.now(),
              });

              // Bring the Electron window back to the foreground
              if (window.electronAPI?.focusWindow) {
                await window.electronAPI.focusWindow();
              }
            }
          }
        } catch (err) {
          console.warn('[SubscriptionContext] Poll error:', err);
        }

        if (pollCount >= maxPolls) {
          clearInterval(poller);
        }
      }, pollInterval);
    } catch (err: any) {
      console.error('[SubscriptionContext] Upgrade flow error:', err);
      if (typeof window !== 'undefined' && window.alert) {
        const msg = err instanceof Error ? err.message : 'Unable to initialize payment checkout.';
        window.alert(`Checkout error: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  }, [user, fetchSubscription]);

  // --- Refresh ---
  const refresh = useCallback(async () => {
    setLoading(true);
    await fetchSubscription();
  }, [fetchSubscription]);

  // --- Effects ---

  // Fetch on mount and when user changes
  useEffect(() => {
    void fetchSubscription();
    void loadUsage();
  }, [fetchSubscription, loadUsage]);

  // Revalidate on focus
  useEffect(() => {
    const handleFocus = () => void fetchSubscription();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [fetchSubscription]);

  // Periodic revalidation
  useEffect(() => {
    revalidateTimerRef.current = setInterval(() => {
      void fetchSubscription();
    }, REVALIDATION_MS);
    return () => {
      if (revalidateTimerRef.current) clearInterval(revalidateTimerRef.current);
    };
  }, [fetchSubscription]);

  return (
    <SubscriptionContext.Provider
      value={{
        plan,
        status,
        billingInterval,
        currentPeriodEnd,
        cancelAtPeriodEnd,
        loading,
        limits,
        usage,
        isFeatureAvailable,
        isLimitReached,
        incrementUsage,
        upgradeTo,
        refresh,
      }}
    >
      {children}
    </SubscriptionContext.Provider>
  );
}

// --- Hook ---

export function useSubscription(): SubscriptionContextType {
  const ctx = useContext(SubscriptionContext);
  if (!ctx) throw new Error('useSubscription must be used within SubscriptionProvider');
  return ctx;
}
