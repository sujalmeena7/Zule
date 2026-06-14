// ============================================
// Zule AI — Redaction_Engine
// ============================================
//
// Pure, declarative redaction over text and `ContextSection` arrays. Implements
// design.md §"Components and Interfaces > 9. Redaction_Engine" and
// Requirement 15.3 ("apply User-defined rule set ... to transcript and screen
// text before either is included in any prompt sent to a cloud
// Provider_Adapter").
//
// Rule application order:
//   1. User-defined `regex` rules in declaration order.
//   2. Built-in `entity` rules in canonical order.
//
// User-defined regex rules run first so that a User can override a built-in
// (e.g. a stricter email pattern) by listing their override before the built-in
// is requested.
//
// Idempotence (Property 44 / Requirement 30.2):
//   apply(apply(x, R), R) === apply(x, R)
// The built-in entity replacements (`[REDACTED:EMAIL]`, `[REDACTED:PHONE]`,
// `[REDACTED:CC]`, `[REDACTED:IBAN]`, `[REDACTED:SSN]`) contain no `@`, no
// digits, and no `[A-Z]{2}\d{2}` shape, so none of the built-in patterns can
// match an output of any other built-in rule. The function performs no I/O and
// has no hidden state.

import type { RedactionRule, RedactionEntity } from '../types/redaction';

/**
 * A minimal mirror of `Context_Builder`'s `ContextSection` shape so that
 * `applyToSections` can be implemented and tested ahead of the full
 * `Context_Builder` rewrite (Task 5). Once `contextBuilder.ts` lands, the
 * canonical type will live there and this re-declaration is expected to be
 * replaced by a re-export.
 */
export interface ContextSection {
  label: '[KNOWLEDGE]' | '[MEMORY]' | '[AUDIO]' | '[SCREEN]';
  text: string;
  tokenCount?: number;
  citationId?: string;
  source?: { docId?: string; meetingId?: string; date?: number };
}

/**
 * Default replacement strings for the built-in entity classes. Each string is
 * chosen so that no built-in pattern (defined in `ENTITY_PATTERN` below) can
 * match it: this is what guarantees idempotence for the built-in rules.
 */
export const DEFAULT_ENTITY_REPLACEMENT: Readonly<Record<RedactionEntity, string>> =
  Object.freeze({
    email: '[REDACTED:EMAIL]',
    phone: '[REDACTED:PHONE]',
    'credit-card': '[REDACTED:CC]',
    iban: '[REDACTED:IBAN]',
    'us-ssn': '[REDACTED:SSN]',
  });

/**
 * Built-in entity patterns. All compiled with the `g` flag so a single
 * `String.prototype.replace` pass redacts every occurrence in the input.
 *
 * These patterns lean toward recall (catch the common formats) over precision;
 * the engine is the last line of defence before cloud egress, so a small
 * false-positive rate on, for example, long digit strings is preferred to
 * leaking a real card number.
 */
const ENTITY_PATTERN: Readonly<Record<RedactionEntity, RegExp>> = {
  // Simplified RFC: local@domain.tld, anchored on word boundaries.
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,

  // US-style and E.164. Optional country code, optional area-code parens,
  // optional separators of space / dot / dash. The `(?<!\d)` and `(?!\d)`
  // guards keep the pattern from latching onto 10-digit substrings of
  // longer digit runs (e.g. the trailing 10 digits of a 22-character IBAN
  // or a 12-digit order ref). `\b` is insufficient here because digit-to-
  // digit transitions are not word boundaries.
  phone:
    /(?<!\d)(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}(?!\d)/g,

  // 13–19 digits (PAN range) with optional space/dash separators between them.
  'credit-card': /\b(?:\d[ -]?){12,18}\d\b/g,

  // IBAN: 2-letter country code + 2 check digits + 11–30 BBAN alphanumerics.
  // Total length 15–34, matching the published IBAN length range.
  iban: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,

  // US SSN: XXX-XX-XXXX. Dashes are required to keep precision; bare 9-digit
  // runs are caught by the credit-card or phone patterns when applicable.
  'us-ssn': /\b\d{3}-\d{2}-\d{4}\b/g,
};

