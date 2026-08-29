// ============================================
// Zule AI — AI_Provider_Router
// ============================================
//
// Thin orchestrator that manages registered provider adapters, selects
// the appropriate model, and provides priority-ordered failover with
// abort honouring. Delegates heavy lifting (timeout, retry) to the
// shared HTTP utilities in `src/brain/providers/http.ts`.
//
// Requirements covered:
//   - 4.3 — Priority-ordered failover on transport error, 5xx, or timeout.
//   - 4.7 — AbortSignal honoured within 200 ms; onComplete never invoked
//            after abort.
//   - 15.2 — While CryptoVault is locked, refuse cloud providers and
//            surface a typed error.
//
// Design reference: design.md §3. AI_Provider_Router

import type {
  CallOpts,
  Capabilities,
  ProviderAdapter,
  ProviderResponse,
  PromptInput,
  StreamCallbacks,
} from '../types/ai';
import { selectModel, type SelectModelInput } from './modelSelector';
import { isRetryableError, isImageUnsupportedError } from './providers/http';

// --- Constants -----------------------------------------------------------

/**
 * Provider names that are allowed when the vault is locked or the
 * browser is offline. All other providers are considered "cloud" and
 * require both the vault to be unlocked and network connectivity.
 * Requirements: 15.2, 20.1.
 *
 * INVARIANT — membership is exactly `{ollama, simulation}`. Every cloud gate
 * in this router (vault-locked, offline, 429 cooldown) keys off *non*-membership
 * here, so adding a remote provider (e.g. `custom`) to this set would exempt it
 * from those gates and ship transcript content off-device while the app
 * believes it is offline. Exported so tests can pin the membership directly.
 */
export const LOCAL_PROVIDER_NAMES = new Set<string>(['ollama', 'simulation']);

/**
 * How long to skip a provider after it returns HTTP 429 (rate-limited /
 * quota-exceeded). Without this, a provider with an exhausted quota is retried
 * on every single request — wasting a full round-trip and adding latency before
 * failing over to the next provider every time. After a 429 we skip it for this
 * window so subsequent requests go straight to the next provider.
 */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

// --- Error types ---------------------------------------------------------

/**
 * Thrown when the router refuses a request because the vault is locked
 * and only cloud providers are available in the priority list.
 */
export class VaultLockedError extends Error {
  readonly code = 'VAULT_LOCKED' as const;
  constructor(providerName: string) {
    super(
      `AI_Provider_Router: cannot use cloud provider '${providerName}' while CryptoVault is locked. Unlock the vault or switch to a local provider.`,
    );
    this.name = 'VaultLockedError';
  }
}

/**
 * Thrown when the router refuses a request because the browser is offline
 * and only cloud providers are available in the priority list.
 * Requirement 20.1.
 */
export class OfflineError extends Error {
  readonly code = 'OFFLINE' as const;
  constructor(providerName: string) {
    super(
      `AI_Provider_Router: cannot use cloud provider '${providerName}' while offline. Zule will use local providers until connectivity returns.`,
    );
    this.name = 'OfflineError';
  }
}

/**
 * Thrown when all adapters in the priority list have failed (or been
 * skipped due to vault-lock). Wraps the last underlying error.
 */
export class AllProvidersFailedError extends Error {
  readonly code = 'ALL_PROVIDERS_FAILED' as const;
  readonly lastError: unknown;
  constructor(lastError: unknown) {
    const msg =
      lastError instanceof Error
        ? lastError.message
        : String(lastError);
    super(`AI_Provider_Router: all providers failed. Last error: ${msg}`);
    this.name = 'AllProvidersFailedError';
    this.lastError = lastError;
  }
}

/**
 * Thrown when a caller demanded `requireImageInput` but no registered,
 * currently-usable adapter accepts images.
 *
 * Distinct from `AllProvidersFailedError` because nothing failed — no request
 * was ever made. The condition is a configuration gap, not a transport problem,
 * and the two need different handling: a failed request may be worth retrying,
 * whereas this one will keep being true until the User adds a vision provider or
 * the caller falls back to OCR. Surfacing it as a generic failure would send the
 * caller down a retry path that cannot succeed.
 */
export class NoVisionProviderError extends Error {
  readonly code = 'NO_VISION_PROVIDER' as const;
  constructor() {
    super(
      'AI_Provider_Router: this request needs a model that can read images, but no image-capable provider is available. Add a vision provider (e.g. Gemini) or unlock the vault.',
    );
    this.name = 'NoVisionProviderError';
  }
}

