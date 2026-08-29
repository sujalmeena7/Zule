// ============================================================================
// Realtime Meeting Audio Pipeline Unit & Property Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  buildUtteranceWindow,
  suppressEchoDuplicates,
  QuestionDetectorStream,
  isNearSuperset,
  countWordDifferences,
} from '../questionDetector';
import {
  conversationCacheKey,
  getScreenCached,
  setScreenCached,
  clearScreenCache,
} from '../screenFastCache';
import {
  buildRealtimeConversationContext,
  ANSWER_FIRST_DIRECTIVE,
  SPOKEN_VOICE_DIRECTIVE,
} from '../contextManager';
import type { TranscriptionLine } from '../../types/transcription';
import type { DetectionResult } from '../questionDetector';

describe('Realtime Audio Pipeline: Utterance Windowing & Question Detection', () => {
  it('buildUtteranceWindow joins consecutive same-speaker lines within maxGapMs', () => {
    const lines = [
      { text: 'so what would you say', speakerRole: 'other' as const, timestamp: 1000 },
      { text: 'is the biggest tradeoff here?', speakerRole: 'other' as const, timestamp: 2200 },
    ];
    const joined = buildUtteranceWindow(lines, { maxGapMs: 1500, maxLines: 4 });
    expect(joined).toBe('so what would you say is the biggest tradeoff here?');
  });

  it('buildUtteranceWindow breaks on speaker role transition', () => {
    const lines = [
      { text: 'I agree with that approach', speakerRole: 'user' as const, timestamp: 1000 },
      { text: 'can you explain why?', speakerRole: 'other' as const, timestamp: 1800 },
    ];
    const joined = buildUtteranceWindow(lines, { maxGapMs: 1500, maxLines: 4 });
    expect(joined).toBe('can you explain why?');
  });

  it('buildUtteranceWindow breaks when timestamp gap exceeds maxGapMs', () => {
    const lines = [
      { text: 'first question from earlier', speakerRole: 'other' as const, timestamp: 1000 },
      { text: 'how does this scale?', speakerRole: 'other' as const, timestamp: 5000 },
    ];
    const joined = buildUtteranceWindow(lines, { maxGapMs: 1500, maxLines: 4 });
    expect(joined).toBe('how does this scale?');
  });

  it('buildUtteranceWindow respects maxLines bound', () => {
    const lines = [
      { text: 'line 1', speakerRole: 'other' as const, timestamp: 1000 },
      { text: 'line 2', speakerRole: 'other' as const, timestamp: 1500 },
      { text: 'line 3', speakerRole: 'other' as const, timestamp: 2000 },
      { text: 'line 4', speakerRole: 'other' as const, timestamp: 2500 },
      { text: 'line 5', speakerRole: 'other' as const, timestamp: 3000 },
    ];
    const joined = buildUtteranceWindow(lines, { maxGapMs: 1500, maxLines: 3 });
    expect(joined).toBe('line 3 line 4 line 5');
  });

  it('QuestionDetector detects split questions across 2s chunk boundaries', () => {
    let triggeredResult: DetectionResult | null = null;
    const detector = new QuestionDetectorStream({
      debounceMs: 500,
      interimThrottleMs: 2000,
      now: () => 10000,
    });

    const lines = [
      { text: 'so what would you say', speakerRole: 'other' as const, timestamp: 8500 },
      { text: 'is the biggest tradeoff here?', speakerRole: 'other' as const, timestamp: 9800 },
    ];

    detector.onNewContext(lines, (res) => {
      triggeredResult = res;
    });

    expect(triggeredResult).not.toBeNull();
    expect(triggeredResult!.question).toBe('so what would you say is the biggest tradeoff here?');
    expect(['direct', 'technical']).toContain(triggeredResult!.type);
  });
});

