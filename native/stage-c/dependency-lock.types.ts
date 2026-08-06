/**
 * Stage C Dependency Lock — Type definitions and validation.
 *
 * This module provides the typed interface for reading and validating
 * the native dependency lock. The lock must be machine-parseable and
 * is consumed by the toolchain probe (Task 16.2) and the runtime probe.
 *
 * Requirements: 3.1, 3.2, 3.5–3.12, 14.16
 */

// --------------------------------------------------------------------
// Types
// --------------------------------------------------------------------

export interface IntegrityRecord {
  algorithm: 'sha256';
  digest: string;
}

export type ReviewStatus = 'approved' | 'pending' | 'rejected';

export interface LockedToolchainItem {
  description: string;
  version: string;
  componentIds: string[];
  source: string;
  integrity: IntegrityRecord;
  license: string;
  architecture: string;
  reviewStatus: ReviewStatus;
  transitiveDependencies: string[];
}

export interface LockedDependencyItem {
  description: string;
  version: string;
  packageId: string;
  provisionedRoot: string;
  source: string;
  integrity: IntegrityRecord;
  license: string;
  architecture: string;
  reviewStatus: ReviewStatus;
  includes: Record<string, string>;
  transitiveDependencies: string[];
}

export interface TransitiveDependencyItem {
  description: string;
  version: string;
  source: string;
  integrity: IntegrityRecord;
  license: string;
  architecture: string;
  reviewStatus: ReviewStatus;
}

export interface LockedRuntimeImage {
  osBuild: 'win10_22h2' | 'win11_23h2' | 'win11_24h2';
  runnerLabel: string;
  imageDigest: string;
  collectorManifestDigest: string;
  integrity: IntegrityRecord;
  reviewStatus: ReviewStatus;
  webView2Runtimes: Array<{
    version: string;
    path: string;
    integrity: IntegrityRecord;
    reviewStatus: ReviewStatus;
  }>;
}

export interface CiEnvironment {
  description: string;
  imageReference: string;
  imageDigest: string;
  source: string;
  integrity: IntegrityRecord;
  reviewStatus: ReviewStatus;
  installedComponents: string[];
  snapshots: LockedRuntimeImage[];
}

export interface LockPolicy {
  allowFloatingRanges: false;
  allowUnlistedDependencies: false;
  allowAutoDownload: false;
  allowAlternateCompilers: false;
  requireReviewBeforeUpdate: true;
  requiredReviewChecks: string[];
}

export interface DependencyLock {
  lockVersion: number;
  generatedAt: string;
  architecture: string;
  reviewedBy: string | null;
  reviewDate: string | null;
  notes: string;
  toolchain: {
    msvc: LockedToolchainItem;
    msbuild: LockedToolchainItem;
    windowsSdk: LockedToolchainItem;
  };
  dependencies: {
    webview2Sdk: LockedDependencyItem;
  };
  transitiveDependencies: Record<string, TransitiveDependencyItem>;
  ciEnvironment: CiEnvironment;
  policy: LockPolicy;
}

// --------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------

export interface LockValidationError {
  path: string;
  message: string;
}

/**
 * Floating version pattern — rejects ^, ~, >=, <=, >, <, *, x, latest, etc.
 * Only exact versions (digits, dots, dashes, and alphanumeric pre-release) pass.
 */
const FLOATING_RANGE_PATTERN = /[~^*x]|>=|<=|>(?!=)|<(?!=)|\blatest\b/i;

/**
 * Validates that a version string is exact (no floating ranges).
 * Requirement 3.9: reject floating ranges before compilation.
 */
export function isExactVersion(version: string): boolean {
  if (!version || version.trim().length === 0) return false;
  return !FLOATING_RANGE_PATTERN.test(version);
}

/**
 * Validates the structural integrity of the dependency lock.
 * Returns an array of errors; empty array means valid.
 *
 * This does NOT verify that tools are actually installed — that is
 * the toolchain probe's job (Task 16.2).
 */
