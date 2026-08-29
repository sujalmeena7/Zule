// ============================================================================
// Zule AI — PCM Capture AudioWorkletProcessor
// ============================================================================
//
// Runs on the dedicated audio rendering thread. Captures 16 kHz mono PCM from
// an AudioWorkletNode, performs lightweight energy-based voice activity
// detection per 128-sample frame, and posts speech chunks to the main thread:
//
//   1. Speech ends (trailing silence exceeds hangoverFrames), OR
//   2. The buffer exceeds maxBufferSamples (hard cap for sustained speech),
//      retaining an overlap tail to prevent cutting words mid-syllable, OR
//   3. Partial interim frames (when partialsEnabled is true and speech >= 700ms).
//
// Discards silent frames without allocating or posting empty buffers.
// Maintains a 300 ms pre-roll circular buffer to prevent clipping the first word.
// ============================================================================

const RENDER_QUANTUM = 128;
const SAMPLE_RATE = 16000;
const MS_PER_FRAME = (RENDER_QUANTUM / SAMPLE_RATE) * 1000; // 8 ms

let silenceFloor = 0.008;
let hangoverFrames = Math.ceil(300 / MS_PER_FRAME); // 38 frames ≈ 304 ms
let maxBufferSamples = Math.ceil(2000 / MS_PER_FRAME) * RENDER_QUANTUM; // 2000 ms = 32000 samples
const MIN_CHUNK_SAMPLES = Math.ceil(120 / MS_PER_FRAME) * RENDER_QUANTUM; // 15 frames = 1920 samples (~120 ms)

// Pre-roll: ~300 ms circular buffer
const PRE_ROLL_SAMPLES = Math.ceil(300 / MS_PER_FRAME) * RENDER_QUANTUM; // ~4864 samples
const preRollBuffer = new Float32Array(PRE_ROLL_SAMPLES);
let preRollWritePos = 0;
let preRollCount = 0;

// Overlap tail on hard-cap drain only: ~250 ms
const OVERLAP_TAIL_SAMPLES = Math.ceil(250 / MS_PER_FRAME) * RENDER_QUANTUM; // ~4000 samples

// Partials config & state
let partialsEnabled = false;
let partialIntervalMs = 600;
let minPartialMs = 700;
let framesSinceLastPartial = 0;
let partialSeq = 0;

let ringBuffer = new Float32Array(80000);
let writePos = 0;
let silenceCount = 0;
let wasSpeech = false;
let bufferHasSpeech = false;
let paused = false;
let flushRequested = false;

function frameRms(samples, offset, length) {
  let sumSq = 0;
  const end = offset + length;
  for (let i = offset; i < end; i++) {
    const s = samples[i];
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / length);
}