/**
 * Recorded when an adapter's stream ran to completion without ever handing the
 * consumer a single character of answer.
 *
 * A fulfilled `streamGenerate` promise is not evidence that the User got an
 * answer. A stream can open, deliver nothing but metadata frames, and close —
 * and some adapters then call `onComplete` with an empty string and resolve. The
 * router used to read that as success, log `✅`, and return: no failover, no
 * error, and a card left spinning on "Thinking…" forever while the request was
 * in fact already over. An empty answer is a failure of the same practical kind
 * as a 500, so it is treated as one and the next provider gets its turn.
 *
 * Carries the mid-stream error the adapter reported through `onError`, when
 * there was one — that is usually the real cause, and it would otherwise be
 * dropped along with the empty completion.
 */
export class EmptyCompletionError extends Error {
  readonly code = 'EMPTY_COMPLETION' as const;
  readonly reportedError: unknown;
  constructor(providerName: string, reportedError?: unknown) {
    const detail =
      reportedError instanceof Error ? ` Reported: ${reportedError.message}` : '';
    super(
      `AI_Provider_Router: provider '${providerName}' completed without producing any text.${detail}`,
    );
    this.name = 'EmptyCompletionError';
    this.reportedError = reportedError;
  }
}

// --- Router class --------------------------------------------------------

export class AI_Provider_Router {
  private adapters = new Map<string, ProviderAdapter>();
  private priority: string[] = [];
  private vaultLocked = true; // Default locked — safe default per Requirement 15.2
  private offline = false; // Tracks navigator.onLine — Requirement 20.1
  // Provider name → epoch ms until which it is skipped after a 429.
  private rateLimitedUntil = new Map<string, number>();
  /**
   * Adapters that declared `capabilities.imageInput` but rejected an image at
   * runtime. A gateway advertises the adapter's capability, not the configured
   * model's, so the declaration is a claim; the first rejection is the only
   * reliable evidence available. Remembering it turns a repeated hard failure
   * into a single one followed by correct routing to another vision adapter.
   *
   * Not time-bounded like the 429 cooldown: a model that cannot read images will
   * not start being able to. Cleared when the adapter is unregistered, which is
   * what happens when the User changes the model behind it.
   */
  private imageIncapable = new Set<string>();

  /** True if `name` is currently in a post-429 cooldown window. */
  private isRateLimited(name: string): boolean {
    const until = this.rateLimitedUntil.get(name);
    if (until === undefined) return false;
    if (Date.now() >= until) {
      this.rateLimitedUntil.delete(name);
      return false;
    }
    return true;
  }

  /** Record a 429 so this provider is skipped for the cooldown window. */
  private markRateLimited(name: string): void {
    this.rateLimitedUntil.set(name, Date.now() + RATE_LIMIT_COOLDOWN_MS);
  }

  // --- Registration & configuration --------------------------------------

