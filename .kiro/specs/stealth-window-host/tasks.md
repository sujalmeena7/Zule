# Implementation Plan: Stealth Window Host

## Overview

Tasks 1–15 are retained as completed historical Stage A/B context. Stage A failed mandatory real-Windows gates A5/A6 and remains disabled; Stage B remains disabled and not evaluated. The unchecked Stage C plan implements the design's truthful Windows-only `ZuleUI.exe` WebView2 sidecar while Electron remains App Core and Layer 0 remains packaged, warm, and immediately recoverable. Stage C is production-disabled until every release gate has complete passing evidence bound to the packaged artifact hashes.

## Tasks

### Completed Historical Stage A/B Tasks

- [x] 1. Create shared Win32 FFI module
  - [x] 1.1 Create `electron/win32/ffi.ts` with lazy-loaded koffi surface
    - Extract and generalize the FFI loading pattern from `electron/nativeStealth.ts`
    - Implement `getFfi(): Win32Ffi | null` with single-load-once, failure-latch semantics
    - Load `user32.dll`, `kernel32.dll`, `dwmapi.dll` (gdi32 lazy for Stage B)
    - Declare all Stage A function bindings: `RegisterClassExW`, `UnregisterClassW`, `CreateWindowExW`, `DestroyWindow`, `SetParent`, `GetParent`, `GetWindowLongPtrW`, `SetWindowLongPtrW`, `SetWindowPos`, `ShowWindow`, `DefWindowProcW`, `GetClientRect`, `GetWindowRect`, `GetClassNameW`, `LoadCursorW`, `GetModuleHandleW`, `GetLastError`
    - Declare all struct types: `POINT`, `SIZE`, `RECT`, `BLENDFUNCTION`, `WNDPROC` proto, `WNDCLASSEXW`
    - Implement `registerCallback`, `unregisterCallback`, `alloc`, `decode`, `procAddress` helpers
    - Implement `isWin32()` platform guard
    - No-op on non-Windows; never throw to callers
    - _Requirements: 10.1, 10.3, 10.4_

  - [x] 1.2 Refactor `electron/nativeStealth.ts` to consume `win32/ffi.ts`
    - Replace inline koffi loading with `getFfi()` from the shared module
    - Accept a raw HWND value (from `CreateWindowExW`) in addition to Electron's `getNativeWindowHandle()` Buffer
    - Preserve existing public API: `applyNativeStealth`, `removeNativeStealth`, `isNativeStealthAvailable`
    - Ensure all existing tests pass unmodified
    - _Requirements: 4.1, 10.3_

- [x] 2. Implement WNDPROC registration and safety
  - [x] 2.1 Create `electron/win32/wndProc.ts` with native-fallback and JS callback modes
    - Implement `registerWndProc('native')`: resolve `DefWindowProcW` address from user32.dll, return it as `lpfnWndProc` with no koffi callback registered
    - Implement `registerWndProc('js', handlers)`: register a koffi callback with `makeSafeWndProc` wrapper
    - Implement `makeSafeWndProc` with try/catch totality, circuit breaker (`MAX_WNDPROC_FAULTS = 10`), reentrancy guard (`inWndProc` flag), ring buffer fault recorder
    - Implement message allowlist: mouse, wheel, keyboard, `WM_MOUSELEAVE`, `WM_DPICHANGED`, `WM_DISPLAYCHANGE`, `WM_DESTROY` — all others return `null` immediately
    - Implement `dispose()` that calls `koffi.unregister` only after `DestroyWindow` + `UnregisterClassW`
    - Assert `process.type === 'browser'` on registration
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [x] 2.2 Write property test for WNDPROC totality (Property 16)
    - **Property 16: WNDPROC totality**
    - ∀ message triples (msg, wParam, lParam) from uint32 × int64 × int64, including throwing handlers: wrapper returns a safe integer and never throws
    - After `MAX_WNDPROC_FAULTS` faults, returns only `DefWindowProcW` results
    - **Validates: Requirements 9.2, 9.6**

  - [x] 2.3 Write property test for WNDPROC allowlist minimality (Property 17)
    - **Property 17: WNDPROC allowlist minimality**
    - ∀ msg ∉ allowlist: handler performs zero allocations and returns `null`
    - **Validates: Requirements 9.3**

  - [x] 2.4 Write property test for reentrancy guard (Property 18)
    - **Property 18: No reentrant WNDPROC dispatch**
    - ∀ message sequences causing `SetWindowPos` or `sendInputEvent` during handling: handler body never executes more than once simultaneously
    - **Validates: Requirements 9.4**

- [x] 3. Implement Stealth Host lifecycle
  - [x] 3.1 Create `electron/win32/hostWindow.ts` with `createStealthHost` and `StealthHost` lifecycle
    - Implement `randomClassName()` generating names matching `/^[A-Za-z][A-Za-z0-9_]{5,31}$/` with blocklist enforcement (no `chrome`, `electron`, `zule`, `overlay`, `widget` case-insensitive)
    - Implement `createStealthHost(opts)` following the algorithmic pseudocode: platform guard → getFfi → assert browser process → randomize class → register WNDPROC → RegisterClassExW → CreateWindowExW → apply stealth layers to host → SetWindowPos HWND_TOPMOST
    - Implement `getState()`, `create()`, `show()`, `hide()`, `reassert()`, `setBounds()`, `destroy()` on the StealthHost interface
    - Implement graceful failure at every step: ffi-load, register-class (with retry on `ERROR_CLASS_ALREADY_EXISTS`), create-window, wndproc — each returning Layer 0 with `failure.rolledBack = true`
    - Implement `destroy()`: DestroyWindow → UnregisterClassW → koffi.unregister ordering
    - Implement `onLost` callback on unexpected `WM_DESTROY`
    - _Requirements: 1.1, 1.4, 2.1, 3.1, 3.2, 3.4, 3.5, 6.3, 9.5, 10.1_

  - [x] 3.2 Write property test for class-name safety (Property 6)
    - **Property 6: Class-name safety**
    - ∀ generated seeds: `randomClassName()` matches format regex, contains no blocklisted substrings, and over 10000 seeds collision rate is 0
    - **Validates: Requirements 1.1, 1.4**

  - [x] 3.3 Write property test for no resource leaks on failure paths (Property 5)
    - **Property 5: No resource leaks on any failure path**
    - ∀ failure injection point: count of registered classes, HWNDs, koffi callbacks, DCs, DIB sections returns to pre-attempt value
    - Use fake FFI with observable counters
    - **Validates: Requirements 3.2, 6.3**

  - [x] 3.4 Write property test for teardown ordering (Property 22)
    - **Property 22: Teardown ordering**
    - ∀ destroy sequences: DestroyWindow precedes UnregisterClassW precedes koffi.unregister; release() precedes DestroyWindow when a child was adopted
    - **Validates: Requirements 6.3, 9.5, 3.2**

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement Stage A reparenting
  - [x] 5.1 Create `electron/win32/reparent.ts` with `adopt`, `release`, and `rollback` logic
    - Implement `adopt(hostHwnd, childHwnd)`: snapshot styles/rect → style fixup (clear `WS_POPUP`, set `WS_CHILD`, move `WS_EX_TOPMOST` to host) → `SetParent` → refit child to `(0, 0, clientWidth, clientHeight)` → run self-check → rollback on failure
    - Implement self-check: verify `GetParent`, `WS_CHILD` style, `enumTopLevelClassesForThisProcess` contains no `/Chrome_WidgetWin/` for our PID (excluding dashboard), display affinity on host
    - Implement `release()`: `SetParent(child, NULL)` → restore saved style/exStyle/rect → `applyNativeStealth(child)` → assert `GetParent(child) === NULL`
    - Implement `rollback(childHwnd, saved)` as documented in the pseudocode
    - Make `adopt` and `release` idempotent
    - _Requirements: 1.2, 1.3, 2.2, 2.3, 3.3, 3.4_

  - [x] 5.2 Write property test for reparenting idempotence (Property 1)
    - **Property 1: Reparenting idempotence**
    - ∀ host h, child c, n ≥ 1: adopt(h, c) applied n times yields same state as once, and exactly one SetParent call reaches FFI
    - **Validates: Requirements 1.2, 6.2**

  - [x] 5.3 Write property test for release/adopt round-trip fidelity (Property 2)
    - **Property 2: Release/adopt round-trip fidelity**
    - ∀ initial style s, exStyle e, rect r: adopt then release restores GWL_STYLE = s, GWL_EXSTYLE = e, rect = r exactly, GetParent(c) = NULL
    - **Validates: Requirements 3.3, 3.4**

  - [x] 5.4 Write property test for idempotent release (Property 3)
    - **Property 3: Idempotent release**
    - ∀ n ≥ 1: release() applied n times equals once; releasing a never-adopted host is a no-op
    - **Validates: Requirements 3.3, 3.5**

  - [x] 5.5 Write property test for graceful degradation (Property 4)
    - **Property 4: Graceful degradation — overlay always functional**
    - ∀ failure injection point: after failure the overlay BrowserWindow is still created, visible, at intended bounds, hostStrategy = 'none', failure.rolledBack = true
    - **Validates: Requirements 3.1, 3.4, 2.3, 2.6**

