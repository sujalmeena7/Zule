# Requirements Document

## Introduction

Stage C replaces only Zule's floating overlay top-level Electron window on Windows with the app-owned `ZuleUI.exe` WebView2 presentation sidecar. Electron remains the application core, canonical state owner, service owner, Dashboard host, and permanent Layer 0 fallback. Stage A remains failed and disabled after mandatory gates A5 and A6 failed. Stage B remains disabled with status `not evaluated`.

Stage C uses stable, truthful Zule metadata. The sole frameless floating surface uses executable name `ZuleUI.exe`, Win32 class `ZuleUIWindow`, and an empty title. Stage C does not conceal the Dashboard, process tree, modules, child windows, WebView2 runtime artifacts, or application behavior, and no product material may claim undetectability or monitoring evasion.

## Glossary

- **App_Core**: The existing Electron application, including the main process and renderer services, that owns canonical state and application services.
- **Dashboard**: Zule's Electron-hosted main application window, which remains outside Stage C replacement scope.
- **Floating_Overlay**: Zule's floating copilot user interface.
- **Floating_Surface**: The single frameless transparent Stage C top-level window that presents the Floating_Overlay.
- **Layer_0**: The existing Electron `BrowserWindow` Floating_Overlay and its existing lifecycle, geometry, drag, IPC, and Capture_Protection behavior; the permanent fallback.
- **Stage_A**: The failed HWND-reparenting experiment, disabled after mandatory real-Windows interaction gate A5 and geometry/lifecycle gate A6 failed.
- **Stage_B**: The disabled offscreen-render experiment with status `not evaluated`.
- **Stage_C**: The Windows-only app-owned WebView2 sidecar strategy described by the Stage C design.
- **Stage_C_Controller**: The App_Core component that selects, probes, launches, synchronizes, supervises, and falls back from Stage C.
- **Strategy_Selector**: The Stage_C_Controller logic whose only selectable host strategies are Layer_0 and Stage_C.
- **Stage_C_Sidecar**: The presentation-only native Windows process with executable name `ZuleUI.exe`.
- **Stage_C_Toolchain_Probe**: The non-mutating build-time check for the reviewed native compiler, build system, and Windows SDK.
- **Runtime_Probe**: The ordered prelaunch compatibility and integrity check that does not start the Stage_C_Sidecar.
- **Stage_C_Manifest**: The packaged exact-schema record of versions, architecture, protocol, bridge schema, capabilities, WebView2 minimum, dependency inventory, hashes, and release evidence.
- **Dependency_Lock**: The reviewed exact-version inventory for the native toolchain and Stage C dependencies.
- **Manifest_Toolchain**: The parser and serializer that creates and validates the Stage_C_Manifest.
- **Production_Build**: A distributable build intended for end users.
- **Diagnostic_Build**: A local development build carrying an explicit Stage C diagnostic marker.
- **App_Publisher**: The configured Zule publisher and signing identity.
- **WebView2_Runtime**: The observable Microsoft WebView2 runtime used by the Stage_C_Sidecar.
- **Ready_Handshake**: The authenticated sidecar readiness message containing launch, version, protocol, bridge, capability, architecture, and runtime information.
- **Overlay_Projection**: A versioned rendering projection containing requested visibility, DIP bounds, mode, Capture_Protection value, and reviewed Floating_Overlay render state.
- **Canonical_Overlay_State**: The authoritative Floating_Overlay state owned only by App_Core.
- **Local_IPC**: The local-only per-launch authenticated framed transport between App_Core and the Stage_C_Sidecar.
- **Launch_Credential**: A 32-byte cryptographically random secret scoped to one sidecar launch.
- **Protocol_Envelope**: The exact-schema message containing protocol version, unique message identifier, allowlisted type, and type-specific payload.
- **Protocol_Codec**: The strict UTF-8 JSON frame serializer and parser for Protocol_Envelope values.
- **Allowed_Message**: A Protocol_Envelope whose type and payload conform to the reviewed directional allowlist and exact schema.
- **Bridge_Adapter**: The frozen least-privilege WebView2 adapter that maps reviewed Floating_Overlay methods and events to Allowed_Messages.
- **Capture_Protection**: The user setting that requests `WDA_EXCLUDEFROMCAPTURE` when enabled and `WDA_NONE` when disabled.
- **Device_Independent_Pixel**: A logical pixel measured at 96 units per inch.
- **Stage_C_Release_Gate**: The complete Windows evidence matrix required before production enablement.
- **Release_Gate_Harness**: The Windows tooling that executes Stage C release gates and archives evidence by build hash.
- **Stage_C_Telemetry**: Content-free operational events validated against an exact field and size allowlist.
- **Stage C build system**: The pinned native compilation and build configuration for the Stage_C_Sidecar.
- **build system**: The workspace build orchestration that invokes or skips the Stage C build system.
- **Stage C CI environment**: The pinned continuous-integration image used to build Stage C release artifacts.
- **packaging system**: The release tooling that assembles App_Core, Stage C, and Layer_0 artifacts.
- **updater**: The application update component that stages, verifies, activates, and rolls back complete releases.
- **application startup**: The packaged application initialization path.
- **release process**: The controlled workflow that accepts or rejects production artifacts.
- **test suite**: The automated project validation runner.
- **Product_Documentation**: User-facing, release, diagnostic, and telemetry descriptions of Stage C.
- **Protected_Layer_0_Tests**: `src/overlay/dualModeOverlay.preservation.test.ts` and `src/electron-tests/dualModeOverlay.bugcondition.test.ts`.

## Requirements

### Requirement 1: Permanent Fallback, Stage Status, and Narrow Scope

**User Story:** As a user, I want a truthful and recoverable host strategy, so that Stage C cannot weaken the supported overlay.

#### Acceptance Criteria

1. THE Strategy_Selector SHALL return only Layer_0 or Stage_C as a runtime host strategy.
2. THE Strategy_Selector SHALL report Stage_A status as `FAILED_DISABLED_A5_A6`.
3. THE Strategy_Selector SHALL report Stage_B status as `DISABLED_NOT_EVALUATED`.
4. THE Strategy_Selector SHALL reject Stage_A selection requests from build flags, runtime flags, environment variables, persisted settings, retry logic, and fallback logic.
5. THE Strategy_Selector SHALL reject Stage_B selection requests from build flags, runtime flags, environment variables, persisted settings, retry logic, and fallback logic.
6. THE Stage_C_Controller SHALL keep packaged Layer_0 available for selection without restarting App_Core.
7. THE Stage_C_Controller SHALL limit Stage_C replacement to the Floating_Overlay top-level window.
8. THE App_Core SHALL retain Electron ownership of the Dashboard and each non-Floating_Overlay application surface.
9. THE Product_Documentation SHALL describe Stage_C as changing only the Floating_Overlay top-level host from `Chrome_WidgetWin` to `ZuleUIWindow`.
10. THE Product_Documentation SHALL identify the Dashboard, process tree, modules, child windows, WebView2_Runtime artifacts, and application behavior as observable.
11. THE Product_Documentation SHALL contain zero claims of undetectability, monitoring evasion, capture impossibility, or system-level invisibility.

