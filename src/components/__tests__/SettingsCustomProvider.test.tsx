// ============================================
// Zule AI — Settings_Provider_Panel: Custom (OpenAI-compatible) provider
// ============================================
//
// Feature: custom-openai-compatible-provider
//
// DOM-level tests for the custom provider row rendered by `Settings.tsx`.
// The design's Testing Strategy puts Properties 2, 6, and 15 here, against
// `@testing-library/react` — so this file opens with a shared harness
// (context/toast/secure-storage stubs, a fake-IndexedDB reset, and a render
// helper) and adds one top-level `describe` per property below it.
//
// Harness notes:
// - `@huggingface/transformers` is stubbed because `Settings.tsx` pulls in
//   `vectorStore` (→ `transformersEnv`); the ONNX runtime never has to load.
// - `ZuleContext` / `SubscriptionContext` are stubbed rather than wrapped in
//   real providers: the panel only reads a handful of fields from each, and the
//   real providers reach for Firebase.
// - Secure_Key_Storage is an in-memory `Map` keyed by a fake cipher prefix
//   (design §Testing Strategy), so nothing touches Electron `safeStorage`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import { createElement } from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';

// ─── Module stubs (hoisted) ──────────────────────────────────────────────────

vi.mock('@huggingface/transformers', () => ({
  env: {
    allowLocalModels: false,
    allowRemoteModels: true,
    useBrowserCache: true,
    localModelPath: '',
    backends: { onnx: { wasm: {} } },
  },
  pipeline: vi.fn(),
}));

const toastMock = vi.hoisted(() => {
  const fn = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(),
  });
  return fn;
});
vi.mock('react-hot-toast', () => ({
  default: toastMock,
  toast: toastMock,
  Toaster: () => null,
}));

/**
 * In-memory Secure_Key_Storage double. `encryptApiKey` hands back an opaque
 * `test-cipher:<n>` token; `decryptApiKey` resolves it through the map. A
 * `throws` mode is available for the Requirement 3.10 path (Property 5).
 */
const secureKeyStore = vi.hoisted(() => {
  const ciphers = new Map<string, string>();
  return {
    ciphers,
    mode: { value: 'ok' as 'ok' | 'throws' | 'plain' },
    reset() {
      ciphers.clear();
      this.mode.value = 'ok';
    },
  };
});

vi.mock('../../utils/secureKeyStorage', () => ({
  encryptApiKey: vi.fn(async (plaintext: string) => {
    if (secureKeyStore.mode.value === 'throws') {
      throw new Error('safeStorage unavailable');
    }
    if (secureKeyStore.mode.value === 'plain') return `plain:${plaintext}`;
    const cipher = `test-cipher:${secureKeyStore.ciphers.size + 1}`;
    secureKeyStore.ciphers.set(cipher, plaintext);
    return cipher;
  }),
  decryptApiKey: vi.fn(async (cipher: string) => {
    if (cipher.startsWith('plain:')) return cipher.slice('plain:'.length);
    return secureKeyStore.ciphers.get(cipher) ?? '';
  }),
}));

vi.mock('../../context/ZuleContext', () => ({
  useZule: () => ({
    state: { apiKey: '', theme: 'dark', customModes: [] },
    actions: {
      updateApiKey: vi.fn(),
      updateTheme: vi.fn(),
      saveCustomMode: vi.fn(),
      deleteCustomMode: vi.fn(),
    },
  }),
}));

vi.mock('../../context/SubscriptionContext', () => ({
  useSubscription: () => ({
    limits: { kbDocuments: 100, customModes: 100 },
    upgradeTo: vi.fn(),
  }),
}));

// Imported after the mocks so the stubbed modules are the ones bound.
import { Settings } from '../Settings';
import { database, __resetDatabaseForTests, type ProviderConfig } from '../../data/database';
import { decryptApiKey } from '../../utils/secureKeyStorage';
import {
  CUSTOM_PROVIDER_ID,
  CUSTOM_PROVIDER_LABEL,
  MAX_API_KEY_LENGTH,
  MAX_MODEL_ID_LENGTH,
  type CustomField,
} from '../../brain/providers/customProviderConfig';
import { MAX_BASE_URL_LENGTH, normalizeBaseUrl } from '../../brain/providers/endpointValidator';

// ─── Shared harness ──────────────────────────────────────────────────────────

/** DOM ids of the three custom-provider controls, with their field maxima. */
const CUSTOM_FIELDS: ReadonlyArray<{
  field: CustomField;
  inputId: string;
  max: number;
}> = [
  { field: 'baseUrl', inputId: 'custom-provider-base-url', max: MAX_BASE_URL_LENGTH },
  { field: 'apiKey', inputId: 'custom-provider-api-key', max: MAX_API_KEY_LENGTH },
  { field: 'modelId', inputId: 'custom-provider-model-id', max: MAX_MODEL_ID_LENGTH },
];

