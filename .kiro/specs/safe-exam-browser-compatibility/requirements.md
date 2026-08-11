# Requirements Document

## Introduction

Safe Exam Browser Compatibility provides a restricted operating mode for Zule when an institution explicitly permits Zule as a companion application for an approved accessibility, proctoring, support, or other permitted workflow. The feature does not make Zule generally compatible with secured exams and does not authorize AI assistance, capture, transcription, or external communication unless an institution explicitly approves each capability for the specific assessment context.

Zule currently uses an Electron App Core, a Dashboard, a Floating Overlay, preload-mediated IPC, microphone and system-audio transcription, screen capture and OCR, AI-provider routing, global shortcuts, capture exclusion, and native window-host strategies. Several current behaviors conflict with an SEB-controlled environment. This feature therefore introduces a separate fail-closed compatibility mode that excludes Zule's concealment-oriented overlay paths and preserves SEB authority.

The official [SEB Windows manual](https://safeexambrowser.org/windows/win_usermanual_en.html) documents administrator-configured third-party applications through Permitted Processes and warns that such applications require additional institutional security controls. The official [SEB integration documentation](https://www.safeexambrowser.org/developer/seb-integration.html) documents integration with exam solutions and administrator-controlled configuration, but does not document a Zule-specific companion integration. Accordingly, Zule-specific official support is `NOT_DOCUMENTED`; deployment is eligible only through an institution-approved SEB configuration and a validated official SEB mechanism. If a target SEB version, platform, kiosk mode, or institutional policy does not permit Zule, the feature remains unavailable.

Content from the official SEB sources was rephrased for compliance with licensing restrictions.

## Glossary

- **Zule**: The complete Zule desktop application.
- **App_Core**: Zule's Electron main process and renderer services, which own application state, IPC, capture, transcription, AI routing, storage, and lifecycle.
- **Dashboard**: Zule's standard Electron application window.
- **Floating_Overlay**: Zule's always-on-top floating copilot window.
- **Overlay_Manager**: The App_Core component that creates and controls the Floating_Overlay.
- **Safe_Exam_Browser**: The official Safe Exam Browser application, abbreviated as SEB, that enforces an institution-defined kiosk and assessment configuration.
- **SEB_Configuration**: The institution-controlled Safe Exam Browser settings for a specific assessment or managed client.
- **Institution_Administrator**: An authorized representative who configures the assessment, SEB_Configuration, and permitted companion workflows.
- **Candidate**: The person participating in the institution-configured workflow.
- **Approved_Workflow**: An accessibility, proctoring, support, or companion workflow explicitly authorized by the Institution_Administrator.
- **Authorization_Record**: Institution-issued data that identifies the institution, Approved_Workflow, allowed capabilities, target assessment context, applicable SEB versions and platforms, validity interval, and policy identifier.
- **Capability_Policy**: The allowlist of Zule capabilities contained in the Authorization_Record.
- **Compatibility_Feature**: The Zule feature defined by this document.
- **SEB_Compatibility_Mode**: Zule's restricted runtime state for an authorized Approved_Workflow.
- **Compatibility_Controller**: The App_Core component that validates authorization, evaluates eligibility, enforces the Capability_Policy, and controls SEB_Compatibility_Mode.
- **Compatibility_Probe**: A read-only check that determines whether the target platform, Zule release, SEB release, SEB_Configuration, and Authorization_Record satisfy the validated compatibility rules.
- **Permitted_Process**: A third-party application explicitly configured by an Institution_Administrator through SEB's official permitted-process mechanism.
- **Official_Mechanism**: A configuration or integration path documented by the Safe Exam Browser project for the target SEB release and platform.
- **Validated_Compatibility_Matrix**: A release-controlled list of tested combinations of Zule version, official SEB version, operating system, kiosk mode, and enabled Zule capabilities.
- **Visible_Companion_Surface**: The truthful, user-visible Zule window used during SEB_Compatibility_Mode.
- **Restricted_Capability**: Screen capture, OCR, microphone capture, system-audio capture, transcription, AI generation, external provider communication, knowledge retrieval, local file access, clipboard access, or another capability that can expose assessment information or provide assistance.
- **Security_Control**: An SEB or institution control, including kiosk restrictions, process monitoring, application blocking, URL filtering, assessment configuration, screen-capture protection, keyboard restrictions, task switching, display restrictions, network policy, and session termination policy.
- **Sensitive_Content**: Exam questions, Candidate answers, screenshots, OCR text, transcripts, audio, prompts, AI responses, credentials, tokens, personal data, and protected assessment URLs.
- **Content_Free_Audit_Event**: An audit record containing only allowlisted operational metadata and no Sensitive_Content.
- **Fail_Closed_State**: A state in which Zule withholds the requested companion capability and preserves SEB control.
- **Official_Support_Status**: One of `NOT_DOCUMENTED`, `VALIDATED_OFFICIAL_MECHANISM`, `UNSUPPORTED_TARGET`, or `REVOKED`.
## Requirements

### Requirement 1: Administrator Authorization and Official Support Gate

**User Story:** As an Institution_Administrator, I want compatibility enabled only for approved configurations, so that Zule cannot self-authorize use with Safe_Exam_Browser.

#### Acceptance Criteria

1. THE Compatibility_Feature SHALL use `Disabled` as the default state for every Zule installation.
2. WHEN an Institution_Administrator requests SEB_Compatibility_Mode, THE Compatibility_Controller SHALL require an Authorization_Record for the current Approved_Workflow.
3. WHEN the Compatibility_Controller evaluates an Authorization_Record, THE Compatibility_Controller SHALL verify the institution identifier, policy identifier, assessment-context identifier, validity interval, Zule release, SEB release, operating system, and Capability_Policy.
4. WHEN the Compatibility_Controller evaluates SEB eligibility, THE Compatibility_Controller SHALL require Zule to be configured as a Permitted_Process through an Official_Mechanism.
5. WHEN the Compatibility_Controller evaluates SEB eligibility, THE Compatibility_Controller SHALL require an exact match in the Validated_Compatibility_Matrix.
6. IF the Authorization_Record is absent, expired, revoked, malformed, or mismatched, THEN THE Compatibility_Controller SHALL enter the Fail_Closed_State.
7. IF the target SEB release, platform, or kiosk mode lacks an Official_Mechanism that permits the Approved_Workflow, THEN THE Compatibility_Controller SHALL set Official_Support_Status to `UNSUPPORTED_TARGET` and enter the Fail_Closed_State.
8. WHILE Zule-specific integration remains absent from official SEB documentation, THE Compatibility_Controller SHALL report Official_Support_Status as `NOT_DOCUMENTED` unless a validated Permitted_Process deployment applies.
9. WHEN an approved Permitted_Process deployment passes release validation, THE Compatibility_Controller SHALL report Official_Support_Status as `VALIDATED_OFFICIAL_MECHANISM` for only the matching Validated_Compatibility_Matrix entry.
10. THE Compatibility_Feature SHALL provide zero candidate-controlled settings that create, expand, extend, or override an Authorization_Record.
11. THE Compatibility_Feature SHALL provide zero automatic modifications to SEB_Configuration.

### Requirement 2: Preservation of SEB Security Authority

**User Story:** As an Institution_Administrator, I want Safe_Exam_Browser to retain security authority, so that Zule cannot weaken the configured assessment environment.

#### Acceptance Criteria

1. THE Compatibility_Feature SHALL perform zero modifications to Safe_Exam_Browser binaries, services, processes, memory, configuration stores, or runtime state.
2. THE Compatibility_Feature SHALL perform zero injection, hooking, reparenting, patching, debugging, impersonation, or inter-process manipulation against Safe_Exam_Browser.
3. THE Compatibility_Feature SHALL perform zero attempts to disable, evade, or alter kiosk restrictions.
4. THE Compatibility_Feature SHALL perform zero attempts to disable, evade, or alter process monitoring.
5. THE Compatibility_Feature SHALL perform zero attempts to disable, evade, or alter application blocking or prohibited-process handling.
6. THE Compatibility_Feature SHALL perform zero attempts to disable, evade, or alter URL filtering or navigation policy.
7. THE Compatibility_Feature SHALL perform zero attempts to read, decrypt, generate, replace, or alter assessment-specific SEB_Configuration without Institution_Administrator authorization through an Official_Mechanism.
8. THE Compatibility_Feature SHALL perform zero attempts to disable, evade, or alter Safe_Exam_Browser screen-capture protections.
9. THE Compatibility_Feature SHALL perform zero attempts to disable, evade, or alter keyboard, task-switching, clipboard, display, network, quit, or session controls.
10. IF a Security_Control prevents a Zule operation, THEN THE Compatibility_Controller SHALL deny the operation and preserve the Security_Control result.
11. THE Compatibility_Feature SHALL provide zero fallback paths that weaken a Security_Control after a denied operation.
12. THE Compatibility_Feature SHALL use only public operating-system interfaces and Official_Mechanisms for coexistence with Safe_Exam_Browser.

### Requirement 3: Truthful, Visible, Non-Stealth Operation

**User Story:** As a Candidate, I want Zule's authorized activity to remain visible, so that the companion workflow cannot operate through concealment.

#### Acceptance Criteria

1. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL use the Visible_Companion_Surface as the only interactive Zule surface.
2. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL keep the Floating_Overlay unavailable.
3. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL keep native stealth host strategies unavailable.
4. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL keep screen-capture exclusion disabled on every Zule window.
5. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL keep Zule windows out of hidden, randomized, generic, or third-party-identifying window metadata states.
6. THE Visible_Companion_Surface SHALL display the Zule product name, institution name, Approved_Workflow, active Capability_Policy summary, and Official_Support_Status.
7. WHILE SEB_Compatibility_Mode is active, THE Visible_Companion_Surface SHALL display a persistent `Institution-authorized SEB companion` status indicator.
8. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL register zero global shortcuts that hide, reveal, move, or elevate a Zule surface outside Safe_Exam_Browser task-switching policy.
9. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL request zero always-on-top levels that place Zule above the Safe_Exam_Browser-controlled workspace.
10. THE Compatibility_Feature SHALL use stable Zule-owned executable, publisher, process, class, title, and version metadata.
11. THE Compatibility_Feature SHALL make zero claims of invisibility, undetectability, monitoring evasion, or guaranteed coexistence with Safe_Exam_Browser.
12. IF Safe_Exam_Browser hides, blocks, or terminates Zule, THEN THE Compatibility_Controller SHALL treat the result as an authorization or compatibility denial without relaunching Zule during the assessment context.
### Requirement 4: Consent and Session Activation

**User Story:** As a Candidate, I want informed consent and clear session boundaries, so that authorized companion capabilities do not start without notice.

#### Acceptance Criteria

1. WHEN an eligible Approved_Workflow is requested, THE Compatibility_Controller SHALL present the Candidate with the institution name, assessment context, approved purpose, allowed capabilities, data destinations, retention policy, and support contact before activating a Restricted_Capability.
2. WHEN Candidate consent is required by the Authorization_Record, THE Compatibility_Controller SHALL require an affirmative consent action before activating SEB_Compatibility_Mode.
3. IF Candidate consent is declined or withdrawn, THEN THE Compatibility_Controller SHALL enter the Fail_Closed_State and release active Restricted_Capability resources within 2 seconds.
4. WHEN Candidate consent is recorded, THE Compatibility_Controller SHALL record the policy identifier, consent timestamp, Zule version, and authorization result without recording Sensitive_Content.
5. WHILE SEB_Compatibility_Mode is active, THE Visible_Companion_Surface SHALL provide a single-action control for stopping Zule's companion session.
6. WHEN the Candidate stops the companion session, THE Compatibility_Controller SHALL stop each active Restricted_Capability within 2 seconds.
7. WHEN Safe_Exam_Browser exits or the assessment context ends, THE Compatibility_Controller SHALL exit SEB_Compatibility_Mode within 2 seconds of receiving the corresponding supported lifecycle signal.
8. IF a supported Safe_Exam_Browser lifecycle signal is unavailable, THEN THE Compatibility_Controller SHALL require an Institution_Administrator-defined explicit session-end action and display the active status until that action occurs.
9. WHEN SEB_Compatibility_Mode exits, THE Compatibility_Controller SHALL clear assessment-scoped in-memory Sensitive_Content before permitting a standard Zule session.

### Requirement 5: Capability Allowlisting and Unauthorized-Assistance Prevention

**User Story:** As an Institution_Administrator, I want capability-level enforcement, so that Zule provides only the approved companion function.

#### Acceptance Criteria

1. THE Capability_Policy SHALL identify each permitted Restricted_Capability individually.
2. THE Compatibility_Controller SHALL deny every Restricted_Capability absent from the Capability_Policy.
3. THE Compatibility_Controller SHALL use denied as the default decision for a Restricted_Capability whose policy value is missing, unknown, or ambiguous.
4. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL disable autonomous question detection unless the Capability_Policy explicitly permits autonomous question detection.
5. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL disable AI response generation unless the Capability_Policy explicitly permits AI response generation for the Approved_Workflow.
6. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL disable manual prompting unless the Capability_Policy explicitly permits manual prompting for the Approved_Workflow.
7. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL disable Knowledge Base retrieval unless the Capability_Policy explicitly permits the identified knowledge corpus.
8. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL disable screen capture, keyframe collection, OCR, and screen-derived context unless an Official_Mechanism and the Capability_Policy explicitly permit each capability.
9. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL disable microphone capture, system-audio capture, and transcription unless the Capability_Policy explicitly permits each capability.
10. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL disable provider communication to every endpoint absent from the Capability_Policy endpoint allowlist.
11. WHEN an allowed capability processes assessment information, THE Compatibility_Controller SHALL limit processing to the purpose, data categories, destinations, and retention interval in the Authorization_Record.
12. IF a requested operation could provide assistance beyond the Approved_Workflow, THEN THE Compatibility_Controller SHALL deny the operation and emit one Content_Free_Audit_Event.
13. IF a capability-policy decision cannot be evaluated before an operation starts, THEN THE Compatibility_Controller SHALL deny the operation.
14. THE Compatibility_Feature SHALL provide zero candidate-controlled mechanisms for changing the Capability_Policy during the assessment context.

### Requirement 6: Compatibility Probe and Fail-Closed Runtime

**User Story:** As a support operator, I want deterministic compatibility checks, so that unsupported environments do not enter a partially enabled state.

#### Acceptance Criteria

1. WHEN Zule receives a request for SEB_Compatibility_Mode, THE Compatibility_Probe SHALL complete before any Restricted_Capability starts.
2. WHEN the Compatibility_Probe executes, THE Compatibility_Probe SHALL inspect only the Zule version, operating-system version, configured SEB version, approved kiosk-mode identifier, Authorization_Record, and institution-provided configuration evidence.
3. THE Compatibility_Probe SHALL perform zero reads of Safe_Exam_Browser process memory, private IPC, secrets, or decrypted assessment configuration.
4. THE Compatibility_Probe SHALL perform zero changes to Safe_Exam_Browser or SEB_Configuration.
5. WHEN every required eligibility check succeeds, THE Compatibility_Probe SHALL return `ELIGIBLE` with the matching Validated_Compatibility_Matrix entry identifier.
6. IF any required eligibility check fails, THEN THE Compatibility_Probe SHALL return one typed content-free failure reason and enter the Fail_Closed_State.
7. IF the Compatibility_Probe exceeds 3 seconds, THEN THE Compatibility_Controller SHALL enter the Fail_Closed_State with `PROBE_TIMEOUT`.
8. WHILE the Fail_Closed_State is active, THE Compatibility_Controller SHALL keep every Restricted_Capability stopped.
9. WHILE the Fail_Closed_State is active, THE Visible_Companion_Surface SHALL show the failure category and institution support contact without displaying Sensitive_Content.
10. WHEN authorization expires or is revoked during SEB_Compatibility_Mode, THE Compatibility_Controller SHALL stop each Restricted_Capability within 2 seconds and enter the Fail_Closed_State.
11. WHEN the runtime environment diverges from the selected Validated_Compatibility_Matrix entry, THE Compatibility_Controller SHALL stop each Restricted_Capability within 2 seconds and enter the Fail_Closed_State.
12. IF the Compatibility_Controller crashes or restarts during the assessment context, THEN THE Compatibility_Feature SHALL restart in the Fail_Closed_State without automatically resuming a Restricted_Capability.
### Requirement 7: Architecture Isolation and Least Privilege

**User Story:** As a maintainer, I want the compatibility path isolated from Zule's ordinary overlay path, so that existing concealment and capture features cannot leak into an SEB session.

#### Acceptance Criteria

1. THE Compatibility_Controller SHALL remain inside the App_Core and use the existing context-isolated preload IPC boundary for renderer requests.
2. THE Compatibility_Feature SHALL create zero direct renderer access to Node.js, Safe_Exam_Browser processes, operating-system process control, or SEB_Configuration.
3. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL block Overlay_Manager creation of the Floating_Overlay.
4. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL block Stage A, Stage B, Stage C, reparenting, layered-window, and native-stealth host selection.
5. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL block Zule's panic-hide and bring-to-front shortcut actions.
6. WHILE SEB_Compatibility_Mode is active, THE Compatibility_Controller SHALL prevent App_Core startup switches from disabling accessibility exposure for concealment purposes.
7. WHEN a renderer requests a Restricted_Capability, THE App_Core SHALL validate the current session identifier and Capability_Policy before invoking the corresponding service.
8. WHEN a renderer request carries an unknown field, unknown capability, stale session identifier, or invalid value, THE App_Core SHALL reject the request with zero capability invocations.
9. THE Compatibility_Feature SHALL expose only capability-specific IPC operations required by the Approved_Workflow.
10. THE Compatibility_Feature SHALL expose zero generic command, shell, process, filesystem, registry, URL-launch, or arbitrary IPC operations.
11. WHEN SEB_Compatibility_Mode exits, THE Compatibility_Controller SHALL invalidate the assessment-scoped session identifier before returning control to the standard Zule lifecycle.

### Requirement 8: Data Minimization, Network Control, and Retention

**User Story:** As a privacy reviewer, I want assessment data minimized and bounded, so that approved use does not create an unnecessary record of exam content.

#### Acceptance Criteria

1. THE Compatibility_Feature SHALL collect only data categories explicitly listed in the Authorization_Record.
2. THE Compatibility_Feature SHALL transmit data only to destinations explicitly listed in the Capability_Policy endpoint allowlist.
3. THE Compatibility_Feature SHALL use encrypted transport with certificate validation for each permitted network destination.
4. IF a network destination is absent from the endpoint allowlist, THEN THE Compatibility_Controller SHALL deny the transmission before opening the request.
5. IF certificate validation fails, THEN THE Compatibility_Controller SHALL deny the transmission without retrying through a weaker transport.
6. THE Compatibility_Feature SHALL exclude provider credentials, authorization secrets, and Candidate identity data from renderer logs and Content_Free_Audit_Event records.
7. THE Compatibility_Feature SHALL exclude exam questions, Candidate answers, screenshots, OCR text, transcripts, audio, prompts, and AI responses from Content_Free_Audit_Event records.
8. WHERE the Authorization_Record permits transient processing only, THE Compatibility_Controller SHALL retain Sensitive_Content in memory for no longer than the active operation and clear the content when the operation completes.
9. WHERE the Authorization_Record permits assessment-scoped persistence, THE Compatibility_Controller SHALL delete persisted Sensitive_Content at the earlier of the configured retention deadline or session-end cleanup.
10. IF required retention or deletion controls are unavailable, THEN THE Compatibility_Controller SHALL deny the affected Restricted_Capability.
11. WHEN SEB_Compatibility_Mode exits, THE Compatibility_Controller SHALL cancel in-flight network requests associated with the assessment-scoped session identifier.
12. WHEN SEB_Compatibility_Mode exits, THE Compatibility_Controller SHALL prevent assessment-scoped Sensitive_Content from entering standard Zule chat history, meeting history, semantic cache, response cache, Knowledge Base, or summary storage.

### Requirement 9: Content-Free Auditability

**User Story:** As an Institution_Administrator, I want content-free audit evidence, so that approved use and policy enforcement can be reviewed without collecting exam material.

#### Acceptance Criteria

1. WHEN the Compatibility_Controller evaluates authorization, THE Compatibility_Controller SHALL emit one Content_Free_Audit_Event containing timestamp, institution identifier, policy identifier, Zule version, SEB version, matrix entry identifier, decision, and typed reason.
2. WHEN SEB_Compatibility_Mode starts or stops, THE Compatibility_Controller SHALL emit one Content_Free_Audit_Event containing timestamp, session identifier, transition, and policy identifier.
3. WHEN a Restricted_Capability starts, stops, succeeds, or is denied, THE Compatibility_Controller SHALL emit one Content_Free_Audit_Event containing timestamp, session identifier, capability identifier, outcome, and typed reason.
4. WHEN runtime eligibility changes, THE Compatibility_Controller SHALL emit one Content_Free_Audit_Event containing timestamp, session identifier, prior state, next state, and typed reason.
5. THE Compatibility_Feature SHALL enforce an exact field allowlist for every Content_Free_Audit_Event type.
6. THE Compatibility_Feature SHALL reject an audit event containing a field outside the exact field allowlist.
7. THE Compatibility_Feature SHALL limit each Content_Free_Audit_Event to 4,096 UTF-8 bytes.
8. THE Compatibility_Feature SHALL protect audit records from Candidate modification using operating-system access controls available to the Zule installation context.
9. WHERE institution audit export is authorized, THE Compatibility_Feature SHALL export only Content_Free_Audit_Event records for the selected policy identifier and time range.
10. IF audit recording required by the Authorization_Record is unavailable, THEN THE Compatibility_Controller SHALL deny activation of SEB_Compatibility_Mode.
11. IF audit recording fails during SEB_Compatibility_Mode, THEN THE Compatibility_Controller SHALL stop each Restricted_Capability within 2 seconds and enter the Fail_Closed_State.
### Requirement 10: Release Validation and Institutional Deployment

**User Story:** As a release manager, I want compatibility released only with target-specific evidence, so that a generic claim does not replace institutional testing.

#### Acceptance Criteria

1. THE Validated_Compatibility_Matrix SHALL identify the exact Zule version, official SEB version, operating-system version range, kiosk mode, Official_Mechanism, and permitted Capability_Policy for each entry.
2. WHEN any matrix dimension changes, THE Compatibility_Feature SHALL require a new validation result before selecting the changed combination.
3. THE release process SHALL require evidence that Safe_Exam_Browser can start, monitor, switch to, hide, block, and terminate Zule according to the tested SEB_Configuration.
4. THE release process SHALL require evidence that Zule performs zero modification of each Security_Control listed in Requirement 2.
5. THE release process SHALL require evidence that the Floating_Overlay, native stealth, capture exclusion, global hide shortcuts, unauthorized capture, and unauthorized AI remain unavailable during SEB_Compatibility_Mode.
6. THE release process SHALL require evidence that authorization loss, audit failure, policy mismatch, process blocking, and probe timeout each produce the Fail_Closed_State.
7. THE release process SHALL require Institution_Administrator acceptance for the exact SEB_Configuration before deployment to Candidates.
8. THE release process SHALL keep a matrix entry disabled until every mandatory validation result passes.
9. IF an official SEB update removes or changes the applicable Official_Mechanism, THEN THE release process SHALL set affected matrix entries to `REVOKED` before distributing compatibility enablement for the updated SEB release.
10. THE Product_Documentation SHALL identify `NOT_DOCUMENTED` as the Zule-specific official support status until official Zule-specific documentation or equivalent written approval exists.
11. THE Product_Documentation SHALL state that SEB Permitted_Process support does not constitute blanket approval for Zule capabilities.
12. THE Product_Documentation SHALL direct Candidates to the Institution_Administrator rather than providing instructions for changing SEB_Configuration.
13. THE Product_Documentation SHALL provide zero instructions for bypassing a Security_Control, concealing Zule, or obtaining unauthorized assistance.

### Requirement 11: Accessible and Actionable Status

**User Story:** As a Candidate using an approved accommodation, I want accessible status and error information, so that compatibility failures do not create ambiguous exam conditions.

#### Acceptance Criteria

1. THE Visible_Companion_Surface SHALL expose the current authorization state, active capabilities, capture states, network state, audit state, and session state through visible text.
2. THE Visible_Companion_Surface SHALL expose each status value through programmatic accessibility semantics.
3. WHEN a capability is denied, THE Visible_Companion_Surface SHALL identify the denied capability, typed reason, and institution support contact without displaying Sensitive_Content.
4. WHEN SEB_Compatibility_Mode enters the Fail_Closed_State, THE Visible_Companion_Surface SHALL announce the state change through an accessibility live region within 1 second.
5. WHILE SEB_Compatibility_Mode is active, THE Visible_Companion_Surface SHALL provide keyboard access to every Candidate-operable control permitted by Safe_Exam_Browser.
6. IF Safe_Exam_Browser blocks the Visible_Companion_Surface, THEN THE Compatibility_Controller SHALL record one Content_Free_Audit_Event without attempting a concealed alternative surface.
7. THE Product_Documentation SHALL distinguish a Zule compatibility denial from a Safe_Exam_Browser failure.
8. THE Product_Documentation SHALL state that the Institution_Administrator controls assessment authorization and SEB_Configuration.
