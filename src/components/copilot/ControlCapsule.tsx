// ============================================
// Zule AI — Control Capsule Sub-Component
// Cluely-style: Stealth toggle + Logo + Expand/Collapse + Stop
// ============================================

import type { RefCallback } from 'react';
import { Square, ChevronDown, Eye } from 'lucide-react';

/**
 * Chrome-style incognito glyph: fedora silhouette + round glasses.
 * Universally recognised as the "private / hidden mode" indicator,
 * which is unambiguous for the screen-capture stealth state — far
 * less confusing than a struck-through eye in this context.
 */
function IncognitoIcon({
  size = 14,
  strokeWidth = 2,
}: {
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* Fedora crown */}
      <path d="M5 13 C5 9, 7.5 6, 12 6 C16.5 6, 19 9, 19 13" />
      {/* Hat brim */}
      <path d="M3 13 L21 13" />
      {/* Left lens */}
      <circle cx="8" cy="17" r="2.5" />
      {/* Right lens */}
      <circle cx="16" cy="17" r="2.5" />
      {/* Bridge between lenses */}
      <path d="M10.5 17 L13.5 17" />
    </svg>
  );
}

interface ControlCapsuleProps {
  isHidden: boolean;
  onToggleHidden: () => void;
  onStop: () => void;
  handleRef: RefCallback<HTMLElement>;
  /** Optional: current overlay mode for compact/expanded toggle */
  overlayMode?: 'compact' | 'expanded' | 'maximized';
  /** Optional: callback when mode toggle chevron is clicked */
  onToggleMode?: () => void;
  /** Optional: current screen-capture stealth state. When true, the
   *  overlay is invisible to screen recorders / screen-share APIs. */
  isStealth?: boolean;
  /** Optional: callback when the stealth segmented toggle is clicked.
   *  Receives the new desired stealth state (the inverse of `isStealth`). */
  onToggleStealth?: (enabled: boolean) => void;
  /** Optional: callback to fully hide the overlay window from the screen.
   *  The user brings it back via the global shortcut (Ctrl+Shift+H). */
  onHideWindow?: () => void;
}

export function ControlCapsule({
  isHidden,
  onToggleHidden,
  onStop,
  handleRef,
  overlayMode,
  onToggleMode,
  isStealth,
  onToggleStealth,
}: ControlCapsuleProps) {
  // Use overlay mode toggle if provided, otherwise fall back to hide/show toggle
  const handleChevronClick = onToggleMode ?? onToggleHidden;
  const chevronLabel = onToggleMode
    ? (overlayMode === 'compact' ? 'Expand overlay' : 'Collapse overlay')
    : (isHidden ? 'Show suggestion panel' : 'Hide suggestion panel');
  const chevronRotated = onToggleMode
    ? overlayMode === 'compact'
    : isHidden;
  const chevronText = onToggleMode
    ? (overlayMode === 'compact' ? 'Expand' : 'Collapse')
    : (isHidden ? 'Show' : 'Hide');

  // Stealth toggle: a single pill-shaped button that swaps between Eye
  // (visible) and EyeOff (stealth) using a vertical slide+fade transition.
  // Both icons are rendered; CSS reveals one and hides the other based on
  // the `is-stealth` / `is-visible` class on the button. The active icon
  // sits at translateY(0) opacity 1; the inactive icon is parked above
  // (translateY(-8px)) or below (translateY(8px)) and faded out.
  const stealthEnabled = isStealth ?? true;
  const stealthLabel = stealthEnabled
    ? 'Make Zule visible to screen share'
    : 'Make Zule invisible to screen share';

  return (
    <div className="control-capsule" ref={handleRef}>
      {onToggleStealth && (
        <button
          type="button"
          className={`capsule-stealth-toggle ${stealthEnabled ? 'is-stealth' : 'is-visible'}`}
          onClick={() => onToggleStealth(!stealthEnabled)}
          aria-label={stealthLabel}
          aria-pressed={stealthEnabled}
          title={stealthLabel}
        >
          {/* Both icons rendered; CSS picks which one is currently in
              the visible slot. Each icon transitions opacity + translateY
              with the same Material easing as the rest of the overlay. */}
          <span className="stealth-icon stealth-icon-eye" aria-hidden="true">
            <Eye size={14} strokeWidth={2.25} />
          </span>
          <span className="stealth-icon stealth-icon-eyeoff" aria-hidden="true">
            <IncognitoIcon size={14} strokeWidth={1.85} />
          </span>
        </button>
      )}

      <div className="capsule-logo">
        <img src="./favicon.svg" alt="Zule AI" />
      </div>

      <button
        className="capsule-hide-btn"
        onClick={handleChevronClick}
        aria-label={chevronLabel}
      >
        <ChevronDown
          size={14}
          className={`chevron-icon ${chevronRotated ? 'rotated' : ''}`}
        />
        <span className="capsule-hide-label">{chevronText}</span>
      </button>

      <button className="capsule-stop-btn" onClick={onStop} aria-label="Stop session">
        <Square size={12} fill="currentColor" />
      </button>
    </div>
  );
}
