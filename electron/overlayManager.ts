// ============================================
// Zule AI — Overlay Manager
// ============================================
//
// Central main-process module responsible for the overlay window lifecycle.
// Extracted from inline logic in electron/main.ts for testability and separation of concerns.
//
// This file implements:
//   - OverlayManagerConfig and OverlayState interfaces
//   - OverlayManager class with create() / destroy() fully implemented
//   - Stub methods for show/hide/toggle, drag/snap, resize, nudge, shortcuts (tasks 3.2–3.9)

// `electron`'s API must be obtained via CommonJS `require` from this
// ESM-bundled main process — ESM interop exposes neither named nor default
// exports for Electron. See electron/main.ts for the full explanation. Types
// are imported by name (erased at compile time).
import { createRequire } from 'node:module';
import type { BrowserWindow as BrowserWindowType } from 'electron';
const require = createRequire(import.meta.url);
const { BrowserWindow, screen, app, globalShortcut } =
  require('electron') as typeof import('electron');
import path from 'node:path';
import { PositionStore, PersistedBounds } from './positionStore';
import {
  MIN_WIDTH,
  MIN_HEIGHT,
  MAX_WIDTH,
  MAX_HEIGHT,
  SNAP_DISTANCE,
  NUDGE_STEP,
  computeSnap,
  clampToWorkArea,
  clampSize,
  resolveInitialOverlayBounds,
} from './edgeSnap';
import {
  applyNativeStealth,
  removeNativeStealth,
  isNativeStealthAvailable,
} from './nativeStealth';
import { createStealthHost, type StealthHost, type HostStrategy } from './win32/hostWindow';
import { createReparenter, type Reparenter } from './win32/reparent';
import {
  CURRENT_STEALTH_HOST_GATE,
  selectStealthHostStrategy,
} from './win32/stealthHostGate';
import { getFfi, normalizeHwnd } from './win32/ffi';
import { createPaintSurface, type PaintSurface } from './win32/layeredPaint';
import { createInputForwarder, type ForwarderDeps, type DragController } from './win32/inputForwarder';
import { createKeyboardHook, type KeyboardHook } from './win32/keyboardHook';

// ── Performance Guarantees ──────────────────────────────────────────────────
// - No main-process timer runs more frequently than 1/s for maintenance (Req 14.1)
// - Resize animation: 16ms interval for ≤180ms only, then cleared (Req 14.7)
// - PositionStore flush: 500ms debounce (setTimeout), not continuous (Req 14.1)
// - Panic-hide: synchronous hide() call, < 200ms (Req 14.5)
// - Show/hide transitions: synchronous Electron calls, < 150ms (Req 14.6)
// - Zone detector: RAF-throttled, IPC only on state transitions (Req 14.2, 14.3)

// ── Interfaces ───────────────────────────────────────────────────────────────

export interface OverlayManagerConfig {
  preloadPath: string;
  rendererUrl: string; // DEV_URL or file path to dist/index.html
  isDev: boolean;
  snapDistance?: number; // default 16
}

export interface OverlayState {
  alwaysOnTop: boolean;
  contentProtection: boolean;
  mode: 'compact' | 'expanded';
  hostStrategy: HostStrategy;
}

// ── OverlayManager ───────────────────────────────────────────────────────────

export class OverlayManager {
  private static linuxNoticeShown = false;

  private window: BrowserWindowType | null = null;
  private mainWindow: BrowserWindowType | null = null;
  private registeredShortcuts: string[] = [];
  private store: PositionStore;
  private config: OverlayManagerConfig;
  private state: OverlayState;
  private stealthHost: StealthHost | null = null;
  private reparenter: Reparenter | null = null;

  // ── Stage B (layered) fields ────────────────────────────────────────────────
  private paintSurface: PaintSurface | null = null;
  private offscreenWindow: BrowserWindowType | null = null;

  // ── Keyboard Hook (zero-focus-loss input) ───────────────────────────────────
  private keyboardHook: KeyboardHook | null = null;

  // Bound handlers for screen event cleanup
  private handleDisplayChange: () => void;
  private handleDisplayRemoved: (event: Electron.Event, oldDisplay: Electron.Display) => void;
  private handleDisplayMetricsChanged: () => void;

  constructor(config: OverlayManagerConfig) {
    this.config = config;
    this.store = new PositionStore(app.getPath('userData'));
    this.store.load();
    this.state = {
      alwaysOnTop: true,
      contentProtection: true,
      mode: 'compact',
      hostStrategy: 'none',
    };

    // Bind handlers so they can be removed in destroy()
    this.handleDisplayChange = () => this.onDisplayChange();
    this.handleDisplayRemoved = (_event, oldDisplay) => this.onDisplayRemoved(oldDisplay);
    this.handleDisplayMetricsChanged = () => this.onDisplayMetricsChanged();
  }

  // ── Lifecycle: create ────────────────────────────────────────────────────────

