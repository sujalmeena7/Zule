// ============================================
// Zule AI — Document_Parser (refactored)
// ============================================
//
// Implements the Document_Parser contract from design.md §17 / §25:
//
//   * Local PDF.js worker (Requirement 15.7, 21.5) — `workerSrc` is set
//     to a path served from `public/vendor/pdfjs/` rather than a CDN. The
//     mirroring is performed by the Vite plugin / `scripts/copy-vendor.mjs`.
//   * Closed-set extension validation (Requirement 25.3, 18.7) — a total
//     `validateExtension(ext)` function returns a boolean for any input.
//     `parseDocument` rejects unsupported extensions by returning a
//     typed `ZuleError` (`document.unsupported-extension`) rather than
//     throwing strings or calling `alert()`.
//   * Encrypted-PDF handling (Requirement 25.1) — `pdfjs.getDocument`
//     errors of class `PasswordException` are caught at the boundary and
//     surfaced as `document.encrypted-pdf`; the function never throws on
//     this path.
//   * DOCX paragraph preservation (Requirement 25.2) — `mammoth`'s raw
//     text output is split on `\n\n` boundaries by the exported
//     `paragraphs()` helper so consumers can index per-paragraph chunks
//     instead of one monolithic string.
//   * Token-aware chunking (Requirement 25.4) — when an embedding model
//     exposes a tokenizer (`countTokens`), the chunker sizes chunks in
//     tokens (default 300, with 50-token overlap). When no tokenizer is
//     available, the chunker falls back to a word-count-based splitter
//     that satisfies the same round-trip property.
//   * Round-trip (Requirement 25.5) — for any plain-text input, the
//     chunker produces chunks `c_0, c_1, ..., c_n` whose first words
//     after the first chunk are exactly the last `overlap` words of the
//     previous chunk. Joining `[c_0, c_1[overlap:], c_2[overlap:], ...]`
//     reconstructs the original whitespace-separated word sequence
//     verbatim. (See `dedupOverlap` below and the property test in
//     `documentParser.test.ts`.)
//
// The Web-Worker move described in design.md §17 is intentionally
// deferred — the algorithmic API and error contract land first; moving
// the parse + chunk pipeline off the main thread is a follow-up that
// does not change the public surface.

import type { Result } from '../types/result';
import { ok, err } from '../types/result';
import type { ZuleError } from '../types/errors';

// pdfjs-dist and mammoth are heavyweight (and pdfjs touches DOM globals
// at module-evaluation time). They are loaded lazily inside the parser
// boundaries below so the chunker / validator / paragraph helper —
// which the rest of the app and the test suite use synchronously —
// stay free of those side-effects. This also matches the
// code-splitting plan in design.md (the Document_Parser, PDF.js, and
// mammoth ship as on-demand chunks).

// ─── Extension validation ────────────────────────────────────────────────

/**
 * The closed set of file extensions the Document_Parser accepts. Held as
 * a single source-of-truth so the validator and any UI-side filter
 * (`<input accept=...>` etc.) cannot drift apart. (Requirement 25.3.)
 */
export const SUPPORTED_EXTENSIONS = ['txt', 'md', 'json', 'pdf', 'docx'] as const;

export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

const SUPPORTED_SET: ReadonlySet<string> = new Set<string>(SUPPORTED_EXTENSIONS);

/**
 * Total predicate: returns `true` iff `ext` (case-insensitive, leading
 * `.` ignored) is a member of the supported set, and `false` for every
 * other input including non-strings (Property 59, Requirement 25.3).
 *
 * Totality is the point — any caller can hand this any value (a number,
 * `null`, `undefined`, an object) and get back a boolean without an
 * exception. The thrown errors are reserved for genuinely-broken
 * upstream contracts (e.g. PDF parsing) so the UI layer can centralise
 * its toast UX (Requirement 18.7).
 */
export function validateExtension(ext: unknown): boolean {
  if (typeof ext !== 'string') return false;
  const normalised = ext.trim().toLowerCase().replace(/^\./, '');
  return SUPPORTED_SET.has(normalised);
}

/** Extracts the lowercase extension from a filename. Returns `''` when none. */
function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot < 0 || lastDot === filename.length - 1) return '';
  return filename.slice(lastDot + 1).toLowerCase();
}

// ─── parseDocument / parsePDF / parseDOCX ────────────────────────────────

/**
 * Parses a `File` to plain text, returning a typed `Result` rather than
 * throwing on the well-known recoverable failures (unsupported
 * extension, encrypted PDF). Unknown errors still propagate via
 * rejection so the consumer's outer `try/catch` can surface them — the
 * `Result` channel is reserved for failures the UI has a concrete
 * recovery path for.
 *
 * (Requirements 25.1, 25.2, 25.3.)
 */
