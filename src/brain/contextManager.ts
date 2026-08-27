// ============================================
// Zule AI — Context Manager (backward-compat shim)
// ============================================
//
// This module preserves the legacy API surface (`buildContextWindow`,
// `TranscriptLine`, `ContextWindow`) so that existing consumers
// (FloatingCopilot.tsx, aiProvider.ts, summaryEngine.ts,
// useSpeechRecognition.ts, TranscriptPanel.tsx, questionDetector.ts)
// keep compiling without changes.
//
// Under the hood it delegates to `build()` from `./contextBuilder`.
// Requirements: 5.1, 5.2, 24.1.

import type { CopilotMode, ModeConfig } from './modePrompts';
import { build } from './contextBuilder';
import type { MemoryChunk } from './contextBuilder';
import type { RedactionRule } from '../types/redaction';
import type { RedactionAttestation } from '../types/ai';
import { database as knowledgeBase } from '../data/database';
import { MemoryStore } from './memoryStore';
import type { SearchResult } from './memoryStore';
import { cosineSimilarity } from './vectorMath';

// ---------------------------------------------------------------------
// Legacy types — re-exported for consumers
// ---------------------------------------------------------------------

export interface TranscriptLine {
  id: string;
  text: string;
  timestamp: number;
  isInterim: boolean;
  speaker: 'user' | 'other';
}

export interface CitationInfo {
  citationId: string;
  label: '[KNOWLEDGE]' | '[MEMORY]';
  source?: { docId?: string; meetingId?: string; date?: number };
}

