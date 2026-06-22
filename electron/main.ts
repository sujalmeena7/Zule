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

// `electron` is a CommonJS module whose API object is created dynamically by
// the Electron runtime. This main process is bundled as ESM (the project is
// `"type": "module"`), and Node's ESM↔CJS interop cannot expose Electron's API
// cleanly: named imports fail ("does not provide an export named 'app'") because
// cjs-module-lexer can't statically detect the dynamic exports, and the default
// import is `undefined`. The reliable, Electron-documented pattern is to grab
// the API via a CommonJS `require`, which always returns the real module.
// Types are still imported by name (erased at compile time).
import { createRequire } from 'node:module';
import type { BrowserWindow as BrowserWindowType } from 'electron';
const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, session, desktopCapturer, shell } =
  require('electron') as typeof import('electron');
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import crypto from 'node:crypto';
import { OverlayManager } from './overlayManager';
import type { UpdateState } from './autoUpdateService';

// ── Paths ────────────────────────────────────────────────────────────────────
// ESM doesn't have __dirname, so we reconstruct it from import.meta.url
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DIST = path.join(__dirname, '../dist');
const PRELOAD = path.join(__dirname, 'preload.mjs');
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
const isDev = !app.isPackaged;

// ── Hardware-acceleration disable (screen-capture stealth) ──────────────────
//
// Disable Chromium's GPU acceleration BEFORE any window or `app.whenReady()`
// path runs. Per Electron docs, `app.disableHardwareAcceleration()` is only
// honoured when called at module init, before the GPU process spawns.
//
// Why: WebRTC capturers (Google Meet, Discord, Slack screen-share) on Windows
// 10 / 11 with certain DWM compositor paths use a hardware "flip-model"
// presentation that can leak overlay content even with
// `setWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` set on the window —
// because the OS-level capture-exclusion rule is bypassed when the surface is
// composited directly on the GPU. Forcing software composition makes the
// exclusion rule fire reliably across browsers and OS builds.
//
// Trade-off: marginally higher CPU on the renderer side (the overlay is small,
// so impact is negligible). The dashboard pays the same cost; this is
// acceptable in a stealth-first product where capture invisibility is a
// load-bearing feature.
app.disableHardwareAcceleration();

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

// NOTE: the on-device ML stack (local Whisper) now runs in the MAIN PROCESS via
// onnxruntime-node (see electron/whisperService.ts), so no renderer GPU/WASM
// flags are needed here. The earlier enable-unsafe-webgpu / SharedArrayBuffer
// switches were attempts to stabilise the renderer onnxruntime-web backend,
// which crashed natively (0xC0000005) regardless; they are removed.

// ── Window / Manager references ──────────────────────────────────────────────

let mainWindow: BrowserWindowType | null = null;
let overlayManager: OverlayManager | null = null;

// ── IPC Fan-Out: Auto-Update State ───────────────────────────────────────────
//
// Broadcasts UpdateState to both Dashboard and Overlay windows.
// Skips destroyed or unavailable windows silently — never throws.
// Requirement 10.6, 10.8 — Property 12: Event delivery fan-out correctness.

function broadcastUpdateState(state: UpdateState): void {
  const windows: (BrowserWindowType | null | undefined)[] = [
    mainWindow,
    overlayManager?.getWindow(),
  ];
  for (const win of windows) {
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('update:state', state);
      } catch {
        // Skip silently — window may have been destroyed between check and send
      }
    }
  }
}

// ── IPC Fan-Out: Sync Messages (Telemetry) ───────────────────────────────────
//
// Broadcasts a message to both Dashboard and Overlay windows via the
// existing `ipc-sync-message` channel. Used for forwarding telemetry
// MetricEvents from the main process to the renderer's telemetry sink.
// Follows the same fan-out pattern as vectorIndex.query telemetry.
// Requirements: 9.1, 9.2, 9.3, 9.4, 9.5

function broadcastSyncMessage(message: unknown): void {
  const windows: (BrowserWindowType | null | undefined)[] = [
    mainWindow,
    overlayManager?.getWindow(),
  ];
  for (const win of windows) {
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('ipc-sync-message', message);
      } catch {
        // Skip silently — window may have been destroyed between check and send
      }
    }
  }
}

