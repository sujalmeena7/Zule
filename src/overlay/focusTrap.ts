// src/overlay/focusTrap.ts
//
// Focus trap hook for the overlay window.
// Traps Tab/Shift+Tab within the overlay container when enabled,
// releases immediately when disabled (overlay hidden).
//
// Requirements: 13.4, 13.7

import { useEffect, useRef } from 'react';

export interface FocusTrapOptions {
  containerRef: React.RefObject<HTMLElement>;
  enabled: boolean;
  onEscape?: () => void;
}

/**
 * Selector for elements that are focusable via Tab navigation.
 * Covers buttons, inputs, textareas, selects, links with href,
 * and elements with a non-negative tabindex.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Get all focusable elements within a container, handling dynamic content.
 * Filters out elements that are explicitly hidden via `display:none` or
 * `visibility:hidden`, or have the `hidden` attribute.
 */
function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const elements = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  return elements.filter((el) => {
    // Skip elements with the hidden attribute
    if (el.hidden) {
      return false;
    }
    // Skip elements that are explicitly styled as not visible
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    return true;
  });
}

/**
 * React hook that traps Tab/Shift+Tab within the container when enabled.
 * Releases immediately when disabled (overlay hidden).
 *
 * - When `enabled=true`: Tab wraps from last focusable element back to first;
 *   Shift+Tab wraps from first back to last.
 * - When `enabled=false`: focus trap is released immediately, even if user
 *   was mid-interaction.
 * - Optional `onEscape` callback fired when Escape is pressed while trap is active.
 *
 * Handles dynamic content — queries focusable elements on each keydown rather
 * than caching, so elements appearing/disappearing from the DOM are handled.
 */
export function useFocusTrap(options: FocusTrapOptions): void {
  const { containerRef, enabled, onEscape } = options;

  // Store onEscape in a ref to avoid re-attaching the listener on every render
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!enabled) return;

    let rafId: number;
    let cleanupFn: (() => void) | null = null;

    const tryAttach = () => {
      const container = containerRef.current;
      if (!container) {
        rafId = requestAnimationFrame(tryAttach);
        return;
      }

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          onEscapeRef.current?.();
          return;
        }
        if (event.key !== 'Tab') return;

        const focusableElements = getFocusableElements(container);
        if (focusableElements.length === 0) return;

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];
        const activeElement = document.activeElement as HTMLElement | null;

        if (event.shiftKey) {
          if (activeElement === firstElement || !container.contains(activeElement)) {
            event.preventDefault();
            lastElement.focus();
          }
        } else {
          if (activeElement === lastElement || !container.contains(activeElement)) {
            event.preventDefault();
            firstElement.focus();
          }
        }
      };

      container.addEventListener('keydown', handleKeyDown);
      cleanupFn = () => container.removeEventListener('keydown', handleKeyDown);
    };

    tryAttach();

    return () => {
      cancelAnimationFrame(rafId);
      cleanupFn?.();
    };
  }, [enabled, containerRef]);
}
