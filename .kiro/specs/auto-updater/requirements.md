# Requirements Document

## Introduction

This feature adds in-app update notifications and a one-click upgrade
flow to the Zule AI Electron desktop application, bringing the
experience in line with the auto-update affordances users expect from
mature professional desktop apps.

The Electron build already produces the artefacts the platform's
auto-update mechanism consumes — `release\ZuleAI-setup.exe`,
`release\ZuleAI-setup.exe.blockmap`, and `release\latest.yml` — and the
`electron-builder.yml` `publish` block is already configured to publish
to GitHub Releases at `zule-ai/zule`. This feature consumes those
artefacts: the running application discovers a newer release, downloads
the installer and blockmap in the background, surfaces the new version
plus its changelog inside the running UI, and offers a one-click
"Restart and install" action.

The feature is bounded by three architectural constraints already
established in the codebase:

1. **Offline-first.** The application MUST remain fully usable when
   the update channel is unreachable. Update failures are silent,
   non-blocking, and never visible to the user as errors.
2. **Renderer/main split via `contextBridge`.** New IPC channels
   follow the existing pattern in `electron/preload.ts`
   (`contextBridge.exposeInMainWorld('electronAPI', { ... })`) and are
   typed in `src/types/electron.d.ts`.
3. **Established design language.** The in-app update notification
   uses the existing `glass-card` and `pill` styles seen in
   `src/components/Settings.tsx`; it is an in-app banner, not a native
   OS dialog.

The feature is in scope for the Windows NSIS build (the only platform
currently produced by the build pipeline) and is bounded by the
dashboard and overlay windows already managed by `electron/overlayManager.ts`.

## Glossary

- **Auto_Updater**: The main-process subsystem responsible for
  contacting the Update_Source, downloading the installer and
  blockmap, verifying integrity, and triggering the installer on
  application restart.
- **Update_Source**: The GitHub Releases channel for the
  `zule-ai/zule` repository, hosting `latest.yml`, the
  `ZuleAI-setup.exe` installer, and its `.blockmap` companion. This is
  the only channel through which the Auto_Updater discovers and
  downloads updates.
- **Latest_Release_Manifest**: The `latest.yml` document published
  alongside each GitHub Release, carrying the version, artefact
  filename, file size, and per-artefact integrity hash that the
  Auto_Updater consumes.
- **Update_Notification_UI**: The React component rendered inside the
  Dashboard_Window that surfaces the update state — available,
  downloading, ready to install, dismissed — to the user.
- **Update_Banner**: The visual presentation of the
  Update_Notification_UI in its "available" and "ready to install"
  states. Uses the existing `glass-card` and `pill` styles.
- **Update_Indicator**: A subtle visual marker rendered on the
  Overlay_Window that indicates an update is ready to install,
  without blocking the overlay's primary copilot affordances.
- **Dashboard_Window**: The primary Electron BrowserWindow that hosts
  the React application's main UI surface.
- **Overlay_Window**: The floating, frameless, always-on-top
  Electron BrowserWindow managed by `electron/overlayManager.ts`.
- **Settings_Module**: The Settings page in `src/components/Settings.tsx`
  and the persisted `settings` IndexedDB store backing it.
- **IPC_Bridge**: The contextBridge surface defined in
  `electron/preload.ts` and exposed to the renderer as
  `window.electronAPI`, typed in `src/types/electron.d.ts`.
- **Telemetry_Module**: The existing telemetry sink in
  `src/brain/telemetry.ts` that records typed `MetricEvent` rows to
  the local `STORE_TELEMETRY` IndexedDB store.
- **Current_Version**: The semantic version string of the currently
  running application, sourced from the `version` field of the
  packaged `package.json`.
- **Available_Version**: The semantic version string carried in the
  Latest_Release_Manifest as the highest published release on the
  Update_Source.
- **Release_Notes**: The Markdown body associated with a published
  GitHub Release, intended to be rendered as the user-visible
  changelog inside the Update_Banner.

## Requirements

### Requirement 1: Update Source and Authoritative Channel

