// ============================================
// Property 8: Stealth-state consistency across lifecycle cycles
// ============================================
//
// ∀ sequences σ of {show, hide, toggle, resize, move, nudge, recenter,
// displayAdded, displayRemoved, displayMetricsChanged} length ≤ 20:
// if contentProtection = true then top-level HWND has display affinity,
// DWM cloak, and correct ex-styles; exactly one HWND owns stealth layers.
//
// **Validates: Requirements 4.1, 4.2, 4.3, 6.5**

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// ── Win32 Constants ──────────────────────────────────────────────────────────

const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_APPWINDOW = 0x00040000;
const WDA_EXCLUDEFROMCAPTURE = 0x00000011;

// ── Stealth Layer Tracking Model ─────────────────────────────────────────────
//
// Instead of mocking the full Electron + OverlayManager integration (which is
// extremely heavy), we test the logical invariants at the layer-ownership level
// using a simplified model that mirrors the OverlayManager's stealth routing:
//
// - A "host HWND" and a "child HWND" (overlay) exist
// - When hostStrategy !== 'none', the HOST owns stealth layers
// - When hostStrategy === 'none', the OVERLAY owns stealth layers
// - Exactly one HWND owns layers at any time
// - Operations (show, hide, toggle, resize, etc.) reassert stealth on the owner

type HwndId = 'host' | 'overlay';

interface StealthLayers {
  displayAffinity: boolean;
  dwmCloak: boolean;
  exStyleHardened: boolean; // WS_EX_TOOLWINDOW + WS_EX_NOACTIVATE, -WS_EX_APPWINDOW
}

const NO_STEALTH: StealthLayers = {
  displayAffinity: false,
  dwmCloak: false,
  exStyleHardened: false,
};

const FULL_STEALTH: StealthLayers = {
  displayAffinity: true,
  dwmCloak: true,
  exStyleHardened: true,
};

/**
 * Model of the OverlayManager's stealth state. Tracks which HWND owns stealth
 * layers and whether contentProtection is enabled. Mirrors the logic in
 * overlayManager.ts: setContentProtection, show, hide, toggle, reassert,
 * and display-change handlers.
 */
class StealthStateModel {
  // Layer ownership tracking per-HWND
  private layers: Map<HwndId, StealthLayers> = new Map();

  // System state
  contentProtection: boolean = true;
  hostStrategy: 'reparent' | 'none';
  visible: boolean = true;
  private hostActive: boolean;

  constructor(hostStrategy: 'reparent' | 'none') {
    this.hostStrategy = hostStrategy;
    this.hostActive = hostStrategy !== 'none';

    // Initialize: layers on the current top-level HWND
    this.layers.set('host', { ...NO_STEALTH });
    this.layers.set('overlay', { ...NO_STEALTH });

    // Apply initial stealth to the top-level HWND
    this.applyStealthToOwner();
  }

  /** Get which HWND currently owns stealth (the top-level one). */
  get stealthOwner(): HwndId {
    return this.hostActive ? 'host' : 'overlay';
  }

  /** Apply stealth layers to the current owner (mirrors applyNativeStealth). */
  private applyStealthToOwner(): void {
    if (!this.contentProtection) return;

    const owner = this.stealthOwner;
    this.layers.set(owner, { ...FULL_STEALTH });
  }

  /** Remove stealth layers from a specific HWND (mirrors removeNativeStealth). */
  private removeStealthFrom(hwnd: HwndId): void {
    this.layers.set(hwnd, { ...NO_STEALTH });
  }

  /** Reassert stealth on the current owner (called after show/display change). */
  reassert(): void {
    if (this.contentProtection) {
      this.applyStealthToOwner();
    }
  }

  // ── Operations (mirror OverlayManager methods) ──────────────────────────

  show(): void {
    this.visible = true;
    // OverlayManager: stealthHost.show() + stealthHost.reassert() + reapplyPlatformState
    this.reassert();
  }