- [x] 6. Integrate Stealth Host into OverlayManager
  - [x] 6.1 Add `hostStrategy` to `OverlayState` and implement `attachStealthHost()` in `electron/overlayManager.ts`
    - Add `hostStrategy: HostStrategy` to `OverlayState` interface
    - Implement `attachStealthHost()` called after overlay creation: create host → adopt → handle failure gracefully
    - Route `resize`, `move`, `nudge`, `recenter`, `applySnap` through `host.setBounds()` when `hostStrategy !== 'none'`; through `window.setBounds()` at Layer 0
    - In `reparent` mode, refit child to `(0, 0, w, h)` in host-client coordinates after host setBounds
    - Route `show`, `hide`, `toggle` through the host when active, then call `reassert()`
    - _Requirements: 6.1, 6.2, 6.5, 4.3_

  - [x] 6.2 Implement stealth-toggle integration and teardown ordering
    - Update `setContentProtection(enabled)`: apply/remove stealth layers on whichever HWND is currently top-level (host or overlay), never destroy the host on toggle
    - Implement teardown in `destroy()`: `release()` → `destroy()` host → close BrowserWindow
    - Add `before-quit` handler for host teardown
    - Handle `display-removed`, `display-metrics-changed`, `display-added` events with `reassert()`
    - _Requirements: 5.1, 5.2, 5.3, 4.2, 4.3, 4.4, 6.3_

  - [x] 6.3 Write property test for stealth-state consistency across lifecycle cycles (Property 8)
    - **Property 8: Stealth-state consistency across lifecycle cycles**
    - ∀ sequences σ of {show, hide, toggle, resize, move, nudge, recenter, displayAdded, displayRemoved, displayMetricsChanged} length ≤ 20: if contentProtection = true then top-level HWND has display affinity, DWM cloak, and correct ex-styles; exactly one HWND owns stealth layers
    - **Validates: Requirements 4.1, 4.2, 4.3, 6.5**

  - [x] 6.4 Write property test for stealth toggle preserves topology (Property 9)
    - **Property 9: Stealth toggle preserves topology**
    - ∀ sequences of toggle-visibility-protection values: hostStrategy is invariant, hostHwnd unchanged, final layer state matches last toggle value
    - **Validates: Requirements 5.1, 5.2, 5.3**

  - [x] 6.5 Write property test for geometry equivalence with Layer 0 (Property 10)
    - **Property 10: Geometry equivalence with Layer 0**
    - ∀ bounds reachable through resize/move/nudge/recenter/snap: on-screen rect equals Layer 0 rect within 1 device pixel
    - **Validates: Requirements 6.1, 6.5**

  - [x] 6.6 Write property test for child fills host client area (Property 11)
    - **Property 11: Child fills host client area**
    - ∀ host bounds b: after setBounds(b) in reparent mode, child rect = (0, 0, clientWidth(b), clientHeight(b))
    - **Validates: Requirements 6.2**

- [x] 7. Checkpoint - Ensure all tests pass and Stage A is functional
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Create detection scanner harness
  - [x] 8.1 Create `electron/win32/enumScanner.ts` with `findChromiumTopLevelClasses`
    - Implement `EnumWindows` → `GetWindowThreadProcessId` → filter to PID → `GetClassName` → collect `/Chrome_WidgetWin/` matches
    - Register as a dev-only IPC handler in `electron/main.ts` for manual verification
    - Used by the self-check in adopt and by the spike report
    - _Requirements: 1.3, 1.5, 2.2_

- [x] 9. Implement Stage B rendering pipeline (gated on spike report)
  - [x] 9.1 Add lazy gdi32 sub-loading to `electron/win32/ffi.ts`
    - Load `gdi32.dll` lazily on first Stage B use
    - Declare Stage B bindings: `UpdateLayeredWindow`, `GetDC`, `ReleaseDC`, `SetCapture`, `ReleaseCapture`, `ScreenToClient`, `ClientToScreen`, `TrackMouseEvent`, `CreateCompatibleDC`, `CreateDIBSection`, `SelectObject`, `DeleteObject`, `DeleteDC`
    - Declare Stage B structs: `BITMAPINFOHEADER`, `BITMAPINFO`, `TRACKMOUSEEVENT`
    - _Requirements: 7.1, 10.4_

  - [x] 9.2 Create `electron/win32/layeredPaint.ts` with `PaintSurface` implementation
    - Implement `createPaintSurface(width, height)`: CreateCompatibleDC → CreateDIBSection with `biHeight = -height` (top-down) → wrap pixel pointer with `koffi.view()` for zero-copy Buffer
    - Implement `present(hostHwnd, screenX, screenY)`: stable `BLENDFUNCTION` allocation, `UpdateLayeredWindow` with `ULW_ALPHA` + `AC_SRC_ALPHA`
    - Implement `resize(width, height)`: allocate new DIB, keep previous on failure
    - Implement `dispose()`: DeleteObject bitmap → DeleteDC
    - Implement frame-size guard: drop frame when `buffer.length ≠ width * height * 4`
    - Implement circuit breaker: count consecutive `UpdateLayeredWindow` failures, request rollback past `MAX_PRESENT_FAILURES`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 9.3 Write property test for paint frame size safety (Property 19)
    - **Property 19: Paint frame size safety**
    - ∀ paint buffers b and surfaces s: copy occurs only when b.length = s.width * s.height * 4; otherwise frame dropped and previous surface unchanged; no write exceeds s.pixels.length
    - **Validates: Requirements 7.2, 7.1**

  - [x] 9.4 Write property test for present-failure circuit breaker (Property 20)
    - **Property 20: Present-failure circuit breaker monotonicity**
    - ∀ sequences of present results: rollback requested iff > MAX_PRESENT_FAILURES consecutive failures; any success resets counter
    - **Validates: Requirements 7.3**

