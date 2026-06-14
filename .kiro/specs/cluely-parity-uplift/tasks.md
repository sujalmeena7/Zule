# Implementation Plan: Cluely Parity Uplift

## Overview

This plan converts the design into a sequence of discrete, incremental coding tasks that remediate the audit defects and deliver the Cluely-parity uplifts. The work is organised so that **pure logic helpers** land first (each with its property-based tests), then the **domain modules** that compose them (provider router, context builder, response cache, question detector, transcription, etc.), then the **orchestration and UI** that wires them together (stop-session flow, FloatingCopilot lifecycle, cross-window sync, settings, stealth, observability), and finally the **end-to-end integration tests and CI gates**. Every task references the granular acceptance criteria it implements; every property-test sub-task references the property number and the requirements clauses it validates.

The implementation language is **TypeScript** (matches the existing Vite + React + TypeScript project). Property-based tests use **fast-check** under **Vitest**; integration tests use **Playwright** with **axe-core** for accessibility.

## Tasks

- [x] 1. Establish testing, tooling, and shared-type foundation
  - [x] 1.1 Add Vitest, fast-check, coverage-v8, fake-indexeddb, Playwright, and axe-core dev dependencies
    - Add the libraries to `package.json` with pinned versions
    - Add `vitest.config.ts` (jsdom environment, coverage thresholds for `src/brain/` ≥ 80%)
    - Add `playwright.config.ts` configured to run against `vite preview`
    - Add `npm run test`, `npm run test:e2e`, and `npm run test:coverage` scripts
    - _Requirements: 30.1, 30.3, 30.4_
  - [x] 1.2 Define shared types and the `ZuleError` discriminated union
    - Create `src/types/result.ts` (`Result<T, E>` helper)
    - Create `src/types/errors.ts` (`ZuleError` union from design §Error Handling)
    - Create `src/types/transcription.ts` (`TranscriptionLine`, `SpeakerRole`, `DetectionMethod`, `TranscriptionProvider`)
    - Create `src/types/sync.ts` (`SyncMessage` discriminated union, `SyncState`)
    - Create `src/types/ai.ts` (`ProviderAdapter`, `Capabilities`, `ProviderResponse`, `StreamCallbacks`, `PromptInput`)
    - Create `src/types/redaction.ts` (`RedactionRule`)
    - _Requirements: 3.2, 3.7, 11.7, 4.1_
  - [x] 1.3 Add `PendingTaskTracker` and `useZuleError` hook
    - Implement `src/utils/pendingTaskTracker.ts` for top-level promise tracking
    - Implement `src/hooks/useZuleError.ts` translating `ZuleError` into a toast and a telemetry emit
    - Replace existing `console.error` and `alert()` call-sites in `Settings.tsx` and elsewhere with the hook
    - _Requirements: 10.7, 18.7_

- [x] 2. Implement pure logic helpers (audit-critical, all PBT-backed)
  - [x] 2.1 Implement `restartBackoff(k)` and the bounded-restart supervisor
    - Create `src/brain/backoff.ts` with `restartBackoff(attempt: number): number`
    - Create `src/brain/restartSupervisor.ts` (event-driven state machine: 5 restarts in 60 s pauses)
    - _Requirements: 1.2, 1.3, 4.5, 20.3_
  - [ ]* 2.2 Property test: backoff is bounded and monotonic
    - **Property 1: Restart backoff is bounded and monotonic**
    - **Validates: Requirements 1.2, 4.5**
  - [ ]* 2.3 Property test: supervisor pauses after 5 consecutive restarts in 60 s
    - **Property 2: Supervisor pauses after 5 consecutive restarts inside 60 s**
    - **Validates: Requirements 1.3, 20.3**
  - [x] 2.4 Implement SSE parser with chunk-boundary safety
    - Create `src/brain/sse.ts` exporting `parseSseFrames(buf: string): { events: SseEvent[]; rest: string }`
    - Split on `\r?\n\r?\n`; retain partial frames across `read()` calls
    - _Requirements: 4.8_
  - [ ]* 2.5 Property test: SSE parser is invariant under chunk boundaries
    - **Property 12: SSE parser is invariant under chunk boundaries**
    - **Validates: Requirements 4.8**
  - [x] 2.6 Implement balanced-brace JSON extractor
    - Create `src/brain/jsonExtract.ts` with `extractJsonObject(text: string): object | null`
    - Locate outermost balanced `{ ... }`, tolerate code fences and trailing commentary
    - _Requirements: 10.2, 10.3_
  - [ ]* 2.7 Property test: JSON extractor round-trip
    - **Property 28: JSON extractor is round-trip exact**
    - **Validates: Requirements 10.2**
  - [x] 2.8 Implement position clamp and downscale helpers
    - Create `src/utils/geometry.ts` with `clampPosition`, `downscaleSize`
    - _Requirements: 12.3, 13.1, 18.4_
  - [ ]* 2.9 Property test: position clamp keeps overlay on-screen and is idempotent
    - **Property 34: Position clamp keeps the overlay on-screen**
    - **Validates: Requirements 12.3, 18.4**
  - [ ]* 2.10 Property test: downscale preserves aspect ratio and longest-edge bound
    - **Property 37: Downscale preserves aspect ratio and the longest-edge bound**
    - **Validates: Requirements 13.1**
  - [x] 2.11 Implement perceptual hash and Hamming distance
    - Create `src/utils/phash.ts` with `phash(imageData)` and `hammingDistance(a, b)`
    - _Requirements: 13.2_
  - [ ]* 2.12 Property test: perceptual-hash skip is reflexive and bounded
    - **Property 38: Perceptual-hash skip is reflexive and bounded**
    - **Validates: Requirements 13.2**
  - [x] 2.13 Implement cosine similarity and int8 quantization helpers
    - Create `src/brain/vectorMath.ts` with `cosineSimilarity`, `quantize`, `dequantize`
    - _Requirements: 6.4, 7.1_
  - [ ]* 2.14 Property test: quantization is approximately reversible and shrinks storage
    - **Property 18: Quantization is approximately reversible and shrinks storage**
    - **Validates: Requirements 6.4**
  - [x] 2.15 Implement model selector (pure)
    - Create `src/brain/modelSelector.ts` with `selectModel({ tokens, mode, profile, registry })`
    - Implement profile-aware tier selection (speed/cost/privacy/balanced)
    - _Requirements: 4.10, 29.2, 29.3, 29.4_
  - [ ]* 2.16 Property test: model selection is monotonic in input tokens and respects profiles
    - **Property 14: Model selection is monotonic in input tokens**
    - **Validates: Requirements 4.10, 29.2, 29.3, 29.4**
  - [x] 2.17 Implement cost calculator
    - Create `src/brain/cost.ts` with `computeCost({ promptTokens, completionTokens, pricePerMTokens })`
    - _Requirements: 28.1, 28.2, 28.3_
  - [ ]* 2.18 Property test: cost calculation is non-negative and additive
    - **Property 60: Cost calculation is non-negative and additive**
    - **Validates: Requirements 28.1, 28.2, 28.3**

