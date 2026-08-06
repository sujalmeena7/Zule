// ============================================
// Zule AI — describeProviderFailure unit tests
// ============================================
//
// The copilot shows this string verbatim in a toast when every provider fails
// and simulation takes over. Two things matter: it must name the real cause
// (not "add your API key"), and it must never echo a credential.

import { describe, it, expect } from 'vitest';
import { describeProviderFailure } from './aiProvider';

describe('describeProviderFailure', () => {
  it('surfaces a disabled-model 503 with the provider detail', () => {
    // The exact shape lumosel.vip returned during live debugging.
    const err = new Error(
      'AnthropicAdapter: HTTP 503  — {"error":"claude-sonnet-4-5-20250929 is temporarily disabled"}',
    );
    const message = describeProviderFailure(err);

    expect(message).toContain('provider is unavailable');
    expect(message).toContain('claude-sonnet-4-5-20250929 is temporarily disabled');
  });

  it('surfaces a gateway-offline 503 from the nested Anthropic error shape', () => {
    // Anthropic-format gateways nest the reason under `error.message`, which is
    // a different shape from the flat `error` string above. Both must resolve.
    const err = new Error(
      'AnthropicAdapter: HTTP 503  — {"type":"error","error":{"type":"overloaded_error","message":"Gateway is offline"}}',
    );
    const message = describeProviderFailure(err);

    expect(message).toContain('provider is unavailable');
    expect(message).toContain('Gateway is offline');
  });

  it('maps a 404 to the base-url / model-id hint', () => {
    const err = new Error('OpenAICompatibleAdapter[custom]: HTTP 404 Not Found');
    expect(describeProviderFailure(err)).toContain('check the Base URL and Model ID');
  });

  it('maps a 402 to an out-of-credit reason and keeps the provider detail', () => {
    const err = new Error(
      'OpenAICompatibleAdapter[custom]: HTTP 402  — {"error":{"message":"This request requires more credits"}}',
    );
    const message = describeProviderFailure(err);

    expect(message).toContain('out of credit');
    expect(message).toContain('This request requires more credits');
  });

  it('falls back to the bare status when the body is not JSON', () => {
    const err = new Error('SomeAdapter: HTTP 418 I am a teapot');
    expect(describeProviderFailure(err)).toBe('the provider returned HTTP 418');
  });

  it('handles an error with no status at all', () => {
    expect(describeProviderFailure(new Error('network down'))).toBe(
      'the provider request failed',
    );
  });

  it('handles non-Error throwables without throwing', () => {
    expect(() => describeProviderFailure('oops')).not.toThrow();
    expect(() => describeProviderFailure(null)).not.toThrow();
    expect(() => describeProviderFailure(undefined)).not.toThrow();
  });

  it('truncates a very long provider detail so a key echoed in the body cannot run on', () => {
    const err = new Error(
      `Adapter: HTTP 400  — {"error":{"message":"${'x'.repeat(500)}"}}`,
    );
    const message = describeProviderFailure(err);
    expect(message.length).toBeLessThan(230);
  });
});