- [x] 10. Implement Stage B input forwarding
  - [x] 10.1 Create `electron/win32/inputForwarder.ts` with coordinate conversion and event mapping
    - Implement `clientToCss(pt, scaleFactor)` and `cssToClient(pt, scaleFactor)` as pure functions
    - Implement `decodeMouseLParam(lParam)` with sign extension: `(lParam & 0xffff) << 16 >> 16`
    - Implement `decodeWheelDelta(wParam)`: extract signed HIWORD
    - Implement Win32 message → Electron `sendInputEvent` mapping for mouse move/down/up, wheel, keyboard, mouseleave
    - Implement hand-rolled drag via `DragController`: `SetCapture` on drag-zone `WM_LBUTTONDOWN`, `SetWindowPos` on `WM_MOUSEMOVE`, `ReleaseCapture` on `WM_LBUTTONUP`
    - Implement hit-test cache integration: empty cache → no drag zones (click-only, never un-clickable)
    - Implement `createInputForwarder(deps)` returning `WndProcHandlers`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [x] 10.2 Write property test for coordinate conversion round-trip (Property 12)
    - **Property 12: Coordinate conversion round-trip**
    - ∀ integer client points p with |p.x|,|p.y| ≤ 32767 and scale ∈ {1, 1.25, 1.5, 1.75, 2, 2.5, 3}: cssToClient(clientToCss(p, s), s) = p within 1 px, both monotonic
    - **Validates: Requirements 8.1, 8.3**

  - [x] 10.3 Write property test for lParam decoding sign-correctness (Property 13)
    - **Property 13: lParam decoding sign-correctness**
    - ∀ signed 16-bit pairs (x, y): decodeMouseLParam(pack(x, y)) = { x, y }; negative coordinates decode negative, never ≥ 32768
    - **Validates: Requirements 8.2**

  - [x] 10.4 Write property test for wheel delta decoding (Property 14)
    - **Property 14: Wheel delta decoding**
    - ∀ signed 16-bit d: decodeWheelDelta(pack(d)) has same sign as d and magnitude |d|; d=0 maps to 0
    - **Validates: Requirements 8.2, 8.6**

  - [x] 10.5 Write property test for forwarded events landing on intended element (Property 15)
    - **Property 15: Forwarded events land on intended element**
    - ∀ CSS rect r inside viewport and scale s: synthesized click at physical centre of r converts to CSS point inside r
    - **Validates: Requirements 8.1, 8.3**

- [x] 11. Implement Stage B OverlayManager integration
  - [x] 11.1 Integrate offscreen BrowserWindow + paint bridge into OverlayManager for Stage B
    - Create offscreen `BrowserWindow` with `offscreen: true` when `strategy === 'layered'`
    - Wire `paint` event to `PaintSurface.present()` via single `memcpy` of `image.getBitmap()`
    - Wire `WndProcHandlers` from `createInputForwarder` to the host's JS WNDPROC
    - Implement `useZoneDetector` no-op when main process reports `strategy === 'layered'`
    - Keep existing `-webkit-app-region` CSS rules in place for Layer 0 / Stage A compatibility
    - Handle DPI changes: refresh scaleFactor, resize paint surface, reassert stealth
    - _Requirements: 7.1, 8.4, 8.7, 2.4, 2.5_

- [x] 12. Checkpoint - Ensure all tests pass and both stages are functional
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Platform guard and non-Windows no-op
  - [x] 13.1 Implement and verify platform scope guards
    - Ensure `createStealthHost` returns `{ strategy: 'none' }` on non-win32 without loading koffi
    - Verify macOS stealth continues via `setContentProtection` → `NSWindowSharingNone` unchanged
    - Verify Linux no-op path with `CONTENT_PROTECTION_NOOP` notice unchanged
    - Verify no new runtime dependencies beyond koffi and four OS-provided DLLs
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 13.2 Write property test for non-Windows no-op (Property 21)
    - **Property 21: Non-Windows no-op**
    - ∀ API calls on platform ∈ {darwin, linux}: createStealthHost returns strategy='none' without loading koffi, no Win32 symbol resolved, overlay path byte-identical to today's
    - **Validates: Requirements 10.1, 10.2**

- [x] 14. Create spike report template and dev-only IPC
  - [x] 14.1 Create `docs/stealth-host-spike.md` template and wire dev-only scanner IPC
    - Create `docs/stealth-host-spike.md` with sections for each A1-A6 criterion (and B1-B5 if needed): Windows build tested, measurement performed, observed result, pass/fail
    - Wire `enumScanner.findChromiumTopLevelClasses` as a dev-only IPC handler in `electron/main.ts` for on-demand verification
    - Add `before-quit` handler in `electron/main.ts` for host teardown
    - _Requirements: 2.2, 2.4, 1.3_

- [x] 15. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
  - Verify existing test suites pass unmodified: `src/overlay/dualModeOverlay.preservation.test.ts`, `src/electron-tests/dualModeOverlay.bugcondition.test.ts`

### Stage C — Production-Disabled Implementation Plan

