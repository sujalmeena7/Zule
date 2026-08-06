# Implementation Plan: Custom (OpenAI-compatible) Provider

## Overview

This plan delivers the optional **Custom (OpenAI-compatible)** provider in
TypeScript, in the order the design's dependency structure dictates: shared
types first; then the pure decision modules (`endpointValidator.ts`,
`customProviderConfig.ts`) that hold every safety-critical branch; then the
provider-agnostic `OpenAICompatibleAdapter` extraction and the two thin
subclasses; then the redaction attestation, the router's `unregisterAdapter`,
Provider_Sync, the Connection_Test, and finally the Settings panel that drives
all of it.

Two invariants are load-bearing throughout and are pinned by tests rather than
by convention: `LOCAL_PROVIDER_NAMES` stays exactly `{ollama, simulation}`, and
`ollama.test.ts` keeps passing **unmodified** across the base-class extraction.

Convert the feature design into a series of prompts for a code-generation LLM
that will implement each step with incremental progress. Make sure that each
prompt builds on the previous prompts, and ends with wiring things together.
There should be no hanging or orphaned code that isn't integrated into a
previous step. Focus ONLY on tasks that involve writing, modifying, or
testing code.

## Tasks

- [x] 1. Extend the shared types for the custom provider
  - [x] 1.1 Extend `ProviderConfig` in `src/data/database.ts`
    - Add `'custom'` to the `id` union; add the new optional fields `modelId?: string` and `acknowledgedEgressAt?: number`; document `priority` as a 1-based integer in `[1, 10]` and `apiKeyCipher` as ciphertext only
    - Do NOT bump `DB_VERSION` and do NOT add a store or migration — `providers` is a single JSON-array row in `STORE_SETTINGS` and both new fields are optional
    - _Requirements: 1.3, 1.9, 3.1_

  - [x] 1.2 Add the redaction attestation and the `custom` provider id to `src/types/ai.ts`
    - Export `RedactionAttestation { applied: boolean; ruleCount: number; segmentsTotal: number; segmentsRedacted: number }`
    - Add the optional field `redaction?: RedactionAttestation` to `PromptInput` so every existing construction site keeps compiling, and add `'custom'` to `ProviderId`
    - _Requirements: 2.9, 2.10_

  - [x] 1.3 Add the two new `ZuleError` variants to `src/types/errors.ts`
    - `{ kind: 'provider.redaction-incomplete'; providerId: string }` and `{ kind: 'provider.config-incomplete'; providerId: string; missing: string[] }`
    - Both must stay content-free: `missing` holds field *names* only, never values
    - _Requirements: 1.5, 1.6, 2.10_

