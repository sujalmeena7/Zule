// ============================================
// Zule AI — Knowledge_Base Retention (chunk-cap eviction)
// ============================================
//
// Pure helper that enforces the Knowledge_Base chunk cap mandated by
// Requirement 6.6. The cap is a *total chunk count* across every
// persisted `KBDocument`; once it is exceeded, oldest documents whose
// type maps to the "auto-saved" categories (`notes`, `sales-script` —
// the in-app proxies for the design's `meeting-fact` type) are evicted
// first. If evicting every auto-saved document still leaves the store
// over cap, eviction continues by `createdAt` ascending across all
// remaining documents.
//
// Acceptance criteria covered:
//
//   - 6.6 — Knowledge_Base applies a configurable retention cap
//     (default 2 000 chunks total). On insertion that would exceed the
//     cap, oldest chunks belonging to documents of type `notes` or
//     `meeting-fact` (mapped here to `notes` / `sales-script`) are
//     evicted first.
//
// Property covered:
//
//   - 19: Knowledge_Base retention cap is preserved under insertion;
//     `notes` / `sales-script` documents are evicted before others.

import type { KBDocument } from './database';

/**
 * Default Knowledge_Base chunk cap (Requirement 6.6). Lifting the
 * constant out of `database.ts` keeps it colocated with the eviction
 * algorithm and lets unit tests reference it without going through the
 * IndexedDB layer.
 */
export const DEFAULT_KB_RETENTION_CAP = 2000;

/**
 * Document types eligible for first-pass eviction. The codebase's
 * `KBDocument['type']` union does not include `meeting-fact` directly;
 * the running app persists auto-saved meeting facts under `notes` (see
 * `summaryEngine.saveFacts`) and the legacy "sales script" upload flow
 * also produces low-priority chunks suitable for early eviction.
 *
 * Captured as a `Set` so callers reading the whitelist (e.g. a future
 * Settings UI that surfaces the eviction order) can iterate without
 * touching this module's internals.
 */
export const KB_AUTO_EVICTABLE_TYPES: ReadonlySet<KBDocument['type']> =
  new Set<KBDocument['type']>(['notes', 'sales-script']);

/** Total chunk count across every document. Pure helper. */
export function totalChunkCount(documents: readonly KBDocument[]): number {
  let n = 0;
  for (const doc of documents) n += doc.chunks?.length ?? 0;
  return n;
}

/**
 * Apply the Knowledge_Base retention cap to a snapshot of documents.
 *
 * Algorithm:
 *
 *   1. If the total chunk count is already ≤ `cap`, return the input
 *      reference unchanged. This is the common case — the property
 *      test relies on it to assert "input below cap → output equals
 *      input".
 *   2. Otherwise, partition documents into two ordered lists:
 *        - `evictable`: documents whose type is in
 *          {@link KB_AUTO_EVICTABLE_TYPES}, sorted by `createdAt`
 *          ascending (oldest first).
 *        - `protected`: every other document, sorted by `createdAt`
 *          ascending.
 *   3. Walk `evictable` and add document ids to the eviction set
 *      until the running chunk total drops to or below `cap`.
 *   4. If still over cap, walk `protected` the same way.
 *   5. Return a new array containing only the documents whose ids
 *      were not evicted, preserving the input array's relative order
 *      (so callers using insertion-order snapshots see a stable
 *      output).
 *
 * The function is pure: inputs are not mutated, no module state is
 * read or written. `cap` is clamped to a non-negative integer floor;
 * `cap === 0` evicts every document.
 *
 * @param documents - readonly snapshot of the Knowledge_Base
 * @param cap - retention cap (defaults to {@link DEFAULT_KB_RETENTION_CAP})
 */
export function applyKBRetention(
  documents: readonly KBDocument[],
  cap: number = DEFAULT_KB_RETENTION_CAP,
): KBDocument[] {
  // Clamp cap defensively. `NaN` and negative values collapse to 0
  // (which evicts everything), while a positive `Infinity` is allowed
  // through unchanged so it represents "unlimited" — `total <= Infinity`
  // is always true, so the fast-path returns the input untouched.
  const safeCap =
    Number.isNaN(cap) || cap < 0 ? 0 : Math.floor(cap);

  const total = totalChunkCount(documents);
  if (total <= safeCap) {
    // No eviction needed. Return a fresh array so callers cannot
    // accidentally mutate the input via the result; document
    // references are shared (they are immutable from this module's
    // point of view).
    return documents.slice();
  }

  // Stable sort by createdAt ascending without disturbing the input.
  // Tie-break by id so two documents written in the same millisecond
  // (possible in tests) have a deterministic eviction order.
  const sortByAgeThenId = (a: KBDocument, b: KBDocument): number => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };

  const evictableQueue = documents
    .filter((d) => KB_AUTO_EVICTABLE_TYPES.has(d.type))
    .slice()
    .sort(sortByAgeThenId);

  const protectedQueue = documents
    .filter((d) => !KB_AUTO_EVICTABLE_TYPES.has(d.type))
    .slice()
    .sort(sortByAgeThenId);

  const toEvict = new Set<string>();
  let running = total;

  // First pass: oldest auto-evictable docs.
  for (const doc of evictableQueue) {
    if (running <= safeCap) break;
    toEvict.add(doc.id);
    running -= doc.chunks?.length ?? 0;
  }

  // Second pass: oldest protected docs, only if still over cap.
  if (running > safeCap) {
    for (const doc of protectedQueue) {
      if (running <= safeCap) break;
      toEvict.add(doc.id);
      running -= doc.chunks?.length ?? 0;
    }
  }

  // Preserve the input's original order in the output (the input is
  // already insertion-order from `getAllDocuments`); filtering
  // achieves this in a single pass.
  return documents.filter((d) => !toEvict.has(d.id));
}

/**
 * Compute the diff between an input snapshot and the post-retention
 * snapshot. Used by `database.enforceKBRetention` to know which ids to
 * `delete` from the documents store.
 */
export function diffKBRetention(
  before: readonly KBDocument[],
  after: readonly KBDocument[],
): { evictedIds: string[] } {
  const keptIds = new Set<string>();
  for (const d of after) keptIds.add(d.id);
  const evictedIds: string[] = [];
  for (const d of before) {
    if (!keptIds.has(d.id)) evictedIds.push(d.id);
  }
  return { evictedIds };
}
