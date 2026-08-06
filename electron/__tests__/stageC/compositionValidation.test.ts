/**
 * Stage C — Composition Validation Tests
 *
 * Since the native C++ code cannot compile on this machine (no MSVC toolchain),
 * these tests validate the C++ source artifacts for correctness by inspecting
 * the source files for required composition patterns, declarations, and ordering.
 *
 * Validates: Requirements 9.2–9.9
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// --------------------------------------------------------------------
// Paths to native source artifacts
// --------------------------------------------------------------------

const NATIVE_DIR = path.resolve(__dirname, '../../../native/stage-c');
const SRC_DIR = path.join(NATIVE_DIR, 'src');

const COMPOSITION_H = path.join(SRC_DIR, 'composition.h');
const COMPOSITION_CPP = path.join(SRC_DIR, 'composition.cpp');
const OVERLAY_MODE_H = path.join(SRC_DIR, 'overlay_mode.h');

// --------------------------------------------------------------------
// Source content cache
// --------------------------------------------------------------------

let compositionH: string;
let compositionCpp: string;
let overlayModeH: string;

beforeAll(() => {
  compositionH = fs.readFileSync(COMPOSITION_H, 'utf-8');
  compositionCpp = fs.readFileSync(COMPOSITION_CPP, 'utf-8');
  overlayModeH = fs.readFileSync(OVERLAY_MODE_H, 'utf-8');
});

// ====================================================================
// Alpha transparency: default background alpha is 0 (Req 9.3)
// ====================================================================

describe('Alpha transparency (Req 9.3)', () => {
  it('sets COREWEBVIEW2_COLOR with all fields zero {0, 0, 0, 0}', () => {
    // The transparent color struct must be initialized with alpha=0, r=0, g=0, b=0
    const transparentMatch = compositionCpp.match(
      /COREWEBVIEW2_COLOR\s+\w+\s*=\s*\{\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\}/,
    );
    expect(transparentMatch).not.toBeNull();
  });

  it('passes the transparent color to put_DefaultBackgroundColor', () => {
    // After creating the transparent color, it must be passed to put_DefaultBackgroundColor
    const transparentPos = compositionCpp.indexOf('COREWEBVIEW2_COLOR transparent');
    const putColorPos = compositionCpp.indexOf('put_DefaultBackgroundColor(transparent)');

    expect(transparentPos).toBeGreaterThan(-1);
    expect(putColorPos).toBeGreaterThan(-1);
    expect(putColorPos).toBeGreaterThan(transparentPos);
  });

  it('documents Req 9.3 alpha transparency in the source', () => {
    expect(compositionCpp).toContain('Req 9.3');
    expect(compositionCpp).toContain('alpha');
  });
});

// ====================================================================
// Composition controller path (Req 9.2)
// ====================================================================

describe('Composition controller path (Req 9.2)', () => {
  it('uses CreateCoreWebView2CompositionController (not windowed controller)', () => {
    expect(compositionCpp).toContain('CreateCoreWebView2CompositionController');
  });

  it('does not use CreateCoreWebView2Controller directly for creation', () => {
    // The non-composition controller path should NOT be used for creation.
    // The code obtains ICoreWebView2Controller via QueryInterface (.As(&controller_))
    // but must not call CreateCoreWebView2Controller as a creation method.
    const creationCalls = compositionCpp.match(
      /->CreateCoreWebView2Controller\s*\(/g,
    );
    expect(creationCalls).toBeNull();
  });

  it('calls put_RootVisualTarget with the root visual', () => {
    expect(compositionCpp).toContain('put_RootVisualTarget');
    // Verify it passes rootVisual_.Get() as the argument
    const putVisualMatch = compositionCpp.match(
      /put_RootVisualTarget\s*\(\s*rootVisual_\.Get\(\)\s*\)/,
    );
    expect(putVisualMatch).not.toBeNull();
  });

  it('obtains ICoreWebView2Environment3 for composition controller creation', () => {
    expect(compositionCpp).toContain('ICoreWebView2Environment3');
    // Must QI to env3 before creating the composition controller
    const env3Pos = compositionCpp.indexOf('ICoreWebView2Environment3');
    const createCompCtrlPos = compositionCpp.indexOf(
      'CreateCoreWebView2CompositionController',
    );
    expect(env3Pos).toBeLessThan(createCompCtrlPos);
  });

  it('documents Req 9.2 composition controller path', () => {
    expect(compositionCpp).toContain('Req 9.2');
  });
});

// ====================================================================
// Controller/client bounds ordering (Req 9.7)
// ====================================================================

describe('Controller/client bounds ordering (Req 9.7)', () => {
  it('Resize() calls put_Bounds before Commit', () => {
    // Extract the Resize method
    const resizeStart = compositionCpp.indexOf('void CompositionHost::Resize(');
    const resizeEnd = compositionCpp.indexOf(
      'void CompositionHost::SetVisible',
    );
    const resizeMethod = compositionCpp.substring(resizeStart, resizeEnd);

    const putBoundsPos = resizeMethod.indexOf('put_Bounds');
    const commitPos = resizeMethod.indexOf('Commit()');

    expect(putBoundsPos).toBeGreaterThan(-1);
    expect(commitPos).toBeGreaterThan(-1);
    expect(putBoundsPos).toBeLessThan(commitPos);
  });

  it('Resize() sets visual clip before controller bounds', () => {
    // The visual clip (SetClip) should be set before put_Bounds
    const resizeStart = compositionCpp.indexOf('void CompositionHost::Resize(');
    const resizeEnd = compositionCpp.indexOf(
      'void CompositionHost::SetVisible',
    );
    const resizeMethod = compositionCpp.substring(resizeStart, resizeEnd);

    const setClipPos = resizeMethod.indexOf('SetClip');
    const putBoundsPos = resizeMethod.indexOf('put_Bounds');

    expect(setClipPos).toBeGreaterThan(-1);
    expect(putBoundsPos).toBeGreaterThan(-1);
    expect(setClipPos).toBeLessThan(putBoundsPos);
  });

  it('no Commit between visual clip and controller bounds in Resize', () => {
    // Extract Resize method
    const resizeStart = compositionCpp.indexOf('void CompositionHost::Resize(');
    const resizeEnd = compositionCpp.indexOf(
      'void CompositionHost::SetVisible',
    );
    const resizeMethod = compositionCpp.substring(resizeStart, resizeEnd);

    // Get the section between SetClip and put_Bounds
    const setClipPos = resizeMethod.indexOf('SetClip');
    const putBoundsPos = resizeMethod.indexOf('put_Bounds');
    const betweenSection = resizeMethod.substring(setClipPos, putBoundsPos);

    // There should be no Commit() call between these two operations
    expect(betweenSection).not.toContain('Commit()');
  });

  it('documents atomic presentation requirement (Req 9.7)', () => {
    const resizeStart = compositionCpp.indexOf('void CompositionHost::Resize(');
    const resizeEnd = compositionCpp.indexOf(
      'void CompositionHost::SetVisible',
    );
    const resizeMethod = compositionCpp.substring(resizeStart, resizeEnd);

    expect(resizeMethod).toContain('Req 9.7');
  });
});

// ====================================================================
// Hidden-surface output (Req 9.8)
// ====================================================================

describe('Hidden-surface output (Req 9.8)', () => {
  it('SetVisible(false) removes root from target via SetRoot(nullptr)', () => {
    // In the hide branch, SetRoot(nullptr) must be called
    const setVisibleStart = compositionCpp.indexOf(
      'void CompositionHost::SetVisible',
    );
    const setVisibleEnd = compositionCpp.indexOf(
      'void CompositionHost::SetMode',
    );
    const setVisibleMethod = compositionCpp.substring(
      setVisibleStart,
      setVisibleEnd,
    );

    expect(setVisibleMethod).toContain('SetRoot(nullptr)');
  });

  it('SetVisible(false) calls put_IsVisible(FALSE)', () => {
    const setVisibleStart = compositionCpp.indexOf(
      'void CompositionHost::SetVisible',
    );
    const setVisibleEnd = compositionCpp.indexOf(
      'void CompositionHost::SetMode',
    );
    const setVisibleMethod = compositionCpp.substring(
      setVisibleStart,
      setVisibleEnd,
    );

    expect(setVisibleMethod).toContain('put_IsVisible(FALSE)');
  });

  it('controller starts as not visible (visible_ = false)', () => {
    // The header should initialize visible_ to false
    expect(compositionH).toMatch(/bool\s+visible_\s*=\s*false/);
  });

  it('SetVisible(false) hides controller before removing root visual', () => {
    // Order in hide path: put_IsVisible(FALSE) then SetRoot(nullptr)
    const setVisibleStart = compositionCpp.indexOf(
      'void CompositionHost::SetVisible',
    );
    const setVisibleEnd = compositionCpp.indexOf(
      'void CompositionHost::SetMode',
    );
    const setVisibleMethod = compositionCpp.substring(
      setVisibleStart,
      setVisibleEnd,
    );

    // Find the else/hide branch
    const hideBranchStart = setVisibleMethod.indexOf('} else {');
    const hideBranch = setVisibleMethod.substring(hideBranchStart);

    const isVisiblePos = hideBranch.indexOf('put_IsVisible(FALSE)');
    const setRootNullPos = hideBranch.indexOf('SetRoot(nullptr)');

    expect(isVisiblePos).toBeGreaterThan(-1);
    expect(setRootNullPos).toBeGreaterThan(-1);
    expect(isVisiblePos).toBeLessThan(setRootNullPos);
  });

  it('documents Req 9.8 zero visible pixels policy', () => {
    expect(compositionCpp).toContain('Req 9.8');
  });
});

// ====================================================================
// Failure cleanup — deterministic COM resource release
// ====================================================================

describe('Failure cleanup — deterministic COM resource release', () => {
  it('Destroy() calls Close() on the controller', () => {
    const destroyStart = compositionCpp.indexOf(
      'void CompositionHost::Destroy()',
    );
    const destroyEnd = compositionCpp.indexOf(
      'bool CompositionHost::IsReady()',
    );
    const destroyMethod = compositionCpp.substring(destroyStart, destroyEnd);

    expect(destroyMethod).toContain('controller_->Close()');
  });

  it('COM pointers are Reset() in reverse creation order', () => {
    const destroyStart = compositionCpp.indexOf(
      'void CompositionHost::Destroy()',
    );
    const destroyEnd = compositionCpp.indexOf(
      'bool CompositionHost::IsReady()',
    );
    const destroyMethod = compositionCpp.substring(destroyStart, destroyEnd);

    // Expected reverse order:
    // 1. controller3_, controller_, compositionController_ (WebView2 controller layer)
    // 2. webviewEnvironment_ (environment)
    // 3. rootVisual_ (visual)
    // 4. dcompTarget_ (target)
    // 5. dcompDevice_ (device — created first, released last)
    const controller3Pos = destroyMethod.indexOf('controller3_.Reset()');
    const controllerPos = destroyMethod.indexOf('controller_.Reset()');
    const compCtrlPos = destroyMethod.indexOf('compositionController_.Reset()');
    const envPos = destroyMethod.indexOf('webviewEnvironment_.Reset()');
    const visualPos = destroyMethod.indexOf('rootVisual_.Reset()');
    const targetPos = destroyMethod.indexOf('dcompTarget_.Reset()');
    const devicePos = destroyMethod.indexOf('dcompDevice_.Reset()');

    expect(controller3Pos).toBeGreaterThan(-1);
    expect(controllerPos).toBeGreaterThan(-1);
    expect(compCtrlPos).toBeGreaterThan(-1);
    expect(envPos).toBeGreaterThan(-1);
    expect(visualPos).toBeGreaterThan(-1);
    expect(targetPos).toBeGreaterThan(-1);
    expect(devicePos).toBeGreaterThan(-1);

    // Verify ordering: controller layer → environment → visual → target → device
    expect(controller3Pos).toBeLessThan(controllerPos);
    expect(controllerPos).toBeLessThan(compCtrlPos);
    expect(compCtrlPos).toBeLessThan(envPos);
    expect(envPos).toBeLessThan(visualPos);
    expect(visualPos).toBeLessThan(targetPos);
    expect(targetPos).toBeLessThan(devicePos);
  });

  it('destructor calls Destroy() for RAII safety', () => {
    expect(compositionCpp).toContain('CompositionHost::~CompositionHost()');
    const destructorStart = compositionCpp.indexOf(
      'CompositionHost::~CompositionHost()',
    );
    const destructor = compositionCpp.substring(
      destructorStart,
      destructorStart + 100,
    );
    expect(destructor).toContain('Destroy()');
  });

  it('Destroy() resets state flags before releasing resources', () => {
    const destroyStart = compositionCpp.indexOf(
      'void CompositionHost::Destroy()',
    );
    const destroyEnd = compositionCpp.indexOf(
      'bool CompositionHost::IsReady()',
    );
    const destroyMethod = compositionCpp.substring(destroyStart, destroyEnd);

    // State flags should be reset early
    const webviewReadyPos = destroyMethod.indexOf('webviewReady_ = false');
    const compositionReadyPos = destroyMethod.indexOf(
      'compositionReady_ = false',
    );
    const closePos = destroyMethod.indexOf('controller_->Close()');

    expect(webviewReadyPos).toBeGreaterThan(-1);
    expect(compositionReadyPos).toBeGreaterThan(-1);
    expect(closePos).toBeGreaterThan(-1);
    // State flags reset before resource release
    expect(webviewReadyPos).toBeLessThan(closePos);
    expect(compositionReadyPos).toBeLessThan(closePos);
  });
});

// ====================================================================
// Mode support (Req 9.9)
// ====================================================================

describe('Mode support (Req 9.9)', () => {
  it('OverlayMode enum has exactly 3 values: Compact, Expanded, Maximized', () => {
    // Check the enum contains exactly these three values
    expect(overlayModeH).toContain('Compact');
    expect(overlayModeH).toContain('Expanded');
    expect(overlayModeH).toContain('Maximized');

    // Count enum values by matching assignment patterns
    const enumValues = overlayModeH.match(
      /^\s+\w+\s*=\s*\d+/gm,
    );
    expect(enumValues).not.toBeNull();
    expect(enumValues!.length).toBe(3);
  });

  it('OverlayMode values are sequential starting from 0', () => {
    const compactMatch = overlayModeH.match(/Compact\s*=\s*(\d+)/);
    const expandedMatch = overlayModeH.match(/Expanded\s*=\s*(\d+)/);
    const maximizedMatch = overlayModeH.match(/Maximized\s*=\s*(\d+)/);

    expect(compactMatch).not.toBeNull();
    expect(expandedMatch).not.toBeNull();
    expect(maximizedMatch).not.toBeNull();

    expect(Number(compactMatch![1])).toBe(0);
    expect(Number(expandedMatch![1])).toBe(1);
    expect(Number(maximizedMatch![1])).toBe(2);
  });

  it('OverlayMode is a uint8_t scoped enum', () => {
    expect(overlayModeH).toMatch(
      /enum\s+class\s+OverlayMode\s*:\s*std::uint8_t/,
    );
  });

  it('SetMode does not trigger service logic (only records mode)', () => {
    // The SetMode implementation should only assign mode_ and nothing else
    const setModeStart = compositionCpp.indexOf(
      'void CompositionHost::SetMode(',
    );
    const setModeEnd = compositionCpp.indexOf(
      'void CompositionHost::Destroy()',
    );
    const setModeMethod = compositionCpp.substring(setModeStart, setModeEnd);

    // Should contain only mode assignment, no IPC, no resize, no commit
    expect(setModeMethod).toContain('mode_ = mode');
    expect(setModeMethod).not.toContain('Resize');
    expect(setModeMethod).not.toContain('Commit');
    expect(setModeMethod).not.toContain('SendMessage');
    expect(setModeMethod).not.toContain('PostMessage');
  });

  it('mode does not affect visibility or composition tree', () => {
    // Extract only the SetMode function body (up to its closing brace)
    const setModeStart = compositionCpp.indexOf(
      'void CompositionHost::SetMode(',
    );
    // Find the opening brace of the function body
    const openBrace = compositionCpp.indexOf('{', setModeStart);
    // Find the matching closing brace (simple: first } after open brace for this short function)
    const closeBrace = compositionCpp.indexOf('}', openBrace + 1);
    const setModeBody = compositionCpp.substring(openBrace, closeBrace + 1);

    expect(setModeBody).not.toContain('SetVisible');
    expect(setModeBody).not.toContain('SetRoot');
    expect(setModeBody).not.toContain('put_IsVisible');
  });

  it('documents Req 9.9 in overlay_mode.h', () => {
    expect(overlayModeH).toContain('9.9');
  });
});
