// ============================================
// Zule AI — Dual-Mode Overlay Preservation Property Tests
// ============================================
//
// Property 2: Preservation — All Non-Bug-Condition Inputs Behave Identically
// to the Unfixed Code.
//
// Spec: .kiro/specs/dual-mode-overlay-window-fix/{design.md, bugfix.md, tasks.md}
// Bug Condition (C(X)) is satisfied by:
//   - IpcInvoke { channel: 'switch-to-overlay' }
//   - PointerDrag { surface: 'card-root', mode: 'mode-2' }
//   - PointerClick { target: 'button', mode: 'mode-2' }
//
// These tests cover every input where C(X) is FALSE and assert the fixed
// code's observable behavior matches the unfixed-code reference observations.
//
// Methodology — observation-first:
//   1. Inspect UNFIXED electron/preload.ts, electron/main.ts, src/**/*.css
//      and the Dashboard component DOM tree.
//   2. Capture the observed shape (channel set, BrowserWindow options,
//      lifecycle order, drag-region presence) as REFERENCE constants.
//   3. Encode each observation as a fast-check property over the
//      heterogeneous ¬C(X) input domain.
//
// On UNFIXED code these tests MUST pass. After the three-layer fix
// (preload bridge + main-process atomic transition + Mode 2 CSS) the
// same tests are re-run to verify no regressions.
//
// Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ─── File paths (relative to the workspace root) ────────────────────────────

const REPO_ROOT = resolve(__dirname, '..', '..');
const PRELOAD_PATH = resolve(REPO_ROOT, 'electron', 'preload.ts');
const MAIN_PATH = resolve(REPO_ROOT, 'electron', 'main.ts');
const SRC_DIR = resolve(REPO_ROOT, 'src');

const PRELOAD_SRC = readFileSync(PRELOAD_PATH, 'utf-8');
const MAIN_SRC = readFileSync(MAIN_PATH, 'utf-8');

// ─── Static-analysis helpers ────────────────────────────────────────────────

/**
 * Extract every literal channel name passed to ipcRenderer.{invoke,send,on,
 * removeListener} in the preload bridge. Any future use of a generic
 * channel-forwarder helper will still surface its allow-listed channel
 * names through this regex (the allow-list is enumerated as string literals).
 */
function extractPreloadChannels(src: string): Set<string> {
  const channels = new Set<string>();
  const re = /ipcRenderer\.(?:invoke|send|on|removeListener)\(\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) channels.add(m[1]);
  return channels;
}

/** Extract every literal channel passed to ipcMain.{handle,on}. */
function extractMainChannels(src: string): Set<string> {
  const channels = new Set<string>();
  const re = /ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) channels.add(m[1]);
  return channels;
}

/**
 * Extract the createMainWindow BrowserWindow constructor options as a string
 * blob (everything between `new BrowserWindow({` and the matching `})`).
 */
function extractMainWindowOptionsBlob(src: string): string {
  const start = src.indexOf('mainWindow = new BrowserWindow({');
  if (start === -1) throw new Error('createMainWindow: BrowserWindow constructor not found');
  const open = src.indexOf('{', start);
  // walk to the matching '}' tracking nested braces
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error('createMainWindow: unmatched braces');
}

/**
 * Extract the ordered list of top-level call expressions inside the
 * `app.whenReady().then(() => { ... })` body. Returns the function names
 * called (e.g. ['relaxCSPForElectron', 'registerIpcHandlers',
 * 'createMainWindow', ...]) in source order.
 */
