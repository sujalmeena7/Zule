// ============================================
// Zule AI — Electron Main Process
// ============================================
//
// Clean startup: only the main dashboard window opens.
// The overlay window is created on-demand when the user starts a copilot session.
//
// Design decisions:
//   - Windows-only for now (no macOS-specific code)
//   - Closing the main window quits the app (no tray clutter)
//   - No auto-launch on startup
//   - CSP headers relaxed at runtime for Electron preload injection
//   - Overlay lifecycle fully delegated to OverlayManager

import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  desktopCapturer,
  shell,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import crypto from 'node:crypto';
import { OverlayManager } from './overlayManager';

// ── Paths ────────────────────────────────────────────────────────────────────
// ESM doesn't have __dirname, so we reconstruct it from import.meta.url
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DIST = path.join(__dirname, '../dist');
const PRELOAD = path.join(__dirname, 'preload.mjs');
const DEV_URL = 'http://localhost:5173';
const isDev = !app.isPackaged;

// ── Chromium feature toggles ─────────────────────────────────────────────────
//
// We are an Electron app, not a general-purpose Chrome browser. Several
// Chromium background services try to phone home (variations, optimization
// hints, translate UI, autofill ML, cast/dial discovery, certificate-
// transparency component updater) and produce noisy "chunked upload"
// network-service errors when they cannot reach Google's endpoints from
// inside an Electron BrowserWindow.
//
// None of these features are needed for Zule, and disabling them quiets
// the dev console without affecting any user-visible behaviour. Applied
// before app.whenReady() so they take effect on first window creation.
app.commandLine.appendSwitch(
  'disable-features',
  [
    'OptimizationHints',
    'OptimizationHintsFetching',
    'OptimizationHintsFetchingAnonymousDataConsent',
    'OptimizationTargetPrediction',
    'AutofillServerCommunication',
    'CertificateTransparencyComponentUpdater',
    'MediaRouter',
    'DialMediaRouteProvider',
    'CastMediaRouteProvider',
    'Translate',
    'TranslateUI',
    'InterestFeedContentSuggestions',
    'CalculateNativeWinOcclusion',
  ].join(','),
);
// Suppress the Chromium variations service entirely. It periodically
// fetches experiment configs from clients4.google.com — a chunked POST
// that fails inside a sandboxed Electron renderer and is the exact
// source of the OnSizeReceived warnings.
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');

// ── Window / Manager references ──────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let overlayManager: OverlayManager | null = null;

// ── CSP Relaxation ───────────────────────────────────────────────────────────
// The index.html has a strict CSP that blocks Electron's preload script.
// We intercept response headers and relax script-src for the Electron context.

function relaxCSPForElectron(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};

    // Remove CSP meta-tag enforcement by stripping the header
    // (Electron's preload needs 'unsafe-inline' for injection)
    if (headers['content-security-policy']) {
      headers['content-security-policy'] = headers['content-security-policy'].map(
        (csp) =>
          csp
            .replace(/script-src\s+'self'/, "script-src 'self' 'unsafe-inline'")
      );
    }

    // Strip COOP/COEP headers that isolate popups and break Firebase Auth
    // "Cross-Origin-Opener-Policy policy would block the window.closed call."
    if (headers['cross-origin-opener-policy']) {
      delete headers['cross-origin-opener-policy'];
    }
    if (headers['cross-origin-embedder-policy']) {
      delete headers['cross-origin-embedder-policy'];
    }

    callback({ responseHeaders: headers });
  });
}

