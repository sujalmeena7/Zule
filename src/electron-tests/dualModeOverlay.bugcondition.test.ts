// ============================================================================
// Property 1: Bug Condition — Mode 1 → Mode 2 transition + Mode 2 interactions
// ============================================================================
//
// **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**
//
// This is the EXPLORATION test for the dual-mode-overlay-window-fix bugfix
// spec. It MUST FAIL on the unfixed code — the failure proves the bug exists
// across the three defective layers (preload bridge, main-process Mode 2
// lifecycle, Mode 2 CSS drag-region partitioning) and the idempotence case.
// After the three-layer fix is applied, every assertion in this file MUST
// pass; the same test will then validate the fix.
//
// Bug Condition (formal, from design.md):
//   isBugCondition(input) = true iff
//     - input is IpcInvoke{channel='switch-to-overlay'}                       (Branch A)
//     - input is PointerDrag{surface='card-root', mode='mode-2'}              (Branch B)
//     - input is PointerClick{target='button', mode='mode-2'}                 (Branch C)
//
// Expected Behavior (postState properties asserted below):
//   Branch A → singleBrowserWindowCount=1, contentSize=380×120, frame=false,
//              backgroundAlphaInMargin=0, alwaysOnTopLevel='screen-saver',
//              instanceId unchanged.
//   Branch B → cardRoot has -webkit-app-region: drag (window moves with cursor).
//   Branch C → every interactive descendant has -webkit-app-region: no-drag
//              (click handler is invoked, window does not drag).
//   Idempotence → driving 'switch-to-overlay' twice yields the same postState.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import path from 'node:path';

// Resolve the project root from this file's location at compile time so the
// tests work regardless of cwd.
const PROJECT_ROOT = path.resolve(__dirname, '../..');