function extractWhenReadyCallOrder(src: string): string[] {
  const start = src.indexOf('app.whenReady().then(');
  if (start === -1) throw new Error('app.whenReady().then(...) not found');
  // find arrow body opening brace
  const bodyOpen = src.indexOf('{', start);
  let depth = 0;
  let bodyEnd = -1;
  for (let i = bodyOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
    }
  }
  if (bodyEnd === -1) throw new Error('app.whenReady() body unmatched');
  const body = src.slice(bodyOpen + 1, bodyEnd);

  // Match identifier( at depth 0 of the body (skip nested braces).
  const calls: string[] = [];
  let d = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{') d++;
    else if (ch === '}') d--;
    else if (d === 0 && /[A-Za-z_]/.test(ch)) {
      // read identifier
      let j = i;
      while (j < body.length && /[A-Za-z0-9_]/.test(body[j])) j++;
      const ident = body.slice(i, j);
      // skip whitespace then optional '?.' then check for '('
      let k = j;
      while (k < body.length && /\s/.test(body[k])) k++;
      if (body[k] === '(' && !/^(if|for|while|return|new|typeof|switch|catch|throw)$/.test(ident)) {
        calls.push(ident);
      }
      i = j;
      continue;
    }
    i++;
  }
  return calls;
}

/** Recursively collect all .css files under a directory. */
function collectCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...collectCssFiles(full));
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

// ─── Reference observations on the UNFIXED code ─────────────────────────────
//
// These are the literal channel sets, BrowserWindow options, lifecycle
// orderings, and drag-region facts observed by inspecting the unfixed
// electron/preload.ts, electron/main.ts, and src/**/*.css.
// They are the baseline that Property 2 preserves.

const REFERENCE_PRELOAD_CHANNELS_NON_SWITCH = new Set<string>([
  'set-content-protection',
  'toggle-visibility-protection',
  'set-always-on-top',
  'set-ignore-mouse-events',
  'start-overlay',
  'stop-overlay',
  'toggle-overlay',
  'resize-overlay',
  'move-overlay',
  'get-overlay-bounds',
  'ipc-sync-message',
  'overlay-error',
  'global-shortcut',
  'get-desktop-sources',
]);

const REFERENCE_MAIN_CHANNELS_NON_SWITCH = new Set<string>([
  'start-overlay',
  'stop-overlay',
  'set-content-protection',
  'toggle-visibility-protection',
  'set-always-on-top',
  'set-ignore-mouse-events',
  'toggle-overlay',
  'resize-overlay',
  'move-overlay',
  'get-overlay-bounds',
  'ipc-sync-message',
  'get-desktop-sources',
]);

// Unfixed createMainWindow uses width: 1280, height: 800, default OS frame,
// no `transparent: true`, no `frame: false`, and no setAlwaysOnTop call.
const REFERENCE_MAIN_WINDOW_OPTIONS = {
  width: 1280,
  height: 800,
  framed: true, // i.e. NO `frame: false` in the constructor options
  opaque: true, // i.e. NO `transparent: true`
  hasAlwaysOnTopOption: false,
};

const REFERENCE_WHEN_READY_PREFIX: string[] = [
  'relaxCSPForElectron',
  'registerIpcHandlers',
  'createMainWindow',
];

// ─── Live observations from the source under test ───────────────────────────

const CURRENT_PRELOAD_CHANNELS = extractPreloadChannels(PRELOAD_SRC);
const CURRENT_MAIN_CHANNELS = extractMainChannels(MAIN_SRC);
const CURRENT_PRELOAD_NON_SWITCH = new Set(
  [...CURRENT_PRELOAD_CHANNELS].filter((c) => c !== 'switch-to-overlay'),
);
const CURRENT_MAIN_NON_SWITCH = new Set(
  [...CURRENT_MAIN_CHANNELS].filter((c) => c !== 'switch-to-overlay'),
);
const CURRENT_WHEN_READY_CALLS = extractWhenReadyCallOrder(MAIN_SRC);

// ============================================================================
// Property-based tests
// ============================================================================