export async function parseDocument(
  file: File,
): Promise<Result<string, ZuleError>> {
  const extension = getExtension(file.name);

  if (!validateExtension(extension)) {
    return err({ kind: 'document.unsupported-extension', ext: extension });
  }

  if (extension === 'txt' || extension === 'md' || extension === 'json') {
    const text = await file.text();
    return ok(text);
  }

  if (extension === 'pdf') {
    return await parsePDF(file);
  }

  // The validator above guarantees `extension === 'docx'` at this point,
  // but the explicit branch keeps the control-flow obvious.
  return await parseDOCX(file);
}

/**
 * Parses a PDF page-by-page. Encrypted PDFs surface a typed
 * `document.encrypted-pdf` error rather than throwing (Requirement
 * 25.1). The detection looks at `error.name === 'PasswordException'`
 * because pdfjs-dist does not export the exception class from its
 * public ESM surface.
 */
export async function parsePDF(
  file: File,
): Promise<Result<string, ZuleError>> {
  // Lazy-load pdfjs so the chunker / validator can be imported in
  // environments without DOMMatrix (e.g. jsdom under Vitest). The first
  // call also installs the local worker path (Requirement 15.7, 21.5).
  const pdfjsLib = await import('pdfjs-dist');
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      '/vendor/pdfjs/pdf.worker.min.mjs';
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;

    const pageTexts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((item: any) => (typeof item.str === 'string' ? item.str : ''))
        .join(' ');
      pageTexts.push(pageText);
    }

    return ok(pageTexts.join('\n\n').trim());
  } catch (e) {
    if (isPasswordException(e)) {
      return err({ kind: 'document.encrypted-pdf' });
    }
    // Unknown errors (corrupt PDF, transient I/O) are not part of the
    // recoverable surface today; propagate so the caller's outer
    // try/catch can log + surface them.
    throw e;
  }
}

/**
 * Parses a DOCX via `mammoth.extractRawText`. The function returns the
 * raw extracted text with paragraph breaks intact — `mammoth` already
 * emits `\n\n` between paragraphs in its raw-text mode. Consumers that
 * want a paragraph array call `paragraphs(text)`.
 */
export async function parseDOCX(
  file: File,
): Promise<Result<string, ZuleError>> {
  const { default: mammoth } = await import('mammoth');
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  // Trim trailing whitespace but preserve interior `\n\n` separators.
  return ok(result.value.replace(/\s+$/u, ''));
}

/**
 * Splits a `\n\n`-separated text block into a list of trimmed
 * paragraphs, dropping empty entries. Used by callers that want one
 * vector / chunk per paragraph (Requirement 25.2).
 */
export function paragraphs(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text
    .split(/\n\n+/u)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// ─── Chunker ────────────────────────────────────────────────────────────

export interface ChunkOptions {
  /** Maximum tokens (or words, in the fallback path) per chunk. Default 300. */
  chunkSize?: number;
  /** Number of tokens / words shared between consecutive chunks. Default 50. */
  overlap?: number;
  /**
   * Optional tokenizer. When provided, the chunker sizes chunks by the
   * value this returns (Requirement 25.4). When omitted, the chunker
   * falls back to whitespace-separated word counts.
   */
  countTokens?: (text: string) => number;
}

/**
 * Splits a plain-text input into overlapping chunks suitable for
 * embedding. The default parameters (`chunkSize = 300`, `overlap = 50`)
 * match the design.md §17 budget and produce the round-trip property
 * documented in Requirement 25.5 / Property 56.
 *
 * The token-aware path is engaged by passing a `countTokens` function;
 * otherwise the chunker uses a word-count splitter (the fallback the
 * design specifies when the embedding model does not expose a
 * tokenizer).
 *
 * Empty / whitespace-only input returns `[]`.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const chunkSize = opts.chunkSize ?? 300;
  const overlap = opts.overlap ?? 50;

  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError(`chunkSize must be a positive integer, got ${chunkSize}`);
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    throw new RangeError(
      `overlap must be an integer in [0, chunkSize), got ${overlap} (chunkSize ${chunkSize})`,
    );
  }

  const words = tokenizeWords(text);
  if (words.length === 0) return [];

  return opts.countTokens
    ? chunkByTokens(words, chunkSize, overlap, opts.countTokens)
    : chunkByWords(words, chunkSize, overlap);
}

/**
 * After chunking with overlap `M`, the first `M` words of every chunk
 * after the first are duplicates of the previous chunk's tail. This
 * helper drops those duplicates so the round-trip property is testable:
 *
 *     dedupOverlap(chunkText(s, opts), opts.overlap).join(' ')
 *
 * yields a string whose whitespace-separated tokens equal the original
 * `tokenizeWords(s)` array, in order. (Property 56, Requirement 25.5.)
 */
export function dedupOverlap(chunks: string[], overlap: number): string[] {
  if (chunks.length === 0) return [];
  if (!Number.isInteger(overlap) || overlap < 0) {
    throw new RangeError(`overlap must be a non-negative integer, got ${overlap}`);
  }
  if (overlap === 0) return chunks.slice();

  const out: string[] = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const words = tokenizeWords(chunks[i]);
    out.push(words.slice(overlap).join(' '));
  }
  return out;
}

