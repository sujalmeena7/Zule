# Implementation Plan: Auto-Updater

## Overview

Implement in-app update notifications and a one-click upgrade flow for the Zule AI Electron desktop application using `electron-updater`. The implementation adds a main-process auto-update service, extends the IPC bridge with six new methods, introduces two new React components (UpdateBanner, UpdateIndicator), a `useAutoUpdate` hook, and emits telemetry events through the existing telemetry module.

## Tasks

- [x] 1. Define types and interfaces
  - [x] 1.1 Add update-related types to `src/types/electron.d.ts`
    - Define `UpdateState`, `DownloadProgress`, and `UpdateError` interfaces
    - Extend the `ElectronAPI` interface with the six new optional methods: `checkForUpdate`, `downloadUpdate`, `cancelDownload`, `installUpdate`, `deferInstall`, `onUpdateState`
    - Ensure all methods have explicit parameter and return types
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_

  - [x] 1.2 Add telemetry event types to `src/brain/telemetry.ts`
    - Add five new `MetricEvent` variants to the discriminated union: `update.checked`, `update.available`, `update.downloaded`, `update.installed`, `update.error`
    - Each variant carries exactly the fields specified in the design (no forbidden fields)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

- [x] 2. Implement main-process auto-update service
  - [x] 2.1 Create `electron/autoUpdateService.ts` with state machine
    - Instantiate `electron-updater`'s `autoUpdater` with `autoDownload: false` and `autoInstallOnAppQuit: false`
    - Implement the finite state machine: idle → checking → available → downloading → ready → installing
    - Implement `isCandidateUpdate` function using SemVer 2.0.0 precedence comparison (including pre-release)
    - Implement `parseManifest` function that validates all four required fields (version, filename, size, hash)
    - Implement `verifyIntegrity` function for hash and size validation
    - Short-circuit all network calls in dev mode (`!app.isPackaged`)
    - Hold `deferredInstall` flag for "Install on next quit" flow
    - Implement progress event throttling (1–10 events per second)
    - Emit telemetry events for all lifecycle transitions
    - Ensure at most one background check per launch
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.3, 2.5, 2.6, 5.3, 8.4, 9.1–9.6_

  - [x] 2.2 Write property test for semver comparison (Property 1)
    - **Property 1: Semver comparison correctness**
    - Generate random semver triples (major.minor.patch[-prerelease]) and validate `isCandidateUpdate` returns true iff availableVersion > currentVersion
    - Test file: `electron/__tests__/semverCompare.test.ts`
    - **Validates: Requirements 1.6, 2.4, 4.9**

  - [x] 2.3 Write property test for manifest parsing (Property 2)
    - **Property 2: Manifest parsing completeness**
    - Generate random YAML with optional missing fields and validate parsing logic
    - Test file: `electron/__tests__/manifestParser.test.ts`
    - **Validates: Requirements 1.2, 1.3**

  - [x] 2.4 Write property test for integrity verification (Property 3)
    - **Property 3: Integrity verification rejects invalid artefacts**
    - Generate random byte arrays + hash/size pairs and validate verification
    - Test file: `electron/__tests__/integrityCheck.test.ts`
    - **Validates: Requirements 1.4, 1.5, 5.8, 8.3**

  - [x] 2.5 Write property test for single check per launch (Property 4)
    - **Property 4: At most one background check per launch**
    - Generate random event sequences and verify at most one `update.checked` event with `trigger: 'startup'`
    - Test file: `electron/__tests__/autoUpdateService.test.ts`
    - **Validates: Requirements 2.3**

  - [x] 2.6 Write property test for error recovery (Property 5)
    - **Property 5: Errors return to previous actionable state**
    - Generate random error types × states and verify state machine transitions
    - Test file: `electron/__tests__/autoUpdateService.test.ts`
    - **Validates: Requirements 2.7, 3.7, 5.7, 8.1, 8.2**

