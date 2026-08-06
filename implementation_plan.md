# Phase 2: Audio Pipeline Overhaul — AudioWorklet Migration + VAD-Driven Flushing

Migrate the audio capture pipeline from the deprecated `ScriptProcessorNode` (runs on the main thread, blocks rendering, limited to power-of-2 buffer sizes) to an `AudioWorkletProcessor` (runs on a dedicated real-time audio thread, zero main-thread jank). Additionally, replace the fixed-interval `setInterval` flushing with VAD-driven flushing so chunks are sent to Whisper the instant speech ends, cutting perceived latency from ~1.2s to ~200–400ms for short utterances.

## User Review Required

> [!IMPORTANT]
> **Breaking change to `electron/main.ts` import strategy**: In Phase 1, we modified `main.ts` to use `import * as electronRaw from 'electron'` with a runtime fallback to `createRequire`. This is stable and tested (855/855 pass). The Phase 2 changes do NOT touch this file.

> [!IMPORTANT]
> **AudioWorklet requires a separate `.js` file** loaded via `audioContext.audioWorklet.addModule(url)`. Vite handles this natively for files ending in `?url` or placed in `public/`. We'll use the `public/` approach for maximum compatibility with the Electron renderer.

## Proposed Changes

### Audio Capture Worklet (NEW)

#### [NEW] [pcm-capture-processor.js](file:///c:/project/zule/public/pcm-capture-processor.js)

A standalone AudioWorkletProcessor that runs on the audio rendering thread. Responsibilities:
- Accumulates incoming 128-sample frames into a ring buffer
- Runs an ultra-lightweight energy check per frame (RMS > silence floor)
- When speech ends (trailing silence > `HANGOVER_MS`) OR the buffer exceeds `MAX_BUFFER_MS`, posts a `{ type: 'chunk', pcm: Float32Array }` message to the main thread
- Posts `{ type: 'vad', isSpeech: boolean, energy: number }` on every transition so the UI can show a "speaking" indicator
- Accepts `{ type: 'flush' }` messages from the main thread (for teardown)
- Accepts `{ type: 'config', speechFloor, hangoverMs, maxBufferMs }` for live reconfiguration

