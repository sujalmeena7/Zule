// ============================================
// Zule AI — Context_Builder (design §4)
// ============================================
//
// Tokenizer-aware prompt assembly with priority-drop trimming,
// modality tagging, citation ids, and redaction.
//
// Replaces `contextManager.ts`. Key behavioural differences:
//   - Token counting via `countTokens(text)` (not char-based)
//   - Priority-drop trimming (not middle-truncation)
//   - Configurable caps (transcript lines, knowledge chunks)
//   - Section headers preserved verbatim during trimming
//   - Modality labels: [AUDIO], [SCREEN], [KNOWLEDGE], [MEMORY]
//   - Citation ids: [K1], [K2], ..., [M1], [M2], ...
//   - Redaction applied before cloud egress
//   - PromptAssemblyTrace emitted for telemetry
//
// Requirements: 5.1, 5.2, 5.3, 5.5, 5.6, 15.3, 23.1, 23.2, 23.4, 24.1

import type { CopilotMode, ModeConfig } from './modePrompts';
import type { TranscriptionLine } from '../types/transcription';
import type { RedactionRule } from '../types/redaction';
import { getSystemPrompt } from './modePrompts';
import { apply as redact } from './redaction';

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

export interface ContextSection {
  label: '[KNOWLEDGE]' | '[MEMORY]' | '[AUDIO]' | '[SCREEN]';
  text: string;
  tokenCount: number;
  citationId?: string;
  source?: { docId?: string; meetingId?: string; date?: number };
}

export interface PromptAssemblyTrace {
  systemTokens: number;
  knowledgeTokens: number;
  memoryTokens: number;
  transcriptTokens: number;
  screenTokens: number;
  totalTokens: number;
  budgetTokens: number;
  droppedSections: string[];
  modalitiesUsed: ('audio' | 'screen' | 'knowledge' | 'memory')[];
}

export interface ContextWindow {
  systemPrompt: string;
  knowledge: ContextSection[];
  memory: ContextSection[];
  transcript: ContextSection;
  screen: ContextSection | null;
  userQuery: string;
  /** The derived retrieval query (Requirement 5.4).
   *  When userQuery is empty, falls back to most recent question-shaped
   *  utterance from 'other', or last 200 chars of final transcript. */
  retrievalQuery: string;
  fullPrompt: string;
  trace: PromptAssemblyTrace;
  /** Optional image attachments for adapters with `capabilities.imageInput` (Requirement 23.3). */
  images?: Array<{ mimeType: string; base64: string }>;
}

export interface KnowledgeChunk {
  text: string;
  similarity?: number;
  docId?: string;
  date?: number;
}

export interface MemoryChunk {
  text: string;
  meetingId?: string;
  date?: number;
}

export interface ContextBuilderSettings {
  budgetTokens?: number;
  maxTranscriptLines?: number;
  maxKnowledgeChunks?: number;
  redactionRules?: RedactionRule[];
  customModes?: ModeConfig[];
  /** When true, skip redaction (e.g. for local-only providers). */
  skipRedaction?: boolean;
  /** BCP-47 language tag for the user's recognition language.
   *  When set, a "Respond in <language>." directive is appended to the system prompt. */
  language?: string;
  /** Compact style directive from StyleProfileStore.toDirective().
   *  When non-empty, appended to the system prompt after the language directive (Requirement 22.2). */
  styleDirective?: string;
  /** Optional image attachments for adapters with `capabilities.imageInput`.
   *  When the active adapter supports image input and the user has opted in,
   *  a downscaled keyframe is passed alongside OCR text (Requirement 23.3). */
  images?: Array<{ mimeType: string; base64: string }>;
}

export interface BuildInput {
  mode: CopilotMode;
  transcript: TranscriptionLine[];
  screenText: string;
  knowledgeChunks: KnowledgeChunk[];
  memoryChunks: MemoryChunk[];
  userQuery: string;
  countTokens: (text: string) => number;
  settings?: ContextBuilderSettings;
}

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const DEFAULT_BUDGET_TOKENS = 8_000;
const DEFAULT_MAX_TRANSCRIPT_LINES = 30;
const DEFAULT_MAX_KNOWLEDGE_CHUNKS = 5;