- [x] 16. Stage C1 — Pin the native supply chain and add fail-closed probes
  - [x] 16.1 Create the exact Stage C dependency lock and deterministic build inputs
    - Add the reviewed MSVC, MSBuild, Windows SDK, WebView2 SDK/loader, CI image digest, architecture, source, hash, license, transitive inventory, and review status under `native/stage-c/`; reject floating or unlisted dependencies.
    - Keep JavaScript development and Layer 0 usable when the native toolchain is absent; add no installer, downloader, or alternate compiler fallback.
    - _Requirements: 3.1, 3.2, 3.5–3.12, 14.16_

  - [x] 16.2 Implement the non-mutating Stage C toolchain probe and build-target guards
    - Add a script that reports `AVAILABLE` only for an exact lock match and otherwise reports `UNAVAILABLE` without changing the workstation.
    - Wire native build, package, and production-enable targets to fail closed while ordinary TypeScript and Layer 0 targets continue.
    - _Requirements: 3.3–3.6, 3.9, 3.12_

  - [x] 16.3 Implement the Electron prelaunch runtime probe
    - Add `electron/stageC/runtimeProbe.ts` to enforce the absolute three-second deadline, exact manifest/path/architecture/protocol/bridge/runtime/dependency checks, production signature/evidence/version checks, and diagnostic marker policy without spawning `ZuleUI.exe`.
    - Add Windows guards so non-Windows and native-boundary failures return typed content-free Layer 0 reasons without native loads.
    - _Requirements: 4.2–4.10, 16.1–16.7_

  - [x]* 16.4 Write the property test for probe failure side effects
    - **Property 3: Probe failure has no launch side effect**
    - Generate every probe failure/deadline point and assert zero spawn-count change, usable Layer 0, and a content-free typed reason.
    - **Validates: Requirements 4.3, 4.10**

  - [x]* 16.5 Validate Stage C1 with lock, probe, and build-guard tests
    - Add exact/missing/mismatched toolchain fixtures, production/diagnostic manifest fixtures, deadline tests, and non-mutating filesystem/process assertions; run the targeted Vitest suite and an unavailable-toolchain smoke target.
    - _Requirements: 3.1–3.12, 4.2–4.10, 16.1–16.7_

- [x] 17. Stage C2 — Build the truthful C++20 native shell and WebView2 availability path
  - [x] 17.1 Create the explicit MSVC C++20 `ZuleUI.vcxproj` and native process skeleton
    - Add x64 Win32 entry point, locked SDK/WebView2 references, system-library search policy, COM/resource lifetime scaffolding, and no managed, alternate-compiler, PATH-search, or runtime-download fallback.
    - Stamp `ZuleUI.exe` with stable Zule-owned version resources, including `OriginalFilename=ZuleUI.exe` and `CompanyName`/`ProductName=Zule AI`.
    - _Requirements: 2.1–2.3, 2.7–2.9, 3.7–3.12, 16.6_

  - [x] 17.2 Implement the hidden native `ZuleUIWindow` shell
    - Register exactly the stable `ZuleUIWindow` class and create one borderless, menu-less `WS_POPUP` floating surface with an empty title; require any other app-owned top-level sidecar window to have a non-empty `Zule` title.
    - Keep the surface hidden through startup and add deterministic cleanup of HWND, class, COM, and process resources.
    - _Requirements: 2.4–2.9, 5.8, 9.1, 13.3_

  - [x] 17.3 Add the native WebView2 runtime availability and minimum-version probe
    - Query the supported installed runtime without downloading it, return exact typed availability/version results, and fail initialization while retaining a hidden shell when unavailable or too old.
    - _Requirements: 4.4, 5.4–5.8, 14.16_

  - [x]* 17.4 Write the property test for stable truthful metadata
    - **Property 2: Stable truthful metadata**
    - Generate launch and diagnostic-window sequences and assert stable `ZuleUI.exe`/`ZuleUIWindow`/Zule resource identity, empty title only for the floating surface, and zero concealment or impersonation values.
    - **Validates: Requirements 2.1–2.9**

  - [x]* 17.5 Validate Stage C2 with native shell and metadata tests
    - Add a pinned-toolchain native test executable for metadata, title policy, one-surface ownership, hidden startup, WebView2 availability outcomes, system-library loading, and complete teardown.
    - _Requirements: 2.1–2.9, 3.7, 4.4, 5.8, 9.1, 16.6_

- [x] 18. Stage C3 — Render a static transparent DirectComposition capsule
  - [x] 18.1 Implement the WebView2 composition-controller and DirectComposition visual tree
    - Create the composition controller, attach it to the native visual tree, set default background alpha to zero, and render a bundled static capsule while keeping Stage C hidden until explicitly released.
    - _Requirements: 9.2–9.6, 9.8_

  - [x] 18.2 Implement resize, mode, hidden-surface, and composition cleanup semantics
    - Size the composition root and controller to the full client rect before presenting a resized frame; support static compact/expanded/maximized capsule layouts without service logic and release COM/graphics resources in deterministic order.
    - _Requirements: 9.7–9.9, 13.3_

  - [x]* 18.3 Add native alpha and composition unit tests
    - Verify zero alpha in declared transparent regions, premultiplied partial-alpha error at most one unit, controller/client bounds ordering, hidden-surface output, and failure cleanup.
    - _Requirements: 9.2–9.9_

  - [x]* 18.4 Add Windows composition integration tests
    - Capture compact, expanded, and maximized static capsule frames through the test harness and compare alpha masks at 100%, 125%, 150%, and 200% scaling.
    - _Requirements: 9.4–9.9, 17.8_

  - [x]* 18.5 Validate Stage C3 with the native and Windows composition suites
    - Build with the locked toolchain, run the native lifetime tests, and run the automated transparent-capsule capture suite without enabling production selection.
    - _Requirements: 3.7–3.9, 9.1–9.9, 17.8_

- [x] 19. Stage C4 — Create shared exact-schema protocol, manifest, projection, and telemetry models
  - [x] 19.1 Define one versioned canonical schema source and TypeScript models
    - Add exact schemas for manifest, protocol envelopes and directional payloads, handshake, overlay snapshots/patches, operation results, capture results, bootstrap metadata, bridge messages, status/failure reasons, and telemetry; reject unknown and duplicate fields.
    - _Requirements: 5.5–5.6, 6.13–6.21, 7.1–7.10, 8.1–8.10, 14.6–14.8, 15.1–15.12_

  - [x] 19.2 Generate or validate matching C++ protocol constants and model bindings
    - Produce deterministic C++ message/type/schema definitions from the canonical source and add a schema-version/hash parity check so TypeScript and native builds fail on drift.
    - _Requirements: 5.5–5.6, 6.14, 6.18–6.21, 7.4, 14.6_

  - [x] 19.3 Implement strict Stage C manifest serialization and validation
    - Bind final artifact paths/hashes, exact versions, architecture, protocol, bridge schema, WebView2 minimum, dependency-lock hash, capabilities, publisher, and evidence identifier; reject all schema or binding mismatches before probe use.
    - _Requirements: 4.4–4.9, 14.5–14.8_

  - [x] 19.4 Implement the content-free telemetry validator and sink adapter
    - Enforce the exact field allowlist, field/count/value/UTF-8/event-size bounds, canary-content exclusions, rejection-event subset, disabled-telemetry local routing, and noninterference on sink failure.
    - _Requirements: 15.1–15.14_

  - [x]* 19.5 Add cross-language schema conformance and round-trip tests
    - Exchange golden and mutated fixtures between TypeScript and the native test executable; verify semantic round trips, identical message identifiers/revisions, exact artifact bindings, and rejection of unknown, duplicate, missing, malformed, or oversized fields.
    - _Requirements: 6.13–6.21, 14.7–14.8, 15.1–15.10_

  - [x]* 19.6 Write the property test for exact-envelope validation
    - **Property 6: Exact-envelope validation**
    - Generate malformed encoding/JSON, oversize frames, unknown or reversed types, incompatible versions, missing/extra fields, and invalid payloads; assert zero dispatches and unchanged revisions.
    - **Validates: Requirements 6.13–6.21**

  - [x]* 19.7 Write the property test for telemetry exclusion and noninterference
    - **Property 21: Telemetry noninterference and content exclusion**
    - Generate unknown fields, bound overflows, prohibited canaries, and sink failures; assert rejected output contains no canary and supervision/fallback outcomes are unchanged.
    - **Validates: Requirements 15.1–15.14**

  - [x]* 19.8 Validate Stage C4 with schema, manifest, and telemetry suites
    - Run TypeScript property/unit tests plus the native conformance executable and fail on schema hash drift, noncanonical output, telemetry leakage, or manifest mismatch.
    - _Requirements: 6.13–6.21, 14.5–14.8, 15.1–15.14_

