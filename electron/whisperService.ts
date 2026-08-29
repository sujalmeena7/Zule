// ============================================================================
// Zule AI — Main-Process Whisper Service (onnxruntime-node)
// ============================================================================
//
// Runs local Whisper speech-to-text in the ELECTRON MAIN PROCESS using
// `@huggingface/transformers`'s `node` build, backed by native `onnxruntime-node`.
//
// Realtime dual-session architecture:
//   - Xenova/whisper-base.en (q8, ~77 MB) for finals with Priority Queue (loopback > mic).
//   - Xenova/whisper-tiny.en (q8, ~41 MB) for low-latency interim partials.
//   - Stale partial superseding: drops pending older partials when a newer one arrives.
//   - Ref-counted release: only destroys sessions when all pipelines are released.
//   - Thread tuning: session_options clamp intraOpNumThreads to [2, 4] to prevent
//     Electron main thread starvation.
//   - Returns { text, queueMs, inferMs } for latency measurement and telemetry.
// ============================================================================

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { app } = require('electron') as typeof import('electron');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WhisperPipeline = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text?: string }>;

export const BASE_MODEL_ID = 'Xenova/whisper-base.en';
export const TINY_MODEL_ID = 'Xenova/whisper-tiny.en';

export interface TranscribeResult {
  text: string;
  queueMs: number;
  inferMs: number;
}

export interface TranscribeOptions {
  language?: string;
  modelId?: string;
  kind?: 'final' | 'partial';
  seq?: number;
  pipeline?: 'loopback' | 'microphone';
}

interface AsrSession {
  modelId: string;
  transcriber: WhisperPipeline | null;
  loadPromise: Promise<WhisperPipeline> | null;
  chain: Promise<unknown>;
}

interface BaseQueueItem {
  id: number;
  pipeline: 'loopback' | 'microphone';
  pcm: Float32Array;
  opts: TranscribeOptions;
  enqueuedAt: number;
  resolve: (res: TranscribeResult) => void;
  reject: (err: unknown) => void;
}

interface TinyQueueItem {
  id: number;
  pipeline: 'loopback' | 'microphone';
  seq: number;
  pcm: Float32Array;
  opts: TranscribeOptions;
  enqueuedAt: number;
  resolve: (res: TranscribeResult) => void;
  reject: (err: unknown) => void;
}

// ── State ───────────────────────────────────────────────────────────────────

let baseSession: AsrSession | null = null;
let tinySession: AsrSession | null = null;
const customSessions = new Map<string, AsrSession>();

const activePipelines = new Set<string>();

const basePendingQueue: BaseQueueItem[] = [];
let isBaseProcessing = false;

const tinyPendingQueue: TinyQueueItem[] = [];
let isTinyProcessing = false;

const latestEnqueuedPartialSeq = new Map<string, number>();
const latestProcessedPartialSeq = new Map<string, number>();

let nextJobId = 1;

/**
 * Absolute path to vendored models directory.
 */
function resolveModelsDir(): string {
  const packaged = app?.isPackaged ?? true;
  let base = packaged
    ? path.join(__dirname, '..', 'dist', 'vendor', 'models')
    : path.join(__dirname, '..', 'public', 'vendor', 'models');

  if (packaged && base.includes('app.asar') && !base.includes('app.asar.unpacked')) {
    const unpacked = base.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(unpacked)) {
      base = unpacked;
    }
  }

  return base + path.sep;
}

/**
 * Thread options to prevent oversubscribing the CPU.
 */
function getSessionOptions() {
  const cores = os.cpus()?.length || 4;
  const intraOp = Math.max(2, Math.min(4, Math.floor(cores / 2)));
  return {
    intraOpNumThreads: intraOp,
    interOpNumThreads: 1,
  };
}