/** Fresh IDB factory per test so persisted settings never bleed across cases. */
function resetIndexedDB(): void {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  __resetDatabaseForTests();
}

/** Let the panel's chain of async IndexedDB load effects settle. */
async function flushEffects(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * Mount the Settings screen and wait until the custom provider row is on
 * screen. When `seed` is supplied it is written to the `providers` setting
 * first, so the panel loads it the way a returning User would.
 */
async function renderSettings(seed?: ProviderConfig[]): Promise<void> {
  if (seed) await database.setSetting('providers', seed);
  render(createElement(Settings));
  await flushEffects();
}

/** The live `<input>` for one custom field. */
function customInput(inputId: string): HTMLInputElement {
  const el = document.getElementById(inputId);
  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`custom provider input #${inputId} is not rendered`);
  }
  return el;
}

beforeEach(() => {
  resetIndexedDB();
  secureKeyStore.reset();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

// ─── Generators ──────────────────────────────────────────────────────────────

/**
 * BMP characters only — no lone surrogates, and deliberately no CR/LF, because
 * a single-line `<input>`'s value sanitisation strips newlines and would mask
 * the clamping behaviour under test.
 */
const VALUE_CHARS = 'abzAZ09 -_/:.?&=%@#~+é漢•'.split('');

/**
 * Lengths that straddle the field maximum: a broad band, a tight window around
 * the boundary itself (max-2 … max+2), and a deliberately huge paste.
 */
const lengthArb = (max: number): fc.Arbitrary<number> =>
  fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: 0, max: max + 4 }) },
    { weight: 4, arbitrary: fc.integer({ min: Math.max(0, max - 2), max: max + 2 }) },
    { weight: 2, arbitrary: fc.integer({ min: max + 1, max: max * 2 + 37 }) },
  );

/**
 * A string of an exactly-generated length, tiled from a short random seed.
 * Tiling keeps generation cheap at 4000+ characters while still varying the
 * character mix run to run.
 */
const valueArb = (max: number): fc.Arbitrary<string> =>
  fc
    .tuple(
      lengthArb(max),
      fc.stringOf(fc.constantFrom(...VALUE_CHARS), { minLength: 1, maxLength: 24 }),
    )
    .map(([length, seed]) => {
      if (length === 0) return '';
      return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
    });

/** One (field, raw value) pair, with the value sized against that field's max. */
const fieldAndValueArb = fc
  .constantFrom(...CUSTOM_FIELDS)
  .chain((spec) => valueArb(spec.max).map((value) => ({ spec, value })));

// ─── Property 2 ──────────────────────────────────────────────────────────────

// Feature: custom-openai-compatible-provider, Property 2: Input length clamping
describe('Property 2: Input length clamping', () => {
  /**
   * **Validates: Requirements 1.2**
   *
   * For any string `s` and any field in `{baseUrl, apiKey, modelId}`, the value
   * committed by the Settings_Provider_Panel change handler is a prefix of `s`
   * whose length is at most the field maximum (2048, 512, 200), and equals `s`
   * exactly when `s.length` is within that maximum.
   *
   * The change event is dispatched with the raw value rather than typed key by
   * key: `maxLength` is a UA courtesy that a paste or a programmatic set can
   * walk straight past, so the assertion has to observe what `clampField`
   * commits, not what the attribute advertises.
   */
  it('commits a bounded prefix of any raw input for every custom field', async () => {
    await renderSettings();

    // The attribute is the first line of defence and is asserted once here;
    // the property below covers the handler that actually enforces the bound.
    for (const { inputId, max } of CUSTOM_FIELDS) {
      expect(customInput(inputId).maxLength).toBe(max);
    }

    fc.assert(
      fc.property(fieldAndValueArb, ({ spec, value }) => {
        const input = customInput(spec.inputId);

        fireEvent.change(input, { target: { value } });

        const committed = customInput(spec.inputId).value;

        // Bounded by the field maximum…
        expect(committed.length).toBeLessThanOrEqual(spec.max);
        // …a prefix of the raw input…
        expect(value.startsWith(committed)).toBe(true);
        expect(committed).toBe(value.slice(0, spec.max));
        // …and untouched when it already fits.
        if (value.length <= spec.max) {
          expect(committed).toBe(value);
        }
      }),
      { numRuns: 100 },
    );
    // 100 fast-check runs, each a React change event re-rendering the whole
    // Settings panel under jsdom, run ~12s — past vitest's 5000ms default
    // per-test timeout (cf. Properties 5, 6 and 15).
  }, 60_000);
});
// ─── Property 6 ──────────────────────────────────────────────────────────────