- [x] 3. Implement Redaction_Engine
  - [x] 3.1 Implement regex-and-entity redaction engine
    - Create `src/brain/redaction.ts` with `apply(text, rules)` and `applyToSections(sections, rules)`
    - Built-in entity classes: email, phone, credit-card, IBAN, US-SSN with replacements that do not re-match
    - _Requirements: 15.3_
  - [ ]* 3.2 Property test: redaction is idempotent and applied before cloud egress
    - **Property 44: Redaction is applied before any cloud egress and is idempotent**
    - **Validates: Requirements 15.3, 30.2**

- [x] 4. Implement CryptoVault and unified IndexedDB schema
  - [x] 4.1 Implement `CryptoVault` (PBKDF2 + AES-GCM)
    - Create `src/utils/cryptoVault.ts` with `unlock(passphrase)`, `encrypt(plaintext)`, `decrypt(ciphertext)`
    - PBKDF2(SHA-256, 200 000 iterations) for key derivation; AES-GCM 256
    - _Requirements: 15.1, 15.2_
  - [ ]* 4.2 Property test: AES-GCM key vault round-trips arbitrary plaintext
    - **Property 42: AES-GCM key vault round-trips arbitrary plaintext**
    - **Validates: Requirements 15.1**
  - [x] 4.3 Migrate `src/data/database.ts` to `zule-unified` v4 schema
    - Add stores: `memory_facts`, `telemetry`, `response_cache`, `ratings`, `style_profile`
    - Add indexes on `meetings (startedAt, mode)`, `documents (type, createdAt)`
    - Implement v3 → v4 migration that copies legacy `zule-store` rows then deletes the legacy DB
    - Re-encode plaintext `apiKey` setting into `providers[].apiKeyCipher` after passphrase prompt
    - Delete `src/utils/storage.ts` (dead code) after migration confirms parity
    - _Requirements: 16.1, 16.2_
  - [ ]* 4.4 Property test: migration is idempotent across all prior versions
    - **Property 46: Migration is idempotent**
    - **Validates: Requirements 16.2**
  - [x] 4.5 Implement quota-exceeded recovery and retention rules
    - Surface `storage.quota-exceeded` with "delete oldest meetings" / "delete oldest knowledge chunks" actions
    - Implement `applyRetention(meetings, maxAgeDays, maxLines)` background sweep
    - _Requirements: 16.4, 16.5_
  - [ ]* 4.6 Property test: retention eliminates overdue records
    - **Property 48: Retention rules eliminate overdue records**
    - **Validates: Requirements 16.5**
  - [x] 4.7 Implement validated import/export
    - Create `src/data/exportImport.ts` with `validateExport(json)` returning `{ ok, value | error }`
    - Reject without mutation on validation failure; surface a non-blocking toast
    - _Requirements: 16.3_
  - [ ]* 4.8 Property test: import validation is total and non-mutating
    - **Property 47: Import validation is total**
    - **Validates: Requirements 16.3**

- [x] 5. Implement Vector_Index v2
  - [x] 5.1 Refactor initialization to deferred-promise pattern with retry
    - Replace `new Promise(async ...)` anti-pattern with deferred-promise constructor
    - Add init-failure exponential backoff up to 3 attempts on next `generateEmbedding` call
    - _Requirements: 6.1, 6.2_
  - [x] 5.2 Add session-scoped query-embedding LRU and quantized chunk storage
    - 256-entry LRU keyed by query string, invalidated when embedding model changes
    - Quantize stored vectors to int8 with per-vector `min`/`max` once stored count exceeds 1 000
    - _Requirements: 6.3, 6.4_
  - [x] 5.3 Add configurable retrieval thresholds and retention cap
    - Expose `similarityThreshold` (default 0.40) and `maxResults` (default 5) parameters
    - Enforce 2 000-chunk Knowledge_Base cap; evict oldest `notes`/`meeting-fact` chunks first
    - Invalidate query cache when documents are deleted
    - _Requirements: 6.5, 6.6, 6.7_
  - [ ]* 5.4 Property test: search bounds and threshold are honoured
    - **Property 17: Vector_Index search bounds and threshold are honoured**
    - **Validates: Requirements 6.5**
  - [ ]* 5.5 Property test: Knowledge_Base retention cap and eviction order
    - **Property 19: Knowledge_Base retention cap is preserved under insertion**
    - **Validates: Requirements 6.6**

