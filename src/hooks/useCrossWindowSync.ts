// ============================================
// Zule AI — Cross_Window_Sync v2
// ============================================
//
// Versioned, heartbeated cross-window state synchronisation with
// localStorage-event fallback when BroadcastChannel is unavailable.
//
// Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7

import { useEffect, useState, useCallback, useRef } from 'react';
import type { SyncMessage, SyncState, ClientAction } from '../types/sync';

// ─── Constants ───────────────────────────────────────────────────────────────

const CHANNEL_NAME = 'zule-copilot-sync';
const HEARTBEAT_INTERVAL_MS = 5_000;
const HOST_LOSS_TIMEOUT_MS = 15_000;
const LOCALSTORAGE_KEY = 'zule-sync-msg';

// ─── Pure helpers (exported for property tests) ──────────────────────────────

/**
 * Determines whether an incoming state-update message should be accepted.
 * Returns false when the incoming version is less than the last-applied version.
 *
 * @param lastAppliedVersion The most-recently applied version (receiver state).
 * @param incomingVersion The version carried by the incoming message.
 * @returns true if the message should be accepted; false if it should be rejected.
 *
 * Property (validates Requirement 11.1): For any sequence of version numbers,
 * a receiver that has applied version N rejects messages with version < N.
 */
export function shouldAcceptMessage(
  lastAppliedVersion: number,
  incomingVersion: number,
): boolean {
  return incomingVersion >= lastAppliedVersion;
}

/**
 * Determines whether the host should be considered lost based on the elapsed
 * time since the last heartbeat.
 *
 * @param lastHeartbeatAt The timestamp (ms) of the most-recent heartbeat received.
 * @param now The current timestamp (ms).
 * @param timeoutMs The host-loss detection threshold in milliseconds.
 * @returns true when the host is considered lost.
 *
 * Property (validates Requirement 11.3): After heartbeat interval * 3 (15000ms)
 * with no heartbeat message, the detached window transitions to 'host disconnected'.
 */
export function detectHostLoss(
  lastHeartbeatAt: number,
  now: number,
  timeoutMs: number = HOST_LOSS_TIMEOUT_MS,
): boolean {
  return now - lastHeartbeatAt > timeoutMs;
}

// ─── Transport abstraction ───────────────────────────────────────────────────

/**
 * A thin transport interface implemented by BroadcastChannel (primary) or
 * localStorage events (fallback). This enables testing without a real
 * BroadcastChannel and satisfies Requirement 11.4.
 */
interface SyncTransport {
  send(msg: SyncMessage): void;
  onMessage(cb: (msg: SyncMessage) => void): void;
  close(): void;
}

function createBroadcastChannelTransport(): SyncTransport {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  return {
    send(msg) {
      channel.postMessage(msg);
    },
    onMessage(cb) {
      channel.onmessage = (event) => {
        cb(event.data as SyncMessage);
      };
    },
    close() {
      channel.close();
    },
  };
}

function createLocalStorageTransport(): SyncTransport {
  let listener: ((msg: SyncMessage) => void) | null = null;

  const storageHandler = (event: StorageEvent) => {
    if (event.key !== LOCALSTORAGE_KEY || !event.newValue) return;
    try {
      const msg = JSON.parse(event.newValue) as SyncMessage;
      listener?.(msg);
    } catch {
      // Ignore malformed messages
    }
  };

  window.addEventListener('storage', storageHandler);

  return {
    send(msg) {
      // Write to localStorage; other tabs receive the `storage` event.
      // We append a nonce so that identical consecutive messages still fire.
      localStorage.setItem(
        LOCALSTORAGE_KEY,
        JSON.stringify(msg) + '|' + Date.now() + Math.random(),
      );
      // Immediately remove so we don't pollute storage
      localStorage.removeItem(LOCALSTORAGE_KEY);
    },
    onMessage(cb) {
      listener = cb;
    },
    close() {
      window.removeEventListener('storage', storageHandler);
      listener = null;
    },
  };
}

/**
 * Creates the appropriate transport based on browser capabilities.
 * Falls back to localStorage events when BroadcastChannel is unavailable
 * (Requirement 11.4).
 */
export function createTransport(): { transport: SyncTransport; isFallback: boolean } {
  if (typeof BroadcastChannel !== 'undefined') {
    return { transport: createBroadcastChannelTransport(), isFallback: false };
  }
  return { transport: createLocalStorageTransport(), isFallback: true };
}

