// ============================================================================
// Zule AI — PCM Capture AudioWorkletProcessor
// ============================================================================
//
// Runs on the dedicated audio rendering thread. Captures 16 kHz mono PCM from
// an AudioWorkletNode, performs lightweight energy-based voice activity
// detection per 128-sample frame, and posts complete speech chunks to the main
// thread via MessagePort when:
//
//   1. Speech ends (trailing silence exceeds HANGOVER_FRAMES), OR
//   2. The buffer exceeds MAX_BUFFER_SAMPLES (hard cap for sustained speech).
//
// Chunks shorter than MIN_CHUNK_SAMPLES are discarded (Whisper hallucinates on
// sub-200ms audio).
//
// This replaces the deprecated ScriptProcessorNode which ran on the main
// thread and blocked rendering.
//
// ── Constraints ──────────────────────────────────────────────────────────────
// AudioWorkletProcessor.process() runs in a real-time audio context with no
// access to setTimeout, Date.now(), fetch, or any async API. All timing is
// derived from frame counts (128 samples = 8 ms at 16 kHz).
// ============================================================================

// ── Constants (16 kHz mono, 128-sample frames = 8 ms per process() call) ────

/** Samples per process() invocation (Web Audio spec). */
const RENDER_QUANTUM = 128;

/** Sample rate — must match the AudioContext that loads this processor. */
const SAMPLE_RATE = 16000;

/** Milliseconds per render quantum at 16 kHz. */
const MS_PER_FRAME = (RENDER_QUANTUM / SAMPLE_RATE) * 1000; // 8 ms

/**
 * Per-frame RMS below this is silence. Lower than vad.ts's SPEECH_FLOOR
 * (0.02) because this is a per-frame check, not median-of-frames.
 */
let silenceFloor = 0.008;

/**
 * Trailing silence frames before flushing. 300 ms ÷ 8 ms = 37.5 → 38 frames.
 * Short enough to feel responsive, long enough that natural mid-sentence
 * pauses (commas, thinking) don't cause premature flushes.
 */
let hangoverFrames = Math.ceil(300 / MS_PER_FRAME); // 38

/**
 * Hard cap on buffer duration. 3000 ms ÷ 8 ms = 375 frames × 128 = 48000
 * samples. Prevents unbounded accumulation during sustained speech.
 */
let maxBufferSamples = Math.ceil(3000 / MS_PER_FRAME) * RENDER_QUANTUM; // 48000

/**
 * Minimum chunk size worth sending. 200 ms ÷ 8 ms = 25 frames × 128 = 3200
 * samples. Whisper hallucinates on sub-200 ms audio.
 */
const MIN_CHUNK_SAMPLES = Math.ceil(200 / MS_PER_FRAME) * RENDER_QUANTUM; // 3200

// ── Ring buffer ─────────────────────────────────────────────────────────────

/**
 * Pre-allocated ring buffer. 5 seconds at 16 kHz = 80000 samples — enough
 * headroom above maxBufferSamples (48000) to avoid reallocation.
 */
let ringBuffer = new Float32Array(80000);
/** Write cursor into ringBuffer. */
let writePos = 0;

// ── VAD state ───────────────────────────────────────────────────────────────

/** Consecutive silence frames since last speech frame. */
let silenceCount = 0;
/** Whether the previous frame was classified as speech. */
let wasSpeech = false;
/** Whether we've seen at least one speech frame in the current buffer. */
let bufferHasSpeech = false;
/** Whether capture is paused (main thread can toggle). */
let paused = false;
/** Whether a flush was requested (teardown path). */
let flushRequested = false;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * RMS energy of a 128-sample frame. Inlined for real-time performance — no
 * function call overhead in the hot path.
 */
function frameRms(samples, offset, length) {
  let sumSq = 0;
  const end = offset + length;
  for (let i = offset; i < end; i++) {
    const s = samples[i];
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / length);
}

/**
 * Extract the buffered PCM as a new Float32Array and reset the write cursor.
 * Returns null if the buffer is empty.
 */
function drainBuffer() {
  if (writePos === 0) return null;
  // Slice out the written region — this allocates a new buffer.
  const chunk = ringBuffer.slice(0, writePos);
  writePos = 0;
  bufferHasSpeech = false;
  silenceCount = 0;
  return chunk;
}