  /**
   * Register a provider adapter by its `adapter.name`. Overwrites any
   * existing adapter with the same name.
   */
  registerAdapter(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.name, adapter);
    // A re-registration is how a configuration change arrives (new base URL, new
    // model tag). Whatever the previous model could or could not read says
    // nothing about this one, so the runtime image verdict starts over.
    this.imageIncapable.delete(adapter.name);
  }

  /**
   * Remove an adapter so no subsequent request can be routed to it.
   * Also drops the name from the priority list and clears any post-429
   * cooldown entry, so a later re-registration starts from a clean slate.
   * Returns whether an adapter with that name was registered.
   * Requirement 1.5.
   */
  unregisterAdapter(name: string): boolean {
    const wasPresent = this.adapters.delete(name);
    this.priority = this.priority.filter((n) => n !== name);
    this.rateLimitedUntil.delete(name);
    this.imageIncapable.delete(name);
    return wasPresent;
  }

  /**
   * Set the failover priority order. Names that are not registered are
   * silently skipped during failover iteration.
   */
  setPriority(order: string[]): void {
    this.priority = [...order];
  }

  /**
   * Update the vault-lock state. When locked (`true`), the router refuses
   * any adapter whose name is not in `LOCAL_PROVIDER_NAMES`.
   */
  setVaultLocked(locked: boolean): void {
    this.vaultLocked = locked;
  }

  /**
   * Update the offline state. When offline (`true`), the router refuses
   * any adapter whose name is not in `LOCAL_PROVIDER_NAMES`, effectively
   * the same gate as vault-locked.
   * Requirement 20.1.
   */
  setOffline(offline: boolean): void {
    this.offline = offline;
  }

  /**
   * Returns the capabilities of the first usable adapter in priority order,
   * or `null` if no adapters are registered. Used to check whether the
   * active adapter supports features like image input (Requirement 23.3).
   */
  getActiveAdapterCapabilities(): Capabilities | null {
    const adapters = this.getOrderedAdapters();
    for (const adapter of adapters) {
      // Skip cloud adapters when vault is locked or offline
      if (!LOCAL_PROVIDER_NAMES.has(adapter.name)) {
        if (this.vaultLocked || this.offline) continue;
      }
      return adapter.capabilities;
    }
    return null;
  }

  /**
   * True when at least one currently-usable adapter accepts image input.
   *
   * Deliberately not the same question as `getActiveAdapterCapabilities()
   * ?.imageInput`, which reports only the *first* adapter in priority order.
   * A setup with Nemotron first and Gemini second answers "no" to that and "yes"
   * to this — and "yes" is what matters when deciding whether a screenshot can
   * be sent as pixels, because `requireImageInput` will route past the text-only
   * one. Asking the narrower question is what forced the OCR detour on setups
   * that already had a vision model configured.
   */
  hasImageCapableAdapter(): boolean {
    for (const adapter of this.getOrderedAdapters()) {
      if (!LOCAL_PROVIDER_NAMES.has(adapter.name)) {
        if (this.vaultLocked || this.offline) continue;
        if (this.isRateLimited(adapter.name)) continue;
      }
      if (this.imageIncapable.has(adapter.name)) continue;
      if (adapter.capabilities.imageInput) return true;
    }
    return false;
  }

  /**
   * The adapters that may receive an image, in priority order.
   *
   * Declared capability minus the ones that proved otherwise at runtime. Shared
   * by `stream` and `complete` so both agree on what "vision-capable" means —
   * they diverged once and the non-streaming path kept re-offering a model that
   * had already rejected images.
   */
  private eligibleForImages(adapters: ProviderAdapter[]): ProviderAdapter[] {
    return adapters.filter(
      (a) => a.capabilities.imageInput && !this.imageIncapable.has(a.name),
    );
  }

  // --- Model selection (delegates to pure helper) ------------------------

  /**
   * Delegates to `src/brain/modelSelector.ts` `selectModel`. The caller
   * provides the subset of `SelectModelInput` that the router cannot
   * infer (token count, mode, profile); the registry is built from
   * registered adapters.
   */
  selectModel(
    input: Omit<SelectModelInput, 'registry'> & { registry: SelectModelInput['registry'] },
  ) {
    return selectModel(input);
  }

  // --- Streaming ---------------------------------------------------------

  /**
   * Stream a prompt through the priority-ordered adapter list. Fails over
   * to the next adapter on retryable errors (transport error / 5xx /
   * timeout). Honours `opts.signal` — if the signal is aborted before or
   * during streaming, the reader is cancelled and `onComplete` is never
   * invoked (Requirement 4.7).
   */
  async stream(
    prompt: PromptInput,
    cb: StreamCallbacks,
    opts: CallOpts = {},
  ): Promise<void> {
    // Abort before we even start?
    if (opts.signal?.aborted) {
      throw makeAbortError();
    }

    const adaptersInOrder = this.getOrderedAdapters();
    console.log('[Router] Adapters in order:', adaptersInOrder.map(a => a.name));
    let lastError: unknown = null;

    // Image-only prompts must not be offered to a text-only adapter: the image is
    // dropped and the model answers that it received no context. Filter before
    // the loop so failover cannot walk into one either.
    const eligible = opts.requireImageInput
      ? this.eligibleForImages(adaptersInOrder)
      : adaptersInOrder;

    if (opts.requireImageInput && eligible.length === 0) {
      throw new NoVisionProviderError();
    }
    if (opts.requireImageInput) {
      console.log('[Router] Vision required — eligible:', eligible.map(a => a.name));
    }

    for (const adapter of eligible) {
      // Check abort between adapters (within 200 ms requirement)
      if (opts.signal?.aborted) {
        throw makeAbortError();
      }

      // Vault-lock gate: skip cloud providers when locked
      // Offline gate: skip cloud providers when offline (Requirement 20.1)
      if (!LOCAL_PROVIDER_NAMES.has(adapter.name)) {
        if (this.offline) {
          lastError = new OfflineError(adapter.name);
          continue;
        }
        if (this.vaultLocked) {
          lastError = new VaultLockedError(adapter.name);
          continue;
        }
        // Skip a provider that recently returned 429 (quota/rate limited) so we
        // don't waste a round-trip on it every request during the cooldown.
        if (this.isRateLimited(adapter.name)) {
          console.log(`[Router] Skipping ${adapter.name} (rate-limited cooldown)`);
          lastError = new Error(`${adapter.name} is rate-limited (cooldown)`);
          continue;
        }
      }

      // Whether anything the User can read actually arrived. Counted here rather
      // than inferred from the resolved promise, because the two are not the
      // same thing — see `EmptyCompletionError`.
      let sawContent = false;
      let reportedError: unknown = null;
      const guarded: StreamCallbacks = {
        ...cb,
        onToken: (cumulativeText: string) => {
          if (cumulativeText.length > 0) sawContent = true;
          cb.onToken(cumulativeText);
        },
        onComplete: (response: ProviderResponse) => {
          if (response.text.trim().length > 0) sawContent = true;
          // An empty completion is withheld: it would tell the consumer the
          // request has finished — closing the stream, stopping the spinner,
          // rendering a blank card — moments before the next adapter starts
          // producing the real answer into the same callbacks.
          if (sawContent) cb.onComplete(response);
        },
        onError: (err: Error) => {
          // Adapters report mid-stream errors through this callback and then
          // *resolve*. Once text has already reached the consumer it needs to
          // know the answer is truncated. Before that, this is just one adapter
          // failing, and the one behind it may well succeed — so hold the error
          // and let it travel with the failover instead.
          if (sawContent) cb.onError(err);
          else reportedError = err;
        },
      };

      try {
        console.log(`[Router] Trying adapter: ${adapter.name}...`);
        await adapter.streamGenerate(prompt, guarded, opts);

        if (sawContent) {
          console.log(`[Router] ✅ Adapter ${adapter.name} succeeded`);
          return; // Success — done.
        }

        // Nothing reached the consumer. An abort is the legitimate reason for
        // that, and the request is genuinely over: resolving quietly is what
        // this path has always done, and failing over would fire a fresh
        // request at the next provider on behalf of a User who just cancelled.
        if (opts.signal?.aborted) {
          return;
        }

        // Carry the withheld `onError` into the log. Without it, an adapter that
        // knew exactly why it had nothing to say — a gateway refusing inside a
        // 200, say — looks identical to one that simply went quiet.
        const reason =
          reportedError instanceof Error ? ` — ${reportedError.message}` : '';
        console.warn(
          `[Router] ⚠ Adapter ${adapter.name} completed with no text — treating as failure${reason}`,
        );
        lastError = new EmptyCompletionError(adapter.name, reportedError);
        continue; // Try next adapter
      } catch (err) {
        console.error(`[Router] ❌ Adapter ${adapter.name} FAILED:`, err instanceof Error ? err.message : err);
        lastError = err;

        // If the signal was aborted, do NOT failover — surface the abort.
        if (opts.signal?.aborted) {
          throw makeAbortError();
        }

        // 429 → start a cooldown so we skip this provider on later requests.
        if (is429Error(err)) {
          this.markRateLimited(adapter.name);
          console.log(`[Router] ${adapter.name} rate-limited (429) — cooling down`);
        }

        // The adapter said it takes images and the endpoint disagreed. Record it
        // and keep going: there may be another vision adapter behind this one,
        // and without the failover a 4xx is non-retryable and would end the
        // request here — the caller having already thrown away its text sources
        // on the strength of the declared capability.
        //
        // Only when an image was actually sent. The message match is a substring
        // test ('multimodal', 'image input'), so an unrelated error mentioning
        // those words on a text-only prompt must not brand the adapter.
        if (prompt.images && prompt.images.length > 0 && isImageUnsupportedError(err)) {
          this.imageIncapable.add(adapter.name);
          console.log(`[Router] ${adapter.name} rejected image input — marked text-only`);
          continue;
        }

        // Only failover on retryable errors (transport / 5xx / timeout)
        if (isFailoverError(err)) {
          console.log(`[Router] Failover from ${adapter.name} (retryable error)`);
          continue; // Try next adapter
        }

        // Non-retryable error — surface it immediately.
        throw err;
      }
    }

    // All adapters exhausted.
    if (lastError !== null) {
      if (lastError instanceof VaultLockedError) {
        throw lastError;
      }
      if (lastError instanceof OfflineError) {
        throw lastError;
      }
      throw new AllProvidersFailedError(lastError);
    }

    throw new AllProvidersFailedError(
      new Error('No adapters registered or none matched the priority list.'),
    );
  }

  // --- Non-streaming completion ------------------------------------------

  /**
   * Non-streaming completion with the same failover logic as `stream`.
   */
  async complete(
    prompt: PromptInput,
    opts: CallOpts = {},
  ): Promise<ProviderResponse> {
    // Abort before we even start?
    if (opts.signal?.aborted) {
      throw makeAbortError();
    }

    const adaptersInOrder = this.getOrderedAdapters();
    let lastError: unknown = null;

    // Same vision gate as `stream` — see the comment there.
    const eligible = opts.requireImageInput
      ? this.eligibleForImages(adaptersInOrder)
      : adaptersInOrder;

    if (opts.requireImageInput && eligible.length === 0) {
      throw new NoVisionProviderError();
    }

    for (const adapter of eligible) {
      // Check abort between adapters
      if (opts.signal?.aborted) {
        throw makeAbortError();
      }

      // Vault-lock gate
      // Offline gate (Requirement 20.1)
      if (!LOCAL_PROVIDER_NAMES.has(adapter.name)) {
        if (this.offline) {
          lastError = new OfflineError(adapter.name);
          continue;
        }
        if (this.vaultLocked) {
          lastError = new VaultLockedError(adapter.name);
          continue;
        }
        if (this.isRateLimited(adapter.name)) {
          lastError = new Error(`${adapter.name} is rate-limited (cooldown)`);
          continue;
        }
      }

      try {
        const response = await adapter.complete(prompt, opts);
        // Same rule as `stream`: an answer with no text in it is a failure the
        // caller cannot do anything with, so let the next provider try rather
        // than returning it as a success. See `EmptyCompletionError`.
        if (response.text.trim().length === 0) {
          lastError = new EmptyCompletionError(adapter.name);
          continue;
        }
        return response;
      } catch (err) {
        lastError = err;

        if (opts.signal?.aborted) {
          throw makeAbortError();
        }

        if (is429Error(err)) {
          this.markRateLimited(adapter.name);
        }

        // See `stream` — a declared image capability that the endpoint refuses.
        if (prompt.images && prompt.images.length > 0 && isImageUnsupportedError(err)) {
          this.imageIncapable.add(adapter.name);
          continue;
        }

        if (isFailoverError(err)) {
          continue;
        }

        throw err;
      }
    }

    if (lastError !== null) {
      if (lastError instanceof VaultLockedError) {
        throw lastError;
      }
      if (lastError instanceof OfflineError) {
        throw lastError;
      }
      throw new AllProvidersFailedError(lastError);
    }

    throw new AllProvidersFailedError(
      new Error('No adapters registered or none matched the priority list.'),
    );
  }

  // --- Internal ----------------------------------------------------------

  /**
   * Returns the list of registered adapters in priority order.
   * Adapters not in the priority list are appended in registration order.
   */
  private getOrderedAdapters(): ProviderAdapter[] {
    const result: ProviderAdapter[] = [];
    const seen = new Set<string>();

    // First: adapters explicitly listed in priority order.
    for (const name of this.priority) {
      const adapter = this.adapters.get(name);
      if (adapter && !seen.has(name)) {
        result.push(adapter);
        seen.add(name);
      }
    }

    // Then: any remaining registered adapters not in the priority list.
    for (const [name, adapter] of this.adapters) {
      if (!seen.has(name)) {
        result.push(adapter);
        seen.add(name);
      }
    }

    return result;
  }
}

// --- Module helpers -------------------------------------------------------

/**
 * Determines whether an error should trigger failover to the next adapter.
 * Uses `isRetryableError` from `http.ts` plus timeout (AbortError from
 * per-request timeout, NOT from the caller's signal).
 */
/**
 * True if the error represents an HTTP 429 (rate-limited / quota exceeded).
 * Adapters attach a numeric `.status`; we also sniff the message as a fallback
 * (e.g. "GeminiAdapter: HTTP 429").
 */
function is429Error(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const status = (err as { status?: unknown }).status;
    if (status === 429) return true;
  }
  if (err instanceof Error && /\b429\b/.test(err.message)) return true;
  return false;
}

function isFailoverError(err: unknown): boolean {
  // Transport errors and 5xx are retryable → failover
  if (isRetryableError(err)) return true;

  // Timeout errors (AbortError from fetchWithTimeout's internal controller)
  // are also failover triggers.
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;

  return false;
}

/**
 * Creates a standard AbortError for signal-aborted scenarios.
 */
function makeAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted.', 'AbortError');
  }
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}
