/**
 * Fusion Hints — detects named entities that appear in both screen text
 * and the recent transcript, so the Context_Builder can surface a short
 * hint line in the assembled prompt.
 *
 * Requirement 23.2: WHEN both screen text and the latest transcript line
 * reference overlapping entities, THE Context_Builder SHALL surface a
 * fusion hint in the prompt.
 */

// ─── Entity extraction helpers ──────────────────────────────────────────────

/**
 * Matches capitalised multi-word sequences (2+ words, each starting with
 * an uppercase letter). Examples: "Q3 Budget", "Alice Smith", "Project Falcon".
 */
const CAPITALISED_PHRASE_RE = /\b([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)+)\b/g;

/**
 * Matches standalone capitalised single words that are at least 2 chars
 * and are NOT common English sentence-starters.
 * We include alphanumeric tokens like "Q3", "B2B", etc.
 */
const CAPITALISED_WORD_RE = /\b([A-Z][A-Za-z0-9]{1,})\b/g;

/** Common sentence-starting words to exclude from single-word entity matching. */
const STOP_WORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'There', 'Then', 'They',
  'What', 'When', 'Where', 'Which', 'Who', 'Whom', 'Why', 'How',
  'And', 'But', 'For', 'Not', 'With', 'From', 'Into', 'About',
  'After', 'Before', 'Between', 'During', 'Without', 'Through',
  'Also', 'However', 'Therefore', 'Although', 'Because', 'Since',
  'While', 'Would', 'Could', 'Should', 'Will', 'Can', 'May',
  'Just', 'Only', 'Even', 'Still', 'Already', 'Never', 'Always',
  'Here', 'Now', 'Well', 'Very', 'Much', 'Most', 'Some', 'Any',
  'All', 'Each', 'Every', 'Both', 'Few', 'Many', 'More', 'Other',
  'Our', 'Your', 'His', 'Her', 'Its', 'Their', 'My',
  'Please', 'Sure', 'Yes', 'Yeah', 'Okay',
]);

/**
 * Matches numbers that look meaningful: decimal numbers, percentages,
 * currency amounts, year-like sequences. Handles optional $ prefix.
 * Requires at least one digit after the decimal point to consume it.
 */
const NUMBER_RE = /(?<!\w)(\$?\d[\d,]*(?:\.\d+)?%?)(?!\w)/g;

/**
 * Matches URLs (http/https or www prefix).
 */
const URL_RE = /https?:\/\/[^\s]+|www\.[^\s]+/gi;

/**
 * Extract candidate named entities from a block of text.
 * Returns a de-duplicated set of entity strings (normalised to trimmed form).
 */
function extractEntities(text: string): Set<string> {
  const entities = new Set<string>();

  // Multi-word capitalised phrases (highest signal)
  for (const match of text.matchAll(CAPITALISED_PHRASE_RE)) {
    entities.add(match[1].trim());
  }

  // Single capitalised words (filter stop words)
  for (const match of text.matchAll(CAPITALISED_WORD_RE)) {
    const word = match[1];
    if (!STOP_WORDS.has(word)) {
      entities.add(word);
    }
  }

  // Numbers / percentages / currency
  for (const match of text.matchAll(NUMBER_RE)) {
    entities.add(match[1]);
  }

  // URLs
  for (const match of text.matchAll(URL_RE)) {
    entities.add(match[0]);
  }

  return entities;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Detect entities that appear in BOTH the screen text and the recent
 * transcript lines. Returns an array of human-readable hint strings.
 *
 * @param screenText - The current OCR-extracted screen text.
 * @param recentTranscript - The most recent transcript lines (plain text).
 * @returns An array of fusion-hint strings (may be empty).
 */
export function detectFusionHints(
  screenText: string,
  recentTranscript: string[],
): string[] {
  if (!screenText || screenText.trim().length === 0) return [];
  if (!recentTranscript || recentTranscript.length === 0) return [];

  const transcriptText = recentTranscript.join(' ');
  if (transcriptText.trim().length === 0) return [];

  const screenEntities = extractEntities(screenText);
  const transcriptEntities = extractEntities(transcriptText);

  if (screenEntities.size === 0 || transcriptEntities.size === 0) return [];

  // Find intersection
  const overlapping: string[] = [];
  for (const entity of screenEntities) {
    if (transcriptEntities.has(entity)) {
      overlapping.push(entity);
    }
  }

  if (overlapping.length === 0) return [];

  // Sort for deterministic output, then cap at a reasonable number
  overlapping.sort();
  const capped = overlapping.slice(0, 8);

  const quoted = capped.map((e) => `'${e}'`).join(', ');
  return [`Both screen and audio mention: ${quoted}`];
}