**User Story:** As a Zule developer, I want the application to consume
updates from a single authoritative channel, so that release artefacts
and integrity guarantees are aligned with the existing publish
configuration.

#### Acceptance Criteria

1. THE Auto_Updater SHALL discover candidate updates, fetch the
   Latest_Release_Manifest, and download installer artefacts
   exclusively over network requests addressed to the Update_Source.
2. WHEN the Auto_Updater fetches the Latest_Release_Manifest, THE
   Auto_Updater SHALL complete the fetch within 30 seconds and SHALL
   parse the manifest's version, artefact filename, file size in
   bytes, and per-artefact integrity hash before initiating any
   download.
3. IF the Latest_Release_Manifest cannot be fetched within 30
   seconds, cannot be parsed, or is missing any of the version,
   artefact filename, file size, or integrity hash fields, THEN THE
   Auto_Updater SHALL abandon the update attempt and SHALL NOT
   initiate any installer download until the next user-initiated
   check or the next application launch.
4. IF the integrity hash recorded in the Latest_Release_Manifest
   does not match the hash computed over the downloaded installer,
   THEN THE Auto_Updater SHALL delete the downloaded installer and
   its companion blockmap from local storage and SHALL NOT stage the
   installer for execution.
5. IF the byte length of the downloaded installer does not equal the
   file size in bytes recorded in the Latest_Release_Manifest, THEN
   THE Auto_Updater SHALL delete the downloaded installer and its
   companion blockmap from local storage and SHALL NOT stage the
   installer for execution.
6. THE Auto_Updater SHALL treat the Available_Version as a candidate
   update only when the Available_Version is strictly greater than
   the Current_Version under Semantic Versioning 2.0.0 precedence
   rules, including pre-release identifier comparison.

### Requirement 2: Background Update Check on Application Startup

**User Story:** As a Zule user, I want the application to find new
versions on its own, so that I do not have to remember to look for
updates.

#### Acceptance Criteria

1. WHEN the Dashboard_Window has finished loading the React
   application, THE Auto_Updater SHALL initiate a background update
   check against the Update_Source within 5 seconds.
2. THE background update check SHALL NOT delay the Dashboard_Window's
   first interactive frame by more than 100 milliseconds beyond the
   no-update-check baseline.
3. THE Auto_Updater SHALL perform at most one background update check
   per application launch.
4. IF the background update check determines that the
   Available_Version is equal to or lower than the Current_Version,
   THEN THE Auto_Updater SHALL NOT surface a notification, dialog,
   badge, or status indicator on the Dashboard_Window or the
   Overlay_Window.
5. WHILE a packaged release build of the application is running, THE
   Auto_Updater SHALL be eligible to perform background update
   checks.
6. IF the running application is not a packaged release build, THEN
   THE Auto_Updater SHALL NOT contact the Update_Source.
7. IF the background update check fails to receive a response from
   the Update_Source within 30 seconds or encounters a network
   error, THEN THE Auto_Updater SHALL silently abort the check, SHALL
   NOT surface a user-visible error, and SHALL leave the
   Update_Notification_UI in its `idle` state.

### Requirement 3: Manual Update Check from Settings

**User Story:** As a Zule user, I want a button to check for updates
on demand, so that I can confirm I am running the most recent version
without waiting for the next launch.

#### Acceptance Criteria

1. THE Settings_Module SHALL expose a "Check for updates" control
   together with a text label that displays the Current_Version in
   the format `Version X.Y.Z`.
2. WHEN the user activates the "Check for updates" control, THE
   Auto_Updater SHALL initiate an update check against the
   Update_Source within 1 second of the activation and SHALL
   complete the check within 30 seconds.
3. WHILE an update check or download initiated by the
   Settings_Module is in progress, THE Settings_Module SHALL render
   the "Check for updates" control as non-interactive, rejecting
   both pointer and keyboard activation.
4. WHEN a user-initiated update check completes, THE Settings_Module
   SHALL re-enable the "Check for updates" control within 1 second
   of completion.
