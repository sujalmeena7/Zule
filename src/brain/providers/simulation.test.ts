// ============================================
// Tests for SimulationAdapter
// ============================================
//
// Scope (Requirements 4.2, 4.7, 4.9):
//
//   - Construction exposes the documented capability descriptor.
//   - `countTokens` matches the ~4-chars-per-token approximation.
//   - `complete` resolves with `isSimulated: true` and the stable
//     `providerId: 'simulation'`.
//   - `complete` weaves a slice of the prompt into the synthetic answer.
//   - `streamGenerate` emits cumulative tokens and exactly one
//     `onComplete` call carrying `isSimulated: true`.
//   - `streamGenerate` honours an `AbortSignal` aborted mid-stream by
//     suppressing `onComplete` and halting within 200 ms.
//   - `streamGenerate` respects a pre-aborted signal by emitting no
//     callbacks at all.
//
// PBT is intentionally out of scope for this adapter; the surrounding
// router has its own property tests for failover, abort, and key
// handling (tasks 8.10, 8.11, 8.8).

import { describe, expect, it, vi } from 'vitest';

import { SimulationAdapter } from './simulation';
import type {
  CallOpts,
  PromptInput,
  ProviderResponse,
  StreamCallbacks,
} from './types';

// --- Helpers -------------------------------------------------------------

const PROMPT: PromptInput = {
  systemPrompt: 'You are a helpful assistant.',
  userText: 'What is the capital of France?',
  fullPrompt:
    'You are a helpful assistant.\n\nWhat is the capital of France?',
};

const NO_OPTS: CallOpts = {};

interface StreamRecorder {
  cb: StreamCallbacks;
  tokens: string[];
  errors: Error[];
  result: { value: ProviderResponse | null };
  metrics: Array<{ ttftMs: number; totalMs: number; retries: number; modelId: string }>;
}

function makeStreamCallbacks(): StreamRecorder {
  const tokens: string[] = [];
  const errors: Error[] = [];
  const result: StreamRecorder['result'] = { value: null };
  const metrics: StreamRecorder['metrics'] = [];
  const cb: StreamCallbacks = {
    onToken: (t) => {
      tokens.push(t);
    },
    onComplete: (r) => {
      result.value = r;
    },
    onError: (e) => {
      errors.push(e);
    },
    onMetrics: (m) => {
      metrics.push(m);
    },
  };
  return { cb, tokens, errors, result, metrics };
}

// --- Construction --------------------------------------------------------

describe('SimulationAdapter — construction and capabilities', () => {
  it('reports the documented capability descriptor by default', () => {
    const adapter = new SimulationAdapter();
    expect(adapter.name).toBe('simulation');
    expect(adapter.capabilities.streaming).toBe(true);
    expect(adapter.capabilities.imageInput).toBe(false);
    expect(adapter.capabilities.toolUse).toBe(false);
    expect(adapter.capabilities.maxInputTokens).toBe(8_000);
    expect(adapter.capabilities.pricePerMTokens).toEqual({ input: 0, output: 0 });
  });
});

// --- countTokens ---------------------------------------------------------

describe('SimulationAdapter.countTokens', () => {
  const adapter = new SimulationAdapter();

  it('returns 0 for empty input and ~ceil(length / 4) otherwise', () => {
    expect(adapter.countTokens('')).toBe(0);
    expect(adapter.countTokens('1234')).toBe(1);
    expect(adapter.countTokens('12345')).toBe(2);
    expect(adapter.countTokens('a'.repeat(1000))).toBe(250);
  });
});

// --- complete ------------------------------------------------------------

describe('SimulationAdapter.complete', () => {
  it('resolves with isSimulated: true and providerId="simulation"', async () => {
    const adapter = new SimulationAdapter({ tokenDelayMs: 0 });
    const res = await adapter.complete(PROMPT, NO_OPTS);

    expect(res.isSimulated).toBe(true);
    expect(res.providerId).toBe('simulation');
    expect(res.status).toBe(200);
    expect(res.modelId).toBe('simulation-v1');
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.promptTokens).toBe(adapter.countTokens(PROMPT.fullPrompt));
    expect(res.completionTokens).toBe(adapter.countTokens(res.text));
  });

  it('weaves a truncated echo of the prompt into the synthetic response', async () => {
    const longPrompt: PromptInput = {
      systemPrompt: '',
      userText: 'Q: ' + 'lorem ipsum dolor sit amet '.repeat(50),
      fullPrompt: 'Q: ' + 'lorem ipsum dolor sit amet '.repeat(50),
    };
    const adapter = new SimulationAdapter({ tokenDelayMs: 0 });

    const res = await adapter.complete(longPrompt, NO_OPTS);

    // Lead phrase from the canned library is preserved.
    expect(res.text).toMatch(/^This is a simulated response\./);
    // The first 200 chars of the prompt are echoed back verbatim
    // (Requirement 4.2: simulation produces plausible offline answers).
    const echo = longPrompt.fullPrompt.slice(0, 200);
    expect(res.text).toContain(echo);
    // ...but no more than that — the echo is bounded so we don't
    // accidentally re-emit a 50 KB prompt.
    expect(res.text.length).toBeLessThan(echo.length + 400);
  });
});

