// ============================================
// Zule AI — Keyboard Shortcuts Hook
// ============================================

import { useEffect, useCallback } from 'react';

export interface ShortcutConfig {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  action: () => void;
  description: string;
}

export function useKeyboardShortcuts(shortcuts: ShortcutConfig[]): void {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      for (const shortcut of shortcuts) {
        const ctrlMatch = shortcut.ctrl ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey);
        const shiftMatch = shortcut.shift ? e.shiftKey : !e.shiftKey;
        const altMatch = shortcut.alt ? e.altKey : !e.altKey;
        const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase();

        if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
          e.preventDefault();
          e.stopPropagation();
          shortcut.action();
          return;
        }
      }
    },
    [shortcuts]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

// Default shortcut definitions (actions are bound in the component)
export const SHORTCUT_DEFINITIONS = [
  { key: 'h', ctrl: true, shift: true, description: 'Toggle Hide/Show overlay' },
  { key: 'Enter', ctrl: true, description: 'Submit input to AI' },
  { key: 'm', ctrl: true, shift: true, description: 'Toggle microphone' },
  { key: 's', ctrl: true, shift: true, description: 'Toggle screen capture' },
  { key: 'Escape', description: 'Collapse overlay' },
  { key: '\\', ctrl: true, shift: true, description: 'Panic hide — hide overlay, mute mic, stop capture, pause AI' },
  { key: 'ArrowUp', ctrl: true, alt: true, description: 'Nudge overlay up' },
  { key: 'ArrowDown', ctrl: true, alt: true, description: 'Nudge overlay down' },
  { key: 'ArrowLeft', ctrl: true, alt: true, description: 'Nudge overlay left' },
  { key: 'ArrowRight', ctrl: true, alt: true, description: 'Nudge overlay right' },
  { key: '0', ctrl: true, alt: true, description: 'Recenter overlay' },
] as const;
