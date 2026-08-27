// ============================================
// Zule AI — Screen Fast Cache
// ============================================
//
// A zero-async response cache for the screen-grounded fast dispatch path.
//
// `responseCache` (the Semantic_Cache) matches queries by cosine similarity
// over Transformers.js embeddings. That tolerance is worth paying for on the
// conversational path, where the same question arrives phrased three different
// ways — but generating the query embedding is a WASM forward pass, so the
// lookup costs hundreds of milliseconds warm and seconds cold. On a lookup that
// misses, that entire cost is pure added latency before the request even leaves.
//
// On the screen path the tolerance is worth much less: the cache key includes
// the captured screen text, and screen text is either byte-identical (the user
// re-asked about the same unchanged frame) or wholly different (they scrolled to
// the next question). Near-miss matching has almost nothing to match. So this
// cache keys on an exact hash instead, which makes both hits and misses free.
//
// Scope is deliberately narrow: session-only, in-memory, small, and never
// consulted by the conversational path.

export interface CachedScreenResponse {
  text: string;
  isSimulated: boolean;
}

interface Entry extends CachedScreenResponse {
  key: string;
}

/** Bounded so a long session can't grow this without limit. */
const MAX_ENTRIES = 32;

/**
 * Screen text below this length is too thin to identify a frame — a capture
 * that produced only a window title would collide across unrelated questions.
 */
const MIN_SCREEN_TEXT_FOR_KEY = 24;

/** Most-recent-last insertion order; evicts from the front. */
const entries: Entry[] = [];

/**
 * FNV-1a, 32-bit. Chosen over a cryptographic digest because the only
 * requirement is that distinct screens rarely collide, and this runs on the
 * critical path — `crypto.subtle.digest` would reintroduce the await we are
 * here to remove.
 */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Build the cache key, or `null` when this dispatch isn't cacheable.
 *
 * Returns `null` when there is no query and no usable screen text, since the
 * remaining key material would be identical across unrelated dispatches.
 * Images are keyed by their own hash so a fresh photo of a new question never
 * reuses the previous answer.
 */
export function screenCacheKey(input: {
  mode: string;
  query: string;
  screenText: string;
  imageBase64?: string | null;
}): string | null {
  const query = input.query.trim();
  const screenText = input.screenText.trim();
  const hasUsableScreen = screenText.length >= MIN_SCREEN_TEXT_FOR_KEY;

  if (!query && !hasUsableScreen && !input.imageBase64) return null;

  return [
    input.mode,
    hash(query),
    hasUsableScreen ? hash(screenText) : 'no-screen',
    input.imageBase64 ? hash(input.imageBase64) : 'no-image',
  ].join(':');
}

/** Look up a cached response. Synchronous and allocation-light. */
export function getScreenCached(key: string | null): CachedScreenResponse | null {
  if (!key) return null;
  const index = entries.findIndex((entry) => entry.key === key);
  if (index === -1) return null;
  // Refresh recency so a repeatedly-asked question survives eviction.
  const [entry] = entries.splice(index, 1);
  entries.push(entry);
  return { text: entry.text, isSimulated: entry.isSimulated };
}

/**
 * Store a response. Simulated responses are rejected — caching the "add your
 * API key" placeholder would keep serving it after the key is configured.
 */
export function setScreenCached(key: string | null, response: CachedScreenResponse): void {
  if (!key || response.isSimulated || !response.text.trim()) return;

  const existing = entries.findIndex((entry) => entry.key === key);
  if (existing !== -1) entries.splice(existing, 1);

  entries.push({ key, text: response.text, isSimulated: response.isSimulated });
  while (entries.length > MAX_ENTRIES) entries.shift();
}

/** Drop every entry. Used by tests and by the session-stop path. */
export function clearScreenCache(): void {
  entries.length = 0;
}

/** Entry count — exposed for tests and diagnostics. */
export function screenCacheSize(): number {
  return entries.length;
}
