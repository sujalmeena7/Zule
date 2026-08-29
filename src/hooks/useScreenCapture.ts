// ============================================
// Zule AI — Screen Capture Hook (refactored)
// ============================================
//
// Responsibilities:
//   - Downscale every frame to ≤ 1280 px longest edge before OCR (Req 13.1)
//   - Skip OCR when the perceptual hash hasn't changed beyond threshold (Req 13.2)
//   - Maintain a 5-entry recent-OCR ring buffer with timestamps (Req 13.6)
//   - Handle videoElement.play() rejection as screen.autoplay-blocked (Req 13.5)

import { useState, useRef, useCallback, useEffect } from 'react';
import { recognizeTextDeduped, terminateOcrWorker, OcrWatchdog } from '../workers/ocrWorker';
import { prepareFrame } from '../workers/framePrepWorker';
import { downscaleSize } from '../utils/geometry';
import { phash, hammingDistance } from '../utils/phash';
import { pushToRingBuffer } from '../utils/ringBuffer';
import { useZuleError } from './useZuleError';

/** Maximum longest edge in pixels before passing to OCR. */
const MAX_LONGEST_EDGE = 1920;

/** Default Hamming distance threshold for skipping OCR (bits). */
const DEFAULT_HASH_THRESHOLD = 5;

/** Maximum time (ms) to wait for a decoded frame before dispatching without screen context (Req 4.4). */
export const FRAME_READY_TIMEOUT_MS = 2000;

/** Maximum entries in the recent-OCR ring buffer. */
const OCR_RING_BUFFER_MAX = 5;

/** Default maximum byte length for keyframe JPEG output. */
const DEFAULT_MAX_KEYFRAME_BYTES = 500_000;

/** Default initial JPEG quality for async keyframe encoding. */
const DEFAULT_INITIAL_QUALITY = 0.85;

/** A single OCR result stored in the ring buffer. */
export interface OcrEntry {
  text: string;
  timestamp: number;
  hash: Uint8Array;
}

interface ScreenCaptureHook {
  screenText: string;
  isCapturing: boolean;
  isSupported: boolean;
  startCapture: () => Promise<void>;
  stopCapture: () => void;
  previewRef: React.RefObject<HTMLVideoElement | null>;
  /** The most-recent OCR results (up to 5) with timestamps. */
  recentOcrResults: readonly OcrEntry[];
  /**
   * Capture the current downscaled frame as a base64-encoded JPEG string.
   * Returns null if the video element isn't ready or capture is not active.
   * Used when the active adapter supports image input (Requirement 23.3).
   */
  getKeyframeBase64: () => string | null;
  /**
   * Run OCR on the current frame immediately and resolve with the text.
   *
   * The periodic OCR loop only fires every 3 s and skips frames whose
   * perceptual hash has not moved, so a caller that needs screen text *now*
   * (the "Use Screen" button, which asks a question the instant it is
   * pressed) cannot wait for it — it would read an empty `screenText`.
   * This bypasses both the interval and the hash gate.
   *
   * Resolves with `''` when no frame is available or OCR fails, so callers
   * can proceed without screen context rather than throwing.
   */
  captureTextNow: () => Promise<string>;
  /**
   * Wait for the video sink to have a decoded frame ready. Resolves as soon as
   * the video element reports `readyState >= HAVE_CURRENT_DATA` (via the
   * `loadeddata` or `canplay` event), or after the bounded timeout fires.
   *
   * Returns `{ frameReady: true }` when a decoded frame is available, or
   * `{ frameReady: false }` when the timeout expired (the caller should
   * dispatch without Keyframe/Screen_Text). On timeout, a non-blocking notice
   * is surfaced via the error pipeline (Req 4.3, 4.4).
   */
  waitForFrameReady: () => Promise<{ frameReady: boolean }>;
  /**
   * Whether OCR is required for the current adapter configuration.
   * When false, the periodic OCR loop suspends to save CPU (Req 2.5).
   */
  ocrRequired: boolean;
  /**
   * The most recent Frame_Hash (8-byte Uint8Array) from the last
   * prepared frame. Used for cache keying (Req 5.2, 6.1).
   */
  latestFrameHash: Uint8Array | null;
  /**
   * Async keyframe capture that uses OffscreenCanvas when available.
   * Returns null if no frame is ready. Bounded by maxKeyframeBytes (Req 5.1, 5.3, 7.1).
   */
  getKeyframeAsync: () => Promise<{
    base64: string;
    hash: Uint8Array;
    bytes: number;
  } | null>;
}