// ─── Hook return types ───────────────────────────────────────────────────────

export interface CrossWindowSyncResult {
  /** The latest synced state (applicable to clients/detached). */
  state: Partial<SyncState>;
  /** Whether the transport is connected (host heartbeating). */
  isConnected: boolean;
  /** True if host was lost (no heartbeat for 15 s). */
  hostDisconnected: boolean;
  /** Broadcast a state update to the detached window (host only). */
  broadcastState: (newState: Partial<SyncState>) => void;
  /** Send an action from the detached window to the host (client only). */
  sendAction: (action: ClientAction) => void;
  /**
   * Legacy compatibility: sends a host-action with a string-based action name.
   * @deprecated Use `sendAction` with a typed `ClientAction` instead.
   */
  broadcastAction: (action: string, payload?: unknown) => void;
  /** Request a fresh snapshot from the host (client only). */
  requestSnapshot: () => void;
  /** Whether we fell back to localStorage transport. */
  isFallbackTransport: boolean;
}

// ─── Hook implementation ─────────────────────────────────────────────────────

/**
 * Cross_Window_Sync v2 React hook.
 *
 * @param role — 'host' for the main window, 'client' for the detached copilot.
 * @param initialState — Initial state for the client (optional).
 * @param onAction — Callback invoked on the host when the client sends an action.
 * @param onHostLoss — Callback invoked on the client when host loss is detected.
 */
