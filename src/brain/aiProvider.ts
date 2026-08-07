// ============================================
// Zule AI — aiProvider shim (legacy API surface)
// ============================================
//
// Thin compatibility shim that re-exports the original API surface
// (`streamAIResponse`, `generateAIResponse`, `AIResponse`,
// `StreamCallbacks`) so existing consumers (FloatingCopilot,
// CopilotContext, SuggestionCard, summaryEngine, sync.ts) keep
// compiling while the codebase migrates to the new
// `AI_Provider_Router` + per-provider adapter architecture.
//
// Under the hood every call delegates to the singleton router instance.
// Requirements covered: 4.1, 4.2.

import type { ContextWindow } from './contextManager';
import { database, type ProviderConfig } from '../data/database';
import { AI_Provider_Router, VaultLockedError, OfflineError } from './providerRouter';
import type { PromptInput, StreamCallbacks as RouterStreamCallbacks, ProviderResponse } from '../types/ai';
import { decryptApiKey } from '../utils/secureKeyStorage';
import {
  CUSTOM_PROVIDER_ID,
  mergeCustomEntry,
  planProviderSync,
  resolveCustomRegistration,
  type CustomField,
} from './providers/customProviderConfig';

// --- Legacy types (kept for backwards compat) ----------------------------

export interface AIResponse {
  text: string;
  suggestions: string[];
  followUps: string[];
  isSimulated: boolean;
}

export interface StreamCallbacks {
  onToken: (partialText: string) => void;
  onComplete: (response: AIResponse) => void;
  onError: (error: Error) => void;
  onMetrics?: (metrics: { timeToFirstToken: number; totalLatency: number; model: string }) => void;
  /**
   * Invoked when every configured provider failed and the request is about to
   * be served by the simulation adapter instead. Without this the UI only sees
   * `isSimulated: true` and shows a generic "add your API key" banner, which
   * misattributes real provider failures (wrong model id, expired credit,
   * disabled model) to a missing key.
   */
  onProviderFallback?: (error: Error) => void;
}

/**
 * Turns a provider/transport error into a short, human-readable reason that is
 * safe to show in the UI. Pure and credential-free: it reads only the HTTP
 * status and any `error.message` the provider put in its JSON body, and never
 * echoes headers or the key itself.
 */
export function describeProviderFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');

  // Providers embed their JSON body after an em dash; pull out the human part.
  let detail = '';
  const braceAt = raw.indexOf('{');
  if (braceAt !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(braceAt)) as unknown;
      const errField = (parsed as { error?: unknown }).error;
      if (typeof errField === 'string') {
        detail = errField;
      } else if (errField && typeof errField === 'object') {
        const msg = (errField as { message?: unknown }).message;
        if (typeof msg === 'string') detail = msg;
      }
    } catch {
      /* body was truncated or not JSON — fall through to the status text */
    }
  }

  const statusMatch = /HTTP (\d{3})/.exec(raw);
  const status = statusMatch ? Number(statusMatch[1]) : null;

  const byStatus: Record<number, string> = {
    401: 'the endpoint rejected your API key',
    403: 'the endpoint refused your API key',
    404: 'the endpoint or model was not found — check the Base URL and Model ID',
    402: 'the account is out of credit',
    429: 'the provider is rate-limiting you',
    // 503 covers both "this model is disabled" and "the whole gateway is
    // down", so the prefix stays neutral and the provider's own detail
    // (appended below) says which one it is.
    503: 'the provider is unavailable right now',
  };

  const prefix = status !== null ? (byStatus[status] ?? `the provider returned HTTP ${status}`) : 'the provider request failed';

  return detail ? `${prefix} — ${detail.slice(0, 160)}` : prefix;
}

// --- Singleton router instance -------------------------------------------

/**
 * Lazily-initialised router map keyed by API key. The simulation adapter
 * is always registered; the Gemini adapter is registered when a non-empty
 * API key is supplied for the first time.
 */
const routerInstance = new AI_Provider_Router();

/**
 * Adapter names currently held by the router, tracked alongside
 * `lastSyncedConfigHash` so Provider_Sync can tell "registered and now
 * disabled" (Requirement 1.5) from "never registered".
 */
const registeredNames = new Set<string>();

