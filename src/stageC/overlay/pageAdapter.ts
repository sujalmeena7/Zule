/**
 * Stage C Overlay — Frozen Page Adapter (`window.zuleOverlay`)
 *
 * Installs one frozen adapter on the page that exposes EXACTLY six reviewed
 * methods and three reviewed events. The adapter validates exact schemas and
 * enforces the 65,536-byte size limit BEFORE posting to the native bridge.
 *
 * Every capability traces to a current FloatingCopilot caller:
 *   - requestOverlayAction → FloatingCopilot mode/visibility/stealth/input actions
 *   - requestAI → FloatingCopilot AI trigger/stop/follow-up
 *   - requestAudio → FloatingCopilot system audio toggle
 *   - requestScreenCapture → FloatingCopilot screen capture trigger
 *   - reportDragRegions → FloatingCopilot drag handle reporting
 *   - reportInteractiveRegions → FloatingCopilot interactive area reporting
 *   - onStateSnapshot → FloatingCopilot full state sync
 *   - onStatePatch → FloatingCopilot incremental state update
 *   - onOperationResult → FloatingCopilot intent acknowledgement
 *
 * Provides ZERO access to:
 *   - Named pipes, launch credentials, process environment
 *   - Native handles, filesystem, registry, shell
 *   - Arbitrary network, process creation, App Core IPC
 *
 * Requirements: 7.1–7.10
 */

import type {
  ZuleOverlayBridge,
  OverlayStateSnapshot,
  OverlayStatePatch,
  OperationResult,
  OverlayAction,
  AIAction,
  AudioAction,
  ScreenCaptureAction,
  RegionRect,
} from './types';

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

/** Maximum bridge message size in bytes (Req 7.6). */
const MAX_BRIDGE_MESSAGE_BYTES = 65_536;

/** Maximum number of regions allowed per report (prevent abuse). */
const MAX_REGION_COUNT = 256;

// ────────────────────────────────────────────────────────────────────
// Schema Validation
// ────────────────────────────────────────────────────────────────────

/** Typed error returned when bridge validation fails (Req 7.9). */
export interface BridgeValidationError {
  code: 'SIZE_EXCEEDED' | 'INVALID_SCHEMA' | 'INVALID_TYPE' | 'INVALID_VALUE';
  message: string;
}


// Allowed overlay action types — traced to FloatingCopilot actions
const ALLOWED_OVERLAY_ACTION_TYPES: ReadonlySet<string> = new Set([
  'toggle-mode',
  'toggle-maximize',
  'set-mode',
  'toggle-visibility',
  'stop-session',
  'toggle-stealth',
  'set-input',
  'submit-input',
]);

// Allowed AI action types — traced to FloatingCopilot AI triggers
const ALLOWED_AI_ACTION_TYPES: ReadonlySet<string> = new Set([
  'trigger',
  'stop-generation',
  'follow-up',
]);

// Allowed audio action types — traced to FloatingCopilot audio toggle
const ALLOWED_AUDIO_ACTION_TYPES: ReadonlySet<string> = new Set([
  'toggle-system-audio',
]);

// Allowed screen capture action types — traced to FloatingCopilot capture trigger
const ALLOWED_SCREEN_CAPTURE_ACTION_TYPES: ReadonlySet<string> = new Set([
  'use-screen',
]);

