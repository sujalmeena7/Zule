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
} from './edgeSnap';

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
      focusable: true,
      // Render the page even before the window is shown so the first
      // paint after setContentProtection() is fully composited — avoids
      // the brief flash of unprotected content some users see when
      // protection is applied to a window that was never painted.
      paintWhenInitiallyHidden: true,

      // The overlay needs to be resizable programmatically via IPC
      // (compact/expanded/maximized mode transitions call resize-overlay),
      // but the user should not be able to drag-resize it manually.
      // `resizable: true` allows setBounds to work; we prevent manual
      // resize by not showing the OS resize handles (frame: false does that).
      resizable: true,
      movable: false,

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
        sandbox: false,
        backgroundThrottling: false,
        webSecurity: true,
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

    // Click-through is DISABLED. The overlay window receives all mouse events
    // directly. The zone detector in OverlayShell + CSS -webkit-app-region
    // handles what's draggable vs clickable within the renderer. The previous
    // approach of starting with setIgnoreMouseEvents(true) + async IPC flip
    // caused persistent click-through bugs where buttons appeared clickable
    // but clicks passed through to the desktop behind the overlay.
    // this.window.setIgnoreMouseEvents(true, { forward: true }); // REMOVED

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
  }

  // ── Lifecycle: destroy ───────────────────────────────────────────────────────

  /**
   * Destroy the overlay window and flush position state.
   */
  destroy(): void {
    // Remove screen event listeners
    screen.removeListener('display-added', this.handleDisplayChange);
    screen.removeListener('display-removed', this.handleDisplayRemoved);
    screen.removeListener('display-metrics-changed', this.handleDisplayMetricsChanged);

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
    this.window.showInactive();
    this.reapplyPlatformState();
  }

  /** Hide overlay. */
  hide(): void {
    if (!this.window) return;
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
    this.window.setBounds(targetBounds);
    console.log(`[OverlayManager] after setBounds: ${JSON.stringify(this.window.getBounds())}`);
    this.persistBounds();
  }

  // ── Move / Nudge / Recenter ──────────────────────────────────────────────────

  /** Move to absolute position. */
  move(x: number, y: number): void {
    if (!this.window) return;

    this.window.setPosition(Math.round(x), Math.round(y));
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

    this.window.setBounds(clamped);
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

    this.window.setBounds({ x, y, width: bounds.width, height: bounds.height });
    this.persistBounds();
  }

  /** Apply edge snap to current bounds. */
  applySnap(): void {
    if (!this.window) return;

    const bounds = this.window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const result = computeSnap(bounds, display.workArea, this.config.snapDistance ?? SNAP_DISTANCE);

    if (result.snapped) {
      this.window.setBounds(result.bounds);
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

  /** Set content protection state and persist. Returns false on failure. */
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
        accelerator: `${prefix}+Shift+H`,
        shortcutId: 'toggle-overlay',
        action: () => this.toggle(),
      },
      {
        accelerator: `${prefix}+Shift+\\`,
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
  }

  /** Handle display-added and display-removed events. Only recenter when the
   *  overlay's actual display was affected. Otherwise just re-apply platform state. */
  private onDisplayChange(): void {
    if (!this.window) return;
    this.window.setAlwaysOnTop(true, 'screen-saver');
  }

  /** Handle display-metrics-changed (taskbar toggle, DPI change, workspace switch).
   *  Only re-apply always-on-top; do NOT reposition the overlay. */
  private onDisplayMetricsChanged(): void {
    if (!this.window) return;
    this.window.setAlwaysOnTop(true, 'screen-saver');
  }

  /** Handle display-removed event. Recenter only when the overlay's display was
   *  the one removed (the window is now orphaned on a nonexistent display).
   *  Otherwise just re-apply always-on-top. */
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
      this.window.setBounds({ x, y, width: bounds.width, height: bounds.height });
      this.persistBounds();
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

    if (saved) {
      const clamped = clampToWorkArea(
        { x: saved.x, y: saved.y, width: saved.width, height: saved.height },
        primaryDisplay.workArea,
      );
      return clamped;
    }

    const workArea = primaryDisplay.workArea;
    const width = MIN_WIDTH;
    const height = MIN_HEIGHT;
    const x = workArea.x + Math.round((workArea.width - width) / 2);
    const y = workArea.y + 20;

    return { x, y, width, height };
  }
}
