# Requirements Document

## Introduction

Zule is a browser-based AI meeting copilot (Vite + React + TypeScript SPA) that listens to live conversations, optionally observes the user's screen, retrieves context from a personal knowledge base, and surfaces real-time suggestions, answers, and coaching. The current build (audited in this spec) implements the core skeleton — speech recognition, screen capture + OCR, a Gemini provider, a sliding-window context manager, a local Transformers.js vector store, a question detector, a response cache, and a floating overlay — but contains a significant number of correctness, reliability, security, performance, and UX defects, and is missing several capabilities that Cluely-class assistants ship today.

This spec defines the full set of requirements to (a) remediate the defects identified in the audit and (b) close the capability gap with Cluely (and exceed it on privacy, reliability, observability, and personalization). Requirements are grouped into ten buckets:

1. Audio Capture & Transcription
2. AI Inference & Provider Abstraction
3. Context Management & Retrieval (RAG)
4. Real-Time Coaching & Question Detection
5. Privacy, Security & Stealth
6. Reliability, Performance & Resource Management
7. UX, Internationalization & Accessibility
8. Observability & Telemetry
9. Persistence, Schema & Cross-Window Sync
10. Personalization, Memory & Multi-Modal Fusion

Where a requirement remediates a specific audit finding it is annotated `(Audit: …)`. Where a requirement is a new capability uplift it is annotated `(Uplift: …)`. All acceptance criteria are written using EARS patterns and INCOSE quality rules.

## Glossary

- **Zule**: the overall application as defined by this spec.
- **Copilot_Engine**: the in-page subsystem that orchestrates transcription, retrieval, prompt assembly, inference, and presentation during an active session.
- **AI_Provider_Router**: the module that selects, calls, retries, and streams from a configured large-language-model provider.
- **Provider_Adapter**: a per-provider implementation conforming to a common interface (current: Gemini; new: OpenAI, Anthropic, local-runtime, simulation).
- **Transcription_Engine**: the speech-to-text subsystem, currently wrapping the browser Web Speech API and (uplift) a local Whisper-class model.
- **Context_Builder**: the component that assembles the prompt sent to the model from system instructions, retrieved knowledge, transcript window, screen text, and user query.
- **Vector_Index**: the in-browser embedding index built on Transformers.js (Xenova/all-MiniLM-L6-v2 by default).
- **Knowledge_Base**: persisted user documents (resume, notes, scripts, prior-meeting facts) ingested into the Vector_Index.
- **Memory_Store**: persisted vectorized facts derived from prior meetings, distinct from the user-uploaded Knowledge_Base.
- **Response_Cache**: the in-session cache that returns prior model outputs for semantically equivalent queries.
- **Question_Detector**: the rule-and-model-based component that decides when to autonomously trigger the AI_Provider_Router.
- **Coaching_Module**: the component that computes pace, filler usage, sentiment, and a confidence score from the live transcript.
- **Screen_Capture_Module**: the `getDisplayMedia`-based capture pipeline.
- **OCR_Worker**: the Tesseract-backed worker that extracts text from screen frames.
- **Stealth_Layer**: the set of behaviors that prevent the Copilot UI from appearing in screen-shared video.
- **Detached_Window**: a secondary browser window mirroring Copilot state, opened to keep the UI off the shared surface.
- **Cross_Window_Sync**: the BroadcastChannel-based state mirror between the main window and the Detached_Window.
- **Settings_Store**: persisted user configuration (theme, default mode, API key, provider selection, redaction rules, etc.).
- **Meeting_Store**: persisted past sessions (transcript, summary, action items, analytics).
- **Telemetry_Module**: the local-first metrics/error sink that records latency, errors, and quality signals (always opt-in, never includes content unless user enables).
- **Latency_Budget**: a configured target for end-to-end "answer-next-question" time, measured from question detection to first visible token.
- **Redaction_Engine**: the module that applies user-defined redaction rules to transcript and screen text before they leave the device.
- **User**: the human operator running Zule.
- **Other_Speaker**: any non-user speaker whose audio is captured.
- **Active_Session**: a single meeting from copilot start until copilot stop.

## Requirements

### Requirement 1: Robust Speech Recognition Lifecycle

**User Story:** As a user, I want speech recognition to keep running reliably across long meetings, network blips, and permission changes, so that my transcript is accurate and continuous.

#### Acceptance Criteria

