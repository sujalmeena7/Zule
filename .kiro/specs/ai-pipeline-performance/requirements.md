# Requirements Document

## Introduction

This feature delivers three bundled performance improvements to Zule's local
AI pipeline, all of which preserve the offline-first architecture (no new
cloud dependencies) and the existing main-process inference model
(`@huggingface/transformers` + `onnxruntime-node`):

1. **Batched embedding generation during document upload.** The current
   `Settings` upload path issues one `embed:generate` IPC round trip per
   chunk (≈100 round trips for a typical PDF). A new batched IPC contract
   collapses an N-chunk upload to a single request, materially reducing
   end-to-end upload latency.

2. **Approximate-nearest-neighbor (ANN) Vector_Index for Knowledge_Base
   search.** Today the renderer performs a linear cosine-similarity scan
   over every stored chunk in `kbSearch.ts`. Above ~5 000 chunks the P95
   query latency degrades visibly. An ANN index built and queried in the
   main process keeps semantic search snappy as the Knowledge_Base grows,
   while remaining compatible with the existing int8 quantization policy
   above `QUANTIZATION_THRESHOLD`.

3. **Voice-Activity-Detection (VAD)–gated Whisper transcription.** The
   loopback (system-audio) pipeline currently ships every 2-second PCM
   chunk to `whisper:transcribe`, including chunks that contain only
   silence. A lightweight VAD gate skips silent chunks before the IPC,
   reducing idle inference load. The same gate is applied to the
   Whisper-based microphone dictation path.

These three improvements are scoped together because they share testing
infrastructure (property-based tests with fast-check), the IPC bridge in
`electron/preload.ts`, and the constraint that the existing
`vectorStore.ts` and `kbSearch.ts` test suites must continue to pass.

## Glossary

- **Document_Upload_Path**: The Settings flow in `src/components/Settings.tsx`
  that ingests a document, splits it into chunks, computes an embedding per
  chunk, and persists the result to the Knowledge_Base via
  `knowledgeBase.addDocument`.
- **Embedding_Service**: The main-process embedding inference module
  (`electron/embeddingService.ts`) that runs MiniLM via
  `onnxruntime-node` and is reached from the renderer through the
  `embed:*` IPC channels.
- **IPC_Bridge**: The contextBridge surface defined in
  `electron/preload.ts` and exposed to the renderer as
  `window.electronAPI`.
- **Knowledge_Base**: The persistent collection of user-uploaded
  documents and their chunked, embedded representations in the
  `documents` IndexedDB store.
- **KB_Search_Service**: The component responsible for returning the
  top-`k` Knowledge_Base chunks most similar to a query embedding.
- **Vector_Index**: An approximate-nearest-neighbor index over chunk
  embeddings that supports `addItem`, `removeItem`, `query(vector, k)`,
  and persistence to disk.
- **Loopback_Audio_Pipeline**: The system-audio capture path driven by
  `useSystemAudioTranscription.ts`, which produces 16 kHz mono Float32
  PCM chunks and forwards them to `whisper:transcribe`.
- **Microphone_Audio_Pipeline**: The microphone capture path used by
  `WhisperProvider` for dictation in the InputBar.
- **VAD**: Voice Activity Detector — a function that returns, for an
  input PCM frame, a probability or boolean indicating whether the frame
  contains human speech.
- **Settings_Module**: The Settings page in `src/components/Settings.tsx`
  and the persisted `settings` IndexedDB store backing it.
- **Quantization_Threshold**: The `QUANTIZATION_THRESHOLD` constant
  (default 1 000) in `vectorStore.ts` above which chunk vectors are
  persisted as int8-quantized rather than Float32.

## Requirements

### Requirement 1: Batched Embedding Generation IPC Contract

**User Story:** As a Zule user, I want to upload a document to my Knowledge
Base quickly, so that adding meeting notes or reference material does not
interrupt my workflow.

#### Acceptance Criteria

1. WHEN the renderer invokes the batched embedding bridge with an array of
   `N` non-empty texts, THE Embedding_Service SHALL return an array of
   exactly `N` mean-pooled, L2-normalized embedding vectors in input
   order.
2. WHEN the renderer invokes the batched embedding bridge with an empty
   array, THE Embedding_Service SHALL return an empty array without
   loading or invoking the model.
3. IF any text in the input array is empty or whitespace-only, THEN THE
   Embedding_Service SHALL return a zero-length vector at the
   corresponding index and SHALL continue processing the remaining
   inputs.
4. THE Embedding_Service SHALL produce, for any single text `t`, a
   batched-call vector that is element-wise equal to the
   single-call vector returned by the existing `embed:generate` channel
   for the same `t` and the same model id.
5. WHEN uploading a document of `N` chunks where `N >= 10`, THE
   Document_Upload_Path SHALL issue at most `ceil(N / batch_size)`
   embedding IPC calls, where `batch_size` is at least 32.
6. WHEN uploading a document of 100 chunks, THE Document_Upload_Path
   SHALL complete embedding generation in at most 40 percent of the
   wall-clock time taken by the per-chunk IPC baseline measured on the
   same machine and model id.
