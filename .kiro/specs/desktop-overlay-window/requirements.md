# Requirements Document

## Introduction

Zule is now distributed as an Electron desktop application alongside the browser SPA. The Electron scaffolding already exists — `electron/main.ts` creates an `overlayWindow` with `setAlwaysOnTop(true, 'screen-saver')`, frame/transparent/skipTaskbar configured, and `setContentProtection(true)`; `electron/preload.ts` exposes `setAlwaysOnTop`, `setIgnoreMouseEvents`, `startOverlay`, `onSyncMessage`, `onGlobalShortcut`, plus content-protection toggles via `contextBridge`; `src/hooks/useElectronBridge.ts` provides typed renderer access with a browser fallback; and `src/types/electron.d.ts` declares the API surface.

This spec defines the **native desktop overlay window layer** that must sit on top of that scaffolding to deliver Cluely-style overlay behavior: a small floating capsule that hovers above every other desktop window (browsers, video players, IDEs, fullscreen apps, games), is invisible to screen capture, has click-through for non-interactive zones, snaps to edges, persists position per monitor, never steals focus, and renders the existing `FloatingCopilot` React component inside it. When the renderer is loaded in a plain browser (web mode), the same React tree must continue to function as an in-page DOM overlay through the existing fallback path.

This spec is scoped to the **native overlay window** and its renderer integration. The browser-side overlay lifecycle, stealth, accessibility, and copilot-engine behaviors covered by `.kiro/specs/cluely-parity-uplift/` are referenced by name (e.g., `Copilot_Engine`, `Stealth_Layer`, `Cross_Window_Sync`) for terminology consistency, but their requirements are not duplicated here.

Requirements are grouped into the following concerns:

1. Always-On-Top Behavior
2. Window Chrome (Frameless, Transparent, Rounded)
3. Click-Through and Interactive-Zone Routing
4. Drag, Snap, Multi-Monitor, and Position Persistence
5. Virtual Desktops and Workspaces Visibility
6. Screen-Capture Invisibility
7. Global Shortcuts
8. Focus Management
9. Resize, Compact Mode, and Expanded Mode
10. Renderer Integration (FloatingCopilot Inside the Native Overlay)
11. Web-Mode Fallback
12. Cross-Platform Parity and Documented Divergences
13. Accessibility
14. Performance and Resource Bounds

## Glossary

- **Zule_Desktop**: the Electron-packaged build of Zule.
- **Zule_Web**: the same React SPA loaded in a plain browser.
- **Main_Window**: the Electron `BrowserWindow` created by `createMainWindow()` in `electron/main.ts` that hosts the dashboard UI.
- **Overlay_Window**: the Electron `BrowserWindow` created by `createOverlayWindow()` in `electron/main.ts` that hosts the floating copilot.
- **Overlay_Manager**: the main-process module responsible for creating, configuring, and re-applying behaviors on the Overlay_Window (always-on-top level, content protection, visible-on-all-workspaces, click-through, snap, persistence, etc.). It encapsulates the lifecycle currently inlined in `electron/main.ts`.
- **Renderer_Bridge**: the `contextBridge`-exposed `window.electronAPI` surface defined in `electron/preload.ts` and typed in `src/types/electron.d.ts`.
- **FloatingCopilot**: the existing React component at `src/components/FloatingCopilot.tsx` that renders the copilot UI.
- **Overlay_Route**: the URL hash (`#overlay`) the Overlay_Window loads, used to mount FloatingCopilot in isolation rather than the full dashboard.
- **Interactive_Zone**: a region of the Overlay_Window that must receive mouse events (chat input, buttons, transcript scroll area).
- **Pass_Through_Zone**: a region of the Overlay_Window that must let mouse events fall through to the application underneath (transparent margins, decorative blur).
- **Display**: a single physical or logical monitor as reported by Electron's `screen` module.
- **Display_Id**: the stable identifier for a Display as returned by `screen.getDisplayMatching` / `Display.id`.
- **Position_Store**: the persisted record of Overlay_Window bounds keyed by Display_Id.
- **Compact_Mode**: a reduced Overlay_Window form factor that shows only the control capsule and a single suggestion line.
- **Expanded_Mode**: the full Overlay_Window form factor that shows the suggestion card, transcript panel, quick actions, and input bar.
- **Active_Foreground_App**: the OS window that currently holds keyboard focus and is the target of user input.
- **Global_Shortcut**: a keyboard combination registered with Electron's `globalShortcut` module that fires regardless of which application has focus.
- **Content_Protection**: Electron's `BrowserWindow.setContentProtection` capability that hides a window from screen capture on supported platforms.
- **Snap_Edge**: one of the four screen edges (left, right, top, bottom) of the work area of the Display the Overlay_Window currently sits on.
- **Snap_Distance**: the distance in CSS pixels within which a drag release triggers edge snapping.
- **Panic_Hide**: the user-initiated action that hides the overlay, mutes the mic, stops capture, and aborts in-flight AI as defined in `cluely-parity-uplift` Requirement 15.8 — referenced for shortcut routing only.