1. WHEN the User starts an Active_Session and microphone permission is granted, THE Transcription_Engine SHALL begin streaming interim and final results within 1500 ms.
2. IF the Transcription_Engine emits an `onend` event WHILE the User has not requested stop, THEN THE Transcription_Engine SHALL attempt to restart with exponential backoff bounded by an initial delay of 250 ms, a doubling factor of 2, and a maximum delay of 8000 ms. (Audit: restart-loop without backoff in `useSpeechRecognition.ts`.)
3. IF the Transcription_Engine has attempted five consecutive restarts within 60 seconds without producing a final result, THEN THE Transcription_Engine SHALL surface a recoverable error to the User and pause auto-restart until the User resumes. (Audit: unbounded restart loop.)
4. IF the Transcription_Engine emits a `no-speech` or `audio-capture` error, THEN THE Transcription_Engine SHALL log the error, emit a non-fatal event, and continue listening without tearing down the recognizer.
5. IF the Transcription_Engine emits a `not-allowed` or `service-not-allowed` error, THEN THE Transcription_Engine SHALL stop, clear `shouldRestart`, and surface a permission-denied state to the UI.
6. WHEN the User invokes stop WHILE interim text is non-empty, THE Transcription_Engine SHALL persist the interim text as a final transcript line marked `confidence: low` rather than discard it. (Audit: interim text dropped on stop.)
7. WHERE the browser exposes a per-result `confidence` value, THE Transcription_Engine SHALL drop final results whose confidence is below a configurable threshold (default 0.30) and SHALL count dropped lines in session telemetry. (Audit: no confidence filtering.)
8. WHEN microphone permission transitions from `granted` to `denied` mid-session via the Permissions API, THE Transcription_Engine SHALL stop, surface a permission-revoked event, and offer a one-click resume action that reissues `getUserMedia`. (Audit: no detection of mid-session permission revocation.)
9. WHEN the User changes recognition language in Settings, THE Transcription_Engine SHALL apply the new BCP-47 language tag on the next recognizer start without requiring a page reload. (Audit: hard-coded `en-US`.)
10. IF `window.SpeechRecognition` and `window.webkitSpeechRecognition` are both undefined, THEN THE Transcription_Engine SHALL surface an `unsupported` state and SHALL offer the local Whisper-class fallback defined in Requirement 2.

### Requirement 2: Local-First Transcription Fallback (Uplift)

**User Story:** As a privacy-conscious user, I want a transcription option that does not stream my audio to a third-party cloud STT, so that my conversations remain on my device.

#### Acceptance Criteria

1. WHERE the User has selected `transcription.provider = local-whisper` in Settings, THE Transcription_Engine SHALL use a WebGPU-or-WASM Whisper-class model loaded via the Vector_Index runtime in place of the Web Speech API.
2. WHILE the local Whisper-class model is loading, THE Transcription_Engine SHALL display download progress through the same channel used for embedding-model progress and SHALL allow the User to cancel.
3. WHEN the User starts an Active_Session WITH the local provider selected, THE Transcription_Engine SHALL produce its first final segment within 4 seconds on a baseline reference machine (8-core CPU, 16 GB RAM, no dedicated GPU).
4. THE Transcription_Engine SHALL expose, for each transcript line, the provider used (`web-speech-api` or `local-whisper`) and the language tag detected.

### Requirement 3: Speaker Diarization & Attribution

**User Story:** As a user, I want each transcript line attributed to the correct speaker, so that the AI can reason about who said what.

#### Acceptance Criteria