// Register the simulation adapter lazily — no credentials needed.
// Using a dynamic import ensures it ends up in a separate chunk (Requirement 21.1).
let simulationRegistered = false;
async function ensureSimulationRegistered(): Promise<void> {
  if (simulationRegistered) return;
  const { SimulationAdapter } = await import('./providers/simulation');
  routerInstance.registerAdapter(new SimulationAdapter());
  registeredNames.add('simulation');
  simulationRegistered = true;
}

// Kick off simulation registration immediately (non-blocking) so the
// fallback adapter is ready by the time any AI call is attempted.
void ensureSimulationRegistered();

// Default priority: simulation is always available as fallback.
routerInstance.setPriority(['gemini', 'simulation']);
// Unlock vault so cloud providers can be used when an API key is present.
routerInstance.setVaultLocked(false);

/** Tracks whether we've registered the Gemini adapter for a given key. */
let registeredGeminiKey: string | null = null;

/**
 * Ensures the Gemini adapter is registered (or updated) for the given
 * API key. No-ops if the key has not changed since the last call.
 * Uses dynamic import to ensure the adapter lands in a separate chunk (Requirement 21.1).
 */
async function ensureGeminiRegistered(apiKey: string | undefined): Promise<void> {
  if (!apiKey || !apiKey.trim()) return;
  if (registeredGeminiKey === apiKey) return;
  const { GeminiAdapter } = await import('./providers/gemini');
  routerInstance.registerAdapter(new GeminiAdapter({ apiKey }));
  registeredNames.add('gemini');
  registeredGeminiKey = apiKey;
}

// --- Provider_Sync diagnostics surface -----------------------------------

/**
 * A credential-free configuration diagnostic raised by Provider_Sync.
 *
 * `custom.disabled-while-registered` is the configuration error required by
 * Requirement 1.5; `custom.config-incomplete` names each empty field per
 * Requirement 1.6. `message` has already been passed through `scrubSecret`,
 * and `missing` holds field *names* only — never their values
 * (Requirement 3.9).
 */
export interface ProviderSyncDiagnostic {
  kind: 'custom.disabled-while-registered' | 'custom.config-incomplete';
  providerId: string;
  message: string;
  missing?: CustomField[];
}

type ProviderDiagnosticListener = (diagnostic: ProviderSyncDiagnostic) => void;

const diagnosticListeners = new Set<ProviderDiagnosticListener>();

/**
 * Subscribe the copilot error surface to Provider_Sync diagnostics.
 * Returns an unsubscribe function.
 */
export function subscribeProviderDiagnostics(
  listener: ProviderDiagnosticListener,
): () => void {
  diagnosticListeners.add(listener);
  return () => {
    diagnosticListeners.delete(listener);
  };
}

function emitDiagnostic(diagnostic: ProviderSyncDiagnostic): void {
  console.warn(`[aiProvider] ${diagnostic.message}`);
  for (const listener of diagnosticListeners) {
    try {
      listener(diagnostic);
    } catch (error) {
      console.warn('[aiProvider] Provider diagnostic listener threw:', error);
    }
  }
}

// --- Provider_Sync -------------------------------------------------------

/**
 * Dynamically synchronizes provider registrations and priority list with the router
 * based on saved user database settings.
 * Caches a hash of the config to skip redundant IndexedDB reads.
 *
 * A thin driver over the pure `planProviderSync`: every branch about *what*
 * should be registered lives in `customProviderConfig.ts`; this function only
 * reads storage, decrypts, and applies the resulting plan
 * (Requirements 1.4, 1.5, 1.6, 2.2, 3.9).
 */
let lastSyncedConfigHash: string | null = null;

/**
 * Decrypt a stored cipher, mapping any failure to `''` so the planner treats
 * it as a blank key and degrades to `skip: 'incomplete'` rather than issuing
 * an uncredentialed request (design.md §6 step 2).
 */
async function decryptOrBlank(cipher: string | undefined): Promise<string> {
  if (!cipher || !cipher.trim()) return '';
  try {
    const plain = await decryptApiKey(cipher);
    return typeof plain === 'string' ? plain : '';
  } catch {
    return '';
  }
}

