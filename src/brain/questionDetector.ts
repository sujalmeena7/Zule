// ============================================
// Zule AI — Question Detector (Autonomous Triggers)
// ============================================
//
// Refactored per design.md §5: locale-aware detection with debounce,
// throttle, independent suppression, speaker-role gating, and
// trailing-? floor for unsupported locales.
//
// Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 3.3, 17.3

import type { TranscriptionLine, SpeakerRole } from '../types/transcription';

// Re-export for backward compat with the old contextManager-based import
export type { TranscriptionLine };

/**
 * Minimal shape that the detector requires from a transcript line.
 * Supports both the new TranscriptionLine (speakerRole) and legacy
 * TranscriptLine (speaker) during migration.
 */
export interface DetectableLineInput {
  text: string;
  speakerRole?: SpeakerRole;
  /** @deprecated Legacy field from contextManager.TranscriptLine */
  speaker?: 'user' | 'other';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetectionResult {
  question: string;
  type: 'direct' | 'behavioral' | 'technical' | 'opinion' | 'clarification';
  confidence: number;
  urgencyScore: number;
  source: 'final' | 'interim';
}

export interface QuestionPattern {
  regex: RegExp;
  type: DetectionResult['type'];
  weight: number;
}

// ---------------------------------------------------------------------------
// Locale packs
// ---------------------------------------------------------------------------

const EN_PATTERNS: QuestionPattern[] = [
  // Direct questions
  { regex: /(?:can you|could you|would you)\s+(?:tell|explain|describe|walk\s+(?:me|us)\s+through)/i, type: 'direct', weight: 0.9 },
  { regex: /(?:what|how|why|when|where|who)\s+(?:is|are|was|were|do|does|did|would|could|should|can)/i, type: 'direct', weight: 0.85 },
  { regex: /(?:tell\s+(?:me|us)\s+about)\s+/i, type: 'direct', weight: 0.9 },
  { regex: /(?:what's|what is)\s+your\s+(?:experience|background|approach|take|opinion|thought)/i, type: 'direct', weight: 0.95 },
  // Behavioral interview questions
  { regex: /(?:tell\s+(?:me|us)\s+about\s+a\s+time|describe\s+a\s+situation|give\s+(?:me|us)\s+an\s+example)/i, type: 'behavioral', weight: 0.95 },
  { regex: /(?:how\s+(?:did|do|would)\s+you\s+(?:handle|deal\s+with|approach|solve|manage|overcome))/i, type: 'behavioral', weight: 0.9 },
  // Technical questions
  { regex: /(?:what\s+is\s+(?:a|the|your)\s+(?:approach|solution|algorithm|method|way))/i, type: 'technical', weight: 0.85 },
  { regex: /(?:how\s+(?:would|do)\s+you\s+(?:implement|design|build|optimize|scale|debug|test))/i, type: 'technical', weight: 0.9 },
  { regex: /(?:what(?:'s|\s+is)\s+the\s+(?:difference|time\s+complexity|space\s+complexity|trade-?off))/i, type: 'technical', weight: 0.85 },
  // Opinion/clarification
  { regex: /(?:what\s+do\s+you\s+think|do\s+you\s+(?:agree|have\s+any\s+questions))/i, type: 'opinion', weight: 0.8 },
  { regex: /(?:does\s+that\s+make\s+sense|any\s+(?:questions|thoughts|concerns))/i, type: 'clarification', weight: 0.7 },
];

const ES_PATTERNS: QuestionPattern[] = [
  { regex: /(?:qué|cómo|por qué|cuándo|dónde|quién)\s+/i, type: 'direct', weight: 0.85 },
  { regex: /(?:puedes|podrías|puede)\s+(?:explicar|decir|contar)/i, type: 'direct', weight: 0.9 },
  { regex: /(?:cuéntame|dime)\s+(?:sobre|acerca)/i, type: 'behavioral', weight: 0.9 },
  { regex: /(?:qué opinas|estás de acuerdo|alguna pregunta)/i, type: 'opinion', weight: 0.8 },
];

const FR_PATTERNS: QuestionPattern[] = [
  { regex: /(?:qu'est-ce que|comment|pourquoi|quand|où|qui)\s+/i, type: 'direct', weight: 0.85 },
  { regex: /(?:pouvez-vous|pourriez-vous)\s+(?:expliquer|dire|raconter)/i, type: 'direct', weight: 0.9 },
  { regex: /(?:parlez-moi|dites-moi)\s+(?:de|d')/i, type: 'behavioral', weight: 0.9 },
  { regex: /(?:qu'en pensez-vous|êtes-vous d'accord|des questions)/i, type: 'opinion', weight: 0.8 },
];

const DE_PATTERNS: QuestionPattern[] = [
  { regex: /(?:was|wie|warum|wann|wo|wer)\s+/i, type: 'direct', weight: 0.85 },
  { regex: /(?:können Sie|könnten Sie)\s+(?:erklären|erzählen|beschreiben)/i, type: 'direct', weight: 0.9 },
  { regex: /(?:erzählen Sie|sagen Sie)\s+(?:mir|uns)/i, type: 'behavioral', weight: 0.9 },
  { regex: /(?:was denken Sie|sind Sie einverstanden|irgendwelche Fragen)/i, type: 'opinion', weight: 0.8 },
];

const JA_PATTERNS: QuestionPattern[] = [
  { regex: /(?:何|どう|なぜ|いつ|どこ|誰)/i, type: 'direct', weight: 0.85 },
  { regex: /(?:教えて|説明して|聞かせて)/i, type: 'direct', weight: 0.9 },
  { regex: /(?:どう思い|質問は|いかがですか)/i, type: 'opinion', weight: 0.8 },
];

const ZH_PATTERNS: QuestionPattern[] = [
  { regex: /(?:什么|怎么|为什么|什么时候|哪里|谁)/i, type: 'direct', weight: 0.85 },
  { regex: /(?:请你|能不能|可以)\s*(?:解释|告诉|说明)/i, type: 'direct', weight: 0.9 },
  { regex: /(?:你觉得|你认为|有问题吗)/i, type: 'opinion', weight: 0.8 },
];

const LOCALE_PACKS: Record<string, QuestionPattern[]> = {
  en: EN_PATTERNS,
  es: ES_PATTERNS,
  fr: FR_PATTERNS,
  de: DE_PATTERNS,
  ja: JA_PATTERNS,
  zh: ZH_PATTERNS,
};

// Urgency boosters (English-centric; locale-independent as a simplification)
const URGENCY_PATTERNS = [
  /(?:right now|immediately|quickly|in a hurry|asap|urgent)/i,
  /(?:can you answer|we need to know|tell us now)/i,
];

// Patterns indicating rhetorical or quoted questions — never trigger
const IGNORED_PATTERNS = [
  /^(?:he said|she said|they said)/i,
  /(?:quote|unquote)/i,
  /(?:not a real question|just thinking out loud)/i,
];

// ---------------------------------------------------------------------------
// Core detection logic (pure helpers)
// ---------------------------------------------------------------------------

function getLocalePrefix(locale: string): string {
  // Extract primary subtag from BCP-47 (e.g. 'en-US' → 'en')
  return locale.split(/[-_]/)[0].toLowerCase();
}

function getPatternsForLocale(locale: string): QuestionPattern[] | null {
  const prefix = getLocalePrefix(locale);
  return LOCALE_PACKS[prefix] ?? null;
}

/**
 * Detect whether text matches any question pattern for a given locale.
 * Returns null if no pattern matches.
 */
function matchPatterns(
  text: string,
  patterns: QuestionPattern[],
): { type: DetectionResult['type']; confidence: number } | null {
  let best: { type: DetectionResult['type']; confidence: number } | null = null;

  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      if (!best || pattern.weight > best.confidence) {
        best = { type: pattern.type, confidence: pattern.weight };
      }
    }
  }
  return best;
}

function computeUrgency(text: string): number {
  let score = 1;
  for (const u of URGENCY_PATTERNS) {
    if (u.test(text)) score += 2;
  }
  return score;
}

function isIgnored(text: string): boolean {
  return IGNORED_PATTERNS.some(p => p.test(text));
}

/**
 * Check for trailing question mark — the fallback/floor rule.
 */
function hasTrailingQuestionMark(text: string): boolean {
  return /\?\s*$/.test(text);
}

/**
 * Count whole words by splitting on whitespace. Used for the
 * "differs by at least one whole word" comparison (Requirement 8.3).
 */
function getWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(w => w.length > 0);
}

/**
 * Returns true if `a` and `b` differ by at least one whole word.
 */
export function differsByAtLeastOneWord(a: string, b: string): boolean {
  const wordsA = getWords(a);
  const wordsB = getWords(b);
  if (wordsA.length !== wordsB.length) return true;
  for (let i = 0; i < wordsA.length; i++) {
    if (wordsA[i] !== wordsB[i]) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// QuestionDetectorStream class
// ---------------------------------------------------------------------------

export interface QuestionDetectorStreamOpts {
  debounceMs?: number;
  interimThrottleMs?: number;
  locale?: string;
  /** Injectable clock for testing (returns epoch ms). */
  now?: () => number;
}

/**
 * Locale-aware question detector with:
 * - Final-transcript debouncing (default 1500 ms)
 * - Interim-text throttling (default 4000 ms)
 * - Independent suppression tracking for final and interim
 * - Speaker role gating (only fires on speakerRole === 'other')
 * - Trailing-? floor (confidence >= 0.6 when other speaker ends with ?)
 * - Locale packs for en/es/fr/de/ja/zh; trailing-? fallback for unknown locales
 */
export class QuestionDetectorStream {
  private readonly debounceMs: number;
  private readonly interimThrottleMs: number;
  private readonly locale: string;
  private readonly now: () => number;

  // Independent suppression state (Requirement 8.3)
  private lastFinalTriggeredText = '';
  private lastFinalTriggeredAt = 0;
  private lastInterimTriggeredText = '';
  private lastInterimTriggeredAt = 0;

  constructor(opts: QuestionDetectorStreamOpts = {}) {
    this.debounceMs = opts.debounceMs ?? 1500;
    this.interimThrottleMs = opts.interimThrottleMs ?? 4000;
    this.locale = opts.locale ?? 'en';
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Process new context (final transcript lines). Only triggers when
   * the latest line's speakerRole === 'other' and debounce has elapsed.
   *
   * Requirement 3.3: Gate on speakerRole === 'other'
   * Requirement 8.1: Debounce final triggers (default 1500 ms)
   * Requirement 8.3: Final triggers independent of interim suppression
   */
  onNewContext(lines: DetectableLineInput[], cb: (r: DetectionResult) => void): void {
    if (lines.length === 0) return;

    const latestLine = lines[lines.length - 1];

    // Requirement 3.3: Only fire on other speakers
    // Support both new `speakerRole` and legacy `speaker` field
    const role = latestLine.speakerRole ?? latestLine.speaker;
    if (role === 'user') return;

    const text = latestLine.text.trim();
    if (text.length < 10) return;

    // Don't re-trigger for exact same final text
    if (text === this.lastFinalTriggeredText) return;

    // Requirement 8.1: Debounce — check time since last final trigger
    const currentTime = this.now();
    if (currentTime - this.lastFinalTriggeredAt < this.debounceMs) return;

    // Skip ignored patterns
    if (isIgnored(text)) return;

    // Attempt detection with locale patterns
    const result = this.detect(text, 'final');
    if (result) {
      this.lastFinalTriggeredText = text;
      this.lastFinalTriggeredAt = currentTime;
      cb(result);
    }
  }

  /**
   * Process interim (partial) transcript text. Throttled to at most one
   * trigger per interimThrottleMs (default 4000 ms).
   *
   * Requirement 8.2: Throttle interim triggers
   */
  onInterimText(interim: string, cb: (r: DetectionResult) => void): void {
    const text = interim.trim();
    if (text.length < 15) return;

    // Don't re-trigger exact same interim text
    if (text === this.lastInterimTriggeredText) return;

    // Requirement 8.2: Throttle — at most one per interimThrottleMs
    const currentTime = this.now();
    if (currentTime - this.lastInterimTriggeredAt < this.interimThrottleMs) return;

    // Skip ignored patterns
    if (isIgnored(text)) return;

    // Attempt detection with locale patterns
    const result = this.detect(text, 'interim');
    if (result) {
      this.lastInterimTriggeredText = text;
      this.lastInterimTriggeredAt = currentTime;
      cb(result);
    }
  }

  /**
   * Reset all state. Used on session boundaries.
   */
  reset(): void {
    this.lastFinalTriggeredText = '';
    this.lastFinalTriggeredAt = 0;
    this.lastInterimTriggeredText = '';
    this.lastInterimTriggeredAt = 0;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private detect(text: string, source: 'final' | 'interim'): DetectionResult | null {
    const patterns = getPatternsForLocale(this.locale);

    if (patterns) {
      // Supported locale: try locale-specific patterns
      const match = matchPatterns(text, patterns);
      if (match) {
        return {
          question: text,
          type: match.type,
          confidence: source === 'interim' ? match.confidence * 0.9 : match.confidence,
          urgencyScore: computeUrgency(text),
          source,
        };
      }
    }

    // Trailing-? floor: for supported locales, this is an additional catch-all;
    // for unsupported locales, this is the only rule (Requirement 8.5, 8.6).
    // Only applies when source is 'final' for the trailing-? floor rule,
    // but we also apply it for interim if the text ends with '?'
    if (hasTrailingQuestionMark(text)) {
      return {
        question: text,
        type: 'direct',
        confidence: source === 'interim' ? 0.6 * 0.9 : 0.6,
        urgencyScore: computeUrgency(text),
        source,
      };
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Module-level exports for backward compatibility
// ---------------------------------------------------------------------------

// Legacy TranscriptLine from contextManager (bridged)
import type { TranscriptLine } from './contextManager';

/**
 * @deprecated Use `QuestionDetectorStream.onNewContext` instead.
 * Kept for backward compatibility during migration.
 */
export function detectQuestion(recentContext: TranscriptLine[]): (DetectionResult & { triggerAI: boolean }) | null {
  if (recentContext.length === 0) return null;

  const latestLine = recentContext[recentContext.length - 1];
  if (latestLine.speaker === 'user') return null;

  const text = latestLine.text.trim();
  if (text.length < 10) return null;

  if (isIgnored(text)) return null;

  const patterns = LOCALE_PACKS['en']!;
  const match = matchPatterns(text, patterns);

  if (match) {
    return {
      question: text,
      type: match.type,
      confidence: match.confidence,
      urgencyScore: computeUrgency(text),
      source: 'final',
      triggerAI: match.confidence >= 0.7,
    };
  }

  if (hasTrailingQuestionMark(text)) {
    return {
      question: text,
      type: 'direct',
      confidence: 0.6,
      urgencyScore: computeUrgency(text),
      source: 'final',
      triggerAI: false,
    };
  }

  return null;
}

/**
 * @deprecated Use `QuestionDetectorStream.onInterimText` instead.
 * Kept for backward compatibility during migration.
 */
export function detectInterimQuestion(interimText: string): (DetectionResult & { triggerAI: boolean }) | null {
  const trimmed = interimText.trim();
  if (trimmed.length < 15) return null;

  const patterns = LOCALE_PACKS['en']!;
  const match = matchPatterns(trimmed, patterns);

  if (match) {
    const confidence = match.confidence * 0.9;
    return {
      question: trimmed,
      type: match.type,
      confidence,
      urgencyScore: 1,
      source: 'interim',
      triggerAI: confidence >= 0.65,
    };
  }

  return null;
}
