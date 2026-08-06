// ============================================
// Zule AI — Context_Builder redaction attestation
// ============================================
//
// Feature: custom-openai-compatible-provider, task 6.1.
// Unit coverage for the attestation `build()` stamps on its output so the
// custom OpenAI-compatible adapter can refuse unattested prompts.
//
// **Validates: Requirements 2.9, 2.10**

import { describe, it, expect } from 'vitest';
import { build } from './contextBuilder';
import type { BuildInput, ContextBuilderSettings } from './contextBuilder';
import type { TranscriptionLine } from '../types/transcription';
import type { RedactionRule } from '../types/redaction';

function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function line(text: string): TranscriptionLine {
  return {
    id: `l-${text.length}-${text.slice(0, 4)}`,
    text,
    timestamp: 0,
    isInterim: false,
    speakerId: 'speaker-1',
    speakerRole: 'other',
    detection: 'manual',
    detectionConfidence: 1,
    asrConfidence: 1,
    language: 'en-US',
    provider: 'web-speech',
  };
}

function makeInput(settings: ContextBuilderSettings): BuildInput {
  return {
    mode: 'sales',
    transcript: [line('call me at ada@example.com'), line('second line')],
    screenText: 'invoice for 4111 1111 1111 1111',
    knowledgeChunks: [{ text: 'kb chunk one' }, { text: 'kb chunk two' }],
    memoryChunks: [{ text: 'memory chunk' }],
    userQuery: 'what next?',
    countTokens,
    settings: { budgetTokens: 100_000, ...settings },
  };
}

const EMAIL_RULE: RedactionRule[] = [{ kind: 'entity', entity: 'email' }];

describe('Context_Builder redaction attestation', () => {
  it('attests successfully with a non-empty rule set', () => {
    const result = build(makeInput({ redactionRules: EMAIL_RULE }));

    // 2 knowledge + 1 memory + 1 transcript + 1 screen
    expect(result.redaction.segmentsTotal).toBe(5);
    expect(result.redaction.segmentsRedacted).toBe(5);
    expect(result.redaction.ruleCount).toBe(1);
    expect(result.redaction.applied).toBe(true);
    expect(result.fullPrompt).not.toContain('ada@example.com');
  });

  it('attests successfully with an empty rule set (ruleCount 0 is not a failure)', () => {
    const result = build(makeInput({ redactionRules: [] }));

    expect(result.redaction.ruleCount).toBe(0);
    expect(result.redaction.segmentsRedacted).toBe(result.redaction.segmentsTotal);
    expect(result.redaction.applied).toBe(true);
  });

  it('fails the attestation when skipRedaction is true', () => {
    const result = build(makeInput({ redactionRules: EMAIL_RULE, skipRedaction: true }));

    expect(result.redaction.applied).toBe(false);
    expect(result.redaction.segmentsRedacted).toBe(0);
    expect(result.redaction.segmentsTotal).toBe(5);
    expect(result.fullPrompt).toContain('ada@example.com');
  });

  it('still attests when sections are dropped to fit the budget', () => {
    const result = build({
      ...makeInput({ redactionRules: EMAIL_RULE }),
      settings: { budgetTokens: 30, redactionRules: EMAIL_RULE },
    });

    expect(result.trace.droppedSections.length).toBeGreaterThan(0);
    expect(result.redaction.segmentsRedacted).toBe(result.redaction.segmentsTotal);
    expect(result.redaction.applied).toBe(true);
  });

  it('counts no screen segment when there is no screen text', () => {
    const result = build({
      ...makeInput({ redactionRules: [] }),
      screenText: '   ',
    });

    // 2 knowledge + 1 memory + 1 transcript, no screen
    expect(result.redaction.segmentsTotal).toBe(4);
    expect(result.redaction.applied).toBe(true);
  });
});