/** Instantiate and register the adapter for one provider id. */
async function registerProviderAdapter(
  config: ProviderConfig,
  apiKey: string,
): Promise<void> {
  switch (config.id) {
    case 'gemini': {
      const { GeminiAdapter } = await import('./providers/gemini');
      const geminiOpts: { apiKey: string; defaultModelId?: string } = { apiKey };
      if (config.modelId && config.modelId.trim()) {
        geminiOpts.defaultModelId = config.modelId.trim();
      }
      routerInstance.registerAdapter(new GeminiAdapter(geminiOpts));
      registeredGeminiKey = apiKey;
      break;
    }

    case 'openai': {
      const { OpenAIAdapter } = await import('./providers/openai');
      routerInstance.registerAdapter(new OpenAIAdapter({ apiKey }));
      break;
    }
    case 'anthropic': {
      const { AnthropicAdapter } = await import('./providers/anthropic');
      // Forward optional baseUrl and modelId so users can point Anthropic at
      // compatible gateways (e.g. api.lumosel.vip) and choose a model.
      const anthropicOpts: { apiKey: string; baseUrl?: string; defaultModelId?: string } = { apiKey };
      if (config.baseUrl && config.baseUrl.trim()) {
        anthropicOpts.baseUrl = config.baseUrl.trim();
      }
      if (config.modelId && config.modelId.trim()) {
        anthropicOpts.defaultModelId = config.modelId.trim();
      }
      routerInstance.registerAdapter(new AnthropicAdapter(anthropicOpts));
      break;
    }
    case 'ollama': {
      // Unchanged legacy behaviour: Ollama's documented layout is `/v1`, and
      // this branch has always carried the model tag in `apiKeyCipher`.
      const { OllamaCompatibleAdapter } = await import('./providers/ollama');
      let normalizedUrl = (config.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
      if (!normalizedUrl.endsWith('/v1')) {
        normalizedUrl += '/v1';
      }
      const modelId = config.apiKeyCipher?.trim() || 'llama3.1';
      routerInstance.registerAdapter(
        new OllamaCompatibleAdapter({
          baseUrl: normalizedUrl,
          defaultModelId: modelId,
        }),
      );
      break;
    }
    case CUSTOM_PROVIDER_ID: {
      // Re-resolve so the adapter is built from the same normalised values the
      // planner decided on: the Base_URL straight from storage with no `/v1`
      // synthesis, and the first-class `modelId` field — never the `ollama`
      // branch's `apiKeyCipher`-as-model-tag trick.
      const decision = resolveCustomRegistration({
        config,
        decryptedApiKey: apiKey,
        currentlyRegistered: registeredNames.has(CUSTOM_PROVIDER_ID),
      });
      if (decision.action !== 'register') return;
      const { CustomOpenAICompatibleAdapter } = await import('./providers/custom');
      routerInstance.registerAdapter(
        new CustomOpenAICompatibleAdapter({
          baseUrl: decision.baseUrl,
          modelId: decision.modelId,
          apiKey: decision.apiKey,
          pricePerMTokens: config.pricePerMTokens,
        }),
      );
      break;
    }
    case 'simulation': {
      const { SimulationAdapter } = await import('./providers/simulation');
      routerInstance.registerAdapter(new SimulationAdapter());
      simulationRegistered = true;
      break;
    }
    default:
      return;
  }
  registeredNames.add(config.id);
}

async function ensureProvidersSynced(): Promise<void> {
  try {
    const savedProviders = await database.getSetting<ProviderConfig[]>('providers', []);
    if (!savedProviders || savedProviders.length === 0) {
      return;
    }

    // Skip re-registration if config hasn't changed since last sync. The hash
    // covers the whole array, so any enable/disable transition invalidates it.
    const configHash = JSON.stringify(savedProviders);
    if (configHash === lastSyncedConfigHash) return;
    lastSyncedConfigHash = configHash;

    // Exactly one `custom` entry, initialised when absent.
    const configs = mergeCustomEntry(savedProviders);

    // Decrypt every stored cipher up front. A failure maps to `''`.
    const decryptedKeys: Record<string, string> = {};
    for (const config of configs) {
      if (!config) continue;
      // `ollama` carries its model tag — not a credential — in `apiKeyCipher`;
      // never run it through the keystore.
      if (config.id === 'ollama') {
        decryptedKeys[config.id] = '';
        continue;
      }
      let key = await decryptOrBlank(config.apiKeyCipher);
      if (config.id === 'gemini' && !key.trim()) {
        // Legacy single-key setting fallback, preserved.
        key = (await database.getSetting<string>('apiKey', '')) ?? '';
      }
      decryptedKeys[config.id] = key.trim();
    }

    const plan = planProviderSync(configs, decryptedKeys, registeredNames);

    const byId = new Map<string, ProviderConfig>();
    for (const config of configs) {
      if (config && !byId.has(config.id)) byId.set(config.id, config);
    }

    for (const id of plan.register) {
      const config = byId.get(id);
      if (!config) continue;
      try {
        await registerProviderAdapter(config, decryptedKeys[id] ?? '');
      } catch (error) {
        console.warn(`[aiProvider] Failed to register provider '${id}':`, error);
      }
    }

    for (const id of plan.unregister) {
      routerInstance.unregisterAdapter(id);
      registeredNames.delete(id);
      if (id === 'gemini') registeredGeminiKey = null;
      if (id === 'simulation') simulationRegistered = false;
    }

    if (plan.priority.length > 0) {
      routerInstance.setPriority(plan.priority);
    }

    if (plan.diagnostics.length > 0) {
      // Dynamic import keeps the custom-provider chunk out of the main bundle.
      const { scrubSecret } = await import('./providers/custom');
      const customKey = decryptedKeys[CUSTOM_PROVIDER_ID] ?? '';
      for (const diagnostic of plan.diagnostics) {
        if (diagnostic.kind === 'custom.disabled-while-registered') {
          emitDiagnostic({
            kind: diagnostic.kind,
            providerId: CUSTOM_PROVIDER_ID,
            message: scrubSecret(
              `Provider '${CUSTOM_PROVIDER_ID}' is disabled but was registered; the adapter has been removed and no request will be routed to it. Persisted configuration was left unchanged.`,
              customKey,
            ),
          });
        } else {
          emitDiagnostic({
            kind: diagnostic.kind,
            providerId: CUSTOM_PROVIDER_ID,
            missing: [...diagnostic.missing],
            message: scrubSecret(
              `Provider '${CUSTOM_PROVIDER_ID}' configuration is incomplete — empty field(s): ${diagnostic.missing.join(', ')}. The adapter was not registered.`,
              customKey,
            ),
          });
        }
      }
    }
  } catch (error) {
    console.error('[aiProvider] Failed to sync providers config:', error);
  }
}

// --- Adapter helpers -----------------------------------------------------

/**
 * True when a provider rejected the request specifically because the chosen
 * model cannot accept image input.
 *
 * `activeAdapterSupportsImageInput()` reports the *adapter's* declared
 * capability, but a gateway fronts many models and most cheap/free ones are
 * text-only. Those endpoints reject the whole request (OpenRouter answers 404
 * "No endpoints found that support image input") rather than dropping the
 * attachment, which turns an answerable question into a hard failure.
 */
function isImageUnsupportedError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  return (
    msg.includes('support image input') ||
    msg.includes('support image') ||
    msg.includes('image input') ||
    msg.includes('does not support image') ||
    msg.includes('image_url') ||
    msg.includes('multimodal')
  );
}