export function validateLockStructure(lock: unknown): LockValidationError[] {
  const errors: LockValidationError[] = [];

  if (lock === null || typeof lock !== 'object') {
    errors.push({ path: '', message: 'Lock must be a non-null object' });
    return errors;
  }

  const obj = lock as Record<string, unknown>;

  // Lock version
  if (typeof obj.lockVersion !== 'number' || obj.lockVersion < 1) {
    errors.push({ path: 'lockVersion', message: 'Must be a positive integer' });
  }

  // Architecture
  if (typeof obj.architecture !== 'string' || !['x64', 'arm64'].includes(obj.architecture)) {
    errors.push({ path: 'architecture', message: 'Must be "x64" or "arm64"' });
  }

  // Policy enforcement
  const policy = obj.policy as Record<string, unknown> | undefined;
  if (!policy || typeof policy !== 'object') {
    errors.push({ path: 'policy', message: 'Policy section is required' });
  } else {
    if (policy.allowFloatingRanges !== false) {
      errors.push({ path: 'policy.allowFloatingRanges', message: 'Must be false' });
    }
    if (policy.allowUnlistedDependencies !== false) {
      errors.push({ path: 'policy.allowUnlistedDependencies', message: 'Must be false' });
    }
    if (policy.allowAutoDownload !== false) {
      errors.push({ path: 'policy.allowAutoDownload', message: 'Must be false' });
    }
    if (policy.allowAlternateCompilers !== false) {
      errors.push({ path: 'policy.allowAlternateCompilers', message: 'Must be false' });
    }
  }

  // Toolchain items
  const toolchain = obj.toolchain as Record<string, unknown> | undefined;
  if (!toolchain || typeof toolchain !== 'object') {
    errors.push({ path: 'toolchain', message: 'Toolchain section is required' });
  } else {
    for (const key of ['msvc', 'msbuild', 'windowsSdk']) {
      const item = toolchain[key];
      if (!item || typeof item !== 'object') {
        errors.push({ path: `toolchain.${key}`, message: 'Required toolchain item missing' });
      } else {
        validateLockedItem(`toolchain.${key}`, item as Record<string, unknown>, errors);
      }
    }
  }

  // Dependencies
  const deps = obj.dependencies as Record<string, unknown> | undefined;
  if (!deps || typeof deps !== 'object') {
    errors.push({ path: 'dependencies', message: 'Dependencies section is required' });
  } else {
    if (!deps.webview2Sdk || typeof deps.webview2Sdk !== 'object') {
      errors.push({ path: 'dependencies.webview2Sdk', message: 'WebView2 SDK entry is required' });
    } else {
      validateLockedItem('dependencies.webview2Sdk', deps.webview2Sdk as Record<string, unknown>, errors);
    }
  }

  // Transitive dependencies
  const transitive = obj.transitiveDependencies as Record<string, unknown> | undefined;
  if (!transitive || typeof transitive !== 'object') {
    errors.push({ path: 'transitiveDependencies', message: 'Transitive dependencies section is required' });
  } else {
    for (const [key, item] of Object.entries(transitive)) {
      if (!item || typeof item !== 'object') {
        errors.push({ path: `transitiveDependencies.${key}`, message: 'Must be an object' });
      } else {
        validateLockedItem(`transitiveDependencies.${key}`, item as Record<string, unknown>, errors);
      }
    }
  }

  // CI environment and immutable runner snapshots
  const ci = obj.ciEnvironment as Record<string, unknown> | undefined;
  if (!ci || typeof ci !== 'object') {
    errors.push({ path: 'ciEnvironment', message: 'CI environment section is required' });
  } else {
    if (typeof ci.imageDigest !== 'string' || ci.imageDigest.length === 0) {
      errors.push({ path: 'ciEnvironment.imageDigest', message: 'Image digest is required' });
    }
    if (typeof ci.reviewStatus !== 'string' || !['approved', 'pending', 'rejected'].includes(ci.reviewStatus as string)) {
      errors.push({ path: 'ciEnvironment.reviewStatus', message: 'Must be approved, pending, or rejected' });
    }
    if (!Array.isArray(ci.snapshots) || ci.snapshots.length !== 3) {
      errors.push({ path: 'ciEnvironment.snapshots', message: 'Exactly three immutable runner snapshots are required' });
    } else {
      for (const [index, snapshot] of ci.snapshots.entries()) {
        validateSnapshot(`ciEnvironment.snapshots.${index}`, snapshot, errors);
      }
    }
  }

  return errors;
}