// Allowed overlay modes
const ALLOWED_OVERLAY_MODES: ReadonlySet<string> = new Set([
  'compact',
  'expanded',
  'maximized',
]);

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function getByteLength(str: string): number {
  // TextEncoder gives the exact UTF-8 byte length
  return new TextEncoder().encode(str).byteLength;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasExactKeys(obj: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(obj);
  // All required keys must be present
  for (const key of required) {
    if (!(key in obj)) return false;
  }
  // No extra keys allowed
  for (const key of keys) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────
// Schema Validators — Exact field validation (Req 7.7)
// ────────────────────────────────────────────────────────────────────

function validateRegionRect(rect: unknown): rect is RegionRect {
  if (!isPlainObject(rect)) return false;
  if (!hasExactKeys(rect, ['left', 'top', 'width', 'height'])) return false;
  return (
    isFiniteNumber(rect.left) &&
    isFiniteNumber(rect.top) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height)
  );
}

function validateOverlayAction(action: unknown): action is OverlayAction {
  if (!isPlainObject(action)) return false;
  const type = action.type;
  if (typeof type !== 'string' || !ALLOWED_OVERLAY_ACTION_TYPES.has(type)) return false;

  switch (type) {
    case 'toggle-mode':
    case 'toggle-maximize':
    case 'toggle-visibility':
    case 'stop-session':
      return hasExactKeys(action, ['type']);
    case 'set-mode':
      return hasExactKeys(action, ['type', 'mode']) && typeof action.mode === 'string' && ALLOWED_OVERLAY_MODES.has(action.mode);
    case 'toggle-stealth':
      return hasExactKeys(action, ['type', 'enabled']) && typeof action.enabled === 'boolean';
    case 'set-input':
    case 'submit-input':
      return hasExactKeys(action, ['type', 'text']) && typeof action.text === 'string';
    default:
      return false;
  }
}

function validateAIAction(action: unknown): action is AIAction {
  if (!isPlainObject(action)) return false;
  const type = action.type;
  if (typeof type !== 'string' || !ALLOWED_AI_ACTION_TYPES.has(type)) return false;

  switch (type) {
    case 'trigger':
      return hasExactKeys(action, ['type'], ['query']) &&
        (action.query === undefined || typeof action.query === 'string');
    case 'stop-generation':
      return hasExactKeys(action, ['type']);
    case 'follow-up':
      return hasExactKeys(action, ['type', 'text']) && typeof action.text === 'string';
    default:
      return false;
  }
}

function validateAudioAction(action: unknown): action is AudioAction {
  if (!isPlainObject(action)) return false;
  const type = action.type;
  if (typeof type !== 'string' || !ALLOWED_AUDIO_ACTION_TYPES.has(type)) return false;
  return hasExactKeys(action, ['type']);
}

function validateScreenCaptureAction(action: unknown): action is ScreenCaptureAction {
  if (!isPlainObject(action)) return false;
  const type = action.type;
  if (typeof type !== 'string' || !ALLOWED_SCREEN_CAPTURE_ACTION_TYPES.has(type)) return false;
  return hasExactKeys(action, ['type']);
}

function validateRegions(regions: unknown): regions is RegionRect[] {
  if (!Array.isArray(regions)) return false;
  if (regions.length > MAX_REGION_COUNT) return false;
  return regions.every(validateRegionRect);
}


// ────────────────────────────────────────────────────────────────────
// Size Enforcement (Req 7.6)
// ────────────────────────────────────────────────────────────────────

/**
 * Enforces the 65,536-byte message size limit BEFORE posting.
 * Returns a validation error if the serialized message exceeds the limit.
 */
function enforceSizeLimit(message: unknown): BridgeValidationError | null {
  const json = JSON.stringify(message);
  const byteLength = getByteLength(json);
  if (byteLength > MAX_BRIDGE_MESSAGE_BYTES) {
    return {
      code: 'SIZE_EXCEEDED',
      message: `Message size ${byteLength} bytes exceeds limit of ${MAX_BRIDGE_MESSAGE_BYTES} bytes`,
    };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────
// Native Bridge Posting Interface
// ────────────────────────────────────────────────────────────────────

/**
 * The native message posting interface. In WebView2 this is typically
 * `window.chrome.webview.postMessage`. We abstract it for testability.
 */
export interface NativeBridgePort {
  postMessage(message: unknown): void;
}

// ────────────────────────────────────────────────────────────────────
// Page Adapter Factory
// ────────────────────────────────────────────────────────────────────

/**
 * Bridge message envelope sent to the native receiver.
 */
interface BridgeMessage {
  method: string;
  args: unknown;
}

/**
 * Creates and freezes the `window.zuleOverlay` page adapter.
 *
 * @param port - The native bridge post interface (defaults to chrome.webview)
 * @returns The frozen ZuleOverlayBridge instance
 */
export function createPageAdapter(port: NativeBridgePort): ZuleOverlayBridge {
  return createPageAdapterWithDispatch(port).adapter;
}

// ────────────────────────────────────────────────────────────────────
// Event Dispatch (native → page, called by the WebView2 message handler)
// ────────────────────────────────────────────────────────────────────

/**
 * Dispatches an incoming native event to the registered page callback.
 * This is called by the WebView2 message receive handler on the native side.
 *
 * We expose this through a module-scoped dispatch so the native side
 * can call into the event system without the page being able to
 * intercept or modify the dispatch mechanism.
 */
export interface PageAdapterDispatch {
  dispatchStateSnapshot(snapshot: OverlayStateSnapshot): void;
  dispatchStatePatch(patch: OverlayStatePatch): void;
  dispatchOperationResult(result: OperationResult): void;
}

/**
 * Creates the page adapter and its internal dispatch interface.
 * The adapter is frozen and installed on the window; the dispatch
 * is kept private for the native bridge message handler.
 */
export function createPageAdapterWithDispatch(port: NativeBridgePort): {
  adapter: ZuleOverlayBridge;
  dispatch: PageAdapterDispatch;
} {
  // Event subscriber storage (closure-scoped, not accessible from page)
  let snapshotCallback: ((snapshot: OverlayStateSnapshot) => void) | null = null;
  let patchCallback: ((patch: OverlayStatePatch) => void) | null = null;
  let operationResultCallback: ((result: OperationResult) => void) | null = null;

  function postValidated(method: string, args: unknown): void {
    const envelope: BridgeMessage = { method, args };
    const sizeError = enforceSizeLimit(envelope);
    if (sizeError) {
      throw sizeError;
    }
    port.postMessage(envelope);
  }

  // ── Intent Methods ──

  function requestOverlayAction(action: OverlayAction): void {
    if (!validateOverlayAction(action)) {
      throw { code: 'INVALID_SCHEMA', message: 'Invalid overlay action schema' } as BridgeValidationError;
    }
    postValidated('requestOverlayAction', action);
  }

  function requestAI(action: AIAction): void {
    if (!validateAIAction(action)) {
      throw { code: 'INVALID_SCHEMA', message: 'Invalid AI action schema' } as BridgeValidationError;
    }
    postValidated('requestAI', action);
  }

  function requestAudio(action: AudioAction): void {
    if (!validateAudioAction(action)) {
      throw { code: 'INVALID_SCHEMA', message: 'Invalid audio action schema' } as BridgeValidationError;
    }
    postValidated('requestAudio', action);
  }

  function requestScreenCapture(action: ScreenCaptureAction): void {
    if (!validateScreenCaptureAction(action)) {
      throw { code: 'INVALID_SCHEMA', message: 'Invalid screen capture action schema' } as BridgeValidationError;
    }
    postValidated('requestScreenCapture', action);
  }

  function reportDragRegions(revision: number, regions: RegionRect[]): void {
    if (!isFiniteNumber(revision) || revision < 0 || !Number.isInteger(revision)) {
      throw { code: 'INVALID_VALUE', message: 'Revision must be a non-negative integer' } as BridgeValidationError;
    }
    if (!validateRegions(regions)) {
      throw { code: 'INVALID_SCHEMA', message: 'Invalid drag regions schema' } as BridgeValidationError;
    }
    postValidated('reportDragRegions', { revision, regions });
  }

  function reportInteractiveRegions(revision: number, regions: RegionRect[]): void {
    if (!isFiniteNumber(revision) || revision < 0 || !Number.isInteger(revision)) {
      throw { code: 'INVALID_VALUE', message: 'Revision must be a non-negative integer' } as BridgeValidationError;
    }
    if (!validateRegions(regions)) {
      throw { code: 'INVALID_SCHEMA', message: 'Invalid interactive regions schema' } as BridgeValidationError;
    }
    postValidated('reportInteractiveRegions', { revision, regions });
  }

  // ── Event Subscriptions ──

  function onStateSnapshot(callback: (snapshot: OverlayStateSnapshot) => void): void {
    if (typeof callback !== 'function') {
      throw { code: 'INVALID_TYPE', message: 'Callback must be a function' } as BridgeValidationError;
    }
    snapshotCallback = callback;
  }

  function onStatePatch(callback: (patch: OverlayStatePatch) => void): void {
    if (typeof callback !== 'function') {
      throw { code: 'INVALID_TYPE', message: 'Callback must be a function' } as BridgeValidationError;
    }
    patchCallback = callback;
  }

  function onOperationResult(callback: (result: OperationResult) => void): void {
    if (typeof callback !== 'function') {
      throw { code: 'INVALID_TYPE', message: 'Callback must be a function' } as BridgeValidationError;
    }
    operationResultCallback = callback;
  }

  const adapter: ZuleOverlayBridge = {
    requestOverlayAction,
    requestAI,
    requestAudio,
    requestScreenCapture,
    reportDragRegions,
    reportInteractiveRegions,
    onStateSnapshot,
    onStatePatch,
    onOperationResult,
  };

  Object.freeze(adapter);

  const dispatch: PageAdapterDispatch = {
    dispatchStateSnapshot(snapshot: OverlayStateSnapshot) {
      snapshotCallback?.(snapshot);
    },
    dispatchStatePatch(patch: OverlayStatePatch) {
      patchCallback?.(patch);
    },
    dispatchOperationResult(result: OperationResult) {
      operationResultCallback?.(result);
    },
  };

  return { adapter, dispatch };
}

// ────────────────────────────────────────────────────────────────────
// Installation
// ────────────────────────────────────────────────────────────────────

/**
 * Installs `window.zuleOverlay` as a frozen, non-configurable, non-writable
 * property. Must be called exactly once during Stage C overlay bootstrap.
 *
 * @param port - The native bridge port (defaults to chrome.webview in WebView2)
 * @returns The dispatch interface for the native message handler
 */
export function installPageAdapter(port?: NativeBridgePort): PageAdapterDispatch {
  const resolvedPort: NativeBridgePort = port ?? getDefaultPort();
  const { adapter, dispatch } = createPageAdapterWithDispatch(resolvedPort);

  // Define as non-configurable, non-writable, non-enumerable property
  // so page code cannot delete or reassign window.zuleOverlay
  Object.defineProperty(window, 'zuleOverlay', {
    value: adapter,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  return dispatch;
}

/**
 * Returns the default WebView2 message port.
 * In WebView2, this is `window.chrome.webview`.
 */
function getDefaultPort(): NativeBridgePort {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webview = (window as any).chrome?.webview;
  if (!webview || typeof webview.postMessage !== 'function') {
    // Return a no-op port when not in WebView2 (development/testing)
    return { postMessage: () => {} };
  }
  return webview;
}

// ────────────────────────────────────────────────────────────────────
// Exported validation helpers (for testing)
// ────────────────────────────────────────────────────────────────────

export const _testing = {
  validateOverlayAction,
  validateAIAction,
  validateAudioAction,
  validateScreenCaptureAction,
  validateRegions,
  enforceSizeLimit,
  MAX_BRIDGE_MESSAGE_BYTES,
  MAX_REGION_COUNT,
};
