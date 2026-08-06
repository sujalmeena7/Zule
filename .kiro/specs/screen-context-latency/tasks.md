# Implementation Plan: Screen Context Latency

## Overview

Restructure the "Use Screen" flow to dispatch AI provider requests within 400 ms (P95, session active) by decoupling OCR from the critical path, moving heavy frame preparation off the main thread, warming the OCR worker eagerly, replacing timeout-based frame readiness with event-driven dispatch, skipping OCR for vision adapters, adding screen-aware caching, and bounding keyframe payloads. All changes are scoped to the screen/OCR path and preserve offline-first operation.

## Tasks

- [x] 1. Create FramePrepWorker for off-main-thread frame preparation
  - [x] 1.1 Implement FramePrepWorker module with OffscreenCanvas support
    - Create `src/workers/framePrepWorker.ts` with `FramePrepRequest` and `FramePrepResult` interfaces
    - Implement the web worker that receives pixel buffers, downscales to ≤1280px, computes perceptual hash, and encodes JPEG
    - Implement the `prepareFrame` function that posts to the worker and resolves with the result
    - Implement `isOffThreadAvailable()` feature detection
    - Implement synchronous fallback path when OffscreenCanvas/Worker is unavailable
    - _Requirements: 5.1, 5.2, 5.3, 5.5_

  - [x] 1.2 Implement bounded keyframe re-encoding logic
    - Add re-encode loop that reduces quality/dimensions when JPEG exceeds `maxKeyframeBytes`
    - Report final encoded byte length and re-encode count in the result
    - Ensure output is always valid base64-encoded JPEG (SOI marker `0xFF 0xD8`)
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 1.3 Write property tests for FramePrepWorker
    - **Property 8: Keyframe payload bounded**
    - Generate random pixel buffers (varying dimensions 100–4000px, random content); verify output ≤ maxBytes
    - **Property 9: Keyframe is valid base64 JPEG**
    - Generate random pixel buffers; verify base64 decodes and starts with `0xFF 0xD8`
    - **Validates: Requirements 7.1, 7.2, 7.4**

  - [x] 1.4 Write unit tests for FramePrepWorker
    - Test correct hash output for known pixel buffers
    - Test JPEG header presence in output
    - Test re-encode loop terminates within bounds
    - Test synchronous fallback produces same hash as worker path
    - _Requirements: 5.2, 5.3, 7.1, 7.4_

- [x] 2. Enhance OCR Service with warm-start, deduplication, and grace period
  - [x] 2.1 Implement warm-start and idle grace period for OCR worker
    - Add `warmOcrWorker(language?)` that starts initialization without blocking
    - Add `scheduleIdleTermination()` with configurable grace period (default 30s)
    - Add `cancelIdleTermination()` for session restart
    - Add `terminateOcrWorkerImmediate()` for renderer teardown
    - Ensure re-attach within grace period reuses the existing worker
    - _Requirements: 3.1, 3.3, 3.4, 3.5_

  - [x] 2.2 Implement in-flight OCR deduplication gate
    - Track `inFlightHash` and `inFlightPromise` state
    - Implement `recognizeTextDeduped(canvas, frameHash, language?)` that resolves from shared promise when same-frame OCR is in progress
    - Ensure single `createWorker` invocation when concurrent callers await initialization
    - _Requirements: 1.5, 3.2_

  - [x] 2.3 Write property tests for OCR Service
    - **Property 3: In-flight OCR deduplication**
    - Generate random concurrency counts (2–20); verify exactly 1 Tesseract call
    - **Property 5: Worker initialization deduplication**
    - Generate random concurrent call counts (2–10); verify 1 createWorker call
    - **Property 6: Idle grace period worker reuse**
    - Generate random `{stopDuration, gracePeriod}` pairs; verify worker reuse iff stopDuration < gracePeriod
    - **Validates: Requirements 1.5, 3.2, 3.3, 3.4**

  - [x] 2.4 Write unit tests for OCR Service grace period and dedup
    - Test worker survives stop within grace period
    - Test worker terminates after grace period elapses
    - Test immediate terminate on renderer teardown ignores grace period
    - Test initialization failure surfaces through OcrWatchdog
    - _Requirements: 3.3, 3.4, 3.5, 3.6_

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Enhance Screen Capture Hook with event-driven readiness and adapter awareness
  - [x] 4.1 Replace timeout-based frame readiness with event-driven dispatch
    - Replace the 2000ms poll with `loadeddata`/`canplay` listener on the video sink
    - Dispatch request as soon as video sink reports a decoded frame is available
    - Implement bounded timeout (≤2000ms) fallback that dispatches without Keyframe/Screen_Text and surfaces non-blocking notice
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 4.2 Add adapter-aware OCR suspension and `ocrRequired` flag
    - Expose `ocrRequired` boolean based on active adapter type
    - Suspend periodic OCR loop when only a Vision_Adapter is in use
    - Resume OCR loop when adapter changes to Text_Only_Adapter
    - _Requirements: 2.5_

  - [x] 4.3 Implement async keyframe capture via FramePrepWorker
    - Add `getKeyframeAsync()` that delegates to FramePrepWorker
    - Expose `latestFrameHash` from the most recent prepared frame
    - Ensure frame downscaling to ≤1280px longest edge is preserved
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 4.4 Write property test for ring buffer bounds
    - **Property 13: Ring buffer bounded at 5**
    - Generate random push counts (1–1000); verify buffer.length ≤ 5
    - **Validates: Requirements 8.5**

  - [x] 4.5 Write unit tests for event-driven frame readiness
    - Test event-driven dispatch fires on `loadeddata`
    - Test no fixed delay once frame is available
    - Test timeout fallback fires correctly at ≤2000ms
    - _Requirements: 4.1, 4.2, 4.3_