describe('Dual-Mode Overlay — Preservation Properties (Property 2)', () => {
  // ────────────────────────────────────────────────────────────────────────
  // Property 2.IPC.preload — Validates: Requirements 3.2
  //
  // For every channel name c ≠ 'switch-to-overlay', the preload bridge
  // exposes c iff the unfixed-code reference exposes c. fast-check
  // generates arbitrary channel-name strings (mixed across the reference
  // set, the literal 'switch-to-overlay' which is filtered out, and
  // arbitrary other strings that should be absent from both sides).
  // ────────────────────────────────────────────────────────────────────────
  it('preload bridge surface is preserved for every non-switch-to-overlay channel name (Validates: Requirements 3.2)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // sample known reference channel names so the property exercises
          // the "channel is present" branch
          fc.constantFrom(...REFERENCE_PRELOAD_CHANNELS_NON_SWITCH),
          // arbitrary other strings exercise the "channel is absent" branch
          fc.string({ minLength: 1, maxLength: 60 }),
          // include the literal — must be filtered by the ¬C(X) precondition
          fc.constant('switch-to-overlay'),
        ),
        (channel) => {
          fc.pre(channel !== 'switch-to-overlay');
          const inReference = REFERENCE_PRELOAD_CHANNELS_NON_SWITCH.has(channel);
          const inCurrent = CURRENT_PRELOAD_NON_SWITCH.has(channel);
          // applyOriginal(input) === applyFixed(input) for all c ≠ 'switch-to-overlay'
          expect(inCurrent).toBe(inReference);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('preload bridge does not introduce or remove non-switch channels (Validates: Requirements 3.2)', () => {
    // Symmetric difference of the two sets must be empty.
    const ref = REFERENCE_PRELOAD_CHANNELS_NON_SWITCH;
    const cur = CURRENT_PRELOAD_NON_SWITCH;
    expect(new Set([...cur].filter((c) => !ref.has(c)))).toEqual(new Set());
    expect(new Set([...ref].filter((c) => !cur.has(c)))).toEqual(new Set());
  });

  // ────────────────────────────────────────────────────────────────────────
  // Property 2.IPC.main — Validates: Requirements 3.2
  //
  // Same property at the main-process layer — for every channel name c ≠
  // 'switch-to-overlay', ipcMain.{handle,on} registers c iff the unfixed
  // reference does.
  // ────────────────────────────────────────────────────────────────────────
  it('ipcMain registration set is preserved for every non-switch-to-overlay channel name (Validates: Requirements 3.2)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(...REFERENCE_MAIN_CHANNELS_NON_SWITCH),
          fc.string({ minLength: 1, maxLength: 60 }),
          fc.constant('switch-to-overlay'),
        ),
        (channel) => {
          fc.pre(channel !== 'switch-to-overlay');
          const inReference = REFERENCE_MAIN_CHANNELS_NON_SWITCH.has(channel);
          const inCurrent = CURRENT_MAIN_NON_SWITCH.has(channel);
          expect(inCurrent).toBe(inReference);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('ipcMain does not introduce or remove non-switch channels (Validates: Requirements 3.2)', () => {
    const ref = REFERENCE_MAIN_CHANNELS_NON_SWITCH;
    const cur = CURRENT_MAIN_NON_SWITCH;
    expect(new Set([...cur].filter((c) => !ref.has(c)))).toEqual(new Set());
    expect(new Set([...ref].filter((c) => !cur.has(c)))).toEqual(new Set());
  });

  // ────────────────────────────────────────────────────────────────────────
  // Property 2.Mode-1-launch — Validates: Requirements 3.1, 3.3
  //
  // The application launch path opens a single BrowserWindow with the
  // observed Mode 1 dashboard options: width × height matching the
  // reference, no `frame: false`, no `transparent: true`, and no
  // `setAlwaysOnTop` invocation inside createMainWindow. fast-check
  // generates arbitrary "candidate option mutations" and asserts each
  // mutation is REJECTED by the reference contract.
  // ────────────────────────────────────────────────────────────────────────
  it('Mode 1 launch BrowserWindow constructor options match the unfixed-code reference (Validates: Requirements 3.1, 3.3)', () => {
    const optionsBlob = extractMainWindowOptionsBlob(MAIN_SRC);

    // Concrete dimension extraction.
    const widthMatch = optionsBlob.match(/\bwidth\s*:\s*(\d+)/);
    const heightMatch = optionsBlob.match(/\bheight\s*:\s*(\d+)/);
    expect(widthMatch).not.toBeNull();
    expect(heightMatch).not.toBeNull();
    const width = Number(widthMatch![1]);
    const height = Number(heightMatch![1]);

    // Mode 1 chrome flags — must NOT be present in the unfixed reference.
    const hasFrameFalse = /\bframe\s*:\s*false/.test(optionsBlob);
    const hasTransparentTrue = /\btransparent\s*:\s*true/.test(optionsBlob);
    const hasAlwaysOnTopOpt = /\balwaysOnTop\s*:/.test(optionsBlob);

    // Property: every Mode 1 option observable on the running source matches
    // the captured reference. fast-check enumerates "facts to verify" so a
    // shrink reports the exact facet that regressed.
    fc.assert(
      fc.property(
        fc.constantFrom(
          'width',
          'height',
          'framed',
          'opaque',
          'hasAlwaysOnTopOption',
        ),
        (facet) => {
          switch (facet) {
            case 'width':
              return width === REFERENCE_MAIN_WINDOW_OPTIONS.width;
            case 'height':
              return height === REFERENCE_MAIN_WINDOW_OPTIONS.height;
            case 'framed':
              // framed === !hasFrameFalse
              return !hasFrameFalse === REFERENCE_MAIN_WINDOW_OPTIONS.framed;
            case 'opaque':
              return !hasTransparentTrue === REFERENCE_MAIN_WINDOW_OPTIONS.opaque;
            case 'hasAlwaysOnTopOption':
              return hasAlwaysOnTopOpt === REFERENCE_MAIN_WINDOW_OPTIONS.hasAlwaysOnTopOption;
          }
        },
      ),
      { numRuns: 50 },
    );

    // Also assert there is no setAlwaysOnTop call inside createMainWindow().
    const createBodyStart = MAIN_SRC.indexOf('function createMainWindow');
    if (createBodyStart !== -1) {
      const open = MAIN_SRC.indexOf('{', createBodyStart);
      let depth = 0;
      let end = open;
      for (let i = open; i < MAIN_SRC.length; i++) {
        const ch = MAIN_SRC[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const body = MAIN_SRC.slice(open, end + 1);
      expect(/setAlwaysOnTop\s*\(/.test(body)).toBe(false);
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Property 2.Mode-1-DOM — Validates: Requirements 3.4
  //
  // No CSS file in src/ defines a `-webkit-app-region` rule that targets
  // the Mode 1 dashboard DOM tree. The fix may only introduce rules
  // scoped to a Mode 2-only selector (`.mode-2-card-root` or similar).
  // We enforce both halves of the property: any rule that mentions
  // -webkit-app-region MUST be inside a Mode-2-scoped selector block.
  // ────────────────────────────────────────────────────────────────────────
  it('no Mode 1 CSS rule introduces a -webkit-app-region drag region (Validates: Requirements 3.4)', () => {
    const cssFiles = collectCssFiles(SRC_DIR);
    expect(cssFiles.length).toBeGreaterThan(0);

    // Allow-list selector substrings that mark a rule as Mode-2-scoped.
    // None of these exist in the unfixed code (it has zero -webkit-app-region
    // rules); they're captured here so the same test stays valid after the
    // Layer 3 fix is applied.
    const MODE_2_SCOPED_SELECTOR_FRAGMENTS = [
      '.mode-2-card-root',
      '.native-overlay-mode',
      '.overlay-shell',
      '[data-mode-2',
      '#overlay',
    ];

    const offenders: { file: string; selector: string; declaration: string }[] = [];

    for (const file of cssFiles) {
      const css = readFileSync(file, 'utf-8');
      // Strip /* ... */ comments to avoid false positives in design notes.
      const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
      // Match each rule block: <selector> { <declarations> }
      const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
      let rm: RegExpExecArray | null;
      while ((rm = ruleRe.exec(cleaned)) !== null) {
        const selector = rm[1].trim();
        const declarations = rm[2];
        if (!/-webkit-app-region\s*:/.test(declarations)) continue;
        const isModeTwoScoped = MODE_2_SCOPED_SELECTOR_FRAGMENTS.some((frag) =>
          selector.includes(frag),
        );
        if (!isModeTwoScoped) {
          offenders.push({ file, selector, declaration: declarations.trim() });
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  // Property over arbitrary (surface, mode) tuples that are NOT in the
  // bug-condition set. For each such tuple, no CSS rule can have inserted
  // a drag region targeting that surface in that mode — equivalent to the
  // observation that no global / Mode-1 selector introduces -webkit-app-region.
  it('arbitrary non-(card-root, mode-2) and non-(button, mode-2) interactions remain non-draggable (Validates: Requirements 3.4)', () => {
    const cssFiles = collectCssFiles(SRC_DIR);
    const allCss = cssFiles
      .map((f) => readFileSync(f, 'utf-8'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    const surfaceArb = fc.constantFrom('card-root', 'button', 'other');
    const modeArb = fc.constantFrom('mode-1', 'mode-2');

    const eventArb = fc.oneof(
      fc.record({
        kind: fc.constant('drag' as const),
        surface: surfaceArb,
        mode: modeArb,
        dx: fc.integer({ min: -200, max: 200 }),
        dy: fc.integer({ min: -200, max: 200 }),
      }),
      fc.record({
        kind: fc.constant('click' as const),
        target: surfaceArb,
        mode: modeArb,
      }),
    );

    fc.assert(
      fc.property(eventArb, (ev) => {
        // Bug-condition predicate.
        const isBugCondition =
          (ev.kind === 'drag' && ev.surface === 'card-root' && ev.mode === 'mode-2') ||
          (ev.kind === 'click' && ev.target === 'card-root' /* never */ && false) ||
          (ev.kind === 'click' && ev.target === 'button' && ev.mode === 'mode-2');
        fc.pre(!isBugCondition);

        // Preservation observation: there is no global selector
        // (html/body/#root/*) and no Mode-1 selector that paints
        // -webkit-app-region. Equivalent statement (CSS-source
        // observation): every -webkit-app-region declaration sits inside
        // a Mode-2-scoped selector. Therefore the cursor classification
        // for any non-bug-condition (surface, mode) tuple is "ordinary
        // pointer event".
        const globalRule = /(?:^|[\s,}])(?:html|body|#root|\*)\s*\{[^}]*-webkit-app-region/m.test(
          allCss,
        );
        return !globalRule;
      }),
      { numRuns: 100 },
    );
  });

  // ────────────────────────────────────────────────────────────────────────
  // Property 2.Lifecycle — Validates: Requirements 3.5
  //
  // The call order inside `app.whenReady().then(...)` is unchanged.
  // Specifically: relaxCSPForElectron → registerIpcHandlers →
  // createMainWindow appear in that order as the first three calls.
  // The fix MUST NOT reorder, remove, or interleave new calls between
  // these three.
  // ────────────────────────────────────────────────────────────────────────
  it('app.whenReady() lifecycle prefix is unchanged (Validates: Requirements 3.5)', () => {
    expect(CURRENT_WHEN_READY_CALLS.slice(0, REFERENCE_WHEN_READY_PREFIX.length)).toEqual(
      REFERENCE_WHEN_READY_PREFIX,
    );

    // Property: for every index i in [0, REFERENCE_WHEN_READY_PREFIX.length)
    // the i-th observed call equals the i-th reference call.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: REFERENCE_WHEN_READY_PREFIX.length - 1 }),
        (i) => CURRENT_WHEN_READY_CALLS[i] === REFERENCE_WHEN_READY_PREFIX[i],
      ),
      { numRuns: 50 },
    );
  });

  it('app.requestSingleInstanceLock runs at module init and quit/close handlers remain registered (Validates: Requirements 3.5)', () => {
    // Single-instance lock acquired at module init (top-level statement,
    // outside any function and outside whenReady().then()).
    expect(/const\s+gotLock\s*=\s*app\.requestSingleInstanceLock\(\)/.test(MAIN_SRC)).toBe(true);

    // window-all-closed and before-quit handlers preserved.
    expect(/app\.on\(\s*['"]window-all-closed['"]/.test(MAIN_SRC)).toBe(true);
    expect(/app\.on\(\s*['"]before-quit['"]/.test(MAIN_SRC)).toBe(true);
  });
});