5. WHEN a user-initiated update check determines that the
   Available_Version is equal to or lower than the Current_Version,
   THE Settings_Module SHALL display an "up to date" confirmation
   message that remains visible for at least 5 seconds.
6. WHEN a user-initiated update check determines that the
   Available_Version is strictly greater than the Current_Version,
   THE Update_Notification_UI SHALL transition to its "available"
   state on the Dashboard_Window within 2 seconds of the check
   completing.
7. IF a user-initiated update check fails to receive a response from
   the Update_Source within 30 seconds or encounters a network
   error, THEN THE Settings_Module SHALL re-enable the "Check for
   updates" control, SHALL display a single failure message
   describing the failure category, and SHALL leave the
   Update_Notification_UI in its previous state.

### Requirement 4: In-App Update Banner on the Dashboard

**User Story:** As a Zule user, I want to see what is in a new
version inside the app, so that I can decide whether and when to
install it without leaving the app.

#### Acceptance Criteria

1. WHEN the Auto_Updater identifies a candidate Available_Version
   that is strictly greater than the Current_Version, THE
   Update_Notification_UI SHALL render the Update_Banner inside the
   Dashboard_Window within 2 seconds of the identification event.
2. WHILE the Update_Banner is visible, THE Update_Banner SHALL
   display the Available_Version, the Current_Version, and the
   Release_Notes associated with the Available_Version.
3. THE Update_Banner SHALL render the Release_Notes as formatted
   Markdown, with the rendered content truncated at a maximum of
   20,000 characters and an expand control surfaced whenever the
   source exceeds this limit.
4. IF the Release_Notes for the Available_Version are unavailable or
   empty when the Update_Banner is rendered, THEN THE Update_Banner
   SHALL display placeholder text indicating that release notes are
   not available and SHALL still expose the "Update now" and "Later"
   actions.
5. THE Update_Banner SHALL use the existing `glass-card` and `pill`
   visual styles defined in the renderer's stylesheet.
6. THE Update_Banner SHALL expose a primary action labelled "Update
   now" and a secondary action labelled "Later", with both actions
   reachable and activatable via keyboard focus and pointer input.
7. WHEN the user activates the secondary "Later" action, THE
   Update_Notification_UI SHALL hide the Update_Banner within 500
   milliseconds and SHALL keep it hidden until the application is
   restarted.
8. WHEN the application launches after the user previously activated
   the "Later" action, THE Update_Notification_UI SHALL re-evaluate
   the deferred candidate Available_Version against the
   Current_Version.
9. IF, at re-evaluation on application launch, the deferred
   Available_Version is strictly greater than the Current_Version,
   THEN THE Update_Notification_UI SHALL render the Update_Banner
   inside the Dashboard_Window.
10. THE Update_Banner SHALL NOT block keyboard or pointer
    interaction with Dashboard_Window controls located outside the
    Update_Banner's bounding rectangle.

### Requirement 5: Update Download Lifecycle and Progress

**User Story:** As a Zule user, I want to see how much of the update
has been downloaded, so that I know whether the download is making
progress and roughly when it will be ready to install.

#### Acceptance Criteria

1. WHEN the user activates the primary "Update now" action on the
   Update_Banner, THE Auto_Updater SHALL begin downloading the
   installer artefact for the Available_Version from the
   Update_Source.
2. WHILE the installer download is in progress, THE Update_Banner
   SHALL display the integer percent of bytes received in the closed
   range `[0, 100]`, the bytes received in megabytes rounded to one
   decimal place, and the total download size in megabytes rounded
   to one decimal place.
3. WHILE the installer download is in progress, THE Update_Banner
   SHALL receive a progress update at least once every 1000
   milliseconds.
4. WHILE the installer download is in progress, THE Update_Banner
   SHALL render a "Cancel" action in place of the "Update now"
   action.
5. WHEN the user activates the "Cancel" action while the installer
   download is in progress, THE Auto_Updater SHALL stop the download,
   discard any partial bytes received, and complete the cancellation
   within 2 seconds, and THE Update_Notification_UI SHALL return the
   Update_Banner to its "available" state.