### Requirement 2: Stable Truthful Metadata

**User Story:** As a user, I want app-owned metadata to identify Zule consistently, so that Stage C does not use concealment naming or impersonation.

#### Acceptance Criteria

1. THE Stage_C_Sidecar SHALL use `ZuleUI.exe` as both the executable filename and the `OriginalFilename` version-resource value.
2. THE Stage_C_Sidecar SHALL use `Zule AI` as both the `CompanyName` and `ProductName` version-resource values.
3. THE Stage_C_Sidecar SHALL use Zule-owned `FileDescription`, `InternalName`, file-version, product-version, copyright, and publisher values.
4. THE Stage_C_Sidecar SHALL register `ZuleUIWindow` as the Floating_Surface Win32 class.
5. WHEN the Stage_C_Sidecar creates the Floating_Surface, THE Stage_C_Sidecar SHALL set the window title to the empty string.
6. WHEN the Stage_C_Sidecar creates any other app-owned top-level window, THE Stage_C_Sidecar SHALL set a non-empty title beginning with `Zule`.
7. THE Stage_C_Sidecar SHALL keep executable, class, title policy, product, publisher, and version-resource values identical across launches of the same release.
8. THE Stage_C_Sidecar SHALL use zero randomized or generic concealment values in executable, class, title, product, publisher, and version-resource metadata.
9. THE Stage_C_Sidecar SHALL use zero app-owned metadata values that claim Windows, Microsoft, Edge, System, or third-party ownership.

### Requirement 3: Deterministic Native Toolchain

**User Story:** As a maintainer, I want a pinned reviewed native toolchain, so that Stage C builds do not depend on opportunistic compiler availability.

#### Acceptance Criteria

1. THE Dependency_Lock SHALL identify one exact MSVC version and component set, one exact MSBuild version, one exact Windows SDK version, one exact WebView2 SDK and loader version, one exact Stage C CI image digest, and every transitive native dependency.
2. THE Dependency_Lock SHALL record the source, integrity hash, license, supported architecture, and review status for each locked item.
3. WHEN the Stage_C_Toolchain_Probe executes, THE Stage_C_Toolchain_Probe SHALL return `AVAILABLE` only when every observed tool version, component identifier, architecture, and integrity value exactly matches the Dependency_Lock.
4. IF any required tool is absent or differs from the Dependency_Lock, THEN THE Stage_C_Toolchain_Probe SHALL return `UNAVAILABLE` without installing, downloading, upgrading, or selecting an alternative tool.
5. WHILE the Stage_C_Toolchain_Probe result is `UNAVAILABLE`, THE build system SHALL keep JavaScript development and Layer_0 operation available.
6. WHILE the Stage_C_Toolchain_Probe result is `UNAVAILABLE`, THE build system SHALL fail Stage C native-build, packaging, and production-enablement targets.
7. THE Stage C build system SHALL compile the explicit `.vcxproj` as C++20 Win32 with the locked MSVC, MSBuild, Windows SDK, WebView2 C++ interfaces, and DirectComposition dependencies.
8. THE Stage C build system SHALL resolve every native dependency by exact locked version and integrity hash.
9. IF a dependency uses a floating range or is absent from the Dependency_Lock, THEN THE Stage C build system SHALL fail before compilation.
10. WHEN a native dependency, transitive dependency, tool version, component identifier, or CI image digest changes, THE Stage_C_Release_Gate SHALL require a new integrity, license, vulnerability, publisher, architecture, and reproducibility review.
11. THE Stage C build system SHALL produce a Stage_C_Sidecar only for an architecture distributed by the matching App_Core package.
12. THE Stage C build system SHALL provide zero automatic .NET, Rust, MinGW, Clang, ad-hoc compiler, runtime-download, or SDK-download fallback paths.

### Requirement 4: Runtime Probe and Strategy Selection

**User Story:** As a user, I want Stage C selected only from a compatible verified package, so that probe failure leaves Layer 0 usable.

#### Acceptance Criteria

1. WHEN the Floating_Overlay is requested, THE Stage_C_Controller SHALL create Layer_0, apply the latest Canonical_Overlay_State, apply the current Capture_Protection value, and show Layer_0 before starting the Runtime_Probe.
2. WHEN the Runtime_Probe starts, THE Runtime_Probe SHALL start an absolute 3-second deadline.
3. WHEN the Runtime_Probe executes, THE Runtime_Probe SHALL perform zero Stage_C_Sidecar process starts.
4. WHEN the Runtime_Probe executes, THE Runtime_Probe SHALL verify Windows platform, supported App_Core architecture, Stage_C_Manifest exact schema and integrity, manifest-declared resource path, matching sidecar architecture, exact protocol-major equality, compatible bridge schema, WebView2_Runtime presence and minimum version, and Dependency_Lock integrity.
5. WHERE Production_Build is active, WHEN the Runtime_Probe executes, THE Runtime_Probe SHALL verify a Stage_C_Release_Gate approval identifier bound to every packaged artifact hash.
6. WHERE Production_Build is active, WHEN the Runtime_Probe executes, THE Runtime_Probe SHALL accept the sidecar signature only when signature verification is explicitly valid for App_Publisher.
7. WHERE Production_Build is active, IF signature verification is unknown, offline, warning, indeterminate, invalid, or bound to another publisher, THEN THE Runtime_Probe SHALL return a typed signature failure.
8. WHERE Production_Build is active, WHEN the Runtime_Probe executes, THE Runtime_Probe SHALL verify exact App_Core and Stage_C_Sidecar release-version equality.
9. WHERE Diagnostic_Build is active, WHEN the Runtime_Probe executes, THE Runtime_Probe SHALL verify the explicit local Stage C diagnostic marker.
10. IF a Runtime_Probe check fails or the 3-second deadline expires, THEN THE Stage_C_Controller SHALL keep Layer_0 visible, report one typed content-free reason, and leave the Stage_C_Sidecar spawn count unchanged.
11. WHILE a healthy Stage_C_Sidecar is active, IF a repeated Runtime_Probe fails, THEN THE Stage_C_Controller SHALL retain the healthy Stage_C_Sidecar and block only the next Stage C launch.
12. WHILE Stage_C has failed during the current App_Core launch, WHEN no unused explicit diagnostic retry is requested, THE Strategy_Selector SHALL select Layer_0 without repeating the Runtime_Probe.
13. WHEN every Runtime_Probe check succeeds before the deadline, THE Stage_C_Controller SHALL attempt Stage_C.

