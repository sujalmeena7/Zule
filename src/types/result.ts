// ============================================
// Zule AI — Result helper
// ============================================
//
// A small Either-style discriminated union used by domain modules to surface
// recoverable failures as typed values rather than thrown exceptions
// (see design.md §Error Handling, "Error transport").
//
// Domain-layer functions return `Result<T, ZuleError>`. The orchestration
// layer (e.g. `useZuleError`) maps `{ ok: false }` results into toasts and
// telemetry events in one place.

export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/** Construct a successful `Result`. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Construct a failed `Result`. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Type guard: narrows a `Result` to its successful branch. */
export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

/** Type guard: narrows a `Result` to its failed branch. */
export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}
