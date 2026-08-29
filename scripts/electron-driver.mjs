// ============================================================================
// Zule AI — Electron Driver (dev/verification only)
// ============================================================================
//
// Launches the packaged-bundle Electron app under Playwright and drives it.
// Two modes:
//
//   node scripts/electron-driver.mjs            # run the scripted checks, print JSON
//   node scripts/electron-driver.mjs --repl     # interactive REPL
//
// Prerequisites:
//   1. `npx vite build --config vite.electron.config.ts` (produces dist-electron/)
//   2. a renderer dev server on :5173 (`npx vite --port 5173`), because an
//      unpackaged main.ts loads VITE_DEV_SERVER_URL || http://localhost:5173
//
// GOTCHA: this environment exports ELECTRON_RUN_AS_NODE=1, which makes
// electron.exe behave as plain Node — `require('electron').app` is undefined and
// the app dies at startup. The driver deletes it from the child env below; if you
// launch electron by hand, use `env -u ELECTRON_RUN_AS_NODE`.
//
// The scripted checks exercise the main-process Whisper service over the real
// `whisper:*` IPC surface with synthetic PCM. That verifies the two-session
// architecture, the priority queue, partial superseding and refcounted release
// against real onnxruntime-node inference — none of which unit tests can reach.
// It does NOT verify transcription ACCURACY (synthetic PCM contains no speech).
//
// GOTCHA 2: the checks do NOT go through the app's preload bridge. Under a raw
// Playwright launch `window.electronAPI` never materialises in the app window
// (and `webContents.executeJavaScript` against it hangs), so instead the driver
// opens its own hidden BrowserWindow with `nodeIntegration: true,
// contextIsolation: false, sandbox: false` and calls `ipcRenderer.invoke`
// straight from it. Same ipcMain handlers, same inference, no bridge dependency.
// `page` is still the app window, so `ss`/`text`/`eval` inspect the real UI.

import { _electron as electron } from 'playwright-core';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.driver-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

// Set PACKAGED_APP to a built exe (e.g. release/win-unpacked/DesktopHelper.exe)
// to run the same checks against a packaged build instead of the source tree.
// That is the only way to catch model paths that resolve in dev but not from
// app.asar.unpacked — and a packaged run needs no dev server.
//
// Resolved against APP_DIR because `launch()` sets cwd to the exe's own
// directory: a relative PACKAGED_APP would then be re-resolved against that
// directory and Playwright reports a bare "Process failed to launch!".
const PACKAGED_APP = process.env.PACKAGED_APP
  ? path.resolve(APP_DIR, process.env.PACKAGED_APP)
  : '';

const electronBin =
  PACKAGED_APP ||
  (process.platform === 'win32'
    ? path.join(APP_DIR, 'node_modules/electron/dist/electron.exe')
    : process.platform === 'darwin'
      ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
      : path.join(APP_DIR, 'node_modules/electron/dist/electron'));

let app = null;
let page = null;
let harness = null;

/**
 * Open a hidden Node-integrated window and return its Playwright page. Calls
 * made from it reach ipcMain exactly as the app's own calls do, but need no
 * preload bridge — see GOTCHA 2 in the header.
 */
async function attachHarness() {
  await app.evaluate(async ({ BrowserWindow }) => {
    const w = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    });
    await w.loadURL('about:blank');
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) if (w.url() === 'about:blank') return w;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('harness window never appeared');
}

async function launch() {
  // ELECTRON_RUN_AS_NODE must be absent, not empty — an empty value still trips
  // the Node startup path and aborts on a snapshot assertion.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: electronBin,
    args: PACKAGED_APP ? [] : [APP_DIR],
    cwd: PACKAGED_APP ? path.dirname(PACKAGED_APP) : APP_DIR,
    env,
    timeout: 60_000,
  });
  // Poll for the app's renderer window (identified by URL, not by bridge —
  // the bridge is not reachable under this launch mode).
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !page) {
    for (const w of app.windows()) {
      if (w.url().startsWith('devtools://') || w.url() === 'about:blank') continue;
      const ready = await w.evaluate(() => document.readyState === 'complete').catch(() => false);
      if (ready) { page = w; break; }
    }
    if (!page) await new Promise((r) => setTimeout(r, 500));
  }
  if (!page) {
    const diag = [];
    for (const w of app.windows()) {
      diag.push(
        await w
          .evaluate(() => ({ url: location.href, title: document.title, readyState: document.readyState }))
          .catch((e) => ({ url: w.url(), evalError: e.message })),
      );
    }
    throw new Error('no app renderer window became ready within 45s; windows=' + JSON.stringify(diag));
  }
  harness = await attachHarness();
}