6. WHEN the installer download completes and integrity verification
   succeeds, THE Update_Notification_UI SHALL transition the
   Update_Banner to its "ready to install" state.
7. IF the installer download encounters a network error or fails to
   make progress for 30 consecutive seconds, THEN THE Auto_Updater
   SHALL stop the download, discard any partial bytes received, and
   THE Update_Notification_UI SHALL return the Update_Banner to its
   "available" state with a single user-visible failure indication.
8. IF integrity verification of the downloaded installer fails when
   the download has otherwise completed, THEN THE Auto_Updater SHALL
   delete the downloaded artefact and its companion blockmap from
   local storage and THE Update_Notification_UI SHALL return the
   Update_Banner to its "available" state with a single user-visible
   failure indication.

### Requirement 6: Restart and Install Action

**User Story:** As a Zule user, I want to install a downloaded update
with a single click, so that adopting the new version is as easy as
clicking a button.

#### Acceptance Criteria

1. WHILE the Update_Banner is in its "ready to install" state, THE
   Update_Banner SHALL expose a primary action labelled "Restart and
   install" and a secondary action labelled "Install on next quit".
2. WHEN the user activates the "Restart and install" action, THE
   Auto_Updater SHALL launch the downloaded installer within 2
   seconds and THE application SHALL exit within 5 seconds of the
   installer launching.
3. WHEN the user activates the "Install on next quit" action, THE
   Auto_Updater SHALL stage the installer to run when the
   application exits through a user-initiated application exit, and
   THE Update_Notification_UI SHALL hide the Update_Banner for the
   remainder of the current application launch.
4. IF the user has chosen "Install on next quit" earlier in the
   current application launch, THEN WHEN the application exits
   through a user-initiated application exit, THE Auto_Updater SHALL
   launch the staged installer.
5. IF launching the downloaded installer fails after the user
   activated "Restart and install", THEN THE application SHALL
   remain running, THE Update_Banner SHALL remain in its "ready to
   install" state, and THE Update_Notification_UI SHALL display a
   single user-visible failure indication.
6. IF the application terminates abnormally through a crash, a
   forced kill, or an operating-system shutdown while a "Install on
   next quit" stage is set, THEN THE Auto_Updater SHALL NOT consume
   the staged install on the next application launch and SHALL
   preserve the staged installer artefact for the next user-
   initiated install action.
7. WHILE a "Restart and install" action initiated by the user is in
   progress, THE Update_Banner SHALL reject further activations of
   the "Restart and install" or "Install on next quit" actions.

### Requirement 7: Overlay Window Update Indicator

**User Story:** As a Zule user running the floating overlay during a
meeting, I want a quiet hint that an update is ready, so that I know
to look at the dashboard later without breaking the flow of my
meeting.

#### Acceptance Criteria

1. WHILE the Update_Banner is in its "ready to install" state and
   the Overlay_Window is visible, THE Overlay_Window SHALL render
   the Update_Indicator inside the Overlay_Window's existing
   rendered region.
2. THE Update_Indicator SHALL be at least 6 pixels and at most 12
   pixels in either dimension.
3. WHILE the Update_Indicator is rendered, THE Overlay_Window SHALL
   preserve its outer position, its outer bounds, and its outer size
   unchanged from the immediately preceding frame.
4. THE Update_Indicator SHALL NOT intercept pointer events that
   would otherwise reach the Overlay_Window's existing controls.
5. WHILE the Update_Banner is not in its "ready to install" state,
   THE Overlay_Window SHALL NOT render the Update_Indicator.
6. WHEN the Update_Banner transitions into its "ready to install"
   state and the Overlay_Window is visible, THE Update_Indicator
   SHALL appear within 1000 milliseconds of the transition.
7. WHEN the Update_Banner transitions out of its "ready to install"
   state, THE Update_Indicator SHALL be removed from the
   Overlay_Window within 1000 milliseconds of the transition.

### Requirement 8: Offline-First Failure Handling

