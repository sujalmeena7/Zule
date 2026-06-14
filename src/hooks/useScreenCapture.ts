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
import { recognizeText, terminateOcrWorker, OcrWatchdog } from '../workers/ocrWorker';
import { downscaleSize } from '../utils/geometry';
import { phash, hammingDistance, PHASH_BYTES } from '../utils/phash';
import { pushToRingBuffer } from '../utils/ringBuffer';
import { useZuleError } from './useZuleError';

/** Maximum longest edge in pixels before passing to OCR. */
const MAX_LONGEST_EDGE = 1280;

/** Default Hamming distance threshold for skipping OCR (bits). */
const DEFAULT_HASH_THRESHOLD = 5;

/** Maximum entries in the recent-OCR ring buffer. */
const OCR_RING_BUFFER_MAX = 5;

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
}

export function useScreenCapture(opts?: {
  hashThreshold?: number;
  ocrLanguage?: string;
}): ScreenCaptureHook {
  const hashThreshold = opts?.hashThreshold ?? DEFAULT_HASH_THRESHOLD;
  const ocrLanguage = opts?.ocrLanguage ?? 'eng';

  const [screenText, setScreenText] = useState('');
  const [isCapturing, setIsCapturing] = useState(false);
  const [recentOcrResults, setRecentOcrResults] = useState<OcrEntry[]>([]);

  const streamRef = useRef<MediaStream | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastHashRef = useRef<Uint8Array | null>(null);
  const watchdogRef = useRef<OcrWatchdog>(new OcrWatchdog());
  const notifyError = useZuleError();

  const isSupported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    !!navigator.mediaDevices.getDisplayMedia;

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

      if (previewRef.current) {
        previewRef.current.srcObject = stream;

        // Handle videoElement.play() rejection (Req 13.5)
        try {
          await previewRef.current.play();
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

        // Frame changed enough — run OCR
        try {
          const text = await recognizeText(canvas, ocrLanguage);
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
            // Worker will be lazily recreated on next recognizeText call
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
  }, [isSupported, hashThreshold, captureFrame, notifyError]);

  const stopCapture = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (previewRef.current) {
      previewRef.current.srcObject = null;
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
    };
  }, []);

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

  return {
    screenText,
    isCapturing,
    isSupported,
    startCapture,
    stopCapture,
    previewRef,
    recentOcrResults,
    getKeyframeBase64,
  };
}