7. IF the batched embedding call fails for the whole batch, THEN THE
   Document_Upload_Path SHALL fall back to the per-chunk
   `embed:generate` path and SHALL still persist the document with the
   embeddings that succeed.

### Requirement 2: Approximate-Nearest-Neighbor Vector_Index

**User Story:** As a Zule user with a large Knowledge Base, I want
semantic search to stay fast as I add more documents, so that the
copilot keeps surfacing relevant context in real time.

#### Acceptance Criteria

1. WHEN the renderer calls the Vector_Index search bridge with a query
   vector of dimension `D` and a positive integer `k`, THE Vector_Index
   SHALL return at most `k` results, each containing a chunk identifier
   and a cosine-similarity score in the closed interval `[-1, 1]`.
2. THE Vector_Index SHALL return results in non-increasing order of
   cosine-similarity score.
3. WHEN the Knowledge_Base contains 50 000 chunks, THE Vector_Index
   SHALL return a top-`k=10` result set within 50 milliseconds at the
   95th percentile, measured on the project's reference development
   machine.
4. THE Vector_Index SHALL achieve at least 0.95 recall at `k=10`
   relative to the exact cosine-similarity top-`k=10` over a fixed
   benchmark Knowledge_Base of at least 5 000 chunks.
5. WHEN a chunk is added to the Knowledge_Base, THE Vector_Index SHALL
   include that chunk in the result set of any subsequent search whose
   query satisfies the chunk's similarity threshold.
6. WHEN a chunk is removed from the Knowledge_Base, THE Vector_Index
   SHALL exclude that chunk from the result set of any subsequent
   search.
7. IF the Vector_Index search bridge is invoked with `k <= 0` or with a
   query vector whose dimension does not match the index dimension,
   THEN THE Vector_Index SHALL return an empty result set and SHALL log
   a typed error for diagnostics.

### Requirement 3: Vector_Index Cold-Start and Persistence

**User Story:** As a Zule user, I want the app to start quickly even
when my Knowledge Base is large, so that I can begin a meeting without
waiting for indexing.

#### Acceptance Criteria

1. WHEN the application starts and a previously-persisted Vector_Index
   snapshot exists on disk, THE Vector_Index SHALL load the snapshot
   and SHALL be ready to serve queries within 2 seconds for a
   Knowledge_Base of up to 50 000 chunks.
2. WHEN the application starts and no persisted snapshot exists, THE
   Vector_Index SHALL rebuild itself from the chunks stored in
   IndexedDB and SHALL be ready to serve queries before the
   Knowledge_Base UI surfaces a "ready" state.
3. WHEN a chunk is added to or removed from the Knowledge_Base, THE
   Vector_Index SHALL persist the updated index to disk before the
   application is closed gracefully.
4. IF loading a persisted snapshot fails for any reason, THEN THE
   Vector_Index SHALL discard the snapshot and SHALL fall back to
   rebuilding from IndexedDB.

### Requirement 4: Vector_Index Compatibility with Quantized Storage

**User Story:** As a Zule developer, I want the new Vector_Index to
coexist with the existing storage-quantization policy, so that adding
ANN search does not break the int8 compression for large Knowledge
Bases.

#### Acceptance Criteria

1. WHEN the Vector_Index is built or updated from a chunk persisted in
   the int8-quantized form, THE Vector_Index SHALL dequantize the chunk
   to Float32 before insertion.
2. THE Vector_Index SHALL produce results whose ranking is consistent
   with the legacy linear cosine-similarity scan in `kbSearch.ts` for
   any Knowledge_Base in which all chunks are stored above the
   Quantization_Threshold.
3. THE existing `vectorStore.ts` and `kbSearch.ts` test suites SHALL
   continue to pass without modification of their assertions when the
   Vector_Index is enabled.
4. WHERE the Knowledge_Base is below the Quantization_Threshold, THE
   Vector_Index SHALL operate on the raw Float32 chunk vectors directly
   without invoking the dequantizer.

### Requirement 5: Voice-Activity-Gated Loopback Transcription

**User Story:** As a Zule user listening to a meeting, I want the
transcription pipeline to skip silent audio, so that my CPU and battery
are not consumed transcribing silence.

#### Acceptance Criteria

1. WHILE the Loopback_Audio_Pipeline is capturing audio, THE
   Loopback_Audio_Pipeline SHALL apply the VAD to each captured PCM
   chunk before issuing a transcription request.
2. IF the VAD reports that a chunk's speech probability is strictly
   below the configured speech threshold, THEN THE
   Loopback_Audio_Pipeline SHALL skip the `whisper:transcribe` IPC
   call for that chunk.
3. WHEN the VAD reports that a chunk's speech probability is greater
   than or equal to the configured speech threshold, THE
   Loopback_Audio_Pipeline SHALL forward the chunk to
   `whisper:transcribe` unchanged.
4. WHEN a 60-second loopback recording contains at least 50 percent
   silence by sample count, THE Loopback_Audio_Pipeline SHALL reduce
   the count of `whisper:transcribe` IPC calls by at least 40 percent
   relative to the un-gated baseline measured over the same recording.
