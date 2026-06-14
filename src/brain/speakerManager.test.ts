// ============================================
// Zule AI — Speaker_Module tests
// ============================================
//
// These tests pin the contract of the per-session `SpeakerManager` class
// introduced in task 13.1 and assert the three properties scoped to the
// speaker module (Properties 5, 7, 8 from design.md). All tests target
// the public surface of `speakerManager.ts` only — no module-level
// singleton state is exercised, in line with Requirement 3.1.

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import {
  SpeakerManager,
  VOICEPRINT_CONFIDENCE_THRESHOLD,
  type SpeakerProfile,
  type VoiceprintClassifier,
} from './speakerManager';
import type {
  DetectionMethod,
  SpeakerRole,
} from '../types/transcription';

// ---------------------------------------------------------------------
// Shared generators
// ---------------------------------------------------------------------

const SPEAKER_IDS = ['speaker-1', 'speaker-2', 'speaker-3', 'speaker-4'] as const;

/** Two-speaker default-shape profile pool used by most properties. */
function makeProfiles(): SpeakerProfile[] {
  return [
    {
      id: 'speaker-1',
      name: 'You',
      color: '#000',
      avatarInitial: 'Y',
      role: 'user',
    },
    {
      id: 'speaker-2',
      name: 'Other',
      color: '#111',
      avatarInitial: 'O',
      role: 'other',
    },
    {
      id: 'speaker-3',
      name: 'Speaker 3',
      color: '#222',
      avatarInitial: 'S',
      role: 'other',
    },
    {
      id: 'speaker-4',
      name: 'Speaker 4',
      color: '#333',
      avatarInitial: 'S',
      role: 'other',
    },
  ];
}

const validIdArb = fc.constantFrom(...SPEAKER_IDS);

/** Generator that mixes valid registered ids with junk ids the manager
 * must ignore (so we exercise the "unknown ids do not toggle" path). */
const maybeValidIdArb = fc.oneof(
  { weight: 4, arbitrary: validIdArb },
  {
    weight: 1,
    arbitrary: fc.string({ minLength: 1, maxLength: 12 }).filter(
      (s) => !(SPEAKER_IDS as readonly string[]).includes(s),
    ),
  },
);

// ---------------------------------------------------------------------
// Unit tests — construction, getActive, setActive, profiles
// ---------------------------------------------------------------------

describe('SpeakerManager — construction', () => {
  it('throws when constructed with an empty profile list', () => {
    expect(() => new SpeakerManager({ profiles: [] })).toThrow();
  });

  it('defaults the active speaker to the first "other"-role profile', () => {
    const mgr = new SpeakerManager({ profiles: makeProfiles() });
    expect(mgr.getActive().id).toBe('speaker-2');
    expect(mgr.getActive().role).toBe('other');
  });

  it('honours `initialActiveId` when it points to a registered profile', () => {
    const mgr = new SpeakerManager({
      profiles: makeProfiles(),
      initialActiveId: 'speaker-3',
    });
    expect(mgr.getActive().id).toBe('speaker-3');
  });

  it('falls back to the default when `initialActiveId` is unknown', () => {
    const mgr = new SpeakerManager({
      profiles: makeProfiles(),
      initialActiveId: 'nope',
    });
    expect(mgr.getActive().id).toBe('speaker-2');
  });

  it('seeds toggle history with the constructor-time active speaker', () => {
    const mgr = new SpeakerManager({
      profiles: makeProfiles(),
      now: () => 1000,
    });
    const history = mgr.getToggleHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({ speakerId: 'speaker-2', at: 1000 });
  });
});

describe('SpeakerManager — setActive and getActive', () => {
  it('updates the active speaker for a known id', () => {
    const mgr = new SpeakerManager({ profiles: makeProfiles() });
    mgr.setActive('speaker-1');
    expect(mgr.getActive().id).toBe('speaker-1');
  });

  it('ignores unknown ids without throwing', () => {
    const mgr = new SpeakerManager({ profiles: makeProfiles() });
    const before = mgr.getActive().id;
    mgr.setActive('not-a-speaker');
    expect(mgr.getActive().id).toBe(before);
  });

  it('returns immutable copies of profiles', () => {
    const mgr = new SpeakerManager({ profiles: makeProfiles() });
    const a = mgr.getActive();
    a.name = 'mutated';
    expect(mgr.getActive().name).not.toBe('mutated');
  });
});