export interface ContextWindow {
  systemPrompt: string;
  knowledgeContext: string;
  transcriptContext: string;
  screenContext: string;
  userQuery: string;
  fullPrompt: string;
  /** Modalities that contributed to the assembled prompt (Requirement 23.4, 8.4). */
  modalitiesUsed?: ('audio' | 'screen' | 'knowledge' | 'memory' | 'keyframe' | 'screenText')[];
  /** Citation info for rendering citation chips (Requirements 5.5, 24.2). */
  citations?: CitationInfo[];
  /** Optional image attachments for adapters with `capabilities.imageInput` (Requirement 23.3). */
  images?: Array<{ mimeType: string; base64: string }>;
  /**
   * What redaction the underlying Context_Builder performed, passed straight
   * through so downstream mappers (`aiProvider.toPromptInput`) can hand it to
   * adapters that refuse to transmit unattested prompts.
   *
   * Optional so the many existing construction sites of this legacy shape keep
   * compiling; `buildContextWindow` always populates it.
   * Requirements 2.9, 2.10 (custom-openai-compatible-provider).
   */
  redaction?: RedactionAttestation;
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

const MAX_KB_CHUNKS = 3;
const MAX_MEMORY_CHUNKS = 5;

/**
 * Default ceiling on how long `buildContextWindow` will wait for the
 * Knowledge_Base / Memory_Store retrieval pass before assembling the prompt
 * without it.
 *
 * Both searches embed the query through `vectorStore.generateEmbedding`, which
 * runs a Transformers.js forward pass on the single-threaded WASM backend. Cold
 * that is *seconds*; warm it is still hundreds of milliseconds — all of it on
 * the critical path between the user's click and the first streamed token.
 * Retrieval is an enhancement, not a precondition: a prompt missing a knowledge
 * chunk still answers the question on screen, whereas a prompt that arrives
 * five seconds late has already failed. So we cap the wait and drop whichever
 * side of the retrieval didn't make it.
 */
const DEFAULT_RETRIEVAL_DEADLINE_MS = 600;

// ---------------------------------------------------------------------
// Redaction-rule cache
// ---------------------------------------------------------------------
//
// The rules live in IndexedDB and change only when the User edits them in
// Settings. Re-reading them on every dispatch adds an await to the critical
// path for a value that is almost always identical, so the first read is
// memoized and reused.
//
// The cache is deliberately *not* pre-seeded with `[]`: an unprimed cache is
// distinguishable from a genuinely empty rule set, so the fast path can await
// the real load instead of silently stamping a `ruleCount: 0` attestation onto
// a prompt whose configured rules were never applied (Requirement 2.9).

let cachedRedactionRules: RedactionRule[] | null = null;
let redactionRulesPromise: Promise<RedactionRule[]> | null = null;

async function loadRedactionRules(): Promise<RedactionRule[]> {
  if (cachedRedactionRules) return cachedRedactionRules;
  if (!redactionRulesPromise) {
    redactionRulesPromise = (async () => {
      let rules: RedactionRule[] = [];
      try {
        rules = await knowledgeBase.getSetting<RedactionRule[]>('redactionRules', []);
      } catch {
        // Settings store might not be initialized yet — an empty rule set still
        // produces a *passing* attestation (every segment went through the
        // Redaction_Engine, there was simply nothing to match).
      }
      if (!Array.isArray(rules)) rules = [];
      cachedRedactionRules = rules;
      return rules;
    })();
  }
  return redactionRulesPromise;
}

/**
 * Warm the caches the fast dispatch path depends on, so the first question of
 * a session doesn't pay for them. Safe to call repeatedly and safe to ignore
 * the returned promise — a failure degrades to the lazy load.
 */
export async function primeFastContext(): Promise<void> {
  await loadRedactionRules().catch(() => undefined);
}

/**
 * Drop the memoized redaction rules so the next build re-reads them. Call this
 * after the User edits their rules in Settings.
 */
export function invalidateRedactionRuleCache(): void {
  cachedRedactionRules = null;
  redactionRulesPromise = null;
}

// ---------------------------------------------------------------------
// Singleton MemoryStore — lazily initialized
// ---------------------------------------------------------------------

let memoryStoreInstance: MemoryStore | null = null;
let memoryStoreInitPromise: Promise<void> | null = null;

/**
 * Get the singleton MemoryStore instance, initializing it on first access.
 * Uses a dynamic import of VectorStore to avoid pulling @xenova/transformers
 * into the initial bundle (Requirement 21.1).
 */
function getMemoryStore(): MemoryStore {
  if (!memoryStoreInstance) {
    memoryStoreInstance = new MemoryStore({
      generateEmbedding: async (text: string) => {
        const { vectorStore } = await import('./vectorStore');
        const embedding = await vectorStore.generateEmbedding(text);
        return new Float32Array(embedding);
      },
      cosineSimilarity,
      redact: (text: string) => text, // read-path — no redaction needed on retrieval
      persist: true,
    });
    // Kick off persistence load (fire-and-forget, awaited below)
    memoryStoreInitPromise = memoryStoreInstance.loadFromPersistence().catch(() => {
      // eslint-disable-next-line no-console
      console.warn('[contextManager] MemoryStore persistence load failed');
    });
  }
  return memoryStoreInstance;
}

/**
 * Ensure the MemoryStore has loaded from IndexedDB before searching.
 */
async function ensureMemoryStoreReady(): Promise<MemoryStore> {
  const store = getMemoryStore();
  if (memoryStoreInitPromise) {
    await memoryStoreInitPromise;
    memoryStoreInitPromise = null;
  }
  return store;
}

/** Simple word-based token approximation for the legacy shim path. */
function countTokensApprox(text: string): number {
  // Rough heuristic: ~4 chars per token (matches GPT-style tokenizers)
  return Math.ceil(text.length / 4);
}

/** Adapt a legacy `TranscriptLine` to the new `TranscriptionLine` shape. */
function toLegacyTranscriptionLine(line: TranscriptLine) {
  return {
    id: line.id,
    text: line.text,
    timestamp: line.timestamp,
    isInterim: line.isInterim,
    speakerId: line.speaker === 'user' ? 'speaker-1' : 'speaker-2',
    speakerRole: line.speaker as 'user' | 'other',
    detection: 'manual' as const,
    detectionConfidence: 1,
    asrConfidence: 1,
    language: 'en-US',
    provider: 'web-speech' as const,
  };
}

// ---------------------------------------------------------------------
// Public API — legacy surface
// ---------------------------------------------------------------------

/**
 * Assemble a context window for a screen-grounded question, skipping every
 * retrieval step.
 *
 * This is the fast dispatch path. `buildContextWindow` embeds the query twice
 * (once for the Knowledge_Base, once for the Memory_Store) before it assembles
 * anything, and each embedding is a Transformers.js forward pass on the
 * single-threaded WASM backend. When the question is already fully present in
 * the captured screen text — an MCQ, a coding prompt, a form — those lookups
 * cannot contribute anything the model doesn't already have, so paying seconds
 * for them buys nothing.
 *
 * What this shares with the slow path: the same `build()` from contextBuilder,
 * so the system prompt, section labelling, token budgeting, redaction and
 * attestation are identical. What it drops: Knowledge_Base search, Memory_Store
 * search, and therefore citations.
 *
 * Async only to await the memoized redaction rules — after `primeFastContext()`
 * (or the first call) that resolves without touching IndexedDB, making this
 * effectively synchronous.
 */
/**
 * Output-shape directive prepended to every screen-grounded prompt.
 *
 * This is a latency fix, not a formatting preference. The answer streams token
 * by token, so whatever the model writes first is what the User can act on
 * first. Left to itself a model opens with "Looking at the screenshot, this
 * appears to be a question about…", which means the useful word arrives several
 * seconds after the first word — and on a long DSA solution that gap is most of
 * the wait. Putting the answer on line one costs nothing and removes it.
 *
 * Kept deliberately short: it is prepended to every screen dispatch, and tokens
 * spent here are tokens of prefill on the critical path.
 */
const ANSWER_FIRST_DIRECTIVE = `ANSWER FORMAT — follow exactly:
- Line 1 is the answer itself and nothing else. For a multiple-choice question, the option letter and its text (e.g. "B) 14"). For a coding problem, the approach in one short line.
- Line 1 is final. Work out the answer before you write it — for multiple choice, check every option first. Never revise it later in the reply; a reader who acts on line 1 will not see the correction.
- Never open by restating the question, describing the screenshot, or saying what you are about to do.
- Put code, explanation, and complexity after line 1.`;

export async function buildMinimalScreenContext(
  mode: CopilotMode,
  transcript: TranscriptLine[],
  screenText: string,
  userQuery: string,
  customModes: ModeConfig[] = [],
  options?: { images?: Array<{ mimeType: string; base64: string }> },
): Promise<ContextWindow> {
  const redactionRules = await loadRedactionRules();

  const result = build({
    mode,
    transcript: transcript.map(toLegacyTranscriptionLine),
    screenText,
    knowledgeChunks: [],
    memoryChunks: [],
    userQuery,
    countTokens: countTokensApprox,
    settings: {
      customModes,
      redactionRules,
      // Redact here too: the fast path is a retrieval shortcut, not a privacy
      // shortcut. Skipping redaction would stamp `applied: false` and block the
      // custom provider outright (Requirement 2.9).
      skipRedaction: false,
      images: options?.images,
      // The screen text is the whole payload on this path, so give it room the
      // default budget would otherwise spend on knowledge and memory sections.
      maxTranscriptLines: 8,
    },
  });

  const screenContext = screenText
    ? `\n--- SCREEN CONTENT ---\n${screenText.slice(0, 4000)}\n--- END SCREEN ---`
    : '';

  const recentTranscript = transcript
    .filter((line) => !line.isInterim)
    .slice(-8)
    .map((line) => `[${line.speaker === 'user' ? 'You' : 'Other'}]: ${line.text}`)
    .join('\n');

  const transcriptContext = recentTranscript
    ? `\n--- LIVE CONVERSATION ---\n${recentTranscript}\n--- END CONVERSATION ---`
    : '';

  return {
    // Appended after `build()` rather than folded into the mode prompt so it
    // applies to every mode — including User-defined custom modes — and so it
    // lands last in the system message, where a model weights it most. Our own
    // text, so it carries no User data and does not affect the redaction
    // attestation `build()` produced.
    systemPrompt: `${result.systemPrompt}\n\n${ANSWER_FIRST_DIRECTIVE}`,
    knowledgeContext: '',
    transcriptContext,
    screenContext,
    userQuery,
    fullPrompt: result.fullPrompt,
    modalitiesUsed: result.trace.modalitiesUsed,
    citations: [],
    images: result.images,
    redaction: result.redaction,
  };
}

/**
 * Build a context window using the legacy signature.
 *
 * Delegates to `build()` from contextBuilder, adapting the legacy
 * TranscriptLine[] and fetching knowledge chunks from the database.
 */
export async function buildContextWindow(
  mode: CopilotMode,
  transcript: TranscriptLine[],
  screenText: string,
  userQuery: string,
  customModes: ModeConfig[] = [],
  options?: {
    images?: Array<{ mimeType: string; base64: string }>;
    /**
     * Ceiling on the Knowledge_Base + Memory_Store retrieval wait. Whichever
     * search hasn't resolved by then is dropped from the prompt. Pass
     * `Infinity` to restore the original unbounded behaviour.
     */
    retrievalDeadlineMs?: number;
  },
): Promise<ContextWindow> {
  const searchQuery = userQuery || transcript.slice(-3).map(l => l.text).join(' ');

  // Run both retrievals concurrently and cap the combined wait. Previously
  // these were sequential awaits, so the two embedding passes stacked: the
  // Memory_Store search could not start until the Knowledge_Base search had
  // finished with the model.
  let kbChunks: string[] = [];
  let memoryChunks: MemoryChunk[] = [];

  const kbSearch = (async (): Promise<string[]> => {
    try {
      return await knowledgeBase.search(searchQuery, MAX_KB_CHUNKS);
    } catch {
      return []; // KB might not be initialized yet
    }
  })();

  const memorySearch = (async (): Promise<MemoryChunk[]> => {
    try {
      const store = await ensureMemoryStoreReady();
      const memoryResults: SearchResult[] = await store.search(searchQuery, {
        maxResults: MAX_MEMORY_CHUNKS,
      });
      return memoryResults.map((result) => ({
        text: result.fact.text,
        meetingId: result.fact.source.meetingId,
        date: result.fact.source.date,
      }));
    } catch {
      return []; // Memory store might not be available yet
    }
  })();

  // Whatever each search has produced by the deadline is what gets used. The
  // searches themselves keep running — their warmed embedding model and any
  // persistence load make the *next* dispatch faster.
  kbSearch.then((chunks) => { kbChunks = chunks; }).catch(() => undefined);
  memorySearch.then((chunks) => { memoryChunks = chunks; }).catch(() => undefined);

  const deadlineMs = options?.retrievalDeadlineMs ?? DEFAULT_RETRIEVAL_DEADLINE_MS;
  const retrieval = Promise.all([kbSearch, memorySearch]);
  if (Number.isFinite(deadlineMs)) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      retrieval,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, deadlineMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (kbChunks.length === 0 && memoryChunks.length === 0) {
      // Either both searches genuinely found nothing, or they overran. Only the
      // latter is worth reporting, and only once per dispatch.
      void retrieval.then(([kb, mem]) => {
        if (kb.length > 0 || mem.length > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[contextManager] retrieval exceeded ${deadlineMs}ms budget; prompt sent without it`,
          );
        }
      }).catch(() => undefined);
    }
  } else {
    [kbChunks, memoryChunks] = await retrieval;
  }

  // Load the User's redaction rules so this path redacts before egress
  // instead of opting out (Requirement 2.9). A missing or unreadable setting
  // degrades to an empty rule set, which still produces a *passing*
  // attestation — every segment went through the Redaction_Engine, there was
  // simply nothing to match. Opting out via `skipRedaction` would instead
  // stamp `applied: false` and block the custom provider entirely.
  const redactionRules = await loadRedactionRules();

  const knowledgeChunks = kbChunks.map((text) => ({ text }));

  // Adapt legacy transcript lines to new shape
  const transcriptionLines = transcript.map(toLegacyTranscriptionLine);

  // Delegate to the new Context_Builder
  const result = build({
    mode,
    transcript: transcriptionLines,
    screenText,
    knowledgeChunks,
    memoryChunks,
    userQuery,
    countTokens: countTokensApprox,
    settings: {
      customModes,
      redactionRules,
      // Redact on this path too, so the prompts it produces carry a passing
      // attestation and are eligible for cloud providers (Requirement 2.9).
      skipRedaction: false,
      images: options?.images,
    },
  });

  // Reconstruct legacy ContextWindow shape from build() output
  const knowledgeContext = result.knowledge.length > 0
    ? `\n--- YOUR KNOWLEDGE BASE ---\n${kbChunks.join('\n\n')}\n--- END KNOWLEDGE BASE ---`
    : '';

  const memoryContext = result.memory.length > 0
    ? `\n--- MEMORY ---\n${result.memory.map((s) => s.text).join('\n')}\n--- END MEMORY ---`
    : '';

  const screenContext = screenText
    ? `\n--- SCREEN CONTENT ---\n${screenText.slice(0, 4000)}\n--- END SCREEN ---`
    : '';

  const recentTranscript = transcript
    .filter(line => !line.isInterim)
    .slice(-20)
    .map(line => `[${line.speaker === 'user' ? 'You' : 'Other'}]: ${line.text}`)
    .join('\n');

  const transcriptContext = recentTranscript
    ? `\n--- LIVE CONVERSATION ---\n${recentTranscript}\n--- END CONVERSATION ---`
    : '';

  // Build citation info from knowledge and memory sections (Requirements 5.5, 24.2)
  const citations: CitationInfo[] = [
    ...result.knowledge
      .filter((s) => s.citationId)
      .map((s) => ({
        citationId: s.citationId!,
        label: s.label as CitationInfo['label'],
        source: s.source,
      })),
    ...result.memory
      .filter((s) => s.citationId)
      .map((s) => ({
        citationId: s.citationId!,
        label: s.label as CitationInfo['label'],
        source: s.source,
      })),
  ];

  return {
    systemPrompt: result.systemPrompt,
    knowledgeContext: knowledgeContext + memoryContext,
    transcriptContext,
    screenContext,
    userQuery,
    fullPrompt: result.fullPrompt,
    modalitiesUsed: result.trace.modalitiesUsed,
    citations,
    images: result.images,
    // Pass the Context_Builder's measurement straight through so
    // `aiProvider.toPromptInput` can forward it to the adapters
    // (Requirements 2.9, 2.10).
    redaction: result.redaction,
  };
}
