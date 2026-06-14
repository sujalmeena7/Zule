// Unit tests for the PendingTaskTracker (Requirement 10.7 — no orphan async).
//
// The tracker is intentionally tiny: a Set<Promise> with `add` / `size` /
// `waitAll`. These tests pin down the contract the rest of the codebase
// depends on:
//   1. `add` returns the same promise it received (so callers can chain).
//   2. The tracker's `size` reflects in-flight tasks and drops to zero
//      after a task settles (resolve OR reject).
//   3. `waitAll` resolves only after every currently-tracked task has
//      settled, even if some reject.
//   4. Rejections are NOT swallowed — the original promise still rejects
//      so `.catch(notifyError)` callers see the error.

import { afterEach, describe, expect, it } from 'vitest';
import { pendingTaskTracker } from './pendingTaskTracker';

describe('pendingTaskTracker', () => {
  afterEach(() => {
    pendingTaskTracker._resetForTest();
  });

  it('returns the same promise from add()', async () => {
    const original = Promise.resolve(42);
    const tracked = pendingTaskTracker.add(original);
    expect(tracked).toBe(original);
    await expect(tracked).resolves.toBe(42);
  });

  it('reports size while tasks are in flight and drops to zero on settle', async () => {
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });

    pendingTaskTracker.add(inFlight);
    expect(pendingTaskTracker.size()).toBe(1);

    release();
    await inFlight;
    // Allow the finalizer microtask to run so the Set is updated.
    await Promise.resolve();
    expect(pendingTaskTracker.size()).toBe(0);
  });

  it('waitAll resolves once every tracked task settles, including rejections', async () => {
    const ok = Promise.resolve('done');
    // Attach a catch on the original so the rejection isn't unhandled in
    // the test runner; the tracker should still see it as settled.
    const failing = Promise.reject(new Error('boom'));
    failing.catch(() => {});

    pendingTaskTracker.add(ok);
    pendingTaskTracker.add(failing);

    await pendingTaskTracker.waitAll();
    // Allow finalizers to run and remove themselves from the Set.
    await Promise.resolve();
    expect(pendingTaskTracker.size()).toBe(0);
  });

  it('does not swallow rejections — callers still see the original error', async () => {
    const failing = Promise.reject(new Error('still rejects'));
    const tracked = pendingTaskTracker.add(failing);
    await expect(tracked).rejects.toThrow('still rejects');
  });

  it('waitAll on an empty tracker resolves immediately', async () => {
    await expect(pendingTaskTracker.waitAll()).resolves.toBeUndefined();
  });
});