// ---------------------------------------------------------------------
// Unit tests — classifyByGap
// ---------------------------------------------------------------------

describe('SpeakerManager — classifyByGap', () => {
  it('reports `possibleSpeakerChange = false` on the first call (no prior timestamp)', () => {
    const mgr = new SpeakerManager({ profiles: makeProfiles() });
    const result = mgr.classifyByGap(0);
    expect(result.possibleSpeakerChange).toBe(false);
    expect(result.method).toBe('manual');
    expect(result.confidence).toBe(1.0);
  });

  it('flags a gap longer than 2000 ms as a possible speaker change', () => {
    const mgr = new SpeakerManager({ profiles: makeProfiles() });
    mgr.classifyByGap(0);
    const result = mgr.classifyByGap(2500);
    expect(result.possibleSpeakerChange).toBe(true);
    expect(result.method).toBe('gap-heuristic');
  });

  it('does not flag a gap of exactly 2000 ms as a change', () => {
    const mgr = new SpeakerManager({ profiles: makeProfiles() });
    mgr.classifyByGap(0);
    const result = mgr.classifyByGap(2000);
    expect(result.possibleSpeakerChange).toBe(false);
  });

  it('returns the active speaker id and role unchanged', () => {
    const mgr = new SpeakerManager({ profiles: makeProfiles() });
    mgr.setActive('speaker-3');
    const result = mgr.classifyByGap(5000);
    expect(result.id).toBe('speaker-3');
    expect(result.role).toBe('other');
  });
});

// ---------------------------------------------------------------------
// Unit tests — classifyByVoiceprint
// ---------------------------------------------------------------------