/**
 * Order in which built-in entity rules are applied when the User has opted into
 * one. More specific patterns run first so they can claim a substring before a
 * looser pattern (e.g. credit-card) consumes it.
 */
const ENTITY_ORDER: readonly RedactionEntity[] = [
  'email',
  'us-ssn',
  'iban',
  'phone',
  'credit-card',
];

/**
 * Apply `rules` to `text`, returning a new string with every matching region
 * replaced. The function is total and pure: malformed user regex (a pattern
 * `RegExp` cannot compile) is silently skipped — the next rule still runs and
 * the input is otherwise passed through. This mirrors the engine's role as a
 * last-line defence: a broken user rule must not abort redaction of the
 * remainder.
 */
export function apply(text: string, rules: readonly RedactionRule[]): string {
  if (text.length === 0 || rules.length === 0) return text;

  let out = text;

  // 1) User-defined regex rules first, in declaration order. A user rule
  //    appearing before an entity rule of the same shape effectively overrides
  //    the built-in.
  for (const rule of rules) {
    if (rule.kind !== 'regex') continue;
    const re = compileUserRegex(rule.pattern, rule.flags);
    if (re === null) continue; // malformed -> skip
    out = out.replace(re, rule.replacement);
  }

  // 2) Built-in entity rules in canonical order; only apply those the User
  //    opted into. Each entity rule is applied at most once per `apply` call,
  //    even if the caller listed the same entity twice (the first replacement
  //    wins).
  out = applyEntityRules(out, rules);

  return out;
}

/**
 * Apply every requested built-in entity rule to `text` in canonical order. If
 * the caller listed the same entity twice, the first occurrence's replacement
 * is used and the second is ignored (so callers cannot accidentally apply two
 * different replacements for the same class).
 */
function applyEntityRules(text: string, rules: readonly RedactionRule[]): string {
  if (text.length === 0) return text;

  const requested = new Map<RedactionEntity, string>();
  for (const rule of rules) {
    if (rule.kind !== 'entity') continue;
    if (requested.has(rule.entity)) continue;
    requested.set(
      rule.entity,
      rule.replacement ?? DEFAULT_ENTITY_REPLACEMENT[rule.entity],
    );
  }

  if (requested.size === 0) return text;

  let out = text;
  for (const entity of ENTITY_ORDER) {
    const replacement = requested.get(entity);
    if (replacement === undefined) continue;
    out = out.replace(ENTITY_PATTERN[entity], replacement);
  }
  return out;
}

/**
 * Compile a user-supplied regex, ensuring the `g` flag is present so every
 * match in the text is replaced (rather than only the first). Returns `null`
 * on malformed input so the caller can silently skip the rule.
 */
function compileUserRegex(pattern: string, flags: string): RegExp | null {
  const normalisedFlags = flags.includes('g') ? flags : flags + 'g';
  try {
    return new RegExp(pattern, normalisedFlags);
  } catch {
    return null;
  }
}

/**
 * Apply `rules` to every `text` field of `sections`. Returns a new array of
 * new `ContextSection` objects; the input array and its sections are not
 * mutated. Other fields (`label`, `tokenCount`, `citationId`, `source`) are
 * passed through verbatim.
 *
 * Note: redaction may shorten or extend the section text, so any cached
 * `tokenCount` may be stale on the returned sections. Callers that depend on
 * an accurate token count should re-tokenize after applying redaction
 * (`Context_Builder` does this in Task 5).
 */
export function applyToSections(
  sections: readonly ContextSection[],
  rules: readonly RedactionRule[],
): ContextSection[] {
  return sections.map((s) => ({ ...s, text: apply(s.text, rules) }));
}