- [x] 20. Stage C5 — Implement authenticated named-pipe/bootstrap transport and hostile-input defenses
  - [x] 20.1 Implement the Electron named-pipe endpoint and one-shot bootstrap channel
    - Create a unique local-only pipe with current-logon/two-process ACLs, reject anonymous/network/Everyone/low-integrity access, generate independent cryptographic nonces and a 32-byte launch credential, and inherit only one bounded bootstrap handle.
    - Keep endpoint/credential material out of arguments, environment, renderer/WebView state, logs, crash annotations, and telemetry; close after one read and zero mutable buffers on best effort.
    - _Requirements: 6.1–6.8, 6.12_

  - [x] 20.2 Implement native mutual challenge-response authentication
    - Verify launch identifier, parent identity, challenge, nonce, and proofs before any non-authentication dispatch; enforce the two-second threshold event inside the absolute startup deadline and close invalid connections without effects.
    - _Requirements: 6.9–6.12_

  - [x] 20.3 Implement framed strict dispatch, directional allowlists, replay cache, and backpressure
    - Parse 32-bit little-endian lengths before allocation, cap frames/queues/cache, validate UTF-8/JSON/schema/version/revision/direction, cache terminal duplicate outcomes, and close/fallback on queue overflow.
    - Record only safe rejection metadata and preserve rejection/fallback when recording fails.
    - _Requirements: 6.13–6.27_

  - [x]* 20.4 Add hostile-input and endpoint-isolation integration tests
    - Automate wrong SID/integrity/parent, leaked-handle, altered/expired credential, malformed/reversed/oversized input, replay-cache 4,096/4,097, queue 256/257, and byte-limit boundary cases with zero state mutations and service calls.
    - _Requirements: 6.1–6.27, 17.11_

  - [x]* 20.5 Write the property test for authentication before effects
    - **Property 5: Authentication before effects**
    - Generate every noncurrent credential and altered launch/proof/challenge/nonce/parent combination; assert connection closure and unchanged canonical, surface, and service counters.
    - **Validates: Requirements 6.4, 6.9–6.12**

  - [x]* 20.6 Write the property test for replay idempotence
    - **Property 7: Replay idempotence**
    - Generate valid mutating messages and repetition counts greater than one; assert one mutation, one service invocation, stable state, and cached `duplicate-message` outcomes.
    - **Validates: Requirements 6.22–6.23**

  - [x]* 20.7 Validate Stage C5 with transport, hostile-input, and cleanup suites
    - Run cross-platform codec/auth state-machine tests and real-Windows ACL/bootstrap/native transport tests; verify no credential-bearing diagnostics and no owned handles after each case.
    - _Requirements: 6.1–6.27, 13.16, 17.11_

- [x] 21. Stage C6 — Load the packaged React overlay through a least-privilege bridge
  - [x] 21.1 Build a versioned Stage C React overlay entry from existing presentation components
    - Add a Stage C bootstrap/route that reuses current floating-overlay presentation semantics, consumes projection state only, and emits intents instead of importing Electron service/storage/capture/provider modules.
    - Package hashed overlay assets under the fixed Stage C resources path while retaining all Layer 0 assets.
    - _Requirements: 7.11–7.15, 8.1–8.7, 9.9, 14.1–14.2_

  - [x] 21.2 Implement the frozen `window.zuleOverlay` page adapter
    - Expose only the six reviewed methods and three reviewed events, enforce exact schemas and the 65,536-byte limit before posting, and trace every capability to a current `FloatingCopilot` caller.
    - Exclude unused capabilities and all native/general-purpose authority from production bundles.
    - _Requirements: 7.1–7.10_

  - [x] 21.3 Implement the authoritative native bridge and WebView2 content policy
    - Revalidate every page message natively; map methods/events one-to-one to allowed IPC messages; serve only the read-only packaged virtual origin; deny navigation, popups, downloads, permissions, external URIs, drops, and production developer/browser UI.
    - _Requirements: 7.4–7.15_

  - [x] 21.4 Implement the App Core intent and projection adapter
    - Route allowlisted overlay/AI/audio/screen-capture intents to existing Electron-owned services, update canonical state only after validation/execution, and project snapshots, patches, streams, and operation results without credentials, raw media, screenshot bytes, unrestricted paths, or database values.
    - _Requirements: 8.1–8.10_

  - [x]* 21.5 Write the property test for bridge authority
    - **Property 8: Bridge authority is a subset of the reviewed allowlist**
    - Generate unreviewed methods/events and capability-shaped payloads; assert zero filesystem, registry, shell, process, network, arbitrary IPC, pointer, COM, or native invocations.
    - **Validates: Requirements 7.1–7.10**

  - [x]* 21.6 Write the property test for App Core canonical ownership
    - **Property 9: App Core remains canonical**
    - Generate snapshot/patch/intent/disconnect/reconnect interleavings; assert only validated App Core intents advance canonical state and reconnect sends a complete snapshot before patches.
    - **Validates: Requirements 5.17–5.19, 8.1–8.10**

  - [x]* 21.7 Add packaged-overlay, bridge, and service-ownership integration tests
    - Test exact caller coverage, 65,536/65,537-byte boundaries, denied content operations, invalid native revalidation, projection redaction, stream/result routing, and absence of duplicate service pipelines.
    - _Requirements: 7.1–7.15, 8.1–8.10, 17.12_

  - [x]* 21.8 Validate Stage C6 with packaged React, bridge, and ownership suites
    - Build the Stage C web bundle, run adapter/unit tests, host it in the native sidecar test mode, and execute automated policy and App Core ownership assertions while production selection stays disabled.
    - _Requirements: 7.1–7.15, 8.1–8.10, 14.1, 17.12_

