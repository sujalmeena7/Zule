# Dual-Mode Overlay Window Fix — Bugfix Design

## Overview

Zule's Electron shell hosts a single `BrowserWindow` that must switch from the Mode 1 dashboard (1000×700, OS-framed, opaque) into a Mode 2 floating widget (380×120, frameless, fully transparent, always-on-top at the `screen-saver` level, draggable by its styled card while its buttons stay clickable). The Mode 1 → Mode 2 transition is requested by the renderer through the IPC channel `'switch-to-overlay'`.

The transition is currently broken end-to-end across three layers:

1. **Preload bridge layer** — `'switch-to-overlay'` is not exposed through `contextBridge.exposeInMainWorld`, and there is no allow-list check before forwarding to `ipcRenderer`, so the channel either does not reach the main process or does so through an unsafe path.
2. **Main-process lifecycle layer** — when the channel is handled, the Mode 2 window options (size, frame, transparency, always-on-top) are applied out of order or after the window is already visible. The OS frame keeps painting around the card and opaque pixels persist in what should be the transparent margin. `setAlwaysOnTop(true, 'screen-saver')` is not part of the same lifecycle transition, so the widget can be obscured immediately after the switch.
3. **Renderer drag-region layer** — no element in the Mode 2 DOM tree carries `-webkit-app-region: drag`, so dragging the card does not move the `BrowserWindow`. Buttons inherit `-webkit-app-region: drag` from their ancestor and have no `-webkit-app-region: no-drag` override, so clicking a button initiates a window drag instead of dispatching the click.

The fix repairs all three layers so that emitting `'switch-to-overlay'` produces a fully-formed Mode 2 widget, while leaving the Mode 1 launch path, every other IPC channel, and the standard dashboard React tree untouched. The bug-condition methodology is used to keep the fix targeted: every input that triggers the Mode 2 transition or interacts with the Mode 2 widget is in scope (C(X)), and every other input is preserved exactly (¬C(X)).

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — an input that exercises the Mode 1 → Mode 2 transition or a Mode 2 drag/click interaction. Formally defined in the Bug Condition section.
- **Property (P)**: The desired behavior when the bug condition holds — the renderer-issued `'switch-to-overlay'` produces a frameless, fully-transparent, always-on-top, 380×120 window through a safe bridge, and the Mode 2 card drags the window while its buttons remain clickable.
- **Preservation**: The behavior that must remain identical to the unfixed code for inputs where the bug condition does NOT hold — Mode 1 dashboard launch, every IPC channel other than `'switch-to-overlay'`, the existing window-creation/CSP/single-instance/quit lifecycle, and the standard dashboard DOM tree.
- **Mode_1**: Standard dashboard window — 1000×700 CSS pixels, regular OS frame, opaque background, no `setAlwaysOnTop`.
- **Mode_2**: Floating widget — 380×120 CSS pixels, frameless, fully transparent (alpha 0 in the margin around the card), `setAlwaysOnTop(true, 'screen-saver')`.
- **`'switch-to-overlay'`**: The IPC channel name (allow-listed string) that the renderer invokes to request the Mode 1 → Mode 2 transition.
- **Preload bridge**: `electron/preload.ts` — the only path through which the renderer can talk to the main process under `contextIsolation: true, nodeIntegration: false`.
- **Drag region**: A DOM region marked with `-webkit-app-region: drag` (or `no-drag`) that Chromium translates into native `BrowserWindow` move gestures (or back into normal pointer events).
- **Card root**: The outermost DOM element of the Mode 2 styled HTML card — the surface the user expects to drag.
- **Interactive button**: Any `<button>` (or button-like control) inside the Mode 2 widget that must dispatch click events instead of starting a window drag.

## Bug Details

### Bug Condition

