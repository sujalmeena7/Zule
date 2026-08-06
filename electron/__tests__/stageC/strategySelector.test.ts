/**
 * Strategy Selector — Unit Tests
 *
 * Verifies that:
 * - Only LAYER_0 and STAGE_C are valid outputs of selectStrategy (Req 1.1)
 * - Stage A selection is rejected from every input surface (Req 1.4)
 * - Stage B selection is rejected from every input surface (Req 1.5)
 * - Historical status values are immutable and correct (Req 1.2, 1.3)
 * - No Stage A/B code paths are reachable from the selector (Req 17.25-17.26)
 *
 * Requirements: 1.1–1.5, 17.25–17.26
 */

import { describe, it, expect } from 'vitest';
import {
  HostStrategy,
  STAGE_A_STATUS,
  STAGE_B_STATUS,
  rejectStageA,
  rejectStageB,
  validateStrategyInput,
  scanEnvironmentForDenied,
  selectStrategy,
  getStrategyStatus,
  type RejectionSource,
  type StrategySelectionContext,
} from '../../stageC/strategySelector';

// ────────────────────────────────────────────────────────────────────
// Immutable Historical Status Constants
// ────────────────────────────────────────────────────────────────────

describe('Strategy Selector — Historical Status Constants', () => {
  it('Stage A status is FAILED_DISABLED_A5_A6', () => {
    expect(STAGE_A_STATUS).toBe('FAILED_DISABLED_A5_A6');
  });

  it('Stage B status is DISABLED_NOT_EVALUATED', () => {
    expect(STAGE_B_STATUS).toBe('DISABLED_NOT_EVALUATED');
  });

  it('Stage A status is a string literal type (immutable)', () => {
    // TypeScript compile-time check; runtime: verify it's frozen in getStrategyStatus
    const status = getStrategyStatus();
    expect(status.stageAStatus).toBe('FAILED_DISABLED_A5_A6');
  });

  it('Stage B status is a string literal type (immutable)', () => {
    const status = getStrategyStatus();
    expect(status.stageBStatus).toBe('DISABLED_NOT_EVALUATED');
  });

  it('status report is frozen', () => {
    const status = getStrategyStatus();
    expect(Object.isFrozen(status)).toBe(true);
  });

  it('selectable strategies tuple is frozen', () => {
    const status = getStrategyStatus();
    expect(Object.isFrozen(status.selectableStrategies)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// selectStrategy — Only LAYER_0 or STAGE_C
// ────────────────────────────────────────────────────────────────────

describe('Strategy Selector — selectStrategy', () => {
  it('returns only LAYER_0 or STAGE_C', () => {
    const contexts: StrategySelectionContext[] = [
      { isWindows: false, stageCFailedThisLaunch: false, stageCEligible: false },
      { isWindows: false, stageCFailedThisLaunch: false, stageCEligible: true },
      { isWindows: false, stageCFailedThisLaunch: true, stageCEligible: false },
      { isWindows: false, stageCFailedThisLaunch: true, stageCEligible: true },
      { isWindows: true, stageCFailedThisLaunch: false, stageCEligible: false },
      { isWindows: true, stageCFailedThisLaunch: false, stageCEligible: true },
      { isWindows: true, stageCFailedThisLaunch: true, stageCEligible: false },
      { isWindows: true, stageCFailedThisLaunch: true, stageCEligible: true },
    ];

    for (const ctx of contexts) {
      const result = selectStrategy(ctx);
      expect([HostStrategy.LAYER_0, HostStrategy.STAGE_C]).toContain(result);
    }
  });

  it('returns LAYER_0 on non-Windows', () => {
    expect(selectStrategy({ isWindows: false, stageCFailedThisLaunch: false, stageCEligible: true }))
      .toBe(HostStrategy.LAYER_0);
  });

  it('returns LAYER_0 when Stage C failed this launch', () => {
    expect(selectStrategy({ isWindows: true, stageCFailedThisLaunch: true, stageCEligible: true }))
      .toBe(HostStrategy.LAYER_0);
  });

  it('returns STAGE_C when eligible on Windows and not failed', () => {
    expect(selectStrategy({ isWindows: true, stageCFailedThisLaunch: false, stageCEligible: true }))
      .toBe(HostStrategy.STAGE_C);
  });

  it('returns LAYER_0 as default when not eligible', () => {
    expect(selectStrategy({ isWindows: true, stageCFailedThisLaunch: false, stageCEligible: false }))
      .toBe(HostStrategy.LAYER_0);
  });

  it('never returns a value other than LAYER_0 or STAGE_C', () => {
    // Exhaustive: the only possible STAGE_C case is eligible + windows + not failed
    const result = selectStrategy({ isWindows: true, stageCFailedThisLaunch: false, stageCEligible: true });
    expect(result === HostStrategy.LAYER_0 || result === HostStrategy.STAGE_C).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// rejectStageA — Hard-deny from every source
// ────────────────────────────────────────────────────────────────────

describe('Strategy Selector — rejectStageA', () => {
  const allSources: RejectionSource[] = [
    'build_flag',
    'runtime_flag',
    'environment_variable',
    'persisted_setting',
    'retry_logic',
    'fallback_logic',
    'remote_content',
    'gate_waiver',
  ];

  for (const source of allSources) {
    it(`rejects Stage A from ${source}`, () => {
      const rejection = rejectStageA(source);
      expect(rejection.stage).toBe('A');
      expect(rejection.source).toBe(source);
      expect(rejection.status).toBe(STAGE_A_STATUS);
      expect(rejection.reason).toContain('Stage A');
      expect(rejection.reason).toContain(source);
      expect(rejection.reason).toContain('A5');
      expect(rejection.reason).toContain('A6');
    });

    it(`rejection from ${source} is frozen`, () => {
      const rejection = rejectStageA(source);
      expect(Object.isFrozen(rejection)).toBe(true);
    });
  }
});

// ────────────────────────────────────────────────────────────────────
// rejectStageB — Hard-deny from every source
// ────────────────────────────────────────────────────────────────────

describe('Strategy Selector — rejectStageB', () => {
  const allSources: RejectionSource[] = [
    'build_flag',
    'runtime_flag',
    'environment_variable',
    'persisted_setting',
    'retry_logic',
    'fallback_logic',
    'remote_content',
    'gate_waiver',
  ];

  for (const source of allSources) {
    it(`rejects Stage B from ${source}`, () => {
      const rejection = rejectStageB(source);
      expect(rejection.stage).toBe('B');
      expect(rejection.source).toBe(source);
      expect(rejection.status).toBe(STAGE_B_STATUS);
      expect(rejection.reason).toContain('Stage B');
      expect(rejection.reason).toContain(source);
      expect(rejection.reason).toContain('not evaluated');
    });

    it(`rejection from ${source} is frozen`, () => {
      const rejection = rejectStageB(source);
      expect(Object.isFrozen(rejection)).toBe(true);
    });
  }
});

// ────────────────────────────────────────────────────────────────────
// validateStrategyInput — Input surface validation
// ────────────────────────────────────────────────────────────────────

describe('Strategy Selector — validateStrategyInput', () => {
  it('accepts LAYER_0', () => {
    expect(validateStrategyInput('LAYER_0', 'runtime_flag')).toBeNull();
  });

  it('accepts STAGE_C', () => {
    expect(validateStrategyInput('STAGE_C', 'runtime_flag')).toBeNull();
  });

  it('accepts case-insensitive LAYER_0', () => {
    expect(validateStrategyInput('layer_0', 'runtime_flag')).toBeNull();
  });

  it('accepts case-insensitive STAGE_C', () => {
    expect(validateStrategyInput('stage_c', 'runtime_flag')).toBeNull();
  });

  // Stage A identifiers
  const stageAInputs = ['stage_a', 'stagea', 'stage-a', 'reparent', 'stealth_host', 'stealthhost', 'stealth-host'];
  for (const input of stageAInputs) {
    it(`rejects Stage A identifier: "${input}"`, () => {
      const result = validateStrategyInput(input, 'build_flag');
      expect(result).not.toBeNull();
      expect(result!.stage).toBe('A');
      expect(result!.status).toBe(STAGE_A_STATUS);
    });
  }

  // Stage B identifiers
  const stageBInputs = ['stage_b', 'stageb', 'stage-b', 'layered', 'offscreen', 'offscreen_render'];
  for (const input of stageBInputs) {
    it(`rejects Stage B identifier: "${input}"`, () => {
      const result = validateStrategyInput(input, 'build_flag');
      expect(result).not.toBeNull();
      expect(result!.stage).toBe('B');
      expect(result!.status).toBe(STAGE_B_STATUS);
    });
  }

  it('rejects unknown/unrecognized strategy values', () => {
    const result = validateStrategyInput('some_random_value', 'persisted_setting');
    expect(result).not.toBeNull();
  });

  it('rejects empty string', () => {
    const result = validateStrategyInput('', 'runtime_flag');
    expect(result).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// scanEnvironmentForDenied — Environment variable scanning
// ────────────────────────────────────────────────────────────────────

describe('Strategy Selector — scanEnvironmentForDenied', () => {
  it('returns empty for clean environment', () => {
    expect(scanEnvironmentForDenied({})).toHaveLength(0);
  });

  it('rejects ZULE_HOST_STRATEGY=reparent as Stage A', () => {
    const rejections = scanEnvironmentForDenied({ ZULE_HOST_STRATEGY: 'reparent' });
    expect(rejections).toHaveLength(1);
    expect(rejections[0].stage).toBe('A');
    expect(rejections[0].source).toBe('environment_variable');
  });

  it('rejects ZULE_HOST_STRATEGY=layered as Stage B', () => {
    const rejections = scanEnvironmentForDenied({ ZULE_HOST_STRATEGY: 'layered' });
    expect(rejections).toHaveLength(1);
    expect(rejections[0].stage).toBe('B');
    expect(rejections[0].source).toBe('environment_variable');
  });

  it('rejects ZULE_STAGE_A with any value', () => {
    const rejections = scanEnvironmentForDenied({ ZULE_STAGE_A: 'true' });
    expect(rejections).toHaveLength(1);
    expect(rejections[0].stage).toBe('A');
  });

  it('rejects ZULE_STAGE_B with any value', () => {
    const rejections = scanEnvironmentForDenied({ ZULE_STAGE_B: 'true' });
    expect(rejections).toHaveLength(1);
    expect(rejections[0].stage).toBe('B');
  });

  it('rejects ZULE_REPARENT as Stage A', () => {
    const rejections = scanEnvironmentForDenied({ ZULE_REPARENT: '1' });
    expect(rejections).toHaveLength(1);
    expect(rejections[0].stage).toBe('A');
  });

  it('rejects ZULE_LAYERED as Stage B', () => {
    const rejections = scanEnvironmentForDenied({ ZULE_LAYERED: '1' });
    expect(rejections).toHaveLength(1);
    expect(rejections[0].stage).toBe('B');
  });

  it('rejects ZULE_OFFSCREEN as Stage B', () => {
    const rejections = scanEnvironmentForDenied({ ZULE_OFFSCREEN: 'enabled' });
    expect(rejections).toHaveLength(1);
    expect(rejections[0].stage).toBe('B');
  });

  it('ignores undefined and empty env values', () => {
    const rejections = scanEnvironmentForDenied({
      ZULE_HOST_STRATEGY: undefined,
      ZULE_STAGE_A: '',
    });
    expect(rejections).toHaveLength(0);
  });

  it('collects multiple rejections', () => {
    const rejections = scanEnvironmentForDenied({
      ZULE_STAGE_A: 'true',
      ZULE_STAGE_B: 'true',
      ZULE_REPARENT: '1',
    });
    expect(rejections.length).toBeGreaterThanOrEqual(3);
  });
});

// ────────────────────────────────────────────────────────────────────
// getStrategyStatus — Diagnostic Report
// ────────────────────────────────────────────────────────────────────

describe('Strategy Selector — getStrategyStatus', () => {
  it('reports exactly two selectable strategies', () => {
    const status = getStrategyStatus();
    expect(status.selectableStrategies).toHaveLength(2);
    expect(status.selectableStrategies).toContain(HostStrategy.LAYER_0);
    expect(status.selectableStrategies).toContain(HostStrategy.STAGE_C);
  });

  it('Stage A is never eligible', () => {
    const status = getStrategyStatus();
    expect(status.stageAEligible).toBe(false);
  });

  it('Stage B is never eligible', () => {
    const status = getStrategyStatus();
    expect(status.stageBEligible).toBe(false);
  });

  it('reports correct Stage A status', () => {
    const status = getStrategyStatus();
    expect(status.stageAStatus).toBe('FAILED_DISABLED_A5_A6');
  });

  it('reports correct Stage B status', () => {
    const status = getStrategyStatus();
    expect(status.stageBStatus).toBe('DISABLED_NOT_EVALUATED');
  });
});

// ────────────────────────────────────────────────────────────────────
// Module Isolation — No Stage A/B imports
// ────────────────────────────────────────────────────────────────────

describe('Strategy Selector — Module Isolation', () => {
  it('does not import from win32/hostWindow (Stage A)', () => {
    // The strategy selector must not import from the Stage A execution path
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').resolve(__dirname, '../../stageC/strategySelector.ts'),
      'utf-8',
    );
    expect(source).not.toContain("from '../win32/hostWindow'");
    expect(source).not.toContain("from '../win32/reparent'");
    expect(source).not.toContain("from '../win32/stealthHostGate'");
  });

  it('does not import from win32/layeredPaint (Stage B)', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').resolve(__dirname, '../../stageC/strategySelector.ts'),
      'utf-8',
    );
    expect(source).not.toContain("from '../win32/layeredPaint'");
    expect(source).not.toContain("from '../win32/inputForwarder'");
  });

  it('does not import koffi or any native FFI', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').resolve(__dirname, '../../stageC/strategySelector.ts'),
      'utf-8',
    );
    expect(source).not.toContain('koffi');
    expect(source).not.toContain("from '../win32/ffi'");
  });

  it('only imports from ./protocol/schema', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').resolve(__dirname, '../../stageC/strategySelector.ts'),
      'utf-8',
    );
    // The only import should be from protocol/schema
    const importLines = source.split('\n').filter((line: string) => line.trim().startsWith('import'));
    expect(importLines).toHaveLength(1);
    expect(importLines[0]).toContain('./protocol/schema');
  });
});
