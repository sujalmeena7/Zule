// ============================================
// Zule AI — Endpoint_Validator (pure)
// ============================================
//
// Validates and normalises a User-supplied Base_URL for the Custom
// (OpenAI-compatible) provider (design.md §1. Endpoint_Validator).
//
// The module is deliberately dependency-free: every safety-critical branch on
// the Base_URL — emptiness, length, parseability, scheme — lives here so it is
// testable without IndexedDB, Electron, React, or a network.
//
// Normalisation returns the *input* text with trailing '/' characters stripped,
// never `url.href`. `URL` canonicalisation would re-add a path slash
// (`https://host` → `https://host/`) and may re-order or re-encode query
// parameters that some gateways require verbatim.
//
// Stripping is run to a fixed point because the two operations feed each other:
// `'http://host\r/'` hides whitespace *behind* a trailing slash, and
// `'http://host/ /'` hides a slash behind whitespace. A single trim followed by
// a single strip (or a trailing `trimEnd`) leaves one of the two cases behind,
// which would break idempotence and let a stray control character into the
// assembled `{baseUrl}/chat/completions` endpoint.
//
// Requirements: 1.3, 1.8

/** Maximum accepted Base_URL length, in characters (Requirement 1.2). */
export const MAX_BASE_URL_LENGTH = 2048;

export type BaseUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'empty' | 'too-long' | 'unparseable' | 'unsupported-scheme' };

/** The only schemes an outbound provider request may use. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Alternates `trim()` and trailing-'/' stripping until the value stops
 * changing, so neither operation can re-expose work for the other.
 *
 * Terminates: every iteration that changes the value removes at least one
 * character, so the loop runs at most `value.length` times.
 */
function stripToFixedPoint(value: string): string {
  let current = value;
  for (;;) {
    const next = current.trim().replace(/\/+$/, '');
    if (next === current) return current;
    current = next;
  }
}

/**
 * Trims, validates, and normalises a User-supplied Base_URL.
 *
 * Normalisation = trim surrounding whitespace and strip every trailing '/',
 * repeated to a fixed point.
 * Only absolute URLs whose protocol is exactly `http:` or `https:` are
 * accepted; `new URL(trimmed)` without a base is what makes "absolute"
 * precise, since it rejects relative paths.
 *
 * Idempotent: `normalizeBaseUrl(normalizeBaseUrl(x).url).url` equals
 * `normalizeBaseUrl(x).url` for every accepted input.
 */
export function normalizeBaseUrl(raw: string): BaseUrlResult {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  // Length is checked *before* parsing so a pathological input never reaches
  // `new URL` (Requirement 1.2).
  if (trimmed.length > MAX_BASE_URL_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: 'unsupported-scheme' };
  }

  const normalized = stripToFixedPoint(trimmed);

  // Defensive, and keeps the emptiness decision single-valued: an input that
  // normalises away entirely is empty, not an accepted empty Base_URL. Such an
  // input cannot reach here today (it would not parse), but the invariant
  // "ok ⇒ url is a usable endpoint prefix" is worth stating locally.
  if (normalized.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  return { ok: true, url: normalized };
}