/** Convert a legacy `ContextWindow` to the new `PromptInput`. */
function toPromptInput(context: ContextWindow): PromptInput {
  return {
    systemPrompt: context.systemPrompt || '',
    userText: context.userQuery || '',
    fullPrompt: context.fullPrompt || '',
    images: context.images,
    // Forward the Context_Builder attestation so adapters that refuse
    // unattested prompts (the custom provider's `assertRedacted` pre-flight)
    // can see that redaction completed (Requirements 2.9, 2.10).
    redaction: context.redaction,
  };
}

/** Extract bullet-point-like suggestions from response text. */
function extractBulletPoints(text: string): string[] {
  const lines = text.split('\n');
  return lines
    .filter(l => /^[\s]*[-•*\d.]/.test(l))
    .map(l => l.replace(/^[\s]*[-•*\d.]+\s*/, '').trim())
    .filter(l => l.length > 0)
    .slice(0, 5);
}

/** Convert a `ProviderResponse` to the legacy `AIResponse` shape. */
function toAIResponse(pr: ProviderResponse): AIResponse {
  return {
    text: pr.text,
    suggestions: extractBulletPoints(pr.text),
    followUps: [],
    isSimulated: pr.isSimulated,
  };
}

// --- Public API (legacy surface) -----------------------------------------

/**
 * Non-streaming completion. Delegates to the router's `complete` method.
 */