function getOrCreateSession(modelId: string): AsrSession {
  if (modelId === BASE_MODEL_ID) {
    if (!baseSession) {
      baseSession = {
        modelId: BASE_MODEL_ID,
        transcriber: null,
        loadPromise: null,
        chain: Promise.resolve(),
      };
    }
    return baseSession;
  }
  if (modelId === TINY_MODEL_ID) {
    if (!tinySession) {
      tinySession = {
        modelId: TINY_MODEL_ID,
        transcriber: null,
        loadPromise: null,
        chain: Promise.resolve(),
      };
    }
    return tinySession;
  }

  let session = customSessions.get(modelId);
  if (!session) {
    session = {
      modelId,
      transcriber: null,
      loadPromise: null,
      chain: Promise.resolve(),
    };
    customSessions.set(modelId, session);
  }
  return session;
}

async function ensurePipeline(session: AsrSession): Promise<WhisperPipeline> {
  if (session.transcriber) return session.transcriber;
  if (session.loadPromise) return session.loadPromise;

  session.loadPromise = (async () => {
    const t0 = Date.now();
    const { pipeline, env } = (await import('@huggingface/transformers')) as unknown as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pipeline: (task: string, model: string, opts?: any) => Promise<any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env: any;
    };

    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = resolveModelsDir();

    console.info(`[whisperService] loading ${session.modelId} from ${env.localModelPath}`);
    const asr = (await pipeline('automatic-speech-recognition', session.modelId, {
      dtype: 'q8',
      session_options: getSessionOptions(),
    })) as unknown as WhisperPipeline;
    console.info(`[whisperService] ${session.modelId} ready in ${Date.now() - t0}ms`);

    session.transcriber = asr;
    return asr;
  })();

  try {
    return await session.loadPromise;
  } catch (err) {
    session.loadPromise = null;
    throw err;
  }
}

// ── Queue Processing: Finals (Priority Queue: loopback > mic) ───────────────

async function processNextBaseItem(): Promise<void> {
  if (basePendingQueue.length === 0) {
    isBaseProcessing = false;
    return;
  }

  isBaseProcessing = true;

  // Priority ordering: loopback (index of first loopback item) > mic (earliest)
  let bestIndex = 0;
  let highestPriority = basePendingQueue[0].pipeline === 'loopback' ? 2 : 1;

  for (let i = 1; i < basePendingQueue.length; i++) {
    const item = basePendingQueue[i];
    const priority = item.pipeline === 'loopback' ? 2 : 1;
    if (priority > highestPriority) {
      highestPriority = priority;
      bestIndex = i;
    }
  }

  const [item] = basePendingQueue.splice(bestIndex, 1);
  const session = getOrCreateSession(item.opts.modelId ?? BASE_MODEL_ID);

  try {
    const startedAt = Date.now();
    const queueMs = startedAt - item.enqueuedAt;

    const asr = await ensurePipeline(session);
    const result = await asr(item.pcm);
    const inferMs = Date.now() - startedAt;
    const text = (result?.text ?? '').trim();

    item.resolve({ text, queueMs, inferMs });
  } catch (err) {
    item.reject(err);
  } finally {
    setImmediate(processNextBaseItem);
  }
}

// ── Queue Processing: Partials (Stale Superseding) ──────────────────────────

