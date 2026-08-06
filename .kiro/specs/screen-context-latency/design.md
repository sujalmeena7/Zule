# Design Document: Screen Context Latency

## Overview

This design restructures the "Use Screen" flow so that pressing the button
dispatches an AI provider request within 400 ms (P95, session active) instead
of the current multi-second wait. The core strategy is:

1. **Decouple OCR from the critical path** — the request fires with whatever
   screen text is already available; a background OCR pass updates context for
   the *next* request rather than blocking the current one.
2. **Skip OCR entirely for vision adapters** — when the model can read an
   image, sending both OCR text *and* the JPEG is redundant work and prompt
   inflation.
3. **Warm the OCR worker eagerly** — start worker initialization when capture
   begins, retain it across stop/start cycles with an idle grace period.
4. **Event-driven frame readiness** — replace the 2 000 ms poll with a
   `loadeddata` / `canplay` listener that resolves the instant a frame decodes.
5. **Move heavy frame-prep off the main thread** — phash and JPEG encoding
   happen on an `OffscreenCanvas` worker (with synchronous fallback).
6. **Screen-aware cache** — key the semantic cache on `query + Frame_Hash` so
   repeated questions about an unchanged screen hit instantly.
7. **Bounded keyframe payload** — re-encode at lower quality/dimensions when
   the JPEG exceeds the configured byte ceiling.

No new network dependencies, cloud services, or model files are introduced.
The offline-first contract is preserved.

## Architecture

```mermaid
flowchart TD
    subgraph Renderer Main Thread
        A[Use Screen Button] --> B[handleUseScreen]
        B --> C{Session active?}
        C -->|No| D[startCapture + await frame-ready event]
        C -->|Yes| E[Use current frame]
        D --> E
        E --> F[triggerAI]
        F --> G{Vision adapter?}
        G -->|Yes| H[Attach keyframe only]
        G -->|No| I[Attach freshest Screen_Text]
        H --> J[Cache lookup: query + Frame_Hash]
        I --> J
        J -->|Hit| K[Serve cached response]
        J -->|Miss| L[buildContextWindow → streamAIResponse]
    end

    subgraph OffscreenCanvas Worker
        M[captureFrame] --> N[downscale ≤ 1280px]
        N --> O[phash computation]
        N --> P[JPEG encode + bound check]
    end

    subgraph OCR Service (background)
        Q[Warm worker on session start]
        R[Periodic OCR loop 3s]
        S[captureTextNow - on-demand]
        T[In-flight dedup gate]
    end

    E -.->|frame data| M
    O -.->|Frame_Hash| J
    P -.->|base64 JPEG| H
    R -.->|Screen_Text| I
    S -.->|Screen_Text| I
```

### Key Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| OCR is advisory, not blocking | Vision models don't need it; text-only models benefit from "best available" text rather than waiting for a fresh pass |
| OffscreenCanvas for phash + encode | Keeps main thread under 50 ms budget; feature-detected with sync fallback |
| Grace-period worker retention | Eliminates 1–2 s cold start on re-attach within 30 s |
| Hamming-distance cache key | Perceptual hash is already computed; extending the cache key is cheap and enables instant repeated-question answers |
| Single OCR dedup gate | Prevents duplicate Tesseract invocations when triggerAI and the periodic loop race |

## Components and Interfaces

### 1. FramePrepWorker (new)

A thin wrapper around `OffscreenCanvas` that runs phash and JPEG encode off the
main thread.

```typescript
// src/workers/framePrepWorker.ts

export interface FramePrepRequest {
  /** Raw RGBA pixel buffer transferred from the main thread. */
  pixels: ArrayBuffer;
  width: number;
  height: number;
  /** Max byte length for JPEG output. */
  maxKeyframeBytes: number;
  /** Initial JPEG quality (0–1). */
  initialQuality: number;
}

export interface FramePrepResult {
  /** 8-byte perceptual hash. */
  hash: Uint8Array;
  /** Base64-encoded JPEG (stripped of data URI prefix). */
  keyframeBase64: string;
  /** Final encoded byte length. */
  keyframeBytes: number;
  /** Number of re-encode passes (0 = first pass was within budget). */
  reEncodeCount: number;
}

/**
 * Posts a FramePrepRequest to the worker and resolves with the result.
 * Falls back to synchronous main-thread computation when OffscreenCanvas
 * or Worker is unavailable.
 */
export function prepareFrame(req: FramePrepRequest): Promise<FramePrepResult>;

/**
 * Returns true if the current runtime supports off-main-thread frame prep.
 */
export function isOffThreadAvailable(): boolean;
```

### 2. OCR Service (enhanced)

Extensions to `src/workers/ocrWorker.ts`:

