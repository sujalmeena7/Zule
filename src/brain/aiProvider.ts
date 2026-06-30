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
import { database } from '../data/database';
import { AI_Provider_Router, VaultLockedError, OfflineError } from './providerRouter';
import type { PromptInput, StreamCallbacks as RouterStreamCallbacks, ProviderResponse } from '../types/ai';

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
}

// --- Singleton router instance -------------------------------------------

/**
 * Lazily-initialised router map keyed by API key. The simulation adapter
 * is always registered; the Gemini adapter is registered when a non-empty
 * API key is supplied for the first time.
 */
const routerInstance = new AI_Provider_Router();

// Register the simulation adapter lazily — no credentials needed.
// Using a dynamic import ensures it ends up in a separate chunk (Requirement 21.1).
let simulationRegistered = false;
async function ensureSimulationRegistered(): Promise<void> {
  if (simulationRegistered) return;
  const { SimulationAdapter } = await import('./providers/simulation');
  routerInstance.registerAdapter(new SimulationAdapter());
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
  registeredGeminiKey = apiKey;
}

/**
 * Dynamically synchronizes provider registrations and priority list with the router
 * based on saved user database settings.
 * Caches a hash of the config to skip redundant IndexedDB reads.
 */
let lastSyncedConfigHash: string | null = null;

async function ensureProvidersSynced(): Promise<void> {
  try {
    const savedProviders = await database.getSetting<any[]>('providers', []);
    if (!savedProviders || savedProviders.length === 0) {
      return;
    }

    // Skip re-registration if config hasn't changed since last sync
    const configHash = JSON.stringify(savedProviders);
    if (configHash === lastSyncedConfigHash) return;
    lastSyncedConfigHash = configHash;

    // Sort providers by priority
    const sortedConfigs = [...savedProviders].sort((a, b) => a.priority - b.priority);

    // Register active/enabled adapters
    for (const config of sortedConfigs) {
      if (!config.enabled) {
        continue;
      }

      if (config.id === 'gemini') {
        const { GeminiAdapter } = await import('./providers/gemini');
        const geminiKey = config.apiKeyCipher || (await database.getSetting<string>('apiKey', ''));
        if (geminiKey && geminiKey.trim()) {
          routerInstance.registerAdapter(new GeminiAdapter({ apiKey: geminiKey.trim() }));
          registeredGeminiKey = geminiKey;
        }
      } else if (config.id === 'openai') {
        const { OpenAIAdapter } = await import('./providers/openai');
        if (config.apiKeyCipher && config.apiKeyCipher.trim()) {
          routerInstance.registerAdapter(new OpenAIAdapter({ apiKey: config.apiKeyCipher.trim() }));
        }
      } else if (config.id === 'anthropic') {
        const { AnthropicAdapter } = await import('./providers/anthropic');
        if (config.apiKeyCipher && config.apiKeyCipher.trim()) {
          routerInstance.registerAdapter(new AnthropicAdapter({ apiKey: config.apiKeyCipher.trim() }));
        }
      } else if (config.id === 'ollama') {
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
          })
        );
      } else if (config.id === 'simulation') {
        const { SimulationAdapter } = await import('./providers/simulation');
        routerInstance.registerAdapter(new SimulationAdapter());
      }
    }

    // Set router priority based on all enabled providers
    const priorityList = sortedConfigs.filter((p) => p.enabled).map((p) => p.id);
    if (priorityList.length > 0) {
      routerInstance.setPriority(priorityList);
    }
  } catch (error) {
    console.error('[aiProvider] Failed to sync providers config:', error);
  }
}

// --- Adapter helpers -----------------------------------------------------

/** Convert a legacy `ContextWindow` to the new `PromptInput`. */
function toPromptInput(context: ContextWindow): PromptInput {
  return {
    systemPrompt: context.systemPrompt || '',
    userText: context.userQuery || '',
    fullPrompt: context.fullPrompt || '',
    images: context.images,
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

  try {
    await routerInstance.stream(prompt, routerCallbacks, { signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error; // Let abort errors propagate
    }
    // Re-throw vault-locked and offline errors so callers can surface them
    if (error instanceof VaultLockedError || error instanceof OfflineError) {
      throw error;
    }
    // Fallback: stream via simulation (preserves old behaviour)
    console.warn('[aiProvider] AI streaming failed, falling back to simulation:', error);
    const { SimulationAdapter } = await import('./providers/simulation');
    const simAdapter = new SimulationAdapter();
    await simAdapter.streamGenerate(prompt, routerCallbacks, { signal });
  }
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
