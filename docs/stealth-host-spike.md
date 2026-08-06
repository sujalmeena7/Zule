# Stealth Window Host — Spike Report

## Purpose

This document records per-criterion pass/fail results for the Stealth Window Host
two-stage decision gate. Stage B entry is gated on this report documenting that
Stage A has failed against unfixable criteria. The full gate targets at least one
Windows 10 22H2 and one Windows 11 23H2+ build; the remediation evidence below
comes from an actual Windows run whose exact build was not supplied.

---

## Stage A — HWND Reparenting

Stage A ships only if **all six** criteria pass.

---

### A1: Class-Name Concealment

| Field | Value |
|-------|-------|
| **Description** | `EnumWindows` → `GetWindowThreadProcessId` → filter to our PID → `GetClassName` returns no class matching `/Chrome_WidgetWin/` (excluding dashboard). |
| **Measurement** | Run `dev:scan-chromium-classes` IPC or `enumScanner.findChromiumTopLevelClasses()` from main process. |
| **Windows build tested** | _TODO_ |
| **Observed result** | _TODO_ |
| **Pass / Fail** | _TODO_ |

---

### A2: Per-Pixel Alpha Survives

| Field | Value |
|-------|-------|
| **Description** | Rounded capsule corners are transparent (alpha 0), not black or opaque grey. |
| **Measurement** | Temporarily disable `WDA_EXCLUDEFROMCAPTURE` on the host, screenshot the overlay region, sample ≥3 corner pixels per surface. |
| **Windows build tested** | _TODO_ |
| **Observed result** | _TODO_ |
| **Pass / Fail** | _TODO_ |

---

### A3: Backdrop-Filter Blur Still Renders

| Field | Value |
|-------|-------|
| **Description** | `backdrop-filter: blur()` renders correctly on the capsule (`blur(24px)`), pill (`blur(24px)`), and 480 px card (`blur(32px)`). |
| **Measurement** | Visual check against a high-contrast moving background. Blur must not be absent or render as a flat fill. |
| **Windows build tested** | _TODO_ |
| **Observed result** | _TODO_ |
| **Pass / Fail** | _TODO_ |

---

### A4: Capture Exclusion Still Holds

| Field | Value |
|-------|-------|
| **Description** | With host stealth applied, the overlay is absent from both `desktopCapturer` and external WGC recorder captures. |
| **Measurement** | Capture via Electron `desktopCapturer` and via an external Windows Graphics Capture recorder. Overlay content must not appear in either. |
| **Windows build tested** | _TODO_ |
| **Observed result** | _TODO_ |
| **Pass / Fail** | _TODO_ |

---

### A5: Interaction Model Intact

| Field | Value |
|-------|-------|
| **Description** | `-webkit-app-region: drag` moves the window; buttons click; `useZoneDetector` `setIgnoreMouseEvents` transitions work; keyboard input reaches input bar. |
| **Measurement** | Manual interaction testing: drag overlay, click buttons, verify click-through regions, type in input bar. |
| **Windows build tested** | Real Windows user environment; exact build not supplied. |
| **Observed result** | **Failed.** Host creation and `SetParent` completed (`Stealth host created: strategy=reparent class=Cx0tR4sEHC`; `Reparent succeeded`), but the visible overlay could not be dragged, pointer controls did not behave normally, and the input could not receive focus or keyboard text. Structural reparent success therefore did not prove interaction success. Chromium's app-region drag is implemented for its top-level widget; after `WS_CHILD` conversion it targets the child rather than moving the custom parent. The host also used `WS_EX_NOACTIVATE`, which is incompatible with click-to-focus input. |
| **Pass / Fail** | **FAIL — A5** |

---

### A6: Electron Window Ops Still Work

| Field | Value |
|-------|-------|
| **Description** | `resize()`, `move()`, `nudge()`, `recenter()`, `show()`, `hide()`, `toggle()` and `display-removed` recenter path produce correct geometry. Host tracks child within 1 device pixel. |
| **Measurement** | Exercise each operation; verify on-screen rect matches expected bounds. Check for tearing, off-screen placement, or oscillation between `setBounds` and `SetWindowPos`. |
| **Windows build tested** | Real Windows user environment; exact build not supplied. |
| **Observed result** | **Failed.** The visible overlay landed at the work-area upper-left and remained stuck there. Once Chromium becomes `WS_CHILD`, Electron's `getBounds()`/`setBounds()` contract is no longer a reliable screen-space source: child coordinates are parent-relative `(0, 0)`, while the custom host is the screen-space window. Existing calls to `showInactive`, `setAlwaysOnTop`, persistence, and geometry APIs still target the BrowserWindow and can conflict with host positioning. The observed placement disproves the prior model-only A6 assumption. |
| **Pass / Fail** | **FAIL — A6** |

---

## Stage A Summary

| Criterion | Result |
|-----------|--------|
| A1 — Class-name concealment | Not re-verified in this remediation |
| A2 — Per-pixel alpha | Not re-verified in this remediation |
| A3 — Backdrop-filter blur | Not re-verified in this remediation |
| A4 — Capture exclusion | Existing Layer 0 protection retained; Stage A result not claimed |
| A5 — Interaction model | **FAIL** |
| A6 — Electron window ops | **FAIL** |

