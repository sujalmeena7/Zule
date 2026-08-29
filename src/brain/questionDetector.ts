// ============================================
// Zule AI — Question Detector (Autonomous Triggers)
// ============================================
//
// Realtime question detector with:
// - Multi-line utterance windowing across 2s split chunks
// - Cross-source final/interim deduplication within 6s
// - Speaker-role gating (fires only on 'other' remote party)
// - Trailing-? floor and locale packs
// - Echo duplicate suppression
//
// Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 3.3, 17.3

import type { TranscriptionLine, SpeakerRole } from '../types/transcription';

// Re-export for backward compat
export type { TranscriptionLine };

/**
 * Minimal shape that the detector requires from a transcript line.
 */
export interface DetectableLineInput {
  text: string;
  speakerRole?: SpeakerRole;
  /** @deprecated Legacy field from contextManager.TranscriptLine */
  speaker?: 'user' | 'other';
  timestamp?: number;
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

// Urgency boosters
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
  return locale.split(/[-_]/)[0].toLowerCase();
}

function getPatternsForLocale(locale: string): QuestionPattern[] | null {
  const prefix = getLocalePrefix(locale);
  return LOCALE_PACKS[prefix] ?? null;
}

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

function hasTrailingQuestionMark(text: string): boolean {
  return /\?\s*$/.test(text);
}

/**
 * Significant words of `text`: lowercased, punctuation-stripped, and limited to
 * tokens longer than two characters so filler ("is", "a", "to") and ASR jitter
 * on short function words cannot register as a difference.
 */
function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .filter(w => w.length > 2),
  );
}

/**
 * Symmetric count of significant words present in one string but not the other.
 *
 * This is the barge-in threshold: an in-flight answer is only aborted once the
 * newly detected question differs by enough words to be a genuinely different
 * question, rather than the same one re-transcribed slightly differently.
 * Compared as sets, so word order and repetition are ignored.
 */
export function countWordDifferences(a: string, b: string): number {
  const wordsA = significantWords(a);
  const wordsB = significantWords(b);
  let diffCount = 0;
  for (const w of wordsB) if (!wordsA.has(w)) diffCount++;
  for (const w of wordsA) if (!wordsB.has(w)) diffCount++;
  return diffCount;
}

/**
 * Returns true if fullText is a near-superset of partialText (same topic/utterance).
 */
export function isNearSuperset(fullText: string, partialText: string): boolean {
  const fLower = fullText.toLowerCase().trim();
  const pLower = partialText.toLowerCase().trim();
  if (fLower.includes(pLower)) return true;

  const wordsFull = new Set(fLower.replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(w => w.length > 0));
  const wordsPartial = pLower.replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(w => w.length > 0);

  if (wordsPartial.length === 0) return true;
  for (const w of wordsPartial) {
    if (!wordsFull.has(w)) return false;
  }
  return true;
}

/**
 * Builds a joined utterance string from consecutive lines spoken by the same role.
 * Allows questions that split across 2s chunk boundaries to be detected as a single question.
 */
export function buildUtteranceWindow(
  lines: DetectableLineInput[],
  opts: { maxGapMs?: number; maxLines?: number } = {},
): string {
  if (lines.length === 0) return '';
  const maxGapMs = opts.maxGapMs ?? 1500;
  const maxLines = opts.maxLines ?? 4;

  const targetLine = lines[lines.length - 1];
  const targetRole = targetLine.speakerRole ?? targetLine.speaker;

  const collected: string[] = [targetLine.text.trim()];
  let prevTimestamp = targetLine.timestamp;

  for (let i = lines.length - 2; i >= 0 && collected.length < maxLines; i--) {
    const line = lines[i];
    const role = line.speakerRole ?? line.speaker;
    if (role !== targetRole) break;

    if (prevTimestamp !== undefined && line.timestamp !== undefined) {
      const gap = prevTimestamp - line.timestamp;
      if (gap > maxGapMs || gap < 0) break;
      prevTimestamp = line.timestamp;
    }

    const trimmed = line.text.trim();
    if (trimmed) {
      collected.unshift(trimmed);
    }
  }

  return collected.join(' ');
}

/**
 * Drops a 'user' (mic) line when an 'other' (loopback) line within +- maxTimeGapMs
 * shares >= minOverlapRatio word token overlap. Loopback is authoritative for the remote party.
 */
export function suppressEchoDuplicates(
  lines: TranscriptionLine[],
  opts: { maxTimeGapMs?: number; minOverlapRatio?: number } = {},
): TranscriptionLine[] {
  const maxTimeGapMs = opts.maxTimeGapMs ?? 1200;
  const minOverlapRatio = opts.minOverlapRatio ?? 0.7;

  function tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .split(/\s+/)
        .filter((w) => w.length > 1),
    );
  }

  function computeOverlap(userSet: Set<string>, otherSet: Set<string>): number {
    if (userSet.size === 0 || otherSet.size === 0) return 0;
    let common = 0;
    for (const word of userSet) {
      if (otherSet.has(word)) common++;
    }
    return common / userSet.size;
  }

  const result: TranscriptionLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i];
    if (current.speakerRole === 'user') {
      const userTokens = tokenize(current.text);
      let isEcho = false;

      for (let j = 0; j < lines.length; j++) {
        if (i === j) continue;
        const other = lines[j];
        if (other.speakerRole === 'other') {
          const timeDiff = Math.abs(current.timestamp - other.timestamp);
          if (timeDiff <= maxTimeGapMs) {
            const otherTokens = tokenize(other.text);
            const overlap = computeOverlap(userTokens, otherTokens);
            if (overlap >= minOverlapRatio) {
              isEcho = true;
              break;
            }
          }
        }
      }

      if (isEcho) {
        continue;
      }
    }
    result.push(current);
  }

  return result;
}