function drainBuffer() {
  if (writePos === 0) return null;
  const chunk = ringBuffer.slice(0, writePos);
  writePos = 0;
  bufferHasSpeech = false;
  silenceCount = 0;
  preRollCount = 0;
  preRollWritePos = 0;
  framesSinceLastPartial = 0;
  return chunk;
}

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (e) => this._handleMessage(e.data);
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'config':
        if (typeof msg.silenceFloor === 'number' && msg.silenceFloor > 0) {
          silenceFloor = msg.silenceFloor;
        }
        if (typeof msg.hangoverMs === 'number' && msg.hangoverMs > 0) {
          hangoverFrames = Math.ceil(msg.hangoverMs / MS_PER_FRAME);
        }
        if (typeof msg.maxBufferMs === 'number' && msg.maxBufferMs > 0) {
          maxBufferSamples = Math.ceil(msg.maxBufferMs / MS_PER_FRAME) * RENDER_QUANTUM;
          const needed = maxBufferSamples + RENDER_QUANTUM * 50;
          if (ringBuffer.length < needed) {
            const newBuf = new Float32Array(needed);
            newBuf.set(ringBuffer.subarray(0, writePos));
            ringBuffer = newBuf;
          }
        }
        if (typeof msg.partialsEnabled === 'boolean') {
          partialsEnabled = msg.partialsEnabled;
        }
        if (typeof msg.partialIntervalMs === 'number' && msg.partialIntervalMs > 0) {
          partialIntervalMs = msg.partialIntervalMs;
        }
        if (typeof msg.minPartialMs === 'number' && msg.minPartialMs > 0) {
          minPartialMs = msg.minPartialMs;
        }
        break;
      case 'flush':
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

  process(inputs) {
    if (flushRequested) {
      flushRequested = false;
      if (bufferHasSpeech && writePos >= MIN_CHUNK_SAMPLES) {
        const chunk = drainBuffer();
        if (chunk) {
          this.port.postMessage({ type: 'chunk', pcm: chunk }, [chunk.buffer]);
        }
      } else {
        drainBuffer();
      }
      this.port.postMessage({ type: 'flush-done' });
      return true;
    }

    if (paused) return true;
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;

    const samples = input[0];
    const energy = frameRms(samples, 0, samples.length);
    const isSpeech = energy > silenceFloor;

    if (isSpeech !== wasSpeech) {
      this.port.postMessage({ type: 'vad', isSpeech: isSpeech, energy: energy });
      wasSpeech = isSpeech;
    }

    // ── Pre-roll / Speech onset ──
    if (!bufferHasSpeech) {
      if (isSpeech) {
        bufferHasSpeech = true;
        silenceCount = 0;
        framesSinceLastPartial = 0;

        // Copy circular pre-roll buffer to head of ring buffer
        if (preRollCount > 0) {
          const startIdx = (preRollWritePos - preRollCount + PRE_ROLL_SAMPLES) % PRE_ROLL_SAMPLES;
          if (startIdx + preRollCount <= PRE_ROLL_SAMPLES) {
            ringBuffer.set(preRollBuffer.subarray(startIdx, startIdx + preRollCount), 0);
          } else {
            const firstPart = PRE_ROLL_SAMPLES - startIdx;
            ringBuffer.set(preRollBuffer.subarray(startIdx, PRE_ROLL_SAMPLES), 0);
            ringBuffer.set(preRollBuffer.subarray(0, preRollCount - firstPart), firstPart);
          }
          writePos = preRollCount;
        } else {
          writePos = 0;
        }
        preRollCount = 0;
        preRollWritePos = 0;
      } else {
        // Accumulate silence in circular pre-roll buffer without posting anything
        for (let i = 0; i < samples.length; i++) {
          preRollBuffer[preRollWritePos] = samples[i];
          preRollWritePos = (preRollWritePos + 1) % PRE_ROLL_SAMPLES;
        }
        preRollCount = Math.min(preRollCount + samples.length, PRE_ROLL_SAMPLES);
        return true;
      }
    }

    // ── Accumulate speech audio ──
    if (writePos + samples.length > ringBuffer.length) {
      const newBuf = new Float32Array(ringBuffer.length * 2);
      newBuf.set(ringBuffer.subarray(0, writePos));
      ringBuffer = newBuf;
    }
    ringBuffer.set(samples, writePos);
    writePos += samples.length;

    if (isSpeech) {
      silenceCount = 0;
    } else {
      silenceCount++;
    }

    framesSinceLastPartial++;

    // ── Partials (without draining buffer) ──
    const minPartialSamples = Math.ceil(minPartialMs / MS_PER_FRAME) * RENDER_QUANTUM;
    if (
      partialsEnabled &&
      bufferHasSpeech &&
      writePos >= minPartialSamples &&
      (framesSinceLastPartial * MS_PER_FRAME) >= partialIntervalMs
    ) {
      framesSinceLastPartial = 0;
      const partialPcm = ringBuffer.slice(0, writePos);
      this.port.postMessage({ type: 'partial', pcm: partialPcm, seq: ++partialSeq });
    }

    // ── Flush decisions ──
    let flushReason = null; // 'hangover' | 'cap' | null
    if (bufferHasSpeech && silenceCount >= hangoverFrames) {
      flushReason = 'hangover';
    } else if (writePos >= maxBufferSamples) {
      flushReason = 'cap';
    }

    if (flushReason !== null) {
      if (bufferHasSpeech && writePos >= MIN_CHUNK_SAMPLES) {
        const chunk = ringBuffer.slice(0, writePos);

        if (flushReason === 'cap') {
          // Hard-cap flush: preserve overlap tail to prevent cutting words mid-syllable
          const tailLen = Math.min(writePos, OVERLAP_TAIL_SAMPLES);
          const tail = ringBuffer.slice(writePos - tailLen, writePos);
          ringBuffer.set(tail, 0);
          writePos = tailLen;
          bufferHasSpeech = true;
          silenceCount = 0;
          framesSinceLastPartial = 0;
        } else {
          // Utterance genuinely ended: clean reset
          writePos = 0;
          bufferHasSpeech = false;
          silenceCount = 0;
          preRollCount = 0;
          preRollWritePos = 0;
          framesSinceLastPartial = 0;
        }

        this.port.postMessage({ type: 'chunk', pcm: chunk }, [chunk.buffer]);
      } else {
        // Discard sub-minimum or silent chunks silently
        writePos = 0;
        bufferHasSpeech = false;
        silenceCount = 0;
        preRollCount = 0;
        preRollWritePos = 0;
        framesSinceLastPartial = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