async function processNextTinyItem(): Promise<void> {
  if (tinyPendingQueue.length === 0) {
    isTinyProcessing = false;
    return;
  }

  isTinyProcessing = true;
  const item = tinyPendingQueue.shift()!;
  const session = getOrCreateSession(item.opts.modelId ?? TINY_MODEL_ID);

  try {
    const currentLatestProcessed = latestProcessedPartialSeq.get(item.pipeline) ?? 0;
    // If a newer partial already completed, this one is stale
    if (item.seq < currentLatestProcessed) {
      item.resolve({ text: '', queueMs: 0, inferMs: 0 });
      setImmediate(processNextTinyItem);
      return;
    }

    const startedAt = Date.now();
    const queueMs = startedAt - item.enqueuedAt;

    const asr = await ensurePipeline(session);
    const result = await asr(item.pcm);
    const inferMs = Date.now() - startedAt;

    // Check again after inference in case a newer partial was processed
    const latestAfterInfer = latestProcessedPartialSeq.get(item.pipeline) ?? 0;
    if (item.seq < latestAfterInfer) {
      item.resolve({ text: '', queueMs, inferMs });
    } else {
      latestProcessedPartialSeq.set(item.pipeline, item.seq);
      const text = (result?.text ?? '').trim();
      item.resolve({ text, queueMs, inferMs });
    }
  } catch (err) {
    item.reject(err);
  } finally {
    setImmediate(processNextTinyItem);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Pre-warm the ASR model(s).
 */
export async function preloadWhisper(
  opts: { pipeline?: 'loopback' | 'microphone' | string; modelId?: string } = {},
): Promise<void> {
  if (opts.pipeline) {
    activePipelines.add(opts.pipeline);
  }

  if (opts.modelId) {
    await ensurePipeline(getOrCreateSession(opts.modelId));
  } else {
    // Pre-warm base.en (finals) and tiny.en (partials)
    await Promise.all([
      ensurePipeline(getOrCreateSession(BASE_MODEL_ID)),
      ensurePipeline(getOrCreateSession(TINY_MODEL_ID)),
    ]);
  }
}

/**
 * Transcribe one chunk of 16 kHz mono Float32 PCM.
 * Finals go to the base.en priority queue (loopback > mic).
 * Partials go to the tiny.en queue with stale superseding.
 */
export function transcribePcm(
  pcm: Float32Array,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const pipeline = opts.pipeline ?? 'microphone';
  const kind = opts.kind ?? 'final';
  const seq = opts.seq ?? 0;

  activePipelines.add(pipeline);

  if (kind === 'partial') {
    // Supersede pending older partials for the same pipeline
    const enqueuedSeq = latestEnqueuedPartialSeq.get(pipeline) ?? 0;
    if (seq > enqueuedSeq) {
      latestEnqueuedPartialSeq.set(pipeline, seq);
    }

    // Drop any pending older partials for this pipeline
    for (let i = tinyPendingQueue.length - 1; i >= 0; i--) {
      if (tinyPendingQueue[i].pipeline === pipeline && tinyPendingQueue[i].seq < seq) {
        const [dropped] = tinyPendingQueue.splice(i, 1);
        dropped.resolve({ text: '', queueMs: 0, inferMs: 0 });
      }
    }

    return new Promise<TranscribeResult>((resolve, reject) => {
      tinyPendingQueue.push({
        id: nextJobId++,
        pipeline,
        seq,
        pcm,
        opts,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      });

      if (!isTinyProcessing) {
        processNextTinyItem();
      }
    });
  }

  // Final chunk: enqueue to base.en priority queue
  return new Promise<TranscribeResult>((resolve, reject) => {
    basePendingQueue.push({
      id: nextJobId++,
      pipeline,
      pcm,
      opts,
      enqueuedAt: Date.now(),
      resolve,
      reject,
    });

    if (!isBaseProcessing) {
      processNextBaseItem();
    }
  });
}

/**
 * Release Whisper sessions with reference counting.
 */
export function releaseWhisper(opts: { pipeline?: 'loopback' | 'microphone' | string } = {}): void {
  if (opts.pipeline) {
    activePipelines.delete(opts.pipeline);
  }

  // Only tear down sessions when all registered pipelines have been released
  if (!opts.pipeline || activePipelines.size === 0) {
    activePipelines.clear();

    for (const item of basePendingQueue) {
      item.resolve({ text: '', queueMs: 0, inferMs: 0 });
    }
    basePendingQueue.length = 0;

    for (const item of tinyPendingQueue) {
      item.resolve({ text: '', queueMs: 0, inferMs: 0 });
    }
    tinyPendingQueue.length = 0;

    baseSession = null;
    tinySession = null;
    customSessions.clear();
    latestEnqueuedPartialSeq.clear();
    latestProcessedPartialSeq.clear();
  }
}
