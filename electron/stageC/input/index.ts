/**
 * Stage C Input Module — Barrel export
 *
 * Requirements: 10.1–10.16, 11.1–11.13
 */

export {
  // Types
  PointerEventType,
  PointerButton,
  KeyboardEventType,
  KeyCategory,
  ImeEventType,
  FocusDirection,
  InputRoutingMethod,
  MOVE_FOCUS_REASON,
  MAX_COORDINATE_ERROR_PX,
  WM,

  // Interfaces
  type PointerEvent,
  type WheelEvent,
  type KeyboardEvent,
  type ImeEvent,
  type FocusEvent,
  type ModifierState,
  type InputRouteResult,
  type InputRouter,
  type InputRouterDeps,

  // Functions
  validatePointerOrder,
  validateCoordinateError,
  validateWheelDelta,
  decodeWheelDeltaFromWParam,
  decodeClientCoordinates,
  classifyKey,
  getKeyboardRoutingMethod,
  getImeRoutingMethod,
  getFocusRoutingMethod,
  createInputRouter,
} from './inputRouter';

export {
  // Constants
  NCHITTEST,
  MAX_REGIONS_PER_TYPE,

  // Types
  type HitTestCode,
  type DipRect,
  type RegionMap,
  type HitTestResult,
  type RegionValidationResult,
  type RegionCacheDeps,

  // Functions
  validateRect,
  validateRegionMap,
  physicalToDip,
  dipRectToPhysical,
  hitTest,

  // Classes
  RegionMapCache,
} from './hitTest';

export {
  // Constants
  BASE_DPI,
  MAX_EDGE_ERROR_PX,

  // Types
  TopologyDegradation,
  type PhysicalRect,
  type DipRectEdges,
  type MonitorInfo,
  type TopologyValidationResult,
  type DpiChangeContext,
  type DpiChangeResult,
  type GeometryOperation,
  type GeometryTarget,

  // Functions
  dipEdgesToPhysical,
  physicalEdgesToDip,
  applyDpiChange,
  validateTopology,
  operationToPhysical,
  edgesMatchWithinTolerance,
} from './geometry';