- [x] 2. Implement the pure decision modules
  - [x] 2.1 Implement `src/brain/providers/endpointValidator.ts`
    - Export `MAX_BASE_URL_LENGTH = 2048`, the `BaseUrlResult` union, and `normalizeBaseUrl(raw)`
    - Order of operations: `trim()` → empty check → length check against `MAX_BASE_URL_LENGTH` *before* parsing → `new URL(trimmed)` in try/catch (`'unparseable'`) → protocol must be exactly `'http:'` or `'https:'` (`'unsupported-scheme'`)
    - Return `trimmed.replace(/\/+$/, '')` — the input text with trailing slashes stripped, never `url.href`, so `URL` canonicalisation cannot re-add a path slash or re-order query parameters some gateways require verbatim
    - _Requirements: 1.3, 1.8_

  - [x]* 2.2 Property test for Base_URL validation in `src/brain/providers/endpointValidator.test.ts`
    - **Property 1: Base_URL validation and normalisation**
    - **Validates: Requirements 1.3, 1.8**

  - [x] 2.3 Implement `src/brain/providers/customProviderConfig.ts`
    - Export the constants `CUSTOM_PROVIDER_ID`, `CUSTOM_PROVIDER_LABEL`, `MAX_API_KEY_LENGTH = 512`, `MAX_MODEL_ID_LENGTH = 200`, `MIN_PRIORITY = 1`, `MAX_PRIORITY = 10`, and the `CustomField` type
    - Implement `clampField(field, raw)` (prefix truncation to the field maximum), `mergeCustomEntry(saved)` (exactly one `custom` entry; append `{ enabled: false, baseUrl: '', modelId: '', priority: min(max(existing)+1, MAX_PRIORITY) }` when absent; de-duplicate to the first occurrence), `buildCustomConfigForSave(input)` (normalise Base_URL via `normalizeBaseUrl`, trim Model_ID, clamp/reject non-integer priority, retain the previous cipher when `apiKeyDraft === ''`, reject an over-length API_Key), `resolveCustomRegistration(input)`, and `planProviderSync(configs, decryptedKeys, registered)`
    - Blankness is `value.trim().length === 0`; `resolveCustomRegistration` checks `enabled === false` **first** so a disabled entry yields `unregister` when registered and `skip: 'absent'` otherwise, regardless of the other fields; `missing` is built in the fixed order `['baseUrl', 'apiKey', 'modelId']`
    - Every function is non-mutating — build new arrays and objects, never write back to `configs`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 3.11_

  - [x]* 2.4 Property test for custom-entry initialisation in `src/brain/providers/customProviderConfig.test.ts`
    - **Property 3: The entry list holds exactly one initialised Custom_Provider**
    - **Validates: Requirements 1.1, 1.7**

  - [x]* 2.5 Property test for the save round trip in `src/brain/providers/customProviderConfig.test.ts`
    - **Property 4: Save round-trip preserves the four persisted values**
    - **Validates: Requirements 1.3**

  - [x]* 2.6 Property test for the sync plan in `src/brain/providers/customProviderConfig.test.ts`
    - **Property 7: Provider_Sync's plan is a total, non-mutating function of configuration**
    - **Validates: Requirements 1.4, 1.5, 1.6**

- [x] 3. Checkpoint — the pure decision layer is complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Extract the provider-agnostic OpenAI-compatible transport
  - [x] 4.1 Create `src/brain/providers/openAICompatible.ts` by lifting the body of `OllamaCompatibleAdapter`
    - Move the class and its module-private helpers (`buildRequestBody`, `throwIfNotOk`, `extractCompletionText`, `extractDeltaContent`, `extractUsage`) verbatim; replace every hard-coded `PROVIDER_ID` with `this.providerId`
    - Add `OpenAICompatibleAdapterOptions` with `providerId`, `baseUrl`, `defaultModelId`, `apiKey?`, `capabilities?`, `streamingTimeoutMs?`, `nonStreamingTimeoutMs?`, `fetchImpl?`, `onUsage?`, `scrubError?`, and `preflight?`
    - `preflight(prompt)` runs before the body is serialised and before any `fetch`, so a throw produces zero HTTP requests; `throwIfNotOk` passes the assembled message through `scrubError` before constructing the `ProviderHttpError`
    - Append only `/chat/completions` to `baseUrl` — never synthesise `/v1`
    - _Requirements: 2.10, 3.7_

  - [x] 4.2 Reduce `src/brain/providers/ollama.ts` to a thin subclass
    - Keep the exported surface (`OllamaCompatibleAdapter`, `OllamaCompatibleAdapterOptions`) and every current default: `http://localhost:11434/v1`, `llama3.1`, 120 000 ms streaming and non-streaming, zero pricing, `providerId: 'ollama'`
    - `src/brain/providers/ollama.test.ts` MUST pass **unmodified** — it is the behaviour-preservation guard for the extraction. Run it and do not edit it
    - _Requirements: 2.2_

