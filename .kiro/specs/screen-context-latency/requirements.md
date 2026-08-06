# Requirements Document

## Introduction

The "Use Screen" feature attaches the user's screen as context for an AI
question. Today, pressing the button starts a chain of work that is almost
entirely serialized ahead of the provider request, so the user waits several
seconds before a single token appears:

1. `FloatingCopilot.handleUseScreen` polls for video readiness with a 2 000 ms
   safety timeout before it fires the request.
2. `triggerAI` awaits `useScreenCapture.captureTextNow()` — a full-page
   Tesseract OCR pass over a 1 280 px frame — before it builds the context
   window or opens the provider connection.
3. Because `stopCapture` calls `terminateOcrWorker()`, the first OCR pass after
   every attach also pays the dynamic `import('tesseract.js')`, `createWorker`,
   and language-pack load inside that same awaited call.
4. When the active adapter supports image input, the request carries *both* the
   OCR text and a JPEG keyframe. The OCR text is largely redundant for a vision
   model, and it inflates the prompt, which delays time-to-first-token.
5. `getImageData`, `phash`, and `toDataURL` all run synchronously on the
   renderer's main thread over a 1 280 px canvas, so the overlay stops painting
   while a frame is prepared.
6. The Semantic_Cache is bypassed entirely whenever screen context is armed,
   because its key is the query text alone. Re-asking about an unchanged screen
   therefore always pays the full cost.

This feature reduces the user-perceived latency of a screen-context question by
restructuring *when* and *where* that work happens, without changing the
answers the user gets. It is scoped to the screen/OCR path only; the embedding,
ANN-search, and VAD work is covered by the separate
`ai-pipeline-performance` spec.

The offline-first constraint is preserved: no new network endpoint, no new
model file, and no new cloud dependency.

## Glossary

- **Screen_Capture_Hook**: The renderer hook `src/hooks/useScreenCapture.ts`
  that owns the `getDisplayMedia` stream, the off-screen `<video>` sink, the
  periodic OCR loop, the perceptual-hash gate, and the OCR ring buffer.
- **Use_Screen_Action**: The `handleUseScreen` callback in
  `src/components/FloatingCopilot.tsx`, invoked by the Use Screen button in
  `InputBar`.
- **AI_Request_Path**: The `triggerAI` callback in
  `src/components/FloatingCopilot.tsx`, which assembles context via
  `buildContextWindow` and streams a response via `streamAIResponse`.
- **OCR_Service**: The Tesseract.js wrapper in `src/workers/ocrWorker.ts`
  (`getOcrWorker`, `recognizeText`, `terminateOcrWorker`) and its `OcrWatchdog`
  supervisor.
- **OCR_Worker**: The Tesseract.js worker instance held by the OCR_Service.
- **Screen_Text**: The recognized text for the current frame, held in
  `screenText` / `screenTextRef` and passed to `buildContextWindow`.
- **Keyframe**: The downscaled frame encoded as a base64 JPEG by
  `getKeyframeBase64`, attached as image context when the adapter supports
  image input.
- **Vision_Adapter**: An active provider adapter for which
  `activeAdapterSupportsImageInput()` returns `true`.
- **Text_Only_Adapter**: An active provider adapter for which
  `activeAdapterSupportsImageInput()` returns `false`.
- **Frame_Hash**: The perceptual hash of a downscaled frame, produced by
  `phash` in `src/utils/phash.ts`.
- **Semantic_Cache**: The existing query-response cache reached through
  `semanticCache.get` / `semanticCache.set` in the AI_Request_Path.
- **Dispatch_Latency**: The wall-clock interval from the Use_Screen_Action
  being invoked to the provider request being dispatched by
  `streamAIResponse`. This excludes provider/network time, so it is the
  portion of user-perceived latency this feature owns.
- **Reference_Machine**: The project's reference development machine, the same
  baseline used by the `ai-pipeline-performance` spec's timing criteria.

## Requirements

### Requirement 1: Screen context preparation leaves the critical path

**User Story:** As a Zule user, I want an answer to start appearing almost
immediately after I press Use Screen, so that the screen feels like live
context rather than a batch job.

#### Acceptance Criteria

1. WHEN the user invokes the Use_Screen_Action while a capture session is
   already active, THE AI_Request_Path SHALL achieve a Dispatch_Latency of at
   most 400 milliseconds at the 95th percentile on the Reference_Machine.
2. WHEN the user invokes the Use_Screen_Action and no capture session is
   active, THE Use_Screen_Action SHALL achieve a Dispatch_Latency of at most
   1 500 milliseconds at the 95th percentile on the Reference_Machine,
   excluding the time the operating system's screen-picker dialog is displayed.
3. THE AI_Request_Path SHALL NOT block the dispatch of the provider request on
   the completion of a full-frame OCR pass.
4. WHEN screen context is armed and the AI_Request_Path dispatches a request,
   THE AI_Request_Path SHALL include the freshest Screen_Text available at
   dispatch time.