/**
 * The scripted verification suite. Runs inside the Node-integrated harness
 * window so it talks to the real ipcMain handlers, and returns plain JSON.
 */
async function runChecks() {
  return harness.evaluate(async () => {
    const { ipcRenderer } = window.require('electron');
    const preload = (o) => ipcRenderer.invoke('whisper:preload', o);
    const transcribe = (pcm, o) => ipcRenderer.invoke('whisper:transcribe', pcm, o);
    const release = (o) => ipcRenderer.invoke('whisper:release', o);

    const out = { checks: [] };
    const record = (name, pass, detail) => out.checks.push({ name, pass, detail });

    // 2 s of 16 kHz mono. Low-amplitude noise, not silence: whisperService has
    // no VAD of its own (that gate lives in the renderer provider), so this
    // still exercises a full encoder+decoder pass.
    const pcm = (seconds = 2) => {
      const a = new Float32Array(16000 * seconds);
      for (let i = 0; i < a.length; i++) a[i] = (Math.random() - 0.5) * 0.02;
      return a;
    };

    // ── Both sessions load ──────────────────────────────────────────────────
    const t0 = performance.now();
    const loadedLoop = await preload({ pipeline: 'loopback' });
    const loadedMic = await preload({ pipeline: 'microphone' });
    const preloadMs = Math.round(performance.now() - t0);
    record('both pipelines preload', loadedLoop === true && loadedMic === true, {
      preloadMs,
      loadedLoop,
      loadedMic,
    });

    // ── Both tiers infer and report queue/infer split ───────────────────────
    //
    // The FIRST inference on a session pays model load + graph warmup, which is
    // several seconds and swamps the model-size difference. So warm each tier
    // once, then compare steady-state medians — otherwise whichever tier runs
    // first looks slower purely from ordering.
    const coldFinal = await transcribe(pcm(), { pipeline: 'loopback', kind: 'final', seq: 1 });
    const coldPartial = await transcribe(pcm(), { pipeline: 'loopback', kind: 'partial', seq: 2 });
    record('base.en final inference returns metrics', typeof coldFinal?.inferMs === 'number', coldFinal);
    record('tiny.en partial inference returns metrics', typeof coldPartial?.inferMs === 'number', coldPartial);

    const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const finalMs = [];
    const partialMs = [];
    for (let i = 0; i < 3; i++) {
      finalMs.push((await transcribe(pcm(), { pipeline: 'loopback', kind: 'final', seq: 100 + i })).inferMs);
      partialMs.push((await transcribe(pcm(), { pipeline: 'loopback', kind: 'partial', seq: 200 + i })).inferMs);
    }
    record(
      'warm tiny.en partial is faster than warm base.en final',
      median(partialMs) < median(finalMs),
      {
        warmFinalMs: finalMs,
        warmPartialMs: partialMs,
        medianFinalMs: median(finalMs),
        medianPartialMs: median(partialMs),
        coldFinalMs: coldFinal?.inferMs,
        coldPartialMs: coldPartial?.inferMs,
      },
    );

    // ── Priority queue: loopback final must overtake a queued mic final ─────
    //
    // The queue orders WAITING items only — an in-flight run is never preempted
    // (onnxruntime-node has no cancellation). So a blocker has to occupy the
    // base.en worker first, otherwise whichever request arrives first simply
    // starts immediately and there is nothing to reorder.
    const order = [];
    const blocker = transcribe(pcm(), { pipeline: 'microphone', kind: 'final', seq: 9 });
    await new Promise((r) => setTimeout(r, 500)); // let the blocker start
    const mic = transcribe(pcm(), { pipeline: 'microphone', kind: 'final', seq: 10 })
      .then((r) => { order.push('microphone'); return r; });
    const loop = transcribe(pcm(), { pipeline: 'loopback', kind: 'final', seq: 11 })
      .then((r) => { order.push('loopback'); return r; });
    const [, micR, loopR] = await Promise.all([blocker, mic, loop]);
    record('loopback final is dequeued before a pending mic final', order[0] === 'loopback', {
      order,
      loopbackQueueMs: loopR?.queueMs,
      microphoneQueueMs: micR?.queueMs,
    });

    // ── Stale partials are superseded ───────────────────────────────────────
    //
    // Same asymmetry: of N back-to-back partials the first starts immediately
    // and the last is the newest, so exactly N-2 are dropped while waiting.
    // NOTE: seq must keep increasing across the whole run — the service also
    // drops any partial whose seq is below the newest already *processed* one,
    // so reusing low numbers here makes every request look stale.
    const seqs = [300, 301, 302, 303, 304];
    const partials = await Promise.all(
      seqs.map((seq) => transcribe(pcm(1), { pipeline: 'loopback', kind: 'partial', seq })),
    );
    const superseded = partials.filter((p) => (p?.text ?? '') === '').length;
    record(
      'older queued partials are superseded, newest survives',
      superseded === seqs.length - 2 && (partials[partials.length - 1]?.text ?? '') !== '',
      {
        texts: partials.map((p) => p?.text ?? null),
        superseded,
        expectedSuperseded: seqs.length - 2,
      },
    );

    // ── Refcounted release keeps the other pipeline's session alive ──────────
    await release({ pipeline: 'loopback' });
    const afterRelease = await transcribe(pcm(), {
      pipeline: 'microphone',
      kind: 'final',
      seq: 400,
    });
    record(
      'microphone still transcribes after loopback release (refcount)',
      typeof afterRelease?.inferMs === 'number',
      afterRelease,
    );

    return out;
  });
}

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched');
    await launch();
    console.log('launched. windows:');
    for (const w of app.windows()) console.log(' ', w.url());
  },
  async ss(name) {
    if (!page) return console.log('ERROR: launch first');
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png');
    await page.screenshot({ path: f });
    console.log('screenshot:', f);
  },
  async checks() {
    if (!page) return console.log('ERROR: launch first');
    console.log(JSON.stringify(await runChecks(), null, 2));
  },
  async eval(expr) {
    if (!page) return console.log('ERROR: launch first');
    try { console.log(JSON.stringify(await page.evaluate(expr))); }
    catch (e) { console.log('ERROR:', e.message); }
  },
  async text(sel) {
    if (!page) return console.log('ERROR: launch first');
    console.log(await page.evaluate(
      (s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)',
      sel || null));
  },
  async windows() {
    if (!app) return console.log('ERROR: launch first');
    for (const w of app.windows()) console.log(' ', w.url());
  },
  async ipc(line) {
    if (!harness) return console.log('ERROR: launch first');
    const [channel, ...json] = line.trim().split(/\s+/);
    if (!channel) return console.log('usage: ipc <channel> [jsonArg]');
    const arg = json.length ? JSON.parse(json.join(' ')) : undefined;
    try {
      console.log(JSON.stringify(await harness.evaluate(
        ([ch, a]) => window.require('electron').ipcRenderer.invoke(ch, a),
        [channel, arg],
      )));
    } catch (e) { console.log('ERROR:', e.message); }
  },
  async quit() {
    if (app) await app.close().catch(() => {});
    app = null; page = null; harness = null;
  },
  help() { console.log('commands:', Object.keys(COMMANDS).join(', ')); },
};