- [x] 5. Implement the Custom_Provider_Adapter
  - [x] 5.1 Implement `src/brain/providers/custom.ts`
    - `CustomOpenAICompatibleAdapter extends OpenAICompatibleAdapter` with `readonly name = 'custom'`; constructor throws when `baseUrl` or `modelId` is blank so an incompletely configured adapter cannot exist; cloud timeouts from `http.ts` (6 000 ms non-streaming, 12 000 ms streaming); capabilities default to `streaming: true`, `imageInput: false`, `toolUse: false`, `maxInputTokens: 32_000`, `pricePerMTokens` from config (default `{0,0}`), all overridable
    - Export the pure helper `scrubSecret(text, secret?)`: returns `text` unchanged when `secret` is blank or shorter than 8 characters, otherwise replaces every occurrence of `secret` and `` `Bearer ${secret}` `` with `'[REDACTED:APIKEY]'`. Wire it as `scrubError`
    - Implement `assertRedacted(prompt)` as `preflight`: throw `RedactionIncompleteError` unless `prompt.redaction` exists with `applied === true` and `segmentsRedacted === segmentsTotal`
    - Wire `onUsage` to emit exactly one `{ kind: 'tokens', providerId: 'custom', modelId, promptTokens, completionTokens }` event per completed request through the injectable `telemetrySink` (default `telemetry.emit`), coercing the gateway's usage block to non-negative integers
    - _Requirements: 1.6, 2.1, 2.10, 3.2, 3.4, 3.7, 3.8_

  - [x]* 5.2 Property test for credential placement in `src/brain/providers/custom.test.ts`
    - **Property 12: The credential travels only in the Authorization header**
    - **Validates: Requirements 3.2, 3.3, 3.4**

  - [x]* 5.3 Property test for credential scrubbing across surfaces in `src/brain/providers/custom.test.ts`
    - **Property 13: No surface emits the credential**
    - **Validates: Requirements 3.7, 3.9**

  - [x]* 5.4 Property test for token-usage telemetry in `src/brain/providers/custom.test.ts`
    - **Property 14: Exactly one token-usage event per completed request**
    - **Validates: Requirements 3.8**

  - [x]* 5.5 Example tests for the custom adapter in `src/brain/providers/custom.test.ts`
    - `new CustomOpenAICompatibleAdapter(...).name === 'custom'` _Requirements: 2.1_
    - Base_URL `'https://example.com/v1'` yields the endpoint `'https://example.com/v1/chat/completions'` — no `/v1` synthesis, in contrast to the `ollama` branch in `aiProvider.ts`
    - One streaming happy path against a canned SSE fixture ending in `data: [DONE]`, asserting cumulative `onToken` text and a single `onComplete`
    - Constructor throws for a blank `baseUrl` and for a blank `modelId` _Requirements: 1.6_

- [x] 6. Stamp and enforce the redaction attestation
  - [x] 6.1 Stamp the attestation in `src/brain/contextBuilder.ts`
    - Count the `ContextSection`s emitted and the sections passed through `redactText`, then stamp `{ applied: segmentsRedacted === segmentsTotal, ruleCount, segmentsTotal, segmentsRedacted }` on the built prompt
    - An empty rule set is not a failure: `ruleCount: 0` with `segmentsRedacted === segmentsTotal` attests successfully. When `settings.skipRedaction` is `true`, stamp `applied: false` so such a prompt can never reach the custom provider
    - _Requirements: 2.9, 2.10_

  - [x] 6.2 Stop skipping redaction in `src/brain/contextManager.ts`
    - `buildContextWindow` currently passes `skipRedaction: true` ("Legacy path did not redact"); read the `redactionRules` setting and pass `skipRedaction: false` instead, so prompts from this path carry a passing attestation
    - _Requirements: 2.9_

  - [x]* 6.3 Property test for redaction-before-egress in `src/brain/providers/custom.test.ts`
    - **Property 11: Redaction is complete before egress, or there is no egress**
    - **Validates: Requirements 2.9, 2.10**