// ── getDisplayMedia handler ──────────────────────────────────────────────────
// Electron 28+ requires a display-media request handler for
// `navigator.mediaDevices.getDisplayMedia()` to return a stream. Without it,
// the call resolves to null and screen capture in the renderer silently fails.
// We auto-pick the primary screen — the user has already opted in by clicking
// the "Use Screen" button, so a second OS-level picker would be redundant.
function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        });
        if (sources.length === 0) {
          // No screens available — pass an empty selection (renderer will
          // see a NotAllowedError on the resolved stream and surface it).
          callback({});
          return;
        }
        // Pick the primary screen. A future enhancement could pop a custom
        // chooser UI if multiple screens are present and the user wants to
        // pick one.
        callback({ video: sources[0], audio: 'loopback' });
      } catch (err) {
        console.warn(
          `[main] getDisplayMedia handler failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        callback({});
      }
    },
    { useSystemPicker: false },
  );
}

// ── Create Main Window ───────────────────────────────────────────────────────

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Zule AI',
    icon: path.join(__dirname, '../public/favicon.png'),
    backgroundColor: '#0a0a12',
    // Render the page even before show so the first paint after
    // setContentProtection() is fully composited.
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      webSecurity: false,
    },
  });

  // Allow normal external links to open in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle Firebase auth via system browser deep-link
  ipcMain.handle('login-via-browser', async () => {
    return new Promise((resolve, reject) => {
      // 1. Generate a secure random state/nonce to prevent CSRF
      const stateNonce = crypto.randomBytes(32).toString('hex');
      
      // 2. Create the temporary HTTP server
      const server = http.createServer((req, res) => {
        // Set CORS headers so the web app can POST to this local server
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === 'POST' && req.url === '/token') {
          let body = '';
          req.on('data', chunk => body += chunk.toString());
          req.on('end', () => {
            try {
              const data = JSON.parse(body);
              if (data.state !== stateNonce) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid state nonce' }));
                return;
              }
              
              // Success!
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
              
              // Clean up and resolve
              cleanup();
              
              // Bring the Electron app back to the foreground
              if (mainWindow) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
                app.focus({ steal: true });
              }
              
              resolve(data.idToken);
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid request' }));
            }
          });
          return;
        }

        res.writeHead(404);
        res.end();
      });

      // 3. Handle timeouts (5 minutes)
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('Authentication timed out'));
      }, 5 * 60 * 1000);

      const cleanup = () => {
        clearTimeout(timeoutId);
        server.close();
      };

      // 4. Start the server on a dynamic port (listen(0))
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address !== 'string') {
          const port = address.port;
          // Construct the deep link to the web app
          // Use localhost in dev, vercel url in production
          const baseUrl = isDev ? 'http://localhost:5173/' : 'https://zuleai.vercel.app/';
          const authUrl = `${baseUrl}?desktop_login=true&port=${port}&state=${stateNonce}`;
          
          // Open the system default browser
          shell.openExternal(authUrl);
        } else {
          cleanup();
          reject(new Error('Failed to start local auth server'));
        }
      });
      
      server.on('error', (err) => {
        cleanup();
        reject(err);
      });
    });
  });

  // Apply screen-capture invisibility to the dashboard window too. Without
  // this, the dashboard would still appear on screen shares whenever it is
  // visible (e.g. before a copilot session is started, or after Stop). The
  // overlay window has its own protection applied via OverlayManager.
  // Wrapped in try/catch so a transient GPU-driver error here can never
  // crash the main process.
  try {
    mainWindow.setContentProtection(true);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[main] setContentProtection on dashboard failed: ${message}`);
  }

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(DIST, 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    // OverlayManager handles its own cleanup via setMainWindowRef 'closed' listener
  });

  // Diagnostic: log the exact reason the renderer process dies so we can
  // distinguish an OOM kill from a WASM/native crash etc. Without this the
  // only signal is "DevTools was disconnected" which says nothing about the
  // cause.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `[main] RENDERER GONE — reason="${details.reason}" exitCode=${details.exitCode}`,
    );
  });
  mainWindow.webContents.on('unresponsive', () => {
    console.error('[main] renderer became UNRESPONSIVE');
  });
  // Mirror renderer console errors/warnings into the main-process terminal so
  // they survive a renderer crash that wipes the DevTools console. Uses the
  // modern single-event-object signature (Electron 30+).
  mainWindow.webContents.on(
    'console-message',
    (e: Electron.Event & {
      level?: string | number;
      message?: string;
      lineNumber?: number;
      sourceId?: string;
    }) => {
      const level = typeof e.level === 'string' ? e.level : String(e.level ?? '');
      if (level === 'error' || level === 'warning' || Number(e.level) >= 2) {
        console.error(
          `[renderer:${e.sourceId ?? '?'}:${e.lineNumber ?? '?'}] ${e.message ?? ''}`,
        );
      }
    },
  );
}