export async function generateAIResponse(
  context: ContextWindow,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<AIResponse> {
  await ensureProvidersSynced();
  await ensureGeminiRegistered(apiKey);
  await ensureSimulationRegistered();

  const prompt = toPromptInput(context);

  try {
    const response = await routerInstance.complete(prompt, { signal });
    return toAIResponse(response);
  } catch (error) {
    // Re-throw vault-locked and offline errors so callers can surface them
    if (error instanceof VaultLockedError || error instanceof OfflineError) {
      throw error;
    }
    // Fallback to simulation on transport/provider errors (preserves old behaviour)
    console.warn('AI provider call failed, falling back to simulation:', error);
    const { SimulationAdapter } = await import('./providers/simulation');
    const simAdapter = new SimulationAdapter();
    const simResponse = await simAdapter.complete(prompt, { signal });
    return toAIResponse(simResponse);
  }
}

/**
 * Streaming completion. Delegates to the router's `stream` method,
 * adapting the new `StreamCallbacks` shape to the legacy one.
 */
export async function streamAIResponse(
  context: ContextWindow,
  callbacks: StreamCallbacks,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<void> {
  await ensureProvidersSynced();
  await ensureGeminiRegistered(apiKey);
  await ensureSimulationRegistered();

  const prompt = toPromptInput(context);

  const routerCallbacks: RouterStreamCallbacks = {
    onToken: (cumulativeText: string) => {
      callbacks.onToken(cumulativeText);
    },
    onComplete: (response: ProviderResponse) => {
      callbacks.onComplete(toAIResponse(response));
    },
    onError: (err: Error) => {
      callbacks.onError(err);
    },
    onMetrics: callbacks.onMetrics
      ? (m) => {
          callbacks.onMetrics!({
            timeToFirstToken: m.ttftMs,
            totalLatency: m.totalMs,
            model: m.modelId,
          });
        }
      : undefined,
  };

  let failure: unknown;
  try {
    await routerInstance.stream(prompt, routerCallbacks, { signal });
    return;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error; // Let abort errors propagate
    }
    // Re-throw vault-locked and offline errors so callers can surface them
    if (error instanceof VaultLockedError || error instanceof OfflineError) {
      throw error;
    }
    failure = error;
  }

  // Text-only model + attached keyframe: retry once without the image before
  // giving up. The screen's OCR text is already in `fullPrompt`, so the answer
  // is still grounded in what is on screen — only the picture is lost.
  if (prompt.images && prompt.images.length > 0 && isImageUnsupportedError(failure)) {
    console.warn(
      '[aiProvider] Model rejected image input; retrying text-only (screen OCR text is retained).',
    );
    const textOnlyPrompt: PromptInput = { ...prompt, images: undefined };
    try {
      await routerInstance.stream(textOnlyPrompt, routerCallbacks, { signal });
      return;
    } catch (retryError) {
      if (retryError instanceof Error && retryError.name === 'AbortError') {
        throw retryError;
      }
      if (retryError instanceof VaultLockedError || retryError instanceof OfflineError) {
        throw retryError;
      }
      failure = retryError;
    }
  }

  // Fallback: stream via simulation (preserves old behaviour). Tell the caller
  // *why* first, so the UI can name the real failure instead of blaming a
  // missing API key.
  console.warn('[aiProvider] AI streaming failed, falling back to simulation:', failure);
  if (callbacks.onProviderFallback) {
    try {
      callbacks.onProviderFallback(
        failure instanceof Error ? failure : new Error(String(failure)),
      );
    } catch (listenerError) {
      console.warn('[aiProvider] onProviderFallback listener threw:', listenerError);
    }
  }
  const { SimulationAdapter } = await import('./providers/simulation');
  const simAdapter = new SimulationAdapter();
  await simAdapter.streamGenerate(prompt, routerCallbacks, { signal });
}

// --- Online/offline state -------------------------------------------------

/**
 * Sets the offline state on the router instance. When offline, the router
 * refuses cloud providers and only allows `ollama` and `simulation` adapters.
 * This is effectively the same gate as the vault-locked path.
 *
 * Called from the App layout when `navigator.onLine` transitions.
 * Requirement 20.1.
 */
export function setRouterOffline(offline: boolean): void {
  routerInstance.setOffline(offline);
}

/**
 * Returns whether the currently active adapter supports image input.
 * Used by `FloatingCopilot` to determine whether to capture a keyframe
 * alongside OCR text (Requirement 23.3).
 */
export function activeAdapterSupportsImageInput(): boolean {
  const caps = routerInstance.getActiveAdapterCapabilities();
  return caps?.imageInput === true;
}