## Requirements

### Requirement 1: Always-On-Top Above All Desktop Windows

**User Story:** As a user, I want the overlay to stay visible above every other window — including fullscreen browsers, video players, IDEs, games, and other always-on-top windows — so that I can see Zule's suggestions without alt-tabbing.

#### Acceptance Criteria

1. WHEN the Overlay_Manager creates the Overlay_Window, THE Overlay_Manager SHALL invoke `setAlwaysOnTop(true, 'screen-saver')` within 100 ms of window creation so that the Overlay_Window sits above the standard `floating`, `pop-up-menu`, and `modal-panel` z-levels.
2. WHILE the Active_Foreground_App is in exclusive fullscreen mode, THE Overlay_Window SHALL remain rendered above that fullscreen surface AND SHALL NOT be minimized, hidden, or reordered behind it.
3. WHEN another application registers an always-on-top window at a level at or below `screen-saver`, THE Overlay_Manager SHALL keep the Overlay_Window rendered above that window.
4. WHEN the Overlay_Window transitions from hidden via `hide()` to shown via `show()`, THE Overlay_Manager SHALL re-invoke `setAlwaysOnTop(true, 'screen-saver')` within 100 ms after `show()` returns so that the always-on-top state survives visibility transitions on Windows and Linux.
5. WHEN the user toggles always-on-top off via the Renderer_Bridge, THE Overlay_Manager SHALL invoke `setAlwaysOnTop(false)` on the Overlay_Window within 100 ms so that the Overlay_Window no longer sits above the `floating`, `pop-up-menu`, `modal-panel`, or `screen-saver` z-levels.
6. WHEN the user toggles the always-on-top setting via the Renderer_Bridge, THE Overlay_Manager SHALL persist the new toggle state to the Position_Store within 500 ms so that the choice survives application restart.
7. WHERE the host platform is macOS, WHEN the Overlay_Manager creates the Overlay_Window, THE Overlay_Manager SHALL invoke `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` within 100 ms of window creation so that the Overlay_Window follows the user across Spaces and remains visible above fullscreen Spaces.
8. WHEN the Electron screen module emits a `display-added`, `display-removed`, or `display-metrics-changed` event, THE Overlay_Manager SHALL re-invoke `setAlwaysOnTop(true, 'screen-saver')` on the Overlay_Window within 100 ms of the event so that monitor changes do not drop the always-on-top level.
9. WHEN the Overlay_Manager initializes the Overlay_Window at application startup, THE Overlay_Manager SHALL read the persisted always-on-top toggle state from the Position_Store and apply that state to the Overlay_Window before the Overlay_Window is first shown so that the user's previous choice is restored.
10. IF persisting the always-on-top toggle state to the Position_Store fails, THEN THE Overlay_Manager SHALL retain the new toggle state in memory for the current session AND SHALL emit an error indication to the Renderer_Bridge identifying that the persistence failed so that the user is aware the choice may not survive restart.

### Requirement 2: Frameless, Transparent, Rounded Window Chrome

**User Story:** As a user, I want the overlay to look like a small floating capsule with no OS title bar or borders, so that the visual matches the Cluely reference and the rounded UI is not clipped by native chrome.

#### Acceptance Criteria

