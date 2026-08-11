// ============================================
// Zule AI — Settings Page
// ============================================

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import {
  Key, Palette, Keyboard, Database, Trash2, Plus, FileText,
  Sun, Moon, Shield, Upload, Eye, EyeOff, CheckCircle2, Wand2,
  ArrowUp, ArrowDown, Power, Server, ShieldCheck, Play, Clock,
  Gauge, Lock, Globe, Mic, RefreshCw
} from 'lucide-react';
import { database as knowledgeBase, type KBDocument, type ProviderConfig } from '../data/database';
import { encryptApiKey, decryptApiKey } from '../utils/secureKeyStorage';
import {
  CUSTOM_PROVIDER_ID,
  CUSTOM_PROVIDER_LABEL,
  MAX_API_KEY_LENGTH,
  MAX_MODEL_ID_LENGTH,
  buildCustomConfigForSave,
  clampField,
  mergeCustomEntry,
} from '../brain/providers/customProviderConfig';
import { MAX_BASE_URL_LENGTH } from '../brain/providers/endpointValidator';
// Type-only: the probe implementation itself is loaded lazily inside the
// handler (`await import`), matching how this panel loads other heavy modules.
import type {
  ConnectionTestFailure,
  ConnectionTestResult,
} from '../brain/providers/connectionTest';
import { SHORTCUT_DEFINITIONS } from '../hooks/useKeyboardShortcuts';
import { getModifierKey, getAltKey, getPlatformLimitations } from '../overlay/platformKeys';
import toast from 'react-hot-toast';
import './Settings.css';

import { useZule } from '../context/ZuleContext';
import { useSubscription } from '../context/SubscriptionContext';
import { UpgradeModal } from './UpgradeModal';
import type { GatedFeature } from '../types/subscription';
import { useZuleError } from '../hooks/useZuleError';
import { useAutoUpdate } from '../hooks/useAutoUpdate';
import type { RedactionRule, RedactionEntity } from '../types/redaction';
import { apply as applyRedaction } from '../brain/redaction';
import { SpendPanel } from './SpendPanel';
import { getSupportedLocales, setLocale, type LocaleCode } from '../i18n';
import {
  DEFAULT_MEETING_MAX_AGE_DAYS,
  DEFAULT_TRANSCRIPT_MAX_LINES,
} from '../data/retention';
import type { PrivacyMode } from '../utils/sessionPolicy';
import { telemetry } from '../brain/telemetry';
import { dequantizeFromStorage } from '../brain/vectorStore';
import { chunkIndexId } from '../data/vectorIndexHydration';
import type { VADSensitivity } from '../brain/transcription/vad';
import { vadSensitivityBus } from '../brain/transcription/vadSensitivityBus';

const SUPPORTED_DOC_EXTENSIONS = new Set(['txt', 'md', 'json', 'pdf', 'docx']);

/**
 * Renderer-side mirror of `electron/embeddingService.ts::EMBED_BATCH_SIZE`.
 * Must stay in sync with the main-process constant — the renderer issues
 * one `embed:generateBatch` IPC per window of this many chunks (design
 * §"Components and Interfaces / Batched Embedding Service" and
 * Requirement 1.5 / Property 3). The renderer cannot import from
 * `electron/` directly because it lives under a different tsconfig
 * project; the constant is intentionally duplicated here.
 */
const EMBED_BATCH_SIZE = 32;

/**
 * Split a flat array into successive windows of at most `size` items.
 * The last window may be shorter. For non-positive `size`, the items
 * are returned as a single window so callers degrade gracefully rather
 * than spinning forever. Used by `handleAddDocument` to drive one
 * `embed:generateBatch` IPC per window.
 */
function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) return [];
  if (size <= 0) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

const BUILT_IN_ENTITIES: { id: RedactionEntity; label: string }[] = [
  { id: 'email', label: 'Email' },
  { id: 'phone', label: 'Phone' },
  { id: 'credit-card', label: 'Credit Card' },
  { id: 'iban', label: 'IBAN' },
  { id: 'us-ssn', label: 'US SSN' },
];

// --- AI Provider Configuration ---

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: 'gemini', enabled: true, priority: 0 },
  { id: 'openai', enabled: false, priority: 1 },
  { id: 'anthropic', enabled: false, priority: 2 },
  { id: 'ollama', enabled: false, priority: 3, baseUrl: 'http://localhost:11434' },
  { id: 'simulation', enabled: true, priority: 4 },
  // Custom (OpenAI-compatible) ships disabled with empty credentials and is
  // never a Zule default (Requirements 1.1, 1.7).
  { id: CUSTOM_PROVIDER_ID, enabled: false, priority: 6, baseUrl: '', modelId: '' },
];

const PROVIDER_LABELS: Record<ProviderConfig['id'], string> = {
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  ollama: 'Ollama (Local)',
  simulation: 'Simulation',
  custom: CUSTOM_PROVIDER_LABEL,
};

const PROVIDER_DESCRIPTIONS: Record<ProviderConfig['id'], string> = {
  gemini: 'Google Gemini Pro / Flash models',
  openai: 'GPT-4o, o-series models',
  anthropic: 'Claude Sonnet / Opus / Haiku — supports custom gateways',
  ollama: 'Local models via Ollama or LM Studio',
  simulation: 'Offline simulation for testing (no API key needed)',
  custom: 'Any OpenAI-compatible endpoint (OpenRouter, Groq, vLLM, LM Studio…)',
};

/**
 * Placeholder shown in the Custom_Provider API_Key input when a credential is
 * already persisted. The stored cipher is never decrypted into the field, so
 * this masked hint is the only signal that a key exists, and saving with the
 * field blank retains it (Requirements 1.10, 3.1).
 */
const CUSTOM_KEY_SAVED_PLACEHOLDER = '•••••••••••• (saved — leave blank to keep)';

/**
 * Prefix `secureKeyStorage.encryptApiKey` returns when Electron's `safeStorage`
 * is unavailable (e.g. the app is running outside Electron). The credential is
 * then persisted unencrypted, which is a *warning* rather than the
 * Requirement 3.10 failure — that one is a thrown error (design §10).
 */
const PLAINTEXT_CIPHER_PREFIX = 'plain:';

/** User-facing message per `normalizeBaseUrl` rejection reason (Requirement 1.8). */
const CUSTOM_BASE_URL_MESSAGES: Record<string, string> = {
  empty: 'Enter a Base URL, for example https://openrouter.ai/api/v1',
  'too-long': `Base URL must be ${MAX_BASE_URL_LENGTH} characters or fewer.`,
  unparseable:
    'Base URL must be an absolute URL including the scheme, for example https://openrouter.ai/api/v1',
  'unsupported-scheme': 'Base URL must start with http:// or https://',
};

/** User-facing message per API_Key rejection reason (Requirements 3.10, 3.11). */
const CUSTOM_API_KEY_MESSAGES: Record<string, string> = {
  'too-long': `API key must be ${MAX_API_KEY_LENGTH} characters or fewer.`,
  'cipher-missing': 'The credential could not be secured, so nothing was saved.',
};

// --- Connection_Test presentation (task 11.5, Requirements 3.3, 3.9) -----
//
// The probe returns a `category` plus a short, already-`scrubSecret`-ed
// `detail` (`HTTP 401`, `Network request failed`, `Timed out after 6000 ms`) —
// never a response body and never the URL. The panel renders the category as
// human-readable guidance and appends `detail` verbatim as the classification
// hint. Nothing else about the response is surfaced, so no credential and no
// gateway-supplied text can reach the UI (Requirement 3.9).

/** Human-readable guidance per `ConnectionTestFailure` category. */
const CONNECTION_TEST_MESSAGES: Record<ConnectionTestFailure, string> = {
  'invalid-url': 'Base URL is not valid',
  'missing-model': 'Model ID is required',
  unauthorized: 'Authentication failed — check the API key',
  forbidden: 'The endpoint refused this key',
  'not-found': 'Endpoint or model not found — check the Base URL and Model ID',
  'rate-limited': 'The endpoint is rate limiting this key',
  'server-error': 'The endpoint returned a server error',
  network: 'Could not reach the endpoint',
  timeout: 'The endpoint did not respond in time',
  'bad-response': 'The endpoint returned an unexpected response',
};

/**
 * Outcome of the most recent Connection_Test, or `null` before one has run.
 *
 * The `failed` variant carries only the scrubbed classification text produced
 * by `testCustomProviderConnection` (or a locally authored message for the
 * "saved key could not be read" case) — never a decrypted credential.
 */
type CustomConnectionTestStatus =
  | { state: 'testing' }
  | { state: 'ok'; message: string }
  | { state: 'failed'; message: string };

/**
 * Turns a `ConnectionTestResult` into the pill/toast text.
 *
 * Deliberately a module-level pure function rather than inline logic in the
 * component: it keeps the mapping testable and independent of the panel, and it
 * is the only place the probe's `detail` is read. `detail` arrives already
 * passed through `scrubSecret` and is a short classification string (`HTTP 401`,
 * `Network request failed`, `Timed out after 6000 ms`) — never a response body
 * and never the URL — so it is appended as a parenthetical hint behind the
 * human-readable category guidance and nothing else about the response is
 * surfaced (Requirement 3.9).
 */
function describeConnectionTestResult(
  result: ConnectionTestResult,
): { state: 'ok'; message: string } | { state: 'failed'; message: string } {
  if (result.ok) {
    return {
      state: 'ok',
      message:
        result.modelEcho === undefined
          ? `Connected in ${result.latencyMs} ms`
          : `Connected in ${result.latencyMs} ms — responded as "${result.modelEcho}"`,
    };
  }
  return {
    state: 'failed',
    message: `${CONNECTION_TEST_MESSAGES[result.category]} (${result.detail})`,
  };
}

/** Explanation attached to the Test connection button while it is disabled. */
const CUSTOM_TEST_DISABLED_HINT =
  'Enter a Base URL, an API key, and a Model ID to test the connection.';

/** Shared styling for the Custom_Provider field labels. */
const CUSTOM_FIELD_LABEL_STYLE: CSSProperties = {
  fontSize: '0.72rem',
  fontWeight: 600,
  color: 'var(--text-tertiary)',
};

// --- Data-egress disclosure (task 11.4, Requirement 1.4) -----------------
//
// The notice is persistent, not a dismissible banner: it stays visible for the
// custom row whether or not the User has acknowledged it, because the endpoint
// can change at any time. The acknowledgement gate lives entirely here in the
// panel's enable path — the persisted `enabled` flag remains the single source
// of truth Provider_Sync reads, so Requirements 1.4 and 1.6 are unaffected.

/** DOM id of the persistent notice, referenced by `aria-describedby`. */
const CUSTOM_EGRESS_NOTICE_ID = 'custom-provider-egress-notice';

/** DOM id of the acknowledgement checkbox. */
const CUSTOM_EGRESS_ACK_ID = 'custom-provider-egress-ack';