**Stage A verdict: FAIL.** Stage A must not ship because two mandatory criteria failed on real Windows. Runtime selection is now fail-closed to Layer 0; a successful `SetParent` log is not treated as gate success.

### Layer 0 Fallback — Real-Windows Follow-up Evidence

The user manually verified that the fail-closed Layer 0 fallback works for work-area placement, pointer controls, focus and keyboard input, compact/expanded/maximized resizing, maximize/restore, the capture-protection toggle, and `WDA_EXCLUDEFROMCAPTURE` read-back. Logs also confirmed `UNCLOAK`, `DISALLOW_PEEK`, and `EXCLUDED_FROM_PEEK`, with no successful reparent topology.

One Layer 0 defect remained before the follow-up fix: dragging the floating copilot did not move the window. The renderer already provided a native-only `.mode-2-card-root` drag region with `no-drag` controls and scroll content, but the overlay `BrowserWindow` was constructed with `movable: false`. The remediation changed only that overlay constructor to `movable: true`. **Manual PASS after rebuilding/restarting on real Windows:** the user confirmed that dragging the intended drag surfaces moves the overlay away from its startup location, while the existing interactive controls remain usable. This evidence does not change the Stage A **FAIL** verdict, does not enable Stage B, and does not establish or claim undetectability.

---

## Stage B — Offscreen Render + UpdateLayeredWindow

> Stage A has a documented A5/A6 failure, but Stage B is **not enabled** by
> this remediation. Its live input/WNDPROC wiring is incomplete and B1-B5 have
> not passed. Enabling it requires an explicit implementation decision plus a
> completed Stage B gate; until then runtime selection remains Layer 0.

---

### B1: Class-Name Concealment

| Field | Value |
|-------|-------|
| **Description** | Same scanner as A1. Additionally, no Chromium HWND exists for the overlay at all (not even as a child). |
| **Measurement** | `enumScanner.findChromiumTopLevelClasses()` + `EnumChildWindows` on the host HWND. |
| **Windows build tested** | _TODO_ |
| **Observed result** | _TODO_ |
| **Pass / Fail** | _TODO_ |

---

### B2: Paint Throughput

| Field | Value |
|-------|-------|
| **Description** | Sustained ≥30 fps end-to-end (`paint` → `UpdateLayeredWindow`) while card is open with blur active, measured over 10 s. |
| **Measurement** | Frame counter in `present()` path; log timestamps over 10 s with card expanded. |
| **Windows build tested** | _TODO_ |
| **Observed result** | _TODO_ |
| **Pass / Fail** | _TODO_ |

---

### B3: Input Fidelity

| Field | Value |
|-------|-------|
| **Description** | Every forwarded click lands within 1 CSS px of the intended element across 100%, 125%, 150%, and 200% display scaling. Wheel scrolls, keyboard reaches input bar, hover states track cursor. |
| **Measurement** | Click targets at each DPI scale; verify hit-test accuracy via element highlighting or console logging of coordinates. |
| **Windows build tested** | _TODO_ |
| **Observed result** | _TODO_ |
| **Pass / Fail** | _TODO_ |

---

### B4: Hand-Rolled Drag

| Field | Value |
|-------|-------|
| **Description** | Dragging the capsule moves the host smoothly with no cursor drift; release stops the drag; drag never captures the cursor permanently. |
| **Measurement** | Manual drag testing; verify no drift, stuck capture, or dropped release across 20+ drag cycles. |
| **Windows build tested** | _TODO_ |
| **Observed result** | _TODO_ |
| **Pass / Fail** | _TODO_ |

---

### B5: Stability

| Field | Value |
|-------|-------|
| **Description** | 30 min soak with continuous mouse movement over the overlay: no main-process crash, no unbounded memory growth from DIB or callback churn. |
| **Measurement** | Run 30 min soak; monitor RSS via task manager or `process.memoryUsage()`. Acceptable: RSS growth < 50 MB over soak period. |
| **Windows build tested** | _TODO_ |
| **Observed result** | _TODO_ |
| **Pass / Fail** | _TODO_ |

---

## Stage B Summary

| Criterion | Result |
|-----------|--------|
| B1 — Class-name concealment | _TODO_ |
| B2 — Paint throughput | _TODO_ |
| B3 — Input fidelity | _TODO_ |
| B4 — Hand-rolled drag | _TODO_ |
| B5 — Stability | _TODO_ |

**Stage B verdict: NOT ENABLED / NOT EVALUATED.** The implementation gate remains closed; Layer 0 is retained.

---

## Conclusion

| Decision | Outcome |
|----------|---------|
| Stage shipped | **Layer 0** |
| Rationale | Real-Windows Stage A passed structural reparenting but failed mandatory A5 interaction and A6 geometry. Layer 0 preserves the supported Chromium top-level drag/focus model and existing capture exclusion. Stage B is neither explicitly approved nor gate-validated. |
| Date | Post-completion remediation |
| Tester | User-supplied real-Windows screenshot/log evidence; implementation review by Kiro |
| Electron version | Project dependency: `^42.4.0` |
| OS builds tested | Real Windows environment; exact build not supplied. Win10/Win11 cross-build gate remains outstanding. |

This report makes a narrow claim only: the attempted Stage A topology is not
reliable for this overlay architecture. It does not claim that Layer 0, Stage A,
or Stage B is undetectable.