export function useScreenCapture(opts?: {
  hashThreshold?: number;
  ocrLanguage?: string;
  /**
   * Whether OCR is required for the current adapter configuration.
   * When false, the periodic OCR loop suspends to save CPU (Req 2.5).
   * Defaults to true.
   */
  ocrRequired?: boolean;
  /**
   * Maximum byte length for the async keyframe JPEG output (Req 7.1).
   * Defaults to 200,000 bytes.
   */
  maxKeyframeBytes?: number;
  /**
   * Initial JPEG quality (0–1) for async keyframe encoding (Req 7.2).
   * Defaults to 0.7.
   */
  initialQuality?: number;
}): ScreenCaptureHook {
  const hashThreshold = opts?.hashThreshold ?? DEFAULT_HASH_THRESHOLD;
  const ocrLanguage = opts?.ocrLanguage ?? 'eng';
  const ocrRequired = opts?.ocrRequired ?? true;
  const maxKeyframeBytes = opts?.maxKeyframeBytes ?? DEFAULT_MAX_KEYFRAME_BYTES;
  const initialQuality = opts?.initialQuality ?? DEFAULT_INITIAL_QUALITY;

  const [screenText, setScreenText] = useState('');
  const [isCapturing, setIsCapturing] = useState(false);
  const [recentOcrResults, setRecentOcrResults] = useState<OcrEntry[]>([]);

  const streamRef = useRef<MediaStream | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastHashRef = useRef<Uint8Array | null>(null);
  const watchdogRef = useRef<OcrWatchdog>(new OcrWatchdog());
  const ocrRequiredRef = useRef(ocrRequired);
  const latestFrameHashRef = useRef<Uint8Array | null>(null);
  const notifyError = useZuleError();

  const isSupported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    !!navigator.mediaDevices.getDisplayMedia;

  // Keep ocrRequiredRef in sync with the latest prop value so
  // the interval callback always reads the current setting.
  useEffect(() => {
    ocrRequiredRef.current = ocrRequired;
  }, [ocrRequired]);

  /**
   * Lazily create the `<video>` sink that frames are decoded into.
   *
   * The hook owns this element rather than expecting a consumer to render one
   * and bind `previewRef`: nothing ever bound it, so `captureFrame` failed its
   * first guard on every call and OCR never ran at all. Owning the sink here
   * means screen capture works for any consumer, including the native overlay
   * window, without depending on a particular render tree.
   *
   * It is positioned off-screen rather than `display: none` — a `display: none`
   * video can have its decode pipeline suspended by the browser, which would
   * starve `captureFrame()` of pixels even though the stream is live. It is
   * muted and `playsInline` so autoplay is permitted.
   */
  const ensureVideoElement = useCallback((): HTMLVideoElement => {
    const existing = previewRef.current;
    if (existing && existing.isConnected) return existing;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');
    video.style.position = 'fixed';
    video.style.top = '-10000px';
    video.style.left = '-10000px';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    document.body.appendChild(video);

    previewRef.current = video;
    return video;
  }, []);

  /**
   * Capture the current video frame, downscale it, and return ImageData.
   * Returns null if the video element isn't ready.
   */
  const captureFrame = useCallback((): {
    imageData: ImageData;
    canvas: HTMLCanvasElement;
  } | null => {
    const video = previewRef.current;
    if (!video || video.readyState < video.HAVE_ENOUGH_DATA) return null;

    const srcWidth = video.videoWidth;
    const srcHeight = video.videoHeight;
    if (srcWidth <= 0 || srcHeight <= 0) return null;

    // Downscale to ≤ 1280 px longest edge (Req 13.1)
    const { width, height } = downscaleSize(
      { width: srcWidth, height: srcHeight },
      MAX_LONGEST_EDGE,
    );

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    return { imageData, canvas };
  }, []);

  const startCapture = useCallback(async () => {
    if (!isSupported) return;

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 1, max: 5 } },
        audio: false,
      });

      streamRef.current = stream;
      setIsCapturing(true);

      {
        const video = ensureVideoElement();
        video.srcObject = stream;

        // Handle videoElement.play() rejection (Req 13.5)
        try {
          await video.play();
        } catch (playError: unknown) {
          if (
            playError instanceof DOMException &&
            playError.name === 'NotAllowedError'
          ) {
            notifyError({ kind: 'screen.autoplay-blocked' });
            // Stop the capture stream since we can't play the video
            stream.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
            setIsCapturing(false);
            return;
          }
          // Re-throw unexpected errors
          throw playError;
        }
      }

      // Reset state
      setScreenText('');
      setRecentOcrResults([]);
      lastHashRef.current = null;
      watchdogRef.current.reset();

      // Periodic OCR (every 3 seconds)
      intervalRef.current = setInterval(async () => {
        // If watchdog disabled OCR, skip
        if (watchdogRef.current.state === 'disabled') return;

        // If OCR is not required (e.g. Vision_Adapter in use), suspend (Req 2.5)
        if (!ocrRequiredRef.current) return;

        const frame = captureFrame();
        if (!frame) return;

        const { imageData, canvas } = frame;

        // Compute perceptual hash of the downscaled frame (Req 13.2)
        const currentHash = phash(imageData);

        // Skip OCR if the frame hasn't changed enough
        if (lastHashRef.current) {
          const distance = hammingDistance(currentHash, lastHashRef.current);
          if (distance < hashThreshold) {
            // Frame is too similar — skip OCR
            return;
          }
        }

        // Frame changed enough — run OCR via dedup gate (Req 1.5)
        try {
          const text = await recognizeTextDeduped(canvas, currentHash, ocrLanguage);
          if (text && text.trim()) {
            const trimmed = text.trim();
            setScreenText(trimmed);

            // Update the ring buffer (Req 13.6)
            const entry: OcrEntry = {
              text: trimmed,
              timestamp: Date.now(),
              hash: currentHash,
            };
            setRecentOcrResults((prev) =>
              pushToRingBuffer(prev, entry, OCR_RING_BUFFER_MAX),
            );
          }
          // OCR succeeded — record success to clear the error window
          watchdogRef.current.recordSuccess();
        } catch {
          // OCR failure — let the watchdog decide what to do (Req 20.3)
          const { action } = watchdogRef.current.recordError();
          if (action === 'recreate') {
            // Terminate and recreate the worker
            await terminateOcrWorker();
            // Worker will be lazily recreated on next recognizeTextDeduped call
          } else if (action === 'disable') {
            // Disable OCR for the rest of the session
            notifyError({
              kind: 'ocr.worker-failed',
              consecutiveFailures: watchdogRef.current.consecutiveFailures,
            } as any);
          }
        }

        // Update the last hash regardless of OCR success so we don't
        // keep re-trying on frames that match
        lastHashRef.current = currentHash;
      }, 3000);

      // Handle user stopping the share via browser UI
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        stopCapture();
      });
    } catch (error: unknown) {
      if (
        error instanceof DOMException &&
        error.name === 'NotAllowedError'
      ) {
        notifyError({ kind: 'screen.permission-denied' });
      } else {
        console.warn('Screen capture failed:', error);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupported, hashThreshold, captureFrame, notifyError, ensureVideoElement]);

  const stopCapture = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    // Detach the stream and drop the sink the hook created, so a stopped
    // capture leaves no off-screen <video> behind in the document.
    if (previewRef.current) {
      previewRef.current.srcObject = null;
      previewRef.current.remove();
      previewRef.current = null;
    }
    setIsCapturing(false);
    setScreenText('');
    // Note: we intentionally keep recentOcrResults so context can still
    // reason about screen changes after capture stops.
    lastHashRef.current = null;

    // Terminate the OCR worker when capture stops (Req 13.3).
    // It will be recreated lazily on next start via getOcrWorker().
    terminateOcrWorker().catch(() => {
      // Best-effort termination — ignore errors
    });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      // Remove the off-screen sink this hook appended to the document.
      if (previewRef.current) {
        previewRef.current.srcObject = null;
        previewRef.current.remove();
        previewRef.current = null;
      }
    };
  }, []);

  /**
   * Run OCR on the current frame immediately, outside the 3 s interval and
   * outside the perceptual-hash skip, and resolve with the recognised text.
   *
   * Mirrors the interval's bookkeeping so the two paths stay consistent: the
   * ring buffer and `lastHashRef` are updated on success, and failures go
   * through the same watchdog. Never throws — an unavailable frame or a failed
   * OCR pass resolves to `''` so the caller can carry on without screen text.
   */
  const captureTextNow = useCallback(async (): Promise<string> => {
    if (watchdogRef.current.state === 'disabled') return '';

    const frame = captureFrame();
    if (!frame) return '';

    const { imageData, canvas } = frame;

    try {
      // Compute perceptual hash first so we can use the dedup gate (Req 1.5).
      // If the same frame is already being OCR'd (e.g. periodic loop or a
      // concurrent triggerAI fire-and-forget), recognizeTextDeduped will reuse
      // the in-flight promise rather than starting a duplicate Tesseract pass.
      const currentHash = phash(imageData);
      const text = await recognizeTextDeduped(canvas, currentHash, ocrLanguage);
      watchdogRef.current.recordSuccess();

      const trimmed = (text ?? '').trim();
      if (!trimmed) return '';

      setScreenText(trimmed);
      setRecentOcrResults((prev) =>
        pushToRingBuffer(
          prev,
          { text: trimmed, timestamp: Date.now(), hash: currentHash },
          OCR_RING_BUFFER_MAX,
        ),
      );
      // Record the hash so the next interval tick does not redo the work we
      // just did on an unchanged frame.
      lastHashRef.current = currentHash;

      return trimmed;
    } catch {
      const { action } = watchdogRef.current.recordError();
      if (action === 'recreate') {
        await terminateOcrWorker().catch(() => {});
      } else if (action === 'disable') {
        notifyError({
          kind: 'ocr.worker-failed',
          consecutiveFailures: watchdogRef.current.consecutiveFailures,
        });
      }
      return '';
    }
  }, [captureFrame, ocrLanguage, notifyError]);

  /**
   * Capture the current downscaled video frame as a base64-encoded JPEG string.
   * Returns null if capture is not active or the video element isn't ready.
   * The quality is set to 0.5 to keep payload size reasonable (Requirement 23.3).
   */
  const getKeyframeBase64 = useCallback((): string | null => {
    if (!isCapturing) return null;
    const frame = captureFrame();
    if (!frame) return null;
    const { canvas } = frame;
    // toDataURL returns "data:image/jpeg;base64,<data>"; strip the prefix
    const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
    return base64;
  }, [isCapturing, captureFrame]);

  /**
   * Wait for the video sink to report a decoded frame is available.
   *
   * Resolves immediately if the video element already has readyState >=
   * HAVE_CURRENT_DATA. Otherwise listens for `loadeddata` / `canplay` events
   * and resolves the instant one fires.
   *
   * A bounded timeout of FRAME_READY_TIMEOUT_MS (≤2000 ms, Req 4.4) fires if
   * no decoded frame arrives in time. In that case the promise resolves with
   * `{ frameReady: false }` and a non-blocking notice is surfaced so the
   * caller knows to dispatch without Keyframe/Screen_Text (Req 4.3).
   *
   * This replaces the fixed 2000 ms poll that previously gated frame readiness
   * (Req 4.1, 4.2).
   */
  const waitForFrameReady = useCallback((): Promise<{ frameReady: boolean }> => {
    const video = previewRef.current;

    // If no video element exists, we can't wait — resolve as not ready.
    if (!video) {
      notifyError({ kind: 'screen.frame-not-available' });
      return Promise.resolve({ frameReady: false });
    }

    // If the video already has a decoded frame, resolve immediately (Req 4.2).
    if (video.readyState >= video.HAVE_CURRENT_DATA) {
      return Promise.resolve({ frameReady: true });
    }

    return new Promise<{ frameReady: boolean }>((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        video.removeEventListener('loadeddata', onFrameReady);
        video.removeEventListener('canplay', onFrameReady);
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
      };

      const onFrameReady = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ frameReady: true });
      };

      // Listen for the events that signal a decoded frame is available.
      video.addEventListener('loadeddata', onFrameReady);
      video.addEventListener('canplay', onFrameReady);

      // Bounded fallback timeout (Req 4.3, 4.4).
      timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        notifyError({ kind: 'screen.frame-not-available' });
        resolve({ frameReady: false });
      }, FRAME_READY_TIMEOUT_MS);
    });
  }, [notifyError]);

  /**
   * Async keyframe capture that delegates heavy computation (downscale, phash,
   * JPEG encode) to the FramePrepWorker off the main thread (Req 5.1, 5.2, 5.3).
   *
   * The main thread only grabs the raw pixel data from the video at its native
   * resolution via a `drawImage` + `getImageData` call (GPU-accelerated), then
   * transfers the ArrayBuffer to the worker. The worker handles:
   *   - Downscaling to ≤1280px longest edge (Req 5.4)
   *   - Perceptual hash computation
   *   - JPEG encoding bounded by maxKeyframeBytes
   *
   * Updates `latestFrameHashRef` with the result hash for cache keying.
   * Returns `{ base64, hash, bytes }` or `null` if no frame is available.
   */
  const getKeyframeAsync = useCallback(async (): Promise<{
    base64: string;
    hash: Uint8Array;
    bytes: number;
  } | null> => {
    if (!isCapturing) return null;

    const video = previewRef.current;
    if (!video || video.readyState < video.HAVE_ENOUGH_DATA) return null;

    const srcWidth = video.videoWidth;
    const srcHeight = video.videoHeight;
    if (srcWidth <= 0 || srcHeight <= 0) return null;

    // Grab the raw pixel data at the video's native resolution.
    // The drawImage call is GPU-accelerated and fast; getImageData extracts
    // the RGBA buffer for transfer to the worker.
    const canvas = document.createElement('canvas');
    canvas.width = srcWidth;
    canvas.height = srcHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, srcWidth, srcHeight);
    const imageData = ctx.getImageData(0, 0, srcWidth, srcHeight);

    // Transfer the pixel buffer to the worker. The worker will handle
    // downscaling to ≤1280px, phash computation, and JPEG encoding.
    try {
      const result = await prepareFrame({
        pixels: imageData.data.buffer,
        width: srcWidth,
        height: srcHeight,
        maxKeyframeBytes,
        initialQuality,
      });

      // Update the latest frame hash for cache keying (Req 6.1)
      latestFrameHashRef.current = result.hash;

      return {
        base64: result.keyframeBase64,
        hash: result.hash,
        bytes: result.keyframeBytes,
      };
    } catch {
      // If frame prep fails, return null — caller should fall back gracefully.
      return null;
    }
  }, [isCapturing, maxKeyframeBytes, initialQuality]);

  return {
    screenText,
    isCapturing,
    isSupported,
    startCapture,
    stopCapture,
    previewRef,
    recentOcrResults,
    getKeyframeBase64,
    captureTextNow,
    waitForFrameReady,
    ocrRequired,
    latestFrameHash: latestFrameHashRef.current,
    getKeyframeAsync,
  };
}
