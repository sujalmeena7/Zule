import type { HostStrategy } from './hostWindow';

/** Runtime evidence required before a non-Layer-0 window topology may run. */
export interface StealthHostGateEvidence {
  stageAAllCriteriaPassed: boolean;
  stageAFailureDocumented: boolean;
  stageBEntryExplicitlyApproved: boolean;
  stageBAllCriteriaPassed: boolean;
}

/**
 * Real-Windows testing found Stage A failures in interaction (A5) and geometry
 * (A6). Stage B has not been explicitly approved or validated, so production
 * must fail closed to the fully interactive Layer 0 BrowserWindow.
 */
export const CURRENT_STEALTH_HOST_GATE: Readonly<StealthHostGateEvidence> = Object.freeze({
  stageAAllCriteriaPassed: false,
  stageAFailureDocumented: true,
  stageBEntryExplicitlyApproved: false,
  stageBAllCriteriaPassed: false,
});

/** Select only a topology whose complete design gate has passed. */
export function selectStealthHostStrategy(
  evidence: StealthHostGateEvidence,
): HostStrategy {
  if (evidence.stageAAllCriteriaPassed) {
    return 'reparent';
  }

  if (
    evidence.stageAFailureDocumented &&
    evidence.stageBEntryExplicitlyApproved &&
    evidence.stageBAllCriteriaPassed
  ) {
    return 'layered';
  }

  return 'none';
}
