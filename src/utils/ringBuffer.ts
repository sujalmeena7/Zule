// ============================================
// Zule AI — Ring Buffer Helper
// ============================================
//
// A pure, generic ring-buffer utility used by the Screen_Capture_Module
// to retain the most-recent N OCR results (Requirement 13.6). The helper
// is framework-free and side-effect-free, making it straightforward to
// property-test.

/**
 * Push `entry` onto `buffer`, evicting the oldest entry when the buffer
 * reaches `maxSize`. Returns a **new** array — the original is never
 * mutated.
 *
 * Invariants:
 *   - The returned array length is always `<= maxSize`.
 *   - The most recently pushed entry is at the end.
 *   - When eviction is needed, the entry at index 0 (the oldest) is removed.
 *
 * @param buffer  The current ring buffer (may be empty).
 * @param entry   The new item to append.
 * @param maxSize Maximum number of entries to retain (must be >= 1).
 */
export function pushToRingBuffer<T>(
  buffer: readonly T[],
  entry: T,
  maxSize: number,
): T[] {
  if (maxSize < 1) {
    throw new RangeError('pushToRingBuffer: maxSize must be >= 1');
  }

  // If the buffer is already at (or somehow over) capacity, slice to keep
  // only the newest `maxSize - 1` items, then append.
  const base =
    buffer.length >= maxSize
      ? buffer.slice(buffer.length - maxSize + 1)
      : [...buffer];

  base.push(entry);
  return base;
}