### Requirement 5: Lifecycle, Version Handshake, and State Synchronization

**User Story:** As a user, I want deterministic sidecar lifecycle and synchronized startup, so that Stage C appears only when compatible and ready.

#### Acceptance Criteria

1. WHEN Stage_C is attempted without a pending or healthy Stage_C_Sidecar, THE Stage_C_Controller SHALL spawn exactly one packaged `ZuleUI.exe` process without shell execution for that Stage C launch attempt.
2. WHILE a pending or healthy Stage_C_Sidecar exists, WHEN another Floating_Overlay request arrives, THE Stage_C_Controller SHALL reuse the existing process and Floating_Surface.
3. WHEN the Stage_C_Controller spawns `ZuleUI.exe`, THE Stage_C_Controller SHALL start one absolute 3-second startup deadline that includes authentication, Ready_Handshake verification, snapshot acknowledgement, and first-frame readiness.
4. WHEN WebView2, Bridge_Adapter, Floating_Surface, and content-policy initialization complete, THE Stage_C_Sidecar SHALL send exactly one Ready_Handshake for the current Stage C launch attempt.
5. THE Ready_Handshake SHALL contain the current launch identifier, exact sidecar version, protocol major, protocol minor, bridge schema version, capability identifiers, architecture, and WebView2_Runtime version.
6. WHEN the Stage_C_Controller receives the Ready_Handshake, THE Stage_C_Controller SHALL verify authentication, launch identifier, release-version policy, protocol major, protocol-minor capabilities, bridge schema, required capabilities, architecture, and WebView2_Runtime version before sending state.
7. IF Ready_Handshake verification fails, THEN THE Stage_C_Controller SHALL keep the Floating_Surface hidden and begin fallback with a typed handshake failure.
8. WHILE the Ready_Handshake is unaccepted, THE Stage_C_Sidecar SHALL keep the Floating_Surface hidden.
9. WHEN the Ready_Handshake is accepted, THE Stage_C_Controller SHALL send exactly one complete current Overlay_Projection snapshot before sending any incremental patch.
10. WHEN the Stage_C_Sidecar receives the initial snapshot, THE Stage_C_Sidecar SHALL apply the complete snapshot before acknowledging the matching revision.
11. IF the matching snapshot acknowledgement does not arrive within 1 second after snapshot transmission, THEN THE Stage_C_Controller SHALL begin fallback with `STATE_ACK_TIMEOUT`.
12. WHEN the matching snapshot acknowledgement arrives, THE Stage_C_Controller SHALL wait for `surface.firstFrameReady` before cutover.
13. WHEN the Stage_C_Sidecar sends `surface.firstFrameReady`, THE Stage_C_Sidecar SHALL have presented a transparent frame containing the acknowledged snapshot revision.
14. IF `surface.firstFrameReady` does not arrive within 1 second after snapshot acknowledgement, THEN THE Stage_C_Controller SHALL begin fallback with `FIRST_FRAME_TIMEOUT`.
15. WHEN authentication, Ready_Handshake acceptance, snapshot acknowledgement, and first-frame readiness complete in that order before the startup deadline, THE Stage_C_Controller SHALL hide Layer_0 before showing the Floating_Surface.
16. IF the 3-second startup deadline expires during any startup phase, THEN THE Stage_C_Controller SHALL keep or restore Layer_0 usability and begin fallback with `STARTUP_TIMEOUT`.
17. WHEN an incremental patch has the current base revision and next sequential revision, THE Stage_C_Sidecar SHALL apply the patch and acknowledge the next revision.
18. IF an incremental patch revision is unexpected, THEN THE Stage_C_Sidecar SHALL retain the previous complete render state and request a full snapshot.
19. WHEN Local_IPC reconnects during one App_Core launch, THE Stage_C_Controller SHALL authenticate the connection and send a full snapshot before any incremental patch.
20. WHEN normal shutdown begins, THE Stage_C_Controller SHALL send `lifecycle.shutdown` and wait 2 seconds for sidecar exit.
21. IF the Stage_C_Sidecar remains alive after the 2-second shutdown wait, THEN THE Stage_C_Controller SHALL terminate the owned process.
22. WHEN the owned process exits, THE Stage_C_Controller SHALL close the endpoint, invalidate the Launch_Credential, release owned handles, and verify absence of an owned `ZuleUI.exe` process and `ZuleUIWindow` top-level window.
23. WHEN the first explicit diagnostic retry is requested during an App_Core launch, THE Stage_C_Controller SHALL terminate any owned stale sidecar before creating a replacement.
24. IF a second or later diagnostic retry is requested during the same App_Core launch, THEN THE Stage_C_Controller SHALL reject the request and retain Layer_0.
25. THE Stage_C_Controller SHALL expose diagnostic retry status only through local diagnostics.

### Requirement 6: Authenticated, Bounded, Strict-Schema Local IPC

**User Story:** As a security reviewer, I want a narrow authenticated local protocol, so that rejected or replayed input cannot mutate application state.

#### Acceptance Criteria