- [x] 6. Implement Document_Parser refactor
  - [x] 6.1 Self-host PDF.js and Tesseract workers and switch parser to local origin
    - Copy PDF.js, Tesseract, and Transformers.js runtime assets to `public/` at build time
    - Set `pdfjsLib.GlobalWorkerOptions.workerSrc` to a local `/` path
    - _Requirements: 15.7, 21.5_
  - [x] 6.2 Implement token-aware chunker, encrypted-PDF handling, and DOCX paragraph preservation
    - Refactor `src/utils/documentParser.ts` to a Web Worker
    - Default 300-token chunks with 50-token overlap when tokenizer is available
    - Catch `PasswordException` → `document.encrypted-pdf` recoverable error
    - Split `mammoth.extractRawText` output on `\n\n`
    - Reject extensions outside `{txt,md,json,pdf,docx}` via toast (no `alert`)
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 18.7_
  - [ ]* 6.3 Property test: chunker round-trip preserves words in order
    - **Property 56: Document chunker round-trip**
    - **Validates: Requirements 25.5**
  - [ ]* 6.4 Property test: token-aware chunker respects size
    - **Property 57: Token-aware chunker respects size**
    - **Validates: Requirements 25.4**
  - [ ]* 6.5 Property test: DOCX paragraph preservation
    - **Property 58: DOCX paragraph preservation**
    - **Validates: Requirements 25.2**
  - [ ]* 6.6 Property test: extension validation is total
    - **Property 59: Document parser extension validation**
    - **Validates: Requirements 25.3, 18.7**

- [x] 7. Checkpoint - Foundations and pure logic
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement Provider Adapters and AI_Provider_Router
  - [x] 8.1 Define `ProviderAdapter` interface and shared HTTP utilities
    - Create `src/brain/providers/types.ts` (already partly in 1.2) and `src/brain/providers/http.ts`
    - HTTP utility imposes per-request timeout (12 000 ms streaming, 6 000 ms non-streaming) with `AbortController`
    - Shared retry-with-jitter helper (3 attempts, 500 ms ± 20 %, 8 000 ms cumulative cap)
    - _Requirements: 4.1, 4.4, 4.5_
  - [ ]* 8.2 Property test: per-request timeout aborts when latency exceeds budget
    - **Property 10: Per-request timeout aborts when latency exceeds budget**
    - **Validates: Requirements 4.4**
  - [x] 8.3 Implement `GeminiAdapter` (header-based auth, header `x-goog-api-key`)
    - Create `src/brain/providers/gemini.ts` with `streamGenerate`, `complete`, `countTokens`
    - Pass key in `x-goog-api-key` header; never in URL
    - Use the SSE parser from task 2.4 for streaming
    - _Requirements: 4.2, 4.6, 4.8_
  - [x] 8.4 Implement `OpenAIAdapter` (header `Authorization: Bearer`)
    - Create `src/brain/providers/openai.ts` covering chat completions and o-series
    - _Requirements: 4.2, 4.6_
  - [x] 8.5 Implement `AnthropicAdapter` (header `x-api-key`)
    - Create `src/brain/providers/anthropic.ts` covering Claude Messages API streaming
    - _Requirements: 4.2, 4.6_
  - [x] 8.6 Implement `OllamaCompatibleAdapter` for local OpenAI-compatible runtimes
    - Create `src/brain/providers/ollama.ts` (LM Studio / Ollama)
    - _Requirements: 4.2, 4.6_
  - [x] 8.7 Implement `SimulationAdapter` and ensure `isSimulated` propagates
    - Create `src/brain/providers/simulation.ts`; every response sets `isSimulated: true`
    - _Requirements: 4.2, 4.9_
  - [ ]* 8.8 Property test: API keys never appear in provider URLs
    - **Property 11: API keys never appear in URLs**
    - **Validates: Requirements 4.6**
  - [x] 8.9 Implement `AI_Provider_Router` with priority-ordered failover and abort honouring
    - Create `src/brain/providerRouter.ts` with `registerAdapter`, `setPriority`, `selectModel`, `stream`, `complete`
    - Failover on transport-error / 5xx / timeout; honour `AbortSignal.aborted` within 200 ms
    - Refuse cloud providers when CryptoVault is locked
    - _Requirements: 4.3, 4.7, 15.2_
  - [ ]* 8.10 Property test: failover preserves priority order and terminates
    - **Property 9: Provider failover preserves priority order and terminates**
    - **Validates: Requirements 4.3**
  - [ ]* 8.11 Property test: vault-locked router refuses cloud providers
    - **Property 43: Vault-locked router refuses cloud providers**
    - **Validates: Requirements 15.2**
  - [x] 8.12 Replace `src/brain/aiProvider.ts` with thin shim that delegates to the new router
    - Keep the old export surface temporarily so other modules compile
    - _Requirements: 4.1, 4.2_

- [x] 9. Implement Response_Cache v2
  - [x] 9.1 Implement cosine-similarity cache with LRU and IndexedDB persistence
    - Create `src/brain/responseCache.ts` exporting `ResponseCache` class
    - Use `Vector_Index.generateEmbedding` for cache keys; cosine match against stored entries
    - LRU bound (default 256); persist to `STORE_RESPONSE_CACHE`; Settings toggle to clear and disable
    - Refuse to store when `isSimulated`, empty trimmed text, or non-2xx status
    - Annotate served responses with `fromCache: true` and emit `cache.hit` telemetry
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 4.9_
  - [ ]* 9.2 Property test: cache refuses to store invalid responses
    - **Property 13: Response_Cache refuses to store invalid responses**
    - **Validates: Requirements 4.9, 7.4**
  - [ ]* 9.3 Property test: LRU bound preserves capacity invariant
    - **Property 20: Response_Cache LRU bound**
    - **Validates: Requirements 7.2**

