// ============================================
// Zule AI — ModelCombobox tests
// ============================================
//
// This component replaced a native `<datalist>` for one reason: the native popup
// could not be scrolled and could not be styled. So what is worth pinning is not
// the appearance but the three behaviours the native widget gave us for free and
// that a hand-written listbox can silently lose:
//
//   - the list is a real scroll container, so the wheel and the scrollbar work;
//   - the field stays free text, so a model the gateway does not list is still
//     usable — discovery is a convenience, never a gate;
//   - typing narrows the list without ever hiding the typed value.

import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ModelCombobox, rankModelOptions, splitOnMatch } from './ModelCombobox';

const CATALOG = [
  'anthropic/claude-3-5-haiku',
  'anthropic/claude-sonnet-4',
  'community/haiku-tuned-7b',
  'qwen/qwen3-vl-235b-a22b-instruct:free',
];

function renderCombobox(overrides: Partial<ComponentProps<typeof ModelCombobox>> = {}) {
  const onChange = vi.fn();
  const result = render(
    <ModelCombobox
      id="model-field"
      value=""
      onChange={onChange}
      placeholder="model id"
      maxLength={200}
      options={CATALOG}
      {...overrides}
    />,
  );
  return { onChange, ...result };
}

// --- rankModelOptions ----------------------------------------------------

describe('rankModelOptions', () => {
  it('puts prefix matches ahead of mid-id matches', () => {
    // Typing `haiku` on a large gateway matches both the vendor's own id and
    // community fine-tunes with `haiku` buried inside. Neither is wrong, but the
    // one the User meant is almost never the fine-tune.
    expect(rankModelOptions(['community/haiku-x', 'haiku-3-5'], 'haiku')).toEqual([
      'haiku-3-5',
      'community/haiku-x',
    ]);
  });

  it('matches case-insensitively and ignores surrounding space', () => {
    expect(rankModelOptions(CATALOG, '  HAIKU ')).toEqual([
      'anthropic/claude-3-5-haiku',
      'community/haiku-tuned-7b',
    ]);
  });

  it('returns the catalog untouched for an empty query', () => {
    expect(rankModelOptions(CATALOG, '   ')).toEqual(CATALOG);
  });

  it('returns nothing when no id contains the query', () => {
    expect(rankModelOptions(CATALOG, 'gpt-4o')).toEqual([]);
  });
});

// --- splitOnMatch --------------------------------------------------------

describe('splitOnMatch', () => {
  it("splits around the first match, preserving the id's own casing", () => {
    expect(splitOnMatch('anthropic/claude-3-5-HAIKU', 'haiku')).toEqual({
      before: 'anthropic/claude-3-5-',
      match: 'HAIKU',
      after: '',
    });
  });

  it('has nothing to mark for an empty query or a miss', () => {
    expect(splitOnMatch('a-model', '  ')).toBeNull();
    expect(splitOnMatch('a-model', 'zzz')).toBeNull();
  });
});

// --- The dropdown --------------------------------------------------------

describe('ModelCombobox', () => {
  it('offers no way to open the list before a catalog is loaded', () => {
    // A chevron that opens an empty panel is the defect this replaced.
    renderCombobox({ options: null });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens on the chevron and lists every model the gateway returned', () => {
    renderCombobox();
    fireEvent.click(screen.getByRole('button'));

    const rows = screen.getAllByRole('option');
    expect(rows.map((row) => row.textContent)).toEqual([
      'anthropic/claude-3-5-haiku',
      'anthropic/claude-sonnet-4',
      'community/haiku-tuned-7b',
      'qwen/qwen3-vl-235b-a22b-instruct:freefree',
    ]);
  });

  it('scrolls its own list rather than the page', () => {
    // The whole reason for this component: the list is an element in the document
    // with `max-height` + `overflow-y: auto` (see ModelCombobox.css), so the
    // wheel, a trackpad drag and a drag on the scrollbar are handled by the
    // browser. A native `<datalist>` popup is reachable by none of them. The
    // stylesheet is not loaded under jsdom, so what is asserted here is that the
    // list is a real `role="listbox"` element carrying the class those rules
    // hang off — the part a refactor could silently drop.
    renderCombobox();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox').className).toContain('model-combobox-list');
  });

  it('narrows the list as the User types, without touching what they typed', () => {
    const { onChange } = renderCombobox({ value: 'haiku' });
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getAllByRole('option').map((row) => row.textContent)).toEqual([
      'anthropic/claude-3-5-haiku',
      'community/haiku-tuned-7b',
    ]);
    expect(screen.getByRole('combobox')).toHaveProperty('value', 'haiku');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps a model the gateway never listed usable', () => {
    // Discovery is a convenience, never a gate. An id with no match must still
    // be typeable, and the panel has to say so rather than look broken.
    renderCombobox({ value: 'my-private-deployment' });
    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText(/still be sent exactly as typed/i)).toBeTruthy();
    expect(screen.getByRole('combobox')).toHaveProperty('value', 'my-private-deployment');
  });

  it('commits the clicked model', () => {
    const { onChange } = renderCombobox();
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('anthropic/claude-sonnet-4'));

    expect(onChange).toHaveBeenCalledWith('anthropic/claude-sonnet-4');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens, moves and commits from the keyboard', () => {
    const { onChange } = renderCombobox();
    const input = screen.getByRole('combobox');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('anthropic/claude-sonnet-4');
  });

  it('wraps past the last row and closes on Escape', () => {
    const { onChange } = renderCombobox();
    const input = screen.getByRole('combobox');

    // Up from a closed list lands on the last row; one more wraps to the first.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(CATALOG[0]);

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
