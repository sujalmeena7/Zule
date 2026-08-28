// ============================================================================
// Zule AI — Inlined PCM Capture Worklet Code
// ============================================================================
// Inlined so AudioWorklet can load synchronously via Blob URL in both dev and
// production packaged Electron (file:// scheme) without CORS or fetch errors.

export const PCM_CAPTURE_WORKLET_CODE = `
const RENDER_QUANTUM = 128;
const SAMPLE_RATE = 16000;
const MS_PER_FRAME = (RENDER_QUANTUM / SAMPLE_RATE) * 1000;

let silenceFloor = 0.008;
let hangoverFrames = Math.ceil(300 / MS_PER_FRAME);
let maxBufferSamples = Math.ceil(3000 / MS_PER_FRAME) * RENDER_QUANTUM;
const MIN_CHUNK_SAMPLES = Math.ceil(200 / MS_PER_FRAME) * RENDER_QUANTUM;

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
      const chunk = drainBuffer();
      if (chunk && chunk.length >= MIN_CHUNK_SAMPLES) {
        this.port.postMessage({ type: 'chunk', pcm: chunk }, [chunk.buffer]);
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

    let shouldFlush = false;
    if (bufferHasSpeech && silenceCount >= hangoverFrames) {
      shouldFlush = true;
    }
    if (writePos >= maxBufferSamples) {
      shouldFlush = true;
    }

    if (shouldFlush && writePos >= MIN_CHUNK_SAMPLES) {
      const chunk = drainBuffer();
      if (chunk) {
        this.port.postMessage({ type: 'chunk', pcm: chunk }, [chunk.buffer]);
      }
    } else if (shouldFlush) {
      writePos = 0;
      bufferHasSpeech = false;
      silenceCount = 0;
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
`;

export function createWorkletBlobUrl(): string {
  const blob = new Blob([PCM_CAPTURE_WORKLET_CODE], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}