- [x] 22. Stage C7 — Implement native input, hit testing, drag, DPI, and multi-monitor geometry
  - [x] 22.1 Implement native pointer, wheel, keyboard, IME, and focus routing
    - Forward composition-controller input in client coordinates, preserve pointer order and exact signed wheel deltas, transfer focus through the pinned controller contract, and route printable/modifier/navigation/editing/accelerator/IME input without synthetic text injection.
    - _Requirements: 10.1–10.5_

  - [x] 22.2 Implement validated region maps, `WM_NCHITTEST`, and native drag
    - Validate revision/finite bounds/count/size, cache without synchronous renderer calls, enforce drag-over-click-through precedence and safe `HTCLIENT` default, use the Windows move loop, release capture, and report final DIP bounds.
    - Preserve existing Layer 0 `-webkit-app-region` CSS unchanged.
    - _Requirements: 10.6–10.16_

  - [x] 22.3 Implement edge-rounded DIP/physical conversion and topology recovery
    - Use signed per-monitor-DPI edge conversion; apply `WM_DPICHANGED` recommended bounds before rendering; update raster scale/composition/input/regions together; revalidate monitor topology; recenter only unreachable bounds and report typed degradation when recovery is impossible.
    - Match Layer 0 move/resize/nudge/recenter/snap/maximize/restore/show/hide/toggle target edges within one physical pixel.
    - _Requirements: 11.1–11.13_

  - [x]* 22.4 Write the property test for DPI conversion round trips
    - **Property 13: DPI conversion round trip**
    - Generate signed rectangles and scales 1, 1.25, 1.5, 1.75, 2, 2.5, and 3; assert monotonic independent-edge conversion and at most one-physical-pixel round-trip error.
    - **Validates: Requirements 11.3–11.6**

  - [x]* 22.5 Write the property test for hit-test precedence and safe defaults
    - **Property 14: Hit-test precedence and safe default**
    - Generate points and valid/stale/malformed/missing region maps; assert drag yields `HTCAPTION`, click-through without drag yields `HTTRANSPARENT`, and all other cases yield `HTCLIENT`.
    - **Validates: Requirements 10.6–10.12**

  - [x]* 22.6 Write the property test for input coordinate fidelity
    - **Property 15: Input coordinate fidelity**
    - Generate target rectangles, signed desktop coordinates, DPIs, and wheel deltas; assert target containment, at most one-pixel physical error, and exact wheel sign/magnitude.
    - **Validates: Requirements 10.1–10.5, 11.5–11.6**

  - [x]* 22.7 Add native and automated Windows input/geometry tests
    - Cover pointer ordering, click targets, keyboard/IME, both wheel axes, focus, overlap precedence, cancelled drags, capture release, negative coordinates, monitor crossing/removal/rotation/work-area changes, all required scales, and Layer 0 geometry parity.
    - _Requirements: 10.1–10.16, 11.1–11.13, 17.9–17.10_

  - [x]* 22.8 Validate Stage C7 with property, native, and Windows matrix suites
    - Run generated geometry/input tests and the real-Windows automated matrix; fail on misroute, retained capture, unreachable surface, CSS preservation change, or edge error above one pixel.
    - _Requirements: 10.1–10.16, 11.1–11.13, 17.9–17.10, 18.6_

- [x] 23. Stage C8 — Implement capture-protection read-back and toggle semantics
  - [x] 23.1 Implement native display-affinity application and bounded read-back
    - Map enabled to `WDA_EXCLUDEFROMCAPTURE` and disabled to `WDA_NONE`; read back within 100 ms; return typed application/read/mismatch/timeout results; reapply after create, recreate, show, and display migration.
    - _Requirements: 12.1–12.5, 12.10_

  - [x] 23.2 Implement controller capture fallback and Layer 0 parity
    - Hide/close Stage C first, apply and verify the same current value on Layer 0 before showing where possible, always restore Layer 0 usability within 500 ms, retain Dashboard ownership, and report typed degradation without capture-impossibility claims.
    - _Requirements: 12.6–12.12, 13.8–13.12_

  - [x]* 23.3 Write the property test for capture state following the user value
    - **Property 16: Capture state follows the user value**
    - Generate toggles, recreation, show, monitor migration, mismatch, and fallback sequences; assert visible-surface read-back equals the latest request and mismatched Stage C is never exposed.
    - **Validates: Requirements 12.1–12.10**

  - [x]* 23.4 Add automated Windows capture and failure-injection tests
    - Run 20 enable/disable cycles with native read-back, Electron desktop capture, and an external Windows Graphics Capture test recorder; inject apply/read/mismatch/timeout failures and measure Layer 0 recovery.
    - _Requirements: 12.1–12.12, 17.13–17.14_

  - [x]* 23.5 Validate Stage C8 with capture parity and fallback suites
    - Execute property/native/integration capture tests and fail on read-back over 100 ms, parity mismatch, recovery over 500 ms, duplicate visibility, or modification to Dashboard capture behavior.
    - _Requirements: 12.1–12.12, 13.8–13.12, 17.13–17.14_

