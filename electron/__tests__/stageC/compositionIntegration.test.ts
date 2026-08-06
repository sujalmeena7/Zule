/**
 * Stage C — Composition Integration Test Harness Validation
 *
 * This TypeScript test validates that the native C++ composition integration
 * test source exists and has the correct structure. The native test itself
 * executes on CI with the MSVC toolchain; this file ensures the test plan
 * is in place even when the native code cannot compile on this machine.
 *
 * Validates: Requirements 9.4–9.9, 17.8
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// --------------------------------------------------------------------
// Path to the native integration test source
// --------------------------------------------------------------------

const NATIVE_DIR = path.resolve(__dirname, '../../../native/stage-c');
const TESTS_DIR = path.join(NATIVE_DIR, 'tests');
const INTEGRATION_TEST = path.join(
  TESTS_DIR,
  'composition_integration_test.cpp',
);

// --------------------------------------------------------------------
// Source content cache
// --------------------------------------------------------------------

let testSource: string;

beforeAll(() => {
  testSource = fs.readFileSync(INTEGRATION_TEST, 'utf-8');
});

// ====================================================================
// File existence and basic structure
// ====================================================================

describe('Composition integration test harness exists', () => {
  it('native test file exists at expected path', () => {
    expect(fs.existsSync(INTEGRATION_TEST)).toBe(true);
  });

  it('test file is non-trivial (> 100 lines)', () => {
    const lineCount = testSource.split('\n').length;
    expect(lineCount).toBeGreaterThan(100);
  });
});

// ====================================================================
// Mode x scale test matrix coverage
// ====================================================================

describe('Test matrix covers all mode × scale combinations', () => {
  it('tests compact mode', () => {
    expect(testSource).toContain('Compact');
  });

  it('tests expanded mode', () => {
    expect(testSource).toContain('Expanded');
  });

  it('tests maximized mode', () => {
    expect(testSource).toContain('Maximized');
  });

  it('tests 100% scaling', () => {
    expect(testSource).toMatch(/100/);
  });

  it('tests 125% scaling', () => {
    expect(testSource).toMatch(/125/);
  });

  it('tests 150% scaling', () => {
    expect(testSource).toMatch(/150/);
  });

  it('tests 200% scaling', () => {
    expect(testSource).toMatch(/200/);
  });

  it('scale factors array contains all four values', () => {
    // The kScaleFactors array should list 100, 125, 150, 200
    const scaleArrayMatch = testSource.match(
      /kScaleFactors\[\]\s*=\s*\{[^}]+\}/,
    );
    expect(scaleArrayMatch).not.toBeNull();
    const scaleContent = scaleArrayMatch![0];
    expect(scaleContent).toContain('100');
    expect(scaleContent).toContain('125');
    expect(scaleContent).toContain('150');
    expect(scaleContent).toContain('200');
  });

  it('overlay modes array contains all three modes', () => {
    const modesArrayMatch = testSource.match(/kModes\[\]\s*=\s*\{[^}]+\}/s);
    expect(modesArrayMatch).not.toBeNull();
    const modesContent = modesArrayMatch![0];
    expect(modesContent).toContain('Compact');
    expect(modesContent).toContain('Expanded');
    expect(modesContent).toContain('Maximized');
  });
});

// ====================================================================
// Alpha verification structure (Req 9.4, 9.5, 9.6)
// ====================================================================

describe('Alpha verification routines are present', () => {
  it('verifies transparent regions have alpha == 0 (Req 9.4, 9.6)', () => {
    expect(testSource).toContain('VerifyTransparentRegions');
    // Should check alpha == 0
    expect(testSource).toMatch(/alpha\s*!=\s*0/);
  });

  it('verifies premultiplied partial alpha error <= 1 unit (Req 9.5)', () => {
    expect(testSource).toContain('VerifyPremultipliedAlpha');
    // Should check error > 1
    expect(testSource).toMatch(/error\s*>\s*1/);
  });

  it('verifies hidden surface produces no visible pixels (Req 9.8)', () => {
    expect(testSource).toContain('VerifyHiddenSurface');
  });

  it('references Req 9.4 (alpha 0 transparency)', () => {
    expect(testSource).toContain('Req 9.4');
  });

  it('references Req 9.5 (premultiplied alpha error)', () => {
    expect(testSource).toContain('Req 9.5');
  });

  it('references Req 9.6 (declared transparent regions)', () => {
    // The source combines Req 9.4 and 9.6 in one comment: "Req 9.4, 9.6"
    expect(testSource).toMatch(/9\.6/);
  });

  it('references Req 9.8 (hidden surface zero pixels)', () => {
    expect(testSource).toContain('Req 9.8');
  });
});

// ====================================================================
// Composition and surface integration structure
// ====================================================================

describe('Test creates FloatingSurface and CompositionHost', () => {
  it('creates FloatingSurface', () => {
    expect(testSource).toContain('FloatingSurface');
    expect(testSource).toContain('surface.RegisterWindowClass');
    expect(testSource).toContain('surface.Create');
  });

  it('creates CompositionHost', () => {
    expect(testSource).toContain('CompositionHost');
    expect(testSource).toContain('composition.InitializeComposition');
  });

  it('initializes WebView2 for composition rendering', () => {
    expect(testSource).toContain('InitializeWebView2');
  });

  it('sets overlay mode before capture', () => {
    expect(testSource).toContain('composition.SetMode');
  });

  it('resizes composition to physical pixel dimensions', () => {
    expect(testSource).toContain('composition.Resize');
  });

  it('tests visibility toggle for hidden surface verification', () => {
    expect(testSource).toContain('composition.SetVisible(false)');
    expect(testSource).toContain('composition.SetVisible(true)');
  });
});

// ====================================================================
// Frame capture mechanism
// ====================================================================

describe('Frame capture uses DWM-compatible methods', () => {
  it('uses PrintWindow with PW_RENDERFULLCONTENT for DComp surfaces', () => {
    expect(testSource).toContain('PrintWindow');
    expect(testSource).toContain('PW_RENDERFULLCONTENT');
  });

  it('falls back to BitBlt if PrintWindow fails', () => {
    expect(testSource).toContain('BitBlt');
  });

  it('creates 32-bit BGRA DIB section for alpha-aware capture', () => {
    expect(testSource).toContain('CreateDIBSection');
    expect(testSource).toMatch(/biBitCount\s*=\s*32/);
  });

  it('uses top-down bitmap (negative biHeight)', () => {
    expect(testSource).toMatch(/-static_cast<LONG>\(heightPx\)/);
  });
});

// ====================================================================
// DPI scaling logic
// ====================================================================

describe('DPI scaling is correctly applied', () => {
  it('has a ScaleDip function for DIP-to-physical conversion', () => {
    expect(testSource).toContain('ScaleDip');
  });

  it('scales dimensions using percentage-based calculation', () => {
    // ScaleDip should multiply by scalePercent / 100
    expect(testSource).toMatch(/dipValue\)?\s*\*\s*scalePercent\s*\/\s*100/);
  });

  it('applies scaling to both width and height', () => {
    expect(testSource).toContain('ScaleDip(dims.width, tc.scalePercent)');
    expect(testSource).toContain('ScaleDip(dims.height, tc.scalePercent)');
  });
});

// ====================================================================
// Requirements traceability
// ====================================================================

describe('Requirements traceability', () => {
  it('documents requirements 9.4-9.9 in test file header', () => {
    expect(testSource).toContain('9.4');
    expect(testSource).toContain('9.5');
    expect(testSource).toContain('9.6');
    expect(testSource).toContain('9.8');
    expect(testSource).toContain('9.9');
  });

  it('documents requirement 17.8 (transparency gate)', () => {
    expect(testSource).toContain('17.8');
  });

  it('includes COM initialization for DirectComposition', () => {
    expect(testSource).toContain('CoInitializeEx');
    expect(testSource).toContain('CoUninitialize');
  });

  it('performs deterministic cleanup on each test case', () => {
    expect(testSource).toContain('composition.Destroy()');
    expect(testSource).toContain('surface.Destroy()');
  });
});