/** The masked placeholder the panel shows once a cipher exists (design §10). */
const CUSTOM_KEY_SAVED_PLACEHOLDER = '•••••••••••• (saved — leave blank to keep)';

/** A valid draft for the two non-secret fields, held constant across runs. */
const VALID_BASE_URL = 'https://gateway.example.test/v1';
const VALID_MODEL_ID = 'gw/model-alpha';

/**
 * Characters real gateway keys are drawn from. Deliberately excludes the
 * punctuation that shows up in the persisted JSON's structural text, so a
 * substring hit on the serialised row means a leak and not a coincidence.
 */
const KEY_CHARS =
  'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_'.split('');

/**
 * An API_Key sized across the permitted range, up to and including the 512
 * character maximum. The lower bound is 8 rather than 1: a one-character key is
 * a substring of almost any JSON document (`"true"`, `"custom"`, a priority
 * digit), so a plaintext-exclusion assertion below that length would report
 * incidental collisions rather than credential leaks — and `scrubSecret` draws
 * the same line for the same reason.
 */
const apiKeyArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.oneof(
      { weight: 5, arbitrary: fc.integer({ min: 8, max: 48 }) },
      { weight: 3, arbitrary: fc.integer({ min: 49, max: MAX_API_KEY_LENGTH }) },
      { weight: 2, arbitrary: fc.constant(MAX_API_KEY_LENGTH) },
    ),
    fc.stringOf(fc.constantFrom(...KEY_CHARS), { minLength: 8, maxLength: 32 }),
  )
  .map(([length, seed]) => {
    const body = seed.repeat(Math.ceil((length + 3) / seed.length));
    return `sk-${body}`.slice(0, length);
  });

/** The "Save Provider Config" button, whatever its transient label. */
function saveProvidersButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find((el) => {
    const label = (el.textContent ?? '').trim();
    return label === 'Save Provider Config' || label === 'Saving...';
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('the "Save Provider Config" button is not rendered');
  }
  return button;
}

/** Click save and let the encrypt → validate → persist chain settle. */
async function clickSaveProviders(): Promise<void> {
  await act(async () => {
    fireEvent.click(saveProvidersButton());
  });
  await flushEffects(3);
}

/** The `providers` row exactly as it sits in IndexedDB. */
async function readPersistedProviders(): Promise<ProviderConfig[]> {
  return database.getSetting<ProviderConfig[]>('providers', []);
}

// Feature: custom-openai-compatible-provider, Property 6: The API_Key is persisted only as ciphertext, and a blank save retains it
describe('Property 6: The API_Key is persisted only as ciphertext, and a blank save retains it', () => {
  /**
   * **Validates: Requirements 1.9, 1.10, 3.1**
   *
   * For any API_Key of up to 512 characters, after a save every string field of
   * the persisted Custom_Provider_Config excludes the plaintext key, the stored
   * cipher decrypts back to the key, and a subsequent save performed with an
   * empty API_Key input leaves the stored cipher unchanged while rendering no
   * character of the key in the API_Key control.
   *
   * The exclusion clause is asserted against `JSON.stringify` of the whole
   * persisted row rather than a named field, so a leak into *any* field —
   * `baseUrl`, `modelId`, a stray draft copy — is caught.
   *
   * One mount serves every run: the panel is the system under test and its
   * post-save state (cleared input, masked placeholder, recorded cipher) is
   * exactly what the second half of the property inspects, so re-mounting
   * between runs would test a different flow than the one Requirement 1.10
   * describes.
   */
  it('persists only ciphertext and keeps it across a blank re-save', async () => {
    await renderSettings();

    fireEvent.change(customInput('custom-provider-base-url'), {
      target: { value: VALID_BASE_URL },
    });
    fireEvent.change(customInput('custom-provider-model-id'), {
      target: { value: VALID_MODEL_ID },
    });

    await fc.assert(
      fc.asyncProperty(apiKeyArb, async (apiKey) => {
        // ── Save with a key entered ───────────────────────────────────────
        fireEvent.change(customInput('custom-provider-api-key'), {
          target: { value: apiKey },
        });
        await clickSaveProviders();

        const persisted = await readPersistedProviders();
        const saved = persisted.find((entry) => entry.id === CUSTOM_PROVIDER_ID);
        expect(saved).toBeDefined();

        // Requirement 1.9 / 3.1: a cipher is stored…
        const cipher = saved?.apiKeyCipher;
        expect(typeof cipher).toBe('string');
        expect((cipher ?? '').length).toBeGreaterThan(0);
        // …it round-trips to the key…
        await expect(decryptApiKey(cipher ?? '')).resolves.toBe(apiKey);
        // …and no field anywhere in the row holds the plaintext.
        expect(JSON.stringify(persisted)).not.toContain(apiKey);

        // The control is cleared and masked, so nothing of the key is on screen.
        const keyInput = customInput('custom-provider-api-key');
        expect(keyInput.value).toBe('');
        expect(keyInput.placeholder).toBe(CUSTOM_KEY_SAVED_PLACEHOLDER);

        // ── Save again with the key field left blank ──────────────────────
        await clickSaveProviders();

        const rePersisted = await readPersistedProviders();
        const reSaved = rePersisted.find((entry) => entry.id === CUSTOM_PROVIDER_ID);

        // Requirement 1.10: the stored cipher survives a blank save…
        expect(reSaved?.apiKeyCipher).toBe(cipher);
        // …still without any plaintext, and still masked.
        expect(JSON.stringify(rePersisted)).not.toContain(apiKey);
        expect(customInput('custom-provider-api-key').value).toBe('');
      }),
      { numRuns: 100 },
    );
    // 100 fast-check runs × two full save cycles through jsdom + fake-indexeddb
    // run ~12s, well past vitest's 5000ms default per-test timeout.
  }, 120_000);
});

