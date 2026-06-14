import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useFocusTrap } from './focusTrap';

// Helper: create a container with focusable elements
function createContainer(focusableCount: number): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);

  for (let i = 0; i < focusableCount; i++) {
    const btn = document.createElement('button');
    btn.textContent = `Button ${i}`;
    container.appendChild(btn);
  }

  return container;
}

// Helper: simulate a keyboard event on the container
function fireKeyDown(
  target: HTMLElement,
  key: string,
  options: { shiftKey?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey: options.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe('useFocusTrap', () => {
  let container: HTMLDivElement;

  afterEach(() => {
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
  });

  it('traps Tab: wraps from last focusable element to first', () => {
    container = createContainer(3);
    const buttons = container.querySelectorAll('button');
    const ref = { current: container } as React.RefObject<HTMLElement>;

    renderHook(() => useFocusTrap({ containerRef: ref, enabled: true }));

    // Focus the last button
    (buttons[2] as HTMLElement).focus();
    expect(document.activeElement).toBe(buttons[2]);

    // Press Tab on the container — should wrap to first
    fireKeyDown(container, 'Tab');
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('traps Shift+Tab: wraps from first focusable element to last', () => {
    container = createContainer(3);
    const buttons = container.querySelectorAll('button');
    const ref = { current: container } as React.RefObject<HTMLElement>;

    renderHook(() => useFocusTrap({ containerRef: ref, enabled: true }));

    // Focus the first button
    (buttons[0] as HTMLElement).focus();
    expect(document.activeElement).toBe(buttons[0]);

    // Press Shift+Tab — should wrap to last
    fireKeyDown(container, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(buttons[2]);
  });

  it('does not trap when enabled=false', () => {
    container = createContainer(3);
    const buttons = container.querySelectorAll('button');
    const ref = { current: container } as React.RefObject<HTMLElement>;

    renderHook(() => useFocusTrap({ containerRef: ref, enabled: false }));

    // Focus the last button
    (buttons[2] as HTMLElement).focus();

    // Press Tab — should NOT trap (no preventDefault, no focus change by hook)
    const event = fireKeyDown(container, 'Tab');
    // The hook should not have called preventDefault
    expect(event.defaultPrevented).toBe(false);
  });

  it('releases trap immediately when enabled transitions to false', () => {
    container = createContainer(3);
    const buttons = container.querySelectorAll('button');
    const ref = { current: container } as React.RefObject<HTMLElement>;

    const { rerender } = renderHook(
      ({ enabled }) => useFocusTrap({ containerRef: ref, enabled }),
      { initialProps: { enabled: true } },
    );

    // Focus the last button and verify trap is active
    (buttons[2] as HTMLElement).focus();
    fireKeyDown(container, 'Tab');
    expect(document.activeElement).toBe(buttons[0]);

    // Disable the trap
    rerender({ enabled: false });

    // Focus the last button again
    (buttons[2] as HTMLElement).focus();

    // Press Tab — should NOT trap anymore
    const event = fireKeyDown(container, 'Tab');
    expect(event.defaultPrevented).toBe(false);
  });

  it('calls onEscape when Escape is pressed while trap is active', () => {
    container = createContainer(2);
    const ref = { current: container } as React.RefObject<HTMLElement>;
    const onEscape = vi.fn();

    renderHook(() =>
      useFocusTrap({ containerRef: ref, enabled: true, onEscape }),
    );

    fireKeyDown(container, 'Escape');
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it('does not call onEscape when trap is disabled', () => {
    container = createContainer(2);
    const ref = { current: container } as React.RefObject<HTMLElement>;
    const onEscape = vi.fn();

    renderHook(() =>
      useFocusTrap({ containerRef: ref, enabled: false, onEscape }),
    );

    fireKeyDown(container, 'Escape');
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('handles container with no focusable elements gracefully', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const ref = { current: container } as React.RefObject<HTMLElement>;

    renderHook(() => useFocusTrap({ containerRef: ref, enabled: true }));

    // Should not throw
    const event = fireKeyDown(container, 'Tab');
    expect(event.defaultPrevented).toBe(false);
  });

  it('handles dynamic content - focuses newly added elements', () => {
    container = createContainer(2);
    const buttons = container.querySelectorAll('button');
    const ref = { current: container } as React.RefObject<HTMLElement>;

    renderHook(() => useFocusTrap({ containerRef: ref, enabled: true }));

    // Add a new button dynamically
    const newBtn = document.createElement('button');
    newBtn.textContent = 'New Button';
    container.appendChild(newBtn);

    // Focus the new (now last) button
    newBtn.focus();
    expect(document.activeElement).toBe(newBtn);

    // Press Tab — should wrap to first
    fireKeyDown(container, 'Tab');
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('Tab focuses first element when active element is outside container', () => {
    container = createContainer(3);
    const buttons = container.querySelectorAll('button');
    const ref = { current: container } as React.RefObject<HTMLElement>;

    renderHook(() => useFocusTrap({ containerRef: ref, enabled: true }));

    // Active element is body (outside container)
    document.body.focus();

    // Press Tab — should focus first element in container
    fireKeyDown(container, 'Tab');
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('Shift+Tab focuses last element when active element is outside container', () => {
    container = createContainer(3);
    const buttons = container.querySelectorAll('button');
    const ref = { current: container } as React.RefObject<HTMLElement>;

    renderHook(() => useFocusTrap({ containerRef: ref, enabled: true }));

    // Active element is body (outside container)
    document.body.focus();

    // Press Shift+Tab — should focus last element in container
    fireKeyDown(container, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(buttons[2]);
  });
});