// ── Processor ───────────────────────────────────────────────────────────────

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (e) => this._handleMessage(e.data);
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'config':
        // Live reconfiguration from the main thread (e.g. Settings change).
        if (typeof msg.silenceFloor === 'number' && msg.silenceFloor > 0) {
          silenceFloor = msg.silenceFloor;
        }
        if (typeof msg.hangoverMs === 'number' && msg.hangoverMs > 0) {
          hangoverFrames = Math.ceil(msg.hangoverMs / MS_PER_FRAME);
        }
        if (typeof msg.maxBufferMs === 'number' && msg.maxBufferMs > 0) {
          maxBufferSamples = Math.ceil(msg.maxBufferMs / MS_PER_FRAME) * RENDER_QUANTUM;
          // Resize ring buffer if needed.
          const needed = maxBufferSamples + RENDER_QUANTUM * 50; // headroom
          if (ringBuffer.length < needed) {
            const newBuf = new Float32Array(needed);
            newBuf.set(ringBuffer.subarray(0, writePos));
            ringBuffer = newBuf;
          }
        }
        break;

      case 'flush':
        // Teardown: drain whatever is in the buffer and signal completion.
        flushRequested = true;
        break;

      case 'pause':
        paused = true;
        break;

      case 'resume':
        paused = false;
        break;
    }
  }

  /**
   * Called by the audio rendering thread for every 128-sample quantum.
   * Returns `true` to keep the processor alive.
   */
  process(inputs) {
    // Handle flush request (teardown path).
    if (flushRequested) {
      flushRequested = false;
      const chunk = drainBuffer();
      if (chunk && chunk.length >= MIN_CHUNK_SAMPLES) {
        // Transfer ownership — zero-copy move to main thread.
        this.port.postMessage({ type: 'chunk', pcm: chunk }, [chunk.buffer]);
      }
      this.port.postMessage({ type: 'flush-done' });
      return true;
    }

    if (paused) return true;

    // Guard: no input connected or empty channel.
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;

    const samples = input[0]; // mono channel, 128 samples

    // ── Per-frame energy check ────────────────────────────────────────────
    const energy = frameRms(samples, 0, samples.length);
    const isSpeech = energy > silenceFloor;

    // Emit VAD state transitions so the UI can show a speaking indicator.
    if (isSpeech !== wasSpeech) {
      // Small message — no Transferable needed.
      this.port.postMessage({ type: 'vad', isSpeech: isSpeech, energy: energy });
      wasSpeech = isSpeech;
    }

    // ── Accumulate into ring buffer ───────────────────────────────────────
    // Ensure capacity (defensive — ring buffer is pre-allocated with headroom).
    if (writePos + samples.length > ringBuffer.length) {
      const newBuf = new Float32Array(ringBuffer.length * 2);
      newBuf.set(ringBuffer.subarray(0, writePos));
      ringBuffer = newBuf;
    }
    ringBuffer.set(samples, writePos);
    writePos += samples.length;

    if (isSpeech) {
      bufferHasSpeech = true;
      silenceCount = 0;
    } else {
      silenceCount++;
    }

    // ── Flush decisions ───────────────────────────────────────────────────

    let shouldFlush = false;

    // 1. Speech ended: trailing silence exceeded hangover threshold AND
    //    the buffer contains at least one speech frame.
    if (bufferHasSpeech && silenceCount >= hangoverFrames) {
      shouldFlush = true;
    }

    // 2. Hard cap: buffer is too large (sustained speech without pause).
    if (writePos >= maxBufferSamples) {
      shouldFlush = true;
    }

    if (shouldFlush && writePos >= MIN_CHUNK_SAMPLES) {
      const chunk = drainBuffer();
      if (chunk) {
        // Transfer ownership — zero-copy move to main thread.
        this.port.postMessage({ type: 'chunk', pcm: chunk }, [chunk.buffer]);
      }
    } else if (shouldFlush) {
      // Buffer too short to be useful — discard silently.
      writePos = 0;
      bufferHasSpeech = false;
      silenceCount = 0;
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