if (process.argv.includes('--repl')) {
  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout, prompt: 'driver> ',
  });
  rl.on('line', async (line) => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    if (!cmd) return rl.prompt();
    const fn = COMMANDS[cmd];
    if (!fn) { console.log('unknown:', cmd, '- try: help'); return rl.prompt(); }
    try { await fn(rest.join(' ')); } catch (e) { console.log('ERROR:', e.message); }
    if (cmd === 'quit') { rl.close(); process.exit(0); }
    rl.prompt();
  });
  rl.on('close', async () => { await COMMANDS.quit(); process.exit(0); });
  console.log('zule driver — "help" for commands, "launch" to start');
  rl.prompt();
} else {
  // Scripted mode: launch, screenshot, run the checks, report, exit non-zero on failure.
  try {
    await launch();
    const shot = path.join(SHOT_DIR, 'launch.png');
    await page.screenshot({ path: shot }).catch(() => {});
    console.log('WINDOWS: ' + app.windows().map((w) => w.url()).join(' | '));
    console.log('SCREENSHOT: ' + shot);
    const result = await runChecks();
    console.log('RESULT ' + JSON.stringify(result, null, 2));
    const failed = result.checks.filter((c) => !c.pass);
    console.log(`\nSUMMARY: ${result.checks.length - failed.length}/${result.checks.length} passed`);
    for (const f of failed) console.log('FAILED: ' + f.name);
    await app.close().catch(() => {});
    process.exit(failed.length ? 1 : 0);
  } catch (e) {
    console.log('DRIVER ERROR: ' + (e?.stack || e?.message || String(e)));
    if (app) await app.close().catch(() => {});
    process.exit(2);
  }
}