- [x] 10. Implement Context_Builder
  - [x] 10.1 Implement tokenizer-aware Context_Builder with priority-drop trimming
    - Create `src/brain/contextBuilder.ts` exporting `build({ mode, transcript, screenText, knowledgeChunks, memoryChunks, userQuery, settings })`
    - Count tokens via `adapter.countTokens`; bound by `context.budgetTokens` (default 8 000)
    - Drop order: `screen → older-transcript → lower-similarity-knowledge → older-knowledge`; preserve section headers verbatim
    - Cap at 30 final transcript lines and 5 knowledge chunks (configurable)
    - Annotate sections with `[AUDIO] / [SCREEN] / [KNOWLEDGE] / [MEMORY]` and citation ids `[K1] / [M1]`
    - Apply `Redaction_Engine.apply` before cloud egress
    - Emit `PromptAssemblyTrace` for telemetry
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6, 15.3, 23.1, 23.2, 23.4, 24.1_
  - [x] 10.2 Implement implicit retrieval-query fallback and language directive
    - When `userQuery` is empty, retrieval query = most-recent question-shaped utterance, else last 200 chars
    - Append `Respond in <BCP-47>.` directive matching the user's recognition language
    - _Requirements: 5.4, 17.4_
  - [ ]* 10.3 Property test: builder respects budget, caps, citations, and drop-order prefix
    - **Property 15: Context_Builder produces an output that respects the budget and drop order**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.5, 5.6, 23.1, 24.1**
  - [ ]* 10.4 Property test: implicit retrieval query falls back deterministically
    - **Property 16: Implicit retrieval query falls back deterministically**
    - **Validates: Requirements 5.4**
  - [ ]* 10.5 Property test: redaction is applied to all cloud-bound payloads
    - **Property 44 (re-asserted at the prompt-assembly layer)**
    - **Validates: Requirements 15.3**
  - [ ]* 10.6 Property test: language directive is appended to system prompts
    - **Property 50: Language directive is appended to system prompts**
    - **Validates: Requirements 17.4**
  - [x] 10.7 Replace `src/brain/contextManager.ts` with a thin shim delegating to Context_Builder
    - _Requirements: 5.1, 5.2_

- [x] 11. Implement Question_Detector refactor
  - [x] 11.1 Implement locale-aware detector with debounce, throttle, and role gating
    - Refactor `src/brain/questionDetector.ts` into a `QuestionDetectorStream` class
    - Final-debounce default 1 500 ms; interim-throttle default 4 000 ms; independent suppression state
    - Locale packs for `en/es/fr/de/ja/zh` with trailing-`?` floor for unsupported locales
    - Gate on `speakerRole === 'other'`; emit `{ question, type, confidence, urgencyScore, source }`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 3.3, 17.3_
  - [ ]* 11.2 Property test: never fires on user-attributed lines
    - **Property 6: Question_Detector never fires on user-attributed lines**
    - **Validates: Requirements 3.3**
  - [ ]* 11.3 Property test: debounce and throttle invariants
    - **Property 21: Question_Detector debounce and throttle invariants**
    - **Validates: Requirements 8.1, 8.2**
  - [ ]* 11.4 Property test: final triggers are independent of interim suppression
    - **Property 22: Final triggers are independent of interim suppression**
    - **Validates: Requirements 8.3**
  - [ ]* 11.5 Property test: trailing-`?` floor for non-self speakers
    - **Property 23: Trailing-`?` floor**
    - **Validates: Requirements 8.6**

- [x] 12. Implement Coaching_Module
  - [x] 12.1 Implement pure `getFullAnalysis(text, totalWordCount, durationSeconds)`
    - Refactor `src/brain/sentimentAnalyzer.ts` into `src/brain/coaching.ts`
    - Whole-word filler matching (`\b<filler>\b`); user-only WPM; bounded confidence
    - Pure: identical inputs yield identical outputs (no module-level mutable state)
    - _Requirements: 9.2, 9.3, 9.5, 9.6_
  - [x] 12.2 Implement pace-nudge state machine
    - Sustained sub-90 or super-180 WPM for ≥ 15 s of user speech transitions to `nudge`
    - _Requirements: 9.4_
  - [ ]* 12.3 Property test: coaching is a pure function
    - **Property 24: Coaching is a pure function**
    - **Validates: Requirements 9.5, 9.2**
  - [ ]* 12.4 Property test: confidence score is bounded
    - **Property 25: Confidence score is bounded**
    - **Validates: Requirements 9.6**
  - [ ]* 12.5 Property test: WPM aggregates only user-attributed words
    - **Property 26: User-only WPM aggregation**
    - **Validates: Requirements 9.3**
  - [ ]* 12.6 Property test: pace nudge state machine
    - **Property 27: Pace nudge state machine**
    - **Validates: Requirements 9.4**

- [x] 13. Implement SpeakerManager (per-session)
  - [x] 13.1 Convert `src/brain/speakerManager.ts` from module singleton to per-session class
    - Constructor accepts initial profiles; no module-level state
    - Strict separation between `speakerId` and `speakerRole: 'user' | 'other'`
    - `classifyByGap(now)` and `classifyByVoiceprint(audio)` with confidence ≥ 0.55 fallback
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6, 3.7_
  - [ ]* 13.2 Property test: every transcript line satisfies the schema invariant
    - **Property 5: Every transcript line satisfies the schema invariant**
    - **Validates: Requirements 2.4, 3.2, 3.7**
  - [ ]* 13.3 Property test: active speaker assignment respects toggle history
    - **Property 7: Active speaker assignment respects toggle history**
    - **Validates: Requirements 3.4**
  - [ ]* 13.4 Property test: voiceprint diarization falls back below 0.55 confidence
    - **Property 8: Voiceprint diarization falls back below 0.55 confidence**
    - **Validates: Requirements 3.5**

