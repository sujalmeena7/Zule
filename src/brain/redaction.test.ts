// ============================================
// Zule AI — Redaction_Engine tests
// ============================================
//
// Unit tests pin the contract for each built-in entity class and for the
// behaviour of `applyToSections`. The property test asserts Property 44 from
// design.md: redaction is idempotent and (because the built-in replacements
// are designed not to re-match) applying the engine twice never changes the
// result. All tests target the public surface of `redaction.ts` only.

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import {
  apply,
  applyToSections,
  DEFAULT_ENTITY_REPLACEMENT,
  type ContextSection,
} from './redaction';
import type { RedactionRule, RedactionEntity } from '../types/redaction';

// ---------------------------------------------------------------------
// apply — unit tests for built-in entity classes
// ---------------------------------------------------------------------

const ALL_ENTITIES: RedactionRule[] = (
  ['email', 'phone', 'credit-card', 'iban', 'us-ssn'] as const
).map((entity) => ({ kind: 'entity', entity }));

describe('apply — built-in entity classes', () => {
  it('returns the input unchanged when there are no rules', () => {
    const text = 'Email me at alice@example.com or call 415-555-1212.';
    expect(apply(text, [])).toBe(text);
  });

  it('returns an empty string for empty input regardless of rules', () => {
    expect(apply('', ALL_ENTITIES)).toBe('');
  });

  it('redacts email addresses', () => {
    const text = 'Send to alice.smith+work@example.co.uk for details.';
    const result = apply(text, [{ kind: 'entity', entity: 'email' }]);
    expect(result).toBe('Send to [REDACTED:EMAIL] for details.');
  });

  it('redacts US-style phone numbers in several formats', () => {
    const text = 'Call (415) 555-1212, +1 415.555.1212, or 415-555-1212.';
    const result = apply(text, [{ kind: 'entity', entity: 'phone' }]);
    expect(result).toBe(
      'Call [REDACTED:PHONE], [REDACTED:PHONE], or [REDACTED:PHONE].',
    );
  });

  it('redacts credit-card numbers with and without separators', () => {
    const text = 'Cards: 4111-1111-1111-1111 and 4111111111111111.';
    const result = apply(text, [{ kind: 'entity', entity: 'credit-card' }]);
    expect(result).toBe('Cards: [REDACTED:CC] and [REDACTED:CC].');
  });

  it('redacts US SSN in XXX-XX-XXXX form', () => {
    const text = 'SSN: 123-45-6789 on file.';
    const result = apply(text, [{ kind: 'entity', entity: 'us-ssn' }]);
    expect(result).toBe('SSN: [REDACTED:SSN] on file.');
  });

  it('redacts IBANs across countries', () => {
    const text = 'Wire to GB82WEST12345698765432 or DE89370400440532013000.';
    const result = apply(text, [{ kind: 'entity', entity: 'iban' }]);
    expect(result).toBe('Wire to [REDACTED:IBAN] or [REDACTED:IBAN].');
  });

  it('redacts every entity class in a mixed message', () => {
    const text =
      'alice@example.com, 415-555-1212, 4111-1111-1111-1111, ' +
      'GB82WEST12345698765432, SSN 123-45-6789.';
    const result = apply(text, ALL_ENTITIES);
    expect(result).toBe(
      '[REDACTED:EMAIL], [REDACTED:PHONE], [REDACTED:CC], ' +
        '[REDACTED:IBAN], SSN [REDACTED:SSN].',
    );
  });

  it('honours an explicit `replacement` override on an entity rule', () => {
    const text = 'Reach me at alice@example.com.';
    const result = apply(text, [
      { kind: 'entity', entity: 'email', replacement: '<email>' },
    ]);
    expect(result).toBe('Reach me at <email>.');
  });

  it('uses the first listed replacement when an entity is requested twice', () => {
    const text = 'alice@example.com';
    const result = apply(text, [
      { kind: 'entity', entity: 'email', replacement: '<first>' },
      { kind: 'entity', entity: 'email', replacement: '<second>' },
    ]);
    expect(result).toBe('<first>');
  });

  it('does not redact strings that look similar but are not the entity', () => {
    // 12-digit run is short of the credit-card pattern's lower bound (13).
    const text = 'Order ref 123456789012 should pass through.';
    const result = apply(text, ALL_ENTITIES);
    expect(result).toBe(text);
  });
});