// ─── Property 15 ─────────────────────────────────────────────────────────────

/** The eye / eye-off button that sits beside the custom API_Key control. */
function customKeyToggleButton(): HTMLButtonElement {
  const wrapper = customInput('custom-provider-api-key').closest('.api-key-input');
  const button = wrapper?.querySelector('button.key-toggle');
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('the custom provider key reveal toggle is not rendered');
  }
  return button;
}

/** How many times the reveal control is clicked in one run — both parities. */
const toggleClickCountArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 7 });

// Feature: custom-openai-compatible-provider, Property 15: The reveal toggle is a round trip over masking
describe('Property 15: The reveal toggle is a round trip over masking', () => {
  /**
   * **Validates: Requirements 3.5, 3.6**
   *
   * For any API_Key text in the custom API_Key control and any number of
   * reveal-toggle clicks: the control is masked after an even number of clicks
   * and unmasked after an odd number, the typed value is unchanged by
   * toggling, and the button's accessible label tracks the state.
   *
   * jsdom lays out no glyphs, so "presents every character as the same uniform
   * masking character" is checked through its machine-observable equivalent:
   * `input.type === 'password'`, which is what makes a UA mask the value
   * uniformly. The companion clause — that no *rendered text* carries the typed
   * value — is checked against `document.body.textContent`, which holds the
   * panel's text nodes but not an `<input>`'s live value.
   *
   * Toggling twice returning to the start state falls out of the parity
   * assertion: the run normalises to the masked state, then every even click
   * count is asserted masked and every odd one unmasked, so state after `k + 2`
   * clicks equals state after `k`.
   */
  it('masks on even click counts, reveals on odd ones, and never alters the value', async () => {
    await renderSettings();

    fc.assert(
      fc.property(apiKeyArb, toggleClickCountArb, (apiKey, clicks) => {
        // Normalise to the masked starting state; state carries across runs
        // because one mount serves them all.
        if (customKeyToggleButton().getAttribute('aria-label') === 'Hide key') {
          fireEvent.click(customKeyToggleButton());
        }
        expect(customInput('custom-provider-api-key').type).toBe('password');

        fireEvent.change(customInput('custom-provider-api-key'), {
          target: { value: apiKey },
        });
        expect(customInput('custom-provider-api-key').value).toBe(apiKey);

        for (let clicked = 1; clicked <= clicks; clicked++) {
          fireEvent.click(customKeyToggleButton());

          const input = customInput('custom-provider-api-key');
          const revealed = clicked % 2 === 1;

          // Requirement 3.5 / 3.6: parity decides masked vs. unmasked…
          expect(input.type).toBe(revealed ? 'text' : 'password');
          // …the accessible label tracks the same state…
          expect(customKeyToggleButton().getAttribute('aria-label')).toBe(
            revealed ? 'Hide key' : 'Show key',
          );
          // …and the draft itself is untouched by the toggle.
          expect(input.value).toBe(apiKey);

          // Masked: nothing of the key is in the panel's rendered text.
          if (!revealed) {
            expect(document.body.textContent ?? '').not.toContain(apiKey);
          }
        }

        // Back to the masked start state, and the value still intact.
        const settled = customInput('custom-provider-api-key');
        expect(settled.type).toBe(clicks % 2 === 1 ? 'text' : 'password');
        expect(settled.value).toBe(apiKey);
      }),
      { numRuns: 100 },
    );
  }, 60_000);
});

// ─── Property 5 ──────────────────────────────────────────────────────────────

/** A seed credential for the "already saved" configuration each run starts from. */
const SEED_API_KEY = 'sk-seed-0000111122223333444455556666';

