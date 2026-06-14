// ============================================
// Zule AI — Platform-Aware Shortcut Labels
// ============================================
//
// Utility module for rendering keyboard shortcut labels with
// the correct modifier key per platform (Ctrl on win32/linux,
// Cmd on darwin) and surfacing platform-specific limitations.

/**
 * Returns the primary modifier key label for the current platform.
 * Ctrl on Windows/Linux, Cmd (⌘) on macOS.
 */
export function getModifierKey(): string {
  const platform = window.electronAPI?.platform ?? 'win32';
  return platform === 'darwin' ? 'Cmd' : 'Ctrl';
}

/**
 * Returns the alt/option key label for the current platform.
 * Alt on Windows/Linux, Option on macOS.
 */
export function getAltKey(): string {
  const platform = window.electronAPI?.platform ?? 'win32';
  return platform === 'darwin' ? 'Option' : 'Alt';
}

/**
 * Format a shortcut string by replacing generic tokens with
 * platform-specific modifier labels.
 *
 * Tokens: `Mod` → Ctrl/Cmd, `Alt` → Alt/Option
 *
 * @example formatShortcut('Mod+Shift+H') → 'Ctrl+Shift+H' (on win32)
 * @example formatShortcut('Mod+Alt+0') → 'Cmd+Option+0' (on darwin)
 */
export function formatShortcut(combo: string): string {
  const mod = getModifierKey();
  const alt = getAltKey();
  return combo.replace(/\bMod\b/g, mod).replace(/\bAlt\b/g, alt);
}

/**
 * Returns the current platform identifier from the Electron bridge.
 * Falls back to 'win32' in web mode.
 */
export function getPlatform(): 'win32' | 'darwin' | 'linux' {
  return window.electronAPI?.platform ?? 'win32';
}

// ── Platform Limitations ──────────────────────────────────────────────────────

export interface PlatformLimitation {
  feature: string;
  platform: string;
  reason: string;
}

/**
 * Returns the list of known platform limitations for the current host OS.
 * Used to populate the settings panel's limitations section.
 *
 * Requirement 12.1: list every requirement-to-platform combination that is not
 * fully supported, naming the underlying API responsible.
 */
export function getPlatformLimitations(): PlatformLimitation[] {
  const platform = getPlatform();
  const limitations: PlatformLimitation[] = [];

  if (platform === 'linux') {
    limitations.push({
      feature: 'Content Protection',
      platform: 'Linux',
      reason: 'setContentProtection is a no-op on Linux (X11/Wayland). The overlay may appear in screen recordings.',
    });
    limitations.push({
      feature: 'Global Shortcuts (Wayland)',
      platform: 'Linux (Wayland)',
      reason: 'Global shortcuts may not register on Wayland compositors; in-window fallbacks are used when registration fails.',
    });
    limitations.push({
      feature: 'Visible on All Workspaces',
      platform: 'Linux',
      reason: 'Depends on window manager support for _NET_WM_STATE_STICKY hint. Some compositors may not honor this.',
    });
  }

  return limitations;
}
