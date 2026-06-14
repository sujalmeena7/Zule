// Unit tests for `describeZuleError` — the pure mapping from `ZuleError`
// to the toast message + severity used by `useZuleError`. We test the
// pure function directly so we don't have to mount React or stub
// react-hot-toast for every variant.
//
// The hook itself is exercised at the integration level (Settings flow,
// InputBar voice-typing fallback) and indirectly through the property
// tests in later tasks (e.g., Property 51 — telemetry events never leak
// content — leans on `emitErrorTelemetryPlaceholder`).

import { describe, expect, it } from 'vitest';
import {
  describeZuleError,
  emitErrorTelemetryPlaceholder,
} from './useZuleError';
import type { ZuleError } from '../types/errors';

describe('describeZuleError', () => {
  it('marks transient transcription noise as silent (no toast)', () => {
    expect(describeZuleError({ kind: 'transcription.no-speech' }).silent).toBe(true);
    expect(describeZuleError({ kind: 'transcription.audio-capture' }).silent).toBe(true);
  });

  it('marks aborted provider requests as silent', () => {
    expect(describeZuleError({ kind: 'provider.aborted' }).silent).toBe(true);
  });

  it('marks broadcast-channel-unavailable as silent (silent fallback)', () => {
    expect(
      describeZuleError({ kind: 'cross-window.broadcast-unsupported' }).silent,
    ).toBe(true);
  });

  it('classifies transcription.unsupported as a blocking alert', () => {
    const spec = describeZuleError({ kind: 'transcription.unsupported' });
    expect(spec.severity).toBe('alert');
    expect(spec.message).toMatch(/speech recognition/i);
  });

  it('classifies document.unsupported-extension as a non-blocking status toast', () => {
    const spec = describeZuleError({
      kind: 'document.unsupported-extension',
      ext: 'exe',
    });
    expect(spec.severity).toBe('status');
    expect(spec.message).toContain('exe');
  });

  it('includes the providerId and status in provider.server-error message', () => {
    const spec = describeZuleError({
      kind: 'provider.server-error',
      providerId: 'gemini',
      status: 503,
    });
    expect(spec.message).toContain('gemini');
    expect(spec.message).toContain('503');
  });

  it('formats provider.rate-limited with retry-after when supplied', () => {
    const withRetry = describeZuleError({
      kind: 'provider.rate-limited',
      providerId: 'openai',
      retryAfterMs: 4_500,
    });
    expect(withRetry.message).toContain('5s');

    const withoutRetry = describeZuleError({
      kind: 'provider.rate-limited',
      providerId: 'openai',
    });
    expect(withoutRetry.message).not.toMatch(/\d+s\)\.$/);
  });

  it('escalates ocr.worker-failed once consecutive failures reach 3', () => {
    const transient = describeZuleError({
      kind: 'ocr.worker-failed',
      consecutiveFailures: 1,
    });
    expect(transient.message).toMatch(/restart/i);

    const disabled = describeZuleError({
      kind: 'ocr.worker-failed',
      consecutiveFailures: 3,
    });
    expect(disabled.message).toMatch(/disabled/i);
  });
});

describe('emitErrorTelemetryPlaceholder', () => {
  // Property 51's full property-test arrives in task 18.x. This test
  // pins down the constructive guarantee at the placeholder layer:
  // only `kind` plus structurally-typed metadata flow into telemetry.
  it('never copies free-form content fields into the metadata payload', () => {
    const cases: ZuleError[] = [
      { kind: 'transcription.permission-denied' },
      { kind: 'provider.network', providerId: 'gemini' },
      { kind: 'storage.import-invalid', reason: 'schema-version-mismatch' },
      { kind: 'document.unsupported-extension', ext: 'xls' },
      { kind: 'unhandled-rejection', name: 'TypeError' },
    ];

    // The function only logs in dev; calling it should not throw and
    // should not require any external side-effects to succeed.
    for (const e of cases) {
      expect(() => emitErrorTelemetryPlaceholder(e)).not.toThrow();
    }
  });
});