```typescript
// Additions to ocrWorker.ts

export interface OcrServiceConfig {
  /** Idle grace period in ms before terminating the worker. Default 30_000. */
  idleGracePeriodMs?: number;
}

/**
 * Warm-start the OCR worker without blocking. Returns immediately.
 * The returned promise resolves when the worker is ready (callers may
 * ignore it on the critical path).
 */
export function warmOcrWorker(language?: string): Promise<void>;

/**
 * Recognize text with in-flight deduplication. If a recognize call for the
 * same frame hash is already in progress, the returned promise resolves
 * with the same result (no duplicate Tesseract invocation).
 */
export function recognizeTextDeduped(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  frameHash: Uint8Array,
  language?: string,
): Promise<string>;

/**
 * Schedule worker termination after the idle grace period.
 * Cancels any previously scheduled termination.
 */
export function scheduleIdleTermination(): void;

/**
 * Cancel any pending idle termination (called on session restart).
 */
export function cancelIdleTermination(): void;

/**
 * Terminate immediately, ignoring grace period. Called on renderer teardown.
 */
export function terminateOcrWorkerImmediate(): Promise<void>;
```

### 3. Screen Capture Hook (enhanced)

Extensions to `src/hooks/useScreenCapture.ts`:

```typescript
// Extended return type for useScreenCapture

interface ScreenCaptureHookExtended extends ScreenCaptureHook {
  /**
   * Whether OCR is required for the current adapter configuration.
   * When false, the periodic OCR loop suspends to save CPU.
   */
  ocrRequired: boolean;

  /**
   * The most recent Frame_Hash (8-byte Uint8Array) from the last
   * prepared frame. Used for cache keying.
   */
  latestFrameHash: Uint8Array | null;

  /**
   * Async keyframe capture that uses OffscreenCanvas when available.
   * Returns null if no frame is ready. Bounded by maxKeyframeBytes.
   */
  getKeyframeAsync: () => Promise<{
    base64: string;
    hash: Uint8Array;
    bytes: number;
  } | null>;
}
```

### 4. Screen-Aware Cache Extension

Extension to `ResponseCache` in `src/brain/responseCache.ts`:

```typescript
// Extended cache API for screen-context keying

export interface ScreenCacheKey {
  query: string;
  frameHash: Uint8Array | null;
}

/**
 * Look up a cached response using both query similarity AND frame hash
 * Hamming distance. Returns a hit only when both thresholds are met.
 */
async getWithFrame(key: ScreenCacheKey): Promise<{
  hit: AIResponse | null;
  similarity: number;
  hashDistance: number;
}>;

/**
 * Store a response keyed to both query embedding and frame hash.
 */
async setWithFrame(
  key: ScreenCacheKey,
  response: AIResponse,
): Promise<void>;
```

### 5. Telemetry Extensions

New metric event variants for `src/brain/telemetry.ts`:

```typescript
// Additional MetricEvent variants
| { kind: 'screen.dispatch'; latencyMs: number; hasKeyframe: boolean; hasScreenText: boolean }
| { kind: 'screen.ocrComplete'; durationMs: number; deduped: boolean }
| { kind: 'screen.ocrSkipped'; reason: 'vision-adapter' }
| { kind: 'screen.keyframeReencode'; passes: number; finalBytes: number }
```

## Data Models

### FramePrepResult

| Field | Type | Description |
|-------|------|-------------|
| hash | Uint8Array(8) | 64-bit perceptual hash of the downscaled frame |
| keyframeBase64 | string | Base64-encoded JPEG payload (no data URI prefix) |
| keyframeBytes | number | Final encoded byte length after any re-encoding |
| reEncodeCount | number | Number of quality/dimension reduction passes |

### Extended CacheEntry

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique entry identifier |
| query | string | Original query text |
| embedding | number[] | Query embedding vector |
| frameHash | Uint8Array \| null | Perceptual hash of the frame used (null for non-screen entries) |
| response | AIResponse | Cached response |
| lastUsedAt | number | Epoch ms of last access |

### OCR Dedup State

| Field | Type | Description |
|-------|------|-------------|
| inFlightHash | Uint8Array \| null | Hash of the frame currently being OCR'd |
| inFlightPromise | Promise\<string\> \| null | Shared promise for in-flight OCR |

### Screen Telemetry Event

| Field | Type | Description |
|-------|------|-------------|
| kind | string literal | Discriminated event type |
| latencyMs | number | Wall-clock duration of the measured stage |
| hasKeyframe | boolean | Whether a JPEG keyframe was attached |
| hasScreenText | boolean | Whether OCR text was attached |
| deduped | boolean | Whether an in-flight OCR pass was reused |
| passes | number | Number of re-encode passes for keyframe |
| finalBytes | number | Final byte length of emitted keyframe |

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all
valid executions of a system — essentially, a formal statement about what the
system should do. Properties serve as the bridge between human-readable
specifications and machine-verifiable correctness guarantees.*