1. WHEN the Stage_C_Controller prepares a sidecar launch, THE Stage_C_Controller SHALL create one unique local-only Windows named-pipe endpoint for that launch.
2. THE Stage_C_Controller SHALL grant endpoint access only to the current logon SID and the two participating application processes.
3. THE Stage_C_Controller SHALL reject anonymous, network, `Everyone`, and low-integrity endpoint access.
4. WHEN the Stage_C_Controller prepares a sidecar launch, THE Stage_C_Controller SHALL generate one 32-byte Launch_Credential and independent nonces from the Windows cryptographic random source.
5. WHEN the Stage_C_Controller spawns the Stage_C_Sidecar, THE Stage_C_Controller SHALL deliver the endpoint, launch identifier, Launch_Credential, and parent identity through one length-bounded inherited one-shot handle.
6. THE Stage_C_Controller SHALL make only the intended child bootstrap handle inheritable.
7. THE Stage_C_Controller SHALL omit the bootstrap record from command-line arguments, environment variables, WebView storage, renderer globals, logs, crash annotations, and Stage_C_Telemetry.
8. WHEN the Stage_C_Sidecar consumes the bootstrap record once, THE Stage_C_Controller SHALL close the inherited handle and reject subsequent bootstrap reads.
9. WHEN Local_IPC connects, THE Local_IPC SHALL complete mutual challenge-response authentication for the current launch before accepting a non-authentication message.
10. IF authentication exceeds 2 seconds, THEN THE Stage_C_Controller SHALL emit one content-free threshold event and continue only until the absolute 3-second startup deadline.
11. IF authentication proof, launch identifier, challenge, nonce, parent identity, or Launch_Credential is invalid, THEN THE Local_IPC SHALL close the connection with zero state mutations and zero service invocations.
12. WHEN a Local_IPC launch disconnects or exits, THE Stage_C_Controller SHALL invalidate the Launch_Credential and overwrite mutable credential buffers on a best-effort basis.
13. THE Protocol_Codec SHALL serialize each Protocol_Envelope as a 32-bit little-endian byte length followed by strict UTF-8 JSON.
14. THE Protocol_Codec SHALL parse only exact-schema Protocol_Envelope values.
15. WHEN a valid Protocol_Envelope is serialized, parsed, serialized, and parsed, THE Protocol_Codec SHALL produce a semantically equivalent Protocol_Envelope without extra fields.
16. IF a declared frame length exceeds 1,048,576 bytes, THEN THE Protocol_Codec SHALL reject the frame before payload allocation or JSON parsing.
17. IF a frame has malformed UTF-8, malformed JSON, an unknown type, an extra field, a missing field, an incompatible protocol, a non-canonical identifier, an invalid payload, or an unexpected revision, THEN THE Local_IPC SHALL reject the frame with zero state mutations and zero service invocations.
18. THE Local_IPC SHALL accept only `lifecycle.shutdown`, `state.snapshot`, `state.patch`, `surface.setBounds`, `surface.setVisibility`, `surface.setCaptureProtection`, `ai.streamDelta`, `ai.streamCompleted`, `ai.streamFailed`, and `operation.result` from App_Core to the Stage_C_Sidecar.
19. THE Local_IPC SHALL accept only `lifecycle.ready`, `lifecycle.shutdownAck`, `surface.firstFrameReady`, `state.snapshotAck`, `state.patchAck`, `surface.boundsChanged`, `surface.captureProtectionResult`, `intent.overlay`, `intent.ai`, `intent.audio`, `intent.screenCapture`, and `diagnostic.contentPolicyEvent` from the Stage_C_Sidecar to App_Core.
20. THE Local_IPC SHALL reject every message type received in a direction not listed for that direction.
21. THE Local_IPC SHALL provide zero generic invoke, arbitrary channel, arbitrary method, filesystem, process, URL, or command payload types.
22. WHEN Local_IPC receives a repeated message identifier, THE Local_IPC SHALL return `duplicate-message` with the cached terminal outcome and perform zero repeated mutations or service invocations.
23. THE Local_IPC SHALL retain at most 4,096 replay-cache entries per launch.
24. THE Local_IPC SHALL queue at most 256 messages and at most 1,048,576 aggregate queued bytes per connection.
25. IF either queue bound is exceeded, THEN THE Local_IPC SHALL close the connection and begin fallback.
26. WHEN Local_IPC records a rejection, THE Local_IPC SHALL record only category, direction, safely decoded type, and byte count.
27. IF rejection recording fails, THEN THE Local_IPC SHALL preserve rejection, supervision, and fallback behavior.

### Requirement 7: Least-Privilege WebView2 Bridge and Content Policy

**User Story:** As a security reviewer, I want web content limited to reviewed overlay intents, so that the presentation process has no general native authority.

#### Acceptance Criteria

1. THE Bridge_Adapter SHALL expose one frozen `window.zuleOverlay` adapter.
2. THE Bridge_Adapter SHALL expose only `requestOverlayAction`, `requestAI`, `requestAudio`, `requestScreenCapture`, `reportDragRegions`, and `reportInteractiveRegions` from WebView2 content to the Stage_C_Sidecar.
3. THE Bridge_Adapter SHALL emit only `onStateSnapshot`, `onStatePatch`, and `onOperationResult` from the Stage_C_Sidecar to WebView2 content.
4. THE Bridge_Adapter SHALL map each exposed method and event one-to-one to an exact Allowed_Message schema traced to a current Floating_Overlay caller.
5. IF a proposed bridge capability has no current Floating_Overlay caller, THEN THE Bridge_Adapter SHALL exclude the capability from Production_Build.
6. WHEN WebView2 content emits a bridge message, THE Bridge_Adapter SHALL reject a message whose strict UTF-8 encoded size exceeds 65,536 bytes before native dispatch.
7. WHEN WebView2 content emits a bridge message within the size bound, THE Bridge_Adapter SHALL validate version, exact fields, type, range, count, and size before native dispatch.
8. WHEN the Stage_C_Sidecar receives a bridge message, THE Stage_C_Sidecar SHALL repeat authoritative version, exact-field, type, range, count, and size validation.
9. IF a bridge message is unsupported or invalid, THEN THE Bridge_Adapter SHALL return a typed error with zero native side effects.
10. THE Bridge_Adapter SHALL expose zero access to named pipes, Launch_Credentials, process environment, native handles, filesystem, registry, shell, arbitrary network, process creation, App_Core IPC, native pointers, or general COM host objects.
11. THE Stage_C_Sidecar SHALL load only bundled versioned Zule overlay resources through a read-only virtual host.
12. THE Stage_C_Sidecar SHALL restrict navigation to the packaged Zule overlay origin.
13. WHEN WebView2 requests a new window, download, permission, external URI, unapproved navigation, or drag-and-drop operation, THE Stage_C_Sidecar SHALL deny the request and emit a content-policy event.
14. WHERE Production_Build is active, THE Stage_C_Sidecar SHALL disable developer tools, context menus, browser accelerator keys, and external drop targets.
15. THE Stage_C_Sidecar SHALL treat every page message as untrusted input.

### Requirement 8: Electron Service and State Ownership

**User Story:** As a maintainer, I want the sidecar to remain presentation-only, so that Stage C does not create a second application core.

#### Acceptance Criteria

1. THE App_Core SHALL be the sole component permitted to mutate Canonical_Overlay_State.
2. WHEN the Stage_C_Sidecar receives a snapshot or patch, THE Stage_C_Sidecar SHALL use the data only as a render projection.
3. WHEN a user action requests a state or service change, THE Stage_C_Sidecar SHALL send an allowlisted intent to App_Core without mutating Canonical_Overlay_State or invoking an application service.
4. THE App_Core SHALL be the sole component permitted to validate and execute state-changing or service-changing intents.
5. THE App_Core SHALL retain exclusive ownership of provider credentials, AI routing, prompt construction, streaming, cancellation, microphone capture, loopback capture, preprocessing, transcription, audio-device selection, screen-source enumeration, screen capture, permissions, image processing, retention, settings, and updates.
6. THE Overlay_Projection SHALL contain zero provider credentials, raw audio, screenshot bytes, unrestricted filesystem paths, service handles, or App_Core database values.
7. THE Stage_C_Sidecar SHALL perform zero direct AI-provider, audio-capture, screen-capture, settings-storage, update, credential-storage, or database operations.
8. WHEN App_Core accepts a sidecar intent, THE App_Core SHALL perform the operation before updating Canonical_Overlay_State.
9. WHEN App_Core updates Canonical_Overlay_State after an accepted intent, THE App_Core SHALL project the resulting state or operation result to the Stage_C_Sidecar.
10. THE App_Core SHALL create zero duplicate AI, audio, transcription, capture, or database pipelines in the Stage_C_Sidecar.