  /**
   * Create the overlay BrowserWindow with all required options and show it
   * without stealing focus. Loads the renderer at the #overlay route.
   */
  create(): void {
    if (this.window) {
      return; // Already created
    }

    const isMac = process.platform === 'darwin';
    const isWin = process.platform === 'win32';

    // Restore persisted bounds or use defaults
    const restoredBounds = this.restoreBounds();

    // Platform-specific BrowserWindow options
    const platformOptions: Electron.BrowserWindowConstructorOptions = {};
    if (isMac) {
      platformOptions.titleBarStyle = 'hidden';
      platformOptions.roundedCorners = false;
    }

    this.window = new BrowserWindow({
      // Position and size
      x: restoredBounds.x,
      y: restoredBounds.y,
      width: restoredBounds.width,
      height: restoredBounds.height,

      // Chrome: frameless, transparent capsule. The explicit alpha-zero
      // backgroundColor ('#00000000') prevents the Windows DWM from
      // rendering a black box in place of the protected window during
      // screen capture.
      frame: false,
      transparent: true,
      hasShadow: false,
      skipTaskbar: true,
      backgroundColor: '#00000000',

      // Focus & display behavior
      show: false,
      focusable: false,
      // Render the page even before the window is shown so the first
      // paint after setContentProtection() is fully composited — avoids
      // the brief flash of unprotected content some users see when
      // protection is applied to a window that was never painted.
      paintWhenInitiallyHidden: true,

      // The overlay must accept user movement so Chromium's native
      // `-webkit-app-region: drag` handling can move this frameless window.
      // This option is scoped to the overlay BrowserWindow; the dashboard is
      // created independently in main.ts and is unaffected.
      resizable: true,
      movable: true,

      // Size constraints
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,

      // Platform-specific options
      ...platformOptions,

      // Web preferences
      webPreferences: {
        preload: this.config.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        // Same preload.ts as the main window (contextBridge/ipcRenderer only)
        // — safe to sandbox. See main.ts createMainWindow() for detail.
        sandbox: true,
        backgroundThrottling: false,
        // The overlay renders the copilot, which issues the AI fetch calls.
        // In dev it loads from http://localhost:5173, so the browser's
        // same-origin policy blocks fetch to arbitrary gateways (CORS
        // preflight fails). Disabling webSecurity in dev lets custom /
        // Anthropic-gateway providers reach any user-configured endpoint
        // without a proxy. In production the overlay loads from file:// where
        // CORS does not apply, so security stays on. Mirrors main.ts.
        webSecurity: !this.config.isDev,
      },
    });

    // ── Post-creation platform setup ──────────────────────────────────────────

    // Always-on-top at screen-saver level (above fullscreen apps)
    this.window.setAlwaysOnTop(true, 'screen-saver');

    // Screen-capture invisibility. Wrapped in try/catch because on some
    // Windows GPU drivers a transient graphics-buffer error can throw
    // when the OS-level capture-protect surface is allocated. The window
    // remains usable without protection — we just surface the failure to
    // the renderer so the UI can fall back gracefully.
    try {
      this.window.setContentProtection(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[OverlayManager] setContentProtection failed: ${message}`);
      const mainWin = this.mainWindow;
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('overlay-error', {
          code: 'CONTENT_PROTECTION_FAILED',
          message: `Could not enable screen-capture invisibility: ${message}`,
        });
      }
    }

    // Native Win32 stealth: apply defense-in-depth layers (display affinity
    // verification, DWM preview hardening, window style hardening) on top of
    // Electron's setContentProtection. Each layer is independent — a failure
    // in one does not block the others.
    //
    // Keep the overlay non-activating so pointer interaction does not transfer
    // OS focus away from the foreground application. Keyboard entry requires
    // normal window activation and is intentionally not synthesized here.
    if (isNativeStealthAvailable()) {
      try {
        const result = applyNativeStealth(
          this.window.getNativeWindowHandle(),
          { allowActivation: false },
        );
        if (!result.ok) {
          console.warn('[OverlayManager] Native stealth: no layers applied');
        }
      } catch (nErr: unknown) {
        const msg = nErr instanceof Error ? nErr.message : String(nErr);
        console.warn(`[OverlayManager] Native stealth failed: ${msg}`);
      }
    }

    // Click-through is DISABLED. The overlay window receives all mouse events
    // directly. The zone detector in OverlayShell + CSS -webkit-app-region
    // handles what's draggable vs clickable within the renderer. The previous
    // approach of starting with setIgnoreMouseEvents(true) + async IPC flip
    // caused persistent click-through bugs where buttons appeared clickable
    // but clicks passed through to the desktop behind the overlay.
    // this.window.setIgnoreMouseEvents(true, { forward: true }); // REMOVED

    // ── Stealth Host attachment (Stage A) ─────────────────────────────────────
    // Attempt to attach the stealth host BEFORE showing the window. If the host
    // takes over, native stealth layers are applied to the host HWND instead.
    // Failure at any step degrades gracefully to Layer 0 (existing behaviour).
    this.attachStealthHost();

    // Visible on all virtual desktops / workspaces
    if (isMac) {
      this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else {
      this.window.setVisibleOnAllWorkspaces(true);
    }

    // ── Load renderer ─────────────────────────────────────────────────────────

    if (this.config.isDev) {
      this.window.loadURL(`${this.config.rendererUrl}#overlay`);
      // Mirror ALL overlay renderer console output to the main-process terminal
      // so we can see aiProvider debug logs without a separate DevTools window.
      this.window.webContents.on(
        'console-message' as any,
        (e: any) => {
          const msg = e?.message ?? (typeof e === 'string' ? e : '');
          if (msg) {
            console.log(`[overlay] ${msg}`);
          }
        },
      );
    } else {
      this.window.loadFile(this.config.rendererUrl, { hash: 'overlay' });
    }

    // ── Show without stealing focus ───────────────────────────────────────────

    this.window.once('ready-to-show', () => {
      this.window?.showInactive();
    });

    // ── Prevent focus steal on click (Windows) ────────────────────────────────
    // The overlay is created with focusable: false. Electron tells Chromium not
    // to activate this window on any interaction. Combined with WS_EX_NOACTIVATE
    // from nativeStealth, the window never becomes the foreground window.
    // Keyboard input is handled by a WH_KEYBOARD_LL hook (see below).

    // ── Keyboard Hook IPC (zero-focus-loss typing) ────────────────────────────
    // The renderer signals when an input element gains/loses logical focus.
    // On focus: install a WH_KEYBOARD_LL hook that intercepts all keystrokes
    //           and forwards them to the overlay's webContents.
    // On blur:  uninstall the hook so keystrokes flow normally to the fg app.
    if (isWin) {
      const { ipcMain } = require('electron') as typeof import('electron');

      ipcMain.on('overlay-request-focus', () => {
        if (!this.window || this.window.isDestroyed()) return;
        if (!this.keyboardHook) {
          this.keyboardHook = createKeyboardHook();
        }
        this.keyboardHook.install(this.window);
      });

      ipcMain.on('overlay-blur', () => {
        if (this.keyboardHook) {
          this.keyboardHook.uninstall();
        }
      });
    }

    // ── Window close cleanup ──────────────────────────────────────────────────

    this.window.on('closed', () => {
      this.window = null;
    });

    // ── Renderer crash handling ───────────────────────────────────────────────

    this.window.webContents.on('render-process-gone', (_event, details) => {
      console.warn(
        `[OverlayManager] Renderer crashed: reason=${details.reason} ` +
          `exitCode=${details.exitCode}`,
      );

      // Notify main window so dashboard can offer recovery options
      const mainWin = this.mainWindow;
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('overlay-error', {
          code: 'RENDERER_CRASHED',
          message: `Overlay renderer process terminated: ${details.reason}`,
        });
      }

      // Auto-recreate overlay after a short delay so the user isn't left
      // staring at a blank window with a hidden dashboard.
      console.log('[OverlayManager] Auto-restarting overlay after renderer crash...');
      setTimeout(() => {
        this.destroy();
        this.create();
        this.show();
      }, 1000);
    });

    // ── Display change listeners ──────────────────────────────────────────────
    // Reposition overlay only when its actual display changes (added/removed).
    // display-metrics-changed fires on taskbar toggles, DPI changes, etc. —
    // we only re-apply always-on-top on those events, not reposition.

    screen.on('display-added', this.handleDisplayChange);
    screen.on('display-removed', this.handleDisplayRemoved);
    screen.on('display-metrics-changed', this.handleDisplayMetricsChanged);

    // ── App quit handler ──────────────────────────────────────────────────────
    // Ensure stealth host teardown ordering is respected on app quit:
    // release() → destroy() host, before Electron tears down the BrowserWindow.
    app.on('before-quit', () => {
      // Uninstall keyboard hook before anything else
      if (this.keyboardHook) {
        this.keyboardHook.uninstall();
        this.keyboardHook = null;
      }
      if (this.reparenter) {
        this.reparenter.release();
        this.reparenter = null;
      }
      // Stage B cleanup
      if (this.paintSurface) {
        this.paintSurface.dispose();
        this.paintSurface = null;
      }
      if (this.offscreenWindow && !this.offscreenWindow.isDestroyed()) {
        this.offscreenWindow.close();
        this.offscreenWindow = null;
      }
      if (this.stealthHost) {
        this.stealthHost.destroy();
        this.stealthHost = null;
      }
      this.state.hostStrategy = 'none';
    });
  }

