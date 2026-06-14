// src/overlay/zoneDetector.ts

/**
 * Zone classification for the overlay window.
 * - 'interactive': mouse events are captured by the overlay
 * - 'pass-through': mouse events fall through to the application below
 */
export type ZoneClassification = 'interactive' | 'pass-through';

/**
 * State used by the zone detector to determine classification overrides.
 */
export interface ZoneDetectorState {
  isDragging: boolean;
  isModalOpen: boolean;
  currentZone: ZoneClassification;
}

/**
 * Classify a point as interactive or pass-through based on the DOM element.
 *
 * Rules (in priority order):
 * 1. If isDragging → always 'interactive'
 * 2. If isModalOpen → always 'interactive'
 * 3. If element is null (no element under cursor) → 'pass-through'
 * 4. If element or any ancestor has [data-interactive-zone] → 'interactive'
 * 5. Otherwise → 'pass-through'
 *
 * Pure function given the element chain.
 */
export function classifyZone(
  element: Element | null,
  state: ZoneDetectorState,
): ZoneClassification {
  // Priority 1: Drag override — always interactive during drag
  if (state.isDragging) {
    return 'interactive';
  }

  // Priority 2: Modal override — always interactive when modal is open
  if (state.isModalOpen) {
    return 'interactive';
  }

  // Priority 3: No element under cursor — pass through
  if (element === null) {
    return 'pass-through';
  }

  // Priority 4: Check element and ancestors for [data-interactive-zone]
  if (hasInteractiveZoneMarker(element)) {
    return 'interactive';
  }

  // Priority 5: Default — pass through
  return 'pass-through';
}

/**
 * Walk up the DOM tree from the given element, checking if any node
 * has the [data-interactive-zone] attribute.
 */
function hasInteractiveZoneMarker(element: Element): boolean {
  let current: Element | null = element;
  while (current !== null) {
    if (current.hasAttribute('data-interactive-zone')) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

/**
 * Determines whether an IPC call should be emitted given previous and new zone.
 * Returns true only on state transition (deduplication).
 *
 * Consecutive identical classifications produce zero additional IPC calls.
 */
export function shouldEmitIPC(
  previousZone: ZoneClassification,
  newZone: ZoneClassification,
): boolean {
  return previousZone !== newZone;
}