### Requirement 9: Transparent Composition

**User Story:** As a user, I want Stage C transparency to match Layer 0, so that the native host introduces no opaque artifacts.

#### Acceptance Criteria

1. WHEN the Stage_C_Sidecar creates the Floating_Surface, THE Stage_C_Sidecar SHALL create one borderless `WS_POPUP` window without caption text or a menu.
2. THE Stage_C_Sidecar SHALL host WebView2 through the composition-controller path and a DirectComposition visual tree.
3. WHEN WebView2 initializes, THE Stage_C_Sidecar SHALL set the WebView2 default background alpha to 0.
4. WHEN rendered content has alpha 0, THE Floating_Surface SHALL present alpha 0 at the corresponding pixel.
5. WHEN rendered content has alpha from 1 through 254, THE Floating_Surface SHALL preserve premultiplied alpha with absolute alpha-channel error no greater than one 8-bit unit.
6. WHEN the Floating_Overlay declares a fully transparent region, THE Floating_Surface SHALL present zero pixels with alpha greater than 0 in that region.
7. WHEN the Floating_Surface resizes, THE Stage_C_Sidecar SHALL size the composition root and WebView2 controller to the complete client rectangle before presenting the resized frame.
8. WHILE the Floating_Surface is hidden, THE Stage_C_Sidecar SHALL present zero visible desktop pixels.
9. WHEN compact, expanded, or maximized mode is requested, THE Stage_C_Sidecar SHALL render the corresponding Layer_0 presentation semantics without implementing application service logic.

### Requirement 10: Input, Native Drag, Hit Testing, and Focus

**User Story:** As a user, I want Stage C interactions to match Layer 0, so that pointer, keyboard, scrolling, drag, and focus remain reliable.

#### Acceptance Criteria

1. WHEN a pointer event targets WebView2 content, THE Stage_C_Sidecar SHALL forward the event in client coordinates with error no greater than 1 physical pixel on each edge-derived axis.
2. WHEN pointer enter, leave, move, button, or hover events occur, THE Stage_C_Sidecar SHALL preserve the Windows event order.
3. WHEN a vertical or horizontal wheel event occurs, THE Stage_C_Sidecar SHALL preserve the signed wheel delta exactly.
4. WHEN an interactive element activates, THE Stage_C_Sidecar SHALL transfer keyboard focus through the pinned WebView2 controller contract without activating another Zule window.
5. WHEN WebView2 has focus, THE Stage_C_Sidecar SHALL route printable keys, modifiers, navigation keys, editing keys, accelerators, and IME composition through Windows and WebView2 input contracts.
6. WHEN the renderer reports drag, interactive, or click-through regions, THE Stage_C_Sidecar SHALL validate revision, finite coordinates, rectangle edges, count, and encoded size before replacing the cached region map.
7. WHEN region validation succeeds, THE Stage_C_Sidecar SHALL convert each rectangle edge from Device_Independent_Pixels to physical client pixels using the effective DPI of the active monitor.
8. WHILE processing `WM_NCHITTEST`, THE Stage_C_Sidecar SHALL use the last valid cached region map without a synchronous renderer call.
9. WHEN a hit-test point belongs to a drag region, THE Floating_Surface SHALL return `HTCAPTION`.
10. WHEN a hit-test point belongs to a click-through region and no drag region, THE Floating_Surface SHALL return `HTTRANSPARENT`.
11. WHEN a hit-test point belongs to neither a drag region nor a click-through region, THE Floating_Surface SHALL return `HTCLIENT`.
12. IF a region map is absent, stale, malformed, out of bounds, or otherwise invalid, THEN THE Floating_Surface SHALL return `HTCLIENT` for the affected point.
13. WHEN `HTCAPTION` starts movement, THE Floating_Surface SHALL use the Windows native move loop.
14. WHEN native movement completes or is cancelled, THE Floating_Surface SHALL release pointer capture before reporting final DIP bounds to App_Core.
15. THE Stage_C_Sidecar SHALL apply click-through behavior only to validated declared click-through regions.
16. THE Stage_C_Sidecar SHALL preserve the existing Layer_0 `-webkit-app-region` drag and no-drag rules without modification.

### Requirement 11: DPI and Multi-Monitor Geometry

**User Story:** As a user, I want stable geometry across display configurations, so that the Floating_Overlay remains reachable and accurately positioned.

#### Acceptance Criteria

1. THE App_Core SHALL store canonical Floating_Overlay rectangles in Device_Independent_Pixels.
2. THE Stage_C_Sidecar SHALL use per-monitor DPI awareness compatible with App_Core.
3. WHEN converting DIP bounds to physical bounds, THE Stage_C_Sidecar SHALL scale and round the left, top, right, and bottom edges independently before deriving width and height.
4. WHEN converting physical bounds to DIP bounds, THE Stage_C_Sidecar SHALL inverse-scale the left, top, right, and bottom edges using the effective DPI of the active target monitor before deriving width and height.
5. WHEN coordinates are negative within the virtual desktop, THE Stage_C_Sidecar SHALL preserve the signed coordinate values.
6. WHEN DIP bounds are converted to physical pixels and back at scale 1, 1.25, 1.5, 1.75, 2, 2.5, or 3, THE Stage_C_Sidecar SHALL preserve each physical rectangle edge with absolute error no greater than 1 pixel.
7. WHEN Windows sends `WM_DPICHANGED`, THE Stage_C_Sidecar SHALL apply the operating-system-recommended physical rectangle before presenting the next frame.
8. WHEN effective DPI changes, THE Stage_C_Sidecar SHALL update WebView2 rasterization scale, composition bounds, input conversion, and region maps before presenting the next frame.
9. WHEN monitor crossing, rotation, addition, removal, work-area change, or scale change occurs, THE Stage_C_Controller SHALL revalidate each Floating_Surface rectangle edge against current monitor work areas.
10. IF persisted bounds have zero intersection with all current monitor work areas, THEN THE Stage_C_Controller SHALL center the Floating_Surface within the primary monitor work area.
11. IF topology recovery cannot calculate a finite positive-area replacement rectangle, THEN THE Stage_C_Controller SHALL retain the current rectangle and report a typed geometry degradation.
12. WHEN App_Core requests move, resize, nudge, recenter, snap, maximize, restore, show, hide, or toggle, THE Stage_C_Sidecar SHALL match each Layer_0 target rectangle edge with absolute error no greater than 1 physical pixel.
13. WHEN a native move or resize completes, THE Stage_C_Sidecar SHALL return edge-converted final DIP bounds to App_Core for canonical persistence.

