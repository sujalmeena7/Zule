// ============================================
// Zule AI — Redaction rule type
// ============================================
//
// Canonical rule shape consumed by `Redaction_Engine.apply`
// (see design.md §Components and Interfaces > 9. Redaction_Engine).
//
// A `regex` rule applies a user-defined pattern (with explicit `flags`
// and a `replacement`); an `entity` rule selects one of the built-in
// entity classes. The engine applies regex rules first (so user rules
// can override) and then the built-in entity rules. Replacements are
// chosen so they do not themselves match the rule, which gives the
// engine its idempotence (Property 44, Requirement 30.2).

export type RedactionRule =
  | {
      kind: 'regex';
      pattern: string;
      flags: string;
      replacement: string;
    }
  | {
      kind: 'entity';
      entity: 'email' | 'phone' | 'credit-card' | 'iban' | 'us-ssn';
      /** Defaults to `[REDACTED:<ENTITY>]` when omitted. */
      replacement?: string;
    };

/** The set of built-in entity classes recognised by the engine. */
export type RedactionEntity = Extract<RedactionRule, { kind: 'entity' }>['entity'];