// ── Mode 2 Atomic Transition ─────────────────────────────────────────────────
//
// Performs the Mode 1 → Mode 2 transition on the single live BrowserWindow
// instance (no destroy/recreate, same instanceId preserved end-to-end).
//
// The call order is load-bearing — see design.md "Atomic lifecycle ordering":
//   hide → chrome removal → transparent background → no shadow →
//   resize to 380×120 → setAlwaysOnTop(true, 'screen-saver') → showInactive
//
// `hide()` first ensures no intermediate paint reveals the old Mode 1 chrome;
// `setAlwaysOnTop(true, 'screen-saver')` is bundled in the same handler
// invocation so AOT is in effect before the next paint completes.
function applyMode2Transition(win: BrowserWindow): void {
  win.hide();
  win.setMenuBarVisibility(false);
  win.setBackgroundColor('#00000000');
  win.setHasShadow(false);
  win.setBounds({ ...win.getBounds(), width: 480, height: 80 }, false);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.showInactive();
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  // Mode 1 → Mode 2 transition. The channel takes no payload; any payload is
  // silently ignored. Operates on the existing dashboard BrowserWindow — does
  // NOT create a new window, does NOT close/destroy the existing one.
  ipcMain.handle('switch-to-overlay', () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return false;
    applyMode2Transition(win);
    return true;
  });

  // Start copilot overlay — creates and shows via OverlayManager.
  // Hide the main dashboard while the floating overlay is active so it
  // doesn't bleed through behind the transparent overlay window.
  ipcMain.handle('start-overlay', () => {
    if (!overlayManager) return false;
    overlayManager.create();
    overlayManager.show();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
    return true;
  });

  // Stop copilot overlay — destroys via OverlayManager and re-shows the
  // dashboard so the user lands back on Mode 1 cleanly.
  ipcMain.handle('stop-overlay', () => {
    if (!overlayManager) return false;
    overlayManager.destroy();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    return true;
  });

  // Content protection toggle (overlay window only — preserved for backwards compat)
  ipcMain.handle('set-content-protection', (_event, enabled: boolean) => {
    overlayManager?.setContentProtection(enabled);
    return true;
  });

  // Unified toggle: flip screen-capture invisibility on BOTH the dashboard
  // and the overlay window in a single IPC call. Wrapped in try/catch
  // because setContentProtection can throw transient GPU-driver errors
  // on some Windows configurations — the call returns `false` in that
  // case so the renderer can surface the failure without crashing.
  ipcMain.handle('toggle-visibility-protection', (_event, enabled: boolean) => {
    let ok = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.setContentProtection(enabled);
      } catch (err: unknown) {
        ok = false;
        console.warn(
          `[main] toggle-visibility-protection on dashboard failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // OverlayManager.setContentProtection has its own try/catch and
    // emits an 'overlay-error' IPC event on failure — we don't override
    // its behavior here.
    overlayManager?.setContentProtection(enabled);
    return ok;
  });

  // Always-on-top toggle
  ipcMain.handle('set-always-on-top', (_event, enabled: boolean) => {
    overlayManager?.setAlwaysOnTop(enabled);
    return true;
  });

  // Mouse event forwarding (click-through toggle).
  // NOTE: This handler is intentionally a NO-OP now. The overlay window is
  // always interactive (setIgnoreMouseEvents removed from OverlayManager.create).
  // Keeping the handler registered so the preload bridge type doesn't break,
  // but it no longer toggles click-through to avoid the racy pass-through bug.
  ipcMain.handle('set-ignore-mouse-events', (_event, _ignore: boolean, _options?: { forward?: boolean }) => {
    // Intentionally disabled — see UPGRADE-SEMANTIC-SEARCH.md for context.
    return true;
  });

  // Show/hide overlay
  ipcMain.handle('toggle-overlay', () => {
    return overlayManager?.toggle() ?? false;
  });

  // Resize overlay window
  ipcMain.handle('resize-overlay', (_event, width: number, height: number) => {
    console.log(`[main] resize-overlay called: ${width}x${height}`);
    overlayManager?.resize(width, height);
    return true;
  });

  // Move overlay window
  ipcMain.handle('move-overlay', (_event, x: number, y: number) => {
    overlayManager?.move(x, y);
    return true;
  });

  // Get overlay bounds
  ipcMain.handle('get-overlay-bounds', () => {
    return overlayManager?.getBounds() ?? null;
  });

  // Forward messages between main and overlay windows (cross-window IPC sync)
  ipcMain.on('ipc-sync-message', (_event, message: unknown) => {
    mainWindow?.webContents.send('ipc-sync-message', message);
    overlayManager?.getWindow()?.webContents.send('ipc-sync-message', message);
  });

  // Native screen capture — returns available screens/windows
  ipcMain.handle('get-desktop-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 240 },
    });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
    }));
  });
}

// ── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  relaxCSPForElectron();
  registerDisplayMediaHandler();
  registerIpcHandlers();
  createMainWindow();

  // Instantiate OverlayManager — owns all overlay lifecycle from here
  overlayManager = new OverlayManager({
    preloadPath: PRELOAD,
    rendererUrl: isDev ? DEV_URL : path.join(DIST, 'index.html'),
    isDev,
  });

  overlayManager.setMainWindowRef(mainWindow!);
  overlayManager.registerShortcuts(mainWindow!);
});

// Quit when all windows are closed (Windows behavior)
app.on('window-all-closed', () => {
  app.quit();
});

// Clean up before quitting
app.on('before-quit', () => {
  overlayManager?.unregisterShortcuts();
});

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance — focus existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
