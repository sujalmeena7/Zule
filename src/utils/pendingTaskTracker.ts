// ============================================
// Zule AI — PendingTaskTracker
// ============================================
//
// A tiny top-level promise registry used to keep background async work
// (e.g. memory-fact saves on session stop) alive past component unmount,
// so that fire-and-forget Promises do not become orphan tasks
// (see design.md §Error Handling, "Defensive boundaries"; Requirement 10.7).
//
// Compared to `setTimeout(..., 0)`:
// - tasks remain reachable for inspection / awaiting (`size`, `waitAll`)
// - rejections are still observable to callers (we attach a finalizer, but
//   we do NOT swallow the underlying promise — callers are expected to
//   `.catch(notifyError)` on the value they pass in).

class PendingTaskTracker {
  private readonly tasks: Set<Promise<unknown>> = new Set();

  /**
   * Register a promise so it is held alive even if the originating component
   * unmounts. Returns the same promise so callers can chain `.then` / `.catch`
   * — typically `.catch(notifyError)` from `useZuleError`.
   */
  add<T>(promise: Promise<T>): Promise<T> {
    this.tasks.add(promise);
    // Use `.then(cleanup, cleanup)` rather than `.finally` so that the
    // chained promise produced here resolves regardless of whether
    // `promise` rejects — otherwise the discarded `.finally` chain
    // becomes its own unhandled rejection. The caller still receives
    // the original `promise`, so their `.catch(notifyError)` chain
    // observes failures normally.
    const cleanup = () => {
      this.tasks.delete(promise);
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }

  /** Number of currently outstanding tasks. */
  size(): number {
    return this.tasks.size;
  }

  /**
   * Resolves once every currently-tracked task has settled (resolved OR
   * rejected). Useful from page-unload handlers and tests.
   */
  async waitAll(): Promise<void> {
    if (this.tasks.size === 0) return;
    await Promise.allSettled(Array.from(this.tasks));
  }

  /** Test-only helper to drop any retained references. */
  _resetForTest(): void {
    this.tasks.clear();
  }
}

/**
 * Module-level singleton. The tracker has no per-component state, so a
 * shared instance is the correct shape — components and orchestration code
 * register their own background work against it.
 */
export const pendingTaskTracker = new PendingTaskTracker();

export type { PendingTaskTracker };