1. THE Copilot_Engine SHALL reset the `speakerManager` singleton at the start of every Active_Session so that no state leaks across meetings. (Audit: `speakerManager` is module-level and never reset.)
2. THE Transcription_Engine SHALL store, on every transcript line, a `speakerId` whose value is one of the registered speaker ids (e.g., `speaker-1`, `speaker-2`) AND a `speakerRole` whose value is exactly `user` or `other`. (Audit: `useSpeechRecognition.ts` writes `speakerProfile.id` into a field typed as `'user' | 'other'`, causing the Question_Detector check `if (latestLine.speaker === 'user') return null` to never short-circuit and consequently triggering autonomous AI calls on the User's own speech.)
3. THE Question_Detector SHALL gate autonomous triggering on `speakerRole === 'other'` and SHALL not fire on transcript lines whose `speakerRole` is `user`.
4. WHEN the User toggles the active speaker via the control capsule or the keyboard shortcut, THE Copilot_Engine SHALL apply the new `speakerId` and `speakerRole` to every transcript line produced after the toggle.
5. WHERE the User has enabled voiceprint diarization in Settings, THE Transcription_Engine SHALL classify each final transcript line's `speakerRole` as `user` or `other` using a local audio embedding model and SHALL fall back to the most-recent manual assignment when classification confidence is below 0.55.
6. WHEN a silence gap of more than 2000 ms is detected between final transcript lines AND voiceprint diarization is disabled, THE Copilot_Engine SHALL flag the next line with a `possibleSpeakerChange: true` hint that the UI may surface.
7. THE Copilot_Engine SHALL store, with every transcript line, the speaker id, the detection method (`manual`, `gap-heuristic`, `voiceprint`), and a confidence in the range 0–1.

### Requirement 4: AI Provider Abstraction & Multi-Provider Support (Uplift)

**User Story:** As a user, I want to choose among Gemini, OpenAI, Anthropic, and a local model, with automatic failover, so that I am not locked into one vendor and so that I can keep working when one provider is down.

#### Acceptance Criteria

1. THE AI_Provider_Router SHALL define a single `Provider_Adapter` interface comprising `streamGenerate`, `complete`, `countTokens`, `name`, and `capabilities`.
2. THE AI_Provider_Router SHALL ship Provider_Adapters for at least Gemini, OpenAI (including o-series), Anthropic Claude, an OpenAI-compatible local-runtime endpoint (Ollama / LM Studio), and Simulation. (Audit: only Gemini supported; "router" is a misnomer.)
3. WHEN the User configures multiple providers, THE AI_Provider_Router SHALL invoke them in the User-defined priority order and SHALL fail over to the next provider on transport error, 5xx response, or timeout.
4. WHEN the User submits or the Question_Detector triggers a request, THE AI_Provider_Router SHALL impose a configurable per-request timeout (default 12 000 ms for streaming, 6 000 ms for non-streaming) and SHALL abort the underlying `fetch` if the timeout elapses. (Audit: no fetch timeout.)
5. IF a Provider_Adapter returns HTTP 429, 500, 502, 503, or 504, THEN THE AI_Provider_Router SHALL retry up to three times with exponential backoff starting at 500 ms, jitter ±20 %, and SHALL stop retrying once the cumulative wait exceeds 8 000 ms. (Audit: only 429 retried, fixed delay, no jitter.)
6. WHEN the AI_Provider_Router calls a provider that exposes header-based authentication, THE AI_Provider_Router SHALL pass the API key in an HTTP header rather than in a URL query parameter. (Audit: `?key=` leaks the API key into logs and history.)
7. WHILE a streaming response is in flight, THE AI_Provider_Router SHALL honour `AbortSignal.aborted` such that the underlying reader is cancelled within 200 ms of abort and `onComplete` is not invoked.
8. THE AI_Provider_Router SHALL parse server-sent events using event-boundary detection (blank line `\r?\n\r?\n`) rather than naive line splitting, and SHALL retain partial frames in a buffer across `read()` calls. (Audit: SSE parsing splits on `\n` only.)
9. WHERE simulated mode is selected or a real provider has failed over, THE AI_Provider_Router SHALL set `response.isSimulated = true` AND THE Response_Cache SHALL refuse to store responses with `isSimulated = true`. (Audit: simulated answers cached as if real.)
10. THE AI_Provider_Router SHALL select model tier (e.g., `gemini-1.5-flash` vs `gemini-1.5-pro`) using a routing function that takes input token count, mode, and User preference as inputs, with overrideable thresholds defined in Settings. (Audit: brittle keyword regex picks Pro model.)

### Requirement 5: Token-Aware Context Window Management

**User Story:** As a user, I want the AI to receive the most relevant context within the model's token budget, so that answers are accurate and cost is bounded.

#### Acceptance Criteria

1. THE Context_Builder SHALL count tokens using the active provider's tokenizer and SHALL bound the assembled prompt to a configurable budget (default 8 000 input tokens). (Audit: char-based 6 000-char trim only.)
2. WHEN the assembled prompt exceeds the budget, THE Context_Builder SHALL drop sections in the priority order `screen-text → older-transcript → lower-similarity-knowledge → older-knowledge` until the prompt fits, preserving section headers intact. (Audit: brutal middle-truncation cuts headers.)
3. THE Context_Builder SHALL include at most a configurable number of transcript lines (default 30 final lines) and at most a configurable number of knowledge chunks (default 5).
4. WHEN no `userQuery` is provided, THE Context_Builder SHALL form the retrieval query from the most recent question-shaped utterance detected by the Question_Detector, falling back to the last 200 characters of final transcript.
5. THE Context_Builder SHALL annotate every retrieved knowledge chunk in the prompt with a stable citation id (e.g., `[K1]`) AND THE AI_Provider_Router SHALL instruct the model to reference these ids in its answer.
6. THE Context_Builder SHALL emit a structured trace recording the system prompt size, knowledge size, transcript size, screen size, total token count, and which sections were dropped, accessible to Telemetry_Module.

### Requirement 6: Vector Index Correctness, Persistence, & Bounds

**User Story:** As a user, I want my knowledge base to give relevant retrievals quickly, with bounded storage, so that retrieval works well over time.

#### Acceptance Criteria

1. THE Vector_Index SHALL initialize using a deferred-promise pattern that does not pass an `async` function as the executor of `new Promise`. (Audit: `new Promise(async (resolve, reject) => …)` anti-pattern.)
2. WHEN initialization fails, THE Vector_Index SHALL retry on the next `generateEmbedding` call with exponential backoff up to three attempts.
3. THE Vector_Index SHALL persist the result of `generateEmbedding(query)` for the most-recent 256 distinct query strings to a session-scoped cache and SHALL invalidate that cache when the embedding model changes.
4. THE Vector_Index SHALL store document chunk vectors as `Float32Array` quantized to 8 bits with per-vector min/max metadata when stored count exceeds 1 000, reducing storage by at least 4× compared to full-precision storage.
5. THE Knowledge_Base search SHALL expose the cosine-similarity threshold and `maxResults` as parameters, defaulting to 0.40 and 5 respectively. (Audit: 0.4 hard-coded.)
6. THE Knowledge_Base SHALL apply a configurable retention cap (default 2 000 chunks total) AND, on insertion that would exceed the cap, SHALL evict the oldest chunks belonging to documents of type `notes` or `meeting-fact` first. (Audit: unbounded growth from auto-saved meeting facts.)
7. WHEN a document is deleted from the Knowledge_Base, THE Vector_Index SHALL invalidate any cached query results referencing chunks from that document.

### Requirement 7: Semantic Response Cache

**User Story:** As a user, I want repeated or near-duplicate questions to return instantly, without spending tokens, so that latency is low and costs are predictable.

#### Acceptance Criteria

1. THE Response_Cache SHALL use the Vector_Index to compute embeddings of cache keys and SHALL match using cosine similarity rather than Jaccard word overlap. (Audit: Jaccard misses paraphrase such as "what is X" vs "explain X".)
2. THE Response_Cache SHALL apply a least-recently-used eviction policy bounded by a configurable maximum entry count (default 256). (Audit: cache grows unbounded.)
3. THE Response_Cache SHALL persist entries to IndexedDB so that they survive page reloads within a single device, and SHALL expose a Settings toggle to clear and disable persistence.
4. THE Response_Cache SHALL refuse to store entries where `response.isSimulated = true`, where `response.text` is empty after trimming, or where the originating provider reported a non-2xx status.
5. WHEN a cache hit is served, THE Response_Cache SHALL emit a telemetry event `cache.hit` with the similarity score and SHALL annotate the served response with `fromCache: true`.

### Requirement 8: Question Detection & Autonomous Triggering

**User Story:** As a user, I want Zule to detect when a question is being asked of me and prepare an answer, without firing on every word, so that I get timely help without wasted compute.

#### Acceptance Criteria

1. THE Question_Detector SHALL debounce final-transcript triggers using a configurable interval (default 1500 ms) AND SHALL record the most-recent triggered text to suppress duplicate triggers.
2. THE Question_Detector SHALL throttle interim-text triggers such that no more than one autonomous request is emitted per 4 000 ms regardless of interim update frequency. (Audit: every interim update fires `triggerAI` — runaway cost.)
3. THE Question_Detector SHALL track interim-trigger and final-trigger suppression independently AND SHALL allow a final-transcript trigger to fire when its text differs from the most-recently-fired interim trigger by at least one whole word. (Audit: a single `lastTriggeredText` field is shared between interim and final paths so that a final identical to an already-fired interim is suppressed even though it is the first authoritative trigger.)
4. WHEN the Question_Detector decides to fire, THE Question_Detector SHALL emit a structured event `{ question, type, confidence, urgencyScore, source: 'final' | 'interim' }`.
5. WHERE the User's recognition language is non-English, THE Question_Detector SHALL apply a language-appropriate question-pattern set OR SHALL fall back to a single trailing-punctuation rule. (Audit: regex is English-only.)
6. WHILE the Other_Speaker is the active speaker AND the latest final line ends with a question mark, THE Question_Detector SHALL emit a trigger with confidence ≥ 0.6 even if no other pattern matches.

### Requirement 9: Real-Time Coaching & Speech Analytics

**User Story:** As a user, I want continuous coaching on my pace, fillers, and confidence, so that I improve mid-meeting.

#### Acceptance Criteria

1. WHEN the Active_Session has been running for at least 5 seconds, THE Coaching_Module SHALL update the displayed coaching metrics at a configurable cadence (default 2 000 ms).
2. THE Coaching_Module SHALL compute filler counts using whole-word matching anchored on word boundaries.
3. THE Coaching_Module SHALL compute words-per-minute using only User-attributed transcript lines and only the elapsed time during which the User was the active speaker.
4. WHEN computed pace falls below 90 wpm or rises above 180 wpm for at least 15 seconds of User speech, THE Coaching_Module SHALL surface a non-blocking visual nudge.
5. THE Coaching_Module SHALL produce identical outputs for identical input tuples `(text, totalWordCount, durationSeconds)` independent of wall-clock time, prior calls, or hidden module state.
6. THE Coaching_Module SHALL bound `confidenceScore` to the closed interval [0, 100] for any non-negative `wordsPerMinute` and any `fillerRatio` in [0, 1].

### Requirement 10: Session Summary, Action Items, & Memory Capture

**User Story:** As a user, I want a robust meeting summary, action items, follow-up email, and durable memory, so that I can recall and act on what happened.

#### Acceptance Criteria

1. WHEN the User stops an Active_Session, THE Copilot_Engine SHALL request a structured summary from the AI_Provider_Router AND SHALL persist a placeholder meeting record before the summary completes so that no transcript is lost on tab close.
2. THE summary parser SHALL extract a JSON object from a model response that may contain leading/trailing whitespace, surrounding markdown code fences, embedded code fences, and trailing commentary by locating the outermost balanced `{ … }`. (Audit: brittle prefix/suffix stripping.)
3. IF JSON extraction fails, THEN THE Copilot_Engine SHALL retry once with a stricter "respond ONLY with JSON" instruction before returning a fallback summary.
4. THE Copilot_Engine SHALL store every action item with a stable id, completion state, source quote from the transcript, and creation timestamp.
5. WHERE the User has opted in, THE Copilot_Engine SHALL save extracted `keyFacts` to the Memory_Store with an explicit `source: meeting:{meetingId}` tag AND SHALL apply Redaction_Engine rules before saving. (Audit: meeting facts saved indiscriminately to KB without dedup or PII filtering.)
6. THE Memory_Store SHALL deduplicate facts whose embedding cosine similarity to an existing stored fact exceeds 0.92 by retaining the longer text and merging timestamps.
7. IF the asynchronous fact-saving operation outlives the component lifecycle, THEN THE Copilot_Engine SHALL ensure the operation runs to completion using a top-level promise tracker rather than `setTimeout(…, 0)` orphan tasks. (Audit: orphan async via `setTimeout`.)

### Requirement 11: Cross-Window Sync & Detached Mode Reliability

**User Story:** As a user, I want the detached copilot window to mirror state reliably and recover from disconnections, so that I can keep the UI off the shared screen.

#### Acceptance Criteria

1. THE Cross_Window_Sync SHALL include a monotonically increasing `version` on every state-update message AND SHALL reject incoming updates whose `version` is less than the most-recently-applied version.
2. WHEN the Detached_Window opens, THE Cross_Window_Sync SHALL request a full snapshot from the host AND THE host SHALL respond within 500 ms.
3. WHILE the Detached_Window is open, THE host SHALL emit a heartbeat at 5 000 ms intervals AND THE Detached_Window SHALL display a `host disconnected` state if no heartbeat arrives for 15 000 ms.
4. WHERE `BroadcastChannel` is unavailable, THE Cross_Window_Sync SHALL fall back to `localStorage`-event-based messaging with the same message schema. (Audit: no fallback for unsupported browsers.)
5. WHEN `window.open` returns null (popup blocked), THE Copilot_Engine SHALL surface a recoverable error guiding the User to allow popups for the origin and SHALL leave the in-page overlay visible. (Audit: no popup-block handling.)
6. WHEN the host window is closed or refreshed, THE Detached_Window SHALL detect host loss within 15 000 ms and SHALL display a "reconnect" affordance that re-opens the host or closes itself.
7. THE Cross_Window_Sync message types SHALL be defined as a discriminated union with no `any`-typed payloads. (Audit: payloads typed as `any`.)

### Requirement 12: Floating Overlay Lifecycle & Memory Hygiene

**User Story:** As a user, I want the floating overlay to behave correctly across the full session lifecycle without leaks or stale closures, so that long meetings stay responsive.

#### Acceptance Criteria

1. WHEN the FloatingCopilot component unmounts, THE Copilot_Engine SHALL invoke `abortControllerRef.current.abort()` on any in-flight AI request, stop the elapsed-time interval, and tear down all event listeners. (Audit: in-flight stream not aborted on unmount.)
2. WHEN the User invokes manual submit while an autonomous trigger is mid-stream, THE Copilot_Engine SHALL abort the in-flight request before issuing the new one AND SHALL discard any tokens received from the aborted request.
3. WHEN the viewport size changes, THE Copilot_Engine SHALL re-clamp the overlay position to remain fully on-screen. (Audit: drag offset can leave the overlay off-screen after resize.)
4. WHILE the overlay is hidden via Escape, THE User SHALL be able to restore the overlay using the same hide-toggle keyboard shortcut without dependence on the mouse. (Audit: Escape hides but no symmetric show.)
5. THE Copilot_Engine SHALL not call the AI_Provider_Router from a `useEffect` whose dependency array includes a function recreated on every render. (Audit: `triggerAI` is recreated each render and used inside `useEffect` keyed on transcript, causing re-fires.)

### Requirement 13: Screen Capture Efficiency & OCR Pipeline

**User Story:** As a user, I want screen-aware context without my laptop overheating, so that screen capture is sustainable for long sessions.

#### Acceptance Criteria

1. WHEN screen capture is active, THE Screen_Capture_Module SHALL downscale each captured frame to a maximum 1280-pixel longest edge before passing it to the OCR_Worker.
2. THE Screen_Capture_Module SHALL skip OCR on a frame whose perceptual hash differs from the previously OCR-ed frame by less than a configurable threshold (default 5 bits Hamming distance), enabling change-detection. (Audit: every 3 s OCR runs full frame regardless of change.)
3. THE OCR_Worker SHALL be terminated when screen capture stops AND SHALL be re-created lazily on the next capture start. (Audit: worker is never terminated.)
4. WHERE the User has selected a non-English OCR language, THE OCR_Worker SHALL load the corresponding Tesseract language pack on demand and SHALL cache it locally.
5. IF `videoElement.play()` rejects (autoplay-blocked), THEN THE Screen_Capture_Module SHALL surface a recoverable error and SHALL stop the capture stream. (Audit: `play()` rejection unhandled.)
6. THE Screen_Capture_Module SHALL retain the most-recent 5 OCR results with timestamps so that the Context_Builder can reason about screen change rather than only the latest frame.

### Requirement 14: Latency Budget & End-to-End Performance

**User Story:** As a user, I want a clear, measurable latency from question detection to first visible token, so that "what should I say?" feels real-time.

#### Acceptance Criteria

1. THE Copilot_Engine SHALL define a Latency_Budget with a default target of 1500 ms for time-to-first-token (TTFT) and 4 000 ms for total streaming completion under a 50-token answer.
2. WHEN a question is detected, THE Copilot_Engine SHALL record `t_detected`, `t_request_sent`, `t_first_token`, and `t_complete` timestamps.
3. WHEN TTFT exceeds the configured budget for two consecutive requests, THE Telemetry_Module SHALL emit a `latency.degraded` event AND THE UI SHALL surface a non-blocking indicator.
4. WHILE measuring latency, THE Copilot_Engine SHALL include warm-cache hits as zero-latency events in a separate metric stream so that they do not mask provider regressions.

### Requirement 15: Privacy, Redaction, & Stealth

**User Story:** As a privacy-conscious user, I want strong control over what leaves my device and confidence that the overlay does not appear in shared screens, so that I can use Zule in sensitive meetings.

#### Acceptance Criteria

1. THE Settings_Store SHALL persist API keys using a one-time, user-supplied passphrase as input to a key-derivation function (PBKDF2, SHA-256, 200 000 iterations) AND SHALL store keys encrypted with AES-GCM. (Audit: API key stored in IndexedDB unencrypted.)
2. WHILE the User is unauthenticated for the session, THE AI_Provider_Router SHALL refuse to use cloud providers AND SHALL surface a "unlock" prompt.
3. THE Redaction_Engine SHALL apply a User-defined rule set (regex and entity classes such as email, phone, credit-card, IBAN, US-SSN) to transcript and screen text before either is included in any prompt sent to a cloud Provider_Adapter.
4. WHERE the User has selected `privacy.mode = ephemeral`, THE Meeting_Store SHALL not persist transcripts or summaries to disk and SHALL retain the session only in memory until the Active_Session ends.
5. THE Stealth_Layer SHALL use the `display: contents` Detached_Window approach for screen-share invisibility AND, additionally, SHALL set the floating overlay's `data-zule-stealth="true"` attribute so that browser extensions and OS-level capture filters can identify and exclude it.
6. WHERE the host browser supports the `Element.requestFullscreen` API plus `BrowserCaptureMediaStreamTrack.cropTo`, THE Stealth_Layer SHALL provide a "crop tab to content area" mode that excludes the overlay region from the captured tab stream and SHALL document the limitation that this mode applies only to tab capture.
7. THE application SHALL set a Content-Security-Policy meta tag whose `script-src` directive lists only `'self'` plus the explicit origins required by the configured Provider_Adapters (e.g., `https://generativelanguage.googleapis.com`, `https://api.openai.com`, `https://api.anthropic.com`, `https://huggingface.co`, `https://cdn-lfs.huggingface.co`) AND SHALL serve the PDF.js worker, the Tesseract worker, and the Transformers.js runtime from the application origin rather than third-party CDNs. (Audit: PDF.js worker fetched from `cdnjs.cloudflare.com`.)
8. WHEN the User triggers "panic hide" via a configurable shortcut (default `Ctrl+Shift+\`), THE Copilot_Engine SHALL hide the overlay, mute the microphone, stop screen capture, and pause autonomous AI calls within 200 ms.

### Requirement 16: Persistence Schema, Migrations, & Import/Export

**User Story:** As a user, I want a single coherent local database, with safe migrations and validated imports, so that my data is portable and durable.

#### Acceptance Criteria

1. THE application SHALL use a single IndexedDB database (`zule-unified`) AND SHALL remove the legacy `zule-store` database after migrating any prior records into the unified schema. (Audit: `src/utils/storage.ts` opens a separate `zule-store` DB; dead code or split-brain risk.)
2. WHEN the IndexedDB version is upgraded, THE persistence layer SHALL run an idempotent migration sequence covering every previous version AND SHALL log the migration path applied.
3. WHEN the User imports a JSON export, THE persistence layer SHALL validate the payload against a schema (version, exportedAt as number, arrays of typed records) AND SHALL reject the import on validation failure without mutating any store.
4. WHEN a write fails with `QuotaExceededError`, THE persistence layer SHALL surface a recoverable error to the UI offering "delete oldest meetings" and "delete oldest knowledge chunks" actions. (Audit: only `console.error`.)
5. THE persistence layer SHALL apply background retention rules (default: meetings older than 365 days deleted, transcripts truncated to 50 000 lines per meeting) configurable via Settings.

### Requirement 17: Internationalization & Localization

**User Story:** As a non-English user, I want to use Zule in my language across speech, OCR, UI, and prompts, so that the product is usable globally.

#### Acceptance Criteria

1. THE Settings_Store SHALL persist a UI locale (BCP-47), a recognition language, and an OCR language as independent values.
2. THE Copilot_Engine SHALL resolve all user-visible strings through an i18n module supporting at minimum English, Spanish, French, German, Japanese, and Simplified Chinese. (Audit: hard-coded English strings throughout.)
3. WHEN the recognition language is set to a non-English language, THE Question_Detector SHALL load language-appropriate patterns as defined in Requirement 8.5.
4. WHERE the system prompts in `modePrompts.ts` are presented to the model, THE Copilot_Engine SHALL append a language directive matching the User's recognition language so that model output matches the spoken language.

### Requirement 18: Accessibility (A11y)

**User Story:** As a user who relies on assistive technology, I want Zule to be fully usable via keyboard and screen reader, with respect for motion preferences, so that I am not excluded.

#### Acceptance Criteria

1. THE Copilot_Engine SHALL apply an accessible name (via `aria-label` or visible text) to every icon-only button in the control capsule, suggestion card, and quick actions. (Audit: icon-only buttons have no accessible name.)
2. WHEN streaming AI text is updated, THE suggestion card SHALL render the streaming region as an `aria-live="polite"` region so screen readers announce updates.
3. THE Copilot_Engine SHALL support keyboard focus traversal through control capsule, transcript, suggestion card, follow-up chips, mode selector, and input bar in a logical reading order.
4. THE Copilot_Engine SHALL provide a keyboard shortcut to reposition the overlay in 8 directions and to recenter, so that a mouse is not required.
5. WHERE `prefers-reduced-motion: reduce` is set, THE application SHALL disable framer-motion entrance, exit, looping, and parallax animations AND SHALL render static equivalents.
6. THE application SHALL meet WCAG 2.1 AA contrast for all body text and interactive elements in both light and dark themes (verified by automated axe-core checks plus manual review).
7. WHERE `alert()` is currently used to surface recoverable errors, THE Copilot_Engine SHALL replace it with the existing toast system that exposes ARIA `role="status"` for non-blocking errors and `role="alert"` for blocking errors. (Audit: `alert()` in `Settings.tsx`.)

### Requirement 19: Observability & Telemetry (Local-First)

**User Story:** As a user and as a future operator, I want local-first observability of latency, errors, and quality, with strict opt-in for any external telemetry, so that I can diagnose issues without giving up privacy.

#### Acceptance Criteria

1. THE Telemetry_Module SHALL collect at minimum these metrics: TTFT, total request latency, retry counts per provider, cache hit rate, transcript drop rate, OCR frames skipped, embedding-cache hit rate, and memory-store size.
2. THE Telemetry_Module SHALL store metrics locally in IndexedDB AND SHALL expose a "view diagnostics" page that renders the most-recent 24 hours of metrics.
3. WHEN an error is caught by an ErrorBoundary or an async catch, THE Telemetry_Module SHALL record an entry with stack, breadcrumb, and a content-free context payload.
4. WHERE the User has opted in to external telemetry, THE Telemetry_Module SHALL send only metric events (no transcript, no screen text, no API key) over HTTPS to the configured endpoint.
5. THE Telemetry_Module SHALL never include API key material, transcript text, or screen text in any persisted record. (Compliance with 19.5 SHALL be covered by an automated test.)

### Requirement 20: Reliability — Offline, Recovery, & Watchdog

**User Story:** As a user with flaky network or unreliable resources, I want clear graceful degradation, so that Zule keeps helping me even when something fails.

#### Acceptance Criteria

1. WHEN `navigator.onLine` transitions to `false`, THE Copilot_Engine SHALL display an offline banner AND SHALL switch the AI_Provider_Router to local-runtime or simulation per User configuration.
2. WHILE offline, THE Knowledge_Base SHALL continue to serve retrievals AND THE Transcription_Engine SHALL continue if the local-Whisper provider is configured.
3. THE OCR_Worker SHALL be supervised by a watchdog that, on three consecutive thrown errors within 30 seconds, terminates and recreates the worker once and then disables OCR for the session if it errors again.
4. WHEN any background task (model download, Whisper init, OCR language pack) is in flight, THE UI SHALL display its progress through a single ModelLoader queue rather than overlapping toasts.
5. THE Copilot_Engine SHALL include a top-level `unhandledrejection` listener that records to Telemetry_Module and surfaces a non-blocking error toast when in an Active_Session.

### Requirement 21: Bundle Size & Cold-Start Performance

**User Story:** As a first-time visitor, I want Zule to render the landing page and dashboard quickly, even if heavy AI assets load later, so that I am not blocked by tens of megabytes of model files.

#### Acceptance Criteria

1. THE application SHALL code-split the Vector_Index, OCR_Worker, document parsers (PDF.js, mammoth), and the AI Provider_Adapters into separate chunks loaded on demand.
2. WHEN the LandingPage is rendered, THE main JavaScript bundle SHALL not exceed 300 KB gzip (excluding code-split chunks). (Audit: current setup loads heavy deps eagerly.)
3. THE Vector_Index SHALL not be initialized until either an Active_Session begins or the User opens the Knowledge_Base section of Settings.
4. WHEN loading the Whisper-class model or the embedding model, THE ModelLoader SHALL display percentage progress AND SHALL allow the User to cancel.
5. THE PDF.js worker SHALL be served from the application origin (bundled or copied to `public/`) rather than a third-party CDN. (Audit: `cdnjs.cloudflare.com` URL.)

### Requirement 22: Personalization & Style Learning (Uplift)

**User Story:** As a user, I want Zule to learn my voice, vocabulary, and preferred answer style over time, so that suggestions sound like me, not like a generic LLM.

#### Acceptance Criteria

1. WHERE the User has opted in to personalization, THE Copilot_Engine SHALL maintain a `style_profile` derived from User-attributed transcript lines including vocabulary frequency, average sentence length, hedging-word usage, and tone classification.
2. WHEN the AI_Provider_Router builds prompts, THE Context_Builder SHALL inject a compact style directive derived from the `style_profile` (e.g., "match the User's preference for short, declarative sentences").
3. WHEN the User edits an AI suggestion before sending, THE Copilot_Engine SHALL record the edit as a pairwise preference signal AND SHALL update the `style_profile`.
4. THE `style_profile` SHALL be storable, exportable, importable, and clearable via Settings.

### Requirement 23: Multi-Modal Fusion (Uplift)

**User Story:** As a user, I want the AI to reason jointly over what I'm hearing and what's on my screen, so that answers reference both modalities accurately.

#### Acceptance Criteria

1. THE Context_Builder SHALL include a structured multi-modal section labelling each block with `[AUDIO]`, `[SCREEN]`, `[KNOWLEDGE]`, and `[MEMORY]` so that the model can reference modalities explicitly.
2. WHEN both screen text and the latest transcript line reference overlapping entities (e.g., a product name appears in both), THE Context_Builder SHALL surface a fusion hint in the prompt.
3. WHERE the configured Provider_Adapter supports image inputs and the User has opted in to image inputs, THE Screen_Capture_Module SHALL provide a downscaled keyframe image alongside OCR text for the model to consume.
4. THE Copilot_Engine SHALL display, with each AI answer, badges indicating which modalities were used (audio, screen, knowledge, memory).

### Requirement 24: Cross-Meeting Memory Recall in Real Time (Uplift)

**User Story:** As a user, I want Zule to recall facts from prior meetings in real time, so that I do not repeat myself and I get continuity.

#### Acceptance Criteria

1. THE Memory_Store SHALL be searched in addition to the Knowledge_Base on every retrieval AND THE Context_Builder SHALL clearly label memory-derived chunks as `[MEMORY: meeting:{id}, {date}]`.
2. WHEN a memory chunk is included in a prompt, THE UI SHALL render a citation chip in the suggestion card AND clicking the chip SHALL navigate to that meeting's detail page.
3. THE User SHALL be able to mark any memory chunk as "forget" AND THE Memory_Store SHALL hard-delete the chunk and its embedding.

### Requirement 25: Document Ingestion Robustness (Parsers)

**User Story:** As a user uploading PDFs and DOCX files, I want consistent extraction without crashes, so that my knowledge base is reliable.

#### Acceptance Criteria

1. WHEN the User uploads a PDF, THE Document_Parser SHALL extract text page by page AND SHALL handle encrypted PDFs by surfacing a recoverable error rather than throwing.
2. WHEN the User uploads a DOCX, THE Document_Parser SHALL extract raw text via mammoth AND SHALL preserve paragraph breaks.
3. THE Document_Parser SHALL accept `.txt`, `.md`, `.json`, `.pdf`, and `.docx` AND SHALL reject other extensions with a clear, non-blocking error message that does not use `alert()`.
4. THE Document_Parser SHALL chunk text using a token-aware splitter (default 300 tokens, 50 token overlap) rather than a word-count splitter when the embedding model exposes a tokenizer.
5. THE Document_Parser SHALL provide a round-trip property: for any plain-text input shorter than 10 000 words, `chunkText(input).join(' ')` after dedup-of-overlap SHALL contain every word of the input in order. (This is a parser/serializer-style round-trip property.)

### Requirement 26: Evaluation Harness & Quality Signals (Uplift)

**User Story:** As a user, I want to know whether AI answers are getting better or worse over time, so that I can trust the system.

#### Acceptance Criteria

1. THE Copilot_Engine SHALL allow the User to record a thumbs-up / thumbs-down on every AI answer AND SHALL persist the rating with the originating prompt hash, model id, latency, and modality badges.
2. THE Settings page SHALL expose an Evaluation tab that surfaces aggregate ratings per provider, per mode, and per modality combination.
3. WHERE the User has opted in, THE Telemetry_Module SHALL include rating events in external telemetry without including prompt or response text.

### Requirement 27: Stop-Session UX & Data Integrity

**User Story:** As a user, I want the stop-session flow to be safe even if something goes wrong with summary generation, so that I never lose a meeting.

#### Acceptance Criteria

1. WHEN the User clicks Stop, THE Copilot_Engine SHALL persist the raw transcript and analytics to the Meeting_Store before invoking the summary generator. (Audit: current flow generates summary first; if the tab is closed mid-generation the meeting is lost.)
2. WHEN summary generation completes successfully, THE Copilot_Engine SHALL update the persisted Meeting record with summary, action items, follow-up email, and key facts.
3. IF summary generation fails or times out (default 60 000 ms), THEN THE Copilot_Engine SHALL persist the meeting with a placeholder summary and an `aiSummaryStatus = failed` field AND SHALL allow the User to retry summary generation from the meeting detail page.
4. WHILE summary generation is running, THE UI SHALL prevent the User from accidentally double-clicking Stop AND SHALL allow the User to cancel summary generation, leaving the meeting persisted with the placeholder summary.

### Requirement 28: Provider Cost & Token Telemetry (Uplift)

**User Story:** As a user paying for cloud LLMs, I want to know how many tokens and approximate dollars each session consumes, so that I can manage spend.

#### Acceptance Criteria

1. THE AI_Provider_Router SHALL record, per request, prompt tokens, completion tokens, model id, and provider id.
2. THE Settings_Store SHALL allow the User to configure per-model price (input/output per million tokens) AND THE Telemetry_Module SHALL multiply token counts by the configured prices to produce an approximate cost.
3. THE Settings page SHALL expose a Spend tab that summarizes daily, weekly, and monthly approximate cost per provider and per session.

### Requirement 29: Configurable Latency, Cost, and Privacy Profile (Uplift)

**User Story:** As a user, I want to choose a profile that biases the system toward speed, cost, or privacy, so that I can match Zule to the meeting type.

#### Acceptance Criteria

1. THE Settings_Store SHALL persist a `profile` value with values `speed`, `balanced`, `cost`, and `privacy`.
2. WHERE `profile = speed`, THE AI_Provider_Router SHALL prefer the fastest available model AND THE Question_Detector SHALL use a lower confidence threshold (0.6).
3. WHERE `profile = cost`, THE AI_Provider_Router SHALL prefer the cheapest available model AND THE Response_Cache similarity threshold SHALL widen to 0.78.
4. WHERE `profile = privacy`, THE AI_Provider_Router SHALL refuse cloud providers AND THE Memory_Store SHALL operate in ephemeral mode for the session.

### Requirement 30: Automated Test Coverage

**User Story:** As a maintainer, I want core correctness logic covered by automated tests, so that regressions are caught before users see them.

#### Acceptance Criteria

1. THE project SHALL include unit tests for `chunkText`, `analyzeSentiment`, `countFillers`, `calculateWPM`, `calculateConfidence`, `detectQuestion`, `detectInterimQuestion`, `normalizeText`, the SSE parser, the JSON-extractor used by the summary engine, the Vector_Index cosine similarity, and the Context_Builder token-budget trimming.
2. THE project SHALL include property-based tests covering at minimum: round-trip property for `chunkText` (Requirement 25.5), idempotence of `Redaction_Engine.apply` on already-redacted text, and bounds (`0 ≤ confidenceScore ≤ 100`) on `calculateConfidence` for any non-negative `wpm` and `fillerRatio` in `[0, 1]`.
3. THE project SHALL include integration tests for the Active_Session lifecycle (start → transcript → trigger → stream → stop → meeting persisted) using mocked Provider_Adapters.
4. THE CI pipeline SHALL fail when test coverage on the `src/brain/` directory drops below 80 % statements.
