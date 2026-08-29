// ============================================
// Zule AI — Custom provider config helpers (pure)
// ============================================
//
// Every decision the Settings_Provider_Panel and Provider_Sync make about the
// Custom (OpenAI-compatible) provider lives here (design.md §2), so neither of
// them contains branching logic that needs a browser, IndexedDB, or a network
// to test.
//
// Two structural guarantees hold across the whole module:
//   1. Nothing mutates its inputs. Every helper builds fresh arrays/objects,
//      which is how "leave the persisted values unchanged" (Requirement 1.5) is
//      guaranteed structurally rather than by convention.
//   2. Blankness is `value.trim().length === 0`, so a Base_URL, API_Key, or
//      Model_ID made of tabs/newlines/unicode spaces counts as empty
//      (Requirements 1.6, 3.4).
//
// Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 3.11

import type { ProviderConfig } from '../../data/database';
import { MAX_BASE_URL_LENGTH, normalizeBaseUrl } from './endpointValidator';

// --- Constants -----------------------------------------------------------

/** The provider id of the Custom (OpenAI-compatible) entry (Requirement 1.1). */
export const CUSTOM_PROVIDER_ID = 'custom' as const;

/** The label rendered in the AI Providers list (Requirement 1.1). */
export const CUSTOM_PROVIDER_LABEL = 'Custom (OpenAI-compatible)';

/** Maximum accepted API_Key length, in characters (Requirements 1.2, 3.11). */
export const MAX_API_KEY_LENGTH = 512;

/** Maximum accepted Model_ID length, in characters (Requirement 1.2). */
export const MAX_MODEL_ID_LENGTH = 200;

/** Inclusive bounds of the persisted 1-based `priority` field (Requirement 1.3). */
export const MIN_PRIORITY = 1;
export const MAX_PRIORITY = 10;

/**
 * The User-editable text fields of the Custom_Provider entry.
 *
 * `fastModelId` is a member so it gets the same keystroke clamping and
 * `aria-invalid` binding as the rest, but it is deliberately absent from
 * `MISSING_FIELD_ORDER` below: it is optional, and a blank one must never block
 * registration.
 */
export type CustomField = 'baseUrl' | 'apiKey' | 'modelId' | 'fastModelId';

/**
 * Fixed order in which `missing` is reported, so the configuration-incomplete
 * diagnostic names each empty field deterministically (Requirement 1.6).
 */
const MISSING_FIELD_ORDER: readonly CustomField[] = ['baseUrl', 'apiKey', 'modelId'];

const FIELD_MAX_LENGTH: Record<CustomField, number> = {
  baseUrl: MAX_BASE_URL_LENGTH,
  apiKey: MAX_API_KEY_LENGTH,
  modelId: MAX_MODEL_ID_LENGTH,
  fastModelId: MAX_MODEL_ID_LENGTH,
};

/** Provider ids that cannot be registered without a credential. */
const KEY_REQUIRED_PROVIDERS: ReadonlySet<string> = new Set([
  'gemini',
  'openai',
  'anthropic',
  CUSTOM_PROVIDER_ID,
]);

// --- Helpers -------------------------------------------------------------

/** True when `value` holds nothing but whitespace (Requirements 1.6, 3.4). */
function isBlank(value: string | undefined | null): boolean {
  return (value ?? '').trim().length === 0;
}

// --- 1. Keystroke clamping (Requirement 1.2) -----------------------------

/**
 * Clamp an input value to its field maximum by prefix truncation, so an
 * over-length paste is truncated rather than accepted. Returns `raw` unchanged
 * when it already fits.
 */
export function clampField(field: CustomField, raw: string): string {
  const max = FIELD_MAX_LENGTH[field];
  return raw.length <= max ? raw : raw.slice(0, max);
}

/**
 * Heuristic: does this model id name a variant that deliberates before
 * answering?
 *
 * Pattern-matching a name is not a capability check and cannot be one — a
 * gateway exposes no "does it think" field. It is used only to surface an
 * advisory line next to a field the User can still set to anything, so a false
 * positive costs one sentence of screen space and a false negative costs
 * nothing; an actual speed measurement is the authoritative answer.
 *
 * It lives in this dependency-light module rather than beside that measurement
 * so a render path can call it without pulling the adapter, telemetry, and the
 * HTTP layer into its bundle for the sake of one regular expression.
 */