The bug manifests when any input exercises the Mode 1 → Mode 2 transition path or a Mode 2 interaction (drag of the card surface, or click on a Mode 2 button). The defects span three layers — the preload bridge does not expose `'switch-to-overlay'` safely, the main-process lifecycle applies the new window options in the wrong order so the OS frame and opaque background remain visible, and the Mode 2 DOM does not partition `-webkit-app-region: drag` between the card root and its interactive controls.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input is one of:
    - IpcInvoke { channel: string, payload: unknown }     // renderer → main IPC call
    - PointerDrag { surface: 'card-root' | 'button' | 'other', mode: 'mode-1' | 'mode-2' }
    - PointerClick { target: 'card-root' | 'button' | 'other', mode: 'mode-1' | 'mode-2' }
  OUTPUT: boolean

  // Trigger 1: renderer requests the Mode 1 → Mode 2 transition
  IF input IS IpcInvoke AND input.channel = 'switch-to-overlay' THEN
    RETURN true
  END IF

  // Trigger 2: user drags the styled card surface while in Mode 2
  IF input IS PointerDrag AND input.mode = 'mode-2' AND input.surface = 'card-root' THEN
    RETURN true
  END IF

  // Trigger 3: user clicks an interactive button while in Mode 2
  IF input IS PointerClick AND input.mode = 'mode-2' AND input.target = 'button' THEN
    RETURN true
  END IF

  RETURN false
END FUNCTION
```

The **expected behavior** when `isBugCondition(input)` holds is:

```
FUNCTION expectedBehavior(input, postState)
  INPUT:  input — the same input as above
          postState — observable state after the fixed code processes input
  OUTPUT: boolean

  IF input IS IpcInvoke AND input.channel = 'switch-to-overlay' THEN
    RETURN postState.singleBrowserWindowCount = 1
       AND postState.window.contentSize = { width: 380, height: 120 }
       AND postState.window.frame = false
       AND postState.window.backgroundAlphaInMargin = 0
       AND postState.window.alwaysOnTopLevel = 'screen-saver'
       AND postState.window.instanceId = preState.window.instanceId   // same instance
  END IF

  IF input IS PointerDrag AND input.surface = 'card-root' AND input.mode = 'mode-2' THEN
    RETURN postState.window.position ≠ preState.window.position       // window moved
  END IF

  IF input IS PointerClick AND input.target = 'button' AND input.mode = 'mode-2' THEN
    RETURN postState.button.clickHandlerInvoked = true
       AND postState.window.position = preState.window.position       // no drag started
  END IF