/**
 * Base_URL drafts that Requirement 1.8 must reject: values that do not parse as
 * an absolute URL at all (bare hosts, relative paths, whitespace-broken text)
 * and values that parse but carry a scheme other than `http:`/`https:`.
 *
 * The seeds are decorated with a random path-ish suffix and optional surrounding
 * whitespace, then filtered through `normalizeBaseUrl` itself so the generator
 * cannot accidentally emit an *acceptable* value once decorated (`'http://'` plus
 * a suffix, for instance, is perfectly valid). Blank drafts are filtered out too:
 * an empty Base_URL is a legal "saved but unconfigured" entry, not a rejection.
 */
const INVALID_BASE_URL_SEEDS: readonly string[] = [
  // Unparseable — no scheme.
  '/v1',
  'api/v1',
  './relative/v1',
  '../up/v1',
  'gateway.example.test/v1',
  'gateway',
  '://gateway.example.test',
  'ht tp://gateway.example.test/v1',
  'http:/gateway.example.test',
  // Parses, but not http(s).
  'ftp://gateway.example.test/v1',
  'file:///tmp/gateway/v1',
  'ws://gateway.example.test/v1',
  'wss://gateway.example.test/v1',
  'javascript:alert(1)',
  'data:text/plain,ping',
  'mailto:ops@example.test',
  'localhost:11434/v1',
];

const invalidBaseUrlArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...INVALID_BASE_URL_SEEDS),
    fc.stringOf(fc.constantFrom(...'abz09-_/.'.split('')), { maxLength: 12 }),
    fc.constantFrom('', ' ', '  ', '\t'),
  )
  .map(([seed, suffix, pad]) => `${pad}${seed}${suffix}${pad}`)
  .filter((raw) => raw.trim().length > 0 && !normalizeBaseUrl(raw).ok);

/** An API_Key draft deliberately past the 512-character maximum (Requirement 3.11). */
const overLengthApiKeyArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: MAX_API_KEY_LENGTH + 1, max: MAX_API_KEY_LENGTH + 96 }),
    fc.stringOf(fc.constantFrom(...KEY_CHARS), { minLength: 8, maxLength: 32 }),
  )
  .map(([length, seed]) => {
    const body = seed.repeat(Math.ceil((length + 3) / seed.length));
    return `sk-${body}`.slice(0, length);
  });

/** The three rejection causes Property 5 enumerates for the panel's save path. */
type RejectionScenario =
  | { kind: 'bad-base-url'; baseUrl: string; apiKey: string }
  | { kind: 'over-length-key'; apiKey: string }
  | { kind: 'encrypt-throws'; apiKey: string };

const rejectionScenarioArb: fc.Arbitrary<RejectionScenario> = fc.oneof(
  fc.record({
    kind: fc.constant('bad-base-url' as const),
    baseUrl: invalidBaseUrlArb,
    apiKey: apiKeyArb,
  }),
  fc.record({
    kind: fc.constant('over-length-key' as const),
    apiKey: overLengthApiKeyArb,
  }),
  fc.record({
    kind: fc.constant('encrypt-throws' as const),
    apiKey: apiKeyArb,
  }),
);

/** The inline `role="alert"` message bound to a custom field, when present. */
function customFieldAlert(errorId: string): HTMLElement | null {
  return document.getElementById(errorId);
}

/** True when the field carries both `aria-invalid` and its inline alert. */
function hasFieldError(inputId: string, errorId: string): boolean {
  const alert = customFieldAlert(errorId);
  return (
    customInput(inputId).getAttribute('aria-invalid') === 'true' &&
    alert !== null &&
    alert.getAttribute('role') === 'alert' &&
    (alert.textContent ?? '').trim().length > 0
  );
}