// ─── internals ──────────────────────────────────────────────────────────

/**
 * Whitespace-splitting tokenizer that drops empty entries. Co-located
 * here (rather than imported from a generic util) because the
 * round-trip property is defined in terms of this exact split.
 */
function tokenizeWords(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  // The `filter(Boolean)` collapses the leading / trailing empty strings
  // produced by `split(/\s+/)` on inputs that begin or end with
  // whitespace.
  return text.split(/\s+/u).filter((w) => w.length > 0);
}

function chunkByWords(words: string[], chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  const step = chunkSize - overlap;
  let i = 0;
  // The `i + chunkSize >= words.length` guard prevents the final chunks
  // from being entirely-overlap (i.e. wholly duplicated content) — once
  // a chunk reaches the end of the input, we stop. This is what makes
  // the dedup-of-overlap reconstruction total without producing trailing
  // empty entries.
  while (i < words.length) {
    chunks.push(words.slice(i, i + chunkSize).join(' '));
    if (i + chunkSize >= words.length) break;
    i += step;
  }
  return chunks;
}

/**
 * Token-aware chunker. Greedy: extend each chunk as long as
 * `countTokens(chunk-so-far)` stays at or below `chunkSize`. When the
 * boundary is reached, back off `overlap` tokens (measured by the same
 * `countTokens`) into the previous chunk to seed the next one.
 *
 * Property 57 (every chunk has at most `chunkSize` tokens) holds for
 * any input where individual words tokenise to ≤ `chunkSize` tokens —
 * the realistic regime for sub-word tokenizers like the ones shipped
 * with sentence-transformer embedding models. If a single word
 * tokenises to more than `chunkSize`, the chunker still emits it as a
 * single-word chunk (forward progress over invariant preservation in
 * the degenerate case); the property test constrains its generators
 * accordingly.
 */
function chunkByTokens(
  words: string[],
  chunkSize: number,
  overlap: number,
  countTokens: (text: string) => number,
): string[] {
  const chunks: string[] = [];
  let i = 0;

  while (i < words.length) {
    // Grow the chunk one word at a time, stopping when an additional
    // word would exceed `chunkSize` tokens.
    let j = i;
    let lastFitting = i;
    while (j < words.length) {
      const candidate = words.slice(i, j + 1).join(' ');
      if (countTokens(candidate) <= chunkSize) {
        lastFitting = j + 1;
        j++;
      } else {
        break;
      }
    }

    // Forward-progress guarantee: if not even one word fits the budget,
    // emit it as a single-word chunk anyway. (The property test rules
    // this branch out by construction.)
    if (lastFitting === i) {
      lastFitting = i + 1;
    }

    chunks.push(words.slice(i, lastFitting).join(' '));

    if (lastFitting >= words.length) break;

    // Back off `overlap` tokens worth of words from the chunk's tail
    // to seed the next chunk.
    let nextStart = lastFitting;
    while (nextStart > i + 1) {
      const tail = words.slice(nextStart - 1, lastFitting).join(' ');
      if (countTokens(tail) <= overlap) {
        nextStart--;
      } else {
        break;
      }
    }
    // Forward progress: ensure `nextStart` advances past `i`.
    if (nextStart <= i) nextStart = i + 1;

    i = nextStart;
  }

  return chunks;
}

// ─── error helpers ──────────────────────────────────────────────────────

/**
 * Identifies the pdfjs-dist `PasswordException` from its `name` field,
 * since the exception class is not exported from the public ESM
 * surface (verified against `pdfjs-dist@6.x`). Documented here so that
 * if pdfjs-dist ever changes the error shape we have one place to fix.
 */
function isPasswordException(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false;
  const name = (e as { name?: unknown }).name;
  return name === 'PasswordException';
}