// ---------------------------------------------------------------------
// apply — user-defined regex rules
// ---------------------------------------------------------------------

describe('apply — user-defined regex rules', () => {
  it('applies a user regex rule before built-in entity rules', () => {
    // The user rule rewrites the email's local-part *before* the built-in
    // email rule fires; the post-regex string still matches the email
    // pattern, so the final output is the email replacement.
    const text = 'Contact alice@example.com today.';
    const result = apply(text, [
      { kind: 'regex', pattern: 'alice', flags: 'g', replacement: 'bob' },
      { kind: 'entity', entity: 'email' },
    ]);
    expect(result).toBe('Contact [REDACTED:EMAIL] today.');
  });

  it('lets a user regex override a built-in entity by running first', () => {
    // The user redacts emails to a custom token; the built-in email rule
    // then finds nothing left to redact, so the custom token survives.
    const text = 'alice@example.com';
    const result = apply(text, [
      {
        kind: 'regex',
        pattern: '[a-z]+@[a-z.]+',
        flags: 'gi',
        replacement: '<email-redacted>',
      },
      { kind: 'entity', entity: 'email' },
    ]);
    expect(result).toBe('<email-redacted>');
  });

  it('forces the global flag so every match is replaced', () => {
    const text = 'foo foo foo';
    const result = apply(text, [
      { kind: 'regex', pattern: 'foo', flags: '', replacement: 'bar' },
    ]);
    expect(result).toBe('bar bar bar');
  });

  it('skips malformed user regex without throwing', () => {
    const text = 'Email alice@example.com';
    const result = apply(text, [
      { kind: 'regex', pattern: '(', flags: 'g', replacement: 'X' },
      { kind: 'entity', entity: 'email' },
    ]);
    expect(result).toBe('Email [REDACTED:EMAIL]');
  });
});

// ---------------------------------------------------------------------
// applyToSections — unit tests
// ---------------------------------------------------------------------