// Section header constants (preserved verbatim during trimming)
const HEADER_KNOWLEDGE = '[KNOWLEDGE]';
const HEADER_MEMORY = '[MEMORY]';
const HEADER_AUDIO = '[AUDIO]';
const HEADER_SCREEN = '[SCREEN]';

// ---------------------------------------------------------------------
// build() — main entry point
// ---------------------------------------------------------------------

/**
 * Assemble a token-bounded context window from the provided inputs.
 *
 * Drop order when over budget:
 *   1. Screen text (lowest priority)
 *   2. Older transcript lines
 *   3. Lower-similarity knowledge chunks
 *   4. Older knowledge chunks (fallback when no similarity info)
 *
 * Section headers are preserved verbatim — only their content is trimmed.
 */
export function build(input: BuildInput): ContextWindow {
  const {
    mode,
    transcript,
    screenText,
    knowledgeChunks,
    memoryChunks,
    userQuery,
    countTokens,
    settings = {},
  } = input;

  const budgetTokens = settings.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const maxTranscriptLines = settings.maxTranscriptLines ?? DEFAULT_MAX_TRANSCRIPT_LINES;
  const maxKnowledgeChunks = settings.maxKnowledgeChunks ?? DEFAULT_MAX_KNOWLEDGE_CHUNKS;
  const redactionRules = settings.redactionRules ?? [];
  const skipRedaction = settings.skipRedaction ?? false;
  const language = settings.language;
  const styleDirective = settings.styleDirective;

  // 1) Build system prompt with language directive (Requirement 17.4)
  //    then style directive when personalization is enabled (Requirement 22.2)
  const systemPrompt = appendStyleDirective(
    appendLanguageDirective(
      getSystemPrompt(mode, settings.customModes),
      language,
    ),
    styleDirective,
  );

  // 2) Derive retrieval query for upstream callers (Requirement 5.4)
  const retrievalQuery = deriveRetrievalQuery(transcript, userQuery);

  // 3) Apply caps before assembly
  const finalTranscriptLines = transcript
    .filter((line) => !line.isInterim)
    .slice(-maxTranscriptLines);

  const cappedKnowledge = knowledgeChunks.slice(0, maxKnowledgeChunks);

  // 4) Build section texts with modality labels and citations
  const knowledgeSections = buildKnowledgeSections(cappedKnowledge);
  const memorySections = buildMemorySections(memoryChunks);
  const transcriptSection = buildTranscriptSection(finalTranscriptLines);
  const screenSection = buildScreenSection(screenText);

  // 5) Apply redaction to all sections before cloud egress
  const redactText = (text: string): string => {
    if (skipRedaction || redactionRules.length === 0) return text;
    return redact(text, redactionRules);
  };

  const redactedKnowledge = knowledgeSections.map((s) => ({
    ...s,
    text: redactText(s.text),
  }));
  const redactedMemory = memorySections.map((s) => ({
    ...s,
    text: redactText(s.text),
  }));
  const redactedTranscript: ContextSection = {
    ...transcriptSection,
    text: redactText(transcriptSection.text),
  };
  const redactedScreen: ContextSection | null = screenSection
    ? { ...screenSection, text: redactText(screenSection.text) }
    : null;

  // 6) Count tokens for each section (after redaction)
  const systemTokens = countTokens(systemPrompt);
  // The query suffix is the text appended at the end of the prompt
  const querySuffix = userQuery
    ? `\nUser's question: "${userQuery}"`
    : '\nBased on the conversation above, provide your suggestion now.';
  const querySuffixTokens = countTokens(querySuffix);

  // Recount tokens after redaction (redaction may change text length)
  for (const s of redactedKnowledge) s.tokenCount = countTokens(s.text);
  for (const s of redactedMemory) s.tokenCount = countTokens(s.text);
  redactedTranscript.tokenCount = countTokens(redactedTranscript.text);
  if (redactedScreen) redactedScreen.tokenCount = countTokens(redactedScreen.text);

  // 7) Priority-drop trimming to fit budget
  const { knowledge, memory, transcript: trimmedTranscript, screen, droppedSections } =
    priorityDrop({
      budgetTokens,
      systemTokens,
      querySuffixTokens,
      knowledge: redactedKnowledge,
      memory: redactedMemory,
      transcript: redactedTranscript,
      screen: redactedScreen,
      countTokens,
    });

  // 8) Assemble full prompt
  let fullPrompt = assembleFullPrompt({
    systemPrompt,
    knowledge,
    memory,
    transcript: trimmedTranscript,
    screen,
    userQuery,
  });

  // 8b) Final verification: if assembled prompt still exceeds budget due to
  // joining overhead (newlines between sections), do a final trim pass.
  // This handles edge cases where the estimation in priorityDrop diverged.
  let finalKnowledge = knowledge;
  let finalMemory = memory;
  let finalTranscript = trimmedTranscript;
  let finalScreen = screen;
  const finalDropped = [...droppedSections];

  while (countTokens(fullPrompt) > budgetTokens) {
    // Check if the system prompt alone exceeds budget — nothing more we can do
    const basePromptTokens = countTokens(systemPrompt + querySuffix);
    if (basePromptTokens >= budgetTokens) break;

    // Try dropping in priority order
    if (finalScreen) {
      finalScreen = null;
      if (!finalDropped.includes('screen')) finalDropped.push('screen');
    } else if (finalTranscript.text.length > 0) {
      const lines = finalTranscript.text.split('\n');
      if (lines.length > 0) {
        lines.shift();
        finalTranscript = {
          ...finalTranscript,
          text: lines.join('\n'),
          tokenCount: lines.length > 0 ? countTokens(lines.join('\n')) : 0,
        };
        if (!finalDropped.includes('older-transcript')) finalDropped.push('older-transcript');
      } else {
        break;
      }
    } else if (finalKnowledge.length > 0) {
      finalKnowledge = finalKnowledge.slice(0, -1);
      if (!finalDropped.includes('lower-similarity-knowledge')) finalDropped.push('lower-similarity-knowledge');
    } else if (finalMemory.length > 0) {
      finalMemory = finalMemory.slice(1);
      if (!finalDropped.includes('older-memory')) finalDropped.push('older-memory');
    } else {
      break; // Nothing left to trim
    }

    fullPrompt = assembleFullPrompt({
      systemPrompt,
      knowledge: finalKnowledge,
      memory: finalMemory,
      transcript: finalTranscript,
      screen: finalScreen,
      userQuery,
    });
  }

  // 9) Build trace
  const knowledgeTokens = finalKnowledge.reduce((sum, s) => sum + s.tokenCount, 0);
  const memoryTokens = finalMemory.reduce((sum, s) => sum + s.tokenCount, 0);
  const transcriptTokens = finalTranscript.tokenCount;
  const screenTokens = finalScreen?.tokenCount ?? 0;
  const totalTokens = countTokens(fullPrompt);

  const modalitiesUsed: PromptAssemblyTrace['modalitiesUsed'] = [];
  if (finalTranscript.text.length > 0) modalitiesUsed.push('audio');
  if (finalScreen && finalScreen.text.length > 0) modalitiesUsed.push('screen');
  if (finalKnowledge.length > 0) modalitiesUsed.push('knowledge');
  if (finalMemory.length > 0) modalitiesUsed.push('memory');

  const trace: PromptAssemblyTrace = {
    systemTokens,
    knowledgeTokens,
    memoryTokens,
    transcriptTokens,
    screenTokens,
    totalTokens,
    budgetTokens,
    droppedSections: finalDropped,
    modalitiesUsed,
  };

  return {
    systemPrompt,
    knowledge: finalKnowledge,
    memory: finalMemory,
    transcript: finalTranscript,
    screen: finalScreen,
    userQuery,
    retrievalQuery,
    fullPrompt,
    trace,
    // Pass through images when adapter supports image input (Requirement 23.3)
    images: settings.images,
  };
}

