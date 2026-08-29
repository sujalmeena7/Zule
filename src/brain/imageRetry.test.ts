// ============================================
// Zule AI — text-only retry on image rejection
// ============================================
//
// `activeAdapterSupportsImageInput()` reports the ADAPTER's capability, but a
// gateway fronts many models and most cheap/free ones are text-only. Those
// endpoints reject the entire request instead of ignoring the attachment, so a
// screen question that OCR could have answered became a hard failure.
//
// Guarantee under test: when the first attempt fails because the model cannot
// take images, the request is retried once WITHOUT images, and the retry's
// prompt still carries the screen OCR text.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module registers adapters on import and reads IndexedDB via `database`,
// so both collaborators are stubbed before importing it.
const streamMock = vi.fn();

vi.mock('./providerRouter', () => {
  class VaultLockedError extends Error {}
  class OfflineError extends Error {}
  class NoVisionProviderError extends Error {}
  return {
    VaultLockedError,
    OfflineError,
    NoVisionProviderError,
    AI_Provider_Router: class {
      stream = streamMock;
      complete = vi.fn();
      registerAdapter = vi.fn();
      unregisterAdapter = vi.fn();
      setPriority = vi.fn();
      setVaultLocked = vi.fn();
      setOffline = vi.fn();
      getActiveAdapterCapabilities = vi.fn(() => ({ imageInput: true }));
      hasImageCapableAdapter = vi.fn(() => true);
    },
  };
});

vi.mock('../data/database', () => ({
  database: { getSetting: vi.fn(async (_k: string, d: unknown) => d) },
}));

vi.mock('../utils/secureKeyStorage', () => ({
  decryptApiKey: vi.fn(async (c: string) => c),
}));

vi.mock('./providers/simulation', () => ({
  SimulationAdapter: class {
    name = 'simulation';
    capabilities = { streaming: true };
    countTokens = () => 0;
    complete = vi.fn();
    streamGenerate = vi.fn(async (_p: unknown, cb: { onComplete: (r: unknown) => void }) => {
      cb.onComplete({
        text: 'simulated',
        promptTokens: 0,
        completionTokens: 0,
        modelId: 'sim',
        providerId: 'simulation',
        isSimulated: true,
        status: 200,
      });
    });
  },
}));

const { streamAIResponse } = await import('./aiProvider');
// Resolved from the mock above, so `instanceof` compares against the same class
// `aiProvider` closed over.
const { NoVisionProviderError } = await import('./providerRouter');

/** Minimal ContextWindow carrying an attached keyframe plus OCR text. */
function contextWithImage() {
  return {
    systemPrompt: 'sys',
    userQuery: 'what is on my screen',
    fullPrompt: 'sys\n[SCREEN]\nQUESTION 02: Which data structure implements recursion?',
    images: [{ mimeType: 'image/jpeg', base64: 'AAAA' }],
  } as never;
}

function makeCallbacks() {
  return {
    onToken: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    onProviderFallback: vi.fn(),
  };
}

