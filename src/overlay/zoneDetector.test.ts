import { describe, it, expect } from 'vitest';
import { classifyZone, shouldEmitIPC } from './zoneDetector';
import type { ZoneDetectorState } from './zoneDetector';

// --- Helper: create a minimal DOM-like element with optional data-interactive-zone ---

function createElement(options: {
  hasInteractiveZone?: boolean;
  parentHasInteractiveZone?: boolean;
} = {}): Element {
  const doc = new DOMParser().parseFromString('<div></div>', 'text/html');
  const parent = doc.createElement('div');
  const child = doc.createElement('span');
  parent.appendChild(child);
  doc.body.appendChild(parent);

  if (options.parentHasInteractiveZone) {
    parent.setAttribute('data-interactive-zone', '');
  }
  if (options.hasInteractiveZone) {
    child.setAttribute('data-interactive-zone', '');
  }

  return child;
}

function makeState(overrides: Partial<ZoneDetectorState> = {}): ZoneDetectorState {
  return {
    isDragging: false,
    isModalOpen: false,
    currentZone: 'pass-through',
    ...overrides,
  };
}

describe('classifyZone', () => {
  it('returns interactive when isDragging is true regardless of element', () => {
    const state = makeState({ isDragging: true });
    expect(classifyZone(null, state)).toBe('interactive');
    expect(classifyZone(createElement(), state)).toBe('interactive');
  });

  it('returns interactive when isModalOpen is true regardless of element', () => {
    const state = makeState({ isModalOpen: true });
    expect(classifyZone(null, state)).toBe('interactive');
    expect(classifyZone(createElement(), state)).toBe('interactive');
  });

  it('returns pass-through when element is null and no overrides', () => {
    const state = makeState();
    expect(classifyZone(null, state)).toBe('pass-through');
  });

  it('returns interactive when element has [data-interactive-zone]', () => {
    const state = makeState();
    const el = createElement({ hasInteractiveZone: true });
    expect(classifyZone(el, state)).toBe('interactive');
  });

  it('returns interactive when ancestor has [data-interactive-zone]', () => {
    const state = makeState();
    const el = createElement({ parentHasInteractiveZone: true });
    expect(classifyZone(el, state)).toBe('interactive');
  });

  it('returns pass-through when element has no interactive marker', () => {
    const state = makeState();
    const el = createElement();
    expect(classifyZone(el, state)).toBe('pass-through');
  });

  it('drag override takes priority over null element', () => {
    const state = makeState({ isDragging: true });
    expect(classifyZone(null, state)).toBe('interactive');
  });

  it('modal override takes priority over element without marker', () => {
    const state = makeState({ isModalOpen: true });
    const el = createElement();
    expect(classifyZone(el, state)).toBe('interactive');
  });

  it('isDragging takes priority over isModalOpen (both yield interactive)', () => {
    const state = makeState({ isDragging: true, isModalOpen: true });
    expect(classifyZone(null, state)).toBe('interactive');
  });
});

describe('shouldEmitIPC', () => {
  it('returns true when zones differ (interactive → pass-through)', () => {
    expect(shouldEmitIPC('interactive', 'pass-through')).toBe(true);
  });

  it('returns true when zones differ (pass-through → interactive)', () => {
    expect(shouldEmitIPC('pass-through', 'interactive')).toBe(true);
  });

  it('returns false when zones are the same (interactive → interactive)', () => {
    expect(shouldEmitIPC('interactive', 'interactive')).toBe(false);
  });

  it('returns false when zones are the same (pass-through → pass-through)', () => {
    expect(shouldEmitIPC('pass-through', 'pass-through')).toBe(false);
  });
});