// ---------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------

function buildKnowledgeSections(chunks: KnowledgeChunk[]): ContextSection[] {
  return chunks.map((chunk, i) => ({
    label: '[KNOWLEDGE]' as const,
    text: `[K${i + 1}] ${chunk.text}`,
    tokenCount: 0, // computed later
    citationId: `K${i + 1}`,
    source: { docId: chunk.docId, date: chunk.date },
  }));
}

function buildMemorySections(chunks: MemoryChunk[]): ContextSection[] {
  return chunks.map((chunk, i) => {
    // Label format per Requirement 24.1: [MEMORY: meeting:{id}, {date}]
    const dateStr = chunk.date ? new Date(chunk.date).toISOString().slice(0, 10) : 'unknown';
    const meetingLabel = chunk.meetingId
      ? `[MEMORY: meeting:${chunk.meetingId}, ${dateStr}]`
      : `[MEMORY]`;
    return {
      label: '[MEMORY]' as const,
      text: `[M${i + 1}] ${meetingLabel} ${chunk.text}`,
      tokenCount: 0, // computed later
      citationId: `M${i + 1}`,
      source: { meetingId: chunk.meetingId, date: chunk.date },
    };
  });
}

function buildTranscriptSection(lines: TranscriptionLine[]): ContextSection {
  const text = lines
    .map((line) => `[${line.speakerRole === 'user' ? 'You' : 'Other'}]: ${line.text}`)
    .join('\n');
  return {
    label: '[AUDIO]' as const,
    text,
    tokenCount: 0, // computed later
  };
}