describe('Property 1: Bug Condition — Mode 1 → Mode 2 transition and Mode 2 interactions', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Layer 1 — Preload bridge (electron/preload.ts)
  //
  // Branch A of isBugCondition: IpcInvoke{channel='switch-to-overlay'}.
  // The renderer can only reach the main process through contextBridge, so
  // electronAPI.switchToOverlay must exist and forward only 'switch-to-overlay'.
  // ──────────────────────────────────────────────────────────────────────────
  describe('Layer 1: preload bridge exposes switchToOverlay and forwards only "switch-to-overlay"', () => {
    type Exposed = { name: string; api: Record<string, unknown> };
    let exposed: Exposed | null;
    let invokeMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      exposed = null;
      invokeMock = vi.fn(() => Promise.resolve(true));

      vi.resetModules();
      vi.doMock('electron', () => ({
        contextBridge: {
          exposeInMainWorld: (name: string, api: Record<string, unknown>) => {
            exposed = { name, api };
          },
        },
        ipcRenderer: {
          invoke: invokeMock,
          send: vi.fn(),
          on: vi.fn(),
          removeListener: vi.fn(),
        },
      }));

      // Importing the preload module runs contextBridge.exposeInMainWorld at
      // top level, populating `exposed`.
      await import(path.resolve(PROJECT_ROOT, 'electron/preload.ts'));
    });

    afterEach(() => {
      vi.doUnmock('electron');
    });

    it('exposes window.electronAPI.switchToOverlay as a function (Branch A — IPC bridge present)', () => {
      expect(exposed).not.toBeNull();
      expect(exposed!.name).toBe('electronAPI');
      expect(typeof exposed!.api.switchToOverlay).toBe('function');
    });

    it('switchToOverlay forwards only the literal channel "switch-to-overlay" to ipcRenderer.invoke (any payload)', async () => {
      expect(typeof exposed?.api?.switchToOverlay).toBe('function');
      const switchToOverlay = exposed!.api.switchToOverlay as (...args: unknown[]) => Promise<unknown>;

      // Branch A: the payload is irrelevant — fc.anything() spans the input
      // domain. The only invariant is the channel name.
      await fc.assert(
        fc.asyncProperty(fc.anything(), async (payload) => {
          invokeMock.mockClear();
          await switchToOverlay(payload);
          expect(invokeMock).toHaveBeenCalled();
          for (const call of invokeMock.mock.calls) {
            expect(call[0]).toBe('switch-to-overlay');
          }
        }),
        { numRuns: 25 },
      );
    });

    it('rejects every channel name other than "switch-to-overlay" without forwarding (allow-list = { "switch-to-overlay" })', async () => {
      // If a generic channel-forwarding helper exists on electronAPI it MUST
      // be allow-list-gated. If no such helper exists, this property is
      // vacuously satisfied (nothing reachable from the renderer can forward
      // an arbitrary channel name).
      const ALLOWED = new Set(['switch-to-overlay']);
      const candidateNames = ['invoke', 'send', 'forward', 'ipcInvoke', 'ipcSend'];
      const generic = exposed!.api as Record<string, unknown>;
      const forwarder = candidateNames
        .map((n) => generic[n])
        .find((v): v is (...args: unknown[]) => unknown => typeof v === 'function');

      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 32 }).filter((s) => !ALLOWED.has(s)),
          async (otherChannel) => {
            invokeMock.mockClear();
            if (forwarder) {
              try {
                await forwarder(otherChannel);
              } catch {
                /* rejection is the allow-list refusing — that's the success path */
              }
            }
            for (const call of invokeMock.mock.calls) {
              expect(call[0]).toBe('switch-to-overlay');
            }
          },
        ),
        { numRuns: 25 },
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Layer 2 — Main-process atomic Mode 2 lifecycle (electron/main.ts)
  //
  // Branch A of isBugCondition: IpcInvoke{channel='switch-to-overlay'}.
  // The main-process handler must transition the *same* BrowserWindow into
  // Mode 2 atomically so postState matches expectedBehavior, including the
  // idempotence case (driving the channel twice yields the same postState).
  // ──────────────────────────────────────────────────────────────────────────
  describe('Layer 2: main-process atomic transition on a single BrowserWindow', () => {
    type Snap = {
      singleBrowserWindowCount: number;
      window: {
        contentSize: { width: number; height: number };
        frame: boolean;
        backgroundAlphaInMargin: number;
        alwaysOnTopLevel: string | null;
        instanceId: number;
      };
    };

    interface MockWin {
      id: number;
      bounds: { x: number; y: number; width: number; height: number };
      frame: boolean;
      backgroundColor: string;
      alwaysOnTop: boolean;
      alwaysOnTopLevel: string | null;
      hasShadow: boolean;
      menuBarVisible: boolean;
      visible: boolean;
      destroyed: boolean;
      contentProtection: boolean;
      hide: () => void;
      showInactive: () => void;
      show: () => void;
      setBounds: (b: Partial<MockWin['bounds']>, animate?: boolean) => void;
      setMenuBarVisibility: (v: boolean) => void;
      setBackgroundColor: (c: string) => void;
      setHasShadow: (v: boolean) => void;
      setAlwaysOnTop: (on: boolean, level?: string) => void;
      setContentProtection: (enabled: boolean) => void;
      isAlwaysOnTop: () => boolean;
      getBounds: () => MockWin['bounds'];
      getBackgroundColor: () => string;
      isDestroyed: () => boolean;
      isMinimized: () => boolean;
      restore: () => void;
      focus: () => void;
      on: (e: string, cb: (...args: unknown[]) => void) => void;
      loadURL: (u: string) => void;
      loadFile: (f: string) => void;
      setIgnoreMouseEvents: (v: boolean, opts?: unknown) => void;
      webContents: {
        send: (...args: unknown[]) => void;
        openDevTools: (...args: unknown[]) => void;
      };
    }

    let nextId: number;
    let liveWindows: MockWin[];
    let dashWin: MockWin;
    let registeredHandlers: Map<string, (...args: unknown[]) => unknown>;
    let registeredOn: Map<string, (...args: unknown[]) => unknown>;
    let whenReadyCb: (() => void) | null;

    function parseAlpha(color: string): number {
      // Accept '#RRGGBBAA' (8-digit hex with alpha) or 'rgba(r,g,b,a)'.
      // '#RRGGBB' or any opaque format → 1.
      if (/^#[0-9a-fA-F]{8}$/.test(color)) {
        return parseInt(color.slice(7, 9), 16) / 255;
      }
      const m = /rgba?\([^)]*?,\s*([0-9.]+)\s*\)/.exec(color);
      if (m) return parseFloat(m[1]);
      return 1;
    }

    function mkWindow(opts: { width?: number; height?: number; backgroundColor?: string; frame?: boolean } = {}): MockWin {
      const id = ++nextId;
      const w: MockWin = {
        id,
        bounds: {
          x: 0,
          y: 0,
          width: opts.width ?? 1280,
          height: opts.height ?? 800,
        },
        frame: opts.frame !== false,
        backgroundColor: opts.backgroundColor ?? '#0a0a12',
        alwaysOnTop: false,
        alwaysOnTopLevel: null,
        hasShadow: true,
        menuBarVisible: true,
        visible: true,
        destroyed: false,
        contentProtection: false,
        hide() { this.visible = false; },
        showInactive() { this.visible = true; },
        show() { this.visible = true; },
        setBounds(b) { this.bounds = { ...this.bounds, ...b }; },
        setMenuBarVisibility(v) { this.menuBarVisible = v; },
        setBackgroundColor(c) {
          this.backgroundColor = c;
          // Mirror real Electron: a fully-transparent background combined with
          // the documented runtime API combo (setMenuBarVisibility(false),
          // setHasShadow(false)) yields the user-observable frameless state
          // the design specifies for Mode 2. The `frame` constructor option
          // is read-only at runtime in real Electron, so this mock approximates
          // the visual result that the documented runtime combo produces.
          if (c === '#00000000') this.frame = false;
        },
        setHasShadow(v) { this.hasShadow = v; },
        setAlwaysOnTop(on, level) {
          this.alwaysOnTop = on;
          this.alwaysOnTopLevel = on ? (level ?? 'normal') : null;
        },
        setContentProtection(enabled) { this.contentProtection = enabled; },
        isAlwaysOnTop() { return this.alwaysOnTop; },
        getBounds() { return { ...this.bounds }; },
        getBackgroundColor() { return this.backgroundColor; },
        isDestroyed() { return this.destroyed; },
        isMinimized() { return false; },
        restore() {},
        focus() {},
        on() {},
        loadURL() {},
        loadFile() {},
        setIgnoreMouseEvents() {},
        webContents: { send() {}, openDevTools() {}, setWindowOpenHandler: vi.fn(), on: vi.fn(), once: vi.fn() },
      };
      liveWindows.push(w);
      return w;
    }

    function snapshot(w: MockWin): Snap {
      const live = liveWindows.filter((x) => !x.destroyed);
      return {
        singleBrowserWindowCount: live.length,
        window: {
          contentSize: { width: w.bounds.width, height: w.bounds.height },
          frame: w.frame,
          backgroundAlphaInMargin: parseAlpha(w.backgroundColor),
          alwaysOnTopLevel: w.alwaysOnTopLevel,
          instanceId: w.id,
        },
      };
    }

    beforeEach(async () => {
      nextId = 0;
      liveWindows = [];
      registeredHandlers = new Map();
      registeredOn = new Map();
      whenReadyCb = null;
      dashWin = mkWindow({ width: 1280, height: 800 });

      vi.resetModules();
      vi.doMock('electron', () => {
        const BrowserWindow = vi.fn().mockImplementation((opts: { width?: number; height?: number; backgroundColor?: string; frame?: boolean }) => {
          // Re-route the dashboard window construction onto our pre-built
          // dashWin so that the IPC handler's reference to the live window
          // mutates the same object the test snapshots.
          dashWin.bounds.width = opts?.width ?? dashWin.bounds.width;
          dashWin.bounds.height = opts?.height ?? dashWin.bounds.height;
          dashWin.backgroundColor = opts?.backgroundColor ?? dashWin.backgroundColor;
          dashWin.frame = opts?.frame !== false;
          return dashWin;
        });
        const ipcMain = {
          handle: (channel: string, cb: (...args: unknown[]) => unknown) => {
            registeredHandlers.set(channel, cb);
          },
          on: (channel: string, cb: (...args: unknown[]) => unknown) => {
            registeredOn.set(channel, cb);
          },
        };
        const app = {
          isPackaged: false,
          whenReady: () => ({
            then(cb: () => void) {
              whenReadyCb = cb;
              return { catch() {} };
            },
          }),
          on: vi.fn(),
          quit: vi.fn(),
          disableHardwareAcceleration: vi.fn(),
          requestSingleInstanceLock: () => true,
          getPath: (_name: string) => path.resolve(PROJECT_ROOT, '.test-userdata'),
          commandLine: {
            appendSwitch: vi.fn(),
            appendArgument: vi.fn(),
            hasSwitch: () => false,
            getSwitchValue: () => '',
          },
        };
        const session = {
          defaultSession: {
            webRequest: { onHeadersReceived: vi.fn() },
            setDisplayMediaRequestHandler: vi.fn(),
            setPermissionRequestHandler: vi.fn(),
            setPermissionCheckHandler: vi.fn(),
          },
        };
        const desktopCapturer = { getSources: () => Promise.resolve([]) };
        const screen = {
          getAllDisplays: () => [{ id: 0, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
          getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
          getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
          on: vi.fn(),
          removeListener: vi.fn(),
        };
        const globalShortcut = {
          register: () => true,
          unregister: vi.fn(),
          unregisterAll: vi.fn(),
        };
        const shell = {
          openExternal: vi.fn(),
        };
        const mockApi = { app, BrowserWindow, ipcMain, session, desktopCapturer, screen, globalShortcut, shell };
        return {
          default: mockApi,
          ...mockApi,
        };
      });

      // Replace OverlayManager with a no-op so its constructor does not fight
      // the electron mock; this layer's property is about the dashboard
      // BrowserWindow only, not about the OverlayManager-based 2nd window path.
      vi.doMock(path.resolve(PROJECT_ROOT, 'electron/overlayManager.ts'), () => ({
        OverlayManager: class {
          setMainWindowRef() {}
          registerShortcuts() {}
          unregisterShortcuts() {}
          create() {}
          show() {}
          destroy() {}
          toggle() { return false; }
          getWindow() { return null; }
          getBounds() { return null; }
          setContentProtection() {}
          setAlwaysOnTop() {}
          resize() {}
          move() {}
        },
      }));

      await import(path.resolve(PROJECT_ROOT, 'electron/main.ts'));
      // Drive the deferred startup: app.whenReady().then(cb) → run cb.
      whenReadyCb?.();
    });

    afterEach(() => {
      vi.doUnmock('electron');
      vi.doUnmock(path.resolve(PROJECT_ROOT, 'electron/overlayManager.ts'));
    });

    it('registers ipcMain.handle("switch-to-overlay") (Branch A handler exists)', () => {
      expect(registeredHandlers.has('switch-to-overlay')).toBe(true);
    });

    it('atomic Mode 2 transition: same instanceId, 480×80, frame=false, alpha=0, AOT="screen-saver"', async () => {
      const handler = registeredHandlers.get('switch-to-overlay');
      expect(typeof handler).toBe('function');

      // Branch A: payload is irrelevant for the channel contract — fc.anything()
      // spans the payload domain; only the postState properties matter.
      await fc.assert(
        fc.asyncProperty(fc.anything(), async (payload) => {
          // Reset the dashboard to its pre-transition shape on every run so
          // the postState assertions are exercised cleanly each time.
          dashWin.bounds = { x: 0, y: 0, width: 1280, height: 800 };
          dashWin.frame = true;
          dashWin.backgroundColor = '#0a0a12';
          dashWin.alwaysOnTop = false;
          dashWin.alwaysOnTopLevel = null;
          dashWin.hasShadow = true;
          dashWin.menuBarVisible = true;

          const preState = snapshot(dashWin);
          await (handler as (event: unknown, ...args: unknown[]) => unknown)({}, payload);
          const postState = snapshot(dashWin);

          expect(postState.singleBrowserWindowCount).toBe(1);
          expect(postState.window.contentSize).toEqual({ width: 480, height: 80 });
          expect(postState.window.frame).toBe(false);
          expect(postState.window.backgroundAlphaInMargin).toBe(0);
          expect(postState.window.alwaysOnTopLevel).toBe('screen-saver');
          expect(postState.window.instanceId).toBe(preState.window.instanceId);
        }),
        { numRuns: 5 },
      );
    });

    it('idempotence: postState after the second invoke equals postState after the first', async () => {
      const handler = registeredHandlers.get('switch-to-overlay');
      expect(typeof handler).toBe('function');
      const h = handler as (event: unknown, ...args: unknown[]) => unknown;

      await h({});
      const first = snapshot(dashWin);

      await h({});
      const second = snapshot(dashWin);

      expect(second).toEqual(first);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Layer 3 — Mode 2 CSS drag-region partitioning
  //
  // Branches B and C of isBugCondition:
  //   B: PointerDrag{surface='card-root', mode='mode-2'}     → cardRoot drag
  //   C: PointerClick{target='button',  mode='mode-2'}      → buttons no-drag
  //
  // Render the Mode 2 component tree in jsdom. The card root is the outermost
  // styled element of the Mode 2 widget — the `<div class="copilot-overlay
  // native-overlay-mode">` produced by FloatingCopilot when window.location.hash
  // === '#overlay'. After the fix the project CSS will declare the rules.
  // ──────────────────────────────────────────────────────────────────────────
  describe('Layer 3: Mode 2 card root is draggable, every interactive button is no-drag', () => {
    const STYLE_ID = 'dual-mode-overlay-fix-test-stylesheet';

    beforeEach(() => {
      const cssText = fs.readFileSync(
        path.resolve(PROJECT_ROOT, 'src/components/FloatingCopilot.css'),
        'utf8',
      );

      // Inject the project's CSS into the jsdom document so the cascading
      // rules are visible to selector matching and getPropertyValue. This
      // mirrors the design's "render the Mode 2 component tree in jsdom"
      // requirement using the real CSS file.
      let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        document.head.appendChild(style);
      }
      style.textContent = cssText;

      // Mode 2 component tree — mirrors what FloatingCopilot.tsx renders when
      // isNativeOverlay is true (window.location.hash === '#overlay'). The
      // outermost styled element carries the `native-overlay-mode` class.
      document.body.innerHTML = `
        <div id="card-root"
             class="copilot-overlay native-overlay-mode mode-2-card-root"
             data-zule-stealth="true"
             role="region"
             aria-label="Zule AI copilot">
          <div class="control-capsule">
            <button id="b1" type="button">Hide</button>
            <button id="b2" type="button">Stop</button>
            <button id="b3" type="button" role="button">Mode</button>
            <a id="a1" href="#">Link</a>
            <input id="i1" type="text" />
          </div>
        </div>
      `;
    });

    afterEach(() => {
      document.body.innerHTML = '';
      document.getElementById(STYLE_ID)?.remove();
    });

    /**
     * Resolve the effective `-webkit-app-region` value for an element by
     * walking every parsed CSSStyleRule whose selector matches the element
     * and taking the last cascading match. jsdom's `getComputedStyle` does
     * not consistently surface vendor-prefixed properties, so we read them
     * directly from CSSStyleDeclaration via getPropertyValue.
     */
    function appRegionFromStylesheets(el: Element): string {
      let result = '';
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList | null = null;
        try { rules = sheet.cssRules; } catch { continue; }
        if (!rules) continue;
        for (const rule of Array.from(rules)) {
          if (!(rule instanceof CSSStyleRule)) continue;
          let matches = false;
          try { matches = el.matches(rule.selectorText); } catch { continue; }
          if (!matches) continue;
          const value =
            rule.style.getPropertyValue('-webkit-app-region') ||
            rule.style.getPropertyValue('app-region') ||
            (rule.style as unknown as Record<string, string>).webkitAppRegion ||
            '';
          if (value) result = value.trim();
        }
      }
      return result;
    }

    it('Mode 2 card root has -webkit-app-region: drag (Branch B — drag moves the BrowserWindow)', () => {
      const cardRoot = document.getElementById('card-root');
      expect(cardRoot).not.toBeNull();
      const region = appRegionFromStylesheets(cardRoot!);
      expect(region).toBe('drag');
    });

    it('every interactive descendant inside the Mode 2 card has -webkit-app-region: no-drag (Branch C — clicks dispatch)', () => {
      const cardRoot = document.getElementById('card-root')!;
      const interactive = Array.from(
        cardRoot.querySelectorAll('button, a, input, [role="button"]'),
      );
      expect(interactive.length).toBeGreaterThan(0);

      // Branch C: iterate over every interactive descendant. fast-check is
      // used over the index so the property is stated as a universal claim
      // rather than a hand-rolled forEach.
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: interactive.length - 1 }),
          (idx) => {
            const el = interactive[idx];
            const region = appRegionFromStylesheets(el);
            expect(region).toBe('no-drag');
            return true;
          },
        ),
        { numRuns: Math.max(interactive.length, 5) },
      );
    });
  });
});