export function useCrossWindowSync(
  role: 'host' | 'client',
  initialState?: Partial<SyncState>,
  onAction?: (action: ClientAction) => void,
  onHostLoss?: () => void,
): CrossWindowSyncResult {
  const [state, setState] = useState<Partial<SyncState>>(initialState || {});
  const [isConnected, setIsConnected] = useState(role === 'host');
  const [hostDisconnected, setHostDisconnected] = useState(false);
  const [isFallbackTransport, setIsFallbackTransport] = useState(false);

  const transportRef = useRef<SyncTransport | null>(null);
  const versionRef = useRef(0);
  const lastAppliedVersionRef = useRef(0);
  const lastHeartbeatRef = useRef(Date.now());
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hostLossTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onActionRef = useRef(onAction);
  const onHostLossRef = useRef(onHostLoss);

  // Keep refs up-to-date without re-running the effect
  onActionRef.current = onAction;
  onHostLossRef.current = onHostLoss;

  useEffect(() => {
    const { transport, isFallback } = createTransport();
    transportRef.current = transport;
    setIsFallbackTransport(isFallback);

    // ── Message handler ──────────────────────────────────────────────────

    transport.onMessage((msg: SyncMessage) => {
      switch (msg.kind) {
        case 'state-update': {
          if (role === 'client') {
            // Requirement 11.1: reject stale versions
            if (!shouldAcceptMessage(lastAppliedVersionRef.current, msg.version)) {
              return;
            }
            lastAppliedVersionRef.current = msg.version;
            setState(msg.payload);
            setIsConnected(true);
            setHostDisconnected(false);
          }
          break;
        }

        case 'snapshot-request': {
          // Host receives this from the client after the detached window opens
          if (role === 'host') {
            // Requirement 11.2: respond within 500 ms (synchronous post)
            const response: SyncMessage = {
              kind: 'snapshot-response',
              version: versionRef.current,
              payload: state as SyncState,
            };
            transport.send(response);
          }
          break;
        }

        case 'snapshot-response': {
          if (role === 'client') {
            if (!shouldAcceptMessage(lastAppliedVersionRef.current, msg.version)) {
              return;
            }
            lastAppliedVersionRef.current = msg.version;
            setState(msg.payload);
            setIsConnected(true);
            setHostDisconnected(false);
            lastHeartbeatRef.current = Date.now();
          }
          break;
        }

        case 'heartbeat': {
          if (role === 'client') {
            lastHeartbeatRef.current = msg.timestamp;
            setIsConnected(true);
            setHostDisconnected(false);
          }
          break;
        }

        case 'host-action': {
          if (role === 'host') {
            onActionRef.current?.(msg.action);
          }
          break;
        }
      }
    });

    // ── Host heartbeat emitter (Requirement 11.3) ──────────────────────────

    if (role === 'host') {
      heartbeatIntervalRef.current = setInterval(() => {
        versionRef.current += 1;
        const heartbeat: SyncMessage = {
          kind: 'heartbeat',
          version: versionRef.current,
          timestamp: Date.now(),
        };
        transport.send(heartbeat);
      }, HEARTBEAT_INTERVAL_MS);
    }

    // ── Client host-loss detector (Requirement 11.3, 11.6) ────────────────

    if (role === 'client') {
      lastHeartbeatRef.current = Date.now();

      hostLossTimerRef.current = setInterval(() => {
        if (detectHostLoss(lastHeartbeatRef.current, Date.now(), HOST_LOSS_TIMEOUT_MS)) {
          setIsConnected(false);
          setHostDisconnected(true);
          onHostLossRef.current?.();
        }
      }, 1_000); // Check every second
    }

    // ── Client requests snapshot on open (Requirement 11.2) ────────────────

    if (role === 'client') {
      const snapshotRequest: SyncMessage = {
        kind: 'snapshot-request',
        version: 0,
      };
      transport.send(snapshotRequest);
    }

    // ── Cleanup ─────────────────────────────────────────────────────────────

    return () => {
      transport.close();
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      if (hostLossTimerRef.current) {
        clearInterval(hostLossTimerRef.current);
        hostLossTimerRef.current = null;
      }
    };
  }, [role]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── broadcastState (host only) ──────────────────────────────────────────────

  const broadcastState = useCallback(
    (newState: Partial<SyncState>) => {
      if (role !== 'host' || !transportRef.current) return;
      versionRef.current += 1;
      const msg: SyncMessage = {
        kind: 'state-update',
        version: versionRef.current,
        payload: newState as SyncState,
      };
      transportRef.current.send(msg);
      // Keep local state in sync for snapshot replies
      setState(newState);
    },
    [role],
  );

  // ── sendAction (client only) ────────────────────────────────────────────────

  const sendAction = useCallback(
    (action: ClientAction) => {
      if (role !== 'client' || !transportRef.current) return;
      const msg: SyncMessage = {
        kind: 'host-action',
        version: 0,
        action,
      };
      transportRef.current.send(msg);
    },
    [role],
  );

  // ── requestSnapshot (client only) ──────────────────────────────────────────

  const requestSnapshot = useCallback(() => {
    if (role !== 'client' || !transportRef.current) return;
    const msg: SyncMessage = {
      kind: 'snapshot-request',
      version: 0,
    };
    transportRef.current.send(msg);
  }, [role]);

  // ── broadcastAction (legacy compatibility shim) ────────────────────────────

  const broadcastAction = useCallback(
    (action: string, payload?: unknown) => {
      if (role !== 'client' || !transportRef.current) return;
      // Map legacy string actions to the typed ClientAction union
      let clientAction: ClientAction;
      switch (action) {
        case 'TRIGGER_AI':
          clientAction = { kind: 'manual-submit', text: String(payload ?? '') };
          break;
        case 'STOP_SESSION':
          clientAction = { kind: 'stop-session' };
          break;
        case 'CHANGE_MODE':
          clientAction = { kind: 'change-mode', mode: payload as any };
          break;
        default:
          clientAction = { kind: 'manual-submit', text: String(payload ?? '') };
          break;
      }
      const msg: SyncMessage = {
        kind: 'host-action',
        version: 0,
        action: clientAction,
      };
      transportRef.current.send(msg);
    },
    [role],
  );

  return {
    state,
    isConnected,
    hostDisconnected,
    broadcastState,
    sendAction,
    broadcastAction,
    requestSnapshot,
    isFallbackTransport,
  };
}

// ─── Popup-blocked handler (Requirement 11.5) ─────────────────────────────────

/**
 * Opens the detached copilot window and handles the popup-blocked case.
 * When `window.open` returns null, surfaces a `cross-window.popup-blocked`
 * error via the provided notifyError callback and leaves the in-page overlay
 * visible.
 *
 * @param url The URL to open for the detached window.
 * @param features Window features string.
 * @param notifyError Callback to surface a ZuleError (from useZuleError).
 * @returns The opened window reference, or null if blocked.
 */
export function openDetachedWindow(
  url: string,
  features: string,
  notifyError: (e: { kind: 'cross-window.popup-blocked' }) => void,
): Window | null {
  const win = window.open(url, '_blank', features);
  if (!win) {
    // Requirement 11.5: surface recoverable error, leave overlay visible
    notifyError({ kind: 'cross-window.popup-blocked' });
    return null;
  }
  return win;
}