### Property 1: Non-blocking dispatch

*For any* screen-context request where a capture session is active, the
provider request SHALL be dispatched without awaiting the completion of a
full-frame OCR pass — i.e., if OCR is still in progress at dispatch time, the
request fires with the best available text rather than blocking.

**Validates: Requirements 1.3**

### Property 2: Freshest available text at dispatch

*For any* screen-context request, the Screen_Text attached to the dispatched
context SHALL be the most recently completed OCR result available at the moment
of dispatch (from the ring buffer or a just-resolved in-flight pass), never an
older result when a newer one exists.

**Validates: Requirements 1.4**

### Property 3: In-flight OCR deduplication

*For any* N concurrent requests for OCR recognition on the same frame (same
Frame_Hash), the OCR_Service SHALL invoke Tesseract at most once and resolve
all N callers with the same result.

**Validates: Requirements 1.5**

### Property 4: OCR invocation determined by adapter type and keyframe availability

*For any* request where screen context is armed: OCR is skipped if and only if
the active adapter is a Vision_Adapter AND a valid Keyframe is available. In
all other cases (Text_Only_Adapter, or Vision_Adapter with keyframe failure),
OCR SHALL be invoked.

**Validates: Requirements 2.1, 2.2, 2.3**

### Property 5: Worker initialization deduplication

*For any* N concurrent calls to `recognizeText` while OCR_Worker
initialization is in flight, exactly one `createWorker` invocation SHALL
occur; all N callers SHALL await the same initialization promise.

**Validates: Requirements 3.2**

### Property 6: Idle grace period worker reuse

*For any* stop-then-restart interval shorter than the configured idle grace
period, the OCR_Service SHALL reuse the existing OCR_Worker without
re-invoking `createWorker` or reloading the language pack. For intervals
exceeding the grace period, the worker SHALL have been terminated and a new
one created.

**Validates: Requirements 3.3, 3.4**

### Property 7: Screen-aware cache correctness

*For any* query text `Q` and Frame_Hash `H`, a cache lookup with screen
context armed SHALL return a hit if and only if: (a) an entry exists whose
query embedding similarity ≥ the configured threshold, AND (b) the entry's
stored Frame_Hash has Hamming distance ≤ the configured hash threshold from
`H`. A lookup with no Frame_Hash, or against an entry stored without a
Frame_Hash, SHALL always miss.

**Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**

### Property 8: Keyframe payload bounded

*For any* captured frame (regardless of resolution, content complexity, or
color depth), the encoded Keyframe produced by the Screen_Capture_Hook SHALL
have a byte length ≤ the configured maximum. If the initial encode exceeds the
limit, re-encoding at progressively lower quality/dimensions SHALL bring it
within bounds.

**Validates: Requirements 7.1, 7.2**

### Property 9: Keyframe is valid base64 JPEG

*For any* frame passed through the keyframe encoding pipeline, the output
SHALL be a non-empty string that is valid base64 and decodes to a byte
sequence beginning with the JPEG SOI marker (`0xFF 0xD8`).

**Validates: Requirements 7.4**

### Property 10: Frame freshness guarantee

*For any* screen-context request, the frame used to derive context (Screen_Text
or Keyframe) SHALL have been captured at or after the timestamp of the
Use_Screen_Action invocation that initiated that request.

**Validates: Requirements 8.1**

### Property 11: No stale cross-request screen text

*For any* sequence of screen-context requests within a session, request N's
Screen_Text SHALL be derived from a frame captured strictly after request
(N-1)'s frame — the system SHALL never serve text from a frame that predates
the previous request.

**Validates: Requirements 8.2**

### Property 12: Superseded request context isolation

