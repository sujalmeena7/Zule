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
  /** Modalities that contributed to the assembled prompt (Requirement 23.4). */
  modalitiesUsed?: ('audio' | 'screen' | 'knowledge' | 'memory')[];
  /** Citation info for rendering citation chips (Requirements 5.5, 24.2). */
  citations?: CitationInfo[];
  /** Optional image attachments for adapters with `capabilities.imageInput` (Requirement 23.3). */
  images?: Array<{ mimeType: string; base64: string }>;
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

const MAX_KB_CHUNKS = 3;
const MAX_MEMORY_CHUNKS = 5;

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
  options?: { images?: Array<{ mimeType: string; base64: string }> },
): Promise<ContextWindow> {
  // Fetch knowledge chunks from database (mirrors legacy behaviour)
  const searchQuery = userQuery || transcript.slice(-3).map(l => l.text).join(' ');
  let kbChunks: string[] = [];
  try {
    kbChunks = await knowledgeBase.search(searchQuery, MAX_KB_CHUNKS);
  } catch {
    // KB might not be initialized yet
  }

  // Search Memory_Store alongside Knowledge_Base (Requirement 24.1)
  let memoryChunks: MemoryChunk[] = [];
  try {
    const store = await ensureMemoryStoreReady();
    const memoryResults: SearchResult[] = await store.search(searchQuery, {
      maxResults: MAX_MEMORY_CHUNKS,
    });
    memoryChunks = memoryResults.map((result) => ({
      text: result.fact.text,
      meetingId: result.fact.source.meetingId,
      date: result.fact.source.date,
    }));
  } catch {
    // Memory store might not be available yet
  }

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
      skipRedaction: true, // Legacy path did not redact
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
    ? `\n--- SCREEN CONTENT ---\n${screenText.slice(0, 1000)}\n--- END SCREEN ---`
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
  };
}