1. THE Overlay_Manager SHALL create the Overlay_Window with `frame: false`, `transparent: true`, `hasShadow: false`, `skipTaskbar: true`, and `backgroundColor: '#00000000'`.
2. THE Overlay_Manager SHALL create the Overlay_Window with `titleBarStyle: 'hidden'` on macOS so that no title bar is rendered above the React content.
3. WHILE the Overlay_Window is open, THE rounded corners declared by the FloatingCopilot CSS SHALL be rendered without clipping by the OS window border on Windows, macOS, and Linux.
4. WHERE the host platform is Windows AND DWM rounded-corner clipping is active, THE Overlay_Manager SHALL not request OS-managed rounded corners and SHALL leave corner rendering to the renderer.
5. THE Overlay_Manager SHALL create the Overlay_Window with `roundedCorners: false` on macOS so that the renderer-controlled rounding is not double-clipped by AppKit AND SHALL apply this configuration unconditionally without any fallback to OS-managed rounding regardless of renderer state.
6. WHEN the Overlay_Window is created, THE pixels in the transparent margin around the FloatingCopilot capsule SHALL be fully transparent (alpha 0) and SHALL not show any window background fill.

### Requirement 3: Click-Through for Pass-Through Zones, Interactive Zones Remain Clickable

**User Story:** As a user, I want to click through the transparent areas around the capsule into whatever app is underneath, while still being able to type into the chat input and click the controls.

#### Acceptance Criteria

1. THE Overlay_Manager SHALL invoke `setIgnoreMouseEvents(true, { forward: true })` on the Overlay_Window during initialization so that the window starts in click-through mode and continues to receive `mousemove` events for hover-based zone detection.
2. THE renderer SHALL classify every pixel of the Overlay_Window as either an Interactive_Zone or a Pass_Through_Zone based on the DOM element under the cursor at that pixel.
3. WHEN the cursor enters an Interactive_Zone, THE renderer SHALL call `setIgnoreMouseEvents(false)` via the Renderer_Bridge so that mouse events are delivered to the FloatingCopilot.
4. WHEN the cursor leaves all Interactive_Zones, THE renderer SHALL call `setIgnoreMouseEvents(true, { forward: true })` so that mouse events fall through to the application below.
5. THE renderer SHALL toggle click-through state at most once per `mousemove` event AND SHALL debounce redundant calls using a same-state guard so that no IPC call is issued when the desired state already matches the current state.
6. WHILE the user is actively dragging the Overlay_Window via the drag handle, THE renderer SHALL keep `setIgnoreMouseEvents(false)` for the entire duration of the drag and SHALL ignore Pass_Through_Zone classification while the drag is in progress, restoring zone-based behavior only on `mouseup`.
7. WHILE a modal element (chat dropdown, settings menu) is open, THE renderer SHALL treat the entire Overlay_Window as an Interactive_Zone, overriding any underlying Pass_Through_Zone classification, until the modal closes.
8. IF the renderer cannot determine the zone (no element under cursor), THEN THE renderer SHALL default to Pass_Through_Zone behavior so that the user is never trapped clicking the overlay.

### Requirement 4: Drag-to-Reposition With Edge Snap, Multi-Monitor, and Persistence

**User Story:** As a user, I want to drag the overlay anywhere on any of my monitors, have it snap cleanly to screen edges, and have it remember where I last placed it on each monitor.

#### Acceptance Criteria

