// ============================================
// Zule AI — Platform Keys Utility Tests
// ============================================

import { describe, it, expect, afterEach } from 'vitest';
import {
  getModifierKey,
  getAltKey,
  formatShortcut,
  getPlatform,
  getPlatformLimitations,
} from './platformKeys';

describe('platformKeys', () => {
  const originalElectronAPI = window.electronAPI;

  afterEach(() => {
    // Restore original state
    if (originalElectronAPI) {
      window.electronAPI = originalElectronAPI;
    } else {
      delete (window as unknown as Record<string, unknown>).electronAPI;
    }
  });

  describe('getModifierKey', () => {
    it('returns "Cmd" on darwin', () => {
      window.electronAPI = { platform: 'darwin' } as typeof window.electronAPI;
      expect(getModifierKey()).toBe('Cmd');
    });

    it('returns "Ctrl" on win32', () => {
      window.electronAPI = { platform: 'win32' } as typeof window.electronAPI;
      expect(getModifierKey()).toBe('Ctrl');
    });

    it('returns "Ctrl" on linux', () => {
      window.electronAPI = { platform: 'linux' } as typeof window.electronAPI;
      expect(getModifierKey()).toBe('Ctrl');
    });

    it('defaults to "Ctrl" when electronAPI is not available', () => {
      delete (window as unknown as Record<string, unknown>).electronAPI;
      expect(getModifierKey()).toBe('Ctrl');
    });
  });

  describe('getAltKey', () => {
    it('returns "Option" on darwin', () => {
      window.electronAPI = { platform: 'darwin' } as typeof window.electronAPI;
      expect(getAltKey()).toBe('Option');
    });

    it('returns "Alt" on win32', () => {
      window.electronAPI = { platform: 'win32' } as typeof window.electronAPI;
      expect(getAltKey()).toBe('Alt');
    });

    it('returns "Alt" on linux', () => {
      window.electronAPI = { platform: 'linux' } as typeof window.electronAPI;
      expect(getAltKey()).toBe('Alt');
    });

    it('defaults to "Alt" when electronAPI is not available', () => {
      delete (window as unknown as Record<string, unknown>).electronAPI;
      expect(getAltKey()).toBe('Alt');
    });
  });

  describe('formatShortcut', () => {
    it('formats shortcuts with Cmd on darwin', () => {
      window.electronAPI = { platform: 'darwin' } as typeof window.electronAPI;
      expect(formatShortcut('Mod+Shift+Space')).toBe('Cmd+Shift+Space');
    });

    it('preserves Ctrl on win32', () => {
      window.electronAPI = { platform: 'win32' } as typeof window.electronAPI;
      expect(formatShortcut('Mod+Shift+Space')).toBe('Ctrl+Shift+Space');
    });

    it('preserves Ctrl on linux', () => {
      window.electronAPI = { platform: 'linux' } as typeof window.electronAPI;
      expect(formatShortcut('Mod+Shift+Space')).toBe('Ctrl+Shift+Space');
    });

    it('handles multiple modifiers', () => {
      window.electronAPI = { platform: 'darwin' } as typeof window.electronAPI;
      expect(formatShortcut('Mod+Alt+Space')).toBe('Cmd+Option+Space');
    });
  });

  describe('getPlatform', () => {
    it('returns the platform from electronAPI', () => {
      window.electronAPI = { platform: 'darwin' } as typeof window.electronAPI;
      expect(getPlatform()).toBe('darwin');
    });

    it('defaults to win32 when electronAPI is unavailable', () => {
      delete (window as unknown as Record<string, unknown>).electronAPI;
      expect(getPlatform()).toBe('win32');
    });
  });

  describe('getPlatformLimitations', () => {
    it('returns empty array on win32', () => {
      window.electronAPI = { platform: 'win32' } as typeof window.electronAPI;
      expect(getPlatformLimitations()).toEqual([]);
    });

    it('returns empty array on darwin', () => {
      window.electronAPI = { platform: 'darwin' } as typeof window.electronAPI;
      expect(getPlatformLimitations()).toEqual([]);
    });

    it('returns limitations on linux', () => {
      window.electronAPI = { platform: 'linux' } as typeof window.electronAPI;
      const limitations = getPlatformLimitations();
      expect(limitations.length).toBeGreaterThan(0);

      // Should include content protection limitation
      const contentProtection = limitations.find((l) => l.feature === 'Content Protection');
      expect(contentProtection).toBeDefined();
      expect(contentProtection!.platform).toBe('Linux');

      // Should include global shortcuts limitation
      const shortcuts = limitations.find((l) => l.feature === 'Global Shortcuts (Wayland)');
      expect(shortcuts).toBeDefined();
      expect(shortcuts!.platform).toBe('Linux (Wayland)');

      // Should include workspace visibility limitation
      const workspaces = limitations.find((l) => l.feature === 'Visible on All Workspaces');
      expect(workspaces).toBeDefined();
    });
  });
});