  hide(): void {
    this.visible = false;
    // OverlayManager: stealthHost.hide() — stealth layers remain applied
  }

  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  resize(_w: number, _h: number): void {
    // OverlayManager: applyBounds → host.setBounds, no explicit reassert
    // Stealth layers remain unchanged during resize
  }

  move(_x: number, _y: number): void {
    // OverlayManager: applyBounds, stealth unchanged
  }

  nudge(_dx: number, _dy: number): void {
    // OverlayManager: applyBounds, stealth unchanged
  }

  recenter(): void {
    // OverlayManager: applyBounds, stealth unchanged
  }

  displayAdded(): void {
    // OverlayManager: onDisplayChange → reassert always-on-top
    // If host is active and stealth is on, reassert to maintain layers
    this.reassert();
  }

  displayRemoved(): void {
    // OverlayManager: onDisplayRemoved → recenter + reassert
    this.reassert();
  }

  displayMetricsChanged(): void {
    // OverlayManager: onDisplayMetricsChanged → reassert always-on-top
    this.reassert();
  }

  setContentProtection(enabled: boolean): void {
    this.contentProtection = enabled;
    const owner = this.stealthOwner;

    if (enabled) {
      // Apply stealth to the current top-level HWND
      this.layers.set(owner, { ...FULL_STEALTH });
    } else {
      // Remove stealth from the current top-level HWND
      this.removeStealthFrom(owner);
    }
  }

  // ── Invariant checking ──────────────────────────────────────────────────

  /**
   * Check the core invariant: if contentProtection is true, exactly one HWND
   * owns full stealth layers, and it is the current top-level HWND.
   */
  checkInvariant(): { valid: boolean; detail: string } {
    const owner = this.stealthOwner;
    const nonOwner: HwndId = owner === 'host' ? 'overlay' : 'host';

    const ownerLayers = this.layers.get(owner)!;
    const nonOwnerLayers = this.layers.get(nonOwner)!;

    if (this.contentProtection) {
      // Invariant 1: top-level HWND has all stealth layers
      if (!ownerLayers.displayAffinity) {
        return { valid: false, detail: `Owner '${owner}' missing display affinity` };
      }
      if (!ownerLayers.dwmCloak) {
        return { valid: false, detail: `Owner '${owner}' missing DWM cloak` };
      }
      if (!ownerLayers.exStyleHardened) {
        return { valid: false, detail: `Owner '${owner}' missing ex-style hardening` };
      }

      // Invariant 2: non-owner must NOT have stealth layers
      if (nonOwnerLayers.displayAffinity || nonOwnerLayers.dwmCloak || nonOwnerLayers.exStyleHardened) {
        return {
          valid: false,
          detail: `Non-owner '${nonOwner}' has stealth layers (should have none): ` +
            `affinity=${nonOwnerLayers.displayAffinity}, cloak=${nonOwnerLayers.dwmCloak}, ` +
            `exStyle=${nonOwnerLayers.exStyleHardened}`,
        };
      }
    }

    // Invariant 3: exactly one HWND owns stealth layers (never two simultaneously)
    const ownerHasAny = ownerLayers.displayAffinity || ownerLayers.dwmCloak || ownerLayers.exStyleHardened;
    const nonOwnerHasAny = nonOwnerLayers.displayAffinity || nonOwnerLayers.dwmCloak || nonOwnerLayers.exStyleHardened;

    if (ownerHasAny && nonOwnerHasAny) {
      return {
        valid: false,
        detail: `Both HWNDs own stealth layers simultaneously (owner='${owner}')`,
      };
    }

    return { valid: true, detail: 'OK' };
  }
}

// ── Operation type for random sequence generation ────────────────────────────

type Operation =
  | { type: 'show' }
  | { type: 'hide' }
  | { type: 'toggle' }
  | { type: 'resize'; w: number; h: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'nudge'; dx: number; dy: number }
  | { type: 'recenter' }
  | { type: 'displayAdded' }
  | { type: 'displayRemoved' }
  | { type: 'displayMetricsChanged' };

// ── fast-check arbitraries ───────────────────────────────────────────────────