function buildScreenSection(screenText: string): ContextSection | null {
  if (!screenText || screenText.trim().length === 0) return null;
  return {
    label: '[SCREEN]' as const,
    text: screenText,
    tokenCount: 0, // computed later
  };
}

// ---------------------------------------------------------------------
// Priority-drop trimming
// ---------------------------------------------------------------------

interface PriorityDropInput {
  budgetTokens: number;
  systemTokens: number;
  querySuffixTokens: number;
  knowledge: ContextSection[];
  memory: ContextSection[];
  transcript: ContextSection;
  screen: ContextSection | null;
  countTokens: (text: string) => number;
}

interface PriorityDropResult {
  knowledge: ContextSection[];
  memory: ContextSection[];
  transcript: ContextSection;
  screen: ContextSection | null;
  droppedSections: string[];
}

function priorityDrop(input: PriorityDropInput): PriorityDropResult {
  const {
    budgetTokens,
    systemTokens,
    querySuffixTokens,
    countTokens: countFn,
  } = input;

  let knowledge = [...input.knowledge];
  let memory = [...input.memory];
  let transcript = { ...input.transcript };
  let screen = input.screen ? { ...input.screen } : null;
  const droppedSections: string[] = [];

  // Calculate current total tokens (sum of sections + system + query suffix + overhead for labels/newlines)
  const calcTotal = (): number => {
    let total = systemTokens + querySuffixTokens;
    for (const s of knowledge) total += s.tokenCount;
    for (const s of memory) total += s.tokenCount;
    total += transcript.tokenCount;
    if (screen) total += screen.tokenCount;
    // Add approximate overhead for section headers and newlines between sections
    const headerOverhead =
      (knowledge.length > 0 ? countFn('\n' + HEADER_KNOWLEDGE + '\n') : 0) +
      (memory.length > 0 ? countFn('\n' + HEADER_MEMORY + '\n') : 0) +
      (transcript.text.length > 0 ? countFn('\n' + HEADER_AUDIO + '\n') : 0) +
      (screen ? countFn('\n' + HEADER_SCREEN + '\n') : 0);
    total += headerOverhead;
    return total;
  };

  // Drop 1: Screen text (lowest priority)
  if (calcTotal() > budgetTokens && screen) {
    droppedSections.push('screen');
    screen = null;
  }

  // Drop 2: Older transcript lines (drop oldest first)
  if (calcTotal() > budgetTokens && transcript.text.length > 0) {
    const lines = transcript.text.split('\n');
    while (calcTotal() > budgetTokens && lines.length > 0) {
      lines.shift(); // Remove oldest line
      transcript = {
        ...transcript,
        text: lines.join('\n'),
        tokenCount: lines.length > 0 ? countFn(lines.join('\n')) : 0,
      };
      if (!droppedSections.includes('older-transcript')) {
        droppedSections.push('older-transcript');
      }
    }
  }

  // Drop 3: Lower-similarity knowledge chunks (drop lowest similarity first)
  // Knowledge chunks are provided in similarity order (highest first), so we drop from the end
  if (calcTotal() > budgetTokens && knowledge.length > 0) {
    while (calcTotal() > budgetTokens && knowledge.length > 0) {
      knowledge.pop(); // Remove lowest-similarity (last in pre-sorted array)
      if (!droppedSections.includes('lower-similarity-knowledge')) {
        droppedSections.push('lower-similarity-knowledge');
      }
    }
  }

  // Drop 4: Memory chunks (older first) if still over budget
  if (calcTotal() > budgetTokens && memory.length > 0) {
    while (calcTotal() > budgetTokens && memory.length > 0) {
      memory.shift(); // Remove oldest memory
      if (!droppedSections.includes('older-memory')) {
        droppedSections.push('older-memory');
      }
    }
  }

  return { knowledge, memory, transcript, screen, droppedSections };
}