END FUNCTION
```

### Examples

- **Renderer invokes `'switch-to-overlay'` (unfixed)**: the channel is not exposed through `contextBridge.exposeInMainWorld`, so `window.electronAPI.switchToOverlay()` is undefined and the message never reaches main; even when wired, the main handler resizes the window but leaves the OS frame painted and the background opaque. **Expected**: a single atomic transition produces a 380×120 frameless transparent always-on-top widget on the same `BrowserWindow` instance.
- **Renderer invokes `'switch-to-overlay'`, then immediately another window grabs focus**: the widget is obscured because `setAlwaysOnTop(true, 'screen-saver')` was not part of the same lifecycle. **Expected**: the widget stays on top because `setAlwaysOnTop(true, 'screen-saver')` is part of the same transition that resizes and reframes the window.
- **User drags the styled card by its surface in Mode 2 (unfixed)**: nothing happens — Chromium does not initiate a native window drag because no DOM element carries `-webkit-app-region: drag`. **Expected**: the window moves with the cursor.
- **User clicks the "Stop" button inside the Mode 2 widget (unfixed)**: instead of dispatching the click, the window begins to drag because the button inherits `-webkit-app-region: drag` from its ancestor and has no `no-drag` override. **Expected**: the click is dispatched to the button handler and the window does not move.
- **Edge case — renderer invokes `'switch-to-overlay'` twice in a row**: the second invocation must be a no-op for the window topology (still one window, still 380×120, still frameless transparent AOT) and must not destroy/recreate the window. **Expected**: idempotent transition, single `BrowserWindow` instance preserved.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- The Mode 1 dashboard launch path: the application opens a single `BrowserWindow` at 1000×700 with the regular OS frame and an opaque background, with no `setAlwaysOnTop` call, no transparency flag, and no frameless chrome applied.
- Every IPC channel other than `'switch-to-overlay'` continues to route through the existing preload bridge with no change to its name, payload shape, response shape, or invocation timing.
- The Mode 1 dashboard DOM tree is non-draggable at the window level — no element declares `-webkit-app-region: drag`, so mouse interactions on the dashboard behave as ordinary pointer events.
- The existing main-process lifecycle steps — window creation, CSP relaxation in `relaxCSPForElectron`, the single-instance lock acquired via `app.requestSingleInstanceLock`, and the `before-quit` / `window-all-closed` handlers — execute in their current order with no behavior change.
- The renderer's standard React tree, including the FloatingCopilot host workspace and dashboard components, renders with the exact same component output for any input that does not exercise the Mode 1 → Mode 2 transition.

**Scope:**
All inputs that do NOT satisfy the bug condition above must produce exactly the same observable behavior as the unfixed code. This includes:
- The Mode 1 application launch (no `'switch-to-overlay'` event has been emitted).
- Any IPC invoke whose channel name is not literally `'switch-to-overlay'` (e.g., `'start-overlay'`, `'set-content-protection'`, `'get-desktop-sources'`, `'ipc-sync-message'`).
- Pointer drags whose surface is not the Mode 2 card root, and pointer drags that occur in Mode 1.
- Pointer clicks on Mode 1 dashboard targets, and Mode 2 clicks whose target is not an interactive button.
- Keyboard events, focus events, OS-level events, display change events, and any other input class not enumerated in the bug condition.

The actual expected correct behavior for inputs where the bug condition holds is defined in Property 1 of the Correctness Properties section.

## Hypothesized Root Cause

Based on the layered description in the bugfix requirements, the most likely root causes are:

1. **Missing `contextBridge` exposure for `'switch-to-overlay'`**: `electron/preload.ts` registers `electronAPI` via `contextBridge.exposeInMainWorld`, but the surface does not include a `switchToOverlay` method, and there is no allow-list check that constrains forwarded channel names to `'switch-to-overlay'` before invoking `ipcRenderer.invoke`. Either the renderer cannot reach the main process at all (the method is undefined on `window.electronAPI`), or any caller can forward arbitrary channel names through a generic bridge.

2. **Out-of-order or post-show window option mutation in main**: the handler for `'switch-to-overlay'` resizes the `BrowserWindow` via `setBounds(380, 120)` but applies the chrome changes (frame removal, transparent background) after the window has already painted, so the OS-rendered frame and opaque background remain. In stock Electron, several of these properties are immutable after construction or require a hide → mutate → show sequence. The fix must apply all Mode 2 properties in a single atomic lifecycle step before the next paint.

3. **`setAlwaysOnTop(true, 'screen-saver')` not bundled into the transition**: the AOT call is delayed (or omitted) so the freshly transitioned widget can be covered by other top-level windows during the brief race window between resize and `setAlwaysOnTop`. The fix must call `setAlwaysOnTop(true, 'screen-saver')` as part of the same handler invocation that performs the size and chrome changes.

4. **Window destruction/recreation forbidden but conceptually needed**: a tempting fix is to destroy the dashboard `BrowserWindow` and create a new one with `frame: false, transparent: true`. The requirement explicitly forbids this (the same `BrowserWindow` instance must be preserved). The fix must therefore use the runtime mutation APIs available — `setBounds`, `setMenuBarVisibility`, `setBackgroundColor('#00000000')`, `setHasShadow(false)`, `setAlwaysOnTop(true, 'screen-saver')` — and rely on a `hide() → mutate → showInactive()` ordering when needed so that no intermediate paint reveals the old chrome.

5. **No drag region on the Mode 2 card root**: the styled card root in the Mode 2 DOM does not declare `-webkit-app-region: drag`. Chromium therefore does not translate pointer drags on the card surface into native `BrowserWindow` move gestures, and the widget cannot be repositioned on the desktop.

6. **Buttons inherit drag from ancestor without no-drag override**: even after the card root is marked draggable, every interactive `<button>` (and other clickable control) inside the Mode 2 widget inherits `-webkit-app-region: drag` from the card root. Without an explicit `-webkit-app-region: no-drag` rule on those controls, Chromium converts the click into the start of a window drag and the button's click handler is never invoked.

## Correctness Properties

Property 1: Bug Condition — Mode 1 → Mode 2 Transition and Mode 2 Interactions Behave Correctly

_For any_ input where the bug condition holds (`isBugCondition(input)` returns true), the fixed code SHALL produce the expected Mode 2 behavior:

- For an IPC invoke on channel `'switch-to-overlay'`: the message is delivered through a `contextBridge.exposeInMainWorld`-exposed handler that forwards only the allow-listed channel name `'switch-to-overlay'` and rejects any other channel name without forwarding; the main process then transitions the single existing `BrowserWindow` instance into Mode 2 by resizing it to 380×120, removing the OS frame, painting a fully-transparent margin (alpha 0), and calling `setAlwaysOnTop(true, 'screen-saver')` as a single lifecycle step that completes before the next paint of the new mode, without creating a second window or destroying and re-creating the existing window.
- For a pointer drag whose surface is the Mode 2 card root: the `BrowserWindow` moves with the cursor because the card root carries `-webkit-app-region: drag`.
- For a pointer click whose target is an interactive button inside the Mode 2 widget: the click is dispatched to the button's handler (no native window drag is started) because the button carries `-webkit-app-region: no-drag`.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**

Property 2: Preservation — All Non-Bug-Condition Inputs Behave Identically to the Unfixed Code

_For any_ input where the bug condition does NOT hold (`isBugCondition(input)` returns false), the fixed code SHALL produce exactly the same observable result as the original code, preserving:

- The Mode 1 dashboard launch path — same single `BrowserWindow` opened at 1000×700 with the regular OS frame and opaque background, no `setAlwaysOnTop`, no transparency, no frameless chrome.
- Every IPC channel whose name is not literally `'switch-to-overlay'` — same channel name, same payload shape, same response shape, same routing through the existing preload bridge.
- The Mode 1 dashboard DOM tree as non-draggable — no element declares `-webkit-app-region: drag`, so Mode 1 pointer events are unaffected by the new drag-region rules.
- The existing main-process lifecycle — window creation, CSP relaxation, single-instance lock acquisition, and `before-quit` / `window-all-closed` handling — executed in the current order with no behavior change.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

## Fix Implementation

### Changes Required

Assuming the root cause analysis is correct, the fix touches three files across the three defective layers. The bug condition above maps cleanly onto these three layers, and each change is scoped so that ¬C(X) inputs — Mode 1 launch, other IPC channels, Mode 1 DOM, existing lifecycle — observe no behavior change.

**File**: `electron/preload.ts`

**Function**: the `electronAPI` object exposed via `contextBridge.exposeInMainWorld`

**Specific Changes**:
1. **Add a `switchToOverlay` method to `electronAPI`**: a typed wrapper that internally calls `ipcRenderer.invoke('switch-to-overlay')` and only the literal channel name `'switch-to-overlay'`. The method takes no payload (the transition needs no parameters) and returns `Promise<boolean>`.
2. **Allow-list the channel name**: if the project chooses to keep a generic channel-forwarding helper, an internal allow-list (a `const ALLOWED_CHANNELS = new Set(['switch-to-overlay'])`) MUST be checked, and any other channel name MUST be rejected (e.g., by throwing or returning a rejected `Promise`) without invoking `ipcRenderer`. The simpler shape — a dedicated `switchToOverlay()` method — implicitly satisfies the allow-list because no other channel name is reachable from the renderer through this method.
3. **Leave every other exposed method untouched**: `setContentProtection`, `setAlwaysOnTop`, `setIgnoreMouseEvents`, `startOverlay`, `stopOverlay`, `toggleOverlay`, `resizeOverlay`, `moveOverlay`, `getOverlayBounds`, `sendSyncMessage`, `onSyncMessage`, `onOverlayError`, `onGlobalShortcut`, `getDesktopSources` — same channel names, same signatures, same behavior. (Preservation 3.2.)

**File**: `electron/main.ts`

**Function**: a new `'switch-to-overlay'` IPC handler registered alongside the existing handlers in `registerIpcHandlers`, plus a small private helper that performs the atomic transition on a `BrowserWindow` reference

**Specific Changes**:
1. **Register `ipcMain.handle('switch-to-overlay', ...)`**: the handler resolves the live single `BrowserWindow` reference (the Mode 1 dashboard window) and delegates to the helper. It does NOT create a new window and does NOT call `BrowserWindow.close()` or `destroy()` on the existing one (Property 1, Requirement 2.3).
2. **Apply the Mode 2 transition atomically**: the helper performs, in order, on the same `BrowserWindow` instance:
   - `win.hide()` — take the window off-screen so the next paint is not the old chrome.
   - `win.setMenuBarVisibility(false)` and any other chrome-removal calls available at runtime.
   - `win.setBackgroundColor('#00000000')` — alpha-zero background so the margin around the card is fully transparent.
   - `win.setHasShadow(false)` — no platform shadow around the floating widget.
   - `win.setBounds({ width: 380, height: 120 }, false)` — resize without animation so the new content size is exact.
   - `win.setAlwaysOnTop(true, 'screen-saver')` — bundled into the same handler invocation (Requirement 2.3).
   - `win.showInactive()` — bring the window back without stealing focus.
   The ordering ensures that no intermediate paint reveals the old Mode 1 chrome and that AOT is in effect before the next paint completes.
3. **Preserve the existing main-process lifecycle**: do not modify `relaxCSPForElectron`, `createMainWindow`, `app.requestSingleInstanceLock`, `app.on('window-all-closed')`, or `app.on('before-quit')`. Do not re-order their invocation in `app.whenReady().then(...)`. (Preservation 3.5.)
4. **Do not introduce a second `BrowserWindow`**: the `OverlayManager`-based second-window path (`'start-overlay'`) is orthogonal to this fix and remains exactly as it is. The `'switch-to-overlay'` handler operates on the existing main window only. (Preservation 3.2, 3.5.)
5. **Reject malformed payloads silently**: if the renderer somehow forwards `'switch-to-overlay'` with an unexpected payload, the handler ignores the payload and performs the transition. No payload is required by the channel contract.

**File**: the Mode 2 floating-widget component CSS (the styled HTML card and its interactive controls — e.g., `src/components/copilot/ControlCapsule.css` and the parent overlay CSS that styles the card root)

**Function**: the CSS rule set that applies to the Mode 2 card root and its interactive descendants

**Specific Changes**:
1. **Mark the card root as draggable**: add `-webkit-app-region: drag;` to the outermost styled element of the Mode 2 card surface. Scope this rule with a class or attribute selector that exists ONLY in the Mode 2 DOM tree (e.g., a `.mode-2-card-root` class added when the renderer is in the Mode 2 hash route, or a guard via the existing `isNativeOverlay` flag). Do NOT add `-webkit-app-region: drag` to any element that is rendered in the Mode 1 dashboard. (Preservation 3.4.)
2. **Mark every interactive control inside the card as no-drag**: add `-webkit-app-region: no-drag;` to every `<button>`, `<a>`, `<input>`, and any `[role="button"]` element that is a descendant of the card root in Mode 2. The selector chain (`.mode-2-card-root button, .mode-2-card-root a, .mode-2-card-root input, .mode-2-card-root [role="button"]`) overrides the inherited `drag` value so clicks on those controls dispatch normally.
3. **Leave the Mode 1 dashboard DOM tree's drag region rules untouched**: no element in the Mode 1 component tree declares `-webkit-app-region: drag` or `no-drag`. Verify there are no global rules (e.g., on `html`, `body`, or `#root`) that introduce drag regions. (Preservation 3.4.)
4. **Do not touch Mode 2 visual styling unrelated to drag regions**: colors, sizes, border radius, blur, transitions — all unchanged. The only additions are the two `-webkit-app-region` declarations.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on the unfixed code (one counterexample per defective layer), then verify that the fix produces the expected Mode 2 behavior for all inputs satisfying the bug condition AND preserves the original behavior for all inputs that do not.