- [x] 14. Implement Transcription_Engine (`useTranscription`) with Web Speech and Whisper providers
  - [x] 14.1 Implement Web Speech provider with backoff, confidence filter, and permission watcher
    - Create `src/hooks/useTranscription.ts` and `src/brain/transcription/webSpeech.ts`
    - Use `restartSupervisor` from task 2.1; flush interim on stop; drop low-confidence finals
    - Watch microphone permission via `navigator.permissions.query({name:'microphone'})`
    - Apply BCP-47 language at start; surface `unsupported` when neither recognizer exists
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10_
  - [x] 14.2 Implement local Whisper provider via `Whisper_Runtime`
    - Create `src/brain/transcription/whisper.ts` using a WebGPU/WASM Whisper-class model
    - Surface download progress through the shared `ModelLoader` queue (task 23.4)
    - Stamp every line with `provider` and `language`
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - [x] 14.3 Replace `src/hooks/useSpeechRecognition.ts` consumers with `useTranscription`
    - Update `FloatingCopilot`, `CopilotContext`, `DetachedCopilot` to consume the new hook
    - _Requirements: 1.1, 2.4_
  - [ ]* 14.4 Property test: stop flushes interim text exactly once and only when non-empty
    - **Property 3: Stop flushes interim text exactly once and only when non-empty**
    - **Validates: Requirements 1.6**
  - [ ]* 14.5 Property test: confidence filter is a strict pass-through
    - **Property 4: Confidence filter is a strict pass-through**
    - **Validates: Requirements 1.7**

- [x] 15. Implement Screen_Capture_Module and OCR_Worker refactor
  - [x] 15.1 Refactor `useScreenCapture` to downscale and skip via perceptual hash
    - Downscale every frame to ≤ 1280 px longest edge before passing to OCR
    - Skip OCR when `hammingDistance < threshold` (default 5 bits)
    - Retain a 5-entry recent-OCR ring buffer with timestamps
    - Handle `videoElement.play()` rejection as `screen.autoplay-blocked`
    - _Requirements: 13.1, 13.2, 13.5, 13.6_
  - [x] 15.2 Add OCR worker watchdog and lazy language-pack loading
    - Refactor `src/workers/ocrWorker.ts` to expose `terminate()`
    - Watchdog terminates and recreates worker after 3 errors / 30 s; disables OCR on subsequent error
    - Lazy-load Tesseract language packs on demand
    - Terminate worker when capture stops; recreate lazily on next start
    - _Requirements: 13.3, 13.4, 20.3_
  - [ ]* 15.3 Property test: recent-OCR ring buffer is bounded
    - **Property 39: Recent-OCR ring buffer is bounded**
    - **Validates: Requirements 13.6**

- [x] 16. Implement Memory_Store
  - [x] 16.1 Implement `MemoryStore` with cosine dedup and redacted-on-write
    - Create `src/brain/memoryStore.ts` exporting `add`, `search`, `forget`, `applyRedactionAndSave`
    - Dedup on cosine similarity > 0.92; retain longer text and merge `meetingIds`
    - All persisted text is redacted; `source.meetingIds` always includes the originating meeting
    - _Requirements: 10.5, 10.6, 24.3_
  - [ ]* 16.2 Property test: memory dedup invariant
    - **Property 30: Memory_Store dedup invariant**
    - **Validates: Requirements 10.6**
  - [ ]* 16.3 Property test: facts are saved redacted with source tag
    - **Property 31: Memory facts are saved redacted with source tag**
    - **Validates: Requirements 10.5**
  - [x] 16.4 Wire Memory_Store into Context_Builder retrieval
    - Search Memory_Store alongside Knowledge_Base; label memory chunks `[MEMORY: meeting:{id}, {date}]`
    - _Requirements: 24.1_

- [x] 17. Implement Style_Profile (uplift)
  - [x] 17.1 Implement `StyleProfileStore` with observe/edit/import/export
    - Create `src/brain/styleProfile.ts` with `observeUserUtterance`, `observeEdit`, `toDirective`, `export`, `import`, `clear`
    - Updates only from user-attributed lines
    - `toDirective()` produces a ≤ 80-token compact prompt fragment
    - Persist to `STORE_STYLE_PROFILE`
    - _Requirements: 22.1, 22.2, 22.3, 22.4_
  - [ ]* 17.2 Property test: style profile updates only from user-attributed lines
    - **Property 54: Style profile updates only from user-attributed lines**
    - **Validates: Requirements 22.1**
  - [ ]* 17.3 Property test: style profile import-export round trip
    - **Property 53: Style profile import-export round trip**
    - **Validates: Requirements 22.4**
  - [ ]* 17.4 Property test: style directive token bound
    - **Property 55: Style directive token bound**
    - **Validates: Requirements 22.2**
  - [x] 17.5 Inject style directive into Context_Builder when personalization is enabled
    - _Requirements: 22.2_