describe('applyToSections', () => {
  const sections: ContextSection[] = [
    {
      label: '[KNOWLEDGE]',
      text: 'Contact alice@example.com',
      tokenCount: 4,
      citationId: 'K1',
      source: { docId: 'doc-1' },
    },
    {
      label: '[AUDIO]',
      text: 'No PII here',
      tokenCount: 3,
    },
  ];

  it('returns a new array with redacted text fields', () => {
    const result = applyToSections(sections, [
      { kind: 'entity', entity: 'email' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Contact [REDACTED:EMAIL]');
    expect(result[1].text).toBe('No PII here');
  });

  it('preserves all non-text fields verbatim', () => {
    const result = applyToSections(sections, [
      { kind: 'entity', entity: 'email' },
    ]);
    expect(result[0].label).toBe('[KNOWLEDGE]');
    expect(result[0].tokenCount).toBe(4);
    expect(result[0].citationId).toBe('K1');
    expect(result[0].source).toEqual({ docId: 'doc-1' });
  });

  it('does not mutate the input array or its sections', () => {
    const before = JSON.stringify(sections);
    applyToSections(sections, [{ kind: 'entity', entity: 'email' }]);
    expect(JSON.stringify(sections)).toBe(before);
  });
});

// ---------------------------------------------------------------------
// Property 44: Redaction is idempotent
// ---------------------------------------------------------------------
//
// **Property 44: Redaction is applied before any cloud egress and is
// idempotent**
//
// *For all* text `x` and rule sets `R`, `apply(apply(x, R), R) === apply(x,
// R)`. This file covers the idempotence half (Requirement 30.2). The
// "applied before cloud egress" half is asserted at the prompt-assembly
// layer in Task 10.5 once `Context_Builder` lands.
//
// The property holds for any rule set whose replacements are not themselves
// matched by any rule's pattern. Built-in entity rules are designed this way
// (see `redaction.ts` for the proof sketch); for user-defined regex rules the
// engine cannot guarantee the property in full generality (a rule like
// `{pattern: 'a', replacement: 'aa'}` is non-idempotent by construction). We
// therefore generate rule sets from the safe, well-formed pool in this test:
// arbitrary subsets of the five built-in entity rules with their default or
// safe overridden replacements.
//
// **Validates: Requirements 15.3, 30.2**

const ENTITY_NAMES: RedactionEntity[] = [
  'email',
  'phone',
  'credit-card',
  'iban',
  'us-ssn',
];

/** A safe replacement: an arbitrary token that contains no characters that
 * could match any of the five built-in entity patterns (no `@`, no digits, no
 * uppercase-letter runs followed by digits). */
const safeReplacementArb = fc
  .stringMatching(/^<[a-z]{1,16}>$/)
  .filter((s) => s.length > 2);

/** Generator for an arbitrary subset of the built-in entity rules. The same
 * entity is never listed twice (the engine ignores duplicates, but we keep
 * the generator clean). Each rule has a 50% chance of using a custom
 * replacement, otherwise the default is used. */
const entityRulesArb: fc.Arbitrary<RedactionRule[]> = fc
  .subarray(ENTITY_NAMES)
  .chain((entities) =>
    fc
      .tuple(
        ...entities.map((entity) =>
          fc.oneof(
            fc.constant<RedactionRule>({ kind: 'entity', entity }),
            safeReplacementArb.map<RedactionRule>((replacement) => ({
              kind: 'entity',
              entity,
              replacement,
            })),
          ),
        ),
      )
      .map((rules) => rules as RedactionRule[]),
  );

/** Generator for text containing a mix of plain words and embedded PII so
 * that the property exercises both the trivial fixed-point and the redaction
 * fixed-point. */
const textArb = fc
  .array(
    fc.oneof(
      // Plain ascii words.
      fc.stringMatching(/^[A-Za-z ,.!?]{1,40}$/),
      // Email-shaped substrings.
      fc.constantFrom(
        'alice@example.com',
        'bob.smith+work@mail.co.uk',
        'no-reply@deep.sub.domain.io',
      ),
      // Phone-shaped substrings.
      fc.constantFrom(
        '415-555-1212',
        '(415) 555-1212',
        '+1 415.555.1212',
        '+44 20 7946 0958',
      ),
      // Credit-card-shaped substrings.
      fc.constantFrom(
        '4111-1111-1111-1111',
        '4111 1111 1111 1111',
        '4111111111111111',
        '5500-0000-0000-0004',
      ),
      // IBAN-shaped substrings.
      fc.constantFrom(
        'GB82WEST12345698765432',
        'DE89370400440532013000',
        'FR1420041010050500013M02606',
      ),
      // SSN-shaped substrings.
      fc.constantFrom('123-45-6789', '987-65-4321'),
    ),
    { minLength: 0, maxLength: 8 },
  )
  .map((parts) => parts.join(' '));

describe('apply — Property 44: redaction is idempotent', () => {
  it('apply(apply(x, R), R) === apply(x, R) for any text x and built-in rule set R', () => {
    fc.assert(
      fc.property(textArb, entityRulesArb, (text, rules) => {
        const once = apply(text, rules);
        const twice = apply(once, rules);
        return twice === once;
      }),
      { numRuns: 300 },
    );
  });

  it('default entity replacements are themselves fixed points of the full rule set', () => {
    // A direct check that the chosen replacements satisfy the precondition
    // the property test relies on: feeding any of them back through the
    // engine yields the same string.
    for (const entity of ENTITY_NAMES) {
      const replacement = DEFAULT_ENTITY_REPLACEMENT[entity];
      expect(apply(replacement, ALL_ENTITIES)).toBe(replacement);
    }
  });
});