### Requirement 12: Capture-Protection Toggle and Read-Back Parity

**User Story:** As a user, I want the existing capture toggle to retain one verified meaning, so that Stage C does not silently change the requested state.

#### Acceptance Criteria

1. WHEN Capture_Protection is enabled, THE Stage_C_Sidecar SHALL request `WDA_EXCLUDEFROMCAPTURE` for the Floating_Surface.
2. WHEN Capture_Protection is disabled, THE Stage_C_Sidecar SHALL request `WDA_NONE` for the Floating_Surface.
3. WHEN the Stage_C_Sidecar requests a display-affinity value, THE Stage_C_Sidecar SHALL complete `GetWindowDisplayAffinity` read-back within 100 milliseconds after the request.
4. WHEN display-affinity read-back equals the requested value within 100 milliseconds, THE Stage_C_Controller SHALL report Capture_Protection success.
5. IF display-affinity application fails, read-back fails, read-back exceeds 100 milliseconds, or read-back differs from the request, THEN THE Stage_C_Controller SHALL begin fallback with a typed Capture_Protection failure.
6. WHEN Capture_Protection fallback begins, THE Stage_C_Controller SHALL keep or make Layer_0 usable within 500 milliseconds after detecting the failure.
7. WHEN Capture_Protection fallback begins, THE Stage_C_Controller SHALL hide or close the Floating_Surface before showing Layer_0.
8. WHEN Capture_Protection fallback begins, THE Stage_C_Controller SHALL apply and verify the current Capture_Protection value on Layer_0 before showing Layer_0.
9. IF Layer_0 Capture_Protection application or verification fails during fallback, THEN THE Stage_C_Controller SHALL show Layer_0 within the 500-millisecond fallback deadline and report a typed Layer_0 Capture_Protection degradation.
10. WHEN the Floating_Surface is created, recreated, shown, or migrated to another display, THE Stage_C_Sidecar SHALL reapply and verify the current Capture_Protection value.
11. THE App_Core SHALL retain ownership of Dashboard Capture_Protection behavior.
12. THE Product_Documentation SHALL describe Capture_Protection as verified platform behavior with operating-system and runtime limitations rather than a capture-impossibility guarantee.

### Requirement 13: Startup, Crash, and Fallback Safety

**User Story:** As a user, I want every Stage C failure to recover through Layer 0, so that the overlay remains usable without duplicate visible surfaces.

#### Acceptance Criteria

1. WHILE the Floating_Overlay is requested, THE Stage_C_Controller SHALL keep Layer_0 warm and recoverable without restarting App_Core.
2. IF the 3-second startup deadline expires before Stage C readiness, THEN THE Stage_C_Controller SHALL terminate the Stage C launch attempt and begin fallback.
3. IF WebView2, Bridge_Adapter, composition, Floating_Surface creation, authentication, handshake, initial snapshot, or first-frame initialization fails, THEN THE Stage_C_Controller SHALL keep the Floating_Surface hidden and begin fallback.
4. IF `ZuleUI.exe` exits unexpectedly, THEN THE Stage_C_Controller SHALL begin fallback within 500 milliseconds after App_Core receives process-exit notification.
5. WHILE normal shutdown is inactive, IF Local_IPC disconnects unexpectedly, THEN THE Stage_C_Controller SHALL begin fallback within 500 milliseconds after App_Core receives disconnect notification.
6. WHILE normal shutdown is active, WHEN Local_IPC disconnects, THE Stage_C_Controller SHALL complete shutdown without reopening Layer_0.
7. WHEN successful cutover begins, THE Stage_C_Controller SHALL hide Layer_0 before showing the Floating_Surface.
8. WHEN fallback begins after cutover, THE Stage_C_Controller SHALL hide or close the Floating_Surface before showing Layer_0.
9. WHEN fallback begins before cutover, THE Stage_C_Controller SHALL keep Layer_0 visible while cleaning up the hidden Floating_Surface.
10. WHILE the Floating_Overlay is requested, THE Stage_C_Controller SHALL expose at most one visible floating overlay surface.
11. WHEN fallback executes, THE Stage_C_Controller SHALL preserve the latest Canonical_Overlay_State revision, visibility request, DIP bounds, mode, and Capture_Protection value.
12. WHEN fallback completes, THE Stage_C_Controller SHALL report strategy `LAYER_0`, phase `LAYER_0_ACTIVE`, and the typed Stage C failure reason.
13. WHEN simultaneous timeout, disconnect, process-exit, and capture-verification notifications occur, THE Stage_C_Controller SHALL allow exactly one transition owner to perform visibility and cleanup operations.
14. WHEN a failure notification arrives after completed fallback, THE Stage_C_Controller SHALL leave the recovered Layer_0 state unchanged.
15. WHEN Stage_C fails during an App_Core launch, THE Strategy_Selector SHALL retain Layer_0 for that launch unless the single permitted explicit local diagnostic retry remains unused and is requested.
16. WHEN fallback cleans up a launch, THE Stage_C_Controller SHALL cancel pending sidecar operations, close the endpoint, invalidate the Launch_Credential, and terminate an unhealthy or unresponsive owned sidecar.
17. IF Stage_C_Telemetry fails during fallback, THEN THE Stage_C_Controller SHALL complete fallback without changing the recovery result.

### Requirement 14: Packaging, Manifest, Signing, and Atomic Updates

**User Story:** As a release engineer, I want one verified Stage C package set, so that partial, mismatched, or untrusted artifacts leave Layer 0 active.

#### Acceptance Criteria