- [x] 18. Implement Telemetry_Module and Latency_Budget
  - [x] 18.1 Implement local-first `TelemetryModule` with `MetricEvent` discriminated union
    - Create `src/brain/telemetry.ts` writing to `STORE_TELEMETRY`
    - Discriminated union has no free-form payload field; structurally prevents content leakage
    - `enqueueExternal` sends only metrics over HTTPS when opt-in
    - _Requirements: 19.1, 19.2, 19.4, 19.5_
  - [ ]* 18.2 Property test: telemetry events never leak content
    - **Property 51: Telemetry events never leak content**
    - **Validates: Requirements 19.4, 19.5, 26.3**
  - [x] 18.3 Implement `LatencyBudget` recorder and degraded-state detector
    - Create `src/brain/latencyBudget.ts` recording `t_detected`, `t_request_sent`, `t_first_token`, `t_complete`
    - Cache hits flow into a separate `cache.hit` stream
    - Two consecutive over-budget TTFTs emit `latency.degraded`
    - _Requirements: 14.1, 14.2, 14.3, 14.4_
  - [ ]* 18.4 Property test: cache hits and TTFT samples are routed to separate streams
    - **Property 40: Latency budget routes cache hits to a separate stream**
    - **Validates: Requirements 14.4**
  - [ ]* 18.5 Property test: latency-degraded indicator after two consecutive over-budget requests
    - **Property 41: Latency-degraded indicator after two consecutive over-budget requests**
    - **Validates: Requirements 14.3**
  - [x] 18.6 Wire ErrorBoundary and `unhandledrejection` listener into Telemetry
    - `ErrorBoundary` records content-free errors with stack and breadcrumb
    - Top-level `unhandledrejection` listener installed in `main.tsx` routes through `useZuleError`
    - _Requirements: 19.3, 20.5_
  - [ ]* 18.7 Property test: ErrorBoundary records content-free errors
    - **Property 52: ErrorBoundary records content-free errors**
    - **Validates: Requirements 19.3**

- [x] 19. Implement Summary_Engine v2 and stop-session reorder
  - [x] 19.1 Refactor `src/brain/summaryEngine.ts` to use `extractJsonObject` and `PendingTaskTracker`
    - Use the balanced-brace JSON extractor from task 2.6
    - Single retry with stricter "respond ONLY with JSON" instruction on extraction failure
    - Use `PendingTaskTracker.add(promise)` for fact saves; remove `setTimeout(..., 0)` orphan tasks
    - Action items get stable id, completion state, source quote, source line id, timestamp
    - _Requirements: 10.2, 10.3, 10.4, 10.7_
  - [ ]* 19.2 Property test: action items satisfy the schema
    - **Property 29: Action items satisfy the schema**
    - **Validates: Requirements 10.4**
  - [x] 19.3 Reorder stop-session flow to persist meeting before summary generation
    - In `FloatingCopilot` (or its orchestrator), persist the placeholder Meeting first (`aiSummaryStatus: 'pending'`)
    - Generate summary with 60 000 ms timeout; on success update record (`aiSummaryStatus: 'ok'`); on failure mark `'failed'`
    - Disable double-click Stop while in flight; allow cancel
    - Add a "Retry summary" affordance on the meeting detail page
    - Save extracted `keyFacts` via `MemoryStore.applyRedactionAndSave`
    - _Requirements: 10.1, 10.5, 27.1, 27.2, 27.3, 27.4_
  - [ ]* 19.4 Property test: stop-session retry preserves persisted meeting
    - **Property 62: Stop-session retry preserves persisted meeting**
    - **Validates: Requirements 27.3**

- [x] 20. Implement Cross_Window_Sync v2
  - [x] 20.1 Implement versioned, heartbeated sync with `localStorage` fallback
    - Replace `src/hooks/useCrossWindowSync.ts` with a `Cross_Window_Sync v2` implementation
    - Discriminated `SyncMessage` union, monotonic `version`, snapshot on open, 5 000 ms heartbeats
    - Detached window shows `host disconnected` after 15 000 ms of silence; reconnect affordance
    - Fall back to `localStorage`-event channel when `BroadcastChannel` is undefined
    - Surface `cross-window.popup-blocked` when `window.open` returns null
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_
  - [ ]* 20.2 Property test: receivers reject regressing versions
    - **Property 32: Cross-window receivers reject regressing versions**
    - **Validates: Requirements 11.1**
  - [ ]* 20.3 Property test: heartbeat-based host-loss detection
    - **Property 33: Heartbeat-based host-loss detection**
    - **Validates: Requirements 11.3, 11.6**

- [x] 21. Refactor FloatingCopilot lifecycle
  - [x] 21.1 Add unmount abort, manual-override abort, and discard-late-tokens
    - Hold an `AbortControllerRef`; abort on unmount and on manual submit
    - Discard `onToken` callbacks delivered after `signal.aborted`
    - Stop elapsed-time interval and tear down event listeners on unmount
    - _Requirements: 12.1, 12.2_
  - [ ]* 21.2 Property test: manual submit aborts in-flight stream and discards late tokens
    - **Property 36: Manual submit aborts in-flight stream and discards late tokens**
    - **Validates: Requirements 12.2**
  - [x] 21.3 Add resize re-clamp and symmetric show/hide shortcut
    - `resize` listener re-clamps `(x, y)` using `clampPosition` from task 2.8
    - Same shortcut (`Ctrl+Shift+H`) toggles hide; Escape hides only
    - 8-direction reposition shortcuts (`Ctrl+Alt+Arrow`) and `Ctrl+Alt+0` recenter
    - _Requirements: 12.3, 12.4, 18.4_
  - [ ]* 21.4 Property test: hide-toggle is symmetric
    - **Property 35: Hide-toggle is symmetric**
    - **Validates: Requirements 12.4**
  - [x] 21.5 Memoise `triggerAI` over stable deps and stop firing from per-render-recreated callbacks
    - Memoise `triggerAI` with `useCallback` over stable references
    - Read latest callback from a ref inside the transcript-keyed `useEffect`
    - _Requirements: 12.5_