- [x] 7. Extend the AI_Provider_Router
  - [x] 7.1 Add `unregisterAdapter` and export `LOCAL_PROVIDER_NAMES` in `src/brain/providerRouter.ts`
    - `unregisterAdapter(name): boolean` deletes from `this.adapters`, drops the name from `this.priority`, clears any `rateLimitedUntil` entry, and returns whether an adapter was present
    - Export `LOCAL_PROVIDER_NAMES` (currently module-private) and leave its membership exactly `new Set(['ollama', 'simulation'])`. Change no other router logic — the vault, offline, and 429 gates already key off non-membership
    - _Requirements: 1.5, 2.2, 2.3, 2.4, 2.7, 2.8_

  - [x]* 7.2 Example tests for the router additions in `src/brain/providerRouter.customProvider.test.ts`
    - `LOCAL_PROVIDER_NAMES` equals exactly `new Set(['ollama', 'simulation'])`, and registering the custom adapter does not add to it — the single most important regression guard in this feature _Requirements: 2.2_
    - `unregisterAdapter('custom')` returns `true`, removes the name from the priority list, and a subsequent route performs zero invocations of the removed adapter; a second call returns `false` _Requirements: 1.5_

  - [x]* 7.3 Property test for the cloud gates in `src/brain/providerRouter.customProvider.test.ts`
    - **Property 8: Cloud gates block the Custom_Provider with zero invocations and zero egress**
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.5**

  - [x]* 7.4 Property test for the 429 cooldown in `src/brain/providerRouter.customProvider.test.ts`
    - **Property 10: A 429 suppresses the Custom_Provider for exactly 300 000 ms and then restores its position**
    - **Validates: Requirements 2.7, 2.8**

  - [x]* 7.5 Property test for the privacy Profile in `src/brain/providerRouter.customProvider.test.ts`
    - **Property 9: The `privacy` Profile never selects the Custom_Provider**
    - **Validates: Requirements 2.6, 2.11**

- [x] 8. Checkpoint — adapters and router gates are in place
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Rewire Provider_Sync over the pure planner
  - [x] 9.1 Make `ensureProvidersSynced` in `src/brain/aiProvider.ts` a thin driver over `planProviderSync`
    - Read `providers` from IndexedDB and run `mergeCustomEntry`; decrypt each `apiKeyCipher` via `decryptApiKey`, mapping a decrypt failure to `''` so it degrades to `skip: 'incomplete'` rather than to an uncredentialed request
    - Track `registeredNames: Set<string>` alongside the existing `lastSyncedConfigHash`, run the planner, then apply the plan: instantiate and `registerAdapter` each `register` id (custom via `await import('./providers/custom')`, matching the existing per-adapter dynamic-import pattern), `router.unregisterAdapter(id)` each `unregister` id, then `router.setPriority(plan.priority)`
    - Construct the custom adapter with the normalised Base_URL straight from storage and the first-class `modelId` field — never the `ollama` branch's `apiKeyCipher`-as-model-tag trick, and no `/v1` suffixing
    - Emit each diagnostic through `console.warn` and the copilot error surface after `scrubSecret`: `custom.disabled-while-registered` is the Requirement 1.5 configuration error, `custom.config-incomplete` names each empty field per Requirement 1.6
    - _Requirements: 1.4, 1.5, 1.6, 2.2, 3.9_

  - [x]* 9.2 Integration check for Settings → IndexedDB → Provider_Sync → router in `src/brain/aiProvider.customProvider.test.ts`
    - Against the fake IndexedDB: save a complete config, assert `custom` is registered and last in the priority list; disable it, re-sync, assert the adapter is gone and the persisted record is byte-identical
    - _Requirements: 1.4, 1.5_

- [x] 10. Implement the Connection_Test
  - [x] 10.1 Implement `src/brain/providers/connectionTest.ts`
    - `testCustomProviderConnection` issues a single non-streaming `POST {normalised}/chat/completions` with `{ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }`, a 6 000 ms `fetchWithTimeout`, and **no** `retryWithJitter` — a configuration probe reports the first failure
    - Map results to the `ConnectionTestFailure` categories; `detail` is a short `scrubSecret`-ed classification string (e.g. `HTTP 401`), never the raw body and never the URL. The probe carries no transcript, screen, or Knowledge_Base content and does not go through the router
    - _Requirements: 3.3, 3.9_

  - [x]* 10.2 Example tests for failure classification in `src/brain/providers/connectionTest.test.ts`
    - Map each canned response to its category: 401 → `unauthorized`, 403 → `forbidden`, 404 → `not-found`, 429 → `rate-limited`, 500 → `server-error`, network throw → `network`, timeout → `timeout`, non-JSON body → `bad-response`, invalid Base_URL → `invalid-url`, blank Model_ID → `missing-model`
    - Assert the probe URL's path, query string, and fragment exclude the API_Key _Requirements: 3.3_