- [x] 24. Stage C9 — Integrate `StageCController` while retaining warm Layer 0 and App Core ownership
  - [x] 24.1 Delete or hard-deny every Stage A/B runtime-selection path before Stage C integration
    - Remove Stage A/B from selectable strategy types and reject their build/runtime flags, environment variables, persisted values, retries, and fallback requests; report immutable historical statuses while allowing only `LAYER_0` or `STAGE_C`.
    - Keep historical source only if needed for diagnostics, but make it unreachable from production and diagnostic runtime selection.
    - _Requirements: 1.1–1.5, 17.25–17.26_

  - [x] 24.2 Add a non-rewriting `Layer0Adapter` and canonical projection owner
    - Wrap existing create/apply-state/bounds/capture/show/hide operations without changing Layer 0 source, assets, preload/main channels, Dashboard startup, lifecycle, Mode 2 behavior, geometry, capture logic, or drag CSS.
    - _Requirements: 1.6–1.8, 18.1–18.6, 18.9_

  - [x] 24.3 Implement `StageCController` probe, spawn, authentication, handshake, and synchronization phases
    - Show warm Layer 0 before probing; spawn exactly one absolute packaged sidecar without shell only after a successful probe; enforce one absolute three-second startup deadline; verify the ready handshake; send one full snapshot before patches; require matching ack and first frame in order.
    - Reuse pending/healthy sidecars and enforce snapshot/patch revision and reconnect rules.
    - _Requirements: 4.1–4.13, 5.1–5.19_

  - [x] 24.4 Implement single-surface cutover, crash/timeout fallback, retry, and shutdown ownership
    - Cut over only as `hide Layer 0 → show Stage C`; fall back only as `hide/close Stage C → restore Layer 0`; preserve canonical state; use one transition owner under timeout/disconnect/exit/capture races; enforce 500 ms recovery, one diagnostic retry, two-second graceful shutdown, credential invalidation, and orphan cleanup.
    - _Requirements: 5.20–5.25, 13.1–13.17_

  - [x] 24.5 Wire content-free Stage C status and telemetry into App Core diagnostics
    - Expose typed strategy/phase/failure/retry state locally, validate all events through the Stage C telemetry model, and keep telemetry failures noninterfering with protocol, supervision, and recovery.
    - _Requirements: 5.25, 15.1–15.14_

  - [x]* 24.6 Write the property test for strategy exclusion
    - **Property 1: Strategy exclusion**
    - Generate configuration, persisted, environment, failure, and retry sequences; assert only Layer 0/Stage C outputs and immutable failed-disabled Stage A / disabled-not-evaluated Stage B statuses.
    - **Validates: Requirements 1.1–1.5**

  - [x]* 24.7 Write the property test for one sidecar per App Core launch
    - **Property 4: Single sidecar per App Core launch**
    - Generate concurrent/repeated overlay requests and assert at most one pending or healthy process and one owned Stage C surface.
    - **Validates: Requirements 5.1–5.2**

  - [x]* 24.8 Write the property test for hidden-until-ready startup
    - **Property 10: Hidden-until-ready**
    - Generate startup event permutations and assert Stage C remains hidden until authenticated accepted handshake, matching snapshot acknowledgement, and first-transparent-frame readiness occur in order.
    - **Validates: Requirements 5.3–5.16, 13.3**

  - [x]* 24.9 Write the property test for at most one visible surface
    - **Property 11: At most one visible surface**
    - Generate cutover/fallback lifecycle sequences; assert visible-count at most one and strict hide-before-show ordering in each direction.
    - **Validates: Requirements 13.7–13.10**

  - [x]* 24.10 Write the property test for fallback state preservation
    - **Property 12: Fallback state preservation**
    - Generate every Stage C failure point and assert latest revision, visibility, DIP bounds, mode, and capture value survive with final `LAYER_0_ACTIVE` status and typed reason.
    - **Validates: Requirements 13.11–13.12**

  - [x]* 24.11 Write the property test for lifecycle teardown idempotence
    - **Property 17: Lifecycle teardown idempotence**
    - Generate repeated/interleaved stop, shutdown, disconnect, and exit notifications; assert endpoint close, credential invalidation, termination, and surface destruction occur at most once with no owned artifacts.
    - **Validates: Requirements 5.20–5.24, 13.16**

  - [x]* 24.12 Write the property test for failure-notification race safety
    - **Property 18: Failure notification race safety**
    - Generate timeout/disconnect/process-exit/capture notification orderings; assert exactly one transition owner and no mutation of the recovered Layer 0 state by late notifications.
    - **Validates: Requirements 13.13–13.14**

  - [x]* 24.13 Write the property test for non-Windows isolation
    - **Property 20: Non-Windows isolation**
    - Generate API sequences on macOS/Linux and assert zero Stage C probes, native loads, endpoints, runtime queries, or launches and unchanged platform Layer 0 behavior.
    - **Validates: Requirements 16.1–16.7**

  - [x]* 24.14 Write the property test for Layer 0 preservation without editing protected tests
    - **Property 22: Layer 0 preservation**
    - Add new preservation orchestration that runs and fingerprints `src/overlay/dualModeOverlay.preservation.test.ts` and `src/electron-tests/dualModeOverlay.bugcondition.test.ts` unchanged while comparing channels, Dashboard startup, lifecycle, Mode 2, CSS, geometry, and capture behavior.
    - **Validates: Requirements 18.1–18.9**

  - [x]* 24.15 Add Stage C controller integration and failure-injection tests
    - Cover every probe/startup/endpoint/auth/handshake/WebView2/bridge/composition/snapshot/frame/disconnect/timeout/crash failure, repeated requests, retry limit, normal shutdown, latest-value/coalescing rules, and App Core-only services.
    - _Requirements: 4.1–4.13, 5.1–5.25, 8.1–8.10, 13.1–13.17, 17.15–17.16, 17.22_

  - [x]* 24.16 Add explicit Stage A/B denial and protected-suite regression tests
    - Attempt historical strategy selection through every input surface and assert hard denial; run both protected test files byte-for-byte unchanged and reject any skip, rename, deletion, replacement, or weakened expectation.
    - _Requirements: 1.1–1.5, 18.7–18.9_

  - [x]* 24.17 Validate Stage C9 with controller, race, platform, and preservation suites
    - Run all Stage C state-machine/property/integration tests and the two protected suites; verify production Stage C remains disabled and Layer 0 stays usable for every unavailable, startup, failure, and recovery state.
    - _Requirements: 1.1–1.8, 4.1–4.13, 5.1–5.25, 13.1–13.17, 16.1–16.7, 18.1–18.9_

- [x] 25. Stage C10 — Integrate fixed-path packaging, signing, manifest generation, and atomic updates
  - [x] 25.1 Package the complete architecture-matched Stage C set while retaining Layer 0
    - Update release configuration to include signed `ZuleUI.exe`, final manifest, dependency lock, versioned overlay resources, and all Layer 0 source/runtime assets under fixed `process.resourcesPath` locations with no PATH/CWD lookup.
    - Keep truthful sidecar metadata independent from Electron executable metadata.
    - _Requirements: 14.1–14.4, 14.15–14.16, 18.1_

  - [x] 25.2 Generate and verify the final signed manifest after artifact finalization
    - Hash and bind final App Core/sidecar/resources/lock artifacts, versions, architecture, protocol, bridge schema, runtime minimum, publisher, signatures, and release-evidence identifier; fail package acceptance for invalid, unknown, offline, warning, indeterminate, or mismatched trust results.
    - _Requirements: 4.5–4.9, 14.4–14.8_

  - [x] 25.3 Integrate complete-set atomic staging, activation, and rollback
    - Stage and verify all artifacts as one transaction, activate only while App Core/sidecar are stopped, retain the installed set on validation failure, restore the prior verified set on activation failure, and make rollback independent of an older sidecar.
    - _Requirements: 14.9–14.14_

  - [x]* 25.4 Write the property test for package-set consistency
    - **Property 19: Package-set consistency**
    - Generate complete/partial/mismatched/unsigned/indeterminate package and update sets; assert Stage C eligibility only for one valid bound set with matching architecture and present Layer 0 assets.
    - **Validates: Requirements 14.1–14.15**

  - [x]* 25.5 Add packaging, signature, manifest, updater, and rollback integration tests
    - Test fixed-path resolution, architecture/version/hash/schema/lock/evidence bindings, publisher decisions, partial transactions, interrupted activation, prior-set restoration, sidecar-independent rollback, and permanent Layer 0 presence.
    - _Requirements: 4.5–4.9, 14.1–14.16, 17.19, 18.1_

  - [x]* 25.6 Validate Stage C10 with packaged-artifact and updater suites
    - Build a diagnostic package set, run offline artifact inspection and updater transaction tests, and assert production enablement still fails without matching approved release evidence.
    - _Requirements: 4.5–4.9, 14.1–14.16, 17.19, 17.23–17.26_