*For any* pair of requests where request B supersedes request A (i.e.,
request B is initiated while request A's context is still being assembled),
request A's screen context (Screen_Text and Keyframe) SHALL NOT be applied to
request B's provider call.

**Validates: Requirements 8.3**

### Property 13: Ring buffer bounded at 5

*For any* number of OCR results produced during a capture session, the
recent-OCR ring buffer SHALL contain at most 5 entries at all times.

**Validates: Requirements 8.5**

### Property 14: Telemetry contains no raw user content

*For any* telemetry event emitted by the screen-context path, the event
payload SHALL NOT contain recognized screen text, raw image bytes (base64 or
binary), or any user-identifying content. Text-derived fields, if present,
SHALL contain only redacted/sanitized forms.

**Validates: Requirements 9.5, 9.6**

## Error Handling

| Scenario | Behavior | User Surface |
|----------|----------|--------------|
| Frame not ready within 2 000 ms timeout | Dispatch request without Keyframe or Screen_Text | Non-blocking toast: "Screen frame not available — answering without screen context" |
| Keyframe encoding fails (OffscreenCanvas or toBlob error) | Fall back to OCR-only path for vision adapters; proceed without keyframe for text-only | Silent fallback; telemetry event logged |
| OCR worker initialization fails | OcrWatchdog policy applies (recreate once, then disable). Request dispatches without Screen_Text | Existing watchdog error surface |
| OffscreenCanvas unavailable (older Electron/browser) | Synchronous fallback for phash + JPEG encode on main thread | No user surface; main-thread budget may be exceeded on very large frames |
| In-flight OCR promise rejects | Error propagates to all callers sharing the dedup promise. Watchdog records the failure. Subsequent requests proceed without text | Existing watchdog error surface |
| Cache lookup throws | Treat as cache miss; dispatch provider request normally | Silent; telemetry records the error |
| Grace-period timer fires during active session | Timer is cancelled when session restarts; no-op if session is active | None |
| Renderer teardown during active capture | Worker terminated immediately (ignoring grace period); stream tracks stopped; video sink removed | None |
| getDisplayMedia rejected by user | Existing `NotAllowedError` handling; capture not started | Toast: "Screen capture permission denied" |
| Stream track ends (user stops sharing via browser UI) | Existing `ended` event handler calls `stopCapture()` | Toast: "Screen detached" |

### Graceful Degradation Hierarchy

The system degrades gracefully through these levels:

1. **Full capability** — OffscreenCanvas + warm OCR worker + vision adapter →
   keyframe only, sub-400 ms dispatch
2. **No OffscreenCanvas** — synchronous frame prep on main thread → slightly
   higher jank budget but functionally identical
3. **OCR worker failed** — watchdog disabled OCR → request proceeds with
   keyframe only (vision) or without screen context (text-only)
4. **No frame available** — timeout fired → request dispatches with
   conversation context only, user notified
5. **Cache unavailable** — lookup throws → every request pays provider cost,
   no data loss

## Testing Strategy

### Unit Tests (example-based)

| Area | Tests |
|------|-------|
| FramePrepWorker | Correct hash output for known pixel buffers; JPEG header presence; re-encode loop terminates; sync fallback produces same hash |
| OCR Service grace period | Worker survives stop; terminates after grace; immediate terminate on teardown |
| Vision adapter skip | OCR not called when adapter is vision + keyframe present; fallback on keyframe failure |
| Cache extension | Hit on matching query + hash; miss on divergent hash; miss on null hash; miss on entry without hash |
| Telemetry events | Correct event shape; no raw content leakage |
| Frame readiness | Event-driven dispatch (no fixed delay); timeout fallback fires correctly |

### Property-Based Tests (fast-check, ≥ 100 iterations each)

| Property | Generator Strategy |
|----------|-------------------|
| P1: Non-blocking dispatch | Generate random OCR delays (0–5000 ms); verify dispatch timestamp < OCR completion timestamp |
| P3: In-flight OCR dedup | Generate random concurrency counts (2–20); verify exactly 1 Tesseract call |
| P4: Adapter + keyframe → OCR decision | Generate random `{adapterType, keyframeAvailable}` tuples; verify OCR call count matches rule |
| P5: Worker init dedup | Generate random concurrent call counts (2–10); verify 1 createWorker call |
| P6: Grace period reuse | Generate random `{stopDuration, gracePeriod}` pairs; verify worker reuse iff stopDuration < gracePeriod |
| P7: Cache correctness | Generate random `{query, hash, storedHash, threshold}` tuples; verify hit/miss matches Hamming rule |
| P8: Keyframe bounded | Generate random pixel buffers (varying dimensions 100–4000 px, random content); verify output ≤ maxBytes |
| P9: Valid JPEG | Generate random pixel buffers; verify base64 decodes and starts with `0xFF 0xD8` |
| P10: Frame freshness | Generate random `{invocationTime, frameCaptureTime}` pairs; verify only frames ≥ invocation time are used |
| P13: Ring buffer bounded | Generate random push counts (1–1000); verify buffer.length ≤ 5 |
| P14: Telemetry no content | Generate random screen text + image bytes; trigger telemetry paths; grep event payloads for raw content |

**Library**: `fast-check` (already available in the project's devDependencies)

**Configuration**: Each property test runs a minimum of 100 iterations. Each test
is tagged with a comment referencing the design property:

```typescript
// Feature: screen-context-latency, Property 7: Screen-aware cache correctness
```

### Integration Tests

| Scenario | Approach |
|----------|----------|
| End-to-end dispatch latency (Req 1.1, 1.2) | Benchmark harness measuring P95 over 50 invocations on reference machine |
| Existing test suite regression (Req 11) | CI gate — existing suites must pass green |
| Offline operation (Req 10) | Network-stubbed integration test verifying no outbound requests |