1. THE renderer SHALL designate the control capsule region of the FloatingCopilot as the drag handle AND SHALL apply CSS `-webkit-app-region: drag` to that region so that native window movement is used in Zule_Desktop.
2. THE renderer SHALL apply CSS `-webkit-app-region: no-drag` to every Interactive_Zone within the drag handle (e.g., the close, pause, and stop buttons inside the control capsule) so that those controls remain clickable.
3. WHEN the user drags the Overlay_Window across the boundary between two Displays, THE Overlay_Window SHALL move smoothly to the second Display without being clamped to the first Display's bounds.
4. WHEN the user releases a drag with the Overlay_Window's edge within Snap_Distance (default 16 CSS pixels) of a Snap_Edge of the current Display's work area, THE Overlay_Manager SHALL snap the matching Overlay_Window edge to that Snap_Edge.
5. WHEN the user releases a drag without entering Snap_Distance of any Snap_Edge, THE Overlay_Window SHALL remain at the released position.
6. WHEN a drag completes, THE Overlay_Manager SHALL record the Overlay_Window's bounds and the current Display_Id to the Position_Store under the key `displayId={Display_Id}`.
7. WHEN the Overlay_Window is created or shown, THE Overlay_Manager SHALL look up the Position_Store entry for the Display under the cursor, AND SHALL use the persisted bounds if present, otherwise SHALL place the Overlay_Window at the default top-right offset on that Display.
8. WHEN a Display is removed AND the Overlay_Window's last persisted position was on that Display, THE Overlay_Manager SHALL relocate the Overlay_Window to the primary Display at the default top-right offset on the next show.
9. THE Overlay_Manager SHALL clamp persisted bounds to the work area of the target Display before applying them so that a saved position from a larger monitor does not place the Overlay_Window off-screen on a smaller monitor.
10. THE Position_Store SHALL persist across application restarts using Electron's `app.getPath('userData')` directory and a JSON file `overlay-positions.json`.

### Requirement 5: Visible on All Virtual Desktops and Workspaces

**User Story:** As a user, I want the overlay to follow me when I switch virtual desktops, Spaces, or workspaces, so that I never lose it because I changed contexts.

#### Acceptance Criteria

1. WHERE the host platform is macOS, THE Overlay_Manager SHALL invoke `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` on the Overlay_Window so that the window appears on every Space, including fullscreen Spaces.
2. WHERE the host platform is Windows, THE Overlay_Manager SHALL invoke `setVisibleOnAllWorkspaces(true)` on the Overlay_Window so that the window appears on every virtual desktop available through Task View.
3. WHERE the host platform is Linux AND the window manager exposes the `_NET_WM_STATE_STICKY` hint via Electron, THE Overlay_Manager SHALL invoke `setVisibleOnAllWorkspaces(true)` so that the window appears on every workspace.
4. IF the host window manager does not support cross-workspace visibility OR the platform-specific `setVisibleOnAllWorkspaces` invocation throws or returns an error, THEN THE Overlay_Manager SHALL log a one-time structured warning AND SHALL leave the Overlay_Window on its current workspace without retrying.
5. WHEN the Overlay_Window is hidden and later shown, THE Overlay_Manager SHALL re-apply `setVisibleOnAllWorkspaces` so that the workspace-following state survives visibility transitions.

### Requirement 6: Hidden From Screen Capture and Screen Sharing

**User Story:** As a user, I want the overlay to not appear in screen recordings, Zoom shares, Teams shares, or OBS captures, so that I can use Zule discreetly.

#### Acceptance Criteria

1. THE Overlay_Manager SHALL invoke `setContentProtection(true)` on the Overlay_Window during initialization.
2. WHEN the user toggles content protection via the Renderer_Bridge `setContentProtection` method, THE Overlay_Manager SHALL apply the new value to the Overlay_Window AND SHALL persist the choice to the Position_Store.
3. WHILE Content_Protection is enabled on Windows, THE Overlay_Window SHALL be excluded from `BitBlt`-based and `DWM Thumbnail`-based capture surfaces such as Zoom screen share, Microsoft Teams screen share, and OBS Display Capture.
4. WHILE Content_Protection is disabled on any supported platform, THE Overlay_Window SHALL be visible to standard screen-capture surfaces so that the exclusion relationship is bidirectional.
5. IF the underlying `setContentProtection` call returns successfully but the OS still includes the Overlay_Window in a capture surface due to a platform limitation, THEN THE Overlay_Manager SHALL treat the call as a successful protection state AND SHALL not surface a failure notice to the user.
6. WHILE Content_Protection is enabled on macOS, THE Overlay_Window SHALL be excluded from `CGWindowListCreateImage`-based and `ScreenCaptureKit`-based capture surfaces using the AppKit `NSWindowSharingNone` sharing type that Electron sets internally.
7. WHERE the host platform is Linux, THE Overlay_Manager SHALL document that `setContentProtection` is a no-op AND SHALL surface a one-time non-blocking notice to the user the first time content protection is requested on Linux.
8. WHEN Zule_Desktop's own `desktopCapturer.getSources()` is invoked from within Zule, THE returned source list SHALL not list the Overlay_Window as a capturable window while Content_Protection is enabled.
9. THE Overlay_Manager SHALL re-apply `setContentProtection` after every `show()` of the Overlay_Window so that the protection survives visibility transitions on platforms that reset the flag on hide.

