// ============================================
// Zule AI — Model picker (replacement for <datalist>)
// ============================================
//
// Why this exists rather than `list={CUSTOM_MODEL_LIST_ID}` on the input:
//
// Chromium draws a `<datalist>` as a native popup the page cannot reach. It
// takes no styling, it decides its own height, and inside an Electron window
// its list does not answer the mouse wheel — so a gateway that serves three
// hundred model ids becomes a dropdown showing about eight of them with no
// scrollbar and no way to scroll. That is why the Load models button felt
// broken even on the runs where the request behind it succeeded.
//
// So the list is an ordinary element instead: a `role="listbox"` with a max
// height and `overflow-y: auto`. The wheel, a two-finger trackpad drag, a drag
// on the scrollbar and the arrow keys then all work, because the browser's own
// scrolling does the work rather than a native widget we cannot instrument.
//
// The input stays free text. Discovery is a convenience, never a gate: a model
// the gateway declines to list is still typeable, exactly as before.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';

import './ModelCombobox.css';

/**
 * Order `options` for `query`: ids that *start* with it first, then ids that
 * merely contain it, each group keeping the catalog's own (alphabetical) order.
 *
 * The split matters on a large gateway. Typing `haiku` against OpenRouter's
 * listing matches both `anthropic/claude-3-5-haiku` and a dozen community
 * fine-tunes with `haiku` buried mid-id; the prefix group puts the vendor's own
 * name for the model where the User is looking.
 *
 * Exported for the tests — the ranking is the part of this component with
 * behaviour worth pinning.
 */
export function rankModelOptions(options: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...options];

  const prefix: string[] = [];
  const contains: string[] = [];
  for (const option of options) {
    const at = option.toLowerCase().indexOf(needle);
    if (at === 0) prefix.push(option);
    else if (at > 0) contains.push(option);
  }
  return [...prefix, ...contains];
}

/**
 * Split `option` around the first case-insensitive occurrence of `query`, so the
 * matched run can be emphasised in place. `null` when there is nothing to mark.
 */
export function splitOnMatch(
  option: string,
  query: string,
): { before: string; match: string; after: string } | null {
  const needle = query.trim();
  if (needle.length === 0) return null;
  const at = option.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return null;
  return {
    before: option.slice(0, at),
    match: option.slice(at, at + needle.length),
    after: option.slice(at + needle.length),
  };
}

/** True for the `:free` suffix OpenRouter uses to mark a zero-cost route. */
function isFreeRoute(modelId: string): boolean {
  return /:free$/i.test(modelId);
}

export interface ModelComboboxProps {
  /** DOM id of the input; the label's `htmlFor` must match. */
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  maxLength: number;
  /**
   * Ids offered as completions. `null` before the catalog has been loaded — in
   * that state the field is a plain text input with no affordance to open,
   * because a dropdown arrow that opens an empty list is the defect this
   * component was written to remove.
   */
  options: readonly string[] | null;
  /** Applied to the wrapper, which is what the layout sizes. */
  className?: string;
  style?: CSSProperties;
}

export function ModelCombobox(props: ModelComboboxProps): JSX.Element {
  const { id, value, onChange, options } = props;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const catalog = options ?? [];
  const hasCatalog = catalog.length > 0;
  const matches = useMemo(() => rankModelOptions(catalog, value), [catalog, value]);

  // Clamped rather than reset in an effect: the filter narrows on every
  // keystroke, and an out-of-range highlight for one render would scroll the
  // list to nowhere.
  const active = matches.length === 0 ? -1 : Math.min(activeIndex, matches.length - 1);

  const commit = useCallback(
    (modelId: string) => {
      onChange(modelId);
      setOpen(false);
      inputRef.current?.focus();
    },
    [onChange],
  );

  // Dismiss on a press anywhere outside. Deliberately `pointerdown` on the
  // document rather than the input's `blur`: closing on blur would tear the
  // list down before the click that chose an option ever landed on it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as Node | null;
      if (node && wrapperRef.current?.contains(node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  // Keep the keyboard highlight inside the scroll window. `block: 'nearest'`
  // scrolls by the minimum needed, so arrowing through a long catalog moves the
  // list one row at a time instead of jumping it a page at a time.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    // Optional call: jsdom has no layout and therefore no `scrollIntoView`, and
    // an unscrollable highlight is not worth throwing out of an effect for.
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      // Only swallow the key when there is a list to close, so Escape still
      // reaches the Settings panel when the field is just a text input.
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (!hasCatalog) return;

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (!open) {
          setOpen(true);
          setActiveIndex(event.key === 'ArrowDown' ? 0 : Math.max(0, matches.length - 1));
          return;
        }
        if (matches.length === 0) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex(((active + step) % matches.length + matches.length) % matches.length);
        return;
      }
      case 'Home':
        if (open && matches.length > 0) {
          event.preventDefault();
          setActiveIndex(0);
        }
        return;
      case 'End':
        if (open && matches.length > 0) {
          event.preventDefault();
          setActiveIndex(matches.length - 1);
        }
        return;
      case 'Enter':
        // Enter only commits a highlighted row. With the list closed it is left
        // alone so it can still submit whatever the field sits inside.
        if (open && active >= 0) {
          event.preventDefault();
          commit(matches[active]);
        }
        return;
      default:
        return;
    }
  };

  const listId = `${id}-listbox`;

  return (
    <div
      ref={wrapperRef}
      className={`model-combobox ${open ? 'is-open' : ''} ${props.className ?? ''}`}
      style={props.style}
    >
      <input
        ref={inputRef}
        id={id}
        type="text"
        className="input-glass model-combobox-input"
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setActiveIndex(0);
          if (hasCatalog) setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
      />

      {hasCatalog && (
        <button
          type="button"
          className="model-combobox-toggle"
          onClick={() => {
            setActiveIndex(0);
            setOpen((wasOpen) => !wasOpen);
            inputRef.current?.focus();
          }}
          tabIndex={-1}
          aria-label={open ? 'Hide the model list' : `Show all ${catalog.length} models`}
          title={open ? 'Hide the model list' : `Show all ${catalog.length} models`}
        >
          <ChevronDown size={14} />
        </button>
      )}

      {open && hasCatalog && (
        <div className="model-combobox-panel" role="presentation">
          <div className="model-combobox-head">
            <span>
              {matches.length === catalog.length
                ? `${catalog.length} models`
                : `${matches.length} of ${catalog.length}`}
            </span>
            <span className="model-combobox-head-hint">↑↓ to move · ⏎ to pick</span>
          </div>

          {matches.length === 0 ? (
            <p className="model-combobox-empty">
              No listed model contains “{value.trim()}”. It will still be sent exactly as typed —
              this list is a shortcut, not a restriction.
            </p>
          ) : (
            <ul ref={listRef} id={listId} className="model-combobox-list" role="listbox">
              {matches.map((option, index) => {
                const parts = splitOnMatch(option, value);
                return (
                  <li
                    key={option}
                    id={`${id}-opt-${index}`}
                    className="model-combobox-option"
                    role="option"
                    aria-selected={option === value}
                    data-active={index === active}
                    title={option}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => commit(option)}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <span className="model-combobox-id">
                      {parts === null ? (
                        option
                      ) : (
                        <>
                          {parts.before}
                          <mark className="model-combobox-match">{parts.match}</mark>
                          {parts.after}
                        </>
                      )}
                    </span>
                    {isFreeRoute(option) && <span className="model-combobox-free">free</span>}
                    {option === value && (
                      <Check size={12} className="model-combobox-check" aria-hidden="true" />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
