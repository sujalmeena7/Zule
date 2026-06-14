// ============================================
// Zule AI — Context_Builder property-based tests
// ============================================
//
// Property 15: For arbitrary inputs, the assembled fullPrompt has token
// count ≤ budgetTokens (when the budget allows at least the system
// prompt); knowledge chunks ≤ maxKnowledgeChunks; transcript lines ≤
// maxTranscriptLines; every knowledge chunk has a citation id [K1..Kn];
// dropped sections appear in trace.droppedSections.
//
// **Validates: Requirements 5.1, 5.2, 5.3, 5.5, 5.6, 23.1, 24.1**

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { build } from './contextBuilder';
import type {
  BuildInput,
  KnowledgeChunk,
  MemoryChunk,
  ContextBuilderSettings,
} from './contextBuilder';
import type { TranscriptionLine } from '../types/transcription';

// ---------------------------------------------------------------------
// Helpers: simple countTokens mock (word count)
// ---------------------------------------------------------------------

/** Simple tokenizer: count words separated by whitespace. Minimum 1 token for non-empty text. */
function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

// ---------------------------------------------------------------------
// Arbitraries (generators)
// ---------------------------------------------------------------------

const arbTranscriptLine: fc.Arbitrary<TranscriptionLine> = fc.record({
  id: fc.uuid(),
  text: fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0),
  timestamp: fc.nat(),
  isInterim: fc.constant(false),
  speakerId: fc.constantFrom('speaker-1', 'speaker-2'),
  speakerRole: fc.constantFrom('user' as const, 'other' as const),
  detection: fc.constantFrom('manual' as const, 'gap-heuristic' as const, 'voiceprint' as const),
  detectionConfidence: fc.double({ min: 0, max: 1, noNaN: true }),
  asrConfidence: fc.double({ min: 0, max: 1, noNaN: true }),
  language: fc.constant('en-US'),
  provider: fc.constant('web-speech' as const),
});

const arbKnowledgeChunk: fc.Arbitrary<KnowledgeChunk> = fc.record({
  text: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
  similarity: fc.double({ min: 0, max: 1, noNaN: true }),
  docId: fc.option(fc.uuid(), { nil: undefined }),
  date: fc.option(fc.nat(), { nil: undefined }),
});

const arbMemoryChunk: fc.Arbitrary<MemoryChunk> = fc.record({
  text: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
  meetingId: fc.option(fc.uuid(), { nil: undefined }),
  date: fc.option(fc.nat(), { nil: undefined }),
});

const arbScreenText: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
);

const arbUserQuery: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length > 0),
);

// ---------------------------------------------------------------------
// Property 15 tests
// ---------------------------------------------------------------------