**User Story:** As a Zule user working offline, I want the app to
keep running normally when the update server cannot be reached, so
that updates never get in the way of my work.

#### Acceptance Criteria

1. IF the Auto_Updater cannot establish a connection to the
   Update_Source within 10 seconds during a background update check,
   or receives an HTTP server error response, then THE Auto_Updater
   SHALL record an `update.error` Telemetry_Module event with a
   failure category drawn from the set
   `{"unreachable", "timeout", "server-error"}` and SHALL NOT
   surface a user-visible error indicator on the Dashboard_Window or
   the Overlay_Window.
2. IF the installer download fails after the user activated the
   "Update now" action through network loss, an HTTP server error,
   or insufficient local storage, THEN THE Update_Notification_UI
   SHALL return the Update_Banner to its "available" state within 2
   seconds, SHALL display exactly one user-visible message that
   names a failure category drawn from the set
   `{"network", "server-error", "storage"}`, and THE Auto_Updater
   SHALL record an `update.error` Telemetry_Module event with the
   same failure category.
3. IF integrity verification of a downloaded installer fails, THEN
   THE Auto_Updater SHALL delete the downloaded artefact and its
   companion blockmap from local storage, THE Update_Notification_UI
   SHALL return the Update_Banner to its "available" state, and THE
   Auto_Updater SHALL record an `update.error` Telemetry_Module
   event with failure category `"integrity"`.
4. WHEN the application launches, THE Auto_Updater SHALL run all
   update-check work off the synchronous launch path so that an
   unreachable Update_Source SHALL NOT delay the Dashboard_Window's
   first interactive frame.
5. WHEN the application begins exiting through a user-initiated
   application exit while an installer download is in progress, THE
   Auto_Updater SHALL abort the download within 2 seconds, discard
   any partial bytes received, and SHALL NOT delay the application's
   normal shutdown beyond that 2-second budget.

### Requirement 9: Update Lifecycle Telemetry

**User Story:** As a Zule developer, I want to observe how often
updates are checked, downloaded, and installed in production, so that
I can measure adoption and detect regressions in the update channel.

#### Acceptance Criteria

1. WHEN the Auto_Updater initiates an update check, THE Auto_Updater
   SHALL emit an `update.checked` Telemetry_Module event whose
   payload contains the Current_Version as a semantic-version string
   and a `trigger` field whose value is exactly one of `"startup"`
   or `"manual"`.
2. WHEN the Auto_Updater identifies a candidate Available_Version
   that is strictly greater than the Current_Version, THE
   Auto_Updater SHALL emit an `update.available` Telemetry_Module
   event whose payload contains the Available_Version and the
   Current_Version, each as a semantic-version string.
3. WHEN the Auto_Updater completes an installer download for which
   integrity verification has succeeded, THE Auto_Updater SHALL emit
   an `update.downloaded` Telemetry_Module event whose payload
   contains the Available_Version as a semantic-version string and
   the wall-clock duration of the download as a non-negative integer
   expressed in milliseconds.
4. WHEN the first application launch following a successful
   installer execution observes that the Current_Version equals the
   Available_Version recorded by the most recent `update.downloaded`
   event, THE Auto_Updater SHALL emit exactly one `update.installed`
   Telemetry_Module event whose payload contains the new
   Current_Version as a semantic-version string.
5. IF the Auto_Updater encounters a failure during the update check,
   the installer download, integrity verification, or installer
   execution, THEN THE Auto_Updater SHALL emit an `update.error`
   Telemetry_Module event whose payload contains a `stage` field
   whose value is exactly one of `"check"`, `"download"`,
   `"integrity"`, or `"install"`, and a `category` field whose value
   is exactly one string-literal tag drawn from a documented finite
   set.
6. THE Auto_Updater SHALL omit from every update lifecycle telemetry
   event payload any operating-system user name, account identifier,
   machine or device identifier, network address, file-system path,
   the Release_Notes body, and every field of the
   Latest_Release_Manifest other than the version string.