5. IF the VAD itself throws or returns an invalid score for a chunk,
   THEN THE Loopback_Audio_Pipeline SHALL forward the chunk to
   `whisper:transcribe` and SHALL log a typed VAD error.
6. WHEN a chunk is skipped by the VAD gate, THE
   Loopback_Audio_Pipeline SHALL NOT emit a transcription line, an
   interim placeholder, or a non-speech token derived from that chunk.

### Requirement 6: Voice-Activity-Gated Microphone Dictation

**User Story:** As a Zule user dictating into the input bar, I want
silent gaps in my speech to be ignored by the local Whisper engine, so
that pauses do not produce hallucinated text.

#### Acceptance Criteria

1. WHERE the Microphone_Audio_Pipeline is configured to use the local
   Whisper provider for dictation, THE Microphone_Audio_Pipeline SHALL
   apply the VAD to each captured PCM chunk before issuing a
   transcription request.
2. IF a chunk's VAD score is strictly below the configured speech
   threshold, THEN THE Microphone_Audio_Pipeline SHALL skip the
   `whisper:transcribe` IPC call for that chunk and SHALL NOT emit a
   transcription line for that chunk.
3. WHILE no speech has been detected in the most recent 2 consecutive
   chunks, THE Microphone_Audio_Pipeline SHALL preserve the existing
   dictation session state without tearing down the capture stream.

### Requirement 7: VAD Sensitivity Configuration

**User Story:** As a Zule user, I want to adjust how aggressively the
transcription pipeline filters out silence, so that I can balance
responsiveness against background-noise tolerance for my environment.

#### Acceptance Criteria

1. THE Settings_Module SHALL expose a VAD sensitivity control with at
   least three discrete levels: `low`, `medium`, and `high`.
2. WHEN the user selects a sensitivity level, THE Settings_Module
   SHALL persist the choice to the `settings` IndexedDB store under a
   stable key.
3. WHEN the application starts, THE Loopback_Audio_Pipeline and the
   Microphone_Audio_Pipeline SHALL read the persisted sensitivity
   level and SHALL configure the VAD's speech threshold accordingly.
4. WHEN the user changes the sensitivity level during an active
   session, THE Loopback_Audio_Pipeline and the
   Microphone_Audio_Pipeline SHALL apply the new threshold to all
   subsequently captured chunks without restarting the capture stream.
5. IF the Loopback_Audio_Pipeline or the Microphone_Audio_Pipeline is
   in a failed runtime state, THEN THE Settings_Module SHALL disable
   the VAD sensitivity control and SHALL display the failure reason
   alongside the disabled control.
6. THE `medium` sensitivity level SHALL match the project's documented
   default speech threshold so that existing users see consistent
   behavior on first upgrade.

### Requirement 8: Offline Operation Preserved

**User Story:** As a Zule user running fully offline, I want the new
performance features to work without any network access, so that my
local-first setup keeps functioning.

#### Acceptance Criteria

1. THE batched Embedding_Service, the Vector_Index, and the VAD SHALL
   operate without issuing any outbound network request.
2. WHERE the application is configured to use the Ollama local LLM
   provider, THE feature SHALL NOT introduce any new dependency that
   requires a cloud service or external API key.
3. THE feature SHALL NOT require model files beyond those already
   vendored under `dist/vendor/models` or downloadable through the
   existing Hugging Face local-model path.

### Requirement 9: No Regressions in Existing Tests

**User Story:** As a Zule developer, I want the existing test suite to
keep passing after this feature lands, so that I can be confident the
performance work has not broken correctness.

#### Acceptance Criteria

1. THE existing `src/brain/vectorStore.test.ts` and
   `src/brain/vectorMath.test.ts` test suites SHALL pass without
   modification of their assertions.
2. THE existing `src/data/kbSearch.test.ts` test suite SHALL pass
   without modification of its assertions.
3. THE existing `src/hooks/useSystemAudioTranscription` integration
   tests SHALL pass without modification of their assertions, with the
   VAD gate disabled or set to a permissive threshold under test.

### Requirement 10: Telemetry for the New Pipeline Stages

**User Story:** As a Zule developer, I want to observe the impact of
batching, ANN search, and VAD gating in production, so that I can
measure the speedup and detect regressions.

#### Acceptance Criteria

1. WHEN a batched embedding call completes, THE Embedding_Service
   SHALL emit a telemetry event recording the batch size and the
   wall-clock duration.
2. WHEN a Vector_Index query completes, THE Vector_Index SHALL emit a
   telemetry event recording `k`, the result count, and the wall-clock
   duration.
3. WHEN the VAD gate skips a chunk, THE corresponding audio pipeline
   SHALL increment a `vad.skipped` counter exposed through the
   existing telemetry surface.
4. THE telemetry events SHALL NOT contain raw chunk text, raw audio
   samples, or any user-identifying content.
5. WHERE telemetry includes text-derived fields for debugging, THE
   telemetry payload SHALL only contain processed or sanitized forms
   of the text — for example a redacted preview, a hashed identifier,
   or aggregate statistics — and SHALL apply the project's existing
   redaction rules before emission.