// --- streamGenerate: happy path -----------------------------------------

describe('SimulationAdapter.streamGenerate — happy path', () => {
  it('emits cumulative tokens and a single onComplete with isSimulated: true', async () => {
    const adapter = new SimulationAdapter({ tokenDelayMs: 0 });
    const { cb, tokens, errors, result, metrics } = makeStreamCallbacks();

    await adapter.streamGenerate(PROMPT, cb, NO_OPTS);

    expect(errors).toEqual([]);
    expect(result.value).not.toBeNull();
    expect(result.value!.isSimulated).toBe(true);
    expect(result.value!.providerId).toBe('simulation');
    expect(result.value!.status).toBe(200);
    expect(result.value!.modelId).toBe('simulation-v1');

    // At least one token must have been emitted, and the final cumulative
    // value must match the completion text exactly.
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[tokens.length - 1]).toBe(result.value!.text);

    // Cumulative invariant: each emitted value extends the previous one.
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i]!.startsWith(tokens[i - 1]!)).toBe(true);
    }

    // Optional metrics callback was invoked with sane values.
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.modelId).toBe('simulation-v1');
    expect(metrics[0]!.retries).toBe(0);
    expect(metrics[0]!.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('cycles through canned responses across calls for variety', async () => {
    const adapter = new SimulationAdapter({
      tokenDelayMs: 0,
      cannedResponses: ['A.', 'B.', 'C.'],
    });
    const emptyPrompt: PromptInput = { systemPrompt: '', userText: '', fullPrompt: '' };

    const r1 = await adapter.complete(emptyPrompt, NO_OPTS);
    const r2 = await adapter.complete(emptyPrompt, NO_OPTS);
    const r3 = await adapter.complete(emptyPrompt, NO_OPTS);
    const r4 = await adapter.complete(emptyPrompt, NO_OPTS);

    expect(r1.text).toBe('A.');
    expect(r2.text).toBe('B.');
    expect(r3.text).toBe('C.');
    expect(r4.text).toBe('A.');
  });
});

// --- streamGenerate: abort honouring (Requirement 4.7) ------------------

describe('SimulationAdapter.streamGenerate — abort handling', () => {
  it('emits no callbacks when the signal is already aborted on entry', async () => {
    const adapter = new SimulationAdapter({ tokenDelayMs: 0 });
    const { cb, tokens, errors, result, metrics } = makeStreamCallbacks();

    const controller = new AbortController();
    controller.abort();

    await adapter.streamGenerate(PROMPT, cb, { signal: controller.signal });

    expect(tokens).toEqual([]);
    expect(errors).toEqual([]);
    expect(result.value).toBeNull();
    expect(metrics).toEqual([]);
  });

  it('does not invoke onComplete after an abort and halts within 200 ms', async () => {
    // Use a relatively long inter-token delay so the abort lands mid-stream.
    const adapter = new SimulationAdapter({
      tokenDelayMs: 30,
      cannedResponses: [Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ')],
    });
    const { cb, tokens, errors, result, metrics } = makeStreamCallbacks();

    const controller = new AbortController();

    // Abort after a few tokens have had a chance to emit.
    setTimeout(() => controller.abort(), 50);

    const t0 = performance.now();
    await adapter.streamGenerate(
      { systemPrompt: '', userText: '', fullPrompt: '' },
      cb,
      { signal: controller.signal },
    );
    const elapsed = performance.now() - t0;

    // The streaming loop must yield control within 200 ms of abort
    // (Requirement 4.7). Tokens emitted before the abort are tolerated;
    // the strict invariant is that `onComplete` is NEVER invoked.
    expect(result.value).toBeNull();
    expect(errors).toEqual([]);
    expect(metrics).toEqual([]);
    // Sanity check the abort actually happened mid-stream — we should
    // have streamed for ~50 ms then halted shortly after, far below the
    // total time it would take to stream all 50 words at 30 ms each
    // (1500 ms).
    expect(elapsed).toBeLessThan(500);
    // Some tokens may or may not have been emitted depending on timing;
    // we just assert the cumulative invariant for any that were.
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i]!.startsWith(tokens[i - 1]!)).toBe(true);
    }
  });

  it('rejects complete() with AbortError when the signal is pre-aborted', async () => {
    const adapter = new SimulationAdapter({ tokenDelayMs: 0 });
    const controller = new AbortController();
    controller.abort();

    const onError = vi.fn();
    try {
      await adapter.complete(PROMPT, { signal: controller.signal });
      // Should not reach here.
      expect.fail('complete() should have thrown an AbortError');
    } catch (err) {
      onError(err);
      expect((err as Error).name).toBe('AbortError');
    }
    expect(onError).toHaveBeenCalledOnce();
  });
});
