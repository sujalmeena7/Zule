// ============================================
// Zule AI — useOverlayMode Hook Tests
// ============================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useOverlayMode,
  COMPACT_WIDTH,
  COMPACT_HEIGHT,
  EXPANDED_WIDTH,
  EXPANDED_HEIGHT,
} from './useOverlayMode';

// Mock the useElectronBridge hook
const mockResizeOverlay = vi.fn().mockResolvedValue(true);

vi.mock('../hooks/useElectronBridge', () => ({
  isElectron: () => true,
  useElectronBridge: () => ({
    isElectronEnv: true,
    api: {
      resizeOverlay: mockResizeOverlay,
      platform: 'win32',
      isElectron: true,
      setContentProtection: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      startOverlay: vi.fn(),
      stopOverlay: vi.fn(),
      toggleOverlay: vi.fn(),
      moveOverlay: vi.fn(),
      getOverlayBounds: vi.fn(),
      sendSyncMessage: vi.fn(),
      onSyncMessage: vi.fn(),
      onOverlayError: vi.fn(),
      onGlobalShortcut: vi.fn(),
      getDesktopSources: vi.fn(),
    },
  }),
}));

describe('useOverlayMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts in compact mode by default', () => {
    const { result } = renderHook(() => useOverlayMode());
    expect(result.current.mode).toBe('compact');
    expect(result.current.isCompact).toBe(true);
    expect(result.current.isExpanded).toBe(false);
  });

  it('starts in expanded mode when specified', () => {
    const { result } = renderHook(() => useOverlayMode('expanded'));
    expect(result.current.mode).toBe('expanded');
    expect(result.current.isCompact).toBe(false);
    expect(result.current.isExpanded).toBe(true);
  });

  it('toggles from compact to expanded', () => {
    const { result } = renderHook(() => useOverlayMode('compact'));

    act(() => {
      result.current.toggleMode();
    });

    expect(result.current.mode).toBe('expanded');
    expect(result.current.isExpanded).toBe(true);
    expect(result.current.isCompact).toBe(false);
  });

  it('toggles from expanded to compact', () => {
    const { result } = renderHook(() => useOverlayMode('expanded'));

    act(() => {
      result.current.toggleMode();
    });

    expect(result.current.mode).toBe('compact');
    expect(result.current.isCompact).toBe(true);
    expect(result.current.isExpanded).toBe(false);
  });

  it('calls resizeOverlay with compact dimensions when switching to compact', () => {
    const { result } = renderHook(() => useOverlayMode('expanded'));

    act(() => {
      result.current.setMode('compact');
    });

    expect(mockResizeOverlay).toHaveBeenCalledWith(COMPACT_WIDTH, COMPACT_HEIGHT);
  });

  it('calls resizeOverlay with expanded dimensions when switching to expanded', () => {
    const { result } = renderHook(() => useOverlayMode('compact'));

    act(() => {
      result.current.setMode('expanded');
    });

    expect(mockResizeOverlay).toHaveBeenCalledWith(EXPANDED_WIDTH, EXPANDED_HEIGHT);
  });

  it('announces mode transition for aria-live after first toggle', () => {
    const { result } = renderHook(() => useOverlayMode('compact'));

    // First transition — should announce
    act(() => {
      result.current.toggleMode();
    });
    expect(result.current.modeAnnouncement).toBe('Expanded mode');

    // Second transition
    act(() => {
      result.current.toggleMode();
    });
    expect(result.current.modeAnnouncement).toBe('Compact mode');
  });

  it('does not announce on initial render', () => {
    const { result } = renderHook(() => useOverlayMode('compact'));
    expect(result.current.modeAnnouncement).toBe('');
  });

  it('setMode sets the mode directly', () => {
    const { result } = renderHook(() => useOverlayMode('compact'));

    act(() => {
      result.current.setMode('expanded');
    });

    expect(result.current.mode).toBe('expanded');
    expect(mockResizeOverlay).toHaveBeenCalledWith(EXPANDED_WIDTH, EXPANDED_HEIGHT);
  });
});