describe('Realtime Audio Pipeline: Barge-In Threshold (countWordDifferences)', () => {
  it('treats the same question re-transcribed with punctuation/case jitter as unchanged', () => {
    // The dominant real-world case: ASR re-emits the same utterance with
    // different casing and punctuation. Aborting here would cancel a correct
    // in-flight answer for nothing.
    const a = 'What is the time complexity of binary search?';
    const b = 'what is the time complexity of binary search';
    expect(countWordDifferences(a, b)).toBe(0);
  });

  it('ignores short function words so filler jitter cannot reach the threshold', () => {
    // Only tokens longer than two characters count, so "is"/"a"/"of" churn is invisible.
    expect(countWordDifferences('what is a cache', 'what a cache is')).toBe(0);
  });

  it('stays below the >= 3 barge-in threshold for a one-word correction', () => {
    const diff = countWordDifferences(
      'how would you scale the database',
      'how would you scale the cache',
    );
    expect(diff).toBe(2); // 'database' removed, 'cache' added
    expect(diff).toBeLessThan(3);
  });

  it('reaches the >= 3 barge-in threshold for a genuinely different question', () => {
    const diff = countWordDifferences(
      'what is the time complexity of binary search',
      'tell me about a time you handled production incident',
    );
    expect(diff).toBeGreaterThanOrEqual(3);
  });

  it('is symmetric and zero on identical input (property)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(countWordDifferences(a, b)).toBe(countWordDifferences(b, a));
        expect(countWordDifferences(a, a)).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  it('never reports a difference for a question compared against itself, however punctuated (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z]{3,10}$/), { minLength: 1, maxLength: 8 }),
        (words) => {
          const plain = words.join(' ');
          const punctuated = `${words.join(', ')}?`;
          expect(countWordDifferences(plain, punctuated)).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('Realtime Audio Pipeline: Cross-Source Suppression (isNearSuperset)', () => {
  it('recognises the completed final as a superset of the partial that already fired', () => {
    // The hybrid path fires prefetch on the partial; the final must not re-trigger.
    expect(
      isNearSuperset(
        'so what would you say is the biggest tradeoff here?',
        'so what would you say is the biggest',
      ),
    ).toBe(true);
  });

  it('tolerates reordering because comparison falls back to word membership', () => {
    expect(isNearSuperset('the biggest tradeoff here is latency', 'tradeoff biggest')).toBe(true);
  });

  it('rejects a genuinely new question so a follow-up is not suppressed', () => {
    expect(
      isNearSuperset(
        'tell me about a time you handled an outage',
        'what is the time complexity of quicksort',
      ),
    ).toBe(false);
  });

  it('a string is always a near-superset of itself and of its own prefixes (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z]{2,10}$/), { minLength: 1, maxLength: 10 }),
        (words) => {
          const full = words.join(' ');
          expect(isNearSuperset(full, full)).toBe(true);
          // Every prefix of the utterance is a partial that preceded it.
          for (let n = 1; n <= words.length; n++) {
            expect(isNearSuperset(full, words.slice(0, n).join(' '))).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('Realtime Audio Pipeline: Echo Suppression', () => {
  it('suppressEchoDuplicates drops user mic line when loopback has matching tokens within 1.2s', () => {
    const lines: TranscriptionLine[] = [
      {
        id: '1',
        text: 'What is the time complexity of binary search?',
        timestamp: 2000,
        isInterim: false,
        speakerId: 'speaker-2',
        speakerRole: 'other',
        detection: 'manual',
        detectionConfidence: 1,
        asrConfidence: 0.9,
        language: 'en',
        provider: 'local-whisper',
      },
      {
        id: '2',
        text: 'What is the time complexity of binary search?',
        timestamp: 2300,
        isInterim: false,
        speakerId: 'speaker-1',
        speakerRole: 'user', // Echo leaked into mic
        detection: 'manual',
        detectionConfidence: 1,
        asrConfidence: 0.85,
        language: 'en',
        provider: 'web-speech',
      },
    ];

    const deduplicated = suppressEchoDuplicates(lines);
    expect(deduplicated).toHaveLength(1);
    expect(deduplicated[0].speakerRole).toBe('other');
  });

  it('suppressEchoDuplicates preserves distinct user speech', () => {
    const lines: TranscriptionLine[] = [
      {
        id: '1',
        text: 'Can you tell us about your background?',
        timestamp: 2000,
        isInterim: false,
        speakerId: 'speaker-2',
        speakerRole: 'other',
        detection: 'manual',
        detectionConfidence: 1,
        asrConfidence: 0.9,
        language: 'en',
        provider: 'local-whisper',
      },
      {
        id: '2',
        text: 'Sure, I have five years of experience in distributed systems.',
        timestamp: 2800,
        isInterim: false,
        speakerId: 'speaker-1',
        speakerRole: 'user',
        detection: 'manual',
        detectionConfidence: 1,
        asrConfidence: 0.95,
        language: 'en',
        provider: 'web-speech',
      },
    ];

    const deduplicated = suppressEchoDuplicates(lines);
    expect(deduplicated).toHaveLength(2);
  });
});

describe('Realtime Audio Pipeline: Fast Exact-Match Cache', () => {
  it('conversationCacheKey produces deterministic exact-match key', () => {
    const key1 = conversationCacheKey({ mode: 'interview', query: 'What is quicksort?' });
    const key2 = conversationCacheKey({ mode: 'interview', query: 'What is quicksort?' });
    const key3 = conversationCacheKey({ mode: 'interview', query: 'What is mergesort?' });

    expect(key1).not.toBeNull();
    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
  });

  it('stores and retrieves cached conversation response synchronously', () => {
    clearScreenCache();
    const key = conversationCacheKey({ mode: 'interview', query: 'Explain Raft consensus.' });

    expect(getScreenCached(key)).toBeNull();

    setScreenCached(key, {
      text: 'Raft is a consensus algorithm designed for understandability.',
      isSimulated: false,
    });

    const hit = getScreenCached(key);
    expect(hit).not.toBeNull();
    expect(hit?.text).toBe('Raft is a consensus algorithm designed for understandability.');
  });
});

describe('Realtime Audio Pipeline: Fast Context Builder', () => {
  it('buildRealtimeConversationContext injects ANSWER_FIRST and SPOKEN_VOICE directives with zero KB/Memory', async () => {
    const transcript = [
      { id: '1', timestamp: 1000, text: 'Hello', isInterim: false, speaker: 'user' as const },
      { id: '2', timestamp: 2000, text: 'What is CAP theorem?', isInterim: false, speaker: 'other' as const },
    ];

    const ctx = await buildRealtimeConversationContext(
      'interview',
      transcript,
      'What is CAP theorem?',
    );

    expect(ctx.systemPrompt).toContain(ANSWER_FIRST_DIRECTIVE);
    expect(ctx.systemPrompt).toContain(SPOKEN_VOICE_DIRECTIVE);
    expect(ctx.knowledgeContext).toBe('');
    expect(ctx.transcriptContext).toContain('[Other]: What is CAP theorem?');
    expect(ctx.screenContext).toBe('');
  });
});