Because the bug condition spans IPC, native window options, and CSS drag regions, the test suite combines:
- Unit tests in the main process to drive `'switch-to-overlay'` end-to-end and assert post-state on a real (or in-test) `BrowserWindow`.
- Property-based tests over the IPC channel-name and the input-classification surface to cover preservation across the full input domain.
- Integration tests in Playwright/Electron that drive the renderer, emit `'switch-to-overlay'`, and assert that the Mode 2 widget appears, drags, and dispatches button clicks correctly.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If a counterexample does not appear where expected, re-hypothesize the root cause for that layer.

**Test Plan**: Write small focused tests against the UNFIXED code that exercise each of the three defective layers and observe the failure mode. The tests deliberately use the same channel name, drag surface, and click target as the production code so that the unfixed defect is reproduced exactly.

**Test Cases**:
1. **IPC bridge missing test (Layer 1)**: in the renderer (or a renderer-context test environment), assert that `window.electronAPI.switchToOverlay` is a function. On the unfixed code this assertion fails because the method is not exposed (or, if a generic channel forwarder exists, that it forwards arbitrary channel names — the allow-list assertion fails). **(will fail on unfixed code)**
2. **Atomic main-process transition test (Layer 2)**: in a main-process test, create the dashboard `BrowserWindow`, drive the `'switch-to-overlay'` IPC handler, and snapshot the window options after the next paint. Assert `getBounds()` has size 380×120, `isAlwaysOnTop()` is true at the `screen-saver` level, and `getBackgroundColor()` reports an alpha-0 value, AND assert the `BrowserWindow` instance id is unchanged. On the unfixed code at least one of these fails (typically AOT level or background alpha). **(will fail on unfixed code)**
3. **Card root drag region test (Layer 3)**: in the renderer, render the Mode 2 component tree and assert `getComputedStyle(cardRoot).webkitAppRegion === 'drag'`. On the unfixed code this returns `'no-drag'` (or empty), and the assertion fails. **(will fail on unfixed code)**
4. **Button no-drag override test (Layer 3)**: in the renderer, render the Mode 2 component tree and assert `getComputedStyle(button).webkitAppRegion === 'no-drag'` for every interactive button. On the unfixed code this returns `'drag'` (inherited from the card root once Layer 3 is partially fixed) or empty, and the assertion fails. **(will fail on unfixed code)**
5. **Edge case — idempotent transition**: drive `'switch-to-overlay'` twice and assert the post-state after the second call equals the post-state after the first (size, frame, alpha, AOT, instance id). On the unfixed code this may fail because the second invocation re-applies options out of order or destroys/recreates the window. **(may fail on unfixed code)**