- [x] 3. Implement progress throttle and IPC fan-out
  - [x] 3.1 Create progress throttle utility in `electron/autoUpdateService.ts`
    - Throttle raw electron-updater progress events to 1–10 per second
    - Ensure at least one event per 1000ms while download is active
    - _Requirements: 5.3, 10.7_

  - [x] 3.2 Implement IPC fan-out delivery in `electron/main.ts`
    - Broadcast state transitions and progress events to both Dashboard and Overlay windows
    - Skip destroyed windows silently without throwing
    - _Requirements: 10.6, 10.8_

  - [x] 3.3 Write property test for progress throttle (Property 11)
    - **Property 11: Progress throttle respects frequency bounds**
    - Generate random event streams with timestamps, validate output rate bounds
    - Test file: `electron/__tests__/progressThrottle.test.ts`
    - **Validates: Requirements 5.3, 10.7**

  - [x] 3.4 Write property test for fan-out delivery (Property 12)
    - **Property 12: Event delivery fan-out correctness**
    - Generate random window destruction combinations, validate delivery correctness
    - Test file: `electron/__tests__/ipcFanOut.test.ts`
    - **Validates: Requirements 10.6, 10.8**

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Extend preload bridge and register IPC handlers
  - [x] 5.1 Add IPC channel handlers to `electron/main.ts`
    - Register `ipcMain.handle` for `update:check`, `update:download`, `update:cancel`, `update:install`, `update:defer`
    - Register `ipcMain.on` pattern for `update:state` subscription
    - Lazy-load `autoUpdateService` after Dashboard's `did-finish-load` event
    - Register no-op handlers that reject with typed error if service fails to init
    - _Requirements: 2.1, 2.2, 8.4, 10.2, 10.3, 10.4, 10.5, 10.6, 11.5_

  - [x] 5.2 Extend `electron/preload.ts` with six new methods
    - Add `checkForUpdate`, `downloadUpdate`, `cancelDownload`, `installUpdate`, `deferInstall`, `onUpdateState` to the `contextBridge.exposeInMainWorld` call
    - Follow existing invoke/on pattern from the preload file
    - `onUpdateState` returns an unsubscribe function following the same pattern as `onSyncMessage`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

- [x] 6. Implement persistence and shutdown logic
  - [x] 6.1 Implement `update-state.json` persistence in `electron/autoUpdateService.ts`
    - Write persisted state on successful download + "Install on next quit"
    - Read on `app.before-quit` to decide whether to launch installer (user-initiated quit only)
    - Delete after successful install (detected by version comparison on next launch)
    - Do not consume deferred install after abnormal termination
    - _Requirements: 6.3, 6.4, 6.6, 9.4_

  - [x] 6.2 Implement graceful shutdown handling
    - On `app.before-quit`: abort any in-progress download within 2s, discard partial bytes
    - If `deferredInstall` flag is set and quit is user-initiated, call `autoUpdater.quitAndInstall(true, true)`
    - _Requirements: 8.5, 6.4_

- [x] 7. Implement `useAutoUpdate` React hook
  - [x] 7.1 Create `src/hooks/useAutoUpdate.ts`
    - Subscribe to `window.electronAPI.onUpdateState` on mount, unsubscribe on unmount
    - Expose current `UpdateState` plus action dispatchers: `check`, `download`, `cancel`, `install`, `defer`, `dismiss`
    - Track `dismissed: boolean` local state that hides banner until next app restart
    - Handle graceful fallback when `window.electronAPI` methods are unavailable
    - _Requirements: 4.7, 4.8, 10.6, 11.5_

  - [x] 7.2 Write property test for progress display computation (Property 8)
    - **Property 8: Progress display computation**
    - Generate random (bytesReceived, totalBytes) pairs and validate computed display values
    - Test file: `src/hooks/__tests__/useAutoUpdate.test.ts`
    - **Validates: Requirements 5.2**

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement UpdateBanner component
  - [x] 9.1 Create `src/components/UpdateBanner.tsx` and `src/components/UpdateBanner.css`
    - Render conditionally when state is `available`, `downloading`, or `ready`
    - Display Available_Version and Current_Version using `pill` class badges
    - Render Release_Notes as Markdown using `react-markdown` + `remark-gfm`, truncated at 20,000 chars with expand control
    - Show placeholder text when release notes unavailable
    - Use `glass-card` container class
    - Render in normal document flow (not position: fixed) so it pushes content down
    - Add `aria-live="polite"` for screen-reader announcements
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.10_

  - [x] 9.2 Implement action buttons and download progress UI in UpdateBanner
    - "Update now" primary action and "Later" secondary action in `available` state
    - "Cancel" action replacing "Update now" during `downloading` state
    - Progress bar showing integer percent, MB received (1 decimal), MB total (1 decimal)
    - "Restart and install" primary and "Install on next quit" secondary in `ready` state
    - Disable all actions during `checking`, `downloading`, `installing` states
    - All actions reachable via keyboard focus and pointer input
    - Display single failure indication inline when errors occur
    - _Requirements: 4.6, 5.1, 5.2, 5.4, 5.5, 5.6, 5.7, 5.8, 6.1, 6.2, 6.3, 6.5, 6.7, 8.2_

  - [x] 9.3 Write property test for control disabling (Property 6)
    - **Property 6: Non-actionable states disable user controls**
    - Generate random update states and verify controls are non-interactive in {checking, downloading, installing}
    - Test file: `src/components/__tests__/UpdateBanner.test.ts`
    - **Validates: Requirements 3.3, 6.7**

  - [x] 9.4 Write property test for banner content (Property 7)
    - **Property 7: Banner renders complete update information**
    - Generate random (availableVersion, currentVersion, releaseNotes) triples and verify rendered content
    - Test file: `src/components/__tests__/UpdateBanner.test.ts`
    - **Validates: Requirements 4.2, 4.3, 4.4**