/**
 * Cached reference to the lazily-loaded Auto_Update service module.
 *
 * The service is dynamically imported after `did-finish-load` (task 2.1)
 * to keep it off the cold-start path. We cache the resolved module here
 * so the synchronous `before-quit` handler can reach `abortDownload()`
 * and `handleBeforeQuit()` without needing a dynamic import on shutdown.
 *
 * `null` until the auto-updater is first loaded; in that case the
 * before-quit handler short-circuits (nothing to abort or install).
 */
let autoUpdateServiceModule: typeof import('./autoUpdateService') | null = null;

/**
 * Cached reference to the lazily-loaded Vector_Index service module.
 *
 * The service is dynamically imported on first use by the `vectorIndex:*`
 * IPC handlers (task 5.3) so the native `hnswlib-node` addon stays out of
 * the cold-start path for users who never query the Knowledge_Base. We
 * cache the resolved module here so the synchronous `before-quit` handler
 * below can reach `flushIndexSync` without needing to dynamic-import on
 * shutdown — Electron does not await async listeners on `before-quit`.
 *
 * `null` until the first `vectorIndex:*` IPC populates it; in that case
 * there's no in-memory state to flush so the handler short-circuits.
 */
let vectorIndexService: typeof import('./vectorIndexService') | null = null;

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