1. WHERE Production_Build is active, THE packaging system SHALL assemble App_Core executables, `ZuleUI.exe`, Stage_C_Manifest, Dependency_Lock, packaged overlay resources, Layer_0 source assets, and Layer_0 runtime assets as one version-matched package set under fixed resource paths.
2. THE packaging system SHALL resolve every Stage C artifact from `process.resourcesPath` without PATH or working-directory search.
3. WHERE Production_Build is active, THE packaging system SHALL include one `ZuleUI.exe` whose architecture equals each distributed Windows App_Core architecture.
4. WHERE Production_Build is active, THE packaging system SHALL require valid App_Publisher signatures on the App_Core executable, `ZuleUI.exe`, and installer before package-set acceptance.
5. WHEN final package-set artifacts exist, THE Manifest_Toolchain SHALL serialize Stage_C_Manifest from only those final artifacts.
6. THE Stage_C_Manifest SHALL bind exact App_Core version, sidecar version, architecture, artifact paths, artifact hashes, protocol major and minor, bridge schema, WebView2 minimum, Dependency_Lock hash, capabilities, App_Publisher identity, and release-evidence identifier.
7. WHEN Stage_C_Manifest is loaded, THE Manifest_Toolchain SHALL reject every unknown field, missing field, duplicate field, invalid value, or artifact binding mismatch before Runtime_Probe use.
8. WHEN a valid Stage_C_Manifest model is serialized, parsed, serialized, and parsed, THE Manifest_Toolchain SHALL preserve an equivalent model and identical artifact bindings.
9. WHEN updater stages Stage C, THE updater SHALL stage the complete version-matched package set as one atomic transaction.
10. WHEN updater verifies a staged transaction, THE updater SHALL verify every required artifact, architecture, hash, signature, publisher, exact version, protocol, bridge schema, dependency lock, release evidence, and Layer_0 asset before activation.
11. IF a staged transaction is partial, missing, mismatched, unsigned, invalid, or indeterminate, THEN THE updater SHALL leave the installed package set active and the staged package set inactive.
12. WHEN updater activates a verified staged transaction, THE updater SHALL replace the complete package set atomically while App_Core and the Stage_C_Sidecar are stopped.
13. IF atomic activation fails, THEN THE updater SHALL restore the previously verified complete package set before application startup.
14. WHEN updater rolls back a release, THE updater SHALL restore a version-matched App_Core and Layer_0 without depending on an older sidecar remaining installed.
15. THE packaging system SHALL preserve `ZuleUI.exe` truthful metadata independently of Electron executable metadata.
16. THE application startup SHALL perform zero downloads of native toolchains, SDKs, loaders, or runtime binaries.

### Requirement 15: Content-Free Operational Telemetry

**User Story:** As a privacy-conscious user, I want Stage C diagnostics to exclude secrets and content, so that host observability does not expose sensitive data.

#### Acceptance Criteria

1. THE Stage_C_Telemetry SHALL permit only `eventName`, `timestamp`, `hostStrategy`, `lifecyclePhase`, `durationMs`, `result`, `failureReason`, `measurements`, `osBuild`, `architecture`, `appCoreVersion`, `sidecarVersion`, `protocolVersion`, and `webView2RuntimeVersion` as common fields.
2. THE Stage_C_Telemetry SHALL permit `category`, `direction`, `decodedType`, and `byteCount` only for protocol-rejection events.
3. THE Stage_C_Telemetry SHALL encode `timestamp` as an RFC 3339 UTC value and numeric fields as finite non-negative numbers within their exact schema ranges.
4. THE Stage_C_Telemetry SHALL limit `eventName`, `result`, `failureReason`, `category`, and `decodedType` to 64 UTF-8 bytes per field.
5. THE Stage_C_Telemetry SHALL limit `hostStrategy`, `lifecyclePhase`, `direction`, `osBuild`, and `architecture` to 32 UTF-8 bytes per field.
6. THE Stage_C_Telemetry SHALL limit `appCoreVersion`, `sidecarVersion`, `protocolVersion`, and `webView2RuntimeVersion` to 64 UTF-8 bytes per field.
7. THE Stage_C_Telemetry SHALL limit `measurements` to 16 exact-schema entries with keys no longer than 64 UTF-8 bytes.
8. THE Stage_C_Telemetry SHALL limit each serialized event to 4,096 UTF-8 bytes.
9. WHEN a Stage_C_Telemetry event is created, THE Stage_C_Controller SHALL validate every field, value, count, and byte bound before local recording or transmission.
10. IF a Stage_C_Telemetry event contains an unknown field or exceeds any field, count, value, or event-size bound, THEN THE Stage_C_Controller SHALL discard the complete event.
11. THE Stage_C_Telemetry SHALL contain zero bootstrap records, Launch_Credentials, endpoint values, provider credentials, prompts, responses, transcripts, entered text, audio, screenshots, OCR data, captured content, Protocol_Envelope payloads, or message payload text.
12. WHEN a protocol-rejection event is accepted, THE Stage_C_Telemetry SHALL contain only the permitted rejection fields and applicable common fields.
13. WHERE application telemetry is disabled, THE Stage_C_Controller SHALL retain Stage C events only in the existing governed local diagnostic channel.
14. IF telemetry recording or transmission fails, THEN THE Stage_C_Controller SHALL preserve validation, sidecar supervision, message rejection, and fallback outcomes.

### Requirement 16: Windows Isolation and Existing Platform Behavior

**User Story:** As a cross-platform maintainer, I want Stage C isolated to Windows, so that native changes cannot alter existing macOS or Linux behavior.

#### Acceptance Criteria

1. WHERE `process.platform` is not `win32`, THE Strategy_Selector SHALL select Layer_0.
2. WHERE `process.platform` is not `win32`, THE Stage_C_Controller SHALL perform zero Stage C manifest probes, native module loads, endpoint creations, runtime queries, or sidecar launches.
3. WHERE `process.platform` is not `win32`, THE App_Core SHALL preserve the existing platform-specific Layer_0 behavior.
4. WHERE `process.platform` is `win32`, THE Stage_C_Controller SHALL load Stage C native boundaries only after the Windows platform guard succeeds.
5. IF a Windows-only native boundary fails to load, THEN THE Stage_C_Controller SHALL retain Layer_0 and report a typed content-free failure.
6. THE Stage_C_Sidecar SHALL load operating-system system libraries through the operating-system system-library search policy without app-local replacement-DLL search.
7. THE Stage_C_Controller SHALL restrict every Stage C use of the existing native interop boundary to Windows and convert each load or call failure into Layer_0 retention.

### Requirement 17: Measurable Production Release Gates

**User Story:** As a release owner, I want complete falsifiable evidence, so that Stage C remains disabled until every supported environment passes.

#### Acceptance Criteria

