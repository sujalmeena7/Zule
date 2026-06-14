// ============================================
// Zule AI — OcrWatchdog unit tests
// ============================================
//
// Tests for the OCR worker watchdog that supervises the Tesseract
// worker lifecycle (Requirement 20.3):
//   - 3 consecutive errors within 30s → recreate worker
//   - Subsequent error after recreate → disable OCR for the session
//   - Success clears the error window
//   - reset() returns to active state

import { describe, expect, it } from 'vitest';
import { OcrWatchdog } from './ocrWorker';

describe('OcrWatchdog', () => {
  it('starts in active state with zero failures', () => {
    const wd = new OcrWatchdog();
    expect(wd.state).toBe('active');
    expect(wd.consecutiveFailures).toBe(0);
  });

  it('remains active after fewer than 3 errors within 30s', () => {
    const wd = new OcrWatchdog({ now: () => 0 });
    const r1 = wd.recordError(1000);
    expect(r1.state).toBe('active');
    expect(r1.action).toBe('continue');

    const r2 = wd.recordError(2000);
    expect(r2.state).toBe('active');
    expect(r2.action).toBe('continue');

    expect(wd.state).toBe('active');
    expect(wd.consecutiveFailures).toBe(2);
  });

  it('transitions to recreated after 3 errors within 30s window', () => {
    const wd = new OcrWatchdog();
    wd.recordError(1000);
    wd.recordError(2000);
    const r3 = wd.recordError(3000);

    expect(r3.state).toBe('recreated');
    expect(r3.action).toBe('recreate');
    expect(wd.state).toBe('recreated');
  });

  it('disables OCR on the next error after a recreate', () => {
    const wd = new OcrWatchdog();
    // Trigger recreation
    wd.recordError(1000);
    wd.recordError(2000);
    wd.recordError(3000);
    expect(wd.state).toBe('recreated');

    // Next error disables
    const r4 = wd.recordError(5000);
    expect(r4.state).toBe('disabled');
    expect(r4.action).toBe('disable');
    expect(wd.state).toBe('disabled');
  });

  it('stays disabled once disabled, even on further errors', () => {
    const wd = new OcrWatchdog();
    wd.recordError(1000);
    wd.recordError(2000);
    wd.recordError(3000);
    wd.recordError(5000); // disable

    const r5 = wd.recordError(6000);
    expect(r5.state).toBe('disabled');
    expect(r5.action).toBe('disable');
  });

  it('does NOT trigger recreate when 3 errors span more than 30s', () => {
    const wd = new OcrWatchdog();
    wd.recordError(0);
    wd.recordError(15_000);
    // Third error is outside the 30s window from the first
    const r3 = wd.recordError(31_000);
    expect(r3.state).toBe('active');
    expect(r3.action).toBe('continue');
    // Only errors within the window are counted
    expect(wd.consecutiveFailures).toBe(2); // errors at 15k and 31k
  });

  it('recordSuccess clears the error window', () => {
    const wd = new OcrWatchdog();
    wd.recordError(1000);
    wd.recordError(2000);
    expect(wd.consecutiveFailures).toBe(2);

    wd.recordSuccess();
    expect(wd.consecutiveFailures).toBe(0);
    expect(wd.state).toBe('active');

    // Now need fresh 3 errors to trigger recreation
    wd.recordError(5000);
    wd.recordError(6000);
    expect(wd.state).toBe('active');
    const r3 = wd.recordError(7000);
    expect(r3.action).toBe('recreate');
  });

  it('reset() returns to active state from disabled', () => {
    const wd = new OcrWatchdog();
    // Get to disabled state
    wd.recordError(1000);
    wd.recordError(2000);
    wd.recordError(3000);
    wd.recordError(5000);
    expect(wd.state).toBe('disabled');

    wd.reset();
    expect(wd.state).toBe('active');
    expect(wd.consecutiveFailures).toBe(0);

    // Can go through the cycle again
    wd.recordError(10_000);
    wd.recordError(11_000);
    const r3 = wd.recordError(12_000);
    expect(r3.action).toBe('recreate');
  });

  it('reset() returns to active state from recreated', () => {
    const wd = new OcrWatchdog();
    wd.recordError(1000);
    wd.recordError(2000);
    wd.recordError(3000);
    expect(wd.state).toBe('recreated');

    wd.reset();
    expect(wd.state).toBe('active');
    expect(wd.consecutiveFailures).toBe(0);
  });

  it('respects custom maxErrors and windowMs options', () => {
    const wd = new OcrWatchdog({ maxErrors: 2, windowMs: 10_000 });
    wd.recordError(0);
    expect(wd.state).toBe('active');

    const r2 = wd.recordError(5000);
    expect(r2.action).toBe('recreate');
    expect(wd.state).toBe('recreated');
  });

  it('prunes old errors from the window (sliding window behavior)', () => {
    const wd = new OcrWatchdog({ windowMs: 30_000 });
    // Spread errors across time so they don't all fit in one window
    wd.recordError(0);
    wd.recordError(20_000);
    // Third error is 31s after the first; the first error falls out of the window
    const r3 = wd.recordError(31_000);
    expect(r3.state).toBe('active');
    expect(r3.action).toBe('continue');
    // Only 2 errors remain in the window (20k and 31k)
    expect(wd.consecutiveFailures).toBe(2);
  });
});
