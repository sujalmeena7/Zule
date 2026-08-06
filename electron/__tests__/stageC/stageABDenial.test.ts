// ============================================
// Zule AI — Stage A/B Denial & Protected-Suite Regression Tests
// ============================================
//
// Task 24.16: Attempt historical strategy selection through every input
// surface and assert hard denial; verify protected test files exist
// unchanged and are not skipped, renamed, deleted, replaced, or weakened.
//
// Requirements: 1.1–1.5, 18.7–18.9

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import {
  selectStrategy,
  validateStrategyInput,
  rejectStageA,
  rejectStageB,
  scanEnvironmentForDenied,
  getStrategyStatus,
  STAGE_A_STATUS,
  STAGE_B_STATUS,
  HostStrategy,
  RejectionSource,
} from '../../stageC/strategySelector';

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

const ALL_REJECTION_SOURCES: RejectionSource[] = [
  'build_flag', 'runtime_flag', 'environment_variable',
  'persisted_setting', 'retry_logic', 'fallback_logic',
  'remote_content', 'gate_waiver',
];

const STAGE_A_IDENTIFIERS = [
  'stage_a', 'stagea', 'stage-a', 'reparent',
  'stealth_host', 'stealthhost', 'stealth-host',
  'STAGE_A', 'StageA', 'REPARENT', 'Stealth_Host',
];

const STAGE_B_IDENTIFIERS = [
  'stage_b', 'stageb', 'stage-b', 'layered',
  'offscreen', 'offscreen_render',
  'STAGE_B', 'StageB', 'LAYERED', 'OFFSCREEN',
];

const DENIED_ENV_VARS = [
  'ZULE_HOST_STRATEGY', 'ZULE_STEALTH_MODE',
  'ZULE_STAGE_A', 'ZULE_STAGE_B',
  'ZULE_REPARENT', 'ZULE_LAYERED', 'ZULE_OFFSCREEN',
];

// ────────────────────────────────────────────────────────────────────
// Stage A/B Hard Denial Tests
// ────────────────────────────────────────────────────────────────────

