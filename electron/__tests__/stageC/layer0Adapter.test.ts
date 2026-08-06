/**
 * Layer0Adapter — Unit Tests
 *
 * Verifies that the Layer0Adapter:
 * 1. Delegates all operations to existing OverlayManager functions
 * 2. Does NOT modify overlayManager.ts source (tested by absence of new logic)
 * 3. Dashboard behavior is unchanged (adapter never touches Dashboard)
 * 4. The adapter is a thin wrapper (no new business logic)
 *
 * Also tests the CanonicalProjectionOwner:
 * - Holds authoritative state
 * - Updates only via validated intents
 * - Produces projections via ProjectionBuilder
 *
 * Requirements: 1.6–1.8, 18.1–18.6, 18.9
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createLayer0Adapter,
  createCanonicalProjectionOwner,
  type Layer0AdapterInterface,
  type CanonicalProjectionOwner,
} from '../../stageC/layer0Adapter';
import { ProjectionBuilder, type CanonicalOverlayState } from '../../stageC/projectionBuilder';
import type { OverlayMode, DipRectangle } from '../../stageC/protocol/schema';

// ────────────────────────────────────────────────────────────────────
// Mock OverlayManager
// ────────────────────────────────────────────────────────────────────

function createMockOverlayManager() {
  const mockWindow = {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    getBounds: vi.fn(() => ({ x: 100, y: 200, width: 400, height: 300 })),
  };

  return {
    create: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    resize: vi.fn(),
    move: vi.fn(),
    setContentProtection: vi.fn(() => true),
    getWindow: vi.fn(() => mockWindow),
    getBounds: vi.fn(() => ({ x: 100, y: 200, width: 400, height: 300 })),
    // Expose mock window for test manipulation
    _mockWindow: mockWindow,
  };
}

// ────────────────────────────────────────────────────────────────────
// Layer0Adapter Tests
// ────────────────────────────────────────────────────────────────────

describe('Layer0Adapter — delegation to OverlayManager', () => {
  let mockOm: ReturnType<typeof createMockOverlayManager>;
  let adapter: Layer0AdapterInterface;

  beforeEach(() => {
    mockOm = createMockOverlayManager();
    adapter = createLayer0Adapter(mockOm as any);
  });

  // ── Req 18.2: access through adapter without rewriting ────────────

  it('ensureCreated() delegates to OverlayManager.create()', () => {
    adapter.ensureCreated();
    expect(mockOm.create).toHaveBeenCalledTimes(1);
  });

  it('show() delegates to OverlayManager.show()', () => {
    adapter.show();
    expect(mockOm.show).toHaveBeenCalledTimes(1);
  });

  it('hide() delegates to OverlayManager.hide()', () => {
    adapter.hide();
    expect(mockOm.hide).toHaveBeenCalledTimes(1);
  });

  it('setCaptureProtection() delegates to OverlayManager.setContentProtection()', () => {
    const result = adapter.setCaptureProtection(true);
    expect(mockOm.setContentProtection).toHaveBeenCalledWith(true);
    expect(result).toBe(true);
  });

  it('setCaptureProtection(false) passes false to setContentProtection', () => {
    adapter.setCaptureProtection(false);
    expect(mockOm.setContentProtection).toHaveBeenCalledWith(false);
  });

  it('applyState() delegates to OverlayManager.resize()', () => {
    const bounds: DipRectangle = { left: 50, top: 100, width: 500, height: 200 };
    adapter.applyState(bounds, 'expanded' as OverlayMode);
    expect(mockOm.resize).toHaveBeenCalledWith(500, 200);
  });

  it('setBounds() delegates to OverlayManager.move() and resize()', () => {
    const bounds: DipRectangle = { left: 75, top: 150, width: 600, height: 250 };
    adapter.setBounds(bounds);
    expect(mockOm.move).toHaveBeenCalledWith(75, 150);
    expect(mockOm.resize).toHaveBeenCalledWith(600, 250);
  });

  // ── Req 18.9: retain a usable Layer 0 path ─────────────────────────

  it('isUsable() returns true when window exists and is not destroyed', () => {
    expect(adapter.isUsable()).toBe(true);
  });

  it('isUsable() returns false when window is null', () => {
    mockOm.getWindow.mockReturnValue(null);
    expect(adapter.isUsable()).toBe(false);
  });

  it('isUsable() returns false when window is destroyed', () => {
    mockOm._mockWindow.isDestroyed.mockReturnValue(true);
    expect(adapter.isUsable()).toBe(false);
  });

  // ── State queries ──────────────────────────────────────────────────

  it('isVisible() reads from the underlying window', () => {
    mockOm._mockWindow.isVisible.mockReturnValue(true);
    expect(adapter.isVisible()).toBe(true);

    mockOm._mockWindow.isVisible.mockReturnValue(false);
    expect(adapter.isVisible()).toBe(false);
  });

  it('isVisible() returns false when window is null', () => {
    mockOm.getWindow.mockReturnValue(null);
    expect(adapter.isVisible()).toBe(false);
  });

  it('getBounds() converts Electron.Rectangle to DipRectangle', () => {
    const bounds = adapter.getBounds();
    expect(bounds).toEqual({
      left: 100,
      top: 200,
      width: 400,
      height: 300,
    });
  });

  it('getBounds() returns null when OverlayManager has no bounds', () => {
    mockOm.getBounds.mockReturnValue(null);
    expect(adapter.getBounds()).toBeNull();
  });

  // ── Req 18.1: adapter does not add new logic ──────────────────────

  it('does not call any OverlayManager method during construction', () => {
    const freshMock = createMockOverlayManager();
    createLayer0Adapter(freshMock as any);
    expect(freshMock.create).not.toHaveBeenCalled();
    expect(freshMock.show).not.toHaveBeenCalled();
    expect(freshMock.hide).not.toHaveBeenCalled();
    expect(freshMock.resize).not.toHaveBeenCalled();
    expect(freshMock.move).not.toHaveBeenCalled();
    expect(freshMock.setContentProtection).not.toHaveBeenCalled();
  });

  // ── Req 1.6: Layer 0 available without restarting App Core ────────

  it('ensureCreated() is idempotent (delegates to OverlayManager.create() which is idempotent)', () => {
    adapter.ensureCreated();
    adapter.ensureCreated();
    adapter.ensureCreated();
    expect(mockOm.create).toHaveBeenCalledTimes(3);
    // OverlayManager.create() internally checks `if (this.window) return;`
    // The adapter just delegates — it adds no new idempotency logic.
  });

  // ── Req 1.7: Stage C replacement limited to floating overlay ──────

  it('adapter only wraps overlay operations, never references Dashboard', () => {
    // The adapter interface has no Dashboard methods.
    // This test verifies the adapter type only contains overlay operations.
    const methods = Object.keys(adapter);
    expect(methods).not.toContain('createDashboard');
    expect(methods).not.toContain('showDashboard');
    expect(methods).not.toContain('hideDashboard');
    expect(methods).not.toContain('dashboardStartup');
  });
});

// ────────────────────────────────────────────────────────────────────
// Canonical Projection Owner Tests
// ────────────────────────────────────────────────────────────────────

describe('CanonicalProjectionOwner — state ownership and projection', () => {
  let projectionBuilder: ProjectionBuilder;
  let owner: CanonicalProjectionOwner;

  beforeEach(() => {
    projectionBuilder = new ProjectionBuilder();
    owner = createCanonicalProjectionOwner(projectionBuilder);
  });

  // ── Req 8.1: sole canonical state owner ────────────────────────────

  it('getState() returns the current canonical state', () => {
    const state = owner.getState();
    expect(state).toHaveProperty('visible');
    expect(state).toHaveProperty('mode');
    expect(state).toHaveProperty('bounds_dip');
    expect(state).toHaveProperty('capture_protection');
  });

  it('getState() returns a copy — external mutations do not affect canonical state', () => {
    const state1 = owner.getState();
    state1.visible = true;
    state1.mode = 'expanded' as OverlayMode;

    const state2 = owner.getState();
    expect(state2.visible).toBe(false); // unchanged
    expect(state2.mode).toBe('compact');
  });

  // ── Req 8.4: updates only via validated intents ────────────────────

  it('updateState() merges partial updates into canonical state', () => {
    owner.updateState({ visible: true, mode: 'expanded' as OverlayMode });
    const state = owner.getState();
    expect(state.visible).toBe(true);
    expect(state.mode).toBe('expanded');
    // Unchanged fields remain
    expect(state.capture_protection).toBe(true);
  });

  it('updateState() can update bounds', () => {
    const newBounds: DipRectangle = { left: 10, top: 20, width: 800, height: 600 };
    owner.updateState({ bounds_dip: newBounds });
    expect(owner.getState().bounds_dip).toEqual(newBounds);
  });

  it('updateState() can update capture protection', () => {
    owner.updateState({ capture_protection: false });
    expect(owner.getState().capture_protection).toBe(false);
  });

  // ── Req 8.9: produce projections via ProjectionBuilder ─────────────

  it('buildSnapshot() produces a valid OverlayProjection with incrementing revision', () => {
    owner.updateState({ visible: true, mode: 'compact' as OverlayMode });
    const snap = owner.buildSnapshot();

    expect(snap.revision).toBe(1);
    expect(snap.visibility_requested).toBe(true);
    expect(snap.mode).toBe('compact');
    expect(snap.capture_protection).toBe(true);
    expect(snap.bounds_dip).toBeDefined();
    expect(snap.render_state).toBeDefined();
  });

  it('buildSnapshot() increments revision on each call', () => {
    const snap1 = owner.buildSnapshot();
    const snap2 = owner.buildSnapshot();
    expect(snap2.revision).toBe(snap1.revision + 1);
  });

  it('buildPatch() returns null when no state changes occurred', () => {
    owner.buildSnapshot(); // Establish baseline
    const patch = owner.buildPatch();
    expect(patch).toBeNull();
  });

  it('buildPatch() detects visibility change', () => {
    owner.buildSnapshot(); // Establish baseline
    owner.updateState({ visible: true });
    const patch = owner.buildPatch();
    expect(patch).not.toBeNull();
    expect(patch!.visibility_requested).toBe(true);
    expect(patch!.next_revision).toBeGreaterThan(patch!.base_revision);
  });

  it('buildPatch() detects bounds change', () => {
    owner.buildSnapshot(); // Establish baseline
    owner.updateState({ bounds_dip: { left: 50, top: 50, width: 300, height: 200 } });
    const patch = owner.buildPatch();
    expect(patch).not.toBeNull();
    expect(patch!.bounds_dip).toEqual({ left: 50, top: 50, width: 300, height: 200 });
  });

  it('buildPatch() detects mode change', () => {
    owner.buildSnapshot();
    owner.updateState({ mode: 'maximized' as OverlayMode });
    const patch = owner.buildPatch();
    expect(patch).not.toBeNull();
    expect(patch!.mode).toBe('maximized');
  });

  it('buildPatch() detects capture_protection change', () => {
    owner.buildSnapshot();
    owner.updateState({ capture_protection: false });
    const patch = owner.buildPatch();
    expect(patch).not.toBeNull();
    expect(patch!.capture_protection).toBe(false);
  });

  // ── Projection reset ───────────────────────────────────────────────

  it('resetProjection() clears the last projected state; next buildPatch returns null', () => {
    owner.buildSnapshot();
    owner.updateState({ visible: true });
    owner.resetProjection();
    // After reset, buildPatch returns null (no baseline to compare against)
    const patch = owner.buildPatch();
    expect(patch).toBeNull();
  });

  it('resetProjection() does not reset revision (monotonically increasing)', () => {
    owner.buildSnapshot(); // rev 1
    owner.buildSnapshot(); // rev 2
    const revBefore = owner.getRevision();
    owner.resetProjection();
    expect(owner.getRevision()).toBe(revBefore);
  });

  it('after resetProjection(), buildSnapshot() continues incrementing revision', () => {
    owner.buildSnapshot(); // rev 1
    owner.resetProjection();
    const snap = owner.buildSnapshot(); // rev 2
    expect(snap.revision).toBe(2);
  });

  // ── Initial state customization ───────────────────────────────────

  it('accepts initial state overrides', () => {
    const customOwner = createCanonicalProjectionOwner(new ProjectionBuilder(), {
      visible: true,
      mode: 'expanded' as OverlayMode,
      bounds_dip: { left: 100, top: 200, width: 800, height: 600 },
      capture_protection: false,
    });

    const state = customOwner.getState();
    expect(state.visible).toBe(true);
    expect(state.mode).toBe('expanded');
    expect(state.bounds_dip).toEqual({ left: 100, top: 200, width: 800, height: 600 });
    expect(state.capture_protection).toBe(false);
  });

  // ── Req 8.6: projection never contains sensitive data ─────────────

  it('buildSnapshot() render_state does not contain sensitive keys', () => {
    owner.updateState({
      visible: true,
      streamingText: 'hello world',
    });
    const snap = owner.buildSnapshot();
    const renderState = snap.render_state;

    // Should NOT have sensitive fields
    expect(renderState).not.toHaveProperty('apiKey');
    expect(renderState).not.toHaveProperty('credentials');
    expect(renderState).not.toHaveProperty('token');
    expect(renderState).not.toHaveProperty('rawAudio');
    expect(renderState).not.toHaveProperty('screenshotBytes');
    expect(renderState).not.toHaveProperty('filePath');

    // Should have safe projected fields
    expect(renderState).toHaveProperty('streamingText', 'hello world');
    expect(renderState).toHaveProperty('visible', true);
  });

  // ── getRevision() ──────────────────────────────────────────────────

  it('getRevision() starts at 0', () => {
    expect(owner.getRevision()).toBe(0);
  });

  it('getRevision() increments after buildSnapshot()', () => {
    owner.buildSnapshot();
    expect(owner.getRevision()).toBe(1);
  });

  it('getRevision() increments after buildPatch() with changes', () => {
    owner.buildSnapshot(); // rev 1
    owner.updateState({ visible: true });
    owner.buildPatch(); // rev 2
    expect(owner.getRevision()).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────
// No-modification verification
// ────────────────────────────────────────────────────────────────────

describe('Layer0Adapter — no source modification verification', () => {
  it('adapter module does not import from win32/ directory (no Stage A/B coupling)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const adapterPath = path.resolve(__dirname, '../../stageC/layer0Adapter.ts');
    const source = fs.readFileSync(adapterPath, 'utf-8');

    // The adapter should NOT import from win32/ — it delegates to OverlayManager
    expect(source).not.toContain("from '../win32/");
    expect(source).not.toContain("from '../../win32/");
  });

  it('adapter module does not import Electron directly (delegates through OverlayManager)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const adapterPath = path.resolve(__dirname, '../../stageC/layer0Adapter.ts');
    const source = fs.readFileSync(adapterPath, 'utf-8');

    // The adapter wraps OverlayManager — it should not import Electron APIs
    expect(source).not.toContain("require('electron')");
    expect(source).not.toContain("from 'electron'");
  });

  it('adapter module does not import nativeStealth (Layer 0 handles that internally)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const adapterPath = path.resolve(__dirname, '../../stageC/layer0Adapter.ts');
    const source = fs.readFileSync(adapterPath, 'utf-8');

    expect(source).not.toContain('nativeStealth');
  });
});