describe('streamAIResponse — image-rejection retry', () => {
  beforeEach(() => {
    streamMock.mockReset();
  });

  it('retries text-only when the model rejects image input, and succeeds', async () => {
    // Attempt 1 fails the way OpenRouter does for a text-only model.
    streamMock.mockRejectedValueOnce(
      new Error(
        'OpenAICompatibleAdapter[custom]: HTTP 404 — {"error":{"message":"No endpoints found that support image input"}}',
      ),
    );
    // Attempt 2 (text-only) succeeds.
    streamMock.mockImplementationOnce(async (_p: unknown, cb: { onComplete: (r: unknown) => void }) => {
      cb.onComplete({
        text: 'A stack.',
        promptTokens: 10,
        completionTokens: 3,
        modelId: 'free-model',
        providerId: 'custom',
        isSimulated: false,
        status: 200,
      });
    });

    const cb = makeCallbacks();
    await streamAIResponse(contextWithImage(), cb);

    expect(streamMock).toHaveBeenCalledTimes(2);

    // First attempt carried the image; the retry must not.
    const firstPrompt = streamMock.mock.calls[0][0] as { images?: unknown[] };
    const retryPrompt = streamMock.mock.calls[1][0] as { images?: unknown[]; fullPrompt: string };
    expect(firstPrompt.images).toHaveLength(1);
    expect(retryPrompt.images).toBeUndefined();

    // The screen's OCR text survives, so the answer is still grounded.
    expect(retryPrompt.fullPrompt).toContain('QUESTION 02');

    // A real answer was delivered — no simulation, no error toast.
    expect(cb.onComplete).toHaveBeenCalledTimes(1);
    expect((cb.onComplete.mock.calls[0][0] as { isSimulated: boolean }).isSimulated).toBe(false);
    expect(cb.onProviderFallback).not.toHaveBeenCalled();
  });

  it('does not retry when the failure is unrelated to images', async () => {
    streamMock.mockRejectedValue(
      new Error('AnthropicAdapter: HTTP 503 — {"error":{"message":"Gateway is offline"}}'),
    );

    const cb = makeCallbacks();
    await streamAIResponse(contextWithImage(), cb);

    // One attempt only, then the simulation fallback reports the real reason.
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(cb.onProviderFallback).toHaveBeenCalledTimes(1);
  });

  it('does not retry when there was no image to drop', async () => {
    streamMock.mockRejectedValue(new Error('HTTP 404 No endpoints found that support image input'));

    const cb = makeCallbacks();
    await streamAIResponse(
      { systemPrompt: 's', userQuery: 'q', fullPrompt: 'q' } as never,
      cb,
    );

    expect(streamMock).toHaveBeenCalledTimes(1);
  });

  it('propagates an abort from the text-only retry instead of simulating', async () => {
    streamMock.mockRejectedValueOnce(new Error('HTTP 404 does not support image input'));
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    streamMock.mockRejectedValueOnce(abort);

    const cb = makeCallbacks();
    await expect(streamAIResponse(contextWithImage(), cb)).rejects.toThrow(/aborted/);
    expect(cb.onProviderFallback).not.toHaveBeenCalled();
  });

  // The screen fast path sends pixels and keeps no OCR text, so dropping the
  // image leaves a prompt with no question in it. A text-only retry there does
  // not degrade the answer, it manufactures a confident non-answer ("no
  // conversation context was included") that looks like the model's opinion.
  it('does not retry text-only when the image was the only grounding', async () => {
    streamMock.mockRejectedValue(
      new Error('HTTP 404 — No endpoints found that support image input'),
    );

    const cb = makeCallbacks();
    await expect(
      streamAIResponse(
        {
          systemPrompt: 'sys',
          userQuery: 'Answer the question on my screen',
          fullPrompt: 'sys',
          images: [{ mimeType: 'image/jpeg', base64: 'AAAA' }],
        } as never,
        cb,
        undefined,
        undefined,
        { requireImageInput: true },
      ),
    ).rejects.toBeInstanceOf(NoVisionProviderError);

    expect(streamMock).toHaveBeenCalledTimes(1);
    // No simulated placeholder — the caller has to hear the real cause so it can
    // fall back to reading the screen as text.
    expect(cb.onProviderFallback).not.toHaveBeenCalled();
    expect(cb.onComplete).not.toHaveBeenCalled();
  });

  it('forwards requireImageInput to the router', async () => {
    streamMock.mockImplementationOnce(async (_p: unknown, cb2: { onComplete: (r: unknown) => void }) => {
      cb2.onComplete({
        text: 'ok',
        promptTokens: 1,
        completionTokens: 1,
        modelId: 'm',
        providerId: 'gemini',
        isSimulated: false,
        status: 200,
      });
    });

    await streamAIResponse(contextWithImage(), makeCallbacks(), undefined, undefined, {
      requireImageInput: true,
    });

    const opts = streamMock.mock.calls[0][2] as { requireImageInput?: boolean };
    expect(opts.requireImageInput).toBe(true);
  });
});