// Feature: custom-openai-compatible-provider, Property 5: A rejected save is a no-op on persisted state and never writes plaintext
describe('Property 5: A rejected save is a no-op on persisted state and never writes plaintext', () => {
  /**
   * **Validates: Requirements 1.8, 3.10, 3.11**
   *
   * For any previously persisted provider array and any rejection cause in
   * `{non-absolute Base_URL, non-http(s) scheme, API_Key longer than 512
   * characters, Secure_Key_Storage encryption failure}`, the save leaves the
   * persisted `providers` value deep-equal to its prior value, writes no field
   * containing the submitted API_Key plaintext, and surfaces an error indication
   * naming the offending field.
   *
   * A complete, valid configuration is saved once up front, so "unchanged" is a
   * claim about a real prior value rather than about a still-absent row. Each run
   * then snapshots `JSON.stringify(providers)` immediately before its save
   * attempt and compares byte-for-byte afterwards — that catches a partial write,
   * a priority renumbering, and a dropped cipher alike.
   *
   * On the over-length cause the panel has *two* defences and they are not
   * equally reachable: `clampField` in the change handler truncates the draft to
   * 512 characters before it ever reaches component state, so the guard in
   * `handleSaveProviders` / `buildCustomConfigForSave` is unreachable through the
   * DOM (`maxLength` is only a UA courtesy; `fireEvent.change` walks past it, the
   * clamp does not). The run therefore asserts whichever outcome is observable:
   * either the guard fired — abort, no-op, error on the API_Key control — or the
   * clamp fired first, in which case the save is allowed to succeed but the
   * accepted credential must be exactly the 512-character prefix and neither the
   * submitted string nor that prefix may appear in the persisted JSON. The
   * plaintext-exclusion clause of the property holds in both branches, which is
   * what Requirement 3.11 is protecting.
   *
   * One mount serves every run, matching Properties 6 and 15: the panel's own
   * post-save state (retained cipher, cleared key control, `hasStoredKey`) is
   * part of what "no-op" means here, so re-mounting between runs would exercise a
   * cold load rather than the save path under test.
   */
  it('aborts every rejected save without touching persisted state or writing plaintext', async () => {
    await renderSettings();

    // ── Seed a complete, already-saved configuration ──────────────────────
    fireEvent.change(customInput('custom-provider-base-url'), {
      target: { value: VALID_BASE_URL },
    });
    fireEvent.change(customInput('custom-provider-model-id'), {
      target: { value: VALID_MODEL_ID },
    });
    fireEvent.change(customInput('custom-provider-api-key'), {
      target: { value: SEED_API_KEY },
    });
    await clickSaveProviders();

    const seeded = await readPersistedProviders();
    const seededCustom = seeded.find((entry) => entry.id === CUSTOM_PROVIDER_ID);
    expect(seededCustom?.baseUrl).toBe(VALID_BASE_URL);
    expect(typeof seededCustom?.apiKeyCipher).toBe('string');

    await fc.assert(
      fc.asyncProperty(rejectionScenarioArb, async (scenario) => {
        // The prior persisted value this run's save must not disturb.
        const before = JSON.stringify(await readPersistedProviders());
        expect(before).not.toBe('[]');

        toastMock.error.mockClear();
        toastMock.success.mockClear();

        // ── Arrange the rejection ─────────────────────────────────────────
        if (scenario.kind === 'bad-base-url') {
          fireEvent.change(customInput('custom-provider-base-url'), {
            target: { value: scenario.baseUrl },
          });
        }
        if (scenario.kind === 'encrypt-throws') {
          // Requirement 3.10: the OS credential store refuses to seal the key.
          secureKeyStore.mode.value = 'throws';
        }
        fireEvent.change(customInput('custom-provider-api-key'), {
          target: { value: scenario.apiKey },
        });

        await clickSaveProviders();

        const after = await readPersistedProviders();
        const afterJson = JSON.stringify(after);

        // ── Assert the outcome ────────────────────────────────────────────
        if (scenario.kind === 'bad-base-url') {
          // Requirement 1.8: nothing written, and the Base_URL control is named.
          expect(afterJson).toBe(before);
          expect(hasFieldError('custom-provider-base-url', 'custom-provider-base-url-error')).toBe(
            true,
          );
          expect(toastMock.error).toHaveBeenCalled();
          expect(toastMock.success).not.toHaveBeenCalled();
          expect(afterJson).not.toContain(scenario.apiKey);
        } else if (scenario.kind === 'encrypt-throws') {
          // Requirement 3.10: the previously persisted cipher survives intact…
          expect(afterJson).toBe(before);
          // …the API_Key control carries the error naming the cause…
          expect(hasFieldError('custom-provider-api-key', 'custom-provider-api-key-error')).toBe(
            true,
          );
          expect(
            customFieldAlert('custom-provider-api-key-error')?.textContent ?? '',
          ).toContain('could not be secured');
          expect(toastMock.error).toHaveBeenCalled();
          expect(toastMock.success).not.toHaveBeenCalled();
          // …and no plaintext fallback was written anywhere.
          expect(afterJson).not.toContain(scenario.apiKey);
        } else {
          const clampedPrefix = scenario.apiKey.slice(0, MAX_API_KEY_LENGTH);
          const rejected = afterJson === before;

          if (rejected) {
            // The save-path guard fired: abort with the API_Key control named.
            expect(
              hasFieldError('custom-provider-api-key', 'custom-provider-api-key-error'),
            ).toBe(true);
            expect(toastMock.error).toHaveBeenCalled();
            expect(toastMock.success).not.toHaveBeenCalled();
          } else {
            // The change-handler clamp fired first, so the over-length draft
            // never existed: only its 512-character prefix was accepted.
            const saved = after.find((entry) => entry.id === CUSTOM_PROVIDER_ID);
            expect(saved?.apiKeyCipher).toBeDefined();
            await expect(decryptApiKey(saved?.apiKeyCipher ?? '')).resolves.toBe(clampedPrefix);
          }

          // Requirement 3.11 either way: no over-length credential, and no
          // plaintext — neither the submitted string nor its accepted prefix.
          expect(afterJson).not.toContain(scenario.apiKey);
          expect(afterJson).not.toContain(clampedPrefix);
        }

        // ── Restore the valid draft for the next run ──────────────────────
        secureKeyStore.mode.value = 'ok';
        fireEvent.change(customInput('custom-provider-api-key'), { target: { value: '' } });
        fireEvent.change(customInput('custom-provider-base-url'), {
          target: { value: VALID_BASE_URL },
        });
        fireEvent.change(customInput('custom-provider-model-id'), {
          target: { value: VALID_MODEL_ID },
        });
      }),
      { numRuns: 100 },
    );
    // 100 runs, each a full save attempt through jsdom + fake-indexeddb, run well
    // past vitest's 5000ms default per-test timeout (cf. Properties 6 and 15).
  }, 120_000);
});