**Expected Counterexamples**:
- Layer 1: `window.electronAPI.switchToOverlay is not a function`. Possible causes: missing `contextBridge.exposeInMainWorld` entry, generic channel forwarder without an allow-list.
- Layer 2: `bounds = { width: 380, height: 120 }` but `alwaysOnTopLevel ≠ 'screen-saver'`, OR background alpha non-zero, OR OS frame still painting because the window was not hidden before mutation. Possible causes: out-of-order option application, missing AOT call inside the same handler, missing `hide() → mutate → showInactive()` sequencing.
- Layer 3: `getComputedStyle(cardRoot).webkitAppRegion === ''` or `'no-drag'`, and/or `getComputedStyle(button).webkitAppRegion === 'drag'`. Possible causes: card root missing `-webkit-app-region: drag`, buttons missing `-webkit-app-region: no-drag` override.

### Fix Checking

**Goal**: Verify that for every input where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  preState  := snapshot(systemUnderTest)
  postState := applyFixed(input, preState)
  ASSERT expectedBehavior(input, postState)
END FOR
```

Concretely this means three sub-properties, one per branch of `isBugCondition`:

```
// Branch 1: IPC channel
FOR ALL input = IpcInvoke('switch-to-overlay', _) DO
  postState := applyFixed(input, preState)
  ASSERT postState.singleBrowserWindowCount = 1
     AND postState.window.contentSize = { width: 380, height: 120 }
     AND postState.window.frame = false
     AND postState.window.backgroundAlphaInMargin = 0
     AND postState.window.alwaysOnTopLevel = 'screen-saver'
     AND postState.window.instanceId = preState.window.instanceId