- [x] 10. Implement UpdateIndicator and Settings extension
  - [x] 10.1 Create `src/components/UpdateIndicator.tsx`
    - 8px green dot, `pointer-events: none`, `border-radius: 50%`
    - Render only when `state.status === 'ready'`
    - Positioned within overlay's existing layout, no change to outer bounds
    - Appears/disappears within 1000ms of ready ↔ non-ready transition
    - Add `aria-label="Update ready to install"`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [x] 10.2 Extend `src/components/Settings.tsx` with update section
    - Add "Check for updates" button with `Version X.Y.Z` label
    - Disable button while `status === 'checking' || status === 'downloading'`
    - Show "You're up to date" confirmation for 5 seconds when no update found
    - Show single failure-category message on error, re-enable button
    - Re-enable button within 1 second of check completion
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 11. Wire components into application layout
  - [x] 11.1 Integrate UpdateBanner into Dashboard layout
    - Import and render `UpdateBanner` at the top of Dashboard component
    - Connect to `useAutoUpdate` hook
    - Ensure banner does not block interaction with other Dashboard controls
    - _Requirements: 4.1, 4.10_

  - [x] 11.2 Integrate UpdateIndicator into OverlayShell
    - Import and render `UpdateIndicator` in `src/components/OverlayShell.tsx`
    - Connect to update state via IPC bridge
    - Ensure overlay outer position, bounds, and size remain unchanged
    - _Requirements: 7.1, 7.3, 11.3_

- [x] 12. Implement telemetry emission and validation
  - [x] 12.1 Wire telemetry events from autoUpdateService to telemetry module
    - Emit `update.checked` on check initiation with currentVersion and trigger
    - Emit `update.available` when candidate version identified
    - Emit `update.downloaded` on successful download with duration
    - Emit `update.installed` on next launch when version matches
    - Emit `update.error` on any failure with stage and category
    - Forward events from main process to renderer telemetry sink via existing IPC pattern
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 12.2 Write property test for telemetry schema (Property 9)
    - **Property 9: Telemetry events conform to schema**
    - Generate random telemetry events and validate structure matches spec
    - Test file: `electron/__tests__/updateTelemetry.test.ts`
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.5**

  - [x] 12.3 Write property test for forbidden telemetry fields (Property 10)
    - **Property 10: Telemetry events contain no forbidden fields**
    - Generate random telemetry events and verify no OS user name, machine ID, network address, file path, or release notes body present
    - Test file: `electron/__tests__/updateTelemetry.test.ts`
    - **Validates: Requirements 9.6**

- [x] 13. Final checkpoint - Ensure all tests pass and no regressions
  - Ensure all tests pass, ask the user if questions arise.
  - Verify existing test suites under `src/brain`, `src/data`, `src/components`, `src/hooks` pass unchanged
  - Verify TypeScript compilation succeeds with the extended `ElectronAPI` interface
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The project uses `vitest --run` for test execution and `fast-check` 3.23.2 for property-based tests
- `react-markdown` and `remark-gfm` are already in dependencies
- All new IPC methods follow the existing `contextBridge` pattern in `electron/preload.ts`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "5.2"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "2.6", "3.1"] },
    { "id": 3, "tasks": ["3.2", "3.3", "3.4", "6.1", "6.2"] },
    { "id": 4, "tasks": ["5.1", "7.1"] },
    { "id": 5, "tasks": ["7.2", "9.1"] },
    { "id": 6, "tasks": ["9.2", "9.3", "9.4", "10.1", "10.2"] },
    { "id": 7, "tasks": ["11.1", "11.2", "12.1"] },
    { "id": 8, "tasks": ["12.2", "12.3"] }
  ]
}
```