// ─── Example rendering tests (task 11.10) ────────────────────────────────────

/** DOM ids of the data-egress disclosure and its acknowledgement checkbox. */
const EGRESS_NOTICE_ID = 'custom-provider-egress-notice';
const EGRESS_ACK_ID = 'custom-provider-egress-ack';

/** Every provider card currently on screen, in rendered order. */
function providerCards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.provider-card'));
}

/** The `.provider-name` text of every card, in rendered order. */
function providerNames(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.provider-card .provider-name')).map(
    (el) => (el.textContent ?? '').trim(),
  );
}

/** The card that owns the three custom-provider controls. */
function customProviderCard(): HTMLElement {
  const card = customInput('custom-provider-base-url').closest('.provider-card');
  if (!(card instanceof HTMLElement)) {
    throw new Error('the custom provider card is not rendered');
  }
  return card;
}

/** The enable/disable power button of the custom row. */
function customToggleButton(): HTMLButtonElement {
  const button = customProviderCard().querySelector('button.provider-toggle');
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('the custom provider enable toggle is not rendered');
  }
  return button;
}

/** The acknowledgement checkbox that unlocks the enable toggle. */
function egressAckCheckbox(): HTMLInputElement {
  const el = document.getElementById(EGRESS_ACK_ID);
  if (!(el instanceof HTMLInputElement)) {
    throw new Error('the data-egress acknowledgement checkbox is not rendered');
  }
  return el;
}

/** `Enabled` / `Disabled` as shown on the custom row's status pill. */
function customStatusPill(): string {
  const pill = customProviderCard().querySelector('.provider-header .pill');
  return (pill?.textContent ?? '').trim();
}