END FOR

// Branch 2: card-root drag in Mode 2
FOR ALL input = PointerDrag(surface='card-root', mode='mode-2', delta=(dx,dy)) DO
  postState := applyFixed(input, preState)
  ASSERT postState.window.position = preState.window.position + (dx, dy)
END FOR

// Branch 3: button click in Mode 2
FOR ALL input = PointerClick(target='button', mode='mode-2') DO
  postState := applyFixed(input, preState)
  ASSERT postState.button.clickHandlerInvoked = true
     AND postState.window.position = preState.window.position
END FOR
```

### Preservation Checking

**Goal**: Verify that for every input where the bug condition does NOT hold, the fixed function produces exactly the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT applyOriginal(input) = applyFixed(input)
END FOR
```

**Testing Approach**: Property-based testing is the right tool for preservation here because the ¬C(X) input domain is large and heterogeneous — every channel name that is not `'switch-to-overlay'`, every pointer interaction in Mode 1, every keyboard event, every display change. Hand-writing unit tests for each subset is brittle. A generator that samples uniformly from this domain and compares the unfixed and fixed code paths gives strong guarantees that the fix is non-invasive.

**Test Plan**: First observe behavior on the UNFIXED code for representative ¬C(X) inputs (Mode 1 launch, `'start-overlay'` invocation, dashboard mouse click, `'set-content-protection'` invocation). Capture those observations as the reference. Then run a `fast-check` property that generates ¬C(X) inputs and asserts the fixed code produces the same observation.