### Requirement 7: Global Shortcuts That Work Across All Applications

**User Story:** As a user, I want keyboard shortcuts to show, hide, recenter, nudge, and panic-hide the overlay even when another application has focus, so that I can control Zule without alt-tabbing.

#### Acceptance Criteria

1. THE Overlay_Manager SHALL register the Global_Shortcut `Ctrl+Shift+H` (or `Cmd+Shift+H` on macOS) to toggle Overlay_Window visibility.
2. THE Overlay_Manager SHALL register the Global_Shortcut `Ctrl+Shift+\\` (or `Cmd+Shift+\\` on macOS) to invoke Panic_Hide as defined in `cluely-parity-uplift` Requirement 15.8.
3. THE Overlay_Manager SHALL register the Global_Shortcut `Ctrl+Shift+Z` (or `Cmd+Shift+Z` on macOS) to bring the Main_Window and Overlay_Window to the front and focus the Main_Window.
4. THE Overlay_Manager SHALL register the Global_Shortcuts `Ctrl+Alt+Up`, `Ctrl+Alt+Down`, `Ctrl+Alt+Left`, and `Ctrl+Alt+Right` (or `Cmd+Option+<arrow>` on macOS) to nudge the Overlay_Window by 40 CSS pixels in the matching direction within the current Display's work area.
5. THE Overlay_Manager SHALL register the Global_Shortcut `Ctrl+Alt+0` (or `Cmd+Option+0` on macOS) to recenter the Overlay_Window on the Display under the cursor.
6. WHEN a Global_Shortcut fires, THE Overlay_Manager SHALL forward a structured event of shape `{ shortcutId: string }` to both the Main_Window and the Overlay_Window via `webContents.send('global-shortcut', shortcutId)` so that the renderer's existing `onGlobalShortcut` handler in `FloatingCopilot.tsx` continues to receive it, AND SHALL forward events only for shortcuts whose registration succeeded.
7. IF a Global_Shortcut registration fails because the combination is already taken by another application, THEN THE Overlay_Manager SHALL log a structured warning containing the combination, SHALL emit an in-app notice to the user identifying which combination is unavailable, AND SHALL not forward `global-shortcut` events for the failed combination.
8. WHEN the application quits, THE Overlay_Manager SHALL invoke `globalShortcut.unregisterAll()` so that no shortcut remains registered after Zule_Desktop exits.
9. WHERE the user has customized a Global_Shortcut combination via Settings, THE Overlay_Manager SHALL re-register the new combination AND SHALL unregister the previous combination atomically before applying the change.

### Requirement 8: No Focus Stealing From the Active Foreground App

**User Story:** As a user, I want the overlay to appear without taking focus away from the app I'm working in, so that my typing and shortcuts continue to land where I expect.

#### Acceptance Criteria

1. WHEN the Overlay_Window is created, THE Overlay_Manager SHALL pass `show: false` and `focusable: true` to the `BrowserWindow` constructor AND SHALL invoke `showInactive()` on first display so that the Active_Foreground_App retains keyboard focus.
2. WHEN the Overlay_Manager invokes `show()` after a hide, THE Overlay_Manager SHALL prefer `showInactive()` over `show()` so that no focus change occurs.
3. WHEN the Overlay_Window is brought back via Global_Shortcut `Ctrl+Shift+Z`, THE Main_Window SHALL receive focus AND THE Overlay_Window SHALL be shown via `showInactive()`.
4. WHILE the Overlay_Window is visible, clicking inside an Interactive_Zone SHALL transfer focus to the Overlay_Window so that the chat input receives keystrokes.
5. WHEN the user clicks outside the Overlay_Window after typing, THE Overlay_Window SHALL not reclaim focus on its next `show()` call.
6. THE Overlay_Manager SHALL set `webPreferences.backgroundThrottling: false` on the Overlay_Window so that the renderer continues to update at full rate even when the Active_Foreground_App holds focus.