  // ── Lifecycle: destroy ───────────────────────────────────────────────────────

  /**
   * Destroy the overlay window and flush position state.
   *
   * Teardown ordering (Req 6.3):
   *   1. release() — un-reparent the child HWND back to top-level
   *   2. destroy() host — DestroyWindow → UnregisterClassW → koffi.unregister
   *   3. close BrowserWindow — Electron tears down the Chromium HWND
   */
  destroy(): void {
    // Remove screen event listeners
    screen.removeListener('display-added', this.handleDisplayChange);
    screen.removeListener('display-removed', this.handleDisplayRemoved);
    screen.removeListener('display-metrics-changed', this.handleDisplayMetricsChanged);

    // ── Keyboard hook teardown ────────────────────────────────────────────────
    if (this.keyboardHook) {
      this.keyboardHook.uninstall();
      this.keyboardHook = null;
    }

    // ── Stealth Host teardown (Req 6.3) ─────────────────────────────────────
    // Release child first (if reparented)
    if (this.reparenter) {
      this.reparenter.release();
      this.reparenter = null;
    }

    // ── Stage B teardown ──────────────────────────────────────────────────────
    // Dispose paint surface before destroying the host
    if (this.paintSurface) {
      this.paintSurface.dispose();
      this.paintSurface = null;
    }
    // Close offscreen window
    if (this.offscreenWindow && !this.offscreenWindow.isDestroyed()) {
      this.offscreenWindow.close();
      this.offscreenWindow = null;
    }

    // Destroy the stealth host
    if (this.stealthHost) {
      this.stealthHost.destroy();
      this.stealthHost = null;
    }
    this.state.hostStrategy = 'none';

    // Then close the BrowserWindow
    if (this.window) {
      this.window.close();
      this.window = null;
    }
    void this.store.flush();
  }

  // ── Visibility ────────────────────────────────────────────────────────────────

  /** Show overlay without stealing focus. */
  show(): void {
    if (!this.window) return;

    if (this.stealthHost && this.state.hostStrategy !== 'none') {
      this.stealthHost.show();
      this.stealthHost.reassert();
    }

    this.window.showInactive();
    this.reapplyPlatformState();
  }

  /** Hide overlay. */
  hide(): void {
    if (!this.window) return;

    // Uninstall keyboard hook so keystrokes flow to the foreground app
    if (this.keyboardHook) {
      this.keyboardHook.uninstall();
    }

    if (this.stealthHost && this.state.hostStrategy !== 'none') {
      this.stealthHost.hide();
    }

    this.window.hide();
  }

  /** Toggle visibility; returns new visibility state (true = visible). */
  toggle(): boolean {
    if (!this.window) return false;
    if (this.window.isVisible()) {
      this.hide();
      return false;
    } else {
      this.show();
      return true;
    }
  }

  // ── Resize ───────────────────────────────────────────────────────────────────