**Test Cases**:
1. **Mode 1 launch preservation**: observe that on the unfixed code the application opens a single `BrowserWindow` at 1000×700 with the regular OS frame and opaque background, no `setAlwaysOnTop`. Assert the fixed code produces the same `BrowserWindow` options at startup.
2. **Other-IPC-channel preservation**: for every channel name in `['start-overlay', 'stop-overlay', 'set-content-protection', 'set-always-on-top', 'set-ignore-mouse-events', 'toggle-overlay', 'resize-overlay', 'move-overlay', 'get-overlay-bounds', 'ipc-sync-message', 'get-desktop-sources']` (and a `fast-check` arbitrary that excludes the literal `'switch-to-overlay'`), assert that the channel is registered in `ipcMain` with the same handler shape and that the preload bridge exposes a method of the same name and signature with no behavioral change.
3. **Mode 1 DOM drag-region preservation**: render the Mode 1 dashboard component tree and walk every element. Assert that no element has `getComputedStyle(el).webkitAppRegion === 'drag'`. The new CSS rules MUST be scoped to a Mode 2-only selector.
4. **Existing main-lifecycle preservation**: assert that `relaxCSPForElectron` is called inside `app.whenReady().then(...)` before `registerIpcHandlers` and `createMainWindow`, that `app.requestSingleInstanceLock()` runs at module init, and that `app.on('window-all-closed')` and `app.on('before-quit')` are still registered with their existing bodies.
5. **Mode 1 mouse-click preservation**: observe that mouse clicks on the dashboard buttons in Mode 1 dispatch normally on unfixed code; assert the same on fixed code.
6. **Mode 2 non-card-root drag preservation**: drag pointer interactions in Mode 2 whose surface is NOT the card root (e.g., on an SVG icon outside the card if any exists) behave the same on fixed and unfixed code.