export function looksLikeThinkingModel(modelId: string): boolean {
  return /think|reason|-r1\b|\bqwq|o1-|o3-/i.test((modelId ?? '').trim());
}

// --- 2. Entry-list initialisation (Requirements 1.1, 1.7) ----------------

/**
 * Return a copy of `saved` that holds exactly one `custom` entry.
 *
 * - When several `custom` entries exist, the first occurrence wins and the rest
 *   are dropped.
 * - When none exists, a disabled, empty entry is appended with the numerically
 *   greatest priority — i.e. *lowest precedence*, last in the failover order —
 *   clamped to `MAX_PRIORITY`.
 */
export function mergeCustomEntry(saved: readonly ProviderConfig[]): ProviderConfig[] {
  const merged: ProviderConfig[] = [];
  let seenCustom = false;

  for (const entry of saved) {
    if (!entry) continue;
    if (entry.id === CUSTOM_PROVIDER_ID) {
      if (seenCustom) continue; // de-duplicate to the first occurrence
      seenCustom = true;
    }
    merged.push({ ...entry });
  }

  if (!seenCustom) {
    let maxPriority = 0;
    for (const entry of merged) {
      const p = Number(entry.priority);
      if (Number.isFinite(p) && p > maxPriority) maxPriority = p;
    }
    const nextPriority = Math.min(
      Math.max(Math.floor(maxPriority) + 1, MIN_PRIORITY),
      MAX_PRIORITY,
    );
    merged.push({
      id: CUSTOM_PROVIDER_ID,
      enabled: false,
      priority: nextPriority,
      baseUrl: '',
      modelId: '',
    });
  }

  return merged;
}

// --- 3. Save validation (Requirements 1.3, 1.8, 3.11) --------------------

export type SaveResult =
  | { ok: true; config: ProviderConfig }
  /**
   * `field` names the offending control so the panel can bind `aria-invalid`.
   * `'priority'` is included for the caller-supplied position value, which is
   * not a User-editable text field.
   */
  | { ok: false; field: CustomField | 'priority'; reason: string };

/**
 * Validate a draft and produce the record to persist.
 *
 * This function does NOT encrypt: the caller supplies the already-produced
 * cipher, or leaves `apiKeyDraft` empty to retain the previously stored cipher
 * (Requirement 1.10). It therefore stays pure and never sees a keystore.
 */
export function buildCustomConfigForSave(input: {
  previous: ProviderConfig;
  enabled: boolean;
  priority: number;
  baseUrlDraft: string;
  modelIdDraft: string;
  /**
   * Optional fast-model draft. Absent (rather than `''`) leaves whatever was
   * previously persisted untouched, so a caller that predates this field cannot
   * silently erase it.
   */
  fastModelIdDraft?: string;
  /** `''` means "retain the previously stored cipher". */
  apiKeyDraft: string;
  /** Present only when `apiKeyDraft` was non-empty. */
  apiKeyCipher?: string;
}): SaveResult {
  const { previous, enabled, priority, baseUrlDraft, modelIdDraft, fastModelIdDraft, apiKeyDraft, apiKeyCipher } = input;

  // Base_URL: an empty value is allowed (the entry may be saved unconfigured),
  // but a non-empty value must be an absolute http(s) URL (Requirement 1.8).
  let baseUrl = '';
  if (baseUrlDraft.trim().length > 0) {
    const result = normalizeBaseUrl(baseUrlDraft);
    if (!result.ok) {
      return { ok: false, field: 'baseUrl', reason: result.reason };
    }
    baseUrl = result.url;
  }

  // API_Key: reject over-length outright, leaving the stored cipher untouched
  // (Requirement 3.11).
  if (apiKeyDraft.length > MAX_API_KEY_LENGTH) {
    return { ok: false, field: 'apiKey', reason: 'too-long' };
  }

  // A non-empty draft without a cipher would mean the credential was never
  // secured; abort rather than persist a stale or plaintext value
  // (Requirements 3.1, 3.10).
  if (apiKeyDraft !== '' && apiKeyCipher === undefined) {
    return { ok: false, field: 'apiKey', reason: 'cipher-missing' };
  }

  // Priority: reject non-integers, clamp integers into [1, 10] (Requirement 1.3).
  if (!Number.isInteger(priority)) {
    return { ok: false, field: 'priority', reason: 'not-an-integer' };
  }
  const clampedPriority = Math.min(Math.max(priority, MIN_PRIORITY), MAX_PRIORITY);

  const retainedCipher = apiKeyDraft === '' ? previous.apiKeyCipher : apiKeyCipher;

  const config: ProviderConfig = {
    ...previous,
    id: CUSTOM_PROVIDER_ID,
    enabled,
    priority: clampedPriority,
    baseUrl,
    modelId: modelIdDraft.trim(),
  };

  // Over-length is clamped at the keystroke by `clampField`, so there is nothing
  // to reject here — unlike the API_Key, a truncated model id fails loudly at the
  // gateway rather than leaking anything.
  if (fastModelIdDraft !== undefined) {
    config.fastModelId = fastModelIdDraft.trim().slice(0, MAX_MODEL_ID_LENGTH);
  }

  if (retainedCipher === undefined) {
    delete config.apiKeyCipher;
  } else {
    config.apiKeyCipher = retainedCipher;
  }

  return { ok: true, config };
}

