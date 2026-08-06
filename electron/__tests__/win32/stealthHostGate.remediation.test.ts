import { describe, expect, it } from 'vitest';
import {
  CURRENT_STEALTH_HOST_GATE,
  selectStealthHostStrategy,
} from '../../win32/stealthHostGate';

describe('stealth host real-Windows remediation gate', () => {
  it('fails closed to Layer 0 after the observed Stage A A5/A6 failure', () => {
    expect(selectStealthHostStrategy(CURRENT_STEALTH_HOST_GATE)).toBe('none');
  });

  it('does not enable Stage B from a written Stage A failure alone', () => {
    expect(selectStealthHostStrategy({
      stageAAllCriteriaPassed: false,
      stageAFailureDocumented: true,
      stageBEntryExplicitlyApproved: false,
      stageBAllCriteriaPassed: true,
    })).toBe('none');
  });

  it('requires explicit approval and a complete Stage B gate before layered mode', () => {
    expect(selectStealthHostStrategy({
      stageAAllCriteriaPassed: false,
      stageAFailureDocumented: true,
      stageBEntryExplicitlyApproved: true,
      stageBAllCriteriaPassed: true,
    })).toBe('layered');
  });

  it('allows reparenting only after every Stage A criterion passes', () => {
    expect(selectStealthHostStrategy({
      stageAAllCriteriaPassed: true,
      stageAFailureDocumented: false,
      stageBEntryExplicitlyApproved: false,
      stageBAllCriteriaPassed: false,
    })).toBe('reparent');
  });
});