5. WHERE an OCR pass for the current frame is already in flight when the
   AI_Request_Path needs Screen_Text, THE AI_Request_Path SHALL reuse that
   in-flight pass rather than starting a second pass over the same frame.

### Requirement 2: Redundant OCR is skipped for vision adapters

**User Story:** As a Zule user on a vision-capable model, I want the app to
send the screen image and skip the text-recognition pass, so that I am not
waiting on work the model does not need.

#### Acceptance Criteria

1. WHERE the active adapter is a Vision_Adapter AND a Keyframe is attached to
   the request, THE AI_Request_Path SHALL NOT invoke the OCR_Service for that
   request.
2. WHERE the active adapter is a Text_Only_Adapter, THE AI_Request_Path SHALL
   obtain Screen_Text for the request through the OCR_Service.
3. IF Keyframe encoding fails or returns no image while the active adapter is a
   Vision_Adapter, THEN THE AI_Request_Path SHALL fall back to obtaining
   Screen_Text through the OCR_Service for that request.
4. WHEN the active adapter changes from a Vision_Adapter to a
   Text_Only_Adapter during an active capture session, THE next request SHALL
   include Screen_Text obtained through the OCR_Service.
5. THE Screen_Capture_Hook SHALL expose whether the current request path
   requires OCR, so that the periodic OCR loop can be suspended while only a
   Vision_Adapter is in use.

### Requirement 3: OCR_Worker readiness is decoupled from the first request

**User Story:** As a Zule user, I want my first screen question of a session to
be as fast as my second, so that attaching the screen does not feel like it
stalls the app.

#### Acceptance Criteria

1. WHEN a capture session starts and the active adapter is a
   Text_Only_Adapter, THE Screen_Capture_Hook SHALL begin OCR_Worker
   initialization without awaiting it on the Use_Screen_Action's critical path.
2. WHEN the OCR_Service is asked to recognize a frame while OCR_Worker
   initialization is in flight, THE OCR_Service SHALL await the in-flight
   initialization rather than starting a second one.
3. WHEN a capture session stops, THE OCR_Service SHALL retain the OCR_Worker
   for at least a configured idle grace period so that a re-attach within that
   period does not pay worker creation or language-pack load again.
4. WHEN the idle grace period elapses with no capture session active, THE
   OCR_Service SHALL terminate the OCR_Worker and release its resources.
5. THE OCR_Service SHALL terminate the OCR_Worker immediately on renderer
   teardown regardless of the idle grace period.
6. IF OCR_Worker initialization fails, THEN THE Screen_Capture_Hook SHALL
   surface the failure through the existing `OcrWatchdog` policy and the
   AI_Request_Path SHALL dispatch the request without Screen_Text rather than
   failing the request.

### Requirement 4: Frame readiness is event-driven, not timeout-driven

**User Story:** As a Zule user, I want the app to fire my question the moment a
frame is available, so that I am not paying a fixed wait that has nothing to do
with my machine's speed.

#### Acceptance Criteria

1. WHEN the Use_Screen_Action starts a capture session, THE Use_Screen_Action
   SHALL dispatch the request as soon as the video sink reports a decoded frame
   is available.
2. THE Use_Screen_Action SHALL NOT wait for a fixed interval once a decoded
   frame is available.
3. IF no decoded frame becomes available within a bounded timeout, THEN THE
   Use_Screen_Action SHALL dispatch the request without a Keyframe and without
   Screen_Text, and SHALL surface a non-blocking notice to the user.
4. THE bounded timeout in clause 3 SHALL be at most 2 000 milliseconds.

### Requirement 5: Frame preparation does not block the renderer's main thread

**User Story:** As a Zule user, I want the overlay to stay responsive while the
screen is being captured, so that typing and scrolling do not stutter.

#### Acceptance Criteria

1. WHILE a capture session is active, THE Screen_Capture_Hook SHALL NOT occupy
   the renderer's main thread for more than 50 milliseconds in any single
   synchronous task attributable to frame preparation.
2. THE Screen_Capture_Hook SHALL produce the Frame_Hash for a captured frame
   without a synchronous main-thread pass over the full-resolution pixel
   buffer.
3. THE Screen_Capture_Hook SHALL produce the Keyframe encoding without a
   synchronous main-thread encode of the full-resolution frame.
4. THE Screen_Capture_Hook SHALL preserve the existing behavior of downscaling
   every frame to at most 1 280 pixels on its longest edge before OCR.
5. IF an off-main-thread frame-preparation facility is unavailable in the
   current runtime, THEN THE Screen_Capture_Hook SHALL fall back to the
   existing synchronous path and SHALL remain functionally correct.

### Requirement 6: Screen-aware response caching

**User Story:** As a Zule user, I want an instant answer when I ask the same
thing about a screen that has not changed, so that repeated questions are not
repeatedly slow.

#### Acceptance Criteria