### Requirement 10: IPC Bridge and Type Surface

**User Story:** As a Zule developer, I want the renderer to talk to
the Auto_Updater through the same typed contextBridge surface as the
rest of the app, so that the update UI is testable and consistent
with the existing IPC pattern.

#### Acceptance Criteria

1. THE IPC_Bridge SHALL expose update lifecycle methods to the
   renderer through `window.electronAPI` and SHALL declare each of
   them with explicit parameter and return types on the
   `ElectronAPI` interface in `src/types/electron.d.ts`.
2. THE IPC_Bridge SHALL expose a method that the renderer calls to
   trigger a manual update check; the method SHALL return a Promise
   that resolves within 30 seconds with the resulting Auto_Updater
   state, or rejects with a typed error when the check fails.
3. THE IPC_Bridge SHALL expose a method that the renderer calls to
   start the installer download for a previously identified
   candidate Available_Version; the method SHALL return a Promise
   that resolves once the download has been started, and SHALL
   reject with a typed error when no candidate Available_Version is
   currently identified.
4. THE IPC_Bridge SHALL expose a method that the renderer calls to
   cancel an installer download that is currently in progress; the
   method SHALL return a Promise that resolves once the download
   has been cancelled, and SHALL reject with a typed error when no
   download is in progress.
5. THE IPC_Bridge SHALL expose a method that the renderer calls to
   trigger a "restart and install" of a previously downloaded
   installer; the method SHALL return a Promise that resolves once
   the installer launch has been initiated, and SHALL reject with a
   typed error when no downloaded installer is staged.
6. THE IPC_Bridge SHALL expose a subscription method that returns an
   unsubscribe function and delivers a typed event whenever the
   Auto_Updater state transitions between `idle`, `checking`,
   `available`, `downloading`, `ready-to-install`, and `error`.
7. WHILE the Auto_Updater is in the `downloading` state, THE
   IPC_Bridge SHALL deliver a progress event at least once every
   1000 milliseconds and at most 10 times per second, where each
   progress event carries a non-negative bytes-received count, a
   total-bytes count not less than the bytes-received count, and an
   integer percent in the closed range `[0, 100]`.
8. THE IPC_Bridge SHALL deliver every Auto_Updater state event to
   the Dashboard_Window and to the Overlay_Window when each window
   has not been destroyed; if one of the windows has been destroyed,
   THE IPC_Bridge SHALL skip it silently and SHALL continue
   delivering to the other window.

### Requirement 11: No Regressions in Existing Behaviour

**User Story:** As a Zule user, I want the rest of the application to
keep working exactly as it does today after this feature lands, so
that the update mechanism does not introduce friction in unrelated
flows.

#### Acceptance Criteria

1. THE existing Settings_Module sections — AI Configuration, AI
   Providers, Knowledge Base, Custom Modes, Appearance, Language,
   Transcription, Keyboard Shortcuts, Performance Profile, Redaction
   Rules, Data Retention, and Privacy — SHALL continue to render the
   same set of visible controls, accept the same input ranges, and
   read or write the same persisted settings as the prior released
   build.
2. THE existing IPC_Bridge methods declared on the `ElectronAPI`
   interface in `src/types/electron.d.ts` SHALL continue to be
   exposed on `window.electronAPI` with identical method names,
   identical parameter counts, identical parameter types, and
   identical return types relative to the prior released build.
3. WHILE the Update_Indicator is not rendered, THE Overlay_Window
   SHALL preserve the same set of visible controls and the same
   pixel dimensions as the prior released build.
4. THE existing test suites under `src/brain`, `src/data`,
   `src/components`, and `src/hooks` SHALL pass with zero failed
   assertions, zero modified assertions, and zero removed or
   skipped test cases.
5. IF the Auto_Updater main-process module fails to initialise, THEN
   THE Settings_Module sections enumerated in clause 1 of this
   requirement, the IPC_Bridge surface enumerated in clause 2, and
   the Overlay_Window behaviour enumerated in clause 3 SHALL
   continue to behave as specified in those clauses.