describe('SpeakerManager — classifyByVoiceprint', () => {
  it('falls back to manual when confidence is below the threshold', async () => {
    const classifier: VoiceprintClassifier = () => ({
      id: 'speaker-3',
      confidence: 0.4,
    });
    const mgr = new SpeakerManager({
      profiles: makeProfiles(),
      voiceprintClassifier: classifier,
    });
    const result = await mgr.classifyByVoiceprint(new Float32Array(0));
    expect(result.method).toBe('manual');
    // Active speaker id is preserved (default 'speaker-2'), not the
    // low-confidence guess.
    expect(result.id).toBe('speaker-2');
  });

  it('accepts the guess when confidence meets the threshold exactly', async () => {
    const classifier: VoiceprintClassifier = () => ({
      id: 'speaker-3',
      confidence: VOICEPRINT_CONFIDENCE_THRESHOLD,
    });
    const mgr = new SpeakerManager({
      profiles: makeProfiles(),
      voiceprintClassifier: classifier,
    });
    const result = await mgr.classifyByVoiceprint(new Float32Array(0));
    expect(result.method).toBe('voiceprint');
    expect(result.id).toBe('speaker-3');
  });

  it('falls back to manual when the guessed id is unknown', async () => {
    const classifier: VoiceprintClassifier = () => ({
      id: 'ghost',
      confidence: 0.99,
    });
    const mgr = new SpeakerManager({ profiles: makeProfiles(), voiceprintClassifier: classifier });
    const result = await mgr.classifyByVoiceprint(new Float32Array(0));
    expect(result.method).toBe('manual');
    expect(result.id).toBe('speaker-2');
  });

  it('clamps reported confidence into [0, 1]', async () => {
    const classifier: VoiceprintClassifier = () => ({
      id: 'speaker-3',
      // Above 1: clamped down. The classifier reports a non-finite or
      // out-of-range value so we exercise the clamp path.
      confidence: 1.5,
    });
    const mgr = new SpeakerManager({ profiles: makeProfiles(), voiceprintClassifier: classifier });
    const result = await mgr.classifyByVoiceprint(new Float32Array(0));
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------
// Property 5: Every transcript line satisfies the schema invariant
// ---------------------------------------------------------------------
//
// **Property 5: Every transcript line satisfies the schema invariant**
//
// For any sequence of `setActive`, `classifyByGap`, and
// `classifyByVoiceprint` operations on a `SpeakerManager`, the
// `(speakerId, speakerRole, detection, detectionConfidence)` tuple
// produced for a transcript line satisfies the closed-set / closed-range
// constraints defined by `TranscriptionLine`:
//
//   * `speakerId` is a non-empty registered id (e.g. `'speaker-1'`).
//   * `speakerRole` is strictly `'user' | 'other'`.
//   * `detection` is one of `'manual' | 'gap-heuristic' | 'voiceprint'`.
//   * `detectionConfidence` is a finite number in `[0, 1]`.
//
// **Validates: Requirements 2.4, 3.2, 3.7**

const VALID_ROLES: readonly SpeakerRole[] = ['user', 'other'];
const VALID_METHODS: readonly DetectionMethod[] = [
  'manual',
  'gap-heuristic',
  'voiceprint',
];

/** A single op that may be applied to the manager during the property. */
type Op =
  | { kind: 'setActive'; id: string }
  | { kind: 'gap'; now: number }
  | { kind: 'voiceprint'; guessId: string; confidence: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  maybeValidIdArb.map<Op>((id) => ({ kind: 'setActive', id })),
  fc
    .integer({ min: 0, max: 1_000_000 })
    .map<Op>((now) => ({ kind: 'gap', now })),
  fc
    .tuple(
      // Voiceprint guesses occasionally point at an unknown id so we
      // exercise the manual-fallback branch.
      maybeValidIdArb,
      fc.double({
        min: -0.5,
        max: 1.5,
        noNaN: true,
      }),
    )
    .map<Op>(([guessId, confidence]) => ({
      kind: 'voiceprint',
      guessId,
      confidence,
    })),
);

describe('SpeakerManager — Property 5: schema invariant', () => {
  it('every classification result satisfies the TranscriptionLine schema invariant', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 0, maxLength: 30 }), async (ops) => {
        // We construct a fresh manager per run so no state leaks across
        // shrunken examples (Requirement 3.1).
        const mgr = new SpeakerManager({ profiles: makeProfiles() });
        for (const op of ops) {
          let result: {
            id: string;
            role: SpeakerRole;
            method: DetectionMethod;
            confidence: number;
          };
          if (op.kind === 'setActive') {
            mgr.setActive(op.id);
            // setActive does not produce a line, but the line emitted
            // immediately afterwards (via gap classification) must
            // satisfy the schema, which is what Property 5 asserts.
            continue;
          } else if (op.kind === 'gap') {
            result = mgr.classifyByGap(op.now);
          } else {
            // Build a one-shot voiceprint classifier for this op.
            const oneShot: VoiceprintClassifier = () => ({
              id: op.guessId,
              confidence: op.confidence,
            });
            const local = new SpeakerManager({
              profiles: makeProfiles(),
              voiceprintClassifier: oneShot,
              initialActiveId: mgr.getActive().id,
            });
            result = await local.classifyByVoiceprint(new Float32Array(0));
          }
          // (a) speakerId is non-empty and registered.
          if (typeof result.id !== 'string' || result.id.length === 0) return false;
          if (!(SPEAKER_IDS as readonly string[]).includes(result.id)) return false;
          // (b) speakerRole is strictly 'user' | 'other'.
          if (!VALID_ROLES.includes(result.role)) return false;
          // (c) detection is one of the closed set.
          if (!VALID_METHODS.includes(result.method)) return false;
          // (d) detectionConfidence is a finite number in [0, 1].
          if (!Number.isFinite(result.confidence)) return false;
          if (result.confidence < 0 || result.confidence > 1) return false;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------
// Property 7: Active speaker assignment respects toggle history
// ---------------------------------------------------------------------
//
// **Property 7: Active speaker assignment respects toggle history**
//
// For any sequence of `setActive(id)` calls where each `id` is a
// registered speaker, `getActive().id` is equal to the most-recently
// set `id`. Unknown ids are filtered out before applying the property
// (the manager ignores them by design).
//
// **Validates: Requirements 3.4**

describe('SpeakerManager — Property 7: toggle history', () => {
  it('getActive().id equals the most-recent valid setActive id', () => {
    fc.assert(
      fc.property(
        fc.array(maybeValidIdArb, { minLength: 1, maxLength: 30 }),
        (ids) => {
          const mgr = new SpeakerManager({ profiles: makeProfiles() });
          const initial = mgr.getActive().id;
          for (const id of ids) {
            mgr.setActive(id);
          }
          // Walk the input from the end to find the most recent valid id.
          let expected = initial;
          for (let i = ids.length - 1; i >= 0; i--) {
            if ((SPEAKER_IDS as readonly string[]).includes(ids[i])) {
              expected = ids[i];
              break;
            }
          }
          return mgr.getActive().id === expected;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('toggle history records every accepted setActive call in order', () => {
    fc.assert(
      fc.property(
        fc.array(validIdArb, { minLength: 0, maxLength: 20 }),
        (ids) => {
          const mgr = new SpeakerManager({
            profiles: makeProfiles(),
            now: () => 0,
          });
          for (const id of ids) {
            mgr.setActive(id);
          }
          const history = mgr.getToggleHistory();
          // First entry is the constructor-time active speaker.
          if (history.length !== ids.length + 1) return false;
          for (let i = 0; i < ids.length; i++) {
            if (history[i + 1].speakerId !== ids[i]) return false;
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------
// Property 8: Voiceprint diarization falls back below 0.55 confidence
// ---------------------------------------------------------------------
//
// **Property 8: Voiceprint diarization falls back below 0.55
// confidence**
//
// For any voiceprint guess `(id, confidence)`, if `confidence < 0.55`
// then `classifyByVoiceprint` does not switch the speaker assignment:
// the returned `id` is the most-recent manual-assigned active speaker
// and the `method` is `'manual'`. Conversely, when `confidence >= 0.55`
// and `id` is registered, the result reports `method: 'voiceprint'`
// and the guessed `id`.
//
// **Validates: Requirements 3.5**

describe('SpeakerManager — Property 8: voiceprint fallback', () => {
  it('low-confidence guesses do not switch the active speaker', async () => {
    await fc.assert(
      fc.asyncProperty(
        validIdArb, // initial active speaker
        validIdArb, // guessed id
        // Confidence strictly below the threshold. We use the
        // half-open generator and clamp explicitly.
        fc.double({
          min: 0,
          max: VOICEPRINT_CONFIDENCE_THRESHOLD - 1e-6,
          noNaN: true,
        }),
        async (initialId, guessId, confidence) => {
          const classifier: VoiceprintClassifier = () => ({
            id: guessId,
            confidence,
          });
          const mgr = new SpeakerManager({
            profiles: makeProfiles(),
            voiceprintClassifier: classifier,
            initialActiveId: initialId,
          });
          const result = await mgr.classifyByVoiceprint(new Float32Array(0));
          // Manual fallback: id is the active speaker, not the guess.
          if (result.method !== 'manual') return false;
          if (result.id !== initialId) return false;
          // The active speaker is unchanged after the call.
          if (mgr.getActive().id !== initialId) return false;
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('high-confidence guesses for registered ids switch attribution to the guess', async () => {
    await fc.assert(
      fc.asyncProperty(
        validIdArb, // initial active speaker
        validIdArb, // guessed id (always registered here)
        fc.double({
          min: VOICEPRINT_CONFIDENCE_THRESHOLD,
          max: 1,
          noNaN: true,
        }),
        async (initialId, guessId, confidence) => {
          const classifier: VoiceprintClassifier = () => ({
            id: guessId,
            confidence,
          });
          const mgr = new SpeakerManager({
            profiles: makeProfiles(),
            voiceprintClassifier: classifier,
            initialActiveId: initialId,
          });
          const result = await mgr.classifyByVoiceprint(new Float32Array(0));
          if (result.method !== 'voiceprint') return false;
          if (result.id !== guessId) return false;
          // Important: the returned attribution is the guess, but the
          // manual `activeSpeakerId` is *not* mutated by voiceprint. The
          // orchestrator decides whether to call `setActive` based on
          // this result.
          if (mgr.getActive().id !== initialId) return false;
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
