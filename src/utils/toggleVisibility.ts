// ============================================
// Zule AI — Toggle Visibility (pure function)
// ============================================
//
// A pure toggle function that models the symmetric show/hide behavior
// of the floating overlay. Used by the Ctrl+Shift+H shortcut.
//
// Property: toggle(toggle(x)) === x  (involution / symmetry)
// Validates: Requirement 12.4

/**
 * Toggle the hidden state of the overlay.
 * This is a pure involution: applying it twice returns to the original state.
 */
export function toggleVisibility(isHidden: boolean): boolean {
  return !isHidden;
}