// --- 4. Registration decision (Requirements 1.4, 1.5, 1.6) ---------------

export type SyncDecision =
  | {
      action: 'register';
      baseUrl: string;
      modelId: string;
      apiKey: string;
      /** `''` when none is configured, which the adapter reads as "unset". */
      fastModelId: string;
    }
  | { action: 'unregister'; reason: 'disabled' }
  | { action: 'skip'; reason: 'incomplete'; missing: CustomField[] }
  | { action: 'skip'; reason: 'absent' };

/**
 * Decide what Provider_Sync must do with the custom entry.
 *
 * The disabled check runs **first**: a disabled entry yields `unregister` when
 * it is currently registered and `skip: 'absent'` otherwise, regardless of
 * whether the other fields are filled in. That ordering is what makes
 * Requirement 1.5 hold unconditionally.
 */
export function resolveCustomRegistration(input: {
  config: ProviderConfig | undefined;
  decryptedApiKey: string;
  currentlyRegistered: boolean;
}): SyncDecision {
  const { config, decryptedApiKey, currentlyRegistered } = input;

  // Absent or disabled ⇒ never registered (Requirements 1.4, 1.5).
  if (!config || config.enabled === false) {
    return currentlyRegistered
      ? { action: 'unregister', reason: 'disabled' }
      : { action: 'skip', reason: 'absent' };
  }

  // Enabled: every required field must be present (Requirement 1.6).
  const normalized = normalizeBaseUrl(config.baseUrl ?? '');
  const modelId = (config.modelId ?? '').trim();
  const apiKey = decryptedApiKey.trim();

  const blank: Record<CustomField, boolean> = {
    // An unparseable or unsupported Base_URL is treated as unusable, exactly
    // like a blank one — there is no endpoint to send to either way.
    baseUrl: !normalized.ok,
    apiKey: isBlank(apiKey),
    modelId: modelId.length === 0,
    // Always false: an absent fast model is a complete configuration, it just
    // means every dispatch uses `modelId`. Reporting it as missing would refuse
    // to register a perfectly usable endpoint.
    fastModelId: false,
  };

  const missing = MISSING_FIELD_ORDER.filter((field) => blank[field]);
  if (missing.length > 0) {
    return { action: 'skip', reason: 'incomplete', missing };
  }

  return {
    action: 'register',
    baseUrl: normalized.ok ? normalized.url : '',
    modelId,
    apiKey,
    fastModelId: (config.fastModelId ?? '').trim(),
  };
}

// --- 5. Whole-config planner (Requirements 1.4, 1.5, 1.6) ----------------

export interface SyncPlan {
  /** Provider ids to (re)register, in ascending priority order. */
  register: string[];
  /** Provider ids to remove from the router. */
  unregister: string[];
  /** The priority list handed to `router.setPriority`. */
  priority: string[];
  /** Human-readable, credential-free diagnostics. */
  diagnostics: Array<
    | { kind: 'custom.disabled-while-registered' }
    | { kind: 'custom.config-incomplete'; missing: CustomField[] }
  >;
}