- [x] 11. Extend the Settings_Provider_Panel
  - [x] 11.1 Add the custom entry to the provider list in `src/components/Settings.tsx`
    - `DEFAULT_PROVIDERS` gains `{ id: 'custom', enabled: false, priority: 6, baseUrl: '', modelId: '' }`; set `PROVIDER_LABELS.custom = 'Custom (OpenAI-compatible)'` and `PROVIDER_DESCRIPTIONS.custom`
    - Replace the load effect's `DEFAULT_PROVIDERS.map` merge with `mergeCustomEntry` over the persisted array, so persisted ids outside the defaults are no longer silently dropped
    - _Requirements: 1.1, 1.7_

  - [x] 11.2 Render the three-input custom row in `src/components/Settings.tsx`
    - Rendered only for `provider.id === 'custom'`: Base_URL (`type="text"`, `maxLength={2048}`), API_Key (`type={reveal ? 'text' : 'password'}`, `maxLength={512}`, reusing the existing eye/eye-off toggle), Model_ID (`type="text"`, `maxLength={200}`); every `onChange` routes through `clampField` so an over-length paste is truncated rather than accepted
    - Bind `aria-invalid` and an inline message to a `customBaseUrlError` state; for `custom` do not decrypt the stored key into the input — record `hasStoredKey.custom = true`, leave the value `''`, and set the placeholder `'•••••••••••• (saved — leave blank to keep)'`
    - _Requirements: 1.2, 1.8, 1.10, 3.5, 3.6_

  - [x] 11.3 Implement the custom save path in `src/components/Settings.tsx`
    - `handleSaveProviders` assigns `priority = index + 1`, then for the custom entry: `clampField` the drafts → `encryptApiKey` when the key draft is non-empty → `buildCustomConfigForSave`; a blank key draft omits `apiKeyCipher` so the stored cipher is retained
    - On `{ ok: false }` abort the whole save (leaving `providers` in IndexedDB byte-identical), set the field error, and toast. An `encryptApiKey` rejection takes the same abort path with a "credential could not be secured" message; a returned `plain:`-prefixed value proceeds with a warning toast that the OS credential store was unavailable
    - _Requirements: 1.3, 1.8, 1.9, 1.10, 3.1, 3.10, 3.11_

  - [x] 11.4 Add the data-egress disclosure and acknowledgement gate in `src/components/Settings.tsx`
    - A persistent notice above the inputs stating that prompts — including transcript text and Knowledge_Base excerpts — are sent to the configured endpoint, that a gateway may relay them to upstream vendors, and that Zule has no data-processing agreement with either
    - Disable the enable toggle for the custom entry until an acknowledgement checkbox is ticked; ticking it stamps `acknowledgedEgressAt: Date.now()` on the entry. The gate lives entirely in the panel's enable path so the persisted `enabled` flag stays the single source of truth Provider_Sync reads
    - _Requirements: 1.4_

  - [x] 11.5 Wire the Test connection control in `src/components/Settings.tsx`
    - A button beside the save button, enabled only when the draft has all three fields; calls `testCustomProviderConnection` with the clamped drafts and the decrypted-or-drafted key, and renders the `ConnectionTestResult` category as a toast plus an inline status pill. Never render `detail` unscrubbed
    - _Requirements: 3.3, 3.9_

  - [x]* 11.6 Property test for input length clamping in `src/components/__tests__/SettingsCustomProvider.test.tsx`
    - **Property 2: Input length clamping**
    - **Validates: Requirements 1.2**

  - [x]* 11.7 Property test for credential persistence in `src/components/__tests__/SettingsCustomProvider.test.tsx`
    - **Property 6: The API_Key is persisted only as ciphertext, and a blank save retains it**
    - **Validates: Requirements 1.9, 1.10, 3.1**

  - [x]* 11.8 Property test for the reveal toggle in `src/components/__tests__/SettingsCustomProvider.test.tsx`
    - **Property 15: The reveal toggle is a round trip over masking**
    - **Validates: Requirements 3.5, 3.6**

  - [x]* 11.9 Property test for rejected saves in `src/components/__tests__/SettingsCustomProvider.test.tsx`
    - **Property 5: A rejected save is a no-op on persisted state and never writes plaintext**
    - **Validates: Requirements 1.8, 3.10, 3.11**

  - [x]* 11.10 Example rendering tests in `src/components/__tests__/SettingsCustomProvider.test.tsx`
    - Exactly one row labelled `Custom (OpenAI-compatible)` is rendered, and `PROVIDER_LABELS.custom` matches it _Requirements: 1.1_
    - The egress notice is present and the enable toggle is disabled until the acknowledgement checkbox is ticked _Requirements: 1.4_
    - A missing persisted entry initialises to disabled, empty fields, and the numerically greatest priority _Requirements: 1.7_

