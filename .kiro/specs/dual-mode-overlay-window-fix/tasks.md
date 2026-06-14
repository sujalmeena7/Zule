# Implementation Plan

## Overview

This plan implements the dual-mode overlay window fix using the bug-condition methodology defined in `design.md`. The fix spans three layers — preload IPC bridge (`electron/preload.ts`), main-process Mode 2 lifecycle (`electron/main.ts`), and Mode 2 renderer CSS drag-region partitioning — and is gated by two property-based tests written BEFORE the fix:

- **Property 1 (Bug Condition)** — fails on unfixed code (proves the bug exists across all three layers and the idempotence case), passes after the fix.
- **Property 2 (Preservation)** — passes on unfixed code (captures baseline behavior for every ¬C(X) input), still passes after the fix (no regressions in Mode 1 launch, other IPC channels, Mode 1 DOM, or the existing main lifecycle).

Tasks are ordered exploration-first: write the failing bug-condition test, write the passing preservation tests, then apply the three-layer fix and re-run both property tests.

## Tasks

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Mode 1 → Mode 2 Transition and Mode 2 Interactions
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists across all three layers
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists in (a) the preload IPC bridge, (b) the main-process Mode 2 lifecycle, (c) the Mode 2 CSS drag-region partitioning
  - **Scoped PBT Approach**: This is a deterministic bug. Scope the property to the concrete failing cases enumerated in the Bug Condition `isBugCondition(input)` pseudocode:
    - Branch A (IPC): `IpcInvoke { channel: 'switch-to-overlay' }` — fix the channel name; the payload is irrelevant (use `fast-check` `fc.anything()` or `fc.constant(undefined)`)
    - Branch B (drag): `PointerDrag { surface: 'card-root', mode: 'mode-2' }` — fix surface and mode; vary `(dx, dy)` with bounded `fc.integer({ min: -200, max: 200 })`
    - Branch C (click): `PointerClick { target: 'button', mode: 'mode-2' }` — fix target and mode; iterate over every interactive button rendered in the Mode 2 widget
  - Test implementation per the three layers from `Bug Details → Bug Condition` and `Testing Strategy → Exploratory Bug Condition Checking`:
    - **Layer 1 (preload bridge)**: in a renderer-context test, assert `typeof window.electronAPI.switchToOverlay === 'function'` AND assert that calling it forwards only the literal channel name `'switch-to-overlay'` to `ipcRenderer.invoke`. If a generic channel forwarder is present, assert that any channel name other than `'switch-to-overlay'` is rejected without forwarding (allow-list = `{ 'switch-to-overlay' }`).
    - **Layer 2 (main-process atomic transition)**: in a main-process test, snapshot the live `BrowserWindow` (`preState`), drive the `'switch-to-overlay'` IPC handler, snapshot again (`postState`), and assert all of: `postState.singleBrowserWindowCount === 1`, `postState.window.contentSize === { width: 380, height: 120 }`, `postState.window.frame === false`, `postState.window.backgroundAlphaInMargin === 0`, `postState.window.alwaysOnTopLevel === 'screen-saver'`, `postState.window.instanceId === preState.window.instanceId` (same instance — no destroy/recreate).
    - **Layer 3 (Mode 2 drag region)**: render the Mode 2 component tree in jsdom and assert `getComputedStyle(cardRoot).webkitAppRegion === 'drag'` AND, for every interactive descendant (`button`, `a`, `input`, `[role="button"]`), `getComputedStyle(el).webkitAppRegion === 'no-drag'`.
    - **Idempotence**: drive `'switch-to-overlay'` twice and assert `postState` after the second call equals `postState` after the first (size, frame, alpha, AOT level, `instanceId`).
  - The test assertions match the Expected Behavior Properties from `Property 1` in the design — the same test will pass after the fix is applied
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists)
  - Document counterexamples found per layer (e.g., "Layer 1: `window.electronAPI.switchToOverlay is not a function`"; "Layer 2: bounds = 380×120 but `alwaysOnTopLevel ≠ 'screen-saver'`, OR background alpha non-zero, OR OS frame still painting"; "Layer 3: `getComputedStyle(cardRoot).webkitAppRegion === ''` and/or `getComputedStyle(button).webkitAppRegion === 'drag'`")
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - All Non-Bug-Condition Inputs Behave Identically to the Unfixed Code
  - **IMPORTANT**: Follow observation-first methodology — observe behavior on UNFIXED code, then encode the observations as property-based tests
  - **Scope**: every input where `isBugCondition(input) === false`, i.e.:
    - Application launch when no `'switch-to-overlay'` event has been emitted (Mode 1 dashboard at 1000×700, OS frame, opaque background, no AOT)
    - Any `IpcInvoke` whose `channel` is not literally `'switch-to-overlay'` (e.g., `'start-overlay'`, `'stop-overlay'`, `'set-content-protection'`, `'set-always-on-top'`, `'set-ignore-mouse-events'`, `'toggle-overlay'`, `'resize-overlay'`, `'move-overlay'`, `'get-overlay-bounds'`, `'ipc-sync-message'`, `'get-desktop-sources'`)
    - Any `PointerDrag` whose `(surface, mode)` is not `('card-root', 'mode-2')`
    - Any `PointerClick` whose `(target, mode)` is not `('button', 'mode-2')`
    - Keyboard events, focus events, OS-level events, display change events
  - **Observe on UNFIXED code** and capture as the reference observations:
    - Observe: at startup the application opens a single `BrowserWindow` at 1000×700 with the regular OS frame, opaque background, no `setAlwaysOnTop` call, no transparency flag, no frameless chrome
    - Observe: every other `ipcMain.handle` channel (per the list above) is registered with the existing handler signature and the preload bridge exposes a method of the same name with the same signature
    - Observe: walking the Mode 1 dashboard DOM tree, no element has `getComputedStyle(el).webkitAppRegion === 'drag'` and no element has `'no-drag'`
    - Observe: `relaxCSPForElectron` is called inside `app.whenReady().then(...)` before `registerIpcHandlers` and `createMainWindow`; `app.requestSingleInstanceLock()` runs at module init; `app.on('window-all-closed')` and `app.on('before-quit')` are still registered with their existing bodies
    - Observe: clicks on Mode 1 dashboard buttons dispatch normally
  - **Write property-based tests** capturing the observations from `Preservation Requirements` and `Property 2` in the design:
    - **Preservation/IPC branch**: use `fast-check` to generate arbitrary channel-name strings, filter out the literal `'switch-to-overlay'`, and assert that `applyOriginal(input) === applyFixed(input)` (same `ipcMain` registration set, same preload bridge surface, same handler signature, same response shape)
    - **Preservation/pointer branch**: use `fast-check` to generate arbitrary `PointerDrag` and `PointerClick` events whose `(surface, mode)` / `(target, mode)` tuple is NOT in `{ ('card-root', 'mode-2'), ('button', 'mode-2') }`, and assert observational equivalence
    - **Preservation/Mode-1-launch**: assert the fixed code produces the same `BrowserWindow` constructor options at startup as the unfixed code (1000×700, framed, opaque, no AOT)
    - **Preservation/Mode-1-DOM**: render the Mode 1 dashboard component tree and walk every element with a `fast-check` traversal arbitrary; assert no element has `webkit-app-region` set to `'drag'` or `'no-drag'`
    - **Preservation/lifecycle ordering**: assert the call order inside `app.whenReady().then(...)` is unchanged
  - Property-based testing generates many test cases automatically for stronger guarantees that the fix is non-invasive across the heterogeneous ¬C(X) input domain
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. Fix for Mode 1 → Mode 2 single-`BrowserWindow` transition across preload bridge, main-process lifecycle, and renderer drag-region partitioning

  - [x] 3.1 Implement the preload bridge fix in `electron/preload.ts`
    - Add a `switchToOverlay(): Promise<boolean>` method to the `electronAPI` object exposed via `contextBridge.exposeInMainWorld`; internally it MUST call `ipcRenderer.invoke('switch-to-overlay')` and only the literal channel name `'switch-to-overlay'`
    - If a generic channel-forwarding helper is retained, add an internal allow-list `const ALLOWED_CHANNELS = new Set(['switch-to-overlay'])` and reject every other channel name (throw or return rejected `Promise`) WITHOUT invoking `ipcRenderer`
    - Leave every other exposed method untouched: `setContentProtection`, `setAlwaysOnTop`, `setIgnoreMouseEvents`, `startOverlay`, `stopOverlay`, `toggleOverlay`, `resizeOverlay`, `moveOverlay`, `getOverlayBounds`, `sendSyncMessage`, `onSyncMessage`, `onOverlayError`, `onGlobalShortcut`, `getDesktopSources` — same channel names, signatures, behavior
    - _Bug_Condition: isBugCondition(input) for Branch A — `IpcInvoke { channel: 'switch-to-overlay' }`_
    - _Expected_Behavior: expectedBehavior — message is delivered through a `contextBridge.exposeInMainWorld`-exposed handler that forwards only the allow-listed channel name `'switch-to-overlay'`_
    - _Preservation: every IPC channel other than `'switch-to-overlay'` continues to route through the existing preload bridge with no change to its name, payload shape, response shape, or invocation timing_
    - _Requirements: 2.1, 3.2_

  - [x] 3.2 Implement the main-process atomic Mode 2 transition in `electron/main.ts`
    - Register `ipcMain.handle('switch-to-overlay', ...)` alongside the existing handlers in `registerIpcHandlers`; the handler resolves the live single Mode 1 `BrowserWindow` reference and delegates to a private helper
    - The handler MUST NOT create a new `BrowserWindow` and MUST NOT call `close()` or `destroy()` on the existing one (same `instanceId` preserved end-to-end)
    - Apply the Mode 2 transition atomically on the same `BrowserWindow` instance, in this exact order: `win.hide()` → `win.setMenuBarVisibility(false)` (and any other available chrome-removal calls) → `win.setBackgroundColor('#00000000')` → `win.setHasShadow(false)` → `win.setBounds({ width: 380, height: 120 }, false)` → `win.setAlwaysOnTop(true, 'screen-saver')` → `win.showInactive()`
    - The ordering ensures no intermediate paint reveals the old Mode 1 chrome and that AOT is in effect before the next paint completes; `setAlwaysOnTop(true, 'screen-saver')` is bundled into the same handler invocation as the resize/reframe (Requirement 2.3)
    - Reject malformed payloads silently — the channel takes no payload; ignore any payload and perform the transition
    - DO NOT modify `relaxCSPForElectron`, `createMainWindow`, `app.requestSingleInstanceLock`, `app.on('window-all-closed')`, or `app.on('before-quit')`; DO NOT re-order their invocation in `app.whenReady().then(...)`
    - DO NOT touch the `OverlayManager`-based second-window path (`'start-overlay'`); it remains exactly as it is
    - _Bug_Condition: isBugCondition(input) for Branch A — `IpcInvoke { channel: 'switch-to-overlay' }`_
    - _Expected_Behavior: expectedBehavior — `postState.singleBrowserWindowCount = 1`, `postState.window.contentSize = { width: 380, height: 120 }`, `postState.window.frame = false`, `postState.window.backgroundAlphaInMargin = 0`, `postState.window.alwaysOnTopLevel = 'screen-saver'`, `postState.window.instanceId = preState.window.instanceId`_
    - _Preservation: the existing main-process lifecycle steps (window creation, CSP relaxation, single-instance lock, before-quit/window-all-closed) execute in their current order with no behavior change; the Mode 1 launch path and every other IPC channel are unchanged_
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.5_

  - [x] 3.3 Implement the Mode 2 CSS drag-region partitioning in the floating-widget component CSS (e.g., `src/components/copilot/ControlCapsule.css` and the parent overlay CSS that styles the card root)
    - Add `-webkit-app-region: drag;` to the outermost styled element of the Mode 2 card surface; scope the rule with a class or attribute selector that exists ONLY in the Mode 2 DOM tree (e.g., `.mode-2-card-root`, gated on the existing `isNativeOverlay` flag or the Mode 2 hash route)
    - Add `-webkit-app-region: no-drag;` to every interactive descendant of the card root: `.mode-2-card-root button`, `.mode-2-card-root a`, `.mode-2-card-root input`, `.mode-2-card-root [role="button"]`
    - DO NOT add `-webkit-app-region: drag` to any element rendered in the Mode 1 dashboard
    - Verify there are no global rules on `html`, `body`, or `#root` that introduce drag regions
    - DO NOT touch any Mode 2 visual styling unrelated to drag regions (colors, sizes, border radius, blur, transitions are unchanged)
    - _Bug_Condition: isBugCondition(input) for Branches B and C — `PointerDrag { surface: 'card-root', mode: 'mode-2' }` and `PointerClick { target: 'button', mode: 'mode-2' }`_
    - _Expected_Behavior: expectedBehavior — the `BrowserWindow` moves with the cursor when the card root is dragged; the click handler is invoked and the window does not move when an interactive button is clicked_
    - _Preservation: the Mode 1 dashboard DOM tree remains non-draggable at the window level — no element declares `-webkit-app-region: drag`, so Mode 1 pointer events are unaffected_
    - _Requirements: 2.4, 2.5, 3.4_

  - [x] 3.4 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Mode 1 → Mode 2 Transition and Mode 2 Interactions
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior across all three branches (IPC, drag, click) and the idempotence check
    - When this test passes, it confirms `expectedBehavior(input, postState)` holds for every input that satisfies `isBugCondition(input)`:
      - Branch A: single `BrowserWindow`, contentSize 380×120, frame false, background alpha 0, AOT level `'screen-saver'`, same `instanceId`
      - Branch B: window position changes by the drag delta when the Mode 2 card root is dragged
      - Branch C: button click handler is invoked exactly once and the window does not move
      - Idempotence: post-state after the second `'switch-to-overlay'` invocation equals post-state after the first
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 3.5 Verify preservation tests still pass
    - **Property 2: Preservation** - All Non-Bug-Condition Inputs Behave Identically to the Unfixed Code
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2 across every ¬C(X) input class: Mode 1 launch, every other IPC channel, Mode 1 DOM drag-region absence, existing main-lifecycle ordering, Mode 1 mouse clicks, Mode 2 non-card-root drags
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions in `applyOriginal(input) === applyFixed(input)` for any input where `isBugCondition(input) === false`)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 4. Checkpoint - Ensure all tests pass
  - Run the full test suite (unit tests, property-based tests, and Playwright + Electron integration tests from `Testing Strategy → Integration Tests` in the design)
  - Confirm Property 1 (Bug Condition) tests pass for all three branches and the idempotence check
  - Confirm Property 2 (Preservation) tests pass across all ¬C(X) input classes
  - Confirm the integration scenarios pass: Mode 1 launch is unchanged at 1000×700 with OS frame and opaque background; invoking `'switch-to-overlay'` produces a 380×120 frameless transparent always-on-top widget on the same `BrowserWindow` instance; the card drags the window; every Mode 2 button dispatches its click handler without starting a window drag
  - Ensure all tests pass, ask the user if questions arise