// ---------------------------------------------------------------------
// Full prompt assembly
// ---------------------------------------------------------------------

interface AssembleInput {
  systemPrompt: string;
  knowledge: ContextSection[];
  memory: ContextSection[];
  transcript: ContextSection;
  screen: ContextSection | null;
  userQuery: string;
}

function assembleFullPrompt(input: AssembleInput): string {
  const parts: string[] = [];

  parts.push(input.systemPrompt);

  if (input.knowledge.length > 0) {
    parts.push(`\n${HEADER_KNOWLEDGE}`);
    for (const s of input.knowledge) {
      parts.push(s.text);
    }
  }

  if (input.memory.length > 0) {
    parts.push(`\n${HEADER_MEMORY}`);
    for (const s of input.memory) {
      parts.push(s.text);
    }
  }

  if (input.transcript.text.length > 0) {
    parts.push(`\n${HEADER_AUDIO}`);
    parts.push(input.transcript.text);
  }

  if (input.screen) {
    parts.push(`\n${HEADER_SCREEN}`);
    parts.push(input.screen.text);
  }

  if (input.userQuery) {
    parts.push(`\nUser's question: "${input.userQuery}"`);
  } else {
    parts.push('\nBased on the conversation above, provide your suggestion now.');
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------
// Implicit retrieval query fallback (Requirement 5.4)
// ---------------------------------------------------------------------

/**
 * Determine the retrieval query when userQuery is empty.
 *
 * Priority:
 *   1. Most recent question-shaped utterance from speaker 'other'
 *      (ends with '?')
 *   2. Last 200 characters of the concatenated final transcript text
 *   3. Empty string (no retrieval possible)
 *
 * When userQuery is non-empty, it is returned as-is.
 */
export function deriveRetrievalQuery(
  transcript: TranscriptionLine[],
  userQuery: string,
): string {
  // If userQuery is provided, use it directly
  if (userQuery.trim().length > 0) {
    return userQuery;
  }

  // Filter to final (non-interim) lines only
  const finalLines = transcript.filter((line) => !line.isInterim);

  // Scan from most recent to oldest for a question-shaped utterance from 'other'
  for (let i = finalLines.length - 1; i >= 0; i--) {
    const line = finalLines[i];
    if (line.speakerRole === 'other' && /\?\s*$/.test(line.text)) {
      return line.text;
    }
  }

  // Fallback: last 200 characters of the concatenated final transcript
  if (finalLines.length > 0) {
    const fullText = finalLines.map((l) => l.text).join(' ');
    if (fullText.length > 0) {
      return fullText.slice(-200);
    }
  }

  return '';
}

// ---------------------------------------------------------------------
// Language directive (Requirement 17.4)
// ---------------------------------------------------------------------

/**
 * Append a language directive to the system prompt when a BCP-47 language
 * tag is provided. The directive instructs the model to respond in that language.
 *
 * If language is empty/undefined, the system prompt is returned unchanged.
 */
export function appendLanguageDirective(
  systemPrompt: string,
  language: string | undefined,
): string {
  if (!language || language.trim().length === 0) {
    return systemPrompt;
  }
  return `${systemPrompt}\nRespond in ${language.trim()}.`;
}

/**
 * Append a compact style directive to the system prompt when personalization is enabled.
 * The caller populates `styleDirective` from `StyleProfileStore.toDirective()`.
 * Requirement 22.2.
 */
export function appendStyleDirective(
  systemPrompt: string,
  styleDirective: string | undefined,
): string {
  if (!styleDirective || styleDirective.trim().length === 0) {
    return systemPrompt;
  }
  return `${systemPrompt}\n${styleDirective.trim()}`;
}