// Feature: custom-openai-compatible-provider, task 11.10: Example rendering tests
describe('Settings_Provider_Panel: custom provider rendering', () => {
  /**
   * **Validates: Requirements 1.1**
   *
   * The panel must show the Custom_Provider exactly once, under the label
   * `Custom (OpenAI-compatible)`. `PROVIDER_LABELS.custom` is module-private in
   * `Settings.tsx`, but it is assigned from the exported `CUSTOM_PROVIDER_LABEL`,
   * so asserting the rendered text against that constant *and* against the
   * literal from the requirement pins both ends of the chain.
   */
  it('renders exactly one row labelled Custom (OpenAI-compatible)', async () => {
    await renderSettings();

    expect(CUSTOM_PROVIDER_LABEL).toBe('Custom (OpenAI-compatible)');

    const labelled = providerNames().filter((name) => name === CUSTOM_PROVIDER_LABEL);
    expect(labelled).toHaveLength(1);

    // The three custom controls are unique too, so "one row" is not one label
    // over two sets of inputs.
    expect(document.querySelectorAll('#custom-provider-base-url')).toHaveLength(1);
    expect(document.querySelectorAll('#custom-provider-api-key')).toHaveLength(1);
    expect(document.querySelectorAll('#custom-provider-model-id')).toHaveLength(1);
  });

  /**
   * **Validates: Requirements 1.1**
   *
   * A persisted record carrying two `custom` entries — a corrupted row, or one
   * written by a build with a different merge — must still collapse to a single
   * rendered row. This is the guard on `mergeCustomEntry`'s de-duplication as it
   * is actually reached, through the panel's load effect.
   */
  it('collapses a duplicated persisted custom entry to one row', async () => {
    await renderSettings([
      { id: 'gemini', enabled: true, priority: 1 },
      { id: CUSTOM_PROVIDER_ID, enabled: false, priority: 2, baseUrl: VALID_BASE_URL, modelId: VALID_MODEL_ID },
      { id: CUSTOM_PROVIDER_ID, enabled: true, priority: 3, baseUrl: 'https://second.example.test', modelId: 'other' },
    ]);

    expect(providerNames().filter((name) => name === CUSTOM_PROVIDER_LABEL)).toHaveLength(1);
    // De-duplication keeps the *first* occurrence, so the second entry's values
    // are not what is on screen.
    expect(customInput('custom-provider-base-url').value).toBe(VALID_BASE_URL);
    expect(customInput('custom-provider-model-id').value).toBe(VALID_MODEL_ID);
  });

  /**
   * **Validates: Requirements 1.4**
   *
   * The disclosure is persistent (a plain `<p>`, no dismiss control) and the
   * enable toggle stays disabled until the acknowledgement is ticked. The toggle
   * also points assistive technology at the notice through `aria-describedby`
   * while it is gated, so the reason it cannot be pressed is discoverable.
   */
  it('gates the enable toggle behind the data-egress acknowledgement', async () => {
    await renderSettings();

    // ── The notice is present and says where the data goes ────────────────
    const notice = document.getElementById(EGRESS_NOTICE_ID);
    expect(notice).not.toBeNull();
    expect(notice?.tagName).toBe('P');
    const noticeText = (notice?.textContent ?? '').toLowerCase();
    expect(noticeText).toContain('transcript');
    expect(noticeText).toContain('knowledge base');
    expect(noticeText).toContain('data-processing agreement');

    // ── Unacknowledged: the toggle is inert and the row is disabled ────────
    expect(egressAckCheckbox().checked).toBe(false);
    expect(customToggleButton().disabled).toBe(true);
    expect(customToggleButton().getAttribute('aria-describedby')).toBe(EGRESS_NOTICE_ID);

    fireEvent.click(customToggleButton());
    expect(customStatusPill()).toBe('Disabled');

    // ── Acknowledged: the toggle unlocks and now enables the provider ──────
    fireEvent.click(egressAckCheckbox());
    expect(egressAckCheckbox().checked).toBe(true);
    expect(customToggleButton().disabled).toBe(false);
    expect(customToggleButton().getAttribute('aria-describedby')).toBeNull();

    fireEvent.click(customToggleButton());
    expect(customStatusPill()).toBe('Enabled');

    // ── Withdrawing the acknowledgement re-gates and forces disabled ───────
    fireEvent.click(egressAckCheckbox());
    expect(egressAckCheckbox().checked).toBe(false);
    expect(customToggleButton().disabled).toBe(true);
    expect(customStatusPill()).toBe('Disabled');
  });

  /**
   * **Validates: Requirements 1.7**
   *
   * A persisted record with no `custom` entry initialises one: disabled, all
   * three fields empty, and a priority above every entry already present. The
   * panel sorts by priority and re-derives the displayed position from list
   * index, so the initialised priority is observed through the rendered order —
   * the custom row lands last, and its position badge equals the card count.
   * Asserting a literal number here would pin the seed's arithmetic rather than
   * the requirement.
   */
  it('initialises a missing custom entry to disabled, empty, and last in priority', async () => {
    // No `custom` id in the record, and the highest priority in use is 7.
    await renderSettings([
      { id: 'gemini', enabled: true, priority: 2 },
      { id: 'simulation', enabled: true, priority: 7 },
    ]);

    // ── Disabled ──────────────────────────────────────────────────────────
    expect(customStatusPill()).toBe('Disabled');
    expect(egressAckCheckbox().checked).toBe(false);
    expect(customToggleButton().disabled).toBe(true);
    expect(customProviderCard().className).toContain('provider-disabled');

    // ── Empty fields, and no "saved credential" placeholder ───────────────
    expect(customInput('custom-provider-base-url').value).toBe('');
    expect(customInput('custom-provider-api-key').value).toBe('');
    expect(customInput('custom-provider-model-id').value).toBe('');
    expect(customInput('custom-provider-api-key').placeholder).toBe('Enter API key...');

    // ── Greatest priority: last card in the priority-sorted list ──────────
    const cards = providerCards();
    expect(cards.length).toBeGreaterThan(1);
    expect(providerNames().at(-1)).toBe(CUSTOM_PROVIDER_LABEL);
    expect(customProviderCard()).toBe(cards[cards.length - 1]);
    expect(
      (customProviderCard().querySelector('.priority-number')?.textContent ?? '').trim(),
    ).toBe(String(cards.length));
    // Last position also means the "move down" arrow has nothing below it.
    expect(
      customProviderCard().querySelector<HTMLButtonElement>(
        `[aria-label="Move ${CUSTOM_PROVIDER_LABEL} down"]`,
      )?.disabled,
    ).toBe(true);
  });
});
