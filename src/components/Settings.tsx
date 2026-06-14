// ============================================
// Zule AI — Settings Page
// ============================================

import { useState, useEffect, useCallback } from 'react';
import {
  Key, Palette, Keyboard, Database, Trash2, Plus, FileText,
  Sun, Moon, Shield, Upload, Eye, EyeOff, CheckCircle2, Wand2,
  ArrowUp, ArrowDown, Power, Server, ShieldCheck, Play, Clock,
  Gauge, Lock, Globe
} from 'lucide-react';
import { database as knowledgeBase, type KBDocument, type ProviderConfig } from '../data/database';
import { SHORTCUT_DEFINITIONS } from '../hooks/useKeyboardShortcuts';
import { getModifierKey, getAltKey, getPlatformLimitations } from '../overlay/platformKeys';
import toast from 'react-hot-toast';
import './Settings.css';

import { useZule } from '../context/ZuleContext';
import { useZuleError } from '../hooks/useZuleError';
import type { RedactionRule, RedactionEntity } from '../types/redaction';
import { apply as applyRedaction } from '../brain/redaction';
import { SpendPanel } from './SpendPanel';
import { getSupportedLocales, setLocale, type LocaleCode } from '../i18n';
import {
  DEFAULT_MEETING_MAX_AGE_DAYS,
  DEFAULT_TRANSCRIPT_MAX_LINES,
} from '../data/retention';
import type { PrivacyMode } from '../utils/sessionPolicy';

const SUPPORTED_DOC_EXTENSIONS = new Set(['txt', 'md', 'json', 'pdf', 'docx']);

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
];

const PROVIDER_LABELS: Record<ProviderConfig['id'], string> = {
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  ollama: 'Ollama (Local)',
  simulation: 'Simulation',
};

const PROVIDER_DESCRIPTIONS: Record<ProviderConfig['id'], string> = {
  gemini: 'Google Gemini Pro / Flash models',
  openai: 'GPT-4o, o-series models',
  anthropic: 'Claude Sonnet / Opus / Haiku',
  ollama: 'Local models via Ollama or LM Studio',
  simulation: 'Offline simulation for testing (no API key needed)',
};

export function Settings() {
  const { state, actions } = useZule();
  const { apiKey, theme, customModes } = state;
  const { updateApiKey, updateTheme, saveCustomMode, deleteCustomMode } = actions;
  const notifyError = useZuleError();

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

  // Data Retention State
  const [meetingMaxAgeDays, setMeetingMaxAgeDays] = useState(DEFAULT_MEETING_MAX_AGE_DAYS);
  const [transcriptMaxLines, setTranscriptMaxLines] = useState(DEFAULT_TRANSCRIPT_MAX_LINES);
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [sweepRunning, setSweepRunning] = useState(false);

  // Language State
  const [uiLocale, setUiLocale] = useState<LocaleCode>('en');
  const [recognitionLanguage, setRecognitionLanguage] = useState('en-US');
  const [ocrLanguage, setOcrLanguage] = useState('eng');

  // Load KB documents
  useEffect(() => {
    knowledgeBase.getAllDocuments().then(setDocuments);
  }, []);

  // Load provider configurations from IndexedDB
  useEffect(() => {
    knowledgeBase.getSetting<ProviderConfig[]>('providers', DEFAULT_PROVIDERS).then((saved) => {
      // Merge saved providers with defaults to ensure new providers are always visible
      const merged = DEFAULT_PROVIDERS.map((def) => {
        const existing = saved.find((p) => p.id === def.id);
        return existing ?? def;
      });
      // Sort by priority
      merged.sort((a, b) => a.priority - b.priority);
      setProviders(merged);

      // Populate providerKeys from loaded apiKeyCipher
      const keys: Record<string, string> = {};
      merged.forEach((p) => {
        if (p.apiKeyCipher) {
          keys[p.id] = p.apiKeyCipher;
        }
      });
      setProviderKeys(keys);
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
      prev.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p))
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

  const handleToggleProviderKeyVisibility = useCallback((id: string) => {
    setShowProviderKey((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const handleSaveProviders = useCallback(async () => {
    setProvidersSaving(true);
    try {
      // Build the configs to persist. For each provider that has a key entered,
      // store it. TODO: encrypt via CryptoVault when vault is unlocked —
      // for now persist raw key as apiKeyCipher placeholder (Requirement 15.1).
      const configsToSave: ProviderConfig[] = providers.map((p) => {
        const key = providerKeys[p.id];
        const config: ProviderConfig = { ...p };
        if (key && key.trim()) {
          // TODO: Replace with vault.encrypt(key) once CryptoVault integration
          // is wired into the Settings flow (vault may not be unlocked here).
          config.apiKeyCipher = key.trim();
        } else {
          delete config.apiKeyCipher;
        }
        return config;
      });
      await knowledgeBase.setSetting('providers', configsToSave);
      toast.success('Provider configuration saved!');
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
    setIsUploading(true);
    try {
      const { chunkText } = await import('../utils/documentParser');
      
      const chunks = chunkText(text);

      // Store text-only chunks without vectors. The ONNX WASM backend
      // (onnxruntime-web@1.14.0 pinned by @xenova/transformers@2.17)
      // is binary-incompatible with Electron 42's V8 and segfaults
      // (ACCESS_VIOLATION 0xC0000005) when loading the embedding model.
      // Since a native crash can't be caught by try/catch, we skip
      // embedding entirely for now. Documents are searchable via keyword
      // matching. Semantic search can be re-enabled once onnxruntime-web
      // is upgraded to a version compatible with this Electron build, or
      // when the embedding pipeline is moved to the main process (Node.js
      // with onnxruntime-node, which doesn't have this incompatibility).
      const chunksWithVectors = chunks.map((chunk) => ({ text: chunk, vector: [] as number[] }));

      await knowledgeBase.addDocument(title || newDocTitle || 'Untitled Document', text, newDocType, chunksWithVectors);
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
          {providers.map((provider, index) => (
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
                    {provider.id === 'ollama' ? (
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
                  </div>
                )}
              </div>

              <button
                className={`btn-icon provider-toggle ${provider.enabled ? 'provider-toggle-on' : ''}`}
                onClick={() => handleToggleProvider(provider.id)}
                aria-label={`${provider.enabled ? 'Disable' : 'Enable'} ${PROVIDER_LABELS[provider.id]}`}
              >
                <Power size={16} />
              </button>
            </div>
          ))}
        </div>

        <div className="provider-actions">
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
    </div>
  );
}