  /** Resize to the target size in one step. Keeps the horizontal center of
   *  the window stable across the resize so the visually-centered control
   *  capsule does not appear to shift sideways when expanding/collapsing.
   *  We deliberately skip the stepped animation here — on a transparent
   *  frameless always-on-top window, frame-by-frame setBounds calls produce
   *  visible jitter that fights the renderer's CSS transitions. A single
   *  setBounds yields a clean instant snap; the React component inside the
   *  window handles its own ease for the appearing card. */
  resize(width: number, height: number): void {
    if (!this.window) {
      console.log('[OverlayManager] resize called but no window');
      return;
    }

    // Clamp requested size to configured constraints
    const clamped = clampSize(width, height, {
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,
    });

    const startBounds = this.window.getBounds();
    console.log(`[OverlayManager] resize: ${startBounds.width}x${startBounds.height} → ${clamped.width}x${clamped.height}`);

    // Determine the work area for the display the window currently occupies
    const display = screen.getDisplayMatching(startBounds);
    const workArea = display.workArea;

    // Anchor the resize on the horizontal center: new left edge = old center
    // − new width / 2. Vertically, anchor to the top edge of the current
    // bounds so the overlay does not jump downward when growing taller.
    const startCenterX = startBounds.x + startBounds.width / 2;
    const proposedX = Math.round(startCenterX - clamped.width / 2);
    const proposedY = startBounds.y;

    // Compute target bounds and clamp to work area so the entire window
    // remains visible after the resize.
    const targetBounds = clampToWorkArea(
      { x: proposedX, y: proposedY, width: clamped.width, height: clamped.height },
      workArea,
    );

    console.log(`[OverlayManager] setBounds: x=${targetBounds.x} y=${targetBounds.y} w=${targetBounds.width} h=${targetBounds.height}`);
    this.applyBounds(targetBounds);
    console.log(`[OverlayManager] after setBounds: ${JSON.stringify(this.window.getBounds())}`);
    this.persistBounds();
  }

  // ── Move / Nudge / Recenter ──────────────────────────────────────────────────

  /** Move to absolute position. */
  move(x: number, y: number): void {
    if (!this.window) return;

    const bounds = this.window.getBounds();
    const targetBounds = { x: Math.round(x), y: Math.round(y), width: bounds.width, height: bounds.height };
    this.applyBounds(targetBounds);
    this.persistBounds();
  }

  /** Nudge by delta within work area. */
  nudge(dx: number, dy: number): void {
    if (!this.window) return;

    const bounds = this.window.getBounds();
    const newX = bounds.x + dx;
    const newY = bounds.y + dy;

    // Get the work area of the display the window currently occupies
    const workArea = screen.getDisplayMatching(bounds).workArea;

    // Clamp the new position to the work area
    const clamped = clampToWorkArea(
      { x: newX, y: newY, width: bounds.width, height: bounds.height },
      workArea,
    );

    this.applyBounds(clamped);
    this.persistBounds();
  }

  /** Recenter on display under cursor. */
  recenter(): void {
    if (!this.window) return;

    const cursorPoint = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursorPoint);
    const workArea = display.workArea;
    const bounds = this.window.getBounds();

    // Center the window within the work area
    const x = Math.round(workArea.x + (workArea.width - bounds.width) / 2);
    const y = Math.round(workArea.y + (workArea.height - bounds.height) / 2);