describe('Context_Builder — Property 15', () => {
  it('assembled fullPrompt token count ≤ budgetTokens when budget allows system prompt + suffix', () => {
    fc.assert(
      fc.property(
        fc.array(arbTranscriptLine, { minLength: 0, maxLength: 50 }),
        arbScreenText,
        fc.array(arbKnowledgeChunk, { minLength: 0, maxLength: 10 }),
        fc.array(arbMemoryChunk, { minLength: 0, maxLength: 5 }),
        arbUserQuery,
        fc.integer({ min: 50, max: 500 }), // budget (generous enough for system prompt)
        (transcript, screenText, knowledgeChunks, memoryChunks, userQuery, budgetTokens) => {
          const input: BuildInput = {
            mode: 'assist',
            transcript,
            screenText,
            knowledgeChunks,
            memoryChunks,
            userQuery,
            countTokens,
            settings: { budgetTokens, skipRedaction: true },
          };

          const result = build(input);

          // The minimum irreducible prompt is the system prompt + query suffix.
          // When even this exceeds the budget, trimming can't help.
          const querySuffix = userQuery
            ? `\nUser's question: "${userQuery}"`
            : '\nBased on the conversation above, provide your suggestion now.';
          const minPrompt = result.systemPrompt + '\n' + querySuffix;
          const minTokens = countTokens(minPrompt);

          if (minTokens <= budgetTokens) {
            // Token count of fullPrompt should respect budget
            const fullPromptTokens = countTokens(result.fullPrompt);
            expect(fullPromptTokens).toBeLessThanOrEqual(budgetTokens);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('knowledge chunks ≤ maxKnowledgeChunks', () => {
    fc.assert(
      fc.property(
        fc.array(arbKnowledgeChunk, { minLength: 0, maxLength: 15 }),
        fc.integer({ min: 1, max: 10 }),
        (knowledgeChunks, maxKnowledgeChunks) => {
          const input: BuildInput = {
            mode: 'assist',
            transcript: [],
            screenText: '',
            knowledgeChunks,
            memoryChunks: [],
            userQuery: 'test',
            countTokens,
            settings: { budgetTokens: 100_000, maxKnowledgeChunks, skipRedaction: true },
          };

          const result = build(input);
          expect(result.knowledge.length).toBeLessThanOrEqual(maxKnowledgeChunks);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('transcript lines ≤ maxTranscriptLines', () => {
    fc.assert(
      fc.property(
        fc.array(arbTranscriptLine, { minLength: 0, maxLength: 60 }),
        fc.integer({ min: 1, max: 30 }),
        (transcript, maxTranscriptLines) => {
          const input: BuildInput = {
            mode: 'assist',
            transcript,
            screenText: '',
            knowledgeChunks: [],
            memoryChunks: [],
            userQuery: 'test',
            countTokens,
            settings: { budgetTokens: 100_000, maxTranscriptLines, skipRedaction: true },
          };

          const result = build(input);
          // Count the actual lines in the transcript section
          const lineCount =
            result.transcript.text.length === 0
              ? 0
              : result.transcript.text.split('\n').length;
          const finalLines = transcript.filter((l) => !l.isInterim).length;
          const expectedMax = Math.min(finalLines, maxTranscriptLines);
          expect(lineCount).toBeLessThanOrEqual(expectedMax);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('every knowledge chunk has a citation id [K1..Kn]', () => {
    fc.assert(
      fc.property(
        fc.array(arbKnowledgeChunk, { minLength: 1, maxLength: 8 }),
        (knowledgeChunks) => {
          const input: BuildInput = {
            mode: 'assist',
            transcript: [],
            screenText: '',
            knowledgeChunks,
            memoryChunks: [],
            userQuery: 'test',
            countTokens,
            settings: { budgetTokens: 100_000, skipRedaction: true },
          };

          const result = build(input);

          // Every knowledge section must have a citationId matching [K1..Kn]
          for (let i = 0; i < result.knowledge.length; i++) {
            const section = result.knowledge[i];
            expect(section.citationId).toBe(`K${i + 1}`);
            // The text should contain the citation reference
            expect(section.text).toContain(`[K${i + 1}]`);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('every memory chunk has a citation id [M1..Mn]', () => {
    fc.assert(
      fc.property(
        fc.array(arbMemoryChunk, { minLength: 1, maxLength: 5 }),
        (memoryChunks) => {
          const input: BuildInput = {
            mode: 'assist',
            transcript: [],
            screenText: '',
            knowledgeChunks: [],
            memoryChunks,
            userQuery: 'test',
            countTokens,
            settings: { budgetTokens: 100_000, skipRedaction: true },
          };

          const result = build(input);

          for (let i = 0; i < result.memory.length; i++) {
            const section = result.memory[i];
            expect(section.citationId).toBe(`M${i + 1}`);
            expect(section.text).toContain(`[M${i + 1}]`);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('dropped sections appear in trace.droppedSections when budget forces trimming', () => {
    fc.assert(
      fc.property(
        fc.array(arbTranscriptLine, { minLength: 5, maxLength: 30 }),
        arbScreenText.filter((s) => s.length > 0),
        fc.array(arbKnowledgeChunk, { minLength: 1, maxLength: 5 }),
        (transcript, screenText, knowledgeChunks) => {
          // Use a very tight budget to force trimming
          const input: BuildInput = {
            mode: 'assist',
            transcript,
            screenText,
            knowledgeChunks,
            memoryChunks: [],
            userQuery: 'What should I do?',
            countTokens,
            settings: { budgetTokens: 30, skipRedaction: true },
          };

          const result = build(input);

          // If sections were dropped, they should be recorded in trace
          if (result.screen === null && screenText.trim().length > 0) {
            expect(result.trace.droppedSections).toContain('screen');
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('drop order is respected: screen first, then older-transcript, then lower-similarity-knowledge', () => {
    fc.assert(
      fc.property(
        fc.array(arbTranscriptLine, { minLength: 5, maxLength: 20 }),
        fc.array(arbKnowledgeChunk, { minLength: 2, maxLength: 5 }),
        (transcript, knowledgeChunks) => {
          // Tight budget to force multiple drops
          const input: BuildInput = {
            mode: 'assist',
            transcript,
            screenText: 'Some screen content here that is visible',
            knowledgeChunks,
            memoryChunks: [],
            userQuery: 'question',
            countTokens,
            settings: { budgetTokens: 25, skipRedaction: true },
          };

          const result = build(input);
          const dropped = result.trace.droppedSections;

          // If both screen and transcript were dropped, screen must come first
          const screenIdx = dropped.indexOf('screen');
          const transcriptIdx = dropped.indexOf('older-transcript');
          const knowledgeIdx = dropped.indexOf('lower-similarity-knowledge');

          if (screenIdx >= 0 && transcriptIdx >= 0) {
            expect(screenIdx).toBeLessThan(transcriptIdx);
          }
          if (transcriptIdx >= 0 && knowledgeIdx >= 0) {
            expect(transcriptIdx).toBeLessThan(knowledgeIdx);
          }
          if (screenIdx >= 0 && knowledgeIdx >= 0) {
            expect(screenIdx).toBeLessThan(knowledgeIdx);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('sections are annotated with correct modality labels', () => {
    fc.assert(
      fc.property(
        fc.array(arbTranscriptLine, { minLength: 1, maxLength: 10 }),
        arbScreenText.filter((s) => s.trim().length > 0),
        fc.array(arbKnowledgeChunk, { minLength: 1, maxLength: 3 }),
        fc.array(arbMemoryChunk, { minLength: 1, maxLength: 2 }),
        (transcript, screenText, knowledgeChunks, memoryChunks) => {
          const input: BuildInput = {
            mode: 'assist',
            transcript,
            screenText,
            knowledgeChunks,
            memoryChunks,
            userQuery: 'test',
            countTokens,
            settings: { budgetTokens: 100_000, skipRedaction: true },
          };

          const result = build(input);

          // Check labels
          for (const s of result.knowledge) {
            expect(s.label).toBe('[KNOWLEDGE]');
          }
          for (const s of result.memory) {
            expect(s.label).toBe('[MEMORY]');
          }
          expect(result.transcript.label).toBe('[AUDIO]');
          if (result.screen) {
            expect(result.screen.label).toBe('[SCREEN]');
          }

          // fullPrompt should contain modality headers
          if (result.knowledge.length > 0) {
            expect(result.fullPrompt).toContain('[KNOWLEDGE]');
          }
          if (result.memory.length > 0) {
            expect(result.fullPrompt).toContain('[MEMORY]');
          }
          if (result.transcript.text.length > 0) {
            expect(result.fullPrompt).toContain('[AUDIO]');
          }
          if (result.screen) {
            expect(result.fullPrompt).toContain('[SCREEN]');
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------
// Property 16: Implicit retrieval query falls back deterministically
// **Validates: Requirements 5.4**
// ---------------------------------------------------------------------

import { deriveRetrievalQuery, appendLanguageDirective } from './contextBuilder';

describe('Context_Builder — Property 16: Implicit retrieval query falls back deterministically', () => {
  const arbOtherQuestion: fc.Arbitrary<TranscriptionLine> = fc.record({
    id: fc.uuid(),
    text: fc.string({ minLength: 1, maxLength: 80 }).map((s) => s.replace(/\?/g, '') + '?'),
    timestamp: fc.nat(),
    isInterim: fc.constant(false),
    speakerId: fc.constant('speaker-2'),
    speakerRole: fc.constant('other' as const),
    detection: fc.constantFrom('manual' as const, 'gap-heuristic' as const, 'voiceprint' as const),
    detectionConfidence: fc.double({ min: 0, max: 1, noNaN: true }),
    asrConfidence: fc.double({ min: 0, max: 1, noNaN: true }),
    language: fc.constant('en-US'),
    provider: fc.constant('web-speech' as const),
  });

  const arbUserLine: fc.Arbitrary<TranscriptionLine> = fc.record({
    id: fc.uuid(),
    text: fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0 && !s.trim().endsWith('?')),
    timestamp: fc.nat(),
    isInterim: fc.constant(false),
    speakerId: fc.constant('speaker-1'),
    speakerRole: fc.constant('user' as const),
    detection: fc.constant('manual' as const),
    detectionConfidence: fc.constant(1),
    asrConfidence: fc.constant(1),
    language: fc.constant('en-US'),
    provider: fc.constant('web-speech' as const),
  });

  const arbNonQuestionOtherLine: fc.Arbitrary<TranscriptionLine> = fc.record({
    id: fc.uuid(),
    text: fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0 && !s.trim().endsWith('?')),
    timestamp: fc.nat(),
    isInterim: fc.constant(false),
    speakerId: fc.constant('speaker-2'),
    speakerRole: fc.constant('other' as const),
    detection: fc.constant('manual' as const),
    detectionConfidence: fc.constant(1),
    asrConfidence: fc.constant(1),
    language: fc.constant('en-US'),
    provider: fc.constant('web-speech' as const),
  });

  it('returns userQuery as-is when userQuery is non-empty', () => {
    fc.assert(
      fc.property(
        fc.array(arbTranscriptLine, { minLength: 0, maxLength: 10 }),
        fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length > 0),
        (transcript, userQuery) => {
          const result = deriveRetrievalQuery(transcript, userQuery);
          expect(result).toBe(userQuery);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('returns most-recent question from other when userQuery is empty and question exists', () => {
    fc.assert(
      fc.property(
        fc.array(arbUserLine, { minLength: 0, maxLength: 5 }),
        arbOtherQuestion,
        fc.array(arbUserLine, { minLength: 0, maxLength: 3 }),
        (prefixLines, questionLine, suffixLines) => {
          // All suffix lines are user lines (not questions from 'other')
          const transcript = [...prefixLines, questionLine, ...suffixLines];
          const result = deriveRetrievalQuery(transcript, '');
          expect(result).toBe(questionLine.text);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('returns last 200 chars when no question-shaped other utterance exists', () => {
    fc.assert(
      fc.property(
        fc.array(arbNonQuestionOtherLine, { minLength: 1, maxLength: 10 }),
        (transcript) => {
          const result = deriveRetrievalQuery(transcript, '');
          const fullText = transcript.filter((l) => !l.isInterim).map((l) => l.text).join(' ');
          expect(result).toBe(fullText.slice(-200));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('returns empty string when transcript is empty and userQuery is empty', () => {
    const result = deriveRetrievalQuery([], '');
    expect(result).toBe('');
  });

  it('is deterministic: same inputs produce same output', () => {
    fc.assert(
      fc.property(
        fc.array(arbTranscriptLine, { minLength: 0, maxLength: 20 }),
        (transcript) => {
          const result1 = deriveRetrievalQuery(transcript, '');
          const result2 = deriveRetrievalQuery(transcript, '');
          expect(result1).toBe(result2);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('selects most-recent (last) question from other when multiple exist', () => {
    fc.assert(
      fc.property(
        arbOtherQuestion,
        arbOtherQuestion,
        (q1, q2) => {
          // Ensure distinct texts to verify we get the LAST one
          const transcript = [q1, q2];
          const result = deriveRetrievalQuery(transcript, '');
          expect(result).toBe(q2.text);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('ignores interim lines when determining fallback', () => {
    fc.assert(
      fc.property(
        arbOtherQuestion,
        (questionLine) => {
          // Mark the question as interim — should not be selected
          const interimQuestion: TranscriptionLine = { ...questionLine, isInterim: true };
          const transcript = [interimQuestion];
          const result = deriveRetrievalQuery(transcript, '');
          // Since only interim lines exist, no final lines → empty string
          expect(result).toBe('');
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------
// Property 50: Language directive is appended to system prompts
// **Validates: Requirements 17.4**
// ---------------------------------------------------------------------

describe('Context_Builder — Property 50: Language directive is appended to system prompts', () => {
  const arbBcp47: fc.Arbitrary<string> = fc.constantFrom(
    'en-US', 'es-ES', 'fr-FR', 'de-DE', 'ja-JP', 'zh-Hans', 'pt-BR', 'ko-KR',
  );

  const arbSystemPrompt: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 200 })
    .filter((s) => s.trim().length > 0);

  it('appended result contains the original system prompt', () => {
    fc.assert(
      fc.property(
        arbSystemPrompt,
        arbBcp47,
        (systemPrompt, language) => {
          const result = appendLanguageDirective(systemPrompt, language);
          expect(result).toContain(systemPrompt);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('appended result contains the language tag', () => {
    fc.assert(
      fc.property(
        arbSystemPrompt,
        arbBcp47,
        (systemPrompt, language) => {
          const result = appendLanguageDirective(systemPrompt, language);
          expect(result).toContain(language);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('appended result ends with "Respond in <lang>."', () => {
    fc.assert(
      fc.property(
        arbSystemPrompt,
        arbBcp47,
        (systemPrompt, language) => {
          const result = appendLanguageDirective(systemPrompt, language);
          expect(result).toMatch(new RegExp(`Respond in ${language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\s*$`));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('returns system prompt unchanged when language is empty or undefined', () => {
    fc.assert(
      fc.property(
        arbSystemPrompt,
        fc.constantFrom('', '  ', undefined),
        (systemPrompt, language) => {
          const result = appendLanguageDirective(systemPrompt, language as string | undefined);
          expect(result).toBe(systemPrompt);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('language directive is present in fullPrompt from build() when language is set', () => {
    fc.assert(
      fc.property(
        arbBcp47,
        (language) => {
          const input = {
            mode: 'assist',
            transcript: [] as TranscriptionLine[],
            screenText: '',
            knowledgeChunks: [] as any[],
            memoryChunks: [] as any[],
            userQuery: 'hello',
            countTokens,
            settings: { budgetTokens: 100_000, skipRedaction: true, language },
          };

          const result = build(input);
          expect(result.systemPrompt).toContain(`Respond in ${language}.`);
          expect(result.fullPrompt).toContain(`Respond in ${language}.`);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('no language directive in system prompt when language is not set', () => {
    const input = {
      mode: 'assist',
      transcript: [] as TranscriptionLine[],
      screenText: '',
      knowledgeChunks: [] as any[],
      memoryChunks: [] as any[],
      userQuery: 'hello',
      countTokens,
      settings: { budgetTokens: 100_000, skipRedaction: true },
    };

    const result = build(input);
    expect(result.systemPrompt).not.toContain('Respond in');
  });
});
