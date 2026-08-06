/**
 * Tests for Stage C dependency lock validation.
 *
 * Validates: Requirements 3.1, 3.2, 3.5–3.12, 14.16
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  validateLockStructure,
  validateLockForProduction,
  isExactVersion,
  findUnresolvedTransitives,
  findUnapprovedItems,
  type DependencyLock,
} from '../../../native/stage-c/dependency-lock.types';

const LOCK_PATH = resolve(__dirname, '../../../native/stage-c/dependency-lock.json');
const lock: DependencyLock = JSON.parse(readFileSync(LOCK_PATH, 'utf-8'));

describe('Stage C dependency-lock.json structure', () => {
  it('parses as valid JSON', () => {
    expect(lock).toBeDefined();
    expect(typeof lock).toBe('object');
  });

  it('passes structural validation', () => {
    const errors = validateLockStructure(lock);
    expect(errors).toEqual([]);
  });

  it('has lockVersion 1', () => {
    expect(lock.lockVersion).toBe(1);
  });

  it('targets x64 architecture matching current Electron distribution', () => {
    expect(lock.architecture).toBe('x64');
  });
});

describe('Requirement 3.1: exact tool identification', () => {
  it('identifies one exact MSVC version and component set', () => {
    expect(lock.toolchain.msvc.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.toolchain.msvc.componentIds.length).toBeGreaterThan(0);
  });

  it('identifies one exact MSBuild version', () => {
    expect(lock.toolchain.msbuild.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.toolchain.msbuild.componentIds.length).toBeGreaterThan(0);
  });

  it('identifies one exact Windows SDK version', () => {
    expect(lock.toolchain.windowsSdk.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(lock.toolchain.windowsSdk.componentIds.length).toBeGreaterThan(0);
  });

  it('identifies one exact WebView2 SDK version', () => {
    expect(lock.dependencies.webview2Sdk.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(lock.dependencies.webview2Sdk.packageId).toBe('Microsoft.Web.WebView2');
  });

  it('identifies one exact CI image digest', () => {
    expect(lock.ciEnvironment.imageDigest).toBeDefined();
    expect(lock.ciEnvironment.imageDigest.length).toBeGreaterThan(0);
  });

  it('lists every transitive native dependency', () => {
    const transitiveKeys = Object.keys(lock.transitiveDependencies);
    expect(transitiveKeys.length).toBeGreaterThan(0);

    // All referenced transitives must resolve
    const unresolved = findUnresolvedTransitives(lock);
    expect(unresolved).toEqual([]);
  });
});

describe('Requirement 3.2: per-item metadata', () => {
  const allItems = [
    ...Object.entries(lock.toolchain).map(([k, v]) => [`toolchain.${k}`, v] as const),
    ...Object.entries(lock.dependencies).map(([k, v]) => [`dependencies.${k}`, v] as const),
    ...Object.entries(lock.transitiveDependencies).map(([k, v]) => [`transitiveDependencies.${k}`, v] as const),
  ];

  it.each(allItems)('%s has source', (_, item) => {
    expect(item.source).toBeDefined();
    expect(item.source.length).toBeGreaterThan(0);
  });

  it.each(allItems)('%s has integrity hash', (_, item) => {
    expect(item.integrity.algorithm).toBe('sha256');
    expect(item.integrity.digest).toBeDefined();
    expect(item.integrity.digest.length).toBeGreaterThan(0);
  });

  it.each(allItems)('%s has license', (_, item) => {
    expect(item.license).toBeDefined();
    expect(item.license.length).toBeGreaterThan(0);
  });

  it.each(allItems)('%s has architecture', (_, item) => {
    expect(item.architecture).toBe('x64');
  });

  it.each(allItems)('%s has review status', (_, item) => {
    expect(['approved', 'pending', 'rejected']).toContain(item.reviewStatus);
  });
});

describe('Requirement 3.9: reject floating ranges', () => {
  it('rejects ^ prefix', () => {
    expect(isExactVersion('^1.0.0')).toBe(false);
  });

  it('rejects ~ prefix', () => {
    expect(isExactVersion('~1.0.0')).toBe(false);
  });

  it('rejects >= range', () => {
    expect(isExactVersion('>=1.0.0')).toBe(false);
  });

  it('rejects * wildcard', () => {
    expect(isExactVersion('*')).toBe(false);
  });

  it('rejects x wildcard', () => {
    expect(isExactVersion('1.x')).toBe(false);
  });

  it('rejects "latest"', () => {
    expect(isExactVersion('latest')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isExactVersion('')).toBe(false);
  });

  it('accepts exact versions', () => {
    expect(isExactVersion('19.42.34435')).toBe(true);
    expect(isExactVersion('10.0.22621.0')).toBe(true);
    expect(isExactVersion('1.0.2903.40')).toBe(true);
    expect(isExactVersion('17.12.12')).toBe(true);
  });

  it('all lock versions are exact', () => {
    for (const item of Object.values(lock.toolchain)) {
      expect(isExactVersion(item.version)).toBe(true);
    }
    for (const item of Object.values(lock.dependencies)) {
      expect(isExactVersion(item.version)).toBe(true);
    }
    for (const item of Object.values(lock.transitiveDependencies)) {
      expect(isExactVersion(item.version)).toBe(true);
    }
  });
});

describe('Requirement 3.12: no alternate compiler fallbacks', () => {
  it('policy rejects alternate compilers', () => {
    expect(lock.policy.allowAlternateCompilers).toBe(false);
  });

  it('policy rejects auto-download', () => {
    expect(lock.policy.allowAutoDownload).toBe(false);
  });

  it('policy rejects floating ranges', () => {
    expect(lock.policy.allowFloatingRanges).toBe(false);
  });

  it('policy rejects unlisted dependencies', () => {
    expect(lock.policy.allowUnlistedDependencies).toBe(false);
  });
});

describe('Requirement 3.10: review checks required on change', () => {
  it('requires review before update', () => {
    expect(lock.policy.requireReviewBeforeUpdate).toBe(true);
  });

  it('requires all six review checks', () => {
    const required = lock.policy.requiredReviewChecks;
    expect(required).toContain('integrity');
    expect(required).toContain('license');
    expect(required).toContain('vulnerability');
    expect(required).toContain('publisher');
    expect(required).toContain('architecture');
    expect(required).toContain('reproducibility');
  });
});

describe('Requirement 3.5: JavaScript and Layer 0 unaffected by lock', () => {
  it('lock file is pure data with no side effects on import', () => {
    // The lock is a JSON file — importing it does not execute code,
    // install anything, or modify the system. This test confirms
    // the lock can be read without a native toolchain present.
    expect(lock).toBeDefined();
    expect(lock.policy.allowAutoDownload).toBe(false);
  });
});

describe('Requirement 14.16: zero downloads at startup', () => {
  it('policy forbids auto-download', () => {
    expect(lock.policy.allowAutoDownload).toBe(false);
  });

  it('no download triggers exist in lock data', () => {
    // Reading the lock is a pure parse — sources are recorded
    // for provenance, not for runtime fetching.
    const json = readFileSync(LOCK_PATH, 'utf-8');
    expect(json).not.toContain('autoInstall');
    expect(json).not.toContain('"autoDownload": true');
    expect(json).not.toContain('fetchOnMissing');
  });
});

describe('findUnapprovedItems', () => {
  it('identifies all pending items in the current lock', () => {
    const unapproved = findUnapprovedItems(lock);
    // All items are currently pending since this is a fresh lock
    expect(unapproved.length).toBeGreaterThan(0);
    expect(unapproved).toContain('toolchain.msvc');
    expect(unapproved).toContain('ciEnvironment');
  });

  it('keeps production disabled for placeholders and unreviewed VM snapshots', () => {
    const errors = validateLockForProduction(lock);
    expect(errors.some(error => error.path === 'toolchain.msvc.integrity.digest')).toBe(true);
    expect(errors.some(error => error.path === 'ciEnvironment.snapshots.0.reviewStatus')).toBe(true);
    expect(errors.some(error => error.path === 'ciEnvironment.snapshots.0.collectorManifestDigest')).toBe(true);
  });
});

describe('WebView2 SDK includes', () => {
  it('declares header, loader, and IDL paths', () => {
    const wv2 = lock.dependencies.webview2Sdk;
    expect(wv2.includes.headers).toBeDefined();
    expect(wv2.includes.loader).toBeDefined();
    expect(wv2.includes.idl).toBeDefined();
  });
});