/**
 * Total, non-mutating planner over a persisted provider array.
 *
 * `decryptedKeys` maps provider id → decrypted credential; a key that could not
 * be decrypted must be passed as `''` so it degrades to `skip: 'incomplete'`
 * rather than to an uncredentialed request. `registered` is the set of adapter
 * names currently held by the router.
 */
export function planProviderSync(
  configs: readonly ProviderConfig[],
  decryptedKeys: Readonly<Record<string, string>>,
  registered: ReadonlySet<string>,
): SyncPlan {
  const plan: SyncPlan = { register: [], unregister: [], priority: [], diagnostics: [] };

  const registerSeen = new Set<string>();
  const prioritySeen = new Set<string>();
  const pushRegister = (id: string) => {
    if (!registerSeen.has(id)) {
      registerSeen.add(id);
      plan.register.push(id);
    }
  };
  const pushPriority = (id: string) => {
    if (!prioritySeen.has(id)) {
      prioritySeen.add(id);
      plan.priority.push(id);
    }
  };

  // Ascending priority, stable on ties. Decorate-sort-undecorate keeps `configs`
  // untouched.
  const ordered = configs
    .map((config, index) => ({ config, index }))
    .filter(({ config }) => Boolean(config))
    .sort((a, b) => {
      const pa = Number.isFinite(Number(a.config.priority)) ? Number(a.config.priority) : Number.MAX_SAFE_INTEGER;
      const pb = Number.isFinite(Number(b.config.priority)) ? Number(b.config.priority) : Number.MAX_SAFE_INTEGER;
      return pa === pb ? a.index - b.index : pa - pb;
    });

  // The custom entry is selected in **array order** — the first occurrence in
  // `configs`, exactly as `mergeCustomEntry` de-duplicates — independent of the
  // priority sort below. Later duplicates stay ignored. The selected entry is
  // still processed at the position its own priority gives it in `ordered`, so
  // `custom`'s place in the priority list comes from that entry's priority.
  const customIndex = configs.findIndex(
    (config) => Boolean(config) && config.id === CUSTOM_PROVIDER_ID,
  );
  const customSeen = customIndex >= 0;

  for (const { config, index } of ordered) {
    const id = config.id;

    if (id === CUSTOM_PROVIDER_ID) {
      if (index !== customIndex) continue; // a later duplicate: ignored

      const decision = resolveCustomRegistration({
        config,
        decryptedApiKey: decryptedKeys[CUSTOM_PROVIDER_ID] ?? '',
        currentlyRegistered: registered.has(CUSTOM_PROVIDER_ID),
      });
      applyCustomDecision(plan, decision, pushRegister, pushPriority);
      continue;
    }

    if (!config.enabled) continue;

    pushPriority(id);
    const key = decryptedKeys[id] ?? '';
    if (!KEY_REQUIRED_PROVIDERS.has(id) || !isBlank(key)) {
      pushRegister(id);
    }
  }

  // No persisted custom entry at all: still unregister a stale adapter.
  if (!customSeen) {
    const decision = resolveCustomRegistration({
      config: undefined,
      decryptedApiKey: decryptedKeys[CUSTOM_PROVIDER_ID] ?? '',
      currentlyRegistered: registered.has(CUSTOM_PROVIDER_ID),
    });
    applyCustomDecision(plan, decision, pushRegister, pushPriority);
  }

  return plan;
}

/** Fold a `SyncDecision` for the custom entry into the plan under construction. */
function applyCustomDecision(
  plan: SyncPlan,
  decision: SyncDecision,
  pushRegister: (id: string) => void,
  pushPriority: (id: string) => void,
): void {
  switch (decision.action) {
    case 'register':
      pushRegister(CUSTOM_PROVIDER_ID);
      pushPriority(CUSTOM_PROVIDER_ID);
      return;
    case 'unregister':
      if (!plan.unregister.includes(CUSTOM_PROVIDER_ID)) {
        plan.unregister.push(CUSTOM_PROVIDER_ID);
      }
      plan.diagnostics.push({ kind: 'custom.disabled-while-registered' });
      return;
    case 'skip':
      if (decision.reason === 'incomplete') {
        plan.diagnostics.push({
          kind: 'custom.config-incomplete',
          missing: [...decision.missing],
        });
      }
      return;
  }
}