    this.applyBounds({ x, y, width: bounds.width, height: bounds.height });
    this.persistBounds();
  }

  /** Apply edge snap to current bounds. */
  applySnap(): void {
    if (!this.window) return;

    const bounds = this.window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const result = computeSnap(bounds, display.workArea, this.config.snapDistance ?? SNAP_DISTANCE);

    if (result.snapped) {
      this.applyBounds(result.bounds);
    }
  }

  // ── State toggles ────────────────────────────────────────────────────────────

  /** Set always-on-top state and persist. */
  setAlwaysOnTop(enabled: boolean): void {
    if (!this.window) return;

    this.state.alwaysOnTop = enabled;

    if (enabled) {
      this.window.setAlwaysOnTop(true, 'screen-saver');
    } else {
      this.window.setAlwaysOnTop(false);
    }

    this.persistBounds();
  }

  /** Set content protection state and persist. Returns false on failure.
   *
   * When a Stealth Host is active, stealth layers are applied/removed on the
   * host HWND (the top-level window owning capture exclusion). When at Layer 0,
   * layers are applied/removed on the overlay's own HWND.
   *
   * IMPORTANT: Toggling never destroys or recreates the host — topology is
   * invariant across stealth toggles (Req 5.2). hostStrategy and hostHwnd
   * remain unchanged regardless of toggle state.
   */
  setContentProtection(enabled: boolean): boolean {
    if (!this.window) return false;

    this.state.contentProtection = enabled;
    try {
      this.window.setContentProtection(enabled);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[OverlayManager] setContentProtection(${enabled}) failed: ${message}`);
      const mainWin = this.mainWindow;
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('overlay-error', {
          code: 'CONTENT_PROTECTION_FAILED',
          message: `Could not toggle screen-capture invisibility: ${message}`,
        });
      }
      return false;
    }

    // Toggle native stealth layers on the current top-level HWND:
    // - When host is active: apply/remove on the host HWND (Req 4.2, 5.1, 5.3)
    // - When at Layer 0: apply/remove on the overlay's own HWND
    if (isNativeStealthAvailable()) {
      try {
        if (this.stealthHost && this.state.hostStrategy !== 'none') {
          // Route stealth layers to the host HWND (it owns the top-level window)
          const hostState = this.stealthHost.getState();
          if (hostState.hostHwnd) {
            if (enabled) {
              applyNativeStealth(hostState.hostHwnd as Parameters<typeof applyNativeStealth>[0]);
            } else {
              removeNativeStealth(hostState.hostHwnd as Parameters<typeof removeNativeStealth>[0]);
            }
          }
        } else {
          // Keep the Layer 0 top-level BrowserWindow non-activating so pointer
          // interaction does not transfer OS focus from the foreground app.
          if (enabled) {
            applyNativeStealth(
              this.window.getNativeWindowHandle(),
              { allowActivation: false },
            );
          } else {
            removeNativeStealth(this.window.getNativeWindowHandle());
          }
        }
      } catch (nErr: unknown) {
        const msg = nErr instanceof Error ? nErr.message : String(nErr);
        // Req 4.4: If stealth layer application fails, continue (don't abort)
        console.warn(`[OverlayManager] Native stealth toggle failed: ${msg}`);
      }
    }

    // Surface a one-time non-blocking notice on Linux where content protection is a no-op
    if (!OverlayManager.linuxNoticeShown && process.platform === 'linux') {
      this.window.webContents.send('overlay-error', {
        code: 'CONTENT_PROTECTION_NOOP',
        message: 'Content protection is not supported on Linux',
      });
      OverlayManager.linuxNoticeShown = true;
    }

    this.persistBounds();
    return true;
  }

  // ── Shortcuts (task 3.7) ──────────────────────────────────────────────────────

  /** Register all global shortcuts. */
  registerShortcuts(mainWindow: BrowserWindowType): void {
    this.mainWindow = mainWindow;

    const isMac = process.platform === 'darwin';
    const prefix = isMac ? 'Cmd' : 'Ctrl';
    const alt = isMac ? 'Option' : 'Alt';

    const shortcuts: Array<{
      accelerator: string;
      shortcutId: string;
      action: () => void;
    }> = [
      {
        accelerator: `${prefix}+.`,
        shortcutId: 'toggle-overlay',
        action: () => this.toggle(),
      },
      {
        accelerator: `${prefix}+Shift+.`,
        shortcutId: 'panic-hide',
        action: () => this.hide(),
      },
      {
        accelerator: `${prefix}+Shift+Z`,
        shortcutId: 'bring-to-front',
        action: () => {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.show();
            this.mainWindow.focus();
          }
          this.show();
        },
      },
      {
        accelerator: `${prefix}+${alt}+Up`,
        shortcutId: 'nudge-up',
        action: () => this.nudge(0, -NUDGE_STEP),
      },
      {
        accelerator: `${prefix}+${alt}+Down`,
        shortcutId: 'nudge-down',
        action: () => this.nudge(0, NUDGE_STEP),
      },
      {
        accelerator: `${prefix}+${alt}+Left`,
        shortcutId: 'nudge-left',
        action: () => this.nudge(-NUDGE_STEP, 0),
      },
      {
        accelerator: `${prefix}+${alt}+Right`,
        shortcutId: 'nudge-right',
        action: () => this.nudge(NUDGE_STEP, 0),
      },
      {
        accelerator: `${prefix}+${alt}+0`,
        shortcutId: 'recenter',
        action: () => this.recenter(),
      },
    ];

    for (const { accelerator, shortcutId, action } of shortcuts) {
      try {
        const success = globalShortcut.register(accelerator, () => {
          action();
          this.forwardShortcut(shortcutId);
        });

        if (success) {
          this.registeredShortcuts.push(accelerator);
        } else {
          console.warn(`[OverlayManager] Failed to register shortcut: ${accelerator}`);
          this.mainWindow?.webContents.send('overlay-error', {
            code: 'SHORTCUT_UNAVAILABLE',
            message: `Global shortcut ${accelerator} is unavailable (may be in use by another application)`,
          });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[OverlayManager] Error registering shortcut ${accelerator}: ${message}`);
        this.mainWindow?.webContents.send('overlay-error', {
          code: 'SHORTCUT_UNAVAILABLE',
          message: `Failed to register global shortcut ${accelerator}: ${message}`,
        });
      }
    }
  }

  /** Unregister all global shortcuts. */
  unregisterShortcuts(): void {
    globalShortcut.unregisterAll();
    this.registeredShortcuts = [];
    this.mainWindow = null;
  }

  /** Forward shortcut event to both windows via IPC. */
  private forwardShortcut(shortcutId: string): void {
    const mainWin = this.mainWindow;
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('global-shortcut', shortcutId);
    }
    const overlayWin = this.window;
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send('global-shortcut', shortcutId);
    }
  }

  // ── Getters ─────────────────────────────────────────────────────────────────

  /** Get current bounds or null if not created. */
  getBounds(): Electron.Rectangle | null {
    return this.window?.getBounds() ?? null;
  }

  /** Get the underlying BrowserWindow reference (for IPC wiring). */
  getWindow(): BrowserWindowType | null {
    return this.window;
  }

  /** Get the current host strategy (for renderer-side no-op decisions). */
  getHostStrategy(): HostStrategy {
    return this.state.hostStrategy;
  }

  /**
   * Set or update the main window reference for error forwarding.
   * Also listens for the main window's 'closed' event to clean up the overlay.
   */
  setMainWindowRef(mainWindow: BrowserWindowType | null): void {
    this.mainWindow = mainWindow;

    // Clean up overlay reference when main window closes
    if (mainWindow) {
      mainWindow.on('closed', () => {
        this.mainWindow = null;
        this.destroy();
      });
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Select and attach a Stealth Host only after its complete design gate passes.
   * The current real-Windows A5/A6 failure evidence selects Layer 0. This keeps
   * Chromium top-level so app-region drag, pointer activation, keyboard focus,
   * and Electron screen-space bounds retain their supported semantics.
   */
  private attachStealthHost(): void {
    if (!this.window || process.platform !== 'win32') return;

    const selectedStrategy = selectStealthHostStrategy(CURRENT_STEALTH_HOST_GATE);
    if (selectedStrategy === 'none') {
      console.warn(
        '[OverlayManager] Stealth Host disabled after documented Stage A A5/A6 failure; using Layer 0',
      );
      return;
    }
    if (selectedStrategy === 'layered') {
      this.attachStealthHostLayered();
      return;
    }

    const bounds = this.window.getBounds();
    const host = createStealthHost({
      bounds,
      strategy: 'reparent',
      onLost: (reason) => {
        console.warn(`[OverlayManager] Stealth host lost: ${reason}`);
        this.state.hostStrategy = 'none';
        this.stealthHost = null;
        this.reparenter = null;
      },
    });

    const hostState = host.create();
    if (!hostState.active) {
      // Graceful degradation — continue at Layer 0
      console.warn('[OverlayManager] Stealth host creation failed, using Layer 0');
      return;
    }

    this.stealthHost = host;
    console.log(
      `[OverlayManager] Stealth host created: strategy=${hostState.strategy} ` +
      `class=${hostState.className ?? '<unknown>'}`,
    );

    // Stage A: reparent the overlay HWND into the host
    const ffi = getFfi();
    if (ffi && hostState.hostHwnd) {
      const reparenter = createReparenter(ffi);
      const childHwnd = this.window.getNativeWindowHandle();
      const result = reparenter.adopt(hostState.hostHwnd, childHwnd);
      if (result.success) {
        this.reparenter = reparenter;
        this.state.hostStrategy = 'reparent';
        console.log('[OverlayManager] Reparent succeeded: strategy=reparent');
        host.show();
      } else {
        // Rollback already happened inside adopt
        host.destroy();
        this.stealthHost = null;
        console.warn('[OverlayManager] Reparent failed, using Layer 0');
      }
    } else {
      // FFI unavailable after host creation succeeded — shouldn't happen but handle gracefully
      host.destroy();
      this.stealthHost = null;
      console.warn('[OverlayManager] FFI unavailable for reparent, using Layer 0');
    }
  }

  /**
   * Attach a Stage B (layered) stealth host with offscreen rendering.
   *
   * Stage B is gated on the spike report documenting Stage A failure (Req 2.4).
   * This method creates:
   *   1. A stealth host with strategy 'layered' (JS WNDPROC for input forwarding)
   *   2. An offscreen BrowserWindow (software raster, no HWND)
   *   3. A PaintSurface backed by CreateDIBSection for zero-copy pixel transfer
   *   4. Wiring: paint event → memcpy → UpdateLayeredWindow
   *   5. An InputForwarder converting Win32 messages to sendInputEvent calls
   *
   * On any failure, degrades gracefully to Layer 0 (existing behaviour).
   *
   * Requirements: 7.1, 8.4, 8.7, 2.4, 2.5
   */
  private attachStealthHostLayered(): void {
    if (!this.window || process.platform !== 'win32') return;

    const bounds = this.window.getBounds();

    // ── Step 1: Create the stealth host with 'layered' strategy ────────────
    const host = createStealthHost({
      bounds,
      strategy: 'layered',
      onLost: (reason) => {
        console.warn(`[OverlayManager] Layered stealth host lost: ${reason}`);
        this.teardownLayeredStage();
      },
    });

    const hostState = host.create();
    if (!hostState.active || !hostState.hostHwnd) {
      console.warn('[OverlayManager] Layered host creation failed, using Layer 0');
      return;
    }

    this.stealthHost = host;

    // ── Step 2: Create offscreen BrowserWindow ─────────────────────────────
    // The offscreen window has no OS-level HWND visible to EnumWindows.
    // It renders via software raster and emits 'paint' events with BGRA frames.
    const offscreen = new BrowserWindow({
      show: false,
      width: bounds.width,
      height: bounds.height,
      webPreferences: {
        preload: this.config.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        offscreen: true,
        webSecurity: !this.config.isDev,
      },
    });

    // Enable offscreen rendering at the configured frame rate
    offscreen.webContents.setFrameRate(60);

    // ── Step 3: Create PaintSurface ────────────────────────────────────────
    const surface = createPaintSurface(bounds.width, bounds.height, {
      onRollbackRequested: (reason) => {
        console.warn(`[OverlayManager] Paint surface circuit breaker: ${reason}`);
        this.teardownLayeredStage();
      },
    });

    if (!surface) {
      console.warn('[OverlayManager] PaintSurface allocation failed, using Layer 0');
      offscreen.close();
      host.destroy();
      this.stealthHost = null;
      return;
    }

    this.paintSurface = surface;
    this.offscreenWindow = offscreen;

    // ── Step 4: Wire paint event → PaintSurface.present() ──────────────────
    // Single memcpy of image.getBitmap() into the DIB section, then present
    // via UpdateLayeredWindow (Req 7.1).
    offscreen.webContents.on('paint', (_event, _dirty, image) => {
      if (!this.paintSurface || !this.stealthHost) return;

      const bitmap = (image as Electron.NativeImage).toBitmap();
      const surfacePixels = this.paintSurface.pixels;

      // Frame-size guard (Req 7.2): only copy when dimensions match
      if (bitmap.length !== surfacePixels.length) {
        return; // Drop mismatched frame
      }

      // Single memcpy — bitmap data into the DIB-backed buffer
      bitmap.copy(surfacePixels);

      // Present to the host via UpdateLayeredWindow
      const currentBounds = this.stealthHost.getState().hostHwnd
        ? this.getBoundsForPresent()
        : null;
      if (currentBounds) {
        this.paintSurface.present(
          this.stealthHost.getState().hostHwnd!,
          currentBounds.x,
          currentBounds.y,
        );
      }
    });

    // ── Step 5: Create InputForwarder + DragController ─────────────────────
    // The DragController uses SetCapture/SetWindowPos/ReleaseCapture for
    // hand-rolled window dragging (Req 8.4, 8.5).
    const ffi = getFfi();
    if (ffi) {
      let dragStartScreenX = 0;
      let dragStartScreenY = 0;
      let dragStartHostX = 0;
      let dragStartHostY = 0;
      let isDragging = false;

      const dragController: DragController = {
        get dragging() { return isDragging; },
        begin(screenX: number, screenY: number) {
          isDragging = true;
          dragStartScreenX = screenX;
          dragStartScreenY = screenY;
          // Capture the host's current screen position
          const hostHwnd = host.getState().hostHwnd;
          if (hostHwnd && ffi.user32.SetCapture) {
            ffi.user32.SetCapture(hostHwnd);
            // Read current host position
            const rect = ffi.alloc('RECT', { left: 0, top: 0, right: 0, bottom: 0 });
            ffi.user32.GetWindowRect(hostHwnd, rect);
            const decoded = ffi.decode(rect, 'RECT') as { left: number; top: number };
            dragStartHostX = decoded.left;
            dragStartHostY = decoded.top;
          }
        },
        update(screenX: number, screenY: number) {
          if (!isDragging) return;
          const dx = screenX - dragStartScreenX;
          const dy = screenY - dragStartScreenY;
          const hostHwnd = host.getState().hostHwnd;
          if (hostHwnd) {
            const SWP_NOSIZE = 0x0001;
            const SWP_NOACTIVATE = 0x0010;
            const SWP_NOZORDER = 0x0004;
            ffi.user32.SetWindowPos(
              hostHwnd,
              null as unknown,
              dragStartHostX + dx,
              dragStartHostY + dy,
              0,
              0,
              SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER,
            );
          }
        },
        end() {
          if (!isDragging) return;
          isDragging = false;
          ffi.user32.ReleaseCapture?.();
        },
      };

      const forwarderDeps: ForwarderDeps = {
        send: (event) => {
          if (this.offscreenWindow && !this.offscreenWindow.isDestroyed()) {
            this.offscreenWindow.webContents.sendInputEvent(event as any);
          }
        },
        clientSize: () => {
          if (!this.paintSurface) return { width: bounds.width, height: bounds.height };
          return { width: this.paintSurface.width, height: this.paintSurface.height };
        },
        scaleFactor: () => {
          if (!this.window) return 1;
          const display = screen.getDisplayMatching(this.window.getBounds());
          return display.scaleFactor;
        },
        drag: dragController,
        // Req 8.7: empty isDragZone means no drag zones (click-only, never un-clickable)
        // The hit-test cache will be populated by the renderer when Stage B is live.
        isDragZone: undefined,
      };

      // Create the InputForwarder — its WndProcHandlers will be invoked by
      // the host's JS WNDPROC for mouse/keyboard/wheel messages.
      const _inputHandlers = createInputForwarder(forwarderDeps);
      // NOTE: The WndProcHandlers are wired to the host's WNDPROC at host
      // creation time via the 'layered' strategy in createStealthHost.
      // When the host's JS WNDPROC receives messages, it will dispatch them
      // through the registered handlers. Currently the host's default JS
      // handler falls through to DefWindowProcW; full integration of the
      // inputHandlers into the live WNDPROC dispatch will be completed when
      // Stage B is activated via the spike report.
    }

    // ── Step 6: Load the renderer into the offscreen window ────────────────
    if (this.config.isDev) {
      offscreen.loadURL(`${this.config.rendererUrl}#overlay`);
    } else {
      offscreen.loadFile(this.config.rendererUrl, { hash: 'overlay' });
    }

    // Mark the strategy as active
    this.state.hostStrategy = 'layered';
    host.show();

    console.log('[OverlayManager] Stage B (layered) stealth host attached');
  }

  /**
   * Get screen-space bounds for presenting frames via UpdateLayeredWindow.
   * Uses the window bounds (which track the intended position).
   */
  private getBoundsForPresent(): Electron.Rectangle | null {
    if (this.window) {
      return this.window.getBounds();
    }
    return null;
  }

  /**
   * Teardown the Stage B (layered) infrastructure and revert to Layer 0.
   * Called on paint surface circuit breaker trip or unexpected host loss.
   */
  private teardownLayeredStage(): void {
    // Dispose paint surface
    if (this.paintSurface) {
      this.paintSurface.dispose();
      this.paintSurface = null;
    }

    // Close offscreen window
    if (this.offscreenWindow && !this.offscreenWindow.isDestroyed()) {
      this.offscreenWindow.close();
      this.offscreenWindow = null;
    }

    // Destroy host
    if (this.stealthHost) {
      this.stealthHost.destroy();
      this.stealthHost = null;
    }

    this.state.hostStrategy = 'none';
    console.log('[OverlayManager] Stage B teardown complete, reverted to Layer 0');
  }

  /**
   * Apply bounds to the overlay. Routes through the Stealth Host when active
   * (hostStrategy !== 'none'), otherwise directly to the BrowserWindow.
   *
   * In reparent mode, the host is moved/resized in screen space and the child
   * is refitted to fill the host's client area at (0, 0, width, height).
   */
  private applyBounds(bounds: Electron.Rectangle): void {
    if (!this.window) return;

    if (this.stealthHost && this.state.hostStrategy !== 'none') {
      // Route through host — move/resize the host in screen space
      this.stealthHost.setBounds(bounds);

      // In reparent mode, refit the child to fill the host client area
      if (this.state.hostStrategy === 'reparent' && this.reparenter) {
        const ffi = getFfi();
        if (ffi) {
          const childHwnd = normalizeHwnd(this.window.getNativeWindowHandle());
          // SWP_NOACTIVATE | SWP_NOZORDER
          const SWP_NOACTIVATE = 0x0010;
          const SWP_NOZORDER = 0x0004;
          ffi.user32.SetWindowPos(
            childHwnd,
            null as unknown,
            0,
            0,
            bounds.width,
            bounds.height,
            SWP_NOACTIVATE | SWP_NOZORDER,
          );
        }
      }
    } else {
      // Layer 0 — route directly to the BrowserWindow
      this.window.setBounds(bounds);
    }
  }

  /** Re-apply platform properties after show (always-on-top, workspaces, content protection). */
  private reapplyPlatformState(): void {
    if (!this.window) return;

    // Re-apply always-on-top state
    if (this.state.alwaysOnTop) {
      this.window.setAlwaysOnTop(true, 'screen-saver');
    } else {
      this.window.setAlwaysOnTop(false);
    }

    // Re-apply visible on all workspaces
    const isMac = process.platform === 'darwin';
    if (isMac) {
      this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else {
      this.window.setVisibleOnAllWorkspaces(true);
    }

    // Re-apply content protection state
    try {
      this.window.setContentProtection(this.state.contentProtection);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[OverlayManager] reapplyPlatformState: setContentProtection failed: ${message}`);
    }

    // Re-apply native stealth layers to the current top-level owner when
    // content protection is active. In Stage A the Chromium HWND is a child;
    // applying top-level-only APIs to it fails with E_HANDLE.
    // Layer 0: keep WS_EX_NOACTIVATE so clicking the overlay does not transfer
    // OS focus away from the foreground fullscreen application.
    if (this.state.contentProtection && isNativeStealthAvailable()) {
      try {
        const hostState = this.stealthHost?.getState();
        if (this.state.hostStrategy !== 'none' && hostState?.hostHwnd) {
          applyNativeStealth(hostState.hostHwnd as Parameters<typeof applyNativeStealth>[0]);
        } else {
          applyNativeStealth(
            this.window.getNativeWindowHandle(),
            { allowActivation: false },
          );
        }
      } catch (nErr: unknown) {
        const msg = nErr instanceof Error ? nErr.message : String(nErr);
        console.warn(`[OverlayManager] reapplyPlatformState: native stealth failed: ${msg}`);
      }
    }
  }

  /** Handle display-added and display-removed events. Only recenter when the
   *  overlay's actual display was affected. Otherwise just re-apply platform state.
   *  Reasserts stealth host layers on display change (Req 4.3). */
  private onDisplayChange(): void {
    if (!this.window) return;
    this.window.setAlwaysOnTop(true, 'screen-saver');
    // Reassert stealth host layers on display events
    if (this.stealthHost && this.state.hostStrategy !== 'none') {
      this.stealthHost.reassert();
    }
  }

  /** Handle display-metrics-changed (taskbar toggle, DPI change, workspace switch).
   *  Only re-apply always-on-top; do NOT reposition the overlay.
   *  Reasserts stealth host layers on display metrics change (Req 4.3). */
  private onDisplayMetricsChanged(): void {
    if (!this.window) return;
    this.window.setAlwaysOnTop(true, 'screen-saver');
    // Reassert stealth host layers on display events
    if (this.stealthHost && this.state.hostStrategy !== 'none') {
      this.stealthHost.reassert();
    }

    // ── Stage B DPI handling ───────────────────────────────────────────────
    // When Stage B is active, a DPI change requires resizing the paint surface
    // to match the new physical pixel dimensions, then reasserting stealth.
    if (this.state.hostStrategy === 'layered' && this.paintSurface && this.offscreenWindow) {
      const display = screen.getDisplayMatching(this.window.getBounds());
      const bounds = this.window.getBounds();
      const physicalWidth = Math.round(bounds.width * display.scaleFactor);
      const physicalHeight = Math.round(bounds.height * display.scaleFactor);

      // Resize the DIB-backed paint surface to the new physical dimensions
      const resized = this.paintSurface.resize(physicalWidth, physicalHeight);
      if (!resized) {
        console.warn('[OverlayManager] Paint surface resize failed on DPI change');
      }

      // Update the offscreen window size to match logical bounds
      this.offscreenWindow.setSize(bounds.width, bounds.height);
    }
  }

  /** Handle display-removed event. Recenter only when the overlay's display was
   *  the one removed (the window is now orphaned on a nonexistent display).
   *  Otherwise just re-apply always-on-top.
   *  Reasserts stealth host layers after recentering (Req 4.3). */
  private onDisplayRemoved(oldDisplay: Electron.Display): void {
    if (!this.window) return;

    this.window.setAlwaysOnTop(true, 'screen-saver');

    const bounds = this.window.getBounds();
    const currentDisplay = screen.getDisplayMatching(bounds);
    const oldId = String(oldDisplay.id);
    const currentId = String(currentDisplay.id);

    // Only recenter if the overlay was on the display that was removed
    if (oldId === currentId) {
      const primaryDisplay = screen.getPrimaryDisplay();
      const workArea = primaryDisplay.workArea;
      const x = workArea.x + Math.round((workArea.width - bounds.width) / 2);
      const y = Math.max(workArea.y, workArea.y + Math.round((workArea.height - bounds.height) / 2));
      this.applyBounds({ x, y, width: bounds.width, height: bounds.height });
      this.persistBounds();
    }

    // Reassert stealth host layers after any display removal handling
    if (this.stealthHost && this.state.hostStrategy !== 'none') {
      this.stealthHost.reassert();
    }
  }

  /** Persist current bounds to store. */
  private persistBounds(): void {
    if (!this.window) return;

    const bounds = this.window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const displayId = String(display.id);

    const persisted: PersistedBounds = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      mode: this.state.mode,
      alwaysOnTop: this.state.alwaysOnTop,
      contentProtection: this.state.contentProtection,
    };

    this.store.set(displayId, persisted);
  }

  /**
   * Restore bounds from store for current primary display, or return defaults
   * if no persisted position exists. Reads from PositionStore so user-positioned
   * overlay windows reopen at their last known location.
   */
  private restoreBounds(): Electron.Rectangle {
    const primaryDisplay = screen.getPrimaryDisplay();
    const primaryId = String(primaryDisplay.id);
    const saved = this.store.get(primaryId);

    return resolveInitialOverlayBounds(saved, primaryDisplay.workArea);
  }
}
