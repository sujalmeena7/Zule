// ============================================
// Zule AI — Endpoint_Validator tests
// ============================================
//
// Feature: custom-openai-compatible-provider, Property 1: Base_URL validation and normalisation
//
// *For any* string `s`, `normalizeBaseUrl(s)` SHALL return `ok: true` if and
// only if `s.trim()` is at most 2048 characters and parses as an absolute URL
// whose protocol is `http:` or `https:`; when `ok`, the returned `url` SHALL
// have no leading or trailing whitespace and no trailing `/` character, and
// `normalizeBaseUrl(url).url` SHALL equal `url`.
//
// **Validates: Requirements 1.3, 1.8**

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { MAX_BASE_URL_LENGTH, normalizeBaseUrl } from './endpointValidator';

// ── Oracle ──────────────────────────────────────────────────────────────────
// An independent restatement of the acceptance condition from the property:
// trimmed, non-empty, within the length bound, parses absolutely, http(s).

function shouldAccept(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > MAX_BASE_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

// ── Generators ──────────────────────────────────────────────────────────────
// The input space is "any string", so the candidate arbitrary mixes fully
// random text with structured gateway-shaped URLs (the interesting region),
// boundary-length inputs around MAX_BASE_URL_LENGTH, and the whitespace /
// trailing-slash decorations the normalisation contract is written about.

const WHITESPACE = [' ', '\t', '\n', '\r', '\u00a0'];

/** Leading/trailing decoration: whitespace and `/` characters, in any order. */
const arbPad = fc.stringOf(fc.constantFrom(...WHITESPACE, '/'), { maxLength: 3 });

const arbStructuredUrl = fc
  .tuple(
    fc.constantFrom('http', 'https', 'HTTP', 'ftp', 'ws', 'wss', 'file', 'javascript', 'mailto', ''),
    fc.constantFrom('example.com', 'localhost', 'openrouter.ai', 'api.groq.com', '127.0.0.1', ''),
    fc.constantFrom('', ':11434', ':1234', ':443'),
    fc.constantFrom('', '/', '//', '/v1', '/v1/', '/api/v1', '/openai/v1//'),
    fc.constantFrom('', '?b=2&a=1', '?model=x%2Fy', '#frag'),
  )
  .map(([scheme, host, port, path, tail]) =>
    scheme.length > 0 ? `${scheme}://${host}${port}${path}${tail}` : `${host}${port}${path}${tail}`,
  );

/** Valid-shaped URLs whose trimmed length straddles MAX_BASE_URL_LENGTH. */
const arbBoundaryLengthUrl = fc
  .integer({ min: MAX_BASE_URL_LENGTH - 2, max: MAX_BASE_URL_LENGTH + 2 })
  .map((total) => {
    const prefix = 'https://example.com/';
    return prefix + 'a'.repeat(Math.max(0, total - prefix.length));
  });

const arbCandidate = fc
  .tuple(
    arbPad,
    fc.oneof(
      { weight: 6, arbitrary: arbStructuredUrl },
      { weight: 2, arbitrary: fc.string({ maxLength: 40 }) },
      { weight: 1, arbitrary: arbBoundaryLengthUrl },
    ),
    arbPad,
  )
  .map(([lead, body, trail]) => `${lead}${body}${trail}`);

// ── Property 1 ──────────────────────────────────────────────────────────────

describe('Property 1: Base_URL validation and normalisation', () => {
  it('accepts exactly the bounded absolute http(s) URLs and returns a trimmed, slash-free fixed point', () => {
    fc.assert(
      fc.property(arbCandidate, (raw) => {
        const result = normalizeBaseUrl(raw);

        // ok ⟺ trimmed is non-empty, within the length bound, absolute, http(s).
        expect(result.ok).toBe(shouldAccept(raw));

        if (result.ok) {
          // No leading or trailing whitespace.
          expect(result.url).toBe(result.url.trim());
          // No trailing '/' character.
          expect(result.url.endsWith('/')).toBe(false);
          // Idempotent: normalising the normalised value is a fixed point.
          const again = normalizeBaseUrl(result.url);
          expect(again.ok).toBe(true);
          if (again.ok) expect(again.url).toBe(result.url);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ── Example tests ───────────────────────────────────────────────────────────

describe('normalizeBaseUrl — examples', () => {
  it('rejects empty and whitespace-only input with reason "empty"', () => {
    expect(normalizeBaseUrl('')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeBaseUrl('   \t\n ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('checks the length bound before parsing', () => {
    const overLong = `https://example.com/${'a'.repeat(MAX_BASE_URL_LENGTH)}`;
    expect(normalizeBaseUrl(overLong)).toEqual({ ok: false, reason: 'too-long' });
    // A pathological non-URL of the same length is also rejected on length.
    expect(normalizeBaseUrl('a'.repeat(MAX_BASE_URL_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'too-long',
    });
  });

  it('rejects relative and unparseable input with reason "unparseable"', () => {
    expect(normalizeBaseUrl('example.com/v1')).toEqual({ ok: false, reason: 'unparseable' });
    expect(normalizeBaseUrl('/v1/chat')).toEqual({ ok: false, reason: 'unparseable' });
  });

  it('rejects non-http(s) schemes with reason "unsupported-scheme"', () => {
    for (const raw of ['ftp://example.com', 'file:///tmp/x', 'ws://example.com', 'javascript:alert(1)']) {
      expect(normalizeBaseUrl(raw)).toEqual({ ok: false, reason: 'unsupported-scheme' });
    }
  });

  it('trims surrounding whitespace and strips every trailing slash', () => {
    expect(normalizeBaseUrl('  https://openrouter.ai/api/v1///  ')).toEqual({
      ok: true,
      url: 'https://openrouter.ai/api/v1',
    });
    expect(normalizeBaseUrl('http://localhost:11434/v1')).toEqual({
      ok: true,
      url: 'http://localhost:11434/v1',
    });
  });

  it('returns the input text verbatim rather than URL canonicalisation', () => {
    // Query parameter order is preserved and no path slash is re-added.
    expect(normalizeBaseUrl('https://gw.example.com?b=2&a=1')).toEqual({
      ok: true,
      url: 'https://gw.example.com?b=2&a=1',
    });
    expect(normalizeBaseUrl('https://gw.example.com')).toEqual({
      ok: true,
      url: 'https://gw.example.com',
    });
  });
});