// ── Microphone / media permission handler ────────────────────────────────────
// Web Speech API (`webkitSpeechRecognition`) and any `getUserMedia({ audio })`
// call require the renderer to be granted the `media`/`audioCapture`
// permission. Electron DENIES these by default, so without this handler the
// in-bar mic button and the main transcription pipeline both fail silently:
// the recognizer constructs fine but emits `onerror`/`onend` immediately, so
// the button looks dead. We auto-grant audio (and the related media checks) —
// the user has already opted in by clicking the mic. The OS still enforces its
// own microphone privacy prompt on first use.
function registerMediaPermissionHandlers(): void {
  const ALLOWED = new Set(['media', 'audioCapture', 'mediaKeySystem']);

  // Async permission *requests* (e.g. getUserMedia, SpeechRecognition).
  session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback) => {
      callback(ALLOWED.has(permission));
    },
  );

  // Synchronous permission *checks* — some Chromium paths gate on this before
  // even issuing the async request, so it must agree with the handler above.
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission) => ALLOWED.has(permission),
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
    icon: path.join(__dirname, '../public/favicon.ico'),
    backgroundColor: '#0a0a12',
    // Render the page even before show so the first paint after
    // setContentProtection() is fully composited.
    paintWhenInitiallyHidden: true,
    // Stealth from Alt+Tab and the Windows taskbar. On Windows, Electron
    // applies the `WS_EX_TOOLWINDOW` extended window style when
    // `skipTaskbar: true`, which is exactly the style proctoring suites
    // (Honorlock, SEB) check for when scanning the Z-order for "always-on-top"
    // overlays. Combined with `setContentProtection(true)` below, the
    // dashboard is stripped from both the screen-capture buffer and the
    // standard window-enumeration walks.
    //
    // Trade-off: the user brings the dashboard back via the
    // `Cmd/Ctrl+Shift+Z` ("bring-to-front") global shortcut registered in
    // OverlayManager.registerShortcuts. Closing the only visible Mode 2
    // overlay does not orphan the user — the shortcut surfaces the window
    // again on demand.
    skipTaskbar: true,
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
              const win = mainWindow;
              if (win && !win.isDestroyed()) {
                if (win.isMinimized()) win.restore();
                win.show();
                win.focus();
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
          let baseUrl = isDev ? DEV_URL : 'https://zuleai.vercel.app';
          if (!baseUrl.endsWith('/')) baseUrl += '/';
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
function applyMode2Transition(win: BrowserWindowType): void {
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
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      win.hide();
    }
    return true;
  });

  // Stop copilot overlay — destroys via OverlayManager and re-shows the
  // dashboard so the user lands back on Mode 1 cleanly.
  ipcMain.handle('stop-overlay', () => {
    if (!overlayManager) return false;
    overlayManager.destroy();
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
    return true;
  });

  // Content protection toggle (overlay window only — preserved for backwards compat)
  ipcMain.handle('set-content-protection', (_event, enabled: boolean) => {
    return overlayManager ? overlayManager.setContentProtection(enabled) : true;
  });

  // Unified toggle: flip screen-capture invisibility on BOTH the dashboard
  // and the overlay window in a single IPC call. Wrapped in try/catch
  // because setContentProtection can throw transient GPU-driver errors
  // on some Windows configurations — the call returns `false` in that
  // case so the renderer can surface the failure without crashing.
  ipcMain.handle('toggle-visibility-protection', (_event, enabled: boolean) => {
    let ok = true;
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      try {
        win.setContentProtection(enabled);
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
    // its behavior here, but we do reflect its outcome in the return value.
    const overlayOk = overlayManager ? overlayManager.setContentProtection(enabled) : true;
    return ok && overlayOk;
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

  // ── Local Whisper transcription (runs natively in the main process) ────────
  // The renderer captures system-audio PCM and ships chunks here; onnxruntime
  // -node transcribes them. See electron/whisperService.ts for why inference is
  // not done in the renderer (native 0xC0000005 crash in the WASM engine).
  ipcMain.handle('whisper:preload', async (_event, opts?: { modelId?: string }) => {
    const { preloadWhisper } = await import('./whisperService');
    await preloadWhisper(opts?.modelId);
    return true;
  });

  ipcMain.handle(
    'whisper:transcribe',
    async (
      _event,
      pcm: Float32Array,
      opts?: { language?: string; modelId?: string },
    ) => {
      const { transcribePcm } = await import('./whisperService');
      // Electron structured-clones the Float32Array across IPC; normalise to a
      // real Float32Array view in case it arrives as a plain ArrayBuffer.
      const samples =
        pcm instanceof Float32Array ? pcm : new Float32Array(pcm as ArrayBufferLike);
      const text = await transcribePcm(samples, opts ?? {});
      return { text };
    },
  );

  ipcMain.handle('whisper:release', async () => {
    const { releaseWhisper } = await import('./whisperService');
    releaseWhisper();
    return true;
  });

  // ── Local text embeddings (also native, main-process) ──────────────────────
  // Same rationale as Whisper: onnxruntime-web crashes the renderer (0xC0000005),
  // so the embedding model runs natively here and the renderer's vectorStore
  // delegates inference over IPC.
  ipcMain.handle('embed:preload', async (_event, opts?: { modelId?: string }) => {
    const { preloadEmbedding } = await import('./embeddingService');
    await preloadEmbedding(opts?.modelId);
    return true;
  });

  ipcMain.handle(
    'embed:generate',
    async (_event, text: string, opts?: { modelId?: string }) => {
      const { generateEmbedding } = await import('./embeddingService');
      const vector = await generateEmbedding(text, opts ?? {});
      return { vector };
    },
  );

  ipcMain.handle(
    'embed:generateBatch',
    async (_event, texts: string[], opts?: { modelId?: string }) => {
      const { generateEmbeddingBatch } = await import('./embeddingService');
      const vectors = await generateEmbeddingBatch(texts, opts ?? {});
      return { vectors };
    },
  );

  // ── Vector_Index (HNSW, native, main-process) ──────────────────────────────
  // The HNSW graph lives here beside the embedding service so upload-time
  // inserts skip an extra IPC trip. Each handler lazy-loads the service module
  // on first use and caches it to the module-level `vectorIndexService`
  // reference; the `before-quit` handler reaches into the same reference to
  // run a synchronous `flushIndexSync` before shutdown (Electron does not
  // await async `before-quit` listeners).
  //
  // The mutating handlers (`rebuild`, `addBatch`, `remove`, `flush`) wrap the
  // service's `void` return in `true` so the renderer's `Promise<boolean>`
  // contract in `electron/preload.ts` is honoured.
  //
  // Telemetry: `vectorIndex:query` times the call and emits exactly one
  // `{ kind: 'vectorIndex.query', k, resultCount, durationMs }` MetricEvent
  // through the existing `ipc-sync-message` channel (Property 20 /
  // Requirement 10.2). The renderer's `telemetry.emit` consumer picks it up
  // and persists it through the same path as every other MetricEvent.
  //
  // TODO: the typed `vector-index.query-invalid` and
  // `vector-index.snapshot-corrupt` diagnostics emitted from inside
  // `vectorIndexService.ts` still go through `console.warn` for now —
  // tasks 5.4 / 5.6 / 5.8 will decide whether to capture them through a
  // dedicated diagnostic sink or directly via `console.warn` spies.

  async function loadVectorIndexService(): Promise<
    typeof import('./vectorIndexService')
  > {
    if (!vectorIndexService) {
      vectorIndexService = await import('./vectorIndexService');
    }
    return vectorIndexService;
  }

  ipcMain.handle(
    'vectorIndex:rebuild',
    async (
      _event,
      items: { id: string; vector: number[] }[],
      numDimensions: number,
    ) => {
      const svc = await loadVectorIndexService();
      await svc.rebuildVectorIndex(items, numDimensions);
      return true;
    },
  );

  ipcMain.handle(
    'vectorIndex:addBatch',
    async (_event, items: { id: string; vector: number[] }[]) => {
      const svc = await loadVectorIndexService();
      await svc.addBatchToIndex(items);
      return true;
    },
  );

  ipcMain.handle('vectorIndex:remove', async (_event, id: string) => {
    const svc = await loadVectorIndexService();
    await svc.removeFromIndex(id);
    return true;
  });

  ipcMain.handle(
    'vectorIndex:query',
    async (_event, vector: number[], k: number) => {
      const svc = await loadVectorIndexService();
      const startedAt = Date.now();
      const hits = await svc.queryIndex(vector, k);
      const durationMs = Date.now() - startedAt;

      // Emit one `vectorIndex.query` MetricEvent through the existing
      // cross-window sync channel. Both windows receive the message so the
      // renderer-side `telemetry.emit` pipeline (which lives in the
      // dashboard) records it once; the overlay copy mirrors the existing
      // `ipc-sync-message` fan-out and is harmless for non-MetricEvent
      // listeners.
      const event = {
        kind: 'vectorIndex.query' as const,
        k,
        resultCount: hits.length,
        durationMs,
      };
      mainWindow?.webContents.send('ipc-sync-message', event);
      overlayManager?.getWindow()?.webContents.send('ipc-sync-message', event);

      return hits;
    },
  );

  ipcMain.handle('vectorIndex:flush', async () => {
    const svc = await loadVectorIndexService();
    await svc.flushIndex();
    return true;
  });

  // Renderer-driven cold-start hydration (Requirements 3.1, 3.2).
  //
  // The renderer calls this from its `embedPreload` boot path, before the
  // Knowledge_Base UI signals ready. We attempt to load the persisted
  // snapshot from `<userData>/vector-index.bin` + `vector-index.json`;
  // `preloadVectorIndex` reports a typed `vector-index.snapshot-corrupt`
  // diagnostic on any failure mode and resets to an empty in-memory state.
  // The returned `count` is the live (non-deleted) item count after
  // preload — a `0` here paired with a non-empty IndexedDB tells the
  // renderer the snapshot was missing or corrupt, so it follows up with
  // `vectorIndex:rebuild` from the IndexedDB chunks.
  ipcMain.handle('vectorIndex:hydrate', async () => {
    const svc = await loadVectorIndexService();
    await svc.preloadVectorIndex();
    return svc.getIndexStatus();
  });

  // ── Auto-Update IPC Handlers ─────────────────────────────────────────────
  // Registered eagerly so they're available even before the service loads.
  // They reject with a typed error if the service hasn't initialized yet
  // (graceful degradation, Requirement 11.5).
  //
  // Requirements: 2.1, 2.2, 8.4, 10.2, 10.3, 10.4, 10.5, 10.6

  ipcMain.handle('update:check', async () => {
    if (!autoUpdateServiceModule) {
      throw { stage: 'check', category: 'unavailable' };
    }
    const service = autoUpdateServiceModule.getAutoUpdateService();
    return service.checkForUpdate('manual');
  });

  ipcMain.handle('update:download', async () => {
    if (!autoUpdateServiceModule) {
      throw { stage: 'download', category: 'unavailable' };
    }
    const service = autoUpdateServiceModule.getAutoUpdateService();
    return service.downloadUpdate();
  });

  ipcMain.handle('update:cancel', async () => {
    if (!autoUpdateServiceModule) {
      throw { stage: 'download', category: 'unavailable' };
    }
    const service = autoUpdateServiceModule.getAutoUpdateService();
    return service.cancelDownload();
  });

  ipcMain.handle('update:install', async () => {
    if (!autoUpdateServiceModule) {
      throw { stage: 'install', category: 'unavailable' };
    }
    const service = autoUpdateServiceModule.getAutoUpdateService();
    return service.installUpdate();
  });

  ipcMain.handle('update:defer', async () => {
    if (!autoUpdateServiceModule) {
      throw { stage: 'install', category: 'unavailable' };
    }
    const service = autoUpdateServiceModule.getAutoUpdateService();
    service.deferInstall();
  });
}

// ── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  relaxCSPForElectron();
  registerDisplayMediaHandler();
  registerMediaPermissionHandlers();
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

  // ── Auto-Update Service (lazy-loaded after dashboard finishes loading) ────
  // Kept off the synchronous startup path (Requirement 8.4). Once loaded,
  // state-change events are broadcast to both windows via IPC fan-out
  // (Requirements 10.6, 10.8).
  mainWindow!.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const mod = await import('./autoUpdateService');
        autoUpdateServiceModule = mod;
        const service = mod.getAutoUpdateService();
        service.onStateChange((state) => broadcastUpdateState(state));

        // Wire telemetry emitter — forward update lifecycle events to the
        // renderer's telemetry sink via the existing `ipc-sync-message`
        // channel (same pattern as vectorIndex.query telemetry).
        // Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
        service.setTelemetryEmitter((event) => {
          broadcastSyncMessage(event);
        });

        // Trigger background startup check (Requirement 2.1)
        service.checkForUpdate('startup').catch(() => {
          // Silently ignore — offline-first (Requirement 8.1)
        });
      } catch (err) {
        console.warn(
          `[main] autoUpdateService init failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Graceful degradation — IPC handlers (task 5.1) will reject with
        // typed errors; the renderer remains in idle state (Req 11.5).
      }
    }, 3000); // 3s delay keeps it within the 5s budget (Req 2.1)
  });
});

// Quit when all windows are closed (Windows behavior)
app.on('window-all-closed', () => {
  app.quit();
});

// Clean up before quitting
app.on('before-quit', () => {
  overlayManager?.unregisterShortcuts();

  // ── Auto-updater graceful shutdown (Requirements 8.5, 6.4) ───────────
  // Abort any in-progress download within the 2-second budget, discard
  // partial bytes, and launch the staged installer if the user chose
  // "Install on next quit". Wrapped in try/catch so updater issues never
  // block app exit.
  if (autoUpdateServiceModule) {
    try {
      const updateService = autoUpdateServiceModule.getAutoUpdateService();
      updateService.abortDownload();      // cancel in-flight download within 2s
      updateService.handleBeforeQuit();   // deferred install if flag is set
    } catch (err) {
      console.warn(
        `[main] autoUpdateService shutdown failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Best-effort synchronous flush of the Vector_Index snapshot so an
  // add/remove/rebuild that happened after the last debounced flush still
  // lands on disk. Electron does not await async `before-quit` handlers,
  // so we use the sync writer (`writeIndexSync` + `fs.writeFileSync`).
  //
  // No-op when the service module was never loaded — the user never
  // touched the Knowledge_Base in this session, so there's nothing to
  // persist. Wrapped in try/catch so a flush error never blocks shutdown.
  if (vectorIndexService) {
    try {
      vectorIndexService.flushIndexSync();
    } catch (err) {
      console.warn(
        `[main] vectorIndex flush on quit failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
});

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance — focus existing window
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}
