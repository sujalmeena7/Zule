# Bugfix Requirements Document

## Introduction

After the first hide/show toggle cycle, overlay buttons become unresponsive (hover works but clicks do not fire) when Invisibility Mode (content protection + native stealth) is active. The issue is a hit-test invalidation caused by `reapplyPlatformState()` redundantly calling `applyNativeStealth()` during `show()`, which writes `WS_EX_NOACTIVATE` via `SetWindowLongPtrW` + `SWP_FRAMECHANGED`. On the first cycle the styles differ from what Windows currently has cached, triggering a frame re-evaluation that invalidates Chromium's hit-test regions. Subsequent cycles are fine because the styles are already applied (no-op path). The bug does not reproduce when stealth mode is off because `reapplyPlatformState()` skips the native stealth branch entirely.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the overlay is hidden and then shown for the FIRST time in a session with content protection enabled THEN the system renders the overlay visually but buttons do not respond to click events (hit-test failure)

1.2 WHEN the overlay buttons are in the unresponsive state THEN the system still shows CSS hover effects on pointer-over, confirming the window receives WM_MOUSEMOVE but not WM_LBUTTONDOWN at the correct hit-test coordinates

1.3 WHEN `reapplyPlatformState()` is called during `show()` with content protection active THEN the system calls `applyNativeStealth()` which invokes `SetWindowLongPtrW(GWL_EXSTYLE)` followed by `SetWindowPos(SWP_FRAMECHANGED)`, invalidating Chromium's compositor hit-test cache before it can process the restored mouse event forwarding

### Expected Behavior (Correct)

2.1 WHEN the overlay is hidden and then shown for the FIRST time in a session with content protection enabled THEN the system SHALL render the overlay with fully functional click handling on all buttons immediately after show completes

2.2 WHEN the overlay is shown after any hide/show cycle with content protection enabled THEN the system SHALL maintain valid hit-test regions such that pointer clicks are correctly dispatched to the target DOM elements

2.3 WHEN `show()` is called and native stealth layers are already applied from window creation THEN the system SHALL NOT redundantly re-apply `SetWindowLongPtrW(GWL_EXSTYLE)` + `SWP_FRAMECHANGED` during the same show operation, avoiding hit-test cache invalidation

### Unchanged Behavior (Regression Prevention)

3.1 WHEN content protection is disabled and the overlay is toggled hidden/shown THEN the system SHALL CONTINUE TO show and hide the overlay with full button interactivity on all cycles

3.2 WHEN the overlay is first created with content protection enabled THEN the system SHALL CONTINUE TO apply all native stealth layers (WDA_EXCLUDEFROMCAPTURE, DWM cloaking, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW) during initial window setup

3.3 WHEN a display change event occurs (monitor added/removed, DPI change) with content protection enabled THEN the system SHALL CONTINUE TO re-apply platform state including native stealth layers to maintain capture exclusion

3.4 WHEN the overlay is shown on the second or subsequent hide/show cycles with content protection enabled THEN the system SHALL CONTINUE TO function correctly with responsive buttons (preserving current working behavior on non-first cycles)

3.5 WHEN the user toggles content protection on or off via the settings UI THEN the system SHALL CONTINUE TO apply or remove native stealth layers as appropriate
