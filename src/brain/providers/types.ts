// ============================================
// Zule AI — Provider adapter type entry-point
// ============================================
//
// Module-local entry-point for the canonical `ProviderAdapter` contract and
// supporting types. The authoritative definitions live in `src/types/ai.ts`
// (introduced in task 1.2); this file re-exports them so that adapter
// implementations and the `AI_Provider_Router` can import everything from a
// single neighbouring path (`./types`) and so we have a place to colocate
// provider-internal helper types that should not pollute the cross-cutting
// `src/types` namespace.
//
// See design.md §3. AI_Provider_Router and Requirements 4.1, 4.4 – 4.6.

// --- Canonical, cross-module contract types ---
export type {
  Capabilities,
  PromptInput,
  CallOpts,
  ProviderResponse,
  StreamCallbacks,
  ProviderAdapter,
  ProviderId,
} from '../../types/ai';

// --- Provider-internal helper types ---

/**
 * Discriminator for the per-request timeout budget. Streaming requests get
 * a longer budget (12 000 ms) than non-streaming completions (6 000 ms),
 * matching Requirement 4.4.
 */
export type ProviderRequestKind = 'streaming' | 'non-streaming';

/**
 * Adapter-thrown HTTP error shape. Adapters are encouraged to throw errors
 * carrying these enrichments so `retryWithJitter` and the router can classify
 * them without re-parsing the wire response.
 *
 * - `status` carries the HTTP status (used by the default retry classifier
 *   to identify 429 / 5xx as transient).
 * - `retryAfterMs` carries a parsed `Retry-After` value when present so the
 *   router can extend its backoff for rate-limited responses.
 * - `providerId` lets the router attribute failures during failover.
 */
export interface ProviderHttpError extends Error {
  providerId?: string;
  status?: number;
  retryAfterMs?: number;
}