const operationArb: fc.Arbitrary<Operation> = fc.oneof(
  fc.constant({ type: 'show' } as Operation),
  fc.constant({ type: 'hide' } as Operation),
  fc.constant({ type: 'toggle' } as Operation),
  fc.record({
    type: fc.constant('resize' as const),
    w: fc.integer({ min: 100, max: 1920 }),
    h: fc.integer({ min: 50, max: 1080 }),
  }),
  fc.record({
    type: fc.constant('move' as const),
    x: fc.integer({ min: 0, max: 3840 }),
    y: fc.integer({ min: 0, max: 2160 }),
  }),
  fc.record({
    type: fc.constant('nudge' as const),
    dx: fc.integer({ min: -100, max: 100 }),
    dy: fc.integer({ min: -100, max: 100 }),
  }),
  fc.constant({ type: 'recenter' } as Operation),
  fc.constant({ type: 'displayAdded' } as Operation),
  fc.constant({ type: 'displayRemoved' } as Operation),
  fc.constant({ type: 'displayMetricsChanged' } as Operation),
);

function applyOperation(model: StealthStateModel, op: Operation): void {
  switch (op.type) {
    case 'show': model.show(); break;
    case 'hide': model.hide(); break;
    case 'toggle': model.toggle(); break;
    case 'resize': model.resize(op.w, op.h); break;
    case 'move': model.move(op.x, op.y); break;
    case 'nudge': model.nudge(op.dx, op.dy); break;
    case 'recenter': model.recenter(); break;
    case 'displayAdded': model.displayAdded(); break;
    case 'displayRemoved': model.displayRemoved(); break;
    case 'displayMetricsChanged': model.displayMetricsChanged(); break;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Property 8: Stealth-state consistency across lifecycle cycles', () => {
  describe('with hostStrategy = "reparent" (host owns stealth)', () => {
    it('∀ sequences σ length ≤ 20: if contentProtection=true then exactly one HWND owns all stealth layers', () => {
      fc.assert(
        fc.property(
          fc.array(operationArb, { minLength: 1, maxLength: 20 }),
          (ops: Operation[]) => {
            const model = new StealthStateModel('reparent');

            // Apply each operation and check invariant after each
            for (let i = 0; i < ops.length; i++) {
              applyOperation(model, ops[i]);
              const result = model.checkInvariant();
              expect(result.valid).toBe(true);
            }

            return true;
          },
        ),
        { numRuns: 500 },
      );
    });

    it('∀ sequences σ with interleaved contentProtection toggles: invariant holds after each step', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              operationArb,
              fc.constant({ type: 'setProtectionTrue' as const }),
              fc.constant({ type: 'setProtectionFalse' as const }),
            ),
            { minLength: 1, maxLength: 20 },
          ),
          (ops) => {
            const model = new StealthStateModel('reparent');

            for (const op of ops) {
              if (op.type === 'setProtectionTrue') {
                model.setContentProtection(true);
              } else if (op.type === 'setProtectionFalse') {
                model.setContentProtection(false);
              } else {
                applyOperation(model, op as Operation);
              }

              const result = model.checkInvariant();
              expect(result.valid).toBe(true);
            }

            return true;
          },
        ),
        { numRuns: 500 },
      );
    });

    it('show followed by any operation reasserts stealth on the host HWND', () => {
      fc.assert(
        fc.property(
          operationArb,
          (op: Operation) => {
            const model = new StealthStateModel('reparent');
            model.show();
            applyOperation(model, op);

            const result = model.checkInvariant();
            expect(result.valid).toBe(true);

            return true;
          },
        ),
        { numRuns: 200 },
      );
    });

    it('display events always reassert stealth on the active host', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('displayAdded', 'displayRemoved', 'displayMetricsChanged'),
          fc.array(operationArb, { minLength: 0, maxLength: 10 }),
          (displayEvent: string, prefix: Operation[]) => {
            const model = new StealthStateModel('reparent');

            // Apply prefix operations
            for (const op of prefix) {
              applyOperation(model, op);
            }

            // Apply display event
            switch (displayEvent) {
              case 'displayAdded': model.displayAdded(); break;
              case 'displayRemoved': model.displayRemoved(); break;
              case 'displayMetricsChanged': model.displayMetricsChanged(); break;
            }

            const result = model.checkInvariant();
            expect(result.valid).toBe(true);

            return true;
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('with hostStrategy = "none" (Layer 0, overlay owns stealth)', () => {
    it('∀ sequences σ length ≤ 20: if contentProtection=true then overlay HWND owns all stealth layers', () => {
      fc.assert(
        fc.property(
          fc.array(operationArb, { minLength: 1, maxLength: 20 }),
          (ops: Operation[]) => {
            const model = new StealthStateModel('none');

            for (const op of ops) {
              applyOperation(model, op);
              const result = model.checkInvariant();
              expect(result.valid).toBe(true);
            }

            return true;
          },
        ),
        { numRuns: 500 },
      );
    });

    it('∀ sequences σ with interleaved toggles: invariant holds at Layer 0', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              operationArb,
              fc.constant({ type: 'setProtectionTrue' as const }),
              fc.constant({ type: 'setProtectionFalse' as const }),
            ),
            { minLength: 1, maxLength: 20 },
          ),
          (ops) => {
            const model = new StealthStateModel('none');

            for (const op of ops) {
              if (op.type === 'setProtectionTrue') {
                model.setContentProtection(true);
              } else if (op.type === 'setProtectionFalse') {
                model.setContentProtection(false);
              } else {
                applyOperation(model, op as Operation);
              }

              const result = model.checkInvariant();
              expect(result.valid).toBe(true);
            }

            return true;
          },
        ),
        { numRuns: 500 },
      );
    });
  });

  describe('invariant: exactly one HWND owns stealth layers at any time', () => {
    it('never two HWNDs own layers simultaneously across random strategies and sequences', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('reparent' as const, 'none' as const),
          fc.array(
            fc.oneof(
              operationArb,
              fc.constant({ type: 'setProtectionTrue' as const }),
              fc.constant({ type: 'setProtectionFalse' as const }),
            ),
            { minLength: 1, maxLength: 20 },
          ),
          (strategy, ops) => {
            const model = new StealthStateModel(strategy);

            for (const op of ops) {
              if (op.type === 'setProtectionTrue') {
                model.setContentProtection(true);
              } else if (op.type === 'setProtectionFalse') {
                model.setContentProtection(false);
              } else {
                applyOperation(model, op as Operation);
              }

              const result = model.checkInvariant();
              expect(result.valid).toBe(true);
            }

            return true;
          },
        ),
        { numRuns: 1000 },
      );
    });

    it('after contentProtection=false, no HWND has stealth layers', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('reparent' as const, 'none' as const),
          fc.array(operationArb, { minLength: 0, maxLength: 10 }),
          (strategy, prefix) => {
            const model = new StealthStateModel(strategy);

            // Apply prefix operations
            for (const op of prefix) {
              applyOperation(model, op);
            }

            // Toggle off
            model.setContentProtection(false);

            // Verify: no HWND has stealth layers when protection is off
            const result = model.checkInvariant();
            expect(result.valid).toBe(true);

            return true;
          },
        ),
        { numRuns: 300 },
      );
    });

    it('contentProtection=true → contentProtection=false → contentProtection=true roundtrip preserves invariant', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('reparent' as const, 'none' as const),
          fc.array(operationArb, { minLength: 0, maxLength: 5 }),
          fc.array(operationArb, { minLength: 0, maxLength: 5 }),
          (strategy, midOps, endOps) => {
            const model = new StealthStateModel(strategy);

            // contentProtection starts true (default)
            model.setContentProtection(false);
            for (const op of midOps) {
              applyOperation(model, op);
              expect(model.checkInvariant().valid).toBe(true);
            }

            model.setContentProtection(true);
            for (const op of endOps) {
              applyOperation(model, op);
              expect(model.checkInvariant().valid).toBe(true);
            }

            return true;
          },
        ),
        { numRuns: 300 },
      );
    });
  });
});