### Unit Tests

- `electron/preload.ts` — `switchToOverlay` is exposed on `electronAPI` and forwards to `ipcRenderer.invoke('switch-to-overlay')`.
- `electron/preload.ts` — if a generic channel forwarder exists, it rejects every channel name that is not in the allow-list (allow-list = `{ 'switch-to-overlay' }`).
- `electron/main.ts` — `ipcMain.handle('switch-to-overlay', ...)` is registered and, when invoked, performs the `hide → mutate → showInactive` transition with the exact ordering and parameters above on the same `BrowserWindow` instance.
- `electron/main.ts` — every other `ipcMain.handle` call from the unfixed code is still registered with the same channel name and handler signature (preservation 3.2).
- Mode 2 CSS — the card-root selector resolves to `webkit-app-region: drag` in jsdom and the button selectors resolve to `webkit-app-region: no-drag`; Mode 1 selectors resolve to neither.

### Property-Based Tests

- **Property 1 (Bug Condition, IPC branch)**: generate arbitrary `IpcInvoke` inputs, filter to those with `channel = 'switch-to-overlay'`, and assert the post-state matches `expectedBehavior`. Use `fast-check` `record` arbitraries for the optional payload.
- **Property 1 (Bug Condition, drag branch)**: generate arbitrary `PointerDrag` inputs in Mode 2 with `surface = 'card-root'` and arbitrary `(dx, dy)` deltas; assert that `postState.window.position = preState.window.position + (dx, dy)` (clamped to the work area).
- **Property 1 (Bug Condition, click branch)**: generate arbitrary `PointerClick` inputs in Mode 2 with `target = 'button'`; assert that the click handler is invoked exactly once and the window does not move.
- **Property 2 (Preservation, IPC branch)**: generate arbitrary channel-name strings via `fast-check`, filter out the literal `'switch-to-overlay'`, and assert that `applyOriginal` and `applyFixed` produce the same `ipcMain` registration set and the same preload bridge surface for that channel name.
- **Property 2 (Preservation, pointer branch)**: generate arbitrary pointer events whose `(surface, mode)` tuple is not in `{ ('card-root', 'mode-2'), ('button', 'mode-2') }` and assert observational equivalence between original and fixed code.
- **Idempotence property**: generate any number `n ≥ 1` of consecutive `'switch-to-overlay'` invocations and assert that the post-state after the n-th call equals the post-state after the first call.

### Integration Tests

- Playwright + Electron: launch the unfixed app, take a screenshot of Mode 1 (1000×700, OS frame), invoke `'switch-to-overlay'` from the renderer, take a screenshot, assert the screenshot fails the Mode 2 visual contract (frame still visible, opaque margin, or AOT not in effect).
- Playwright + Electron: launch the fixed app, invoke `'switch-to-overlay'` from the renderer, assert the new bounds are 380×120, the OS frame is gone, the margin is fully transparent (alpha 0), and the window is on top of a competing top-level window.
- Playwright + Electron: in Mode 2, perform a pointer drag from the card root and assert the `BrowserWindow` position changes by the drag delta.
- Playwright + Electron: in Mode 2, click each interactive button and assert the click handler runs (e.g., observable side effect on the renderer state) and the window position does not change.
- Playwright + Electron: launch the app, do not invoke `'switch-to-overlay'`, assert the Mode 1 dashboard is at 1000×700 with the regular OS frame and an opaque background — Mode 1 launch path must remain identical to the unfixed app (Preservation 3.1).