/** Plain-language disclosure copy shown above the custom inputs. */
const CUSTOM_EGRESS_NOTICE_TEXT =
  'Prompts sent to this provider — including live transcript text and Knowledge Base excerpts — leave your device and are transmitted to the endpoint you configure below. A gateway may relay them onward to upstream model vendors. Zule has no data-processing agreement with the gateway or with those vendors.';

/** Label for the acknowledgement checkbox that unlocks the enable toggle. */
const CUSTOM_EGRESS_ACK_LABEL =
  'I understand where my data is sent and want to enable this provider.';

/**
 * Explanation attached to the enable toggle while it is disabled, so the reason
 * is available to assistive technology and on hover, not just visually.
 */
const CUSTOM_EGRESS_TOGGLE_HINT =
  'Acknowledge the data-egress notice to enable Custom (OpenAI-compatible).';

const CUSTOM_EGRESS_NOTICE_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '10px 12px',
  marginBottom: '10px',
  borderRadius: '8px',
  border: '1px solid var(--accent-yellow, rgba(234, 179, 8, 0.4))',
  background: 'rgba(234, 179, 8, 0.08)',
  fontSize: '0.74rem',
  lineHeight: 1.45,
  color: 'var(--text-secondary)',
  maxWidth: '340px',
};

export function Settings() {
  const { state, actions } = useZule();
  const { apiKey, theme, customModes } = state;
  const { updateApiKey, updateTheme, saveCustomMode, deleteCustomMode } = actions;
  const notifyError = useZuleError();

  // Auto-Update State (task 10.2, Requirements 3.1–3.7)
  const { state: updateState, check: checkForUpdate } = useAutoUpdate();
  const [upToDate, setUpToDate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const prevStatusRef = useRef(updateState.status);

  // Track status transitions to show "up to date" or error messages
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = updateState.status;

    // When transitioning from 'checking' to 'idle' without going through
    // 'available', it means no update was found → show confirmation
    if (prev === 'checking' && updateState.status === 'idle') {
      if (updateState.error) {
        // Error during check — display failure category message
        const errorMessages: Record<string, string> = {
          'unreachable': 'Could not reach update server',
          'timeout': 'Update check timed out',
          'server-error': 'Update server returned an error',
          'network': 'Network error during update check',
          'storage': 'Insufficient storage',
          'integrity': 'Integrity check failed',
        };
        setUpdateError(errorMessages[updateState.error.category] || 'Update check failed');
        setUpToDate(false);
      } else {
        // No update found — show "up to date" for 5 seconds
        setUpdateError(null);
        setUpToDate(true);
        const timer = setTimeout(() => setUpToDate(false), 5000);
        return () => clearTimeout(timer);
      }
    }
  }, [updateState.status, updateState.error]);

  const [localKey, setLocalKey] = useState(apiKey);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [documents, setDocuments] = useState<KBDocument[]>([]);
  const [newDocTitle, setNewDocTitle] = useState('');
  const [newDocContent, setNewDocContent] = useState('');
  const [newDocType, setNewDocType] = useState<KBDocument['type']>('custom');
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // Custom Mode State
  const [showAddMode, setShowAddMode] = useState(false);
  const [newModeLabel, setNewModeLabel] = useState('');
  const [newModeDesc, setNewModeDesc] = useState('');
  const [newModeIcon, setNewModeIcon] = useState('Wand2');
  const [newModePrompt, setNewModePrompt] = useState('');

  // AI Providers State
  const [providers, setProviders] = useState<ProviderConfig[]>(DEFAULT_PROVIDERS);
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>({});
  const [showProviderKey, setShowProviderKey] = useState<Record<string, boolean>>({});
  const [providersSaving, setProvidersSaving] = useState(false);
  // Custom (OpenAI-compatible) provider draft state (task 11.2).
  // `customBaseUrlError` drives `aria-invalid` plus the inline message on the
  // Base_URL control (Requirement 1.8); the save path (task 11.3) sets it.
  const [customBaseUrlError, setCustomBaseUrlError] = useState<string | null>(null);
  // `customApiKeyError` carries the API_Key validation message named by
  // Requirements 3.10 and 3.11 (over-length draft, or a credential that could
  // not be secured). Both cases abort the save with the stored cipher intact.
  const [customApiKeyError, setCustomApiKeyError] = useState<string | null>(null);
  // Providers whose credential exists in IndexedDB as ciphertext. For `custom`
  // the cipher is never decrypted into the input — the flag only drives the
  // masked placeholder, and a blank save keeps the stored cipher
  // (Requirements 1.10, 3.1).
  const [hasStoredKey, setHasStoredKey] = useState<Record<string, boolean>>({});
  // Result of the most recent Connection_Test (task 11.5). Holds presentation
  // text only — the probe's `detail` is already scrubbed and the decrypted key
  // never enters state (Requirements 3.3, 3.9).
  const [providerTestStatus, setProviderTestStatus] =
    useState<Record<string, CustomConnectionTestStatus | null>>({});


  // Performance Profile & Ephemeral Mode State
  type Profile = 'speed' | 'balanced' | 'cost' | 'privacy';
  const [profile, setProfile] = useState<Profile>('balanced');
  const [privacyMode, setPrivacyMode] = useState<PrivacyMode>('normal');

  // Redaction Rules State
  const [enabledEntities, setEnabledEntities] = useState<Set<RedactionEntity>>(new Set());
  const [regexRules, setRegexRules] = useState<Array<{ pattern: string; flags: string; replacement: string }>>([]);
  const [redactionTestInput, setRedactionTestInput] = useState('');
  const [redactionTestOutput, setRedactionTestOutput] = useState<string | null>(null);
  const [redactionSaving, setRedactionSaving] = useState(false);

  // Subscription State
  const { limits } = useSubscription();
  const [upgradeModal, setUpgradeModal] = useState<{
    reason: 'kb-doc-limit' | 'feature-locked';
    feature?: GatedFeature;
  } | null>(null);

  // Data Retention State
  const [meetingMaxAgeDays, setMeetingMaxAgeDays] = useState(DEFAULT_MEETING_MAX_AGE_DAYS);
  const [transcriptMaxLines, setTranscriptMaxLines] = useState(DEFAULT_TRANSCRIPT_MAX_LINES);
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [sweepRunning, setSweepRunning] = useState(false);

  // Language State
  const [uiLocale, setUiLocale] = useState<LocaleCode>('en');
  const [recognitionLanguage, setRecognitionLanguage] = useState('en-US');
  const [ocrLanguage, setOcrLanguage] = useState('eng');

  // Transcription State (VAD sensitivity — task 11.1)
  // The 3-level dial persisted in `STORE_SETTINGS` under the stable key
  // `vadSensitivity`. `medium` is the documented default
  // (Requirement 7.6) and matches the un-gated baseline so existing
  // users see consistent behaviour on first upgrade. The control is
  // disabled when the local Whisper transcription pipeline is in a
  // failed runtime state — mirroring the same `isSupported` checks
  // `useSystemAudioTranscription` performs (Requirement 7.5).
  const [vadSensitivity, setVadSensitivity] = useState<VADSensitivity>('medium');
  const transcriptionSupport = useMemo<{
    supported: boolean;
    reason: string | null;
  }>(() => {
    const electronAPI =
      typeof window !== 'undefined' ? window.electronAPI : undefined;
    const whisperBridge = electronAPI?.whisperTranscribe;
    if (typeof whisperBridge !== 'function') {
      return {
        supported: false,
        reason:
          'Local Whisper transcription is unavailable in this environment.',
      };
    }
    const hasMediaDevices =
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      !!navigator.mediaDevices.getDisplayMedia;
    if (!hasMediaDevices) {
      return {
        supported: false,
        reason:
          'System-audio capture (getDisplayMedia) is not available on this platform.',
      };
    }
    return { supported: true, reason: null };
  }, []);

  // Load KB documents
  useEffect(() => {
    knowledgeBase.getAllDocuments().then(setDocuments);
  }, []);

  // Load provider configurations from IndexedDB
  useEffect(() => {
    knowledgeBase.getSetting<ProviderConfig[]>('providers', DEFAULT_PROVIDERS).then((saved) => {
      // Start from the persisted array so ids outside DEFAULT_PROVIDERS survive
      // the round trip, then append any default the record predates. The
      // `custom` entry is owned by `mergeCustomEntry`, which guarantees exactly
      // one occurrence and initialises a missing one with the numerically
      // greatest priority (Requirements 1.1, 1.7).
      const persisted = Array.isArray(saved) ? saved : DEFAULT_PROVIDERS;
      const withDefaults: ProviderConfig[] = persisted.map((p) => ({ ...p }));
      for (const def of DEFAULT_PROVIDERS) {
        if (def.id === CUSTOM_PROVIDER_ID) continue;
        if (!withDefaults.some((p) => p.id === def.id)) withDefaults.push({ ...def });
      }
      const merged = mergeCustomEntry(withDefaults);
      // Sort by priority
      merged.sort((a, b) => a.priority - b.priority);
      setProviders(merged);

      // Populate providerKeys from loaded apiKeyCipher (decrypting OS-encrypted
      // values). `ollama` repurposes this field for a plaintext model ID.
      // `custom` is the exception: its stored cipher is NEVER decrypted into the
      // input. The input stays empty and only a masked placeholder signals that
      // a credential is saved, so no character of it is ever rendered
      // (Requirement 1.10).
      void (async () => {
        const keys: Record<string, string> = {};
        const stored: Record<string, boolean> = {};
        for (const p of merged) {
          if (p.id === CUSTOM_PROVIDER_ID) {
            keys[p.id] = '';
            if (p.apiKeyCipher) stored[p.id] = true;
            continue;
          }
          if (p.apiKeyCipher) {
            keys[p.id] = p.id === 'ollama' ? p.apiKeyCipher : await decryptApiKey(p.apiKeyCipher);
          }
        }
        setProviderKeys(keys);
        setHasStoredKey(stored);
      })();
    });
  }, []);

  // Load performance profile and privacy mode from IndexedDB
  useEffect(() => {
    knowledgeBase.getSetting<Profile>('profile', 'balanced').then(setProfile);
    knowledgeBase.getSetting<PrivacyMode>('privacyMode', 'normal').then(setPrivacyMode);
  }, []);

  // Load language settings from IndexedDB
  useEffect(() => {
    knowledgeBase.getSetting<LocaleCode>('uiLocale', 'en').then((saved) => {
      setUiLocale(saved);
      setLocale(saved);
    });
    knowledgeBase.getSetting<string>('recognitionLanguage', 'en-US').then(setRecognitionLanguage);
    knowledgeBase.getSetting<string>('ocrLanguage', 'eng').then(setOcrLanguage);
  }, []);

  // Load redaction rules from IndexedDB
  useEffect(() => {
    knowledgeBase.getSetting<RedactionRule[]>('redactionRules', []).then((saved) => {
      const entities = new Set<RedactionEntity>();
      const regexes: Array<{ pattern: string; flags: string; replacement: string }> = [];
      for (const rule of saved) {
        if (rule.kind === 'entity') {
          entities.add(rule.entity);
        } else if (rule.kind === 'regex') {
          regexes.push({ pattern: rule.pattern, flags: rule.flags, replacement: rule.replacement });
        }
      }
      setEnabledEntities(entities);
      setRegexRules(regexes);
    });
  }, []);

  // Load persisted VAD sensitivity (task 11.1, Requirement 7.2). A
  // corrupt or unrecognised stored value falls back to `medium`, the
  // documented default (Requirement 7.6).
  useEffect(() => {
    knowledgeBase
      .getSetting<VADSensitivity>('vadSensitivity', 'medium')
      .then((saved) => {
        const sensitivity: VADSensitivity =
          saved === 'low' || saved === 'medium' || saved === 'high'
            ? saved
            : 'medium';
        setVadSensitivity(sensitivity);
      });
  }, []);

  // Load retention settings from IndexedDB
  useEffect(() => {
    knowledgeBase.getSetting<{ meetingMaxAgeDays?: number; transcriptMaxLines?: number }>('retention', {}).then((saved) => {
      if (saved.meetingMaxAgeDays != null) setMeetingMaxAgeDays(saved.meetingMaxAgeDays);
      if (saved.transcriptMaxLines != null) setTranscriptMaxLines(saved.transcriptMaxLines);
    });
  }, []);

  const handleMoveProvider = useCallback((index: number, direction: 'up' | 'down') => {
    setProviders((prev) => {
      const next = [...prev];
      const swapIndex = direction === 'up' ? index - 1 : index + 1;
      if (swapIndex < 0 || swapIndex >= next.length) return prev;
      [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
      // Reassign priorities based on position
      return next.map((p, i) => ({ ...p, priority: i }));
    });
  }, []);

  const handleToggleProvider = useCallback((id: ProviderConfig['id']) => {
    setProviders((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p;
        // The custom entry cannot be flipped on until the data-egress notice
        // has been acknowledged. The button is already disabled in that state;
        // this is the belt-and-braces guard so a programmatic call cannot
        // produce an enabled-but-unacknowledged entry (Requirement 1.4).
        if (
          p.id === CUSTOM_PROVIDER_ID &&
          !p.enabled &&
          p.acknowledgedEgressAt == null
        ) {
          return p;
        }
        return { ...p, enabled: !p.enabled };
      })
    );
  }, []);

  /**
   * Tick/untick the data-egress acknowledgement for the custom entry.
   *
   * Ticking stamps `acknowledgedEgressAt: Date.now()` on the entry, which is
   * what persists the acknowledgement — re-opening Settings finds the stamp and
   * the User is not re-gated. Unticking removes the stamp *and* forces
   * `enabled: false`, so the gated state can never leave an enabled entry
   * behind a disabled toggle. `enabled` stays the only flag Provider_Sync
   * reads (Requirement 1.4).
   */
  const handleCustomEgressAckChange = useCallback((acknowledged: boolean) => {
    setProviders((prev) =>
      prev.map((p) => {
        if (p.id !== CUSTOM_PROVIDER_ID) return p;
        if (acknowledged) {
          return { ...p, acknowledgedEgressAt: Date.now() };
        }
        const next: ProviderConfig = { ...p, enabled: false };
        delete next.acknowledgedEgressAt;
        return next;
      })
    );
  }, []);

  const handleProviderKeyChange = useCallback((id: string, value: string) => {
    setProviderKeys((prev) => ({ ...prev, [id]: value }));
  }, []);

  const handleProviderUrlChange = useCallback((id: string, value: string) => {
    setProviders((prev) =>
      prev.map((p) => (p.id === id ? { ...p, baseUrl: value } : p))
    );
  }, []);

  const handleProviderModelChange = useCallback((id: string, value: string) => {
    setProviders((prev) =>
      prev.map((p) => (p.id === id ? { ...p, modelId: value } : p))
    );
  }, []);

  // --- Custom (OpenAI-compatible) field handlers (task 11.2) --------------
  //
  // Every handler routes the raw value through `clampField`, so a paste that
  // exceeds the field maximum is truncated rather than accepted — `maxLength`
  // alone is a UA courtesy, not a guarantee (Requirement 1.2).

  const handleCustomBaseUrlChange = useCallback((value: string) => {
    // Editing the field clears the stale validation message so the error state
    // only ever reflects the most recent save attempt (Requirement 1.8).
    setCustomBaseUrlError(null);
    // A Connection_Test result describes one specific configuration; editing
    // any field makes it stale, so it is discarded rather than left to mislead.
    setProviderTestStatus((prev) => ({ ...prev, [CUSTOM_PROVIDER_ID]: null }));
    const clamped = clampField('baseUrl', value);
    setProviders((prev) =>
      prev.map((p) => (p.id === CUSTOM_PROVIDER_ID ? { ...p, baseUrl: clamped } : p)),
    );
  }, []);

  const handleCustomApiKeyChange = useCallback((value: string) => {
    // As with the Base_URL, editing clears the stale message so the error only
    // ever reflects the most recent save attempt (Requirements 3.10, 3.11).
    setCustomApiKeyError(null);
    setProviderTestStatus((prev) => ({ ...prev, [CUSTOM_PROVIDER_ID]: null }));
    setProviderKeys((prev) => ({
      ...prev,
      [CUSTOM_PROVIDER_ID]: clampField('apiKey', value),
    }));
  }, []);

  const handleCustomModelIdChange = useCallback((value: string) => {
    setProviderTestStatus((prev) => ({ ...prev, [CUSTOM_PROVIDER_ID]: null }));
    const clamped = clampField('modelId', value);
    setProviders((prev) =>
      prev.map((p) => (p.id === CUSTOM_PROVIDER_ID ? { ...p, modelId: clamped } : p)),
    );
  }, []);

  const handleToggleProviderKeyVisibility = useCallback((id: string) => {
    setShowProviderKey((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  // --- Connection_Test per provider ----------------------------------------

  /**
   * Evaluates whether a connection probe can be issued for a given provider.
   */
  const canTestProviderConnection = useCallback(
    (providerId: string): boolean => {
      const entry = providers.find((p) => p.id === providerId);
      if (!entry) return false;
      if (providerId === 'simulation') return false;

      const hasDraftKey = (providerKeys[providerId] ?? '').trim().length > 0;
      const hasKey =
        hasDraftKey || (hasStoredKey[providerId] === true && Boolean(entry.apiKeyCipher));

      if (providerId === CUSTOM_PROVIDER_ID) {
        const hasBaseUrl = (entry.baseUrl ?? '').trim().length > 0;
        const hasModelId = (entry.modelId ?? '').trim().length > 0;
        return hasBaseUrl && hasModelId && hasKey;
      }

      if (providerId === 'ollama') {
        return (entry.baseUrl ?? '').trim().length > 0;
      }

      return hasKey;
    },
    [providers, providerKeys, hasStoredKey],
  );

  /**
   * Runs a single-request Connection_Test against the provider's configuration.
   */
  const handleTestProviderConnection = useCallback(
    async (providerId: string) => {
      const entry = providers.find((p) => p.id === providerId);
      if (!entry) return;

      const draftKey = (providerKeys[providerId] ?? '').trim();
      let apiKey = '';

      if (draftKey.length > 0) {
        apiKey = draftKey;
      } else if (entry.apiKeyCipher && providerId !== 'ollama') {
        try {
          apiKey = await decryptApiKey(entry.apiKeyCipher);
        } catch (error) {
          console.error(`[Settings] Stored credential for ${providerId} could not be read:`, error);
          apiKey = '';
        }
        if (apiKey.trim().length === 0 && providerId !== 'ollama') {
          const message = 'The saved API key could not be read — re-enter it and save again.';
          setProviderTestStatus((prev) => ({
            ...prev,
            [providerId]: { state: 'failed', message },
          }));
          toast.error(message);
          return;
        }
      }

      setProviderTestStatus((prev) => ({
        ...prev,
        [providerId]: { state: 'testing' },
      }));

      try {
        const { testProviderConnection } = await import('../brain/providers/connectionTest');
        const baseUrl =
          providerId === CUSTOM_PROVIDER_ID || providerId === 'ollama' || providerId === 'anthropic'
            ? entry.baseUrl ?? ''
            : undefined;
        const modelId = entry.modelId ?? '';

        const result = await testProviderConnection({
          providerId,
          apiKey,
          baseUrl,
          modelId,
        });

        const outcome = describeConnectionTestResult(result);
        setProviderTestStatus((prev) => ({
          ...prev,
          [providerId]: outcome,
        }));

        const label = PROVIDER_LABELS[providerId as ProviderConfig['id']] ?? providerId;
        if (outcome.state === 'ok') {
          toast.success(`${label}: ${outcome.message}`);
        } else {
          toast.error(`${label}: ${outcome.message}`);
        }
      } catch (error) {
        console.error(`[Settings] Connection test for ${providerId} could not run:`, error);
        const message = 'The connection test could not run.';
        setProviderTestStatus((prev) => ({
          ...prev,
          [providerId]: { state: 'failed', message },
        }));
        toast.error(message);
      }
    },
    [providers, providerKeys],
  );


  const handleSaveProviders = useCallback(async () => {
    setProvidersSaving(true);
    try {
      // Build the configs to persist. Each entered key is encrypted via the
      // OS credential store (Electron safeStorage) before it touches disk —
      // see src/utils/secureKeyStorage.ts. The `ollama` provider repurposes
      // this same field for a (non-secret) model ID, so it's stored as-is.
      //
      // `priority` is derived from list position as `index + 1`, making the
      // persisted values 1-based integers in [1, 10] (Requirement 1.3);
      // `buildCustomConfigForSave` clamps the custom entry into that range.
      //
      // Nothing is written until every entry has been validated: the loop
      // below returns early on any rejection, so an invalid draft leaves the
      // persisted `providers` row byte-identical (Requirements 1.8, 3.10, 3.11).
      const configsToSave: ProviderConfig[] = [];
      let keyStoredUnencrypted = false;

      for (const [index, provider] of providers.entries()) {
        const positioned: ProviderConfig = { ...provider, priority: index + 1 };

        if (positioned.id === CUSTOM_PROVIDER_ID) {
          // Re-clamp the drafts: `maxLength` and the onChange clamps are UA
          // courtesies, not guarantees, and state may have been set
          // programmatically (Requirement 1.2).
          const baseUrlDraft = clampField('baseUrl', positioned.baseUrl ?? '');
          const modelIdDraft = clampField('modelId', positioned.modelId ?? '');
          const apiKeyDraft = providerKeys[CUSTOM_PROVIDER_ID] ?? '';

          // Encrypt only a non-empty draft. A blank draft leaves
          // `apiKeyCipher` undefined here so `buildCustomConfigForSave`
          // retains the previously stored cipher (Requirements 1.10, 3.1).
          // An over-length draft is rejected before the keystore is touched, so
          // a programmatic submission neither encrypts nor persists it and the
          // stored cipher is retained (Requirement 3.11). `buildCustomConfigForSave`
          // repeats the check as the authoritative rule.
          if (apiKeyDraft.length > MAX_API_KEY_LENGTH) {
            const message = CUSTOM_API_KEY_MESSAGES['too-long'];
            setCustomApiKeyError(message);
            toast.error(message);
            return;
          }

          let apiKeyCipher: string | undefined;
          if (apiKeyDraft !== '') {
            try {
              // The draft is already within `MAX_API_KEY_LENGTH` here, so the
              // cipher corresponds exactly to the value handed to
              // `buildCustomConfigForSave` below.
              apiKeyCipher = await encryptApiKey(apiKeyDraft);
            } catch (error) {
              // Requirement 3.10: abort before any write, keep the stored
              // ciphertext, and never fall back to persisting plaintext.
              console.error(
                '[Settings] Custom provider credential could not be secured; save aborted:',
                error,
              );
              setCustomApiKeyError(CUSTOM_API_KEY_MESSAGES['cipher-missing']);
              toast.error(
                'The API key could not be secured by the OS credential store — nothing was saved.',
              );
              return;
            }
            // Not a failure, but the credential is going to disk unencrypted
            // because no OS keystore was available (design §10).
            if (apiKeyCipher.startsWith(PLAINTEXT_CIPHER_PREFIX)) {
              keyStoredUnencrypted = true;
            }
          }

          const result = buildCustomConfigForSave({
            previous: provider,
            enabled: positioned.enabled,
            priority: positioned.priority,
            baseUrlDraft,
            modelIdDraft,
            apiKeyDraft,
            apiKeyCipher,
          });

          if (!result.ok) {
            if (result.field === 'baseUrl') {
              const message =
                CUSTOM_BASE_URL_MESSAGES[result.reason] ?? 'Base URL is not valid.';
              setCustomBaseUrlError(message);
              toast.error(message);
            } else if (result.field === 'apiKey') {
              const message =
                CUSTOM_API_KEY_MESSAGES[result.reason] ?? 'API key is not valid.';
              setCustomApiKeyError(message);
              toast.error(message);
            } else {
              // `priority` is derived from list position, not a text control,
              // so there is no field to bind — surface it as a generic error.
              console.error(
                `[Settings] Custom provider priority rejected (${result.reason}); save aborted.`,
              );
              toast.error('Failed to save provider configuration.');
            }
            return;
          }

          configsToSave.push(result.config);
          continue;
        }

        const key = providerKeys[positioned.id];
        const config: ProviderConfig = { ...positioned };
        if (key && key.trim()) {
          config.apiKeyCipher =
            positioned.id === 'ollama' ? key.trim() : await encryptApiKey(key.trim());
        } else {
          delete config.apiKeyCipher;
        }
        configsToSave.push(config);
      }

      await knowledgeBase.setSetting('providers', configsToSave);

      // Reconcile the in-memory list with what was just written. Without this,
      // `providers` keeps the pre-save drafts — most importantly a custom entry
      // whose `apiKeyCipher` is still `undefined` — and the next save with a
      // blank API_Key field would hand that stale entry to
      // `buildCustomConfigForSave` as `previous`, resolving `retainedCipher` to
      // `undefined` and silently dropping the stored credential
      // (Requirement 1.10). Reconciling here also picks up the normalised
      // `baseUrl`, the trimmed `modelId`, and the `index + 1` priorities, so
      // what the panel renders is exactly what is on disk. `acknowledgedEgressAt`
      // survives because `buildCustomConfigForSave` spreads `previous`.
      //
      // Placed after the write so an aborted save (any early `return` above)
      // leaves both IndexedDB and state untouched.
      setProviders(configsToSave.map((config) => ({ ...config })));

      // The save succeeded, so the drafts are now valid and any stale
      // validation state is gone.
      setCustomBaseUrlError(null);
      setCustomApiKeyError(null);
      // Clear the custom API_Key input and record that a cipher now exists, so
      // the masked placeholder takes over and the next save with a blank field
      // retains what was just persisted (Requirements 1.10, 3.1).
      const savedCustom = configsToSave.find((c) => c.id === CUSTOM_PROVIDER_ID);
      if (savedCustom?.apiKeyCipher) {
        setProviderKeys((prev) => ({ ...prev, [CUSTOM_PROVIDER_ID]: '' }));
        setHasStoredKey((prev) => ({ ...prev, [CUSTOM_PROVIDER_ID]: true }));
      }

      if (keyStoredUnencrypted) {
        toast(
          'Provider configuration saved, but the OS credential store was unavailable — the API key is stored unencrypted.',
          { icon: '⚠️' },
        );
      } else {
        toast.success('Provider configuration saved!');
      }
    } catch (error) {
      console.error('[Settings] Failed to save providers:', error);
      toast.error('Failed to save provider configuration.');
    } finally {
      setProvidersSaving(false);
    }
  }, [providers, providerKeys]);

  const handleProfileChange = useCallback(async (newProfile: Profile) => {
    setProfile(newProfile);
    await knowledgeBase.setSetting('profile', newProfile);
    toast.success(`Performance profile set to "${newProfile}"`);
  }, []);

  const handlePrivacyModeChange = useCallback(async (enabled: boolean) => {
    const mode: PrivacyMode = enabled ? 'ephemeral' : 'normal';
    setPrivacyMode(mode);
    await knowledgeBase.setSetting('privacyMode', mode);
    toast.success(enabled
      ? 'Ephemeral mode enabled — meetings will not be saved to disk'
      : 'Ephemeral mode disabled — meetings will be persisted normally'
    );
  }, []);

  // --- Language Handlers ---

  const handleUiLocaleChange = useCallback(async (locale: LocaleCode) => {
    setUiLocale(locale);
    setLocale(locale);
    await knowledgeBase.setSetting('uiLocale', locale);
    toast.success(`UI language set to "${locale}"`);
  }, []);

  const handleRecognitionLanguageChange = useCallback(async (lang: string) => {
    setRecognitionLanguage(lang);
    await knowledgeBase.setSetting('recognitionLanguage', lang);
    toast.success(`Recognition language set to "${lang}"`);
  }, []);

  const handleOcrLanguageChange = useCallback(async (lang: string) => {
    setOcrLanguage(lang);
    await knowledgeBase.setSetting('ocrLanguage', lang);
    toast.success(`OCR language set to "${lang}"`);
  }, []);

  // --- Transcription Handlers (VAD sensitivity, task 11.1) ---

  // Persist the new sensitivity, then broadcast on the
  // `vadSensitivityBus` so any in-flight loopback / microphone capture
  // recomputes its threshold on the next chunk without restarting the
  // capture stream (Requirements 7.2, 7.4 and Property 18). The
  // database read is awaited so a subsequent reload sees the same
  // value that's already live on the bus.
  const handleVadSensitivityChange = useCallback(
    async (level: VADSensitivity) => {
      setVadSensitivity(level);
      try {
        await knowledgeBase.setSetting('vadSensitivity', level);
      } catch (error) {
        console.error('[Settings] Failed to persist VAD sensitivity:', error);
        toast.error('Failed to save transcription sensitivity.');
        return;
      }
      vadSensitivityBus.publish({ type: 'change', value: level });
      toast.success(`Transcription sensitivity set to "${level}"`);
    },
    [],
  );

  // --- Data Retention Handlers ---

  const handleSaveRetention = useCallback(async () => {
    setRetentionSaving(true);
    try {
      await knowledgeBase.setSetting('retention', { meetingMaxAgeDays, transcriptMaxLines });
      toast.success('Retention settings saved!');
    } catch (error) {
      console.error('[Settings] Failed to save retention settings:', error);
      toast.error('Failed to save retention settings.');
    } finally {
      setRetentionSaving(false);
    }
  }, [meetingMaxAgeDays, transcriptMaxLines]);

  const handleRunSweep = useCallback(async () => {
    setSweepRunning(true);
    try {
      const result = await knowledgeBase.enforceRetention({
        maxAgeDays: meetingMaxAgeDays,
        maxLines: transcriptMaxLines,
      });
      toast.success(
        `Sweep complete: ${result.deletedMeetings} meeting(s) deleted, ${result.truncatedMeetings} transcript(s) truncated.`
      );
    } catch (error) {
      console.error('[Settings] Retention sweep failed:', error);
      toast.error('Retention sweep failed.');
    } finally {
      setSweepRunning(false);
    }
  }, [meetingMaxAgeDays, transcriptMaxLines]);

  // --- Redaction Rules Handlers ---

  const buildRedactionRules = useCallback((): RedactionRule[] => {
    const rules: RedactionRule[] = [];
    for (const r of regexRules) {
      if (r.pattern.trim()) {
        rules.push({ kind: 'regex', pattern: r.pattern, flags: r.flags || 'g', replacement: r.replacement });
      }
    }
    for (const entity of enabledEntities) {
      rules.push({ kind: 'entity', entity });
    }
    return rules;
  }, [regexRules, enabledEntities]);

  const handleToggleEntity = useCallback((entity: RedactionEntity) => {
    setEnabledEntities((prev) => {
      const next = new Set(prev);
      if (next.has(entity)) {
        next.delete(entity);
      } else {
        next.add(entity);
      }
      return next;
    });
  }, []);

  const handleAddRegexRule = useCallback(() => {
    setRegexRules((prev) => [...prev, { pattern: '', flags: 'g', replacement: '[REDACTED]' }]);
  }, []);

  const handleRemoveRegexRule = useCallback((index: number) => {
    setRegexRules((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleRegexRuleChange = useCallback((index: number, field: 'pattern' | 'flags' | 'replacement', value: string) => {
    setRegexRules((prev) => prev.map((r, i) => i === index ? { ...r, [field]: value } : r));
  }, []);

  const handleSaveRedactionRules = useCallback(async () => {
    setRedactionSaving(true);
    try {
      const rules = buildRedactionRules();
      await knowledgeBase.setSetting('redactionRules', rules);
      toast.success('Redaction rules saved!');
    } catch (error) {
      console.error('[Settings] Failed to save redaction rules:', error);
      toast.error('Failed to save redaction rules.');
    } finally {
      setRedactionSaving(false);
    }
  }, [buildRedactionRules]);

  const handleTestRedaction = useCallback(() => {
    const rules = buildRedactionRules();
    const result = applyRedaction(redactionTestInput, rules);
    setRedactionTestOutput(result);
  }, [buildRedactionRules, redactionTestInput]);

  const handleSaveKey = () => {
    updateApiKey(localKey);
    setSaved(true);
    toast.success('API Key saved successfully!');
    setTimeout(() => setSaved(false), 2000);
  };

  const handleAddDocument = async (text: string, title: string) => {
    if (!text.trim()) return;

    if (documents.length >= limits.kbDocuments) {
      setUpgradeModal({ reason: 'kb-doc-limit' });
      return;
    }

    setIsUploading(true);
    try {
      const { chunkText } = await import('../utils/documentParser');

      const chunks = chunkText(text);

      // Generate a semantic embedding per chunk so the Knowledge Base is
      // searchable by meaning (not just keywords). Embedding inference runs
      // in the main process via `embed:generateBatch` (one IPC per window
      // of `EMBED_BATCH_SIZE` chunks; design §"Components and Interfaces /
      // Batched Embedding Service" and Requirements 1.5, 1.6). On any
      // batched-call failure we fall back to per-chunk `embed:generate`
      // for that window only, keeping successful windows unchanged
      // (Requirement 1.7). If a per-chunk fallback also throws we store
      // a zero-length vector so the document still persists — the chunk
      // is still keyword-searchable and `database.search` skips empty
      // vectors.
      const { vectorStore } = await import('../brain/vectorStore');

      const batchBridge =
        typeof window !== 'undefined' ? window.electronAPI?.embedGenerateBatch : undefined;

      const vectors: number[][] = new Array<number[]>(chunks.length);
      const windows = chunkArray(chunks, EMBED_BATCH_SIZE);

      let cursor = 0;
      for (const win of windows) {
        const offset = cursor;
        cursor += win.length;
        const t0 = performance.now();
        try {
          if (typeof batchBridge !== 'function') {
            // No batched bridge available (e.g. non-Electron runtime);
            // jump straight to the per-chunk fallback for this window.
            throw new Error('embedGenerateBatch bridge unavailable');
          }
          const { vectors: batchVectors } = await batchBridge(win);
          for (let i = 0; i < win.length; i++) {
            vectors[offset + i] = batchVectors[i] ?? [];
          }
          // Telemetry: one `embed.batch` event per resolved batched IPC
          // carrying `batchSize` and `durationMs` (Requirement 10.1,
          // Property 19). Emitted only on the success path so the
          // `batchSize` field always equals the input window length and
          // `durationMs` reflects a real batched-IPC measurement.
          telemetry.emit({
            kind: 'embed.batch',
            batchSize: win.length,
            durationMs: performance.now() - t0,
          });
        } catch (batchErr) {
          // Per-batch try/catch fallback: fall through to per-chunk
          // `embed:generate` for the chunks in this window only.
          // Successful earlier/later windows retain their batched
          // vectors (Requirement 1.7).
          console.warn('[Settings] batched embedding failed; falling back to per-chunk:', batchErr);
          for (let i = 0; i < win.length; i++) {
            try {
              vectors[offset + i] = await vectorStore.generateEmbedding(win[i]);
            } catch (chunkErr) {
              console.warn('[Settings] per-chunk embedding failed; storing text-only chunk:', chunkErr);
              vectors[offset + i] = [];
            }
          }
        }
      }

      const chunksWithVectors = chunks.map((chunk, i) => ({
        text: chunk,
        vector: vectors[i] ?? [],
      }));

      const persisted = await knowledgeBase.addDocument(
        title || newDocTitle || 'Untitled Document',
        text,
        newDocType,
        chunksWithVectors,
      );

      // After persistence, push the new chunks into the main-process
      // Vector_Index so the next `database.search` finds them via the
      // ANN path above `QUANTIZATION_THRESHOLD` (Requirement 2.5).
      // Each chunk is decoded via `dequantizeFromStorage` so the IPC
      // payload is always a Float32 `number[]` regardless of whether
      // the chunk was persisted raw or int8-quantized (Requirement 4.1,
      // design §"Quantized-storage compatibility"). The id shape matches
      // `vectorIndexHydration.ts::chunkIndexId` so add / remove / query
      // all agree on `${docId}#${chunkIndex}`. Empty vectors (e.g.
      // fallback chunks where every embedding attempt failed) are
      // filtered out so the native HNSW addon never sees a zero-length
      // input. Failures are non-fatal: the linear-scan fallback below
      // the threshold and the cold-start rebuild on next boot keep
      // correctness intact, so a transient index hiccup must not block
      // the upload UX.
      const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
      if (typeof api?.vectorIndexAddBatch === 'function') {
        try {
          const items = persisted.chunks
            .map((chunk, i) => ({
              id: chunkIndexId(persisted.id, i),
              vector: dequantizeFromStorage(chunk),
            }))
            .filter((item) => item.vector.length > 0);
          if (items.length > 0) {
            await api.vectorIndexAddBatch(items);
          }
        } catch (indexErr) {
          console.warn('[Settings] vectorIndex:addBatch failed:', indexErr);
        }
      }

      const updated = await knowledgeBase.getAllDocuments();
      setDocuments(updated);
      setNewDocTitle('');
      setNewDocContent('');
      setShowAddDoc(false);
      toast.success('Document added to Knowledge Base!');
    } catch (error) {
      console.error('Failed to parse document:', error);
      toast.error('Failed to parse document.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!SUPPORTED_DOC_EXTENSIONS.has(ext)) {
      // Reject extensions outside {txt,md,json,pdf,docx} via toast (no `alert`).
      // (Requirement 18.7, 25.3.)
      notifyError({ kind: 'document.unsupported-extension', ext });
      return;
    }

    setIsUploading(true);
    setNewDocTitle(file.name);
    try {
      const { parseDocument } = await import('../utils/documentParser');
      const result = await parseDocument(file);
      if (result.ok === false) {
        // Typed recoverable error — surface via the centralised toast hook
        // (Requirement 18.7, 25.1, 25.3).
        notifyError(result.error);
        setIsUploading(false);
        return;
      }
      const text = result.value;
      setNewDocContent(text);
      // Automatically add it after parsing
      await handleAddDocument(text, file.name);
    } catch (err) {
      // Dev-only breadcrumb; user-facing surface flows through useZuleError.
      console.error('Upload failed:', err);
      notifyError({ kind: 'document.unsupported-extension', ext });
      setIsUploading(false);
    }
  };

  const handleDeleteDocument = async (id: string) => {
    await knowledgeBase.removeDocument(id);
    const updated = await knowledgeBase.getAllDocuments();
    setDocuments(updated);
    toast.success('Document removed!');
  };

  const handleSaveCustomMode = async () => {
    if (!newModeLabel.trim() || !newModePrompt.trim()) return;

    if (customModes.length >= limits.customModes) {
      setUpgradeModal({ reason: 'feature-locked', feature: 'copilot.custom-modes' });
      return;
    }

    await saveCustomMode({
      id: `mode-${Date.now()}`,
      label: newModeLabel,
      description: newModeDesc,
      icon: newModeIcon,
      systemPrompt: newModePrompt,
      createdAt: Date.now()
    });

    setNewModeLabel('');
    setNewModeDesc('');
    setNewModeIcon('Wand2');
    setNewModePrompt('');
    setShowAddMode(false);
    toast.success('Custom mode created!');
  };

  const docTypeLabels: Record<KBDocument['type'], string> = {
    'resume': 'Resume',
    'project': 'Project Notes',
    'job-description': 'Job Description',
    'notes': 'Notes',
    'sales-script': 'Sales Script',
    'custom': 'Custom',
  };

  const docTypeColors: Record<KBDocument['type'], string> = {
    'resume': 'pill-blue',
    'project': 'pill-green',
    'job-description': 'pill-purple',
    'notes': 'pill-yellow',
    'sales-script': 'pill-red',
    'custom': 'pill-blue',
  };

  return (
    <div className="settings page-container">
      <h1 className="settings-title animate-slide-up">Settings</h1>

      {upgradeModal && (
        <UpgradeModal
          reason={upgradeModal.reason}
          feature={upgradeModal.feature}
          onClose={() => setUpgradeModal(null)}
        />
      )}

      {/* AI Configuration */}
      <section className="settings-section glass-card animate-slide-up">
        <div className="section-header">
          <Key size={18} />
          <h2>AI Configuration</h2>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="setting-name">Gemini API Key</span>
            <span className="setting-desc">Enter your Google Gemini API key for real-time AI responses. Without a key, Zule uses simulation mode.</span>
          </div>
          <div className="setting-input-group">
            <div className="api-key-input">
              <input
                type={showKey ? 'text' : 'password'}
                className="input-glass"
                placeholder="Enter your Gemini API key..."
                value={localKey}
                onChange={(e) => setLocalKey(e.target.value)}
              />
              <button className="btn-icon key-toggle" onClick={() => setShowKey(!showKey)}>
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <button
              className={`btn-primary ${saved ? 'saved' : ''}`}
              onClick={handleSaveKey}
              style={{ padding: '8px 20px', fontSize: '0.82rem' }}
            >
              {saved ? <><CheckCircle2 size={14} /> Saved!</> : 'Save Key'}
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="setting-name">AI Status</span>
          </div>
          <span className={`pill ${apiKey ? 'pill-green' : 'pill-yellow'}`}>
            {apiKey ? '🟢 Gemini API Active' : '🟡 Simulation Mode'}
          </span>
        </div>
      </section>

      {/* AI Providers */}
      <section className="settings-section glass-card animate-slide-up" style={{ animationDelay: '0.05s' }}>
        <div className="section-header">
          <Server size={18} />
          <h2>AI Providers</h2>
        </div>
        <p className="section-desc">
          Configure multiple AI providers with failover priority. Providers are tried in the order shown below.
          Drag or use arrows to rearrange priority.
        </p>

        <div className="providers-list">
          {providers.map((provider, index) => {
            // The custom entry's enable toggle stays disabled until the
            // data-egress notice is acknowledged (Requirement 1.4). Every other
            // provider is ungated.
            const egressGated =
              provider.id === CUSTOM_PROVIDER_ID && provider.acknowledgedEgressAt == null;

            return (
              <div key={provider.id} className={`provider-card ${provider.enabled ? '' : 'provider-disabled'}`}>
                <div className="provider-priority">
                  <span className="priority-number">{index + 1}</span>
                  <div className="priority-arrows">
                    <button
                      className="btn-icon priority-arrow"
                      onClick={() => handleMoveProvider(index, 'up')}
                      disabled={index === 0}
                      aria-label={`Move ${PROVIDER_LABELS[provider.id]} up`}
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      className="btn-icon priority-arrow"
                      onClick={() => handleMoveProvider(index, 'down')}
                      disabled={index === providers.length - 1}
                      aria-label={`Move ${PROVIDER_LABELS[provider.id]} down`}
                    >
                      <ArrowDown size={12} />
                    </button>
                  </div>
                </div>

                <div className="provider-info">
                  <div className="provider-header">
                    <span className="provider-name">{PROVIDER_LABELS[provider.id]}</span>
                    <span className={`pill ${provider.enabled ? 'pill-green' : 'pill-yellow'}`}>
                      {provider.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                  <span className="provider-desc">{PROVIDER_DESCRIPTIONS[provider.id]}</span>

                  {/* API Key input — not shown for simulation */}
                  {provider.id !== 'simulation' && (
                    <div className="provider-key-row">
                      {provider.id === CUSTOM_PROVIDER_ID ? (
                        /* Custom (OpenAI-compatible): three separate controls
                           (Requirement 1.2). Each label is associated with its
                           input via htmlFor/id, and the Base_URL control binds
                           aria-invalid plus aria-describedby to the inline
                           validation message (Requirement 1.8). */
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '10px',
                            width: '100%',
                            maxWidth: '340px',
                          }}
                        >
                          {/* Persistent data-egress disclosure plus the
                            acknowledgement that unlocks the enable toggle
                            (Requirement 1.4). It is never dismissible: the
                            endpoint can change at any time. */}
                          <div style={CUSTOM_EGRESS_NOTICE_STYLE}>
                            <p id={CUSTOM_EGRESS_NOTICE_ID} style={{ margin: 0 }}>
                              <ShieldCheck
                                size={13}
                                style={{ verticalAlign: '-2px', marginRight: '5px' }}
                                aria-hidden="true"
                              />
                              {CUSTOM_EGRESS_NOTICE_TEXT}
                            </p>
                            <span
                              style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: '7px',
                              }}
                            >
                              <input
                                id={CUSTOM_EGRESS_ACK_ID}
                                type="checkbox"
                                checked={provider.acknowledgedEgressAt != null}
                                onChange={(e) => handleCustomEgressAckChange(e.target.checked)}
                                aria-describedby={CUSTOM_EGRESS_NOTICE_ID}
                                style={{ marginTop: '2px', flex: '0 0 auto' }}
                              />
                              <label
                                htmlFor={CUSTOM_EGRESS_ACK_ID}
                                style={{ fontSize: '0.74rem', fontWeight: 600, cursor: 'pointer' }}
                              >
                                {CUSTOM_EGRESS_ACK_LABEL}
                              </label>
                            </span>
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <label htmlFor="custom-provider-base-url" style={CUSTOM_FIELD_LABEL_STYLE}>
                              Base URL
                            </label>
                            <div className="api-key-input provider-key-input">
                              <input
                                id="custom-provider-base-url"
                                type="text"
                                maxLength={MAX_BASE_URL_LENGTH}
                                className="input-glass"
                                placeholder="https://openrouter.ai/api/v1"
                                value={provider.baseUrl || ''}
                                onChange={(e) => handleCustomBaseUrlChange(e.target.value)}
                                aria-invalid={customBaseUrlError !== null}
                                aria-describedby={
                                  customBaseUrlError !== null ? 'custom-provider-base-url-error' : undefined
                                }
                              />
                            </div>
                            {customBaseUrlError !== null && (
                              <span
                                id="custom-provider-base-url-error"
                                role="alert"
                                style={{ fontSize: '0.72rem', color: 'var(--accent-red)' }}
                              >
                                {customBaseUrlError}
                              </span>
                            )}
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <label htmlFor="custom-provider-api-key" style={CUSTOM_FIELD_LABEL_STYLE}>
                              API key
                            </label>
                            <div className="api-key-input provider-key-input">
                              <input
                                id="custom-provider-api-key"
                                type={showProviderKey[provider.id] ? 'text' : 'password'}
                                maxLength={MAX_API_KEY_LENGTH}
                                className="input-glass"
                                placeholder={
                                  hasStoredKey[CUSTOM_PROVIDER_ID]
                                    ? CUSTOM_KEY_SAVED_PLACEHOLDER
                                    : 'Enter API key...'
                                }
                                value={providerKeys[provider.id] || ''}
                                onChange={(e) => handleCustomApiKeyChange(e.target.value)}
                                aria-invalid={customApiKeyError !== null}
                                aria-describedby={
                                  customApiKeyError !== null ? 'custom-provider-api-key-error' : undefined
                                }
                              />
                              <button
                                className="btn-icon key-toggle"
                                onClick={() => handleToggleProviderKeyVisibility(provider.id)}
                                aria-label={showProviderKey[provider.id] ? 'Hide key' : 'Show key'}
                              >
                                {showProviderKey[provider.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                              </button>
                            </div>
                            {customApiKeyError !== null && (
                              <span
                                id="custom-provider-api-key-error"
                                role="alert"
                                style={{ fontSize: '0.72rem', color: 'var(--accent-red)' }}
                              >
                                {customApiKeyError}
                              </span>
                            )}
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <label htmlFor="custom-provider-model-id" style={CUSTOM_FIELD_LABEL_STYLE}>
                              Model ID
                            </label>
                            <div className="api-key-input provider-key-input">
                              <input
                                id="custom-provider-model-id"
                                type="text"
                                maxLength={MAX_MODEL_ID_LENGTH}
                                className="input-glass"
                                placeholder="meta-llama/llama-3.1-8b-instruct"
                                value={provider.modelId || ''}
                                onChange={(e) => handleCustomModelIdChange(e.target.value)}
                              />
                            </div>
                          </div>
                        </div>
                      ) : provider.id === 'ollama' ? (
                        <div style={{ display: 'flex', gap: '10px', width: '100%', flexWrap: 'wrap' }}>
                          <div className="api-key-input provider-key-input" style={{ flex: '1 1 200px' }}>
                            <input
                              type="text"
                              className="input-glass"
                              placeholder="Base URL (e.g. http://localhost:11434)"
                              value={provider.baseUrl || ''}
                              onChange={(e) => handleProviderUrlChange(provider.id, e.target.value)}
                            />
                          </div>
                          <div className="api-key-input provider-key-input" style={{ flex: '1 1 200px' }}>
                            <input
                              type="text"
                              className="input-glass"
                              placeholder="Model ID (e.g. llama3.1:8b)"
                              value={providerKeys[provider.id] || ''}
                              onChange={(e) => handleProviderKeyChange(provider.id, e.target.value)}
                            />
                          </div>
                        </div>
                      ) : provider.id === 'anthropic' ? (
                        /* Anthropic Claude: supports a configurable base URL and model
                           so users can point at Anthropic-compatible gateways (e.g.
                           api.lumosel.vip). Base URL and Model ID are optional — omitting
                           them uses the defaults (api.anthropic.com, claude-3-5-sonnet). */
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', maxWidth: '340px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <label htmlFor="anthropic-base-url" style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                              Base URL <span style={{ fontWeight: 400, opacity: 0.7 }}>(optional — leave blank for api.anthropic.com)</span>
                            </label>
                            <div className="api-key-input provider-key-input">
                              <input
                                id="anthropic-base-url"
                                type="text"
                                className="input-glass"
                                placeholder="https://api.anthropic.com/v1/messages"
                                value={provider.baseUrl || ''}
                                onChange={(e) => handleProviderUrlChange(provider.id, e.target.value)}
                              />
                            </div>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <label htmlFor="anthropic-api-key" style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                              API Key
                            </label>
                            <div className="api-key-input provider-key-input">
                              <input
                                id="anthropic-api-key"
                                type={showProviderKey[provider.id] ? 'text' : 'password'}
                                className="input-glass"
                                placeholder="Enter Anthropic API key..."
                                value={providerKeys[provider.id] || ''}
                                onChange={(e) => handleProviderKeyChange(provider.id, e.target.value)}
                              />
                              <button
                                className="btn-icon key-toggle"
                                onClick={() => handleToggleProviderKeyVisibility(provider.id)}
                                aria-label={showProviderKey[provider.id] ? 'Hide key' : 'Show key'}
                              >
                                {showProviderKey[provider.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                              </button>
                            </div>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <label htmlFor="anthropic-model-id" style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                              Model ID <span style={{ fontWeight: 400, opacity: 0.7 }}>(optional — default: claude-3-5-sonnet)</span>
                            </label>
                            <div className="api-key-input provider-key-input">
                              <input
                                id="anthropic-model-id"
                                type="text"
                                className="input-glass"
                                placeholder="claude-sonnet-4-20250514"
                                value={provider.modelId || ''}
                                onChange={(e) => handleProviderModelChange(provider.id, e.target.value)}
                              />
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="api-key-input provider-key-input">
                          <input
                            type={showProviderKey[provider.id] ? 'text' : 'password'}
                            className="input-glass"
                            placeholder={`Enter ${PROVIDER_LABELS[provider.id]} API key...`}
                            value={providerKeys[provider.id] || ''}
                            onChange={(e) => handleProviderKeyChange(provider.id, e.target.value)}
                          />
                          <button
                            className="btn-icon key-toggle"
                            onClick={() => handleToggleProviderKeyVisibility(provider.id)}
                            aria-label={showProviderKey[provider.id] ? 'Hide key' : 'Show key'}
                          >
                            {showProviderKey[provider.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                      )}

                      {/* Per-provider Connection Test */}
                      {provider.id !== 'simulation' && (
                        <div
                          style={{
                            marginTop: '8px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            flexWrap: 'wrap',
                          }}
                        >
                          <button
                            className="btn-secondary"
                            onClick={() => handleTestProviderConnection(provider.id)}
                            disabled={
                              !canTestProviderConnection(provider.id) ||
                              providerTestStatus[provider.id]?.state === 'testing'
                            }
                            aria-busy={providerTestStatus[provider.id]?.state === 'testing'}
                            aria-label={`Test connection to ${PROVIDER_LABELS[provider.id] ?? provider.id}`}
                            style={{
                              padding: '4px 10px',
                              fontSize: '0.75rem',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                            }}
                          >
                            <Play size={11} aria-hidden="true" />
                            {providerTestStatus[provider.id]?.state === 'testing'
                              ? 'Testing…'
                              : 'Test connection'}
                          </button>
                          {providerTestStatus[provider.id] && (
                            <span
                              role="status"
                              aria-live="polite"
                              className={
                                providerTestStatus[provider.id]?.state === 'ok'
                                  ? 'pill pill-green'
                                  : providerTestStatus[provider.id]?.state === 'failed'
                                    ? 'pill pill-red'
                                    : 'pill pill-yellow'
                              }
                              style={{ fontSize: '0.72rem' }}
                            >
                              {providerTestStatus[provider.id]?.state === 'testing'
                                ? 'Testing connection…'
                                : (providerTestStatus[provider.id] as { message?: string } | undefined)?.message}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <button
                  className={`btn-icon provider-toggle ${provider.enabled ? 'provider-toggle-on' : ''}`}
                  onClick={() => handleToggleProvider(provider.id)}
                  disabled={egressGated}
                  title={egressGated ? CUSTOM_EGRESS_TOGGLE_HINT : undefined}
                  aria-describedby={egressGated ? CUSTOM_EGRESS_NOTICE_ID : undefined}
                  aria-label={
                    egressGated
                      ? `Enable ${PROVIDER_LABELS[provider.id]} — ${CUSTOM_EGRESS_TOGGLE_HINT}`
                      : `${provider.enabled ? 'Disable' : 'Enable'} ${PROVIDER_LABELS[provider.id]}`
                  }
                >
                  <Power size={16} />
                </button>
              </div>
            );
          })}
        </div>

        <div
          className="provider-actions"
          style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}
        >
          <button
            className="btn-primary"
            onClick={handleSaveProviders}
            disabled={providersSaving}
            style={{ padding: '8px 20px', fontSize: '0.82rem' }}
          >
            {providersSaving ? 'Saving...' : 'Save Provider Config'}
          </button>
        </div>
      </section>

      {/* Knowledge Base */}
      <section className="settings-section glass-card animate-slide-up" style={{ animationDelay: '0.1s' }}>
        <div className="section-header">
          <Database size={18} />
          <h2>Knowledge Base</h2>
          <button className="btn-secondary" onClick={() => setShowAddDoc(!showAddDoc)} style={{ marginLeft: 'auto', padding: '6px 14px', fontSize: '0.78rem' }}>
            <Plus size={14} />
            Add Document
          </button>
        </div>

        <p className="section-desc">
          Upload your resume, project notes, or job descriptions. Zule will use them to personalize every AI response.
        </p>

        {/* Add Document Form */}
        {showAddDoc && (
          <div className="add-doc-form animate-fade-in">
            <input
              type="text"
              className="input-glass"
              placeholder="Document title (e.g., 'My Resume')"
              value={newDocTitle}
              onChange={(e) => setNewDocTitle(e.target.value)}
            />
            <select
              className="input-glass doc-type-select"
              value={newDocType}
              onChange={(e) => setNewDocType(e.target.value as KBDocument['type'])}
            >
              {Object.entries(docTypeLabels).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
              <option value="notes">Meeting Notes</option>
              <option value="sales-script">Sales Script</option>
              <option value="custom">Custom Document</option>
            </select>

            <div className="file-upload-wrapper" style={{ marginTop: '10px', marginBottom: '10px' }}>
              <input
                type="file"
                id="doc-upload"
                accept=".pdf,.docx,.txt,.md,.json"
                onChange={handleFileUpload}
                style={{ display: 'none' }}
              />
              <label htmlFor="doc-upload" className="btn-secondary" style={{ width: '100%', justifyContent: 'center', borderStyle: 'dashed' }}>
                <Upload size={16} />
                Upload PDF, DOCX, or TXT
              </label>
            </div>

            <textarea
              className="input-glass"
              placeholder="Or paste document content here..."
              value={newDocContent}
              onChange={(e) => setNewDocContent(e.target.value)}
              rows={4}
            />
            <div className="form-actions">
              <button className="btn-secondary" onClick={() => setShowAddDoc(false)}>Cancel</button>
              <button
                className="btn-primary"
                onClick={() => handleAddDocument(newDocContent, newDocTitle)}
                disabled={isUploading || !newDocContent.trim()}
              >
                {isUploading ? <><Database size={14} className="animate-spin" /> Processing...</> : 'Save Document'}
              </button>
            </div>
          </div>
        )}

        {/* Document List */}
        <div className="kb-documents">
          {documents.length === 0 ? (
            <div className="kb-empty">
              <FileText size={24} />
              <p>No documents yet. Add your resume or notes to personalize AI responses.</p>
            </div>
          ) : (
            documents.map(doc => (
              <div key={doc.id} className="kb-doc-card">
                <div className="kb-doc-info">
                  <div className="kb-doc-header">
                    <span className="kb-doc-title">{doc.title}</span>
                    <span className={`pill ${docTypeColors[doc.type]}`}>{docTypeLabels[doc.type]}</span>
                  </div>
                  <span className="kb-doc-meta">
                    {doc.chunks.length} chunks • {doc.content.split(/\s+/).length} words • Added {new Date(doc.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <button className="btn-icon" onClick={() => handleDeleteDocument(doc.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Custom Modes */}
      <section className="settings-section glass-card animate-slide-up" style={{ animationDelay: '0.15s' }}>
        <div className="section-header">
          <Wand2 size={18} />
          <h2>Custom AI Modes</h2>
          <button className="btn-secondary" onClick={() => setShowAddMode(!showAddMode)} style={{ marginLeft: 'auto', padding: '6px 14px', fontSize: '0.78rem' }}>
            <Plus size={14} />
            Create Mode
          </button>
        </div>

        <p className="section-desc">
          Design your own AI copilots for specific meetings, interviews, or roles.
        </p>

        {showAddMode && (
          <div className="add-doc-form animate-fade-in">
            <input
              type="text"
              className="input-glass"
              placeholder="Mode Name (e.g., 'Pirate Mode')"
              value={newModeLabel}
              onChange={(e) => setNewModeLabel(e.target.value)}
            />
            <input
              type="text"
              className="input-glass"
              placeholder="Description (e.g., 'Speaks like a pirate')"
              value={newModeDesc}
              onChange={(e) => setNewModeDesc(e.target.value)}
              style={{ marginTop: '10px' }}
            />
            <input
              type="text"
              className="input-glass"
              placeholder="Icon name from Lucide (e.g., 'Skull')"
              value={newModeIcon}
              onChange={(e) => setNewModeIcon(e.target.value)}
              style={{ marginTop: '10px' }}
            />
            <textarea
              className="input-glass"
              placeholder="System Prompt (e.g., 'You are a pirate. Yarr! Be concise.')"
              value={newModePrompt}
              onChange={(e) => setNewModePrompt(e.target.value)}
              style={{ marginTop: '10px', minHeight: '80px', resize: 'vertical' }}
            />
            <div style={{ marginTop: '15px', display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={() => setShowAddMode(false)}>Cancel</button>
              <button
                className="btn-primary"
                onClick={handleSaveCustomMode}
                disabled={!newModeLabel.trim() || !newModePrompt.trim()}
              >
                Save Mode
              </button>
            </div>
          </div>
        )}

        <div className="kb-list">
          {customModes.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon"><Wand2 size={24} /></span>
              <p>No custom modes yet</p>
            </div>
          ) : (
            customModes.map(mode => (
              <div key={mode.id} className="kb-doc-item animate-fade-in">
                <div className="kb-doc-icon">
                  <Wand2 size={16} />
                </div>
                <div className="kb-doc-info">
                  <div className="kb-doc-header">
                    <span className="kb-doc-title">{mode.label}</span>
                    <span className="pill pill-purple">{mode.icon}</span>
                  </div>
                  <span className="kb-doc-meta">
                    {mode.description}
                  </span>
                </div>
                <button className="btn-icon" onClick={() => {
                  deleteCustomMode(mode.id);
                  toast.success('Custom mode deleted!');
                }}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Appearance */}
      <section className="settings-section glass-card animate-slide-up" style={{ animationDelay: '0.2s' }}>
        <div className="section-header">
          <Palette size={18} />
          <h2>Appearance</h2>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="setting-name">Theme</span>
          </div>
          <div className="theme-toggle">
            <button
              className={`theme-btn ${theme === 'dark' ? 'active' : ''}`}
              onClick={() => updateTheme('dark')}
            >
              <Moon size={14} />
              Dark
            </button>
            <button
              className={`theme-btn ${theme === 'light' ? 'active' : ''}`}
              onClick={() => updateTheme('light')}
            >
              <Sun size={14} />
              Light
            </button>
          </div>
        </div>
      </section>

      {/* Language */}
      <section className="settings-section glass-card animate-slide-up" style={{ animationDelay: '0.22s' }}>
        <div className="section-header">
          <Globe size={18} />
          <h2>Language</h2>
        </div>
        <p className="section-desc">
          Configure the UI language, speech recognition language, and OCR language independently.
        </p>

        <div className="setting-row">
          <div className="setting-label">
            <span className="setting-name">UI Locale</span>
            <span className="setting-desc">Language used for all interface text.</span>
          </div>
          <select
            className="input-glass"
            value={uiLocale}
            onChange={(e) => handleUiLocaleChange(e.target.value as LocaleCode)}
            aria-label="UI Locale"
            style={{ maxWidth: '200px' }}
          >
            {getSupportedLocales().map((loc) => (
              <option key={loc} value={loc}>{loc}</option>
            ))}
          </select>
        </div>

        <div className="setting-row">
          <div className="setting-label">
            <span className="setting-name">Recognition Language</span>
            <span className="setting-desc">BCP-47 language tag for the speech recognizer.</span>
          </div>
          <select
            className="input-glass"
            value={recognitionLanguage}
            onChange={(e) => handleRecognitionLanguageChange(e.target.value)}
            aria-label="Recognition Language"
            style={{ maxWidth: '200px' }}
          >
            <option value="en-US">English (US)</option>
            <option value="en-GB">English (UK)</option>
            <option value="es-ES">Spanish (Spain)</option>
            <option value="es-MX">Spanish (Mexico)</option>
            <option value="fr-FR">French</option>
            <option value="de-DE">German</option>
            <option value="ja-JP">Japanese</option>
            <option value="zh-CN">Chinese (Simplified)</option>
            <option value="zh-TW">Chinese (Traditional)</option>
            <option value="ko-KR">Korean</option>
            <option value="pt-BR">Portuguese (Brazil)</option>
            <option value="it-IT">Italian</option>
          </select>
        </div>

        <div className="setting-row">
          <div className="setting-label">
            <span className="setting-name">OCR Language</span>
            <span className="setting-desc">Tesseract language code for screen text extraction.</span>
          </div>
          <select
            className="input-glass"
            value={ocrLanguage}
            onChange={(e) => handleOcrLanguageChange(e.target.value)}
            aria-label="OCR Language"
            style={{ maxWidth: '200px' }}
          >
            <option value="eng">English</option>
            <option value="spa">Spanish</option>
            <option value="fra">French</option>
            <option value="deu">German</option>
            <option value="jpn">Japanese</option>
            <option value="chi_sim">Chinese (Simplified)</option>
            <option value="chi_tra">Chinese (Traditional)</option>
            <option value="kor">Korean</option>
            <option value="por">Portuguese</option>
            <option value="ita">Italian</option>
          </select>
        </div>
      </section>

      {/* Transcription (VAD sensitivity — task 11.1, Requirement 7.1) */}
      <section className="settings-section glass-card animate-slide-up" style={{ animationDelay: '0.23s' }}>
        <div className="section-header">
          <Mic size={18} />
          <h2>Transcription</h2>
        </div>
        <p className="section-desc">
          Adjust how aggressively the loopback and microphone pipelines
          filter out silence before sending audio to the local Whisper
          engine. Higher sensitivity skips more silent chunks; lower
          sensitivity transcribes more borderline audio.
        </p>

        <div className="setting-row">
          <div className="setting-label">
            <span className="setting-name">VAD Sensitivity</span>
            <span className="setting-desc">
              {transcriptionSupport.supported
                ? 'Live changes take effect on the next captured chunk without restarting capture.'
                : transcriptionSupport.reason}
            </span>
          </div>
          <div
            className="theme-toggle"
            role="radiogroup"
            aria-label="VAD sensitivity"
          >
            {(['low', 'medium', 'high'] as const).map((level) => (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={vadSensitivity === level}
                className={`theme-btn ${vadSensitivity === level ? 'active' : ''}`}
                onClick={() => handleVadSensitivityChange(level)}
                disabled={!transcriptionSupport.supported}
              >
                {level.charAt(0).toUpperCase() + level.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Keyboard Shortcuts */}
      <section className="settings-section glass-card animate-slide-up" style={{ animationDelay: '0.25s' }}>
        <div className="section-header">
          <Keyboard size={18} />
          <h2>Keyboard Shortcuts</h2>
        </div>
        <div className="shortcuts-table">
          {SHORTCUT_DEFINITIONS.map((shortcut, i) => (
            <div key={i} className="shortcut-row">
              <span className="shortcut-desc">{shortcut.description}</span>
              <kbd className="shortcut-key">
                {'ctrl' in shortcut && shortcut.ctrl && <span>{getModifierKey()}</span>}
                {'shift' in shortcut && shortcut.shift && <span>Shift</span>}
                {'alt' in shortcut && shortcut.alt && <span>{getAltKey()}</span>}
                <span>{shortcut.key}</span>
              </kbd>
            </div>
          ))}
        </div>
      </section>

      {/* Platform Limitations (Req 12.1) */}
      {(() => {
        const limitations = getPlatformLimitations();
        if (limitations.length === 0) return null;
        return (
          <section className="settings-section glass-card animate-slide-up" style={{ animationDelay: '0.26s' }}>
            <div className="section-header">
              <Globe size={18} />
              <h2>Platform Limitations</h2>
            </div>
            <p className="section-desc">
              The following features are not fully supported on your platform.
            </p>
            <div className="shortcuts-table">
              {limitations.map((lim, i) => (
                <div key={i} className="shortcut-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
                  <span className="setting-name">{lim.feature} <span className="pill pill-yellow" style={{ marginLeft: '8px' }}>{lim.platform}</span></span>
                  <span className="setting-desc">{lim.reason}</span>
                </div>
              ))}
            </div>
          </section>
        );
      })()}

      {/* Performance Profile */}
      <section className="settings-section glass-card animate-slide-up" style={{ animationDelay: '0.28s' }}>
        <div className="section-header">
          <Gauge size={18} />
          <h2>Performance Profile</h2>
        </div>
        <p className="section-desc">
          Choose a profile that biases the system toward speed, cost-efficiency, or privacy. This affects model selection, confidence thresholds, and caching behavior.
        </p>
        <div className="profile-selector" role="radiogroup" aria-label="Performance profile">
          {(['speed', 'balanced', 'cost', 'privacy'] as const).map((p) => (
            <label key={p} className={`profile-option ${profile === p ? 'active' : ''}`}>
              <input
                type="radio"
                name="profile"
                value={p}
                checked={profile === p}
                onChange={() => handleProfileChange(p)}
                className="profile-radio"
              />
              <span className="profile-label">{p.charAt(0).toUpperCase() + p.slice(1)}</span>
              <span className="profile-desc">
                {p === 'speed' && 'Fastest model, lower confidence threshold'}
                {p === 'balanced' && 'Default — balanced latency and cost'}
                {p === 'cost' && 'Cheapest model, wider cache similarity'}
                {p === 'privacy' && 'Local models only, no cloud providers'}
              </span>
            </label>
          ))}
        </div>

        {/* Ephemeral Mode Toggle */}
        <div className="setting-row" style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="setting-label">
            <span className="setting-name"><Lock size={14} style={{ display: 'inline', marginRight: '6px', verticalAlign: 'middle' }} />Ephemeral Mode</span>
            <span className="setting-desc">
              When enabled, meetings are not saved to disk. Transcripts and summaries stay only in memory until the session ends.
            </span>
          </div>
          <button
            className={`ephemeral-toggle ${privacyMode === 'ephemeral' ? 'active' : ''}`}
            onClick={() => handlePrivacyModeChange(privacyMode !== 'ephemeral')}
            role="switch"
            aria-checked={privacyMode === 'ephemeral'}
            aria-label="Toggle ephemeral mode"
          >
            <span className="toggle-knob" />
          </button>
        </div>
        {privacyMode === 'ephemeral' && (
          <div className="ephemeral-warning animate-fade-in">
            ⚠️ Ephemeral mode is active — no meeting data will be persisted.
          </div>
        )}
      </section>

      {/* Redaction Rules */}
      <section className="settings-section glass-card animate-slide-up" style={{ animationDelay: '0.29s' }}>
        <div className="section-header">
          <ShieldCheck size={18} />
          <h2>Redaction Rules</h2>
        </div>
        <p className="section-desc">
          Configure what sensitive data is automatically redacted before text is sent to cloud AI providers. Entity classes use built-in patterns; custom regex rules let you define your own.
        </p>

        {/* Built-in Entity Classes */}
        <div className="redaction-entities">
          <span className="setting-name" style={{ marginBottom: '8px', display: 'block' }}>Entity Classes</span>
          <div className="entity-toggles">
            {BUILT_IN_ENTITIES.map(({ id, label }) => (
              <button
                key={id}
                className={`entity-toggle-btn ${enabledEntities.has(id) ? 'active' : ''}`}
                onClick={() => handleToggleEntity(id)}
                aria-pressed={enabledEntities.has(id)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Custom Regex Rules */}
        <div className="redaction-regex-rules" style={{ marginTop: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span className="setting-name">Custom Regex Rules</span>
            <button className="btn-secondary" onClick={handleAddRegexRule} style={{ padding: '4px 12px', fontSize: '0.78rem' }}>
              <Plus size={12} />
              Add Rule
            </button>
          </div>
          {regexRules.length === 0 ? (
            <p className="section-desc" style={{ margin: 0 }}>No custom rules defined.</p>
          ) : (
            <div className="regex-rules-list">
              {regexRules.map((rule, index) => (
                <div key={index} className="regex-rule-row">
                  <input
                    type="text"
                    className="input-glass"
                    placeholder="Pattern (e.g., \bSSN\b)"
                    value={rule.pattern}
                    onChange={(e) => handleRegexRuleChange(index, 'pattern', e.target.value)}
                    style={{ flex: 2 }}
                  />
                  <input
                    type="text"
                    className="input-glass"
                    placeholder="Flags"
                    value={rule.flags}
                    onChange={(e) => handleRegexRuleChange(index, 'flags', e.target.value)}
                    style={{ flex: 0.5, minWidth: '50px' }}
                  />
                  <input
                    type="text"
                    className="input-glass"
                    placeholder="Replacement"
                    value={rule.replacement}
                    onChange={(e) => handleRegexRuleChange(index, 'replacement', e.target.value)}
                    style={{ flex: 1.5 }}
                  />
                  <button className="btn-icon" onClick={() => handleRemoveRegexRule(index)} aria-label="Remove rule">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Test Redaction */}
        <div className="redaction-test" style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <span className="setting-name" style={{ marginBottom: '8px', display: 'block' }}>Test Redaction</span>
          <textarea
            className="input-glass"
            placeholder="Enter sample text to test redaction rules..."
            value={redactionTestInput}
            onChange={(e) => setRedactionTestInput(e.target.value)}
            rows={2}
          />
          <div style={{ display: 'flex', gap: '10px', marginTop: '8px', alignItems: 'center' }}>
            <button
              className="btn-secondary"
              onClick={handleTestRedaction}
              disabled={!redactionTestInput.trim()}
              style={{ padding: '6px 14px', fontSize: '0.78rem' }}
            >
              <Play size={12} />
              Test
            </button>
            {redactionTestOutput !== null && (
              <span className="redaction-test-output">{redactionTestOutput}</span>
            )}
          </div>
        </div>

        {/* Save Button */}
        <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="btn-primary"
            onClick={handleSaveRedactionRules}
            disabled={redactionSaving}
            style={{ padding: '8px 20px', fontSize: '0.82rem' }}
          >
            {redactionSaving ? 'Saving...' : 'Save Redaction Rules'}
          </button>
        </div>
      </section>

      {/* Data Retention */}
      <section className="settings-section glass-card animate-slide-up" style={{ animationDelay: '0.3s' }}>
        <div className="section-header">
          <Clock size={18} />
          <h2>Data Retention</h2>
        </div>
        <p className="section-desc">
          Configure how long meeting data is retained. Meetings older than the specified age are deleted and transcripts exceeding the line limit are truncated to the most recent lines.
        </p>

        <div className="setting-row">
          <div className="setting-label">
            <span className="setting-name">Maximum meeting age (days)</span>
            <span className="setting-desc">Meetings older than this will be deleted during a sweep.</span>
          </div>
          <input
            type="number"
            className="input-glass"
            min={1}
            value={meetingMaxAgeDays}
            onChange={(e) => setMeetingMaxAgeDays(Math.max(1, parseInt(e.target.value, 10) || 1))}
            style={{ width: '120px', textAlign: 'center' }}
            aria-label="Maximum meeting age in days"
          />
        </div>

        <div className="setting-row">
          <div className="setting-label">
            <span className="setting-name">Maximum transcript lines per meeting</span>
            <span className="setting-desc">Transcripts exceeding this limit are truncated to the most recent lines.</span>
          </div>
          <input
            type="number"
            className="input-glass"
            min={1}
            value={transcriptMaxLines}
            onChange={(e) => setTranscriptMaxLines(Math.max(1, parseInt(e.target.value, 10) || 1))}
            style={{ width: '120px', textAlign: 'center' }}
            aria-label="Maximum transcript lines per meeting"
          />
        </div>

        <div className="form-actions" style={{ marginTop: '16px' }}>
          <button
            className="btn-primary"
            onClick={handleSaveRetention}
            disabled={retentionSaving}
            style={{ padding: '8px 20px', fontSize: '0.82rem' }}
          >
            {retentionSaving ? 'Saving...' : 'Save Retention Settings'}
          </button>
          <button
            className="btn-secondary"
            onClick={handleRunSweep}
            disabled={sweepRunning}
            style={{ padding: '8px 20px', fontSize: '0.82rem' }}
          >
            {sweepRunning ? 'Running...' : <><Play size={14} /> Run Sweep Now</>}
          </button>
        </div>
      </section>

      {/* Spend */}
      <SpendPanel />

      {/* Privacy */}
      <section className="settings-section glass-card animate-slide-up" style={{ animationDelay: '0.32s' }}>
        <div className="section-header">
          <Shield size={18} />
          <h2>Privacy & Data</h2>
        </div>
        <p className="section-desc">
          All your data is stored locally in your browser's IndexedDB. Nothing is ever sent to our servers.
          Your API key is stored locally and only used to communicate directly with Google's Gemini API.
        </p>
        <div className="privacy-badges">
          <span className="pill pill-green">🔒 100% Local Storage</span>
          <span className="pill pill-green">🚫 Zero Server Data</span>
          <span className="pill pill-green">🔐 End-to-End Private</span>
        </div>
      </section>

      {/* Updates (task 10.2, Requirements 3.1–3.7) */}
      <section className="settings-section glass-card animate-slide-up" style={{ animationDelay: '0.34s' }}>
        <div className="section-header">
          <RefreshCw size={18} />
          <h2>Updates</h2>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span className="setting-name">Version {updateState.currentVersion}</span>
            <span className="setting-desc">
              {upToDate && "You're up to date"}
              {updateError && updateError}
              {!upToDate && !updateError && 'Check if a newer version of Zule is available.'}
            </span>
          </div>
          <button
            className="btn-primary"
            onClick={() => {
              setUpdateError(null);
              setUpToDate(false);
              checkForUpdate();
            }}
            disabled={updateState.status === 'checking' || updateState.status === 'downloading'}
            style={{ padding: '8px 20px', fontSize: '0.82rem' }}
          >
            {updateState.status === 'checking' ? 'Checking...' : 'Check for updates'}
          </button>
        </div>
      </section>
    </div>
  );
}