### Requirement 9: Resize, Compact Mode, and Expanded Mode

**User Story:** As a user, I want the overlay to start small and expand only when I'm reading the suggestion or typing, so that it stays out of the way.

#### Acceptance Criteria

1. THE Overlay_Manager SHALL configure the Overlay_Window with `minWidth: 380`, `minHeight: 64`, `maxWidth: 700`, and `maxHeight: 900`, all values expressed in CSS pixels.
2. THE Overlay_Manager SHALL configure the Overlay_Window with `resizable: true` so that the user can resize from the corners.
3. THE renderer SHALL define Compact_Mode as a 380×64 CSS-pixel form factor that shows only the control capsule AND a single suggestion preview line, where the preview line truncates with a trailing ellipsis if its content exceeds the available horizontal space.
4. THE renderer SHALL define Expanded_Mode as a 450×600 CSS-pixel form factor (default expanded dimensions) up to the maxWidth/maxHeight that shows the suggestion card, transcript area, quick actions, and input bar.
5. WHEN the user toggles between Compact_Mode and Expanded_Mode via the control capsule chevron, THE renderer SHALL invoke `resizeOverlay(width, height)` on the Renderer_Bridge with the target form-factor dimensions AND the Overlay_Manager SHALL animate the resize to the target dimensions over 180 ms.
6. IF the renderer requests a resize that would place any edge of the Overlay_Window outside the work area of its current Display, THEN THE Overlay_Manager SHALL adjust the Overlay_Window position before applying the new size so that the entire Overlay_Window remains within the work area of the current Display.
7. WHEN the user finishes a manual resize gesture on the Overlay_Window via the corner grips, THE Overlay_Manager SHALL persist the resulting bounds to the Position_Store under the current Display_Id within 500 ms of the gesture ending.
8. WHEN the Overlay_Window enters Compact_Mode, THE renderer SHALL remove the transcript panel, quick actions, and input bar from the accessibility tree AND from focus order.
9. WHEN the Overlay_Window enters Expanded_Mode, THE renderer SHALL restore the transcript panel, quick actions, and input bar to the accessibility tree AND to focus order.
10. WHEN the Overlay_Window first launches and no persisted bounds exist in the Position_Store for the current Display_Id, THE Overlay_Manager SHALL open the Overlay_Window in Compact_Mode at the default position for the current Display.
11. IF the bounds retrieved from the Position_Store for the current Display_Id fall outside the configured `minWidth`, `minHeight`, `maxWidth`, or `maxHeight`, THEN THE Overlay_Manager SHALL clamp those bounds to the configured limits before applying them to the Overlay_Window.

### Requirement 10: FloatingCopilot Renders Inside the Native Overlay Window

**User Story:** As a developer, I want the existing `FloatingCopilot` React component to render inside the native overlay window without forking the component, so that the Cluely-style desktop overlay is the same UI that runs in the browser.

#### Acceptance Criteria

1. THE Overlay_Manager SHALL load the renderer at the Overlay_Route `#overlay` in the Overlay_Window so that the React app can mount FloatingCopilot in isolation rather than the full dashboard.
2. THE renderer entry SHALL detect `window.location.hash === '#overlay'` AND, when matched, SHALL render `<FloatingCopilot />` as the root component without wrapping it in the dashboard chrome.
3. WHILE rendering inside the Overlay_Window, the FloatingCopilot SHALL reuse the existing `useElectronBridge` hook AND THE existing `onGlobalShortcut` handler so that the implementation is shared with Zule_Web.
4. WHEN the Overlay_Window is shown, the FloatingCopilot's drag handle position SHALL be ignored in favor of native window dragging via `-webkit-app-region: drag`, AND THE renderer SHALL set the `position` style of the overlay root to `position: fixed; left: 0; top: 0; width: 100vw; height: 100vh;` so that the React component fills the native window.
5. THE renderer SHALL pipe state between the Main_Window and Overlay_Window through the existing `sendSyncMessage` / `onSyncMessage` IPC channel so that transcript, AI response, mode, and elapsed-time updates remain in sync as defined by `cluely-parity-uplift` Requirement 11.
6. WHEN the FloatingCopilot in the Overlay_Window unmounts cleanly (in response to a normal navigation or user-initiated stop), THE renderer SHALL invoke `stopOverlay()` on the Renderer_Bridge so that the native window closes cleanly.
7. IF the FloatingCopilot crashes or unmounts unexpectedly due to an uncaught error, THEN THE renderer SHALL not invoke `stopOverlay()` so that the Overlay_Window remains open for diagnostic inspection.
8. WHEN the user closes the Overlay_Window through any means external to FloatingCopilot unmount (clicking a close affordance, OS shutdown, application quit), THE Overlay_Manager SHALL allow the close to proceed without requiring the FloatingCopilot to unmount first.
9. THE Overlay_Manager SHALL set `webPreferences.preload` on the Overlay_Window to the same `preload.mjs` used by the Main_Window so that the Renderer_Bridge surface is identical in both windows.

### Requirement 11: Web-Mode Fallback to In-Page DOM Overlay

**User Story:** As a user opening Zule in a browser, I want the floating copilot to keep working as an in-page DOM overlay, so that the same React app runs unchanged in browsers that have no Electron.

#### Acceptance Criteria

1. WHEN the renderer detects `isElectron() === false` via `useElectronBridge`, THE FloatingCopilot SHALL render as the in-page DOM overlay using its existing `useDraggable` hook AND its existing CSS positioning, regardless of whether any other native overlay capability appears to be available in the host environment.
2. WHEN the renderer detects `isElectron() === false`, THE FloatingCopilot SHALL not invoke any Renderer_Bridge method that would have OS-level effects (`setAlwaysOnTop`, `setIgnoreMouseEvents`, `setContentProtection`, `resizeOverlay`, `moveOverlay`, `startOverlay`, `stopOverlay`) AND THE existing `browserFallback` no-op API SHALL silently absorb any accidental calls without throwing, logging, or notifying the user.
3. WHEN the renderer detects `isElectron() === true` and `window.location.hash === '#overlay'`, THE FloatingCopilot SHALL render as the native overlay variant defined in Requirement 10.
4. WHEN the renderer detects `isElectron() === true` and `window.location.hash !== '#overlay'`, THE FloatingCopilot SHALL not render in the Main_Window AND THE Main_Window SHALL render the dashboard route in its place.
5. THE web-mode fallback SHALL preserve all keyboard shortcuts defined for the in-page overlay (`Ctrl+Shift+H`, `Ctrl+Alt+<arrow>`, `Ctrl+Alt+0`, `Ctrl+Shift+\\`, `Escape`) using the existing `useKeyboardShortcuts` hook so that browser users have feature parity for in-window control.
6. WHEN the web-mode fallback is active, the panic-hide and bring-to-front Global_Shortcut behaviors SHALL be limited to the active browser tab AND THE renderer SHALL not promise OS-level scope.

### Requirement 12: Cross-Platform Parity With Documented Divergences

**User Story:** As a user on Windows, macOS, or Linux, I want the overlay to behave the same wherever the underlying OS allows, and I want clear documentation when an OS forces a divergence.

#### Acceptance Criteria

1. THE Overlay_Manager SHALL implement Requirements 1 through 9 on Windows, macOS, and Linux using the underlying Electron, AppKit, GDI/DWM, and X11/Wayland APIs, AND SHALL list in the renderer's settings panel every requirement-to-platform combination that is not fully supported, naming the underlying API responsible for each divergence.
2. WHERE Content_Protection is unsupported on the host platform, WHEN content protection is requested for the first time after installation on that platform, THE Overlay_Manager SHALL display a non-blocking notice that names the host platform and identifies Content_Protection as unsupported, that remains visible until the user dismisses it or 10 seconds elapse (whichever occurs first), AND SHALL suppress the same notice on every subsequent content protection request on the same installation.
3. WHERE Content_Protection is unsupported on the host platform, THE Overlay_Manager SHALL display a persistent limitation entry in the renderer's settings panel that names the host platform and identifies Content_Protection as unsupported.
4. WHERE `setVisibleOnAllWorkspaces` is unsupported on the host window manager, THE Overlay_Manager SHALL emit a warning log entry that identifies the host window manager and the unsupported API, AND SHALL display a persistent limitation entry in the renderer's settings panel that identifies the affected feature and the host window manager.
5. WHERE the host platform is Wayland, IF global shortcut registration is rejected by the compositor, THEN THE Overlay_Manager SHALL display an in-app notice within 2 seconds of the rejection that lists every affected shortcut binding by name, AND SHALL register equivalent in-window shortcuts that activate only WHILE the Overlay_Window holds keyboard focus.
6. THE Overlay_Manager SHALL expose `electronAPI.platform` (already declared in `src/types/electron.d.ts`) to the renderer, returning the identifier `win32` on Windows, `darwin` on macOS, and `linux` on Linux.
7. THE renderer SHALL render every tooltip and settings panel control that displays a keyboard-shortcut label using the modifier `Ctrl` when `electronAPI.platform` returns `win32` or `linux`, and using the modifier `Cmd` when `electronAPI.platform` returns `darwin`.

### Requirement 13: Accessibility of the Native Overlay

**User Story:** As a user with assistive technology, I want the floating overlay to be reachable and operable from the keyboard and from a screen reader, so that I can use Zule on equal footing.

#### Acceptance Criteria

1. THE renderer SHALL render the FloatingCopilot root element with `role="region"` and `aria-label="Zule AI copilot"` (already present in `src/components/FloatingCopilot.tsx`) inside the Overlay_Window.
2. WHEN the Overlay_Window first becomes visible, the chat input SHALL not auto-focus so that the Active_Foreground_App retains focus per Requirement 8.
3. WHEN the user invokes the Global_Shortcut to bring the overlay to front (`Ctrl+Shift+Z`), THE renderer SHALL move keyboard focus to the chat input so that the user can immediately type.
4. THE renderer SHALL implement a focus trap inside the Overlay_Window that activates only while the user is interacting with the overlay AND SHALL release the trap immediately when the overlay is hidden, regardless of whether the user is mid-interaction (such as actively typing in the chat input).
5. THE renderer SHALL announce mode transitions between Compact_Mode and Expanded_Mode using `aria-live="polite"` so that screen-reader users know the layout changed.
6. THE renderer SHALL ensure that every Interactive_Zone has a non-empty accessible name resolved via `aria-label`, `aria-labelledby`, or visible text.
7. WHILE Compact_Mode is active, focus order SHALL skip elements hidden per Requirement 9.8 so that keyboard users do not tab into invisible controls.

### Requirement 14: Performance and Resource Bounds

**User Story:** As a user running Zule alongside other applications, I want the native overlay to be lightweight, so that it does not regress my battery life or CPU.

#### Acceptance Criteria

1. WHILE the Overlay_Window is idle (no streaming, no transcription updates, no cursor movement), THE Overlay_Window's renderer process SHALL consume less than 1 % CPU averaged over a 60-second window on a baseline reference machine (8-core CPU, 16 GB RAM).
2. THE renderer SHALL throttle click-through-zone evaluation (Requirement 3) to at most 60 evaluations per second using `requestAnimationFrame` so that high-frequency `mousemove` events do not flood IPC.
3. WHEN the cursor is outside the Overlay_Window AND no animation is in progress, THE renderer SHALL not invoke any Renderer_Bridge method per frame, and this prohibition SHALL apply absolutely with no exceptions for cleanup or state synchronization.
4. THE Overlay_Manager SHALL not register any timer that runs more frequently than once per second in the main process for overlay maintenance.
5. WHEN the user enters Panic_Hide, THE Overlay_Manager SHALL hide the Overlay_Window within 200 ms of the Global_Shortcut firing as measured from `globalShortcut` callback to `BrowserWindow.hide()` return.
6. WHEN the user invokes the show/hide Global_Shortcut, THE Overlay_Window SHALL transition between hidden and visible within 150 ms as measured from shortcut callback to first paint.
7. THE Overlay_Window's renderer process SHALL hold no more than 200 MB of resident memory under steady-state Expanded_Mode operation, excluding model assets owned by the Main_Window.