## Task Dependency Graph

The graph encodes the bugfix exploration-first ordering:

- **Wave 0** runs the two test-writing tasks in parallel — both must be observed against UNFIXED code (task 1 fails, task 2 passes) before any fix is applied.
- **Wave 1** runs the three independent fix layers in parallel (`preload.ts`, `main.ts`, renderer CSS touch disjoint files and have no compile-time dependencies on each other).
- **Wave 2** re-runs the SAME tests written in wave 0 to verify the fix; both verifications run in parallel.
- **Wave 3** is the final checkpoint that gates only on both verifications passing.

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "2"] },
    { "id": 1, "tasks": ["3.1", "3.2", "3.3"] },
    { "id": 2, "tasks": ["3.4", "3.5"] },
    { "id": 3, "tasks": ["4"] }
  ]
}
```

## Notes

- **Test ordering is critical.** Task 1 (bug condition test) MUST be run on UNFIXED code first and observed to fail; this confirms the bug exists across all three layers. Task 2 (preservation tests) MUST be run on UNFIXED code first and observed to pass; this captures the baseline behavior to preserve. Do not begin task 3 (the fix) until both observations are recorded.
- **No new tests in task 3.4 / 3.5.** The verification sub-tasks re-run the SAME tests written in tasks 1 and 2. If those tests need to change to make the fix pass, the fix is wrong — re-examine the root cause, not the test.
- **Single `BrowserWindow` invariant.** Throughout the Mode 1 → Mode 2 transition the same `BrowserWindow` instance MUST be preserved (`postState.window.instanceId === preState.window.instanceId`). The fix MUST NOT call `BrowserWindow.close()`, `destroy()`, or construct a second window in the `'switch-to-overlay'` path.
- **Atomic lifecycle ordering.** The main-process transition order is fixed and load-bearing: `hide → setMenuBarVisibility(false) → setBackgroundColor('#00000000') → setHasShadow(false) → setBounds(380×120) → setAlwaysOnTop(true, 'screen-saver') → showInactive`. Do not reorder or split these calls across separate event-loop turns; the goal is that no intermediate paint reveals old Mode 1 chrome.
- **Drag-region scoping.** Every new `-webkit-app-region` rule MUST be scoped to a Mode 2-only selector (e.g., `.mode-2-card-root` or a gate on the existing `isNativeOverlay` flag). No global selectors (`html`, `body`, `#root`, `*`) and no rule that targets the Mode 1 dashboard DOM tree.
- **Out of scope.** The `OverlayManager`-based second-window path (`'start-overlay'`, `'stop-overlay'`, `'toggle-overlay'`, `'resize-overlay'`, `'move-overlay'`, `'get-overlay-bounds'`) is orthogonal to this fix and is preserved exactly. Same for `relaxCSPForElectron`, `app.requestSingleInstanceLock`, `app.on('window-all-closed')`, `app.on('before-quit')`, `'set-content-protection'`, `'set-always-on-top'`, `'set-ignore-mouse-events'`, `'ipc-sync-message'`, and `'get-desktop-sources'`.