- [x] 12. Final integration
  - [x] 12.1 Wire the custom provider end-to-end and reconcile the widened types
    - Confirm the full path compiles and runs together: Settings save → `providers` row → `ensureProvidersSynced` → `router.registerAdapter('custom')` → `contextBuilder` attestation → adapter egress; fix any call site broken by the widened `ProviderConfig['id']` union and the new `PromptInput.redaction` field
    - Run `npx tsc --noEmit` for both the renderer and `electron/` tsconfig projects, and run the existing suites the design names as must-pass-unmodified: `ollama.test.ts`, `openai.test.ts`, `http.test.ts`, `providerRouter.test.ts`, `modelSelector.test.ts`, `redaction.test.ts`, `contextBuilder.test.ts`
    - _Requirements: 1.3, 2.1, 2.2, 2.9_

- [x] 13. Final checkpoint — feature complete
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. They cover the 15 property tests and the example/integration tests.
- Each of the design's 15 correctness properties is implemented as **exactly one** `fast-check` property test with **at least 100 runs** (`fc.assert(fc.property(...), { numRuns: 100 })`), tagged with the project's comment format: `// Feature: custom-openai-compatible-provider, Property N: <title>`.
- Test harness doubles come from the design's Testing Strategy: an injected `fetchImpl` spy for zero-egress assertions, `vi.useFakeTimers()` for the 300 000 ms cooldown boundary, an in-memory `Map` stub for Secure_Key_Storage (plus a throwing mode), and a `JSON.stringify` snapshot of the fake IndexedDB stores for the "local storage unmodified" clauses.
- Two invariants are pinned by test rather than by convention: `LOCAL_PROVIDER_NAMES` stays exactly `{ollama, simulation}` (task 7.2), and `ollama.test.ts` passes unmodified across the base-class extraction (task 4.2).
- No `DB_VERSION` bump and no IndexedDB migration — `providers` is a single JSON-array row in `STORE_SETTINGS` and both new `ProviderConfig` fields are optional.
- Checkpoints sit at three natural integration points: after the pure decision layer, after the adapters and router gates, and after the full feature is wired.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "2.1"] },
    { "id": 1, "tasks": ["2.2", "2.3", "4.1", "7.1"] },
    { "id": 2, "tasks": ["2.4", "4.2", "5.1", "6.1", "10.1", "11.1"] },
    { "id": 3, "tasks": ["2.5", "5.2", "6.2", "7.2", "10.2", "11.2"] },
    { "id": 4, "tasks": ["2.6", "5.3", "7.3", "9.1", "11.3"] },
    { "id": 5, "tasks": ["5.4", "7.4", "11.4"] },
    { "id": 6, "tasks": ["5.5", "7.5", "11.5"] },
    { "id": 7, "tasks": ["6.3", "9.2", "11.6"] },
    { "id": 8, "tasks": ["11.7"] },
    { "id": 9, "tasks": ["11.8"] },
    { "id": 10, "tasks": ["11.9"] },
    { "id": 11, "tasks": ["11.10"] },
    { "id": 12, "tasks": ["12.1"] }
  ]
}
```