Key constants (tuned for 16 kHz mono):
- `HANGOVER_MS = 300` — trailing silence before flushing (catches natural pauses without splitting mid-word)
- `MAX_BUFFER_MS = 3000` — hard cap prevents unbounded accumulation during sustained speech
- `MIN_CHUNK_MS = 200` — don't flush chunks shorter than this (Whisper produces garbage on <200ms)
- `SILENCE_FLOOR = 0.008` — per-frame RMS below this is silence (lower than VAD's `SPEECH_FLOOR` of 0.02 because this is per-frame, not median-of-frames)

---

### WhisperProvider Refactor

#### [MODIFY] [whisper.ts](file:///c:/project/zule/src/brain/transcription/whisper.ts)

The core migration. Changes:

1. **Replace `ScriptProcessorNode` with `AudioWorkletNode`**:
   - `private processorNode: ScriptProcessorNode | null` → `private workletNode: AudioWorkletNode | null`
   - `private audioBuffer: Float32Array[]` → removed (the worklet manages its own ring buffer)
   - `private processTimer` → removed (no more `setInterval`)
   - New: `private workletReady: boolean` flag

2. **`start()` method rewrite**:
   ```typescript
   // Before:
   this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
   this.processorNode.onaudioprocess = (event) => { ... };
   this.sourceNode.connect(this.processorNode);
   this.processorNode.connect(this.audioContext.destination);
   this.processTimer = setInterval(() => { ... }, this.processIntervalMs);
   
   // After:
   await this.audioContext.audioWorklet.addModule('/pcm-capture-processor.js');
   this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-capture-processor');
   this.workletNode.port.onmessage = (e) => this.handleWorkletMessage(e);
   this.sourceNode.connect(this.workletNode);
   // No destination connection needed — worklet outputs silence
   ```

3. **New `handleWorkletMessage(e: MessageEvent)` method**:
   - On `{ type: 'chunk', pcm }`: run VAD gate → if speech, call `processAudioSegment(pcm)` → emit `line`
   - On `{ type: 'vad', isSpeech, energy }`: emit a new `'vad-state'` event so the UI can show a speaking indicator
   - On `{ type: 'flush-done' }`: resolve teardown promise

4. **`stop()` method update**:
   - Post `{ type: 'flush' }` to the worklet to get any trailing audio
   - Wait for `flush-done` with a 500ms timeout
   - Then teardown audio nodes

5. **`pause()`/`resume()` methods**:
   - Post `{ type: 'pause' }` / `{ type: 'resume' }` to the worklet instead of clearing/restarting timers

6. **`teardownAudio()` update**:
   - Disconnect and nullify `workletNode` instead of `processorNode`

7. **Backwards compatibility**: The `processIntervalMs` option is kept but reinterpreted as `MAX_BUFFER_MS` for the worklet's hard cap. The `processAccumulatedAudio()` and `collectAudioBuffer()` methods are removed.

8. **Graceful fallback**: If `audioContext.audioWorklet` is undefined (older Electron?), fall back to the ScriptProcessorNode path with a console warning. This is defensive — Electron 42+ supports AudioWorklet.

---

### Live VAD Sensitivity Reconfiguration

#### [MODIFY] [whisper.ts](file:///c:/project/zule/src/brain/transcription/whisper.ts) (same file, additional change)

The `vadSensitivityBus` subscriber in `start()` now also posts a `{ type: 'config', speechFloor }` message to the worklet so the in-worklet energy gate tracks Settings changes in real time.

---

### Test Updates

#### [MODIFY] [vad.test.ts](file:///c:/project/zule/src/brain/transcription/vad.test.ts)

No changes needed — the VAD module is pure and its tests are independent of the capture mechanism.

#### [MODIFY] [dualModeOverlay.preservation.test.ts](file:///c:/project/zule/src/overlay/dualModeOverlay.preservation.test.ts)

No IPC channels are added or removed, so no changes needed.

---

### 3. Backend (Vercel Serverless Functions)

Since Firebase Functions require a paid Blaze plan (credit card), we will pivot to using **Vercel Serverless Functions**. Vercel provides a generous free tier with zero credit card required.

#### [NEW] `api/createRazorpaySubscription.ts`
- A Vercel serverless endpoint (`POST`).
- Verifies the Firebase Auth ID Token sent from the frontend using `firebase-admin`.
- Calls Razorpay API to generate the subscription.
- Returns the `short_url` to the client.

#### [NEW] `api/razorpayWebhook.ts`
- A Vercel serverless endpoint (`POST`).
- Verifies the Razorpay cryptographic signature.
- Updates the user's `subscription/current` document in Firestore using `firebase-admin`.

#### [MODIFY] `src/context/SubscriptionContext.tsx`
- Replace Firebase `httpsCallable` with a standard `fetch` call to the Vercel API.
- Attach the user's Firebase Auth ID token (`await user.getIdToken()`) in the `Authorization` header.

#### [DELETE] `functions/`, `firebase.json`, `.firebaserc`
- Remove the old Firebase Functions code to keep the repo clean.

## Verification Plan
1. Ensure the Vercel CLI (`npx vercel`) successfully deploys the `api/` folder.
2. Ensure `fetch` correctly calls the deployed Vercel endpoints and opens the Razorpay checkout.

### Manual Verification
1. Start a meeting with system audio enabled → verify the remote party's speech is transcribed
2. Verify latency improvement: short utterances ("What's the status?") should produce transcript within ~500ms of speech ending, vs. ~1.5s before
3. Verify the "speaking" indicator tracks voice activity in real time
4. Toggle VAD sensitivity in Settings mid-session → verify the next chunk uses the new threshold
5. Verify no main-thread jank during transcription (Chrome DevTools Performance tab should show no long tasks from audio processing)
