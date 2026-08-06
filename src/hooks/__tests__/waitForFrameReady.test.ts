// ============================================
// Zule AI — waitForFrameReady unit tests
// ============================================
//
// Tests for the `waitForFrameReady` method returned by the useScreenCapture
// hook, covering event-driven frame readiness (Requirements 4.1, 4.2, 4.3):
//
//   - Event-driven dispatch fires on `loadeddata`
//   - No fixed delay once frame is available
//   - Timeout fallback fires correctly at ≤2000ms

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useScreenCapture, FRAME_READY_TIMEOUT_MS } from '../useScreenCapture';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock useZuleError to capture error notifications
const mockNotifyError = vi.fn();
vi.mock('../useZuleError', () => ({
  useZuleError: () => mockNotifyError,
}));

// Mock the OCR worker — not needed for frame readiness tests
vi.mock('../../workers/ocrWorker', () => ({
  recognizeText: vi.fn().mockResolvedValue(''),
  recognizeTextDeduped: vi.fn().mockResolvedValue(''),
  terminateOcrWorker: vi.fn().mockResolvedValue(undefined),
  OcrWatchdog: class MockOcrWatchdog {
    state = 'active';
    consecutiveFailures = 0;
    reset() {}
    recordSuccess() {}
    recordError() { return { action: 'none' }; }
  },
}));

// Mock framePrepWorker
vi.mock('../../workers/framePrepWorker', () => ({
  prepareFrame: vi.fn().mockResolvedValue({
    hash: new Uint8Array(8),
    keyframeBase64: '',
    keyframeBytes: 0,
    reEncodeCount: 0,
  }),
}));

// Mock phash utilities
vi.mock('../../utils/phash', () => ({
  phash: vi.fn().mockReturnValue(new Uint8Array(8)),
  hammingDistance: vi.fn().mockReturnValue(0),
  PHASH_BYTES: 8,
}));

// Mock geometry utility
vi.mock('../../utils/geometry', () => ({
  downscaleSize: vi.fn().mockReturnValue({ width: 640, height: 480 }),
}));