// ---------------------------------------------------------------------------
// QuestionDetectorStream class
// ---------------------------------------------------------------------------

export interface QuestionDetectorStreamOpts {
  debounceMs?: number;
  interimThrottleMs?: number;
  crossSourceWindowMs?: number;
  locale?: string;
  /** Injectable clock for testing (returns epoch ms). */
  now?: () => number;
}

/**
 * Locale-aware question detector with:
 * - Multi-line utterance windowing (fixes split-question failure mode)
 * - Final-transcript debouncing
 * - Interim-text throttling
 * - Cross-source final/interim suppression tracking
 * - Speaker role gating (fires on speakerRole === 'other')
 * - Trailing-? floor
 */
export class QuestionDetectorStream {
  private readonly debounceMs: number;
  private readonly interimThrottleMs: number;
  private readonly crossSourceWindowMs: number;
  private readonly locale: string;
  private readonly now: () => number;

  // Cross-source suppression state
  private lastFinalTriggeredText = '';
  private lastFinalTriggeredAt = 0;
  private lastInterimTriggeredText = '';
  private lastInterimTriggeredAt = 0;
  private lastTriggeredText = '';
  private lastTriggeredAt = 0;
  private lastTriggeredSource: 'final' | 'interim' | null = null;

  constructor(opts: QuestionDetectorStreamOpts = {}) {
    this.debounceMs = opts.debounceMs ?? 800;
    this.interimThrottleMs = opts.interimThrottleMs ?? 2500;
    this.crossSourceWindowMs = opts.crossSourceWindowMs ?? 6000;
    this.locale = opts.locale ?? 'en';
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Process new context (final transcript lines).
   * Employs buildUtteranceWindow across consecutive lines to detect split questions.
   */
  onNewContext(lines: DetectableLineInput[], cb: (r: DetectionResult) => void): void {
    if (lines.length === 0) return;

    const latestLine = lines[lines.length - 1];
    const role = latestLine.speakerRole ?? latestLine.speaker;
    if (role === 'user') return;

    const text = buildUtteranceWindow(lines, { maxGapMs: 1500, maxLines: 4 });
    if (text.length < 10) return;

    // Don't re-trigger for exact same final text
    if (text === this.lastFinalTriggeredText) return;

    const currentTime = this.now();

    // Check debounce
    if (currentTime - this.lastFinalTriggeredAt < this.debounceMs) return;

    // Cross-source deduplication: if an interim trigger recently fired and this
    // final text is a near-superset of it, upgrade in place rather than double-firing.
    if (
      this.lastTriggeredSource === 'interim' &&
      currentTime - this.lastTriggeredAt < this.crossSourceWindowMs &&
      isNearSuperset(text, this.lastTriggeredText)
    ) {
      this.lastFinalTriggeredText = text;
      this.lastFinalTriggeredAt = currentTime;
      this.lastTriggeredText = text;
      this.lastTriggeredAt = currentTime;
      this.lastTriggeredSource = 'final';
      return;
    }

    if (isIgnored(text)) return;

    const result = this.detect(text, 'final');
    if (result) {
      this.lastFinalTriggeredText = text;
      this.lastFinalTriggeredAt = currentTime;
      this.lastTriggeredText = text;
      this.lastTriggeredAt = currentTime;
      this.lastTriggeredSource = 'final';
      cb(result);
    }
  }

  /**
   * Process interim (partial) transcript text. Throttled and role-gated.
   */
  onInterimText(
    interim: string,
    cb: (r: DetectionResult) => void,
    role?: SpeakerRole | 'user' | 'other',
  ): void {
    if (role === 'user') return;

    const text = interim.trim();
    if (text.length < 15) return;

    if (text === this.lastInterimTriggeredText) return;

    const currentTime = this.now();
    if (currentTime - this.lastInterimTriggeredAt < this.interimThrottleMs) return;

    if (isIgnored(text)) return;

    const result = this.detect(text, 'interim');
    if (result) {
      this.lastInterimTriggeredText = text;
      this.lastInterimTriggeredAt = currentTime;
      this.lastTriggeredText = text;
      this.lastTriggeredAt = currentTime;
      this.lastTriggeredSource = 'interim';
      cb(result);
    }
  }

  /**
   * Reset all state on session boundaries.
   */
  reset(): void {
    this.lastFinalTriggeredText = '';
    this.lastFinalTriggeredAt = 0;
    this.lastInterimTriggeredText = '';
    this.lastInterimTriggeredAt = 0;
    this.lastTriggeredText = '';
    this.lastTriggeredAt = 0;
    this.lastTriggeredSource = null;
  }

  private detect(text: string, source: 'final' | 'interim'): DetectionResult | null {
    const patterns = getPatternsForLocale(this.locale);

    if (patterns) {
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

import type { TranscriptLine } from './contextManager';

/**
 * @deprecated Use `QuestionDetectorStream.onNewContext` instead.
 */
export function detectQuestion(recentContext: TranscriptLine[]): (DetectionResult & { triggerAI: boolean }) | null {
  if (recentContext.length === 0) return null;

  const latestLine = recentContext[recentContext.length - 1];
  if (latestLine.speaker === 'user') return null;

  const text = buildUtteranceWindow(recentContext, { maxGapMs: 1500, maxLines: 4 });
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