function validateSnapshot(path: string, value: unknown, errors: LockValidationError[]): void {
  if (!value || typeof value !== 'object') {
    errors.push({ path, message: 'Snapshot must be an object' });
    return;
  }
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.runnerLabel !== 'string' || !/^stage-c-win(?:10|11)-[a-z0-9-]+-v\d+$/.test(snapshot.runnerLabel)) {
    errors.push({ path: `${path}.runnerLabel`, message: 'Versioned Stage C runner label is required' });
  }
  if (!Array.isArray(snapshot.webView2Runtimes) || snapshot.webView2Runtimes.length === 0) {
    errors.push({ path: `${path}.webView2Runtimes`, message: 'Preinstalled WebView2 runtimes are required' });
  }
}

function validateLockedItem(path: string, item: Record<string, unknown>, errors: LockValidationError[]): void {
  if (typeof item.version !== 'string' || item.version.length === 0) {
    errors.push({ path: `${path}.version`, message: 'Version is required' });
  } else if (!isExactVersion(item.version as string)) {
    errors.push({ path: `${path}.version`, message: `Floating range rejected: "${item.version}"` });
  }

  if (typeof item.source !== 'string' || item.source.length === 0) {
    errors.push({ path: `${path}.source`, message: 'Source is required' });
  }

  const integrity = item.integrity as Record<string, unknown> | undefined;
  if (!integrity || typeof integrity !== 'object') {
    errors.push({ path: `${path}.integrity`, message: 'Integrity record is required' });
  } else {
    if (integrity.algorithm !== 'sha256') {
      errors.push({ path: `${path}.integrity.algorithm`, message: 'Must be "sha256"' });
    }
    if (typeof integrity.digest !== 'string' || integrity.digest.length === 0) {
      errors.push({ path: `${path}.integrity.digest`, message: 'Digest is required' });
    }
  }

  if (typeof item.license !== 'string' || item.license.length === 0) {
    errors.push({ path: `${path}.license`, message: 'License is required' });
  }

  if (typeof item.architecture !== 'string' || item.architecture.length === 0) {
    errors.push({ path: `${path}.architecture`, message: 'Architecture is required' });
  }

  if (typeof item.reviewStatus !== 'string' || !['approved', 'pending', 'rejected'].includes(item.reviewStatus as string)) {
    errors.push({ path: `${path}.reviewStatus`, message: 'Must be approved, pending, or rejected' });
  }
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;

/**
 * Validates production readiness without mutating or approving the lock.
 * Pending/rejected review, placeholders, missing reviewers, or unreviewed
 * immutable image/runtime data are all hard failures.
 */
export function validateLockForProduction(lock: DependencyLock): LockValidationError[] {
  const errors = validateLockStructure(lock);
  const requireDigest = (path: string, digest: string): void => {
    if (!SHA256_HEX.test(digest) || digest.includes('REVIEW_REQUIRED')) {
      errors.push({ path, message: 'Reviewed 64-character SHA-256 digest is required' });
    }
  };
  const requireApproved = (path: string, status: ReviewStatus): void => {
    if (status !== 'approved') errors.push({ path, message: `Production requires approved review status; found ${status}` });
  };

  if (!lock.reviewedBy) errors.push({ path: 'reviewedBy', message: 'Production lock reviewer is required' });
  if (!lock.reviewDate || Number.isNaN(Date.parse(lock.reviewDate))) {
    errors.push({ path: 'reviewDate', message: 'Valid production lock review date is required' });
  }
  for (const [key, item] of Object.entries(lock.toolchain)) {
    requireApproved(`toolchain.${key}.reviewStatus`, item.reviewStatus);
    requireDigest(`toolchain.${key}.integrity.digest`, item.integrity.digest);
  }
  for (const [key, item] of Object.entries(lock.dependencies)) {
    requireApproved(`dependencies.${key}.reviewStatus`, item.reviewStatus);
    requireDigest(`dependencies.${key}.integrity.digest`, item.integrity.digest);
  }
  for (const [key, item] of Object.entries(lock.transitiveDependencies)) {
    requireApproved(`transitiveDependencies.${key}.reviewStatus`, item.reviewStatus);
    requireDigest(`transitiveDependencies.${key}.integrity.digest`, item.integrity.digest);
  }
  requireApproved('ciEnvironment.reviewStatus', lock.ciEnvironment.reviewStatus);
  requireDigest('ciEnvironment.imageDigest', lock.ciEnvironment.imageDigest);
  requireDigest('ciEnvironment.integrity.digest', lock.ciEnvironment.integrity.digest);
  for (const [index, snapshot] of lock.ciEnvironment.snapshots.entries()) {
    requireApproved(`ciEnvironment.snapshots.${index}.reviewStatus`, snapshot.reviewStatus);
    requireDigest(`ciEnvironment.snapshots.${index}.imageDigest`, snapshot.imageDigest);
    requireDigest(`ciEnvironment.snapshots.${index}.collectorManifestDigest`, snapshot.collectorManifestDigest);
    requireDigest(`ciEnvironment.snapshots.${index}.integrity.digest`, snapshot.integrity.digest);
    for (const [runtimeIndex, runtime] of snapshot.webView2Runtimes.entries()) {
      requireApproved(`ciEnvironment.snapshots.${index}.webView2Runtimes.${runtimeIndex}.reviewStatus`, runtime.reviewStatus);
      requireDigest(`ciEnvironment.snapshots.${index}.webView2Runtimes.${runtimeIndex}.integrity.digest`, runtime.integrity.digest);
    }
  }
  return errors;
}

/**
 * Checks that all transitive dependency references resolve.
 * Returns keys that are referenced but not defined.
 */
export function findUnresolvedTransitives(lock: DependencyLock): string[] {
  const defined = new Set(Object.keys(lock.transitiveDependencies));
  const referenced = new Set<string>();

  for (const item of Object.values(lock.toolchain)) {
    for (const dep of item.transitiveDependencies) {
      referenced.add(dep);
    }
  }
  for (const item of Object.values(lock.dependencies)) {
    for (const dep of item.transitiveDependencies) {
      referenced.add(dep);
    }
  }

  return [...referenced].filter(ref => !defined.has(ref));
}

/**
 * Checks that no item has a rejected or pending review status
 * when a production build is requested.
 */
export function findUnapprovedItems(lock: DependencyLock): string[] {
  const unapproved: string[] = [];

  for (const [key, item] of Object.entries(lock.toolchain)) {
    if (item.reviewStatus !== 'approved') {
      unapproved.push(`toolchain.${key}`);
    }
  }
  for (const [key, item] of Object.entries(lock.dependencies)) {
    if (item.reviewStatus !== 'approved') {
      unapproved.push(`dependencies.${key}`);
    }
  }
  for (const [key, item] of Object.entries(lock.transitiveDependencies)) {
    if (item.reviewStatus !== 'approved') {
      unapproved.push(`transitiveDependencies.${key}`);
    }
  }
  if (lock.ciEnvironment.reviewStatus !== 'approved') {
    unapproved.push('ciEnvironment');
  }

  return unapproved;
}