1. THE Stage_C_Release_Gate SHALL enumerate an exact environment matrix containing Windows 10 22H2, each supported Windows 11 23H2-or-newer build, each distributed architecture, and each WebView2_Runtime version declared for production support.
2. WHEN the Stage_C_Release_Gate executes, THE Release_Gate_Harness SHALL execute every applicable gate for every environment-matrix row.
3. WHEN a gate result is recorded, THE Release_Gate_Harness SHALL bind test build hash, OS build, architecture, WebView2_Runtime version, App_Core version, sidecar version, raw measurement summary, and pass-or-fail result.
4. WHEN the metadata gate executes, THE Release_Gate_Harness SHALL complete 30 cold launches per environment with class exactly `ZuleUIWindow`, image exactly `ZuleUI.exe`, `OriginalFilename` exactly `ZuleUI.exe`, `CompanyName` and `ProductName` exactly `Zule AI`, a blank title only on the Floating_Surface, and zero Floating_Overlay top-level `Chrome_WidgetWin` windows.
5. WHEN the scope-and-honesty gate executes, THE Release_Gate_Harness SHALL verify continued Dashboard, process, module, child-window, and WebView2_Runtime observability with zero undetectability, evasion, capture-impossibility, or impersonation claims in release material.
6. WHEN the runtime-probe gate executes, THE Release_Gate_Harness SHALL complete 30 cold probes per environment with each successful probe completing within 3 seconds and each failed probe starting zero sidecar processes.
7. WHEN the startup gate executes, THE Release_Gate_Harness SHALL complete 30 cold launches per environment with authentication, Ready_Handshake, snapshot acknowledgement, and first-frame readiness occurring in that order within 3 seconds and with 95th-percentile startup duration no greater than 2 seconds.
8. WHEN the transparency gate executes, THE Release_Gate_Harness SHALL test compact, expanded, and maximized states at 100%, 125%, 150%, and 200% scale with zero nonzero-alpha pixels in declared transparent regions and partial-alpha error no greater than one 8-bit unit.
9. WHEN the input gate executes, THE Release_Gate_Harness SHALL run 100 click targets, 100 keyboard and IME actions, 100 vertical and horizontal scroll actions, and 20 drags per tested scale with zero misroutes, coordinate error no greater than 1 physical pixel, and zero retained pointer captures.
10. WHEN the geometry gate executes, THE Release_Gate_Harness SHALL test scale factors 100%, 125%, 150%, 175%, 200%, 250%, and 300% across move, resize, nudge, recenter, snap, maximize, restore, monitor crossing, monitor removal, negative coordinates, DPI change, rotation, and work-area change with final edge error no greater than 1 physical pixel and a reachable Floating_Surface.
11. WHEN the Local_IPC security gate executes, THE Release_Gate_Harness SHALL verify authentication failure, expired credential, replay, reversed-direction type, unknown type, malformed UTF-8, malformed JSON, extra field, missing field, invalid schema, invalid revision, incompatible version, 1,048,577-byte frame, replay-cache bound, 257-message queue, and 1,048,577-byte queue cases with zero App_Core state mutations and zero service invocations.
12. WHEN the bridge security gate executes, THE Release_Gate_Harness SHALL reject every unlisted bridge method or event and every 65,537-byte bridge message with zero native side effects.
13. WHEN the capture gate executes, THE Release_Gate_Harness SHALL complete 20 enable-disable cycles per environment with read-back equal to each request within 100 milliseconds and observed results matching Layer_0 in Electron desktop capture and an external Windows Graphics Capture recorder.
14. WHEN the capture-fallback gate executes, THE Release_Gate_Harness SHALL inject application failure, read-back failure, read-back mismatch, and read-back timeout with Layer_0 usable within 500 milliseconds and zero intervals in which both surfaces remain hidden beyond that deadline.
15. WHEN the fallback gate executes, THE Release_Gate_Harness SHALL inject every probe, endpoint, launch, authentication, handshake, WebView2, bridge, composition, snapshot, first-frame, disconnect, timeout, and crash failure 10 times with Layer_0 recovery, zero duplicate visible surfaces, and notification-to-recovery duration no greater than 500 milliseconds.
16. WHEN the diagnostic-retry gate executes, THE Release_Gate_Harness SHALL verify one accepted retry and rejection of every later retry in the same App_Core launch.
17. WHEN the performance gate executes, THE Release_Gate_Harness SHALL sustain at least 30 presented frames per second and a 95th-percentile local UI-intent round trip no greater than 50 milliseconds during a 10-minute expanded-overlay run.
18. WHEN the stability gate executes, THE Release_Gate_Harness SHALL complete a 60-minute interaction soak and 100 start-stop cycles with zero App_Core crashes, zero sidecar crashes, zero orphan processes, zero leaked top-level sidecar windows, and sidecar private-memory growth no greater than 50 MiB after warm-up.
19. WHEN the packaging gate executes, THE Release_Gate_Harness SHALL verify complete package-set presence, architecture equality, hashes, App_Publisher signatures, Stage_C_Manifest bindings, exact versions, protocol, bridge schema, Dependency_Lock, atomic updater behavior, rollback behavior, evidence binding, and Layer_0 availability for every production artifact set.
20. WHEN the telemetry-privacy gate executes, THE Release_Gate_Harness SHALL inject unique canaries into every prohibited secret and content category and observe zero canary values in recorded or transmitted Stage_C_Telemetry.
21. WHEN the telemetry-schema gate executes, THE Release_Gate_Harness SHALL verify rejection of each unknown field, each field-size overflow, each count overflow, and each 4,097-byte event.
22. WHEN state-update performance is tested, THE Release_Gate_Harness SHALL verify the 256-message and 1,048,576-byte queue bounds, revision-correlated acknowledgements, latest-value geometry and visibility operations, coalescing only of superseded intermediate render patches, and preservation of terminal and error transitions.
23. IF an environment row, gate result, raw measurement, artifact binding, or required evidence field is missing, THEN THE Stage_C_Release_Gate SHALL mark the production decision as failed.
24. THE Stage_C_Release_Gate SHALL approve Stage_C only when every gate has complete passing evidence for every required environment-matrix row and distributed artifact.
25. IF any gate fails or lacks complete evidence, THEN THE Strategy_Selector SHALL keep Stage_C disabled in Production_Build and select Layer_0.
26. THE Strategy_Selector SHALL reject production gate waivers supplied through runtime flags, environment variables, persisted settings, remote content, or diagnostic retry.

### Requirement 18: Protected Layer 0 Behavior and Tests

**User Story:** As a maintainer, I want Layer 0 protected from Stage C changes, so that the permanent fallback retains proven behavior.

#### Acceptance Criteria

1. THE Stage_C_Controller SHALL preserve the existing Layer_0 source, assets, BrowserWindow creation, renderer route, startup support, and capture logic in every Stage C package.
2. THE Stage_C_Controller SHALL access Layer_0 operations through an adapter without rewriting existing Layer_0 behavior.
3. THE Stage_C_Controller SHALL preserve the existing Layer_0 preload and main-process channel inventory without modification.
4. THE App_Core SHALL preserve the existing Dashboard startup behavior without modification.
5. THE Stage_C_Controller SHALL preserve the existing Layer_0 lifecycle ordering and single-window Mode 2 transition behavior without modification.
6. THE Stage_C_Controller SHALL preserve the existing Layer_0 geometry, Capture_Protection, and drag/no-drag CSS behavior without modification.
7. WHEN the test suite executes, THE Protected_Layer_0_Tests SHALL pass without modification to either protected test.
8. IF a Stage C change requires modification, deletion, replacement, renaming, skipping, or expectation weakening in a Protected_Layer_0_Test, THEN THE release process SHALL reject the Stage C change as a design violation.
9. WHEN Stage_C is unavailable, disabled, probing, starting, failing, or recovering, THE App_Core SHALL retain a usable Layer_0 path.