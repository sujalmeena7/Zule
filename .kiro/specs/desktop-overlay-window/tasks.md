# Implementation Plan: Desktop Overlay Window

## Overview

This plan implements the native desktop overlay window layer for Zule AI's Electron app. It extracts the existing inline overlay logic from `electron/main.ts` into a dedicated `OverlayManager` module, adds position persistence, edge-snap algorithms, renderer-side click-through zone detection, focus trap, and the `OverlayShell` wrapper component. All pure algorithm modules are covered by property-based tests using `fast-check`.

## Tasks

- [x] 1. Create pure algorithm modules (no Electron dependencies)
  - [x] 1.1 Implement edge snap algorithm (`electron/edgeSnap.ts`)
    - Create `Rect` and `SnapResult` interfaces
    - Implement `computeSnap(windowBounds, workArea, snapDistance)` — snaps window edges within `snapDistance` of work-area edges
    - Implement `clampToWorkArea(bounds, workArea)` — ensures rectangle is fully contained, idempotent
    - Implement `clampSize(width, height, constraints)` — clamps to min/max dimensions, idempotent
    - Export size constants: `MIN_WIDTH=380`, `MIN_HEIGHT=64`, `MAX_WIDTH=700`, `MAX_HEIGHT=900`, `COMPACT_WIDTH=380`, `COMPACT_HEIGHT=64`, `EXPANDED_WIDTH=450`, `EXPANDED_HEIGHT=600`, `SNAP_DISTANCE=16`, `NUDGE_STEP=40`, `RESIZE_DURATION=180`
    - _Requirements: 4.4, 4.5, 4.9, 9.1, 9.11_

  - [ ]* 1.2 Write property tests for edge snap (`computeSnap`)
    - **Property 3: Edge snap correctness**
    - Use `fast-check` to generate arbitrary `Rect` and `workArea` values
    - Assert: if window edge within `snapDistance` of work-area edge → output aligned; otherwise unchanged
    - **Validates: Requirements 4.4, 4.5**

  - [ ]* 1.3 Write property tests for bounds clamping (`clampToWorkArea`)
    - **Property 4: Bounds clamping invariant**
    - Assert: result is fully within work area; function is idempotent (`clamp(clamp(b,w),w) === clamp(b,w)`)
    - **Validates: Requirements 4.9, 9.6**

  - [ ]* 1.4 Write property tests for size clamping (`clampSize`)
    - **Property 5: Size clamping to configured limits**
    - Assert: `minWidth <= result.width <= maxWidth` and `minHeight <= result.height <= maxHeight`; function is idempotent
    - **Validates: Requirements 9.11**

  - [x] 1.5 Implement zone detector (`src/overlay/zoneDetector.ts`)
    - Create `ZoneClassification` type (`'interactive' | 'pass-through'`)
    - Create `ZoneDetectorState` interface (`isDragging`, `isModalOpen`, `currentZone`)
    - Implement `classifyZone(element, state)` — priority: drag override → modal override → `[data-interactive-zone]` check → pass-through
    - Implement `shouldEmitIPC(previousZone, newZone)` — returns true only on state transition
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [ ]* 1.6 Write property tests for zone detection (`classifyZone`)
    - **Property 1: Zone detection classifies correctly**
    - **Property 6: Drag-state overrides zone detection**
    - **Property 7: Modal-state overrides zone detection**
    - Generate arbitrary combinations of element presence, `[data-interactive-zone]` marker, `isDragging`, `isModalOpen`
    - Assert: drag/modal always → `interactive`; marker → `interactive`; no element or no marker → `pass-through`
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.6, 3.7**

  - [ ]* 1.7 Write property tests for IPC deduplication (`shouldEmitIPC`)
    - **Property 2: IPC call deduplication suppresses redundant calls**
    - Generate arbitrary sequences of zone classifications
    - Assert: number of IPC calls equals number of state transitions
    - **Validates: Requirements 3.5**

- [x] 2. Implement Position Store (`electron/positionStore.ts`)
  - [x] 2.1 Create `PositionStore` class with JSON file persistence
    - Define `PersistedBounds` interface (x, y, width, height, mode, alwaysOnTop, contentProtection)
    - Define `PositionStoreData` interface (version: 1, displays: Record<string, PersistedBounds>)
    - Implement `load()` — reads from `app.getPath('userData')/overlay-positions.json`, returns defaults on missing/corrupt file
    - Implement `get(displayId)` — returns persisted bounds for display
    - Implement `set(displayId, bounds)` — marks dirty, schedules debounced flush
    - Implement `flush()` — writes JSON to disk
    - Implement `remove(displayId)` — removes entry for a display
    - Handle I/O errors: log warning, retain in-memory state, emit error indication
    - _Requirements: 4.6, 4.7, 4.10, 1.6, 1.9, 1.10, 6.2_

  - [ ]* 2.2 Write unit tests for `PositionStore`
    - Test load/save/flush cycle with mock filesystem
    - Test corrupt file recovery (returns defaults)
    - Test concurrent access safety
    - Test error handling paths
    - _Requirements: 4.6, 4.10_

- [x] 3. Implement Overlay Manager (`electron/overlayManager.ts`)
  - [x] 3.1 Create `OverlayManager` class with window lifecycle methods
    - Define `OverlayManagerConfig` interface (preloadPath, rendererUrl, isDev, snapDistance)
    - Define `OverlayState` interface (alwaysOnTop, contentProtection, mode)
    - Implement `create()` — create BrowserWindow with all required options (`frame:false`, `transparent:true`, `hasShadow:false`, `skipTaskbar:true`, `backgroundColor:'#00000000'`, `show:false`, `focusable:true`, `resizable:true`, size constraints, `webPreferences.backgroundThrottling:false`, `titleBarStyle:'hidden'` on macOS, `roundedCorners:false` on macOS)
    - Call `setAlwaysOnTop(true, 'screen-saver')` within 100ms of creation
    - Call `setContentProtection(true)` during initialization
    - Call `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true})` on macOS
    - Call `setIgnoreMouseEvents(true, {forward:true})` on initialization
    - Use `showInactive()` for first display
    - Load renderer at `#overlay` route
    - _Requirements: 1.1, 1.7, 2.1, 2.2, 2.4, 2.5, 2.6, 3.1, 5.1, 5.2, 5.3, 6.1, 8.1, 8.6, 9.1, 9.2, 10.1, 10.9_

  - [x] 3.2 Implement show/hide/toggle with focus-safe behavior
    - `show()` — use `showInactive()`, re-apply `setAlwaysOnTop(true, 'screen-saver')`, re-apply `setVisibleOnAllWorkspaces`, re-apply `setContentProtection`
    - `hide()` — call `BrowserWindow.hide()`
    - `toggle()` — returns new visibility state
    - Ensure show/hide transitions complete within 150ms
    - _Requirements: 1.4, 5.5, 6.9, 8.2, 8.5, 14.6_

  - [x] 3.3 Implement drag, snap, and position persistence
    - Listen for `moved` event on BrowserWindow
    - On drag end: compute snap via `computeSnap`, apply `setBounds` if snapped
    - Persist bounds to `PositionStore` on drag completion
    - On creation/show: restore bounds from `PositionStore` for current display, clamp to work area and size constraints
    - Default to top-right offset when no persisted bounds exist (Compact_Mode)
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 9.10, 9.11_

  - [x] 3.4 Implement resize with animation and bounds enforcement
    - `resize(width, height)` — animate over 180ms (ease-out), clamp to size constraints
    - Adjust position if resize would push window outside work area
    - Persist bounds after manual resize (within 500ms)
    - _Requirements: 9.5, 9.6, 9.7_

  - [x] 3.5 Implement nudge and recenter
    - `nudge(dx, dy)` — move by delta, clamp to work area
    - `recenter()` — center on display under cursor
    - _Requirements: 7.4, 7.5_

  - [x] 3.6 Implement display change handling
    - Listen for `display-added`, `display-removed`, `display-metrics-changed` events
    - Re-apply `setAlwaysOnTop(true, 'screen-saver')` within 100ms of event
    - Relocate to primary display if current display removed
    - Re-clamp bounds on metrics change
    - _Requirements: 1.8, 4.8_

  - [x] 3.7 Implement global shortcut registration
    - Register `Ctrl+Shift+H` / `Cmd+Shift+H` — toggle overlay visibility
    - Register `Ctrl+Shift+\` / `Cmd+Shift+\` — panic hide (hide within 200ms)
    - Register `Ctrl+Shift+Z` / `Cmd+Shift+Z` — bring to front (Main_Window focused, overlay showInactive)
    - Register `Ctrl+Alt+Arrow` / `Cmd+Option+Arrow` — nudge by 40px
    - Register `Ctrl+Alt+0` / `Cmd+Option+0` — recenter
    - Forward `{ shortcutId }` to both windows via `webContents.send('global-shortcut', shortcutId)` only for successfully registered shortcuts
    - Handle registration failures: log warning, emit in-app notice, skip forwarding for failed combos
    - Unregister all on app quit
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 8.3, 14.5_

  - [x] 3.8 Implement always-on-top and content-protection toggle IPC
    - `setAlwaysOnTop` IPC handler — apply state, persist to PositionStore within 500ms
    - `setContentProtection` IPC handler — apply state, persist, surface Linux no-op notice
    - Handle persistence failures: retain in-memory, emit error to renderer
    - _Requirements: 1.5, 1.6, 1.9, 1.10, 6.2, 6.7_

  - [x] 3.9 Handle overlay crash and cleanup
    - Listen for `render-process-gone` — leave window open for diagnostics, emit error to main window
    - Handle close from OS/quit without requiring FloatingCopilot unmount
    - Clean up overlay reference when main window closes
    - _Requirements: 10.7, 10.8_

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Refactor main process entry point
  - [x] 5.1 Extract overlay logic from `electron/main.ts` into `OverlayManager`
    - Replace inline `createOverlayWindow()` and IPC handlers with `OverlayManager` instantiation
    - Replace inline `registerGlobalShortcuts()` with `overlayManager.registerShortcuts(mainWindow)`
    - Update IPC handlers to delegate to `OverlayManager` methods
    - Keep `electron/main.ts` as a thin orchestrator
    - _Requirements: 10.9 (preload path shared), all overlay lifecycle requirements_

  - [x] 5.2 Update preload script to support new IPC channels
    - Ensure `set-ignore-mouse-events` accepts `{ ignore, forward? }` shape
    - Expose any new IPC methods needed by zone detector (if not already covered)
    - Ensure preload is shared between Main_Window and Overlay_Window
    - _Requirements: 3.1, 10.9_

- [x] 6. Implement renderer-side overlay components
  - [x] 6.1 Create `OverlayShell` component (`src/components/OverlayShell.tsx`)
    - Render with `position:fixed; inset:0; width:100vw; height:100vh`
    - Render `<FloatingCopilot />` inside
    - Apply `-webkit-app-region: drag` to capsule region
    - Apply `-webkit-app-region: no-drag` to interactive controls within drag handle
    - Integrate zone detector (RAF-throttled mousemove → classifyZone → IPC)
    - Integrate focus trap
    - Add `role="region"` and `aria-label="Zule AI copilot"` to root
    - Mark interactive zones with `[data-interactive-zone]` attribute
    - _Requirements: 10.2, 10.4, 4.1, 4.2, 13.1, 13.6_

  - [x] 6.2 Implement zone detector integration hook (`src/overlay/useZoneDetector.ts`)
    - Use `requestAnimationFrame` to throttle evaluations to 60/s
    - Call `elementFromPoint(x, y)` on each evaluation
    - Call `classifyZone` and `shouldEmitIPC` to determine if IPC needed
    - Call `setIgnoreMouseEvents` via Renderer_Bridge only on state transitions
    - Track drag state and modal state to override classification
    - Do not invoke any bridge method when cursor is outside overlay and no animation in progress
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 14.2, 14.3_

  - [ ]* 6.3 Write property test for RAF throttle bounds
    - **Property 9: RAF throttle bounds zone evaluations**
    - Simulate burst of mousemove events, assert at most one evaluation per frame
    - **Validates: Requirements 14.2**

  - [x] 6.4 Implement focus trap hook (`src/overlay/focusTrap.ts`)
    - Trap Tab/Shift+Tab within overlay container when enabled
    - Release immediately when overlay hidden (even mid-interaction)
    - Activate only while user is interacting with overlay
    - _Requirements: 13.4, 13.7_

  - [ ]* 6.5 Write property test for focus trap containment
    - **Property 10: Focus trap containment**
    - Generate sequences of Tab/Shift+Tab, assert focus cycles within container
    - **Validates: Requirements 13.4**

  - [x] 6.6 Update renderer entry point (`src/main.tsx`)
    - Detect `window.location.hash === '#overlay'`
    - If overlay route: mount `<OverlayShell />` in isolation (no dashboard chrome)
    - If not overlay: mount `<App />` as before
    - If `isElectron() && hash !== '#overlay'`: do not render FloatingCopilot in Main_Window
    - _Requirements: 10.1, 10.2, 11.3, 11.4_

  - [x] 6.7 Implement compact/expanded mode transitions
    - Compact_Mode: 380×64, shows only control capsule + single suggestion preview (ellipsis truncation)
    - Expanded_Mode: 450×600 default, shows suggestion card, transcript, quick actions, input bar
    - Toggle via chevron: call `resizeOverlay(width, height)` on Renderer_Bridge
    - On compact: remove transcript/quick-actions/input from a11y tree and focus order
    - On expanded: restore to a11y tree and focus order
    - Announce mode transition via `aria-live="polite"`
    - _Requirements: 9.3, 9.4, 9.5, 9.8, 9.9, 13.5, 13.7_

  - [ ]* 6.8 Write property test for accessible names on interactive zones
    - **Property 11: All interactive zones have accessible names**
    - Query all elements with `[data-interactive-zone]`, assert non-empty accessible name
    - **Validates: Requirements 13.6**

- [x] 7. Implement web-mode fallback and cross-platform handling
  - [x] 7.1 Verify and harden web-mode fallback (`useElectronBridge` browser path)
    - Ensure `browserFallback` absorbs all calls without throwing, logging, or notifying
    - Ensure FloatingCopilot renders as in-page DOM overlay when `isElectron() === false`
    - Preserve keyboard shortcuts via existing `useKeyboardShortcuts` hook in browser mode
    - Limit panic-hide and bring-to-front to active browser tab scope
    - _Requirements: 11.1, 11.2, 11.5, 11.6_

  - [ ]* 7.2 Write property test for web fallback no-op absorption
    - **Property 8: Web fallback no-op absorption**
    - For every method on `ElectronAPI` interface, invoke through `browserFallback`
    - Assert: no throw, returns safe default, no side effects
    - **Validates: Requirements 11.2**

  - [x] 7.3 Implement cross-platform divergence handling
    - Linux: surface one-time non-blocking notice for content protection no-op
    - Wayland: handle global shortcut registration rejection, register in-window fallbacks
    - Expose `electronAPI.platform` to renderer (already in preload)
    - Render shortcut labels with `Ctrl` on win32/linux, `Cmd` on darwin
    - Display limitation entries in settings panel for unsupported features
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 6.7_

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Integration wiring and final validation
  - [x] 9.1 Wire `OverlayManager` into app lifecycle
    - Instantiate in `app.whenReady()` after main window creation
    - Pass correct config (preloadPath, rendererUrl, isDev)
    - Register shortcuts with reference to main window
    - Hook into `before-quit` for cleanup
    - Hook into `window-all-closed` for cleanup
    - Connect `ipc-sync-message` forwarding between Main_Window and Overlay_Window
    - _Requirements: 10.5, 10.6, 10.8, 7.8_

  - [x] 9.2 Implement performance constraints
    - Verify no main-process timer runs more frequently than once per second for overlay maintenance
    - Verify renderer does not invoke bridge methods per frame when cursor outside overlay
    - Verify panic-hide completes within 200ms
    - Verify show/hide transitions within 150ms
    - _Requirements: 14.1, 14.3, 14.4, 14.5, 14.6, 14.7_

  - [ ]* 9.3 Write integration tests
    - Test overlay creation with correct BrowserWindow options
    - Test show/hide lifecycle using `showInactive()`
    - Test edge-snap on drag release
    - Test position persistence across restart simulation
    - Test global shortcut forwarding
    - Test content protection state
    - Test mode transitions (compact ↔ expanded)
    - _Requirements: 1.1, 1.4, 4.4, 4.6, 6.1, 7.6, 9.5_

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The design uses TypeScript throughout — all implementation files use `.ts`/`.tsx`
- `fast-check` is already in devDependencies for property-based testing
- The existing `electron/main.ts` scaffolding provides the starting point; task 5 refactors it to use the new `OverlayManager`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.5", "2.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.6", "1.7", "2.2"] },
    { "id": 2, "tasks": ["3.1", "6.4"] },
    { "id": 3, "tasks": ["3.2", "3.3", "3.4", "3.5", "3.6", "3.7", "3.8", "3.9", "6.5"] },
    { "id": 4, "tasks": ["5.1", "5.2"] },
    { "id": 5, "tasks": ["6.1", "6.2", "6.6", "6.7", "7.1", "7.3"] },
    { "id": 6, "tasks": ["6.3", "6.8", "7.2"] },
    { "id": 7, "tasks": ["9.1", "9.2"] },
    { "id": 8, "tasks": ["9.3"] }
  ]
}
```