- [x] 5. Restructure AI Request Path for non-blocking screen context dispatch
  - [x] 5.1 Decouple OCR from the critical dispatch path in triggerAI
    - Modify `triggerAI` to use freshest available Screen_Text at dispatch time rather than awaiting a new OCR pass
    - Reuse in-flight OCR pass via dedup gate when available
    - Warm OCR worker on session start (non-blocking)
    - Ensure dispatch latency ≤400ms (P95) when session is active
    - _Requirements: 1.1, 1.3, 1.4, 1.5_

  - [x] 5.2 Implement vision adapter OCR skip logic
    - Skip OCR invocation when active adapter is Vision_Adapter AND Keyframe is available
    - Fall back to OCR path when keyframe encoding fails for Vision_Adapter
    - Ensure Text_Only_Adapter always obtains Screen_Text via OCR
    - Handle adapter change mid-session (Vision → Text_Only)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 5.3 Ensure frame freshness and context isolation
    - Verify frame used for context is captured at or after Use_Screen_Action invocation time
    - Prevent stale cross-request text (frame must postdate previous request's frame)
    - Discard superseded request context when a newer request arrives
    - Report both modalities through `modalitiesUsed` when both present
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 5.4 Write property tests for dispatch behavior
    - **Property 1: Non-blocking dispatch**
    - Generate random OCR delays (0–5000ms); verify dispatch timestamp < OCR completion timestamp
    - **Property 2: Freshest available text at dispatch**
    - Generate sequences of OCR completions; verify attached text is always the newest available
    - **Property 4: Adapter + keyframe → OCR decision**
    - Generate random `{adapterType, keyframeAvailable}` tuples; verify OCR call count matches rule
    - **Property 10: Frame freshness guarantee**
    - Generate random `{invocationTime, frameCaptureTime}` pairs; verify only frames ≥ invocation time are used
    - **Property 11: No stale cross-request screen text**
    - Generate sequential request pairs; verify text freshness ordering
    - **Property 12: Superseded request context isolation**
    - Generate overlapping request pairs; verify no context leakage
    - **Validates: Requirements 1.3, 1.4, 2.1, 2.2, 2.3, 8.1, 8.2, 8.3**

  - [x] 5.5 Write unit tests for vision adapter skip and fallback
    - Test OCR not called when vision adapter + keyframe present
    - Test fallback to OCR when keyframe encoding fails
    - Test adapter change from Vision to Text_Only resumes OCR
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement screen-aware response caching
  - [x] 7.1 Extend ResponseCache with frame-hash keying
    - Add `getWithFrame(key: ScreenCacheKey)` method that checks both query similarity and Frame_Hash Hamming distance
    - Add `setWithFrame(key: ScreenCacheKey, response)` method that stores frame hash alongside response
    - Return hit only when query threshold AND hash threshold are both met
    - Treat lookup as miss when no Frame_Hash is available or entry was stored without one
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 7.2 Integrate screen-aware cache into AI Request Path
    - Key cache lookup on `query + Frame_Hash` when screen context is armed
    - Serve cached response on hit without dispatching provider request
    - Store response with frame hash on cache miss after provider response
    - _Requirements: 6.1, 6.2_

  - [x] 7.3 Write property tests for screen-aware cache
    - **Property 7: Screen-aware cache correctness**
    - Generate random `{query, hash, storedHash, threshold}` tuples; verify hit/miss matches Hamming rule
    - Verify null hash always misses; verify entry without hash never serves screen-context lookups
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**

  - [x] 7.4 Write unit tests for cache extension
    - Test hit on matching query + hash within threshold
    - Test miss on divergent hash beyond threshold
    - Test miss on null Frame_Hash
    - Test miss on entry stored without Frame_Hash
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 8. Add telemetry for screen context stages
  - [x] 8.1 Emit telemetry events for screen-context path
    - Emit `screen.dispatch` with latencyMs, hasKeyframe, hasScreenText on request dispatch
    - Emit `screen.ocrComplete` with durationMs and deduped flag on OCR pass completion
    - Emit `screen.ocrSkipped` counter when vision adapter skips OCR
    - Emit `screen.keyframeReencode` with passes and finalBytes on re-encode
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 8.2 Apply redaction rules to telemetry payloads
    - Ensure no recognized screen text in event payloads
    - Ensure no raw image bytes (base64 or binary) in event payloads
    - Apply project's existing redaction rules to any text-derived fields
    - _Requirements: 9.5, 9.6_

  - [x] 8.3 Write property test for telemetry content safety
    - **Property 14: Telemetry contains no raw user content**
    - Generate random screen text + image bytes; trigger telemetry paths; grep event payloads for raw content
    - **Validates: Requirements 9.5, 9.6**

  - [x] 8.4 Write unit tests for telemetry events
    - Test correct event shape for each metric kind
    - Test no raw content leakage in payloads
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 9. Validate offline operation and no-regression
  - [x] 9.1 Verify no outbound network requests in screen path
    - Audit Screen_Capture_Hook and OCR_Service for any network calls
    - Confirm Tesseract worker and assets served from `public/vendor/`
    - Confirm no new cloud service or API key dependency introduced
    - _Requirements: 10.1, 10.2, 10.3_

  - [x] 9.2 Verify existing test suites pass without assertion modifications
    - Run `src/utils/phash` and `src/utils/geometry` test suites
    - Run `src/workers/ocrWorker` and `OcrWatchdog` test suites
    - Run `src/hooks/useScreenCapture` tests with async paths stubbed to sync fallback
    - Run `FloatingCopilot` test suites
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The design uses TypeScript throughout; all implementation tasks target TypeScript
- The `fast-check` library is already in devDependencies for property-based testing
- OffscreenCanvas feature detection ensures graceful degradation to synchronous fallback
- The offline-first constraint means no new network dependencies anywhere in the implementation

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "2.2"] },
    { "id": 2, "tasks": ["1.3", "1.4", "2.3", "2.4"] },
    { "id": 3, "tasks": ["4.1", "4.2", "4.3"] },
    { "id": 4, "tasks": ["4.4", "4.5", "5.1"] },
    { "id": 5, "tasks": ["5.2", "5.3"] },
    { "id": 6, "tasks": ["5.4", "5.5", "7.1"] },
    { "id": 7, "tasks": ["7.2", "8.1"] },
    { "id": 8, "tasks": ["7.3", "7.4", "8.2"] },
    { "id": 9, "tasks": ["8.3", "8.4", "9.1"] },
    { "id": 10, "tasks": ["9.2"] }
  ]
}
```
