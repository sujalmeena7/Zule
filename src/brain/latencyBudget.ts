// ============================================
// Zule AI — Latency_Budget (design §13)
// ============================================
//
// Records t_detected, t_request_sent, t_first_token, t_complete
// timestamps per autonomous trigger. Cache hits flow into a separate
// metric stream so they do not mask provider regressions.
//
// When TTFT exceeds the configured budget for two consecutive
// non-cache requests, emits `latency.degraded` via the onDegraded
// callback.
//
// Acceptance criteria covered:
//   - 14.1 — Default TTFT budget of 1500 ms and total budget of 4000 ms
//   - 14.2 — Records t_detected, t_request_sent, t_first_token, t_complete
//   - 14.3 — Two consecutive over-budget TTFTs emit latency.degraded
//   - 14.4 — Cache hits flow into a separate stream (zero-latency)

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface LatencyBudgetConfig {
  /** Target time-to-first-token in milliseconds (default 1500). */
  ttftBudgetMs?: number;
  /** Target total streaming completion time in milliseconds (default 4000). */
  totalBudgetMs?: number;
  /** Called when two consecutive non-cache TTFTs exceed the budget. */
  onDegraded?: () => void;
}

export interface LatencySample {
  tDetected: number;
  tRequestSent: number;
  tFirstToken: number;
  tComplete: number;
  fromCache: boolean;
}

/** A recorded TTFT value from a non-cache sample. */
export interface TTFTSample {
  ttft: number;
  total: number;
  overBudget: boolean;
  timestamp: number;
}

/** A recorded cache-hit event. */
export interface CacheHitSample {
  timestamp: number;
}

// ---------------------------------------------------------------------
// LatencyBudget
// ---------------------------------------------------------------------

export class LatencyBudget {
  private readonly ttftBudgetMs: number;
  private readonly totalBudgetMs: number;
  private readonly onDegraded?: () => void;

  /** Non-cache TTFT samples. */
  private ttftSamples: TTFTSample[] = [];

  /** Cache-hit events (zero-latency). */
  private cacheHitSamples: CacheHitSample[] = [];

  /** Number of consecutive over-budget non-cache TTFTs. */
  private consecutiveOverBudget = 0;

  /** Whether the degraded state has been entered. */
  private degraded = false;

  constructor(config?: LatencyBudgetConfig) {
    this.ttftBudgetMs = config?.ttftBudgetMs ?? 1500;
    this.totalBudgetMs = config?.totalBudgetMs ?? 4000;
    this.onDegraded = config?.onDegraded;
  }

  /**
   * Record a latency sample. Routes to the appropriate stream based
   * on `fromCache`.
   *
   * - Cache hits go to the cache-hit stream (zero-latency events)
   * - Non-cache samples compute TTFT and are checked against the budget
   */
  recordSample(sample: LatencySample): void {
    if (sample.fromCache) {
      this.cacheHitSamples.push({ timestamp: sample.tDetected });
      return;
    }

    const ttft = sample.tFirstToken - sample.tDetected;
    const total = sample.tComplete - sample.tDetected;
    const overBudget = ttft > this.ttftBudgetMs;

    this.ttftSamples.push({
      ttft,
      total,
      overBudget,
      timestamp: sample.tDetected,
    });

    if (overBudget) {
      this.consecutiveOverBudget++;
    } else {
      this.consecutiveOverBudget = 0;
      this.degraded = false;
    }

    // Emit latency.degraded when 2 consecutive over-budget
    if (this.consecutiveOverBudget >= 2 && !this.degraded) {
      this.degraded = true;
      this.onDegraded?.();
    }
  }

  /** Returns all non-cache TTFT samples. */
  getTTFTSamples(): readonly TTFTSample[] {
    return this.ttftSamples;
  }

  /** Returns all cache-hit events. */
  getCacheHitSamples(): readonly CacheHitSample[] {
    return this.cacheHitSamples;
  }

  /** Whether the system is in a degraded latency state. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  /** The configured TTFT budget. */
  get budget(): number {
    return this.ttftBudgetMs;
  }

  /** The configured total budget. */
  get totalBudget(): number {
    return this.totalBudgetMs;
  }

  /** Reset all state — clears samples and degraded flag. */
  reset(): void {
    this.ttftSamples = [];
    this.cacheHitSamples = [];
    this.consecutiveOverBudget = 0;
    this.degraded = false;
  }
}