- [x] 22. Implement stealth, panic shortcut, and CSP
  - [x] 22.1 Add `data-zule-stealth="true"` to overlay and CSP meta tag
    - Set the attribute on the floating overlay container
    - Add `<meta http-equiv="Content-Security-Policy">` to `index.html` with `script-src 'self'` plus configured provider origins
    - _Requirements: 15.5, 15.7_
  - [x] 22.2 Implement crop-to-content-area mode where supported
    - Use `Element.requestFullscreen` + `BrowserCaptureMediaStreamTrack.cropTo` when available
    - Document the tab-capture-only limitation in Settings UI
    - _Requirements: 15.6_
  - [x] 22.3 Implement panic-hide shortcut (default `Ctrl+Shift+\`)
    - Hide overlay, mute microphone, stop screen capture, pause autonomous AI calls within 200 ms
    - Wire through `useKeyboardShortcuts`
    - _Requirements: 15.8_

- [x] 23. Implement Toast, ErrorBoundary, ModelLoader queue, and i18n
  - [x] 23.1 Replace remaining `alert()` and `console.error` with toast / error hook
    - Audit `src/components/Settings.tsx` and other call sites
    - Use `react-hot-toast` with `role="status"` (non-blocking) and `role="alert"` (blocking)
    - _Requirements: 18.7, 25.3_
  - [x] 23.2 Apply accessible names, aria-live, focus order, and reduced-motion support
    - Add `aria-label` to every icon-only button in control capsule, suggestion card, quick actions
    - Wrap streaming AI text in an `aria-live="polite"` region
    - Verify keyboard focus traversal through capsule, transcript, suggestion card, follow-up chips, mode selector, input bar
    - Disable framer-motion entrance/exit/loop/parallax under `prefers-reduced-motion: reduce`
    - _Requirements: 18.1, 18.2, 18.3, 18.5_
  - [x] 23.3 Verify WCAG 2.1 AA contrast in light and dark themes
    - Adjust theme tokens until automated axe-core checks pass
    - _Requirements: 18.6_
  - [x] 23.4 Implement single ModelLoader queue UI
    - Refactor `src/components/common/ModelLoader.tsx` into a queued list with cancel affordances
    - Used by embedding model, Whisper model, and Tesseract language pack downloads
    - _Requirements: 20.4, 21.4_
  - [x] 23.5 Add i18n module and dictionaries (en/es/fr/de/ja/zh-Hans)
    - Create `src/i18n/` with bundled JSON dictionaries for each locale
    - Add `t(key, params?)` helper and `useTranslation` hook
    - Migrate user-visible strings from `LandingPage`, `Dashboard`, `Settings`, `FloatingCopilot`, `MeetingDetail`
    - _Requirements: 17.1, 17.2_
  - [ ]* 23.6 Property test: i18n catalog completeness across all locales
    - **Property 49: i18n catalog completeness**
    - **Validates: Requirements 17.2**

- [x] 24. Settings UI: providers, profile, redaction, retention, evaluation, spend, diagnostics
  - [x] 24.1 Add provider configuration UI with priority and encrypted keys
    - Settings tab to add/edit providers; passphrase prompt drives `CryptoVault`
    - Show priority order; toggle enable/disable
    - _Requirements: 4.2, 15.1, 15.2_
  - [x] 24.2 Add profile selector (`speed | balanced | cost | privacy`) and ephemeral-mode toggle
    - Profile selector wired to model selector and Question_Detector confidence threshold
    - Ephemeral mode prevents `Meeting_Store` and `Memory_Store` writes
    - _Requirements: 15.4, 29.1, 29.2, 29.3, 29.4_
  - [ ]* 24.3 Property test: ephemeral mode does not persist
    - **Property 45: Ephemeral mode does not persist**
    - **Validates: Requirements 15.4**
  - [x] 24.4 Add redaction-rule editor (regex + entity classes)
    - User-defined rules persisted in `Settings.redaction.rules`
    - Live preview of redaction on a sample transcript line
    - _Requirements: 15.3_
  - [x] 24.5 Add retention settings (meeting age, transcript max lines)
    - Wire to `applyRetention` background sweep
    - _Requirements: 16.5_
  - [x] 24.6 Add language pickers (UI locale, recognition language, OCR language)
    - _Requirements: 17.1_
  - [x] 24.7 Add Evaluation tab with thumbs-up / thumbs-down ratings
    - Persist `Rating` records with `promptHash`, `modelId`, `latencyMs`, `modalitiesUsed`
    - Aggregate per provider, per mode, per modality combination
    - _Requirements: 26.1, 26.2_
  - [ ]* 24.8 Property test: rating aggregation conserves count
    - **Property 61: Rating aggregation conserves count**
    - **Validates: Requirements 26.2**
  - [x] 24.9 Add Spend tab with daily/weekly/monthly per-provider cost
    - Use the cost calculator from task 2.17 over telemetry token events
    - _Requirements: 28.3_
  - [x] 24.10 Add Diagnostics page rendering most-recent 24 h of telemetry
    - Read `STORE_TELEMETRY`; render TTFT, latency, retries, cache hits, transcript drops, OCR skips
    - _Requirements: 19.2_

- [ ] 25. Implement multi-modal fusion and citation chips (uplift)
  - [x] 25.1 Surface fusion hints when entities overlap between screen and transcript
    - Detect overlapping entities in `Context_Builder` and append a single fusion-hint line
    - _Requirements: 23.2_
  - [x] 25.2 Send downscaled keyframe alongside OCR text when adapter supports image input
    - Provider capabilities flag drives inclusion; respect user opt-in
    - _Requirements: 23.3_
  - [x] 25.3 Render modality badges and citation chips on suggestion card
    - Badges show which of `audio | screen | knowledge | memory` were used
    - Memory citation chips link to the meeting detail page
    - _Requirements: 23.4, 24.1, 24.2_

- [x] 26. Offline graceful degradation and bundle splitting
  - [x] 26.1 Add offline banner and provider switch on `navigator.onLine === false`
    - Switch the router to local-runtime or simulation per user configuration
    - Knowledge_Base continues to serve retrievals; local Whisper continues if configured
    - _Requirements: 20.1, 20.2_
  - [x] 26.2 Code-split Vector_Index, OCR_Worker, document parsers, and provider adapters
    - Configure dynamic imports in Vite so the LandingPage main chunk is ≤ 300 KB gzip
    - Defer Vector_Index initialisation until session start or KB section open
    - Add a CI check that fails the build if main chunk exceeds 300 KB gzip
    - _Requirements: 21.1, 21.2, 21.3_
  - [x] 26.3 Add lint and CI guards
    - Lint forbids `?key=` substring in `src/brain/providers/*.ts`
    - Lint forbids `alert(` in `src/components/`
    - Lint requires `aria-label` on icon-only buttons in `src/components/copilot/*`
    - Smoke test asserts PDF.js / Tesseract / Transformers.js URLs start with `/`
    - _Requirements: 4.6, 18.1, 18.7, 15.7, 21.5_

- [x] 27. Checkpoint - Domain modules and orchestration
  - Ensure all tests pass, ask the user if questions arise.

- [x] 28. End-to-end and accessibility integration tests
  - [x] 28.1 Active_Session lifecycle Playwright spec
    - Stub `getUserMedia`, `getDisplayMedia`, and provider HTTP layer
    - Drive transcript via injected `SpeechRecognitionEvent`s
    - Verify question detection, streaming render, and persisted meeting on stop
    - Re-open the meeting from dashboard and verify state
    - _Requirements: 30.3_
  - [x] 28.2 Stealth Playwright spec
    - Screen-share into the browser tab; verify overlay does not appear when detached window is in use
    - Verify `data-zule-stealth` attribute is present
    - _Requirements: 15.5_
  - [x] 28.3 Accessibility Playwright spec via axe-core
    - Run `axe.run()` on dashboard, settings, and active session
    - Assert zero violations at WCAG 2.1 AA
    - _Requirements: 18.6_
  - [x] 28.4 Confirm coverage gate on `src/brain/` ≥ 80% statements
    - Wire `vitest run --coverage` into CI; fail when below threshold
    - _Requirements: 30.4_

- [x] 29. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional property/unit tests and can be skipped for faster MVP. The dependency graph still includes them so the parallel scheduler reserves capacity.
- Each task references granular sub-requirement clauses for traceability.
- Property test sub-tasks reference the property number from `design.md §Correctness Properties` and the requirements clauses each property validates.
- Checkpoints (tasks 7, 27, 29) ensure incremental validation between major waves.
- The implementation language is TypeScript throughout. Test infrastructure is Vitest + fast-check + Playwright + axe-core.
- The `Whisper_Runtime`, `Tesseract` workers, `PDF.js` worker, and `Transformers.js` runtime are self-hosted from the application origin.
- The `aiProvider.ts` and `contextManager.ts` modules remain as thin shims during migration so dependent components keep compiling; they are deleted once consumers migrate.

## Task Dependency Graph

The graph spreads tasks that modify the same file across separate waves. The most-touched file is `FloatingCopilot.tsx` (waves 7 → 14: tasks 14.3, 19.3, 21.1, 21.3, 21.5, 22.1, 22.3, 23.1 each in their own wave). `contextBuilder.ts` is touched across waves 5 → 9 (10.1, 10.2, 16.4, 17.5, 25.1). `vectorStore.ts` across waves 2 → 4 (5.1, 5.2, 5.3). `database.ts` across waves 2 → 3 (4.3, 4.5). `ErrorBoundary.tsx` across waves 6 → 14 (18.6, 23.1). Settings tabs (24.1, 24.2, 24.4–24.10) are assumed to be separate tab component files registered through a tab registry, so they can run in parallel.

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "2.4", "2.6", "2.8", "2.11", "2.13", "2.15", "2.17", "3.1", "4.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.5", "2.7", "2.9", "2.10", "2.12", "2.14", "2.16", "2.18", "3.2", "4.2", "4.3", "4.7", "5.1", "6.1", "8.1", "12.1", "13.1", "17.1"] },
    { "id": 3, "tasks": ["4.4", "4.5", "4.6", "4.8", "5.2", "6.2", "8.3", "8.4", "8.5", "8.6", "8.7", "12.2", "13.2", "13.3", "13.4", "17.2", "17.3", "17.4"] },
    { "id": 4, "tasks": ["5.3", "5.4", "5.5", "6.3", "6.4", "6.5", "6.6", "8.2", "8.8", "8.9", "12.3", "12.4", "12.5", "12.6", "16.1"] },
    { "id": 5, "tasks": ["8.10", "8.11", "9.1", "10.1", "11.1", "14.1", "14.2", "15.1", "15.2", "16.2", "16.3", "18.1", "18.3", "23.4", "23.5"] },
    { "id": 6, "tasks": ["8.12", "9.2", "9.3", "10.2", "10.7", "11.2", "11.3", "11.4", "11.5", "14.4", "14.5", "15.3", "18.2", "18.4", "18.5", "18.6", "19.1", "20.1", "20.2", "20.3", "23.6"] },
    { "id": 7, "tasks": ["10.3", "10.4", "10.5", "10.6", "14.3", "16.4", "18.7", "19.2", "26.1", "26.2"] },
    { "id": 8, "tasks": ["17.5", "19.3", "23.2", "24.1", "24.5", "24.7"] },
    { "id": 9, "tasks": ["19.4", "21.1", "24.2", "24.4", "24.6", "24.9", "24.10", "25.1"] },
    { "id": 10, "tasks": ["21.3", "21.2", "22.2", "25.2", "25.3"] },
    { "id": 11, "tasks": ["21.5", "21.4"] },
    { "id": 12, "tasks": ["22.1"] },
    { "id": 13, "tasks": ["22.3"] },
    { "id": 14, "tasks": ["23.1"] },
    { "id": 15, "tasks": ["23.3", "24.3", "24.8", "26.3"] },
    { "id": 16, "tasks": ["28.1", "28.2", "28.3", "28.4"] }
  ]
}
```