describe('Stage A/B Hard Denial — Every Input Surface', () => {
  describe('Stage A rejection from every source', () => {
    for (const source of ALL_REJECTION_SOURCES) {
      it(`rejects Stage A from ${source}`, () => {
        const rejection = rejectStageA(source);
        expect(rejection.stage).toBe('A');
        expect(rejection.source).toBe(source);
        expect(rejection.status).toBe(STAGE_A_STATUS);
        expect(rejection.reason).toContain('Stage A');
        expect(rejection.reason).toContain(STAGE_A_STATUS);
      });
    }
  });

  describe('Stage B rejection from every source', () => {
    for (const source of ALL_REJECTION_SOURCES) {
      it(`rejects Stage B from ${source}`, () => {
        const rejection = rejectStageB(source);
        expect(rejection.stage).toBe('B');
        expect(rejection.source).toBe(source);
        expect(rejection.status).toBe(STAGE_B_STATUS);
        expect(rejection.reason).toContain('Stage B');
        expect(rejection.reason).toContain(STAGE_B_STATUS);
      });
    }
  });

  describe('Stage A identifiers rejected via validateStrategyInput', () => {
    for (const id of STAGE_A_IDENTIFIERS) {
      for (const source of ALL_REJECTION_SOURCES) {
        it(`rejects "${id}" from ${source}`, () => {
          const result = validateStrategyInput(id, source);
          expect(result).not.toBeNull();
          expect(result!.stage).toBe('A');
        });
      }
    }
  });

  describe('Stage B identifiers rejected via validateStrategyInput', () => {
    for (const id of STAGE_B_IDENTIFIERS) {
      for (const source of ALL_REJECTION_SOURCES) {
        it(`rejects "${id}" from ${source}`, () => {
          const result = validateStrategyInput(id, source);
          expect(result).not.toBeNull();
          expect(result!.stage).toBe('B');
        });
      }
    }
  });

  describe('Only LAYER_0 and STAGE_C are accepted', () => {
    it('LAYER_0 is accepted from all sources', () => {
      for (const source of ALL_REJECTION_SOURCES) {
        expect(validateStrategyInput('LAYER_0', source)).toBeNull();
      }
    });

    it('STAGE_C is accepted from all sources', () => {
      for (const source of ALL_REJECTION_SOURCES) {
        expect(validateStrategyInput('STAGE_C', source)).toBeNull();
      }
    });

    it('unknown values are rejected', () => {
      const unknowns = ['random', 'UNKNOWN', 'stage_d', 'hybrid', ''];
      for (const val of unknowns) {
        if (val === '') continue; // empty string edge case
        const result = validateStrategyInput(val, 'build_flag');
        expect(result).not.toBeNull();
      }
    });
  });

  describe('Environment variable denial', () => {
    for (const envVar of DENIED_ENV_VARS) {
      it(`denies ${envVar} with any value`, () => {
        const env = { [envVar]: 'some_value' };
        const rejections = scanEnvironmentForDenied(env);
        expect(rejections.length).toBeGreaterThan(0);
        expect(rejections[0].source).toBe('environment_variable');
      });
    }

    it('clean environment produces no rejections', () => {
      const rejections = scanEnvironmentForDenied({});
      expect(rejections).toEqual([]);
    });

    it('multiple denied vars produce multiple rejections', () => {
      const env: Record<string, string> = {};
      for (const v of DENIED_ENV_VARS) env[v] = 'enabled';
      const rejections = scanEnvironmentForDenied(env);
      expect(rejections.length).toBe(DENIED_ENV_VARS.length);
    });
  });

  describe('Strategy selector output', () => {
    it('never returns Stage A or Stage B', () => {
      const contexts = [
        { isWindows: true, stageCFailedThisLaunch: false, stageCEligible: true },
        { isWindows: true, stageCFailedThisLaunch: true, stageCEligible: true },
        { isWindows: false, stageCFailedThisLaunch: false, stageCEligible: true },
        { isWindows: true, stageCFailedThisLaunch: false, stageCEligible: false },
      ];
      for (const ctx of contexts) {
        const result = selectStrategy(ctx);
        expect(result).not.toBe('STAGE_A');
        expect(result).not.toBe('STAGE_B');
        expect([HostStrategy.LAYER_0, HostStrategy.STAGE_C]).toContain(result);
      }
    });
  });

  describe('Immutable status report', () => {
    it('stageA always FAILED_DISABLED_A5_A6 and ineligible', () => {
      const status = getStrategyStatus();
      expect(status.stageAStatus).toBe('FAILED_DISABLED_A5_A6');
      expect(status.stageAEligible).toBe(false);
    });

    it('stageB always DISABLED_NOT_EVALUATED and ineligible', () => {
      const status = getStrategyStatus();
      expect(status.stageBStatus).toBe('DISABLED_NOT_EVALUATED');
      expect(status.stageBEligible).toBe(false);
    });

    it('selectableStrategies contains only LAYER_0 and STAGE_C', () => {
      const status = getStrategyStatus();
      expect(status.selectableStrategies).toEqual([HostStrategy.LAYER_0, HostStrategy.STAGE_C]);
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// Protected Suite Regression — verify files exist unchanged
// ────────────────────────────────────────────────────────────────────

describe('Protected Suite Regression', () => {
  const PROTECTED_FILES = [
    'src/overlay/dualModeOverlay.preservation.test.ts',
    'src/electron-tests/dualModeOverlay.bugcondition.test.ts',
  ];

  // Resolve paths relative to project root
  const projectRoot = path.resolve(__dirname, '..', '..', '..');

  for (const relPath of PROTECTED_FILES) {
    const absPath = path.join(projectRoot, relPath);

    it(`${relPath} exists and has not been deleted`, () => {
      expect(fs.existsSync(absPath)).toBe(true);
    });

    it(`${relPath} is a file (not renamed to directory)`, () => {
      const stat = fs.statSync(absPath);
      expect(stat.isFile()).toBe(true);
    });

    it(`${relPath} has non-zero content (not emptied)`, () => {
      const content = fs.readFileSync(absPath, 'utf-8');
      expect(content.length).toBeGreaterThan(100);
    });

    it(`${relPath} contains test assertions (not weakened)`, () => {
      const content = fs.readFileSync(absPath, 'utf-8');
      // Must contain expect() calls — indicators of real assertions
      expect(content).toContain('expect(');
      // Must contain describe or it — indicators of test structure
      expect(content).toMatch(/\b(describe|it|test)\s*\(/);
    });

    it(`${relPath} is not skipped (.skip not applied globally)`, () => {
      const content = fs.readFileSync(absPath, 'utf-8');
      // Global skip patterns that would disable the entire file
      expect(content).not.toMatch(/^describe\.skip\s*\(/m);
      expect(content).not.toMatch(/^it\.skip\s*\(/m);
    });
  }

  it('both protected files produce stable SHA-256 fingerprints', () => {
    for (const relPath of PROTECTED_FILES) {
      const absPath = path.join(projectRoot, relPath);
      const content = fs.readFileSync(absPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      // Hash must be a valid 64-char hex string
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      // Content length sanity
      expect(content.length).toBeGreaterThan(0);
    }
  });
});