- [x] 26. Stage C11 — Build the release-gate harness and produce hash-bound real-Windows evidence
  - [x] 26.1 Implement the environment matrix, evidence schema, and fail-closed release decision
    - Enumerate Windows 10 22H2, supported Windows 11 23H2-or-newer builds, distributed architectures, and supported WebView2 versions; bind every result and raw summary to build/artifact hashes and reject missing rows, fields, measurements, or results.
    - _Requirements: 17.1–17.3, 17.23–17.26_

  - [x] 26.2 Implement automated metadata, honesty, runtime-probe, startup, and transparency gates
    - Encode exact launch counts, ordering, deadlines, p95, identity, observable-scope, wording, alpha, mode, and scale thresholds and archive machine-readable evidence.
    - _Requirements: 17.4–17.8_

  - [x] 26.3 Implement automated input, geometry, capture, capture-fallback, and lifecycle-fallback gates
    - Encode required click/key/IME/wheel/drag counts, scales/topologies, capture cycles/recorders, injected failure repetitions, one-visible-surface checks, and 100/500 ms budgets.
    - _Requirements: 17.9–17.10, 17.13–17.16_

  - [x] 26.4 Implement automated Local IPC and bridge security gates
    - Exercise every specified auth, credential, encoding, schema, direction, revision, frame/cache/queue boundary, unlisted bridge capability, and 65,537-byte case with zero state mutation/service/native effects.
    - _Requirements: 17.11–17.12_

  - [x] 26.5 Implement automated performance, stability, and state-update gates
    - Measure 30 FPS minimum, 50 ms p95 intent round trip, 10-minute update run, 60-minute soak, 100 start-stop cycles, process/window leaks, 50 MiB growth, bounded queues, revision-correlated acknowledgements, and safe coalescing.
    - _Requirements: 17.17–17.18, 17.22_

  - [x] 26.6 Implement automated packaging, updater, telemetry-privacy, and telemetry-schema gates
    - Inspect every production artifact/update set and inject unique prohibited-content canaries plus every field/count/event overflow, recording only exact-schema evidence.
    - _Requirements: 17.19–17.21_

  - [x] 26.7 Add real-Windows CI runners and immutable evidence assembly
    - Run each gate for every matrix row using the pinned image/toolchain, sign and archive evidence by build hash, and emit an approval identifier only when every result passes for every distributed artifact.
    - _Requirements: 3.10, 17.1–17.3, 17.23–17.24_

  - [x]* 26.8 Add release-decision and no-waiver tests
    - Generate omitted/failed/tampered rows and attempts to enable through flags, environment, persisted settings, remote content, or retries; assert production remains Layer 0 and diagnostic retries cannot waive gates.
    - _Requirements: 17.23–17.26_

  - [x]* 26.9 Validate Stage C11 and retain production-disabled status pending complete evidence
    - Execute the harness on every configured real-Windows row, verify immutable hash/signature/evidence bindings and all thresholds, rerun the protected Layer 0 suites unchanged, and leave production Stage C disabled unless the complete matrix passes.
    - _Requirements: 17.1–17.26, 18.7–18.9_

## Notes

- Tasks 1–15 are completed historical Stage A/B context only; they do not authorize either strategy for runtime use.
- Every Stage C task (16–26) is intentionally unchecked. Stage C remains production-disabled until Task 26 produces complete passing evidence bound to the final package hashes.
- Tasks marked with `*` are optional automated test tasks; each design correctness property has its own property-test leaf using `fast-check` 3.23.2 and `vitest` 3.2.4 where cross-platform modeling applies.
- Native implementation uses C++20/MSVC; Electron orchestration, models, tooling, React bridge, and cross-platform tests use TypeScript.
- `src/overlay/dualModeOverlay.preservation.test.ts` and `src/electron-tests/dualModeOverlay.bugcondition.test.ts` are protected and MUST remain byte-for-byte unchanged. New tests may invoke or fingerprint them but may not edit, rename, replace, skip, or weaken them.
- Stage A is `FAILED_DISABLED_A5_A6`; Stage B is `DISABLED_NOT_EVALUATED`. Task 24.1 hard-denies both before Stage C controller integration.
- Layer 0 remains packaged, warm during probe/startup, and the immediate fallback. Electron remains the sole canonical state and service owner.
- Stage validation is automated; real-Windows behavior and release evidence are produced by the gate harness rather than manual acceptance steps.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["16.1"] },
    { "id": 1, "tasks": ["16.2"] },
    { "id": 2, "tasks": ["16.3"] },
    { "id": 3, "tasks": ["16.4"] },
    { "id": 4, "tasks": ["16.5"] },
    { "id": 5, "tasks": ["17.1"] },
    { "id": 6, "tasks": ["17.2"] },
    { "id": 7, "tasks": ["17.3"] },
    { "id": 8, "tasks": ["17.4"] },
    { "id": 9, "tasks": ["17.5"] },
    { "id": 10, "tasks": ["18.1"] },
    { "id": 11, "tasks": ["18.2"] },
    { "id": 12, "tasks": ["18.3", "18.4"] },
    { "id": 13, "tasks": ["18.5"] },
    { "id": 14, "tasks": ["19.1"] },
    { "id": 15, "tasks": ["19.2", "19.3", "19.4"] },
    { "id": 16, "tasks": ["19.5", "19.6", "19.7"] },
    { "id": 17, "tasks": ["19.8"] },
    { "id": 18, "tasks": ["20.1", "20.2"] },
    { "id": 19, "tasks": ["20.3"] },
    { "id": 20, "tasks": ["20.4", "20.5", "20.6"] },
    { "id": 21, "tasks": ["20.7"] },
    { "id": 22, "tasks": ["21.1"] },
    { "id": 23, "tasks": ["21.2", "21.3", "21.4"] },
    { "id": 24, "tasks": ["21.5", "21.6", "21.7"] },
    { "id": 25, "tasks": ["21.8"] },
    { "id": 26, "tasks": ["22.1"] },
    { "id": 27, "tasks": ["22.2"] },
    { "id": 28, "tasks": ["22.3"] },
    { "id": 29, "tasks": ["22.4", "22.5", "22.6", "22.7"] },
    { "id": 30, "tasks": ["22.8"] },
    { "id": 31, "tasks": ["23.1"] },
    { "id": 32, "tasks": ["23.2"] },
    { "id": 33, "tasks": ["23.3", "23.4"] },
    { "id": 34, "tasks": ["23.5"] },
    { "id": 35, "tasks": ["24.1"] },
    { "id": 36, "tasks": ["24.2"] },
    { "id": 37, "tasks": ["24.3"] },
    { "id": 38, "tasks": ["24.4"] },
    { "id": 39, "tasks": ["24.5"] },
    { "id": 40, "tasks": ["24.6", "24.7", "24.8", "24.9", "24.10", "24.11", "24.12", "24.13", "24.14", "24.15", "24.16"] },
    { "id": 41, "tasks": ["24.17"] },
    { "id": 42, "tasks": ["25.1"] },
    { "id": 43, "tasks": ["25.2"] },
    { "id": 44, "tasks": ["25.3"] },
    { "id": 45, "tasks": ["25.4", "25.5"] },
    { "id": 46, "tasks": ["25.6"] },
    { "id": 47, "tasks": ["26.1"] },
    { "id": 48, "tasks": ["26.2", "26.3", "26.4", "26.5", "26.6"] },
    { "id": 49, "tasks": ["26.7"] },
    { "id": 50, "tasks": ["26.8"] },
    { "id": 51, "tasks": ["26.9"] }
  ]
}
```
