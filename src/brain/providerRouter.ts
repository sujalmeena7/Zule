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
import { isRetryableError } from './providers/http';

// --- Constants -----------------------------------------------------------

/**
 * Provider names that are allowed when the vault is locked or the
 * browser is offline. All other providers are considered "cloud" and
 * require both the vault to be unlocked and network connectivity.
 * Requirements: 15.2, 20.1.
 */
const LOCAL_PROVIDER_NAMES = new Set<string>(['ollama', 'simulation']);

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

// --- Router class --------------------------------------------------------

export class AI_Provider_Router {
  private adapters = new Map<string, ProviderAdapter>();
  private priority: string[] = [];
  private vaultLocked = true; // Default locked — safe default per Requirement 15.2
  private offline = false; // Tracks navigator.onLine — Requirement 20.1

  // --- Registration & configuration --------------------------------------

  /**
   * Register a provider adapter by its `adapter.name`. Overwrites any
   * existing adapter with the same name.
   */
  registerAdapter(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.name, adapter);
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

    for (const adapter of adaptersInOrder) {
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
      }

      try {
        console.log(`[Router] Trying adapter: ${adapter.name}...`);
        await adapter.streamGenerate(prompt, cb, opts);
        console.log(`[Router] ✅ Adapter ${adapter.name} succeeded`);
        return; // Success — done.
      } catch (err) {
        console.error(`[Router] ❌ Adapter ${adapter.name} FAILED:`, err instanceof Error ? err.message : err);
        lastError = err;

        // If the signal was aborted, do NOT failover — surface the abort.
        if (opts.signal?.aborted) {
          throw makeAbortError();
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

    for (const adapter of adaptersInOrder) {
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
      }

      try {
        const response = await adapter.complete(prompt, opts);
        return response;
      } catch (err) {
        lastError = err;

        if (opts.signal?.aborted) {
          throw makeAbortError();
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
