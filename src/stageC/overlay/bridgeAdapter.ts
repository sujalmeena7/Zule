/**
 * Stage C Overlay — Bridge Adapter Hook
 *
 * Provides a React hook that subscribes to `window.zuleOverlay` state events
 * and exposes intent-emitting callbacks. This is the sole communication layer
 * between the Stage C overlay React tree and the native sidecar.
 *
 * The overlay NEVER imports Electron IPC, service modules, audio/capture
 * pipelines, storage, or provider modules. All state arrives via projection;
 * all user actions emit as intents.
 *
 * Requirements: 7.1–7.3, 7.11–7.15, 8.1–8.7
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  ZuleOverlayBridge,
  OverlayStateSnapshot,
  OverlayStatePatch,
  OverlayRenderState,
  OverlayAction,
  AIAction,
  AudioAction,
  ScreenCaptureAction,
  RegionRect,
} from './types';
import type { OverlayMode } from '../../overlay/useOverlayMode';

// ────────────────────────────────────────────────────────────────────
// Default render state (before first snapshot arrives)
// ────────────────────────────────────────────────────────────────────

const DEFAULT_RENDER_STATE: OverlayRenderState = {
  visible: false,
  mode: 'compact',
  captureProtection: true,
  isSystemAudioActive: false,
  isLoading: false,
  isStreaming: false,
  streamingText: '',
  aiResponse: null,
  inputText: '',
  elapsedTime: 0,
};

// ────────────────────────────────────────────────────────────────────
// Hook: useBridgeState
// ────────────────────────────────────────────────────────────────────

export interface BridgeState {
  /** Whether the bridge is connected and has received at least one snapshot. */
  connected: boolean;
  /** Current revision number from the last snapshot/patch. */
  revision: number;
  /** The current projected render state. */
  renderState: OverlayRenderState;
  /** Current overlay mode from projection. */
  mode: OverlayMode;
}

export interface BridgeActions {
  requestOverlayAction(action: OverlayAction): void;
  requestAI(action: AIAction): void;
  requestAudio(action: AudioAction): void;
  requestScreenCapture(action: ScreenCaptureAction): void;
  reportDragRegions(revision: number, regions: RegionRect[]): void;
  reportInteractiveRegions(revision: number, regions: RegionRect[]): void;
}

export interface UseBridgeResult {
  state: BridgeState;
  actions: BridgeActions;
}

/**
 * Hook that subscribes to the Stage C bridge adapter (`window.zuleOverlay`)
 * and provides projected state + intent actions.
 *
 * If the bridge is not available (e.g. running outside WebView2), the hook
 * returns disconnected state with defaults. This enables development/testing
 * of the overlay in a regular browser with mock data.
 */
export function useBridge(): UseBridgeResult {
  const [connected, setConnected] = useState(false);
  const [revision, setRevision] = useState(0);
  const [renderState, setRenderState] = useState<OverlayRenderState>(DEFAULT_RENDER_STATE);
  const [mode, setMode] = useState<OverlayMode>('compact');
  const bridgeRef = useRef<ZuleOverlayBridge | null>(null);

  useEffect(() => {
    const bridge = window.zuleOverlay;
    if (!bridge) {
      return;
    }

    bridgeRef.current = bridge;

    // Subscribe to state snapshots (full state replacement)
    bridge.onStateSnapshot((snapshot: OverlayStateSnapshot) => {
      setRevision(snapshot.revision);
      setRenderState(snapshot.render_state);
      setMode(snapshot.render_state.mode);
      setConnected(true);
    });

    // Subscribe to incremental patches
    bridge.onStatePatch((patch: OverlayStatePatch) => {
      setRevision(patch.next_revision);
      if (patch.mode) {
        setMode(patch.mode);
      }
      if (patch.render_state_patch) {
        setRenderState((prev) => ({
          ...prev,
          ...patch.render_state_patch,
        }));
        if (patch.render_state_patch.mode) {
          setMode(patch.render_state_patch.mode);
        }
      }
    });

    // Subscribe to operation results (intent acknowledgements)
    bridge.onOperationResult(() => {
      // Operation results can be used for optimistic update rollback
      // or confirmation UI. Currently a no-op placeholder.
    });
  }, []);

  // ── Intent actions ──

  const requestOverlayAction = useCallback((action: OverlayAction) => {
    bridgeRef.current?.requestOverlayAction(action);
  }, []);

  const requestAI = useCallback((action: AIAction) => {
    bridgeRef.current?.requestAI(action);
  }, []);

  const requestAudio = useCallback((action: AudioAction) => {
    bridgeRef.current?.requestAudio(action);
  }, []);

  const requestScreenCapture = useCallback((action: ScreenCaptureAction) => {
    bridgeRef.current?.requestScreenCapture(action);
  }, []);

  const reportDragRegions = useCallback((rev: number, regions: RegionRect[]) => {
    bridgeRef.current?.reportDragRegions(rev, regions);
  }, []);

  const reportInteractiveRegions = useCallback((rev: number, regions: RegionRect[]) => {
    bridgeRef.current?.reportInteractiveRegions(rev, regions);
  }, []);

  return {
    state: { connected, revision, renderState, mode },
    actions: {
      requestOverlayAction,
      requestAI,
      requestAudio,
      requestScreenCapture,
      reportDragRegions,
      reportInteractiveRegions,
    },
  };
}
