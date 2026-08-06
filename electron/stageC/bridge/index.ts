/**
 * Stage C Bridge — Module Index
 *
 * Exports the authoritative native bridge and WebView2 content policy.
 *
 * Requirements: 7.4–7.15
 */

export {
  revalidatePageMessage,
  methodToIpcPayload,
  ipcToEventMessage,
  dispatchPageMessage,
  METHOD_TO_IPC_TYPE,
  IPC_TYPE_TO_EVENT,
  MAX_BRIDGE_REGIONS,
  MAX_ACTION_STRING_LENGTH,
  MAX_PARAMETERS_KEYS,
  EXPECTED_BRIDGE_VERSION,
  type NativeBridgeError,
  type NativeBridgeResult,
  type IntentIpcPayload,
  type DragRegionsIpcPayload,
  type IpcPayload,
  type BridgeDispatchResult,
} from './nativeBridge';

export {
  WebView2ContentPolicy,
  createContentPolicy,
  getContentPolicyIpcType,
  ContentPolicyEventType,
  PACKAGED_VIRTUAL_ORIGIN,
  type ContentPolicyDecision,
  type ContentPolicyConfig,
} from './contentPolicy';