1. WHEN screen context is armed, THE AI_Request_Path SHALL key its cache lookup
   on both the query text and the Frame_Hash of the frame used for the request.
2. WHEN a cache entry exists for the same query text and a Frame_Hash within
   the configured similarity threshold, THE AI_Request_Path SHALL serve the
   cached response without dispatching a provider request.
3. IF the Frame_Hash differs from the cached entry's Frame_Hash by more than
   the configured similarity threshold, THEN THE AI_Request_Path SHALL treat
   the lookup as a miss and SHALL dispatch a provider request.
4. WHEN no Frame_Hash is available for a request, THE AI_Request_Path SHALL
   treat the lookup as a miss.
5. THE AI_Request_Path SHALL NOT serve a screen-context response from a cache
   entry that was stored without a Frame_Hash.

### Requirement 7: Keyframe payload is bounded

**User Story:** As a Zule user on a slow connection, I want the screen image
sent to the model to be no larger than it needs to be, so that upload time does
not dominate my wait.

#### Acceptance Criteria

1. THE Screen_Capture_Hook SHALL produce a Keyframe whose encoded byte length
   does not exceed a configured maximum.
2. IF the encoded Keyframe exceeds the configured maximum, THEN THE
   Screen_Capture_Hook SHALL re-encode at a lower quality or smaller dimension
   until the limit is satisfied.
3. THE Screen_Capture_Hook SHALL report the final encoded byte length of every
   Keyframe it produces.
4. THE Keyframe SHALL remain a valid base64-encoded JPEG payload accepted by
   the existing image-context contract in `buildContextWindow`.

### Requirement 8: Answer quality is preserved

**User Story:** As a Zule user, I want the faster path to give me the same
answers, so that speed does not cost me correctness.

#### Acceptance Criteria

1. WHEN the user asks a question about content visible on screen at the moment
   of the request, THE AI_Request_Path SHALL provide the model with context
   derived from a frame captured no earlier than the Use_Screen_Action
   invocation for that request.
2. THE AI_Request_Path SHALL NOT provide the model with Screen_Text derived
   from a frame captured before the previous request in the same session.
3. WHEN a request is superseded by a newer request, THE AI_Request_Path SHALL
   discard the superseded request's screen context and SHALL NOT apply it to
   the newer request.
4. WHERE both Screen_Text and a Keyframe are attached to a request, THE
   AI_Request_Path SHALL report both modalities through the existing
   `modalitiesUsed` surface.
5. THE Screen_Capture_Hook SHALL continue to maintain the recent-OCR ring
   buffer with at most 5 timestamped entries.

### Requirement 9: Telemetry for the screen context stages

**User Story:** As a Zule developer, I want to see where screen-context time is
spent in production, so that I can confirm the speedup and catch regressions.

#### Acceptance Criteria

1. WHEN a screen-context request is dispatched, THE AI_Request_Path SHALL emit
   a telemetry event recording the Dispatch_Latency and whether a Keyframe,
   Screen_Text, or both were attached.
2. WHEN an OCR pass completes, THE OCR_Service SHALL emit a telemetry event
   recording the wall-clock duration and whether the pass was served from an
   in-flight deduplication.
3. WHEN the AI_Request_Path skips OCR because the active adapter is a
   Vision_Adapter, THE AI_Request_Path SHALL emit a counter event for the skip.
4. WHEN a Keyframe is re-encoded to satisfy the payload limit, THE
   Screen_Capture_Hook SHALL emit a telemetry event recording the number of
   re-encode passes and the final byte length.
5. THE telemetry events SHALL NOT contain recognized screen text, raw image
   bytes, or any user-identifying content.
6. WHERE telemetry includes text-derived fields, THE payload SHALL contain only
   processed or sanitized forms and SHALL apply the project's existing
   redaction rules before emission.

### Requirement 10: Offline operation preserved

**User Story:** As a Zule user running fully offline, I want the faster screen
path to work without network access, so that my local-first setup keeps
functioning.

#### Acceptance Criteria

1. THE Screen_Capture_Hook and the OCR_Service SHALL operate without issuing
   any outbound network request.
2. THE feature SHALL NOT introduce any dependency requiring a cloud service or
   external API key.
3. THE feature SHALL continue to serve the Tesseract worker and core assets
   from the application origin under `public/vendor/`.

### Requirement 11: No regressions in existing tests

**User Story:** As a Zule developer, I want the existing suite to keep passing,
so that I can trust the latency work has not broken behavior.

#### Acceptance Criteria

1. THE existing `src/utils/phash` and `src/utils/geometry` test suites SHALL
   pass without modification of their assertions.
2. THE existing `src/workers/ocrWorker` test suites, including the
   `OcrWatchdog` tests, SHALL pass without modification of their assertions.
3. THE existing `src/hooks/useScreenCapture` test suites SHALL pass, with any
   new asynchronous frame-preparation path stubbed to the synchronous fallback
   under test.
4. THE existing `FloatingCopilot` test suites SHALL pass without modification
   of their assertions.
