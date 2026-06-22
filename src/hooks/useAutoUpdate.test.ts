// ============================================
// Zule AI — useAutoUpdate hook unit tests
// ============================================
//
// Tests for the useAutoUpdate React hook covering:
// - Default state initialization
// - Subscription/unsubscription lifecycle
// - Dispatcher calls to electronAPI methods
// - Graceful fallback when electronAPI is unavailable
// - Dismissed state management

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoUpdate } from './useAutoUpdate';
import type { UpdateState } from '../types/electron';

// ─── Mock helpers ────────────────────────────────────────────────────────────

function createMockElectronAPI() {
  const listeners: Array<(state: UpdateState) => void> = [];
  const unsubscribe = vi.fn();

  return {
    api: {
      checkForUpdate: vi.fn(),
      downloadUpdate: vi.fn(),
      cancelDownload: vi.fn(),
      installUpdate: vi.fn(),
      deferInstall: vi.fn(),
      onUpdateState: vi.fn((cb: (state: UpdateState) => void) => {
        listeners.push(cb);
        return unsubscribe;
      }),
    },
    listeners,
    unsubscribe,
  };
}

describe('useAutoUpdate', () => {
  const originalElectronAPI = window.electronAPI;

  beforeEach(() => {
    // Clear any previous mock
    (window as any).electronAPI = undefined;
  });

  afterEach(() => {
    (window as any).electronAPI = originalElectronAPI;
  });

  // ── Default state ───────────────────────────────────────────────────────

  it('initializes with idle state and dismissed=false', () => {
    const { result } = renderHook(() => useAutoUpdate());

    expect(result.current.state).toEqual({
      status: 'idle',
      currentVersion: '0.0.0',
      availableVersion: null,
      releaseNotes: null,
      progress: null,
      error: null,
    });
    expect(result.current.dismissed).toBe(false);
  });

  // ── Subscription lifecycle ──────────────────────────────────────────────

  it('subscribes to onUpdateState on mount', () => {
    const mock = createMockElectronAPI();
    (window as any).electronAPI = mock.api;

    renderHook(() => useAutoUpdate());

    expect(mock.api.onUpdateState).toHaveBeenCalledTimes(1);
    expect(mock.api.onUpdateState).toHaveBeenCalledWith(expect.any(Function));
  });

  it('unsubscribes on unmount', () => {
    const mock = createMockElectronAPI();
    (window as any).electronAPI = mock.api;

    const { unmount } = renderHook(() => useAutoUpdate());
    unmount();

    expect(mock.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('updates state when onUpdateState callback is invoked', () => {
    const mock = createMockElectronAPI();
    (window as any).electronAPI = mock.api;

    const { result } = renderHook(() => useAutoUpdate());

    const newState: UpdateState = {
      status: 'available',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
      releaseNotes: '# New features\n- Feature A',
      progress: null,
      error: null,
    };

    act(() => {
      mock.listeners[0](newState);
    });

    expect(result.current.state).toEqual(newState);
  });

  // ── Dispatchers ─────────────────────────────────────────────────────────

  it('check() calls electronAPI.checkForUpdate', () => {
    const mock = createMockElectronAPI();
    (window as any).electronAPI = mock.api;

    const { result } = renderHook(() => useAutoUpdate());

    act(() => {
      result.current.check();
    });

    expect(mock.api.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it('download() calls electronAPI.downloadUpdate', () => {
    const mock = createMockElectronAPI();
    (window as any).electronAPI = mock.api;

    const { result } = renderHook(() => useAutoUpdate());

    act(() => {
      result.current.download();
    });

    expect(mock.api.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('cancel() calls electronAPI.cancelDownload', () => {
    const mock = createMockElectronAPI();
    (window as any).electronAPI = mock.api;

    const { result } = renderHook(() => useAutoUpdate());

    act(() => {
      result.current.cancel();
    });

    expect(mock.api.cancelDownload).toHaveBeenCalledTimes(1);
  });

  it('install() calls electronAPI.installUpdate', () => {
    const mock = createMockElectronAPI();
    (window as any).electronAPI = mock.api;

    const { result } = renderHook(() => useAutoUpdate());

    act(() => {
      result.current.install();
    });

    expect(mock.api.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('defer() calls electronAPI.deferInstall', () => {
    const mock = createMockElectronAPI();
    (window as any).electronAPI = mock.api;

    const { result } = renderHook(() => useAutoUpdate());

    act(() => {
      result.current.defer();
    });

    expect(mock.api.deferInstall).toHaveBeenCalledTimes(1);
  });

  it('dismiss() sets dismissed to true', () => {
    const { result } = renderHook(() => useAutoUpdate());

    expect(result.current.dismissed).toBe(false);

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.dismissed).toBe(true);
  });

  // ── Graceful fallback when electronAPI is unavailable ───────────────────

  it('dispatchers are no-ops when electronAPI is undefined', () => {
    (window as any).electronAPI = undefined;

    const { result } = renderHook(() => useAutoUpdate());

    // None of these should throw
    expect(() => {
      act(() => {
        result.current.check();
        result.current.download();
        result.current.cancel();
        result.current.install();
        result.current.defer();
      });
    }).not.toThrow();
  });

  it('dispatchers are no-ops when specific methods are missing', () => {
    // Partial electronAPI - onUpdateState exists but action methods don't
    (window as any).electronAPI = {
      onUpdateState: vi.fn(() => () => {}),
      // No checkForUpdate, downloadUpdate, etc.
    };

    const { result } = renderHook(() => useAutoUpdate());

    expect(() => {
      act(() => {
        result.current.check();
        result.current.download();
        result.current.cancel();
        result.current.install();
        result.current.defer();
      });
    }).not.toThrow();
  });

  it('does not subscribe when onUpdateState is unavailable', () => {
    (window as any).electronAPI = {
      checkForUpdate: vi.fn(),
      // No onUpdateState
    };

    const { result } = renderHook(() => useAutoUpdate());

    // Should remain in default state
    expect(result.current.state.status).toBe('idle');
  });

  // ── State reset semantics ──────────────────────────────────────────────

  it('dismissed state is in-memory only (resets on re-mount)', () => {
    const { result, unmount } = renderHook(() => useAutoUpdate());

    act(() => {
      result.current.dismiss();
    });
    expect(result.current.dismissed).toBe(true);

    // Re-mounting simulates app restart — dismissed resets
    unmount();
    const { result: result2 } = renderHook(() => useAutoUpdate());
    expect(result2.current.dismissed).toBe(false);
  });
});