// Mock ring buffer
vi.mock('../../utils/ringBuffer', () => ({
  pushToRingBuffer: vi.fn((prev, entry, max) => [...prev, entry].slice(-max)),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Creates a mock video element with controllable readyState and events.
 */
function createMockVideoElement(readyState = 0): HTMLVideoElement {
  const listeners: Record<string, Array<() => void>> = {};

  const video = {
    muted: true,
    playsInline: true,
    readyState,
    videoWidth: 1920,
    videoHeight: 1080,
    srcObject: null,
    isConnected: true,
    // Constants
    HAVE_NOTHING: 0,
    HAVE_METADATA: 1,
    HAVE_CURRENT_DATA: 2,
    HAVE_FUTURE_DATA: 3,
    HAVE_ENOUGH_DATA: 4,
    setAttribute: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn(),
    addEventListener: vi.fn((event: string, handler: () => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    removeEventListener: vi.fn((event: string, handler: () => void) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((h) => h !== handler);
      }
    }),
    // Test helper: emit an event
    _emit(event: string) {
      (listeners[event] || []).forEach((h) => h());
    },
    style: {
      position: '',
      top: '',
      left: '',
      width: '',
      height: '',
      opacity: '',
      pointerEvents: '',
    },
  } as unknown as HTMLVideoElement & { _emit: (event: string) => void };

  return video;
}

/**
 * Mock MediaStream for startCapture.
 */
function createMockStream() {
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
}

// Store the real createElement before any mocking so we can delegate for
// non-video elements without infinite recursion.
const realCreateElement = document.createElement.bind(document);

describe('waitForFrameReady', () => {
  let mockVideo: ReturnType<typeof createMockVideoElement>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockNotifyError.mockClear();
    mockVideo = createMockVideoElement(0);

    // Mock document.createElement to return our mock video element
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'video') return mockVideo as unknown as HTMLElement;
      return realCreateElement(tag);
    });

    // Mock document.body.appendChild
    vi.spyOn(document.body, 'appendChild').mockImplementation((node) => node);

    // Mock getDisplayMedia
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getDisplayMedia: vi.fn().mockResolvedValue(createMockStream()),
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Test: event-driven dispatch fires on `loadeddata` ─────────────────
  // Validates Requirement 4.1: dispatch as soon as video sink reports a
  // decoded frame is available.

  it('resolves with frameReady: true when loadeddata event fires', async () => {
    const { result } = renderHook(() => useScreenCapture());

    // Start capture to create the video element
    await act(async () => {
      await result.current.startCapture();
    });

    // Now call waitForFrameReady - video readyState is 0, so it will wait
    let resolvedValue: { frameReady: boolean } | undefined;
    act(() => {
      result.current.waitForFrameReady().then((v) => {
        resolvedValue = v;
      });
    });

    // Should not have resolved yet (no frame available)
    expect(resolvedValue).toBeUndefined();

    // Simulate the video element emitting loadeddata
    act(() => {
      mockVideo._emit('loadeddata');
    });

    // Flush microtasks
    await act(async () => {
      await Promise.resolve();
    });

    expect(resolvedValue).toEqual({ frameReady: true });
  });

  it('resolves with frameReady: true when canplay event fires', async () => {
    const { result } = renderHook(() => useScreenCapture());

    await act(async () => {
      await result.current.startCapture();
    });

    let resolvedValue: { frameReady: boolean } | undefined;
    act(() => {
      result.current.waitForFrameReady().then((v) => {
        resolvedValue = v;
      });
    });

    expect(resolvedValue).toBeUndefined();

    // Simulate canplay instead of loadeddata
    act(() => {
      mockVideo._emit('canplay');
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(resolvedValue).toEqual({ frameReady: true });
  });

  // ── Test: no fixed delay once frame is available ──────────────────────
  // Validates Requirement 4.2: SHALL NOT wait for a fixed interval once a
  // decoded frame is available.

  it('resolves immediately when readyState >= HAVE_CURRENT_DATA', async () => {
    // Create a video that already has a decoded frame (HAVE_CURRENT_DATA = 2)
    mockVideo = createMockVideoElement(2);

    // Re-mock createElement so the hook uses our new video with readyState=2
    vi.mocked(document.createElement).mockImplementation((tag: string) => {
      if (tag === 'video') return mockVideo as unknown as HTMLElement;
      return realCreateElement(tag);
    });

    const { result } = renderHook(() => useScreenCapture());

    await act(async () => {
      await result.current.startCapture();
    });

    let resolvedValue: { frameReady: boolean } | undefined;
    await act(async () => {
      resolvedValue = await result.current.waitForFrameReady();
    });

    // Should resolve immediately — no setTimeout needed
    expect(resolvedValue).toEqual({ frameReady: true });
    // Verify no error was notified
    expect(mockNotifyError).not.toHaveBeenCalled();
  });

  it('does not use a fixed delay when video reports frame available', async () => {
    const { result } = renderHook(() => useScreenCapture());

    await act(async () => {
      await result.current.startCapture();
    });

    const startTime = Date.now();
    let resolveTime: number | undefined;

    act(() => {
      result.current.waitForFrameReady().then(() => {
        resolveTime = Date.now();
      });
    });

    // Emit loadeddata immediately (frame decoded fast)
    act(() => {
      mockVideo._emit('loadeddata');
    });

    await act(async () => {
      await Promise.resolve();
    });

    // Should have resolved without advancing timers
    expect(resolveTime).toBeDefined();
    expect(resolveTime! - startTime).toBe(0); // No fixed delay elapsed
  });

  // ── Test: timeout fallback fires correctly at ≤2000ms ─────────────────
  // Validates Requirement 4.3: bounded timeout dispatches without screen
  // context and surfaces non-blocking notice.
  // Validates Requirement 4.4: timeout ≤ 2000 milliseconds.

  it('resolves with frameReady: false after FRAME_READY_TIMEOUT_MS', async () => {
    const { result } = renderHook(() => useScreenCapture());

    await act(async () => {
      await result.current.startCapture();
    });

    let resolvedValue: { frameReady: boolean } | undefined;
    act(() => {
      result.current.waitForFrameReady().then((v) => {
        resolvedValue = v;
      });
    });

    // Should not resolve before the timeout
    expect(resolvedValue).toBeUndefined();

    // Advance time by the timeout period
    await act(async () => {
      vi.advanceTimersByTime(FRAME_READY_TIMEOUT_MS);
    });

    // Flush microtasks
    await act(async () => {
      await Promise.resolve();
    });

    expect(resolvedValue).toEqual({ frameReady: false });
  });

  it('calls notifyError with screen.frame-not-available on timeout', async () => {
    const { result } = renderHook(() => useScreenCapture());

    await act(async () => {
      await result.current.startCapture();
    });

    act(() => {
      result.current.waitForFrameReady();
    });

    // Advance past the timeout
    await act(async () => {
      vi.advanceTimersByTime(FRAME_READY_TIMEOUT_MS);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockNotifyError).toHaveBeenCalledWith({
      kind: 'screen.frame-not-available',
    });
  });

  it('timeout is at most 2000ms', () => {
    expect(FRAME_READY_TIMEOUT_MS).toBeLessThanOrEqual(2000);
  });

  it('does not fire timeout if event arrives before deadline', async () => {
    const { result } = renderHook(() => useScreenCapture());

    await act(async () => {
      await result.current.startCapture();
    });

    let resolvedValue: { frameReady: boolean } | undefined;
    act(() => {
      result.current.waitForFrameReady().then((v) => {
        resolvedValue = v;
      });
    });

    // Advance part of the timeout
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    // Fire loadeddata before the timeout expires
    act(() => {
      mockVideo._emit('loadeddata');
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(resolvedValue).toEqual({ frameReady: true });

    // Advance past the full timeout to confirm it doesn't fire
    await act(async () => {
      vi.advanceTimersByTime(FRAME_READY_TIMEOUT_MS);
    });

    // notifyError should NOT have been called (no timeout triggered)
    expect(mockNotifyError).not.toHaveBeenCalled();
    // Value should still be true (not overwritten by timeout)
    expect(resolvedValue).toEqual({ frameReady: true });
  });

  it('resolves with frameReady: false when no video element exists', async () => {
    // Render hook without starting capture (no video element)
    const { result } = renderHook(() => useScreenCapture());

    // previewRef.current is null before startCapture
    let resolvedValue: { frameReady: boolean } | undefined;
    await act(async () => {
      resolvedValue = await result.current.waitForFrameReady();
    });

    expect(resolvedValue).toEqual({ frameReady: false });
    expect(mockNotifyError).toHaveBeenCalledWith({
      kind: 'screen.frame-not-available',
    });
  });
});
