# Bugfix Requirements Document

## Introduction

Zule's Electron shell hosts a single `BrowserWindow` that must switch between two visual modes:

- **Mode 1 — Standard Dashboard**: 1000×700 CSS pixels, regular OS frame and chrome, opaque background.
- **Mode 2 — Floating Widget**: 380×120 CSS pixels, frameless, fully transparent, always-on-top at the `screen-saver` level, with a styled HTML card that is draggable across the desktop while its buttons remain clickable.

The transition from Mode 1 to Mode 2 is triggered by the renderer emitting the IPC channel `'switch-to-overlay'`. Today the transition is unreliable: the channel is not safely exposed through the preload bridge, the main-process lifecycle applies the new window options out of order so the OS frame and opaque background remain visible, and the styled card neither drags as a window nor lets its buttons receive clicks because `-webkit-app-region` is not partitioned correctly between the card surface and its interactive controls.

This bugfix repairs the single-`BrowserWindow` dual-mode transition end-to-end so that emitting `'switch-to-overlay'` produces a fully-transparent, frameless, always-on-top, draggable widget whose buttons remain responsive, while leaving the Mode 1 dashboard launch path untouched.

## Bug Analysis

### Current Behavior (Defect)

The current implementation fails to deliver a clean Mode 2 transition. The defects span three layers: the renderer-to-main IPC bridge, the main-process window lifecycle, and the CSS drag-region partitioning inside the floating card.

1.1 WHEN the renderer invokes the `'switch-to-overlay'` IPC channel THEN the system does not deliver the message safely because the preload bridge does not expose `'switch-to-overlay'` through `contextBridge.exposeInMainWorld` and does not validate the channel name before forwarding via `ipcRenderer`.

1.2 WHEN the main process receives `'switch-to-overlay'` THEN the system applies the Mode 2 window options out of order or after the window is already visible, so the OS frame remains drawn around the card and the window background paints opaque pixels in the transparent margin.

1.3 WHEN the main process receives `'switch-to-overlay'` THEN the system does not call `setAlwaysOnTop(true, 'screen-saver')` as part of the same lifecycle transition that resizes the window to 380×120, so the widget can be obscured by other top-level windows immediately after the switch.

1.4 WHEN the user attempts to drag the floating widget by its styled card THEN the system does not move the `BrowserWindow` because no element in the Mode 2 DOM tree carries `-webkit-app-region: drag`.

1.5 WHEN the user clicks a button inside the floating widget THEN the system initiates a native window drag instead of dispatching the click because the buttons inherit `-webkit-app-region: drag` from an ancestor and have no `-webkit-app-region: no-drag` override.

### Expected Behavior (Correct)

After the fix, the renderer-emitted `'switch-to-overlay'` event must produce a fully-formed Mode 2 widget through a safe IPC bridge, an atomic main-process lifecycle transition, and correctly partitioned CSS drag regions.

2.1 WHEN the renderer invokes the `'switch-to-overlay'` IPC channel THEN the system SHALL deliver the message through a `contextBridge.exposeInMainWorld`-exposed handler that forwards only the allow-listed channel name `'switch-to-overlay'` to `ipcRenderer.invoke` and rejects any other channel name without forwarding.

2.2 WHEN the main process receives `'switch-to-overlay'` THEN the system SHALL transition the single `BrowserWindow` into Mode 2 by resizing to 380×120, removing the OS frame, painting a fully-transparent background (alpha 0 in the margin around the card), and calling `setAlwaysOnTop(true, 'screen-saver')` as part of a single lifecycle transition that completes before the next paint of the new mode.

2.3 WHEN the main process receives `'switch-to-overlay'` THEN the system SHALL keep the same `BrowserWindow` instance throughout the transition and SHALL NOT create a second window or destroy and re-create the existing window.

2.4 WHEN the user drags the styled HTML card surface inside the Mode 2 widget THEN the system SHALL move the `BrowserWindow` across the desktop because the card root carries `-webkit-app-region: drag`.

2.5 WHEN the user clicks an interactive button inside the Mode 2 widget THEN the system SHALL dispatch the click to that button without initiating a window drag because every interactive button carries `-webkit-app-region: no-drag`.

### Unchanged Behavior (Regression Prevention)

The Mode 1 launch path, every IPC channel other than `'switch-to-overlay'`, and the renderer's standard React tree must continue to behave exactly as they do today.

3.1 WHEN the application launches and no `'switch-to-overlay'` event has been emitted THEN the system SHALL CONTINUE TO open the single `BrowserWindow` at 1000×700 with the regular OS frame and an opaque background as the Mode 1 dashboard.

3.2 WHEN the renderer invokes any IPC channel other than `'switch-to-overlay'` THEN the system SHALL CONTINUE TO route that channel through the existing preload bridge without changes to its name, payload shape, or response shape.

3.3 WHILE the application is in Mode 1 THEN the system SHALL CONTINUE TO render the dashboard UI with no `setAlwaysOnTop` call, no transparency flag, and no frameless chrome applied to the `BrowserWindow`.

3.4 WHEN the renderer renders Mode 1 dashboard markup THEN the system SHALL CONTINUE TO treat the dashboard DOM tree as non-draggable at the window level because the dashboard does not declare `-webkit-app-region: drag` on any element.

3.5 WHEN the main process handles its existing window-creation, CSP relaxation, single-instance lock, and quit lifecycle THEN the system SHALL CONTINUE TO execute those steps in their current order with no behavior change.
