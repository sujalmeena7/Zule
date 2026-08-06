# Requirements Document

## Introduction

Zule AI currently ships four first-party model providers (Gemini, OpenAI, Anthropic, Ollama) plus a Simulation fallback. Users who want to route the AI assistant through a third-party OpenAI-compatible gateway — freemodel.dev, OpenRouter, Groq, Together, a self-hosted vLLM deployment, or a remote LM Studio instance — have no supported path today.

This feature adds an optional, user-configured **Custom (OpenAI-compatible)** provider. The User supplies a base URL, an API key, and a model id; Zule registers an adapter that speaks the OpenAI Chat Completions wire format against that endpoint and participates in the existing priority-ordered failover chain.

Two decisions frame the whole feature:

1. **Reuse, do not rebuild.** `OllamaCompatibleAdapter` already implements the exact wire protocol these gateways expose: `POST {baseUrl}/chat/completions`, `Authorization: Bearer …` header, OpenAI-dialect SSE streaming terminated by `data: [DONE]`, chunk-boundary-safe frame parsing, and a token-usage fallback estimator. The custom provider is expected to reuse that transport rather than introduce a second copy of it.

2. **The custom provider is a cloud provider, not a local one.** `AI_Provider_Router` exempts the provider ids `ollama` and `simulation` from the vault-locked gate, the offline gate, and the 429 cooldown, because local runtimes never transmit User data off-device. A remote gateway registered under the `ollama` id would ship live transcripts and Knowledge_Base excerpts across the network while the vault is locked and while the application believes it is offline. The custom provider therefore carries its own distinct identifier and is subject to every cloud-provider safety gate.

The provider ships disabled by default and is never a Zule default. Because gateways such as freemodel.dev relay prompts to upstream vendors through an intermediary with no data-processing agreement, the User is told exactly where their data goes and must acknowledge it before the provider is used.

## Glossary

- **Custom_Provider**: The provider entry identified by the string `custom`, representing a User-configured OpenAI-compatible HTTP endpoint.
- **Custom_Provider_Adapter**: The `ProviderAdapter` implementation that serves the Custom_Provider, exposing `name`, `capabilities`, `countTokens`, `complete`, and `streamGenerate`.
- **Custom_Provider_Config**: The persisted `ProviderConfig` record whose `id` is `custom`, holding enabled state, priority, Base_URL, encrypted API_Key, Model_ID, capability flags, and pricing.
- **Base_URL**: The absolute HTTP(S) URL prefix of the Custom_Provider endpoint, to which the adapter appends `/chat/completions`.
- **API_Key**: The User-supplied bearer credential for the Custom_Provider endpoint.
- **Model_ID**: The User-supplied model identifier string sent in the `model` field of the request body.
- **Settings_Provider_Panel**: The "AI Providers" section of the Settings screen that lists provider entries, accepts credentials, and persists provider configuration.
- **Endpoint_Validator**: The pure module that validates and normalises a Base_URL string.
- **Connection_Test**: The Settings-initiated single-request probe that verifies a Custom_Provider configuration before it is relied upon.
- **Provider_Sync**: The routine that reads persisted provider configuration and registers adapters with AI_Provider_Router.
- **AI_Provider_Router**: The orchestrator that holds registered adapters, applies the vault-locked, offline, and rate-limit gates, and performs priority-ordered failover.
- **Model_Selector**: The pure module that resolves a `{ providerId, modelId }` pair from a registry given token count, mode, and Profile.
- **Profile**: The User's latency/cost/privacy preference, one of `speed`, `balanced`, `cost`, `privacy`.
- **CryptoVault**: The passphrase-derived encryption facility whose locked state gates cloud provider use.
- **Secure_Key_Storage**: The renderer-side module that encrypts and decrypts provider API keys through the OS credential store before they reach IndexedDB.
- **Redaction_Engine**: The module that applies User-defined and built-in redaction rules to text before it is included in a cloud provider prompt.
- **Telemetry_Module**: The module that records per-request token-usage events keyed by provider id and model id.
- **Spend_Tracker**: The module that aggregates token-usage events into per-provider cost summaries.
- **Copilot_Error_Surface**: The copilot UI path that presents provider failures to the User.
- **Knowledge_Base**: The User's indexed document store whose excerpts are injected into prompts.
- **User**: The person operating the Zule AI application.

## Requirements

### Requirement 1: Configure a Custom OpenAI-Compatible Endpoint

**User Story:** As a Zule user, I want to point the AI assistant at a third-party OpenAI-compatible endpoint using my own API key, so that I can use models and pricing that Zule does not ship natively.

#### Acceptance Criteria

1. THE Settings_Provider_Panel SHALL display exactly one Custom_Provider entry in the AI Providers list, with the label `Custom (OpenAI-compatible)` and provider id `custom`.
2. THE Settings_Provider_Panel SHALL provide three separate text input controls on the Custom_Provider entry — Base_URL accepting 0 to 2048 characters, API_Key accepting 0 to 512 characters, and Model_ID accepting 0 to 200 characters — and SHALL reject keystrokes that would exceed each stated maximum.
3. WHEN the User activates the save control AND the trimmed Base_URL is an absolute URL using the `http` or `https` scheme, THE Settings_Provider_Panel SHALL persist to the `providers` setting the Custom_Provider_Config enabled state, a priority value that is an integer from 1 to 10, the Base_URL with leading and trailing whitespace and trailing `/` characters removed, and the trimmed Model_ID, such that re-opening the Settings_Provider_Panel displays the same four values.
4. WHERE the Custom_Provider_Config enabled field is `false`, THE Provider_Sync SHALL omit the Custom_Provider_Adapter from the adapters registered with AI_Provider_Router and SHALL omit `custom` from the AI_Provider_Router priority list.
5. IF the Provider_Sync detects a registered Custom_Provider_Adapter whose Custom_Provider_Config enabled field is `false`, THEN THE Provider_Sync SHALL raise a configuration error identifying the Custom_Provider, SHALL remove the Custom_Provider_Adapter from AI_Provider_Router so that no subsequent request is routed to it, and SHALL leave the persisted Custom_Provider_Config values unchanged.
6. WHERE the Custom_Provider_Config enabled field is `true` AND the trimmed Base_URL, the stored API_Key, or the trimmed Model_ID is an empty string, THE Provider_Sync SHALL omit registration of the Custom_Provider_Adapter, SHALL omit `custom` from the AI_Provider_Router priority list, and SHALL record a configuration-incomplete message identifying the Custom_Provider and each empty field.
7. THE Settings_Provider_Panel SHALL initialise a missing Custom_Provider entry with enabled `false`, an empty Base_URL, an empty API_Key, an empty Model_ID, and a priority value lower than every other provider entry already present.
8. IF the User activates the save control while the trimmed Base_URL is non-empty and is not an absolute URL using the `http` or `https` scheme, THEN THE Settings_Provider_Panel SHALL reject the save, SHALL retain the previously persisted Custom_Provider_Config values in the `providers` setting unchanged, and SHALL display an error indication identifying the Base_URL control as invalid.
9. WHEN the User activates the save control with a non-empty API_Key, THE Settings_Provider_Panel SHALL store the API_Key through Secure_Key_Storage as an encrypted cipher value and SHALL NOT write the API_Key plaintext into the `providers` setting.
10. WHEN the Settings_Provider_Panel opens and an encrypted API_Key cipher exists for the Custom_Provider, THE Settings_Provider_Panel SHALL render the API_Key control with a masked placeholder value, SHALL NOT render any character of the stored API_Key, and SHALL retain the existing stored API_Key if the User saves without entering a new value.

### Requirement 2: Treat the Custom Provider as a Cloud Provider

**User Story:** As a Zule user, I want my configured remote endpoint to obey the same safety gates as Gemini and OpenAI, so that my meeting transcripts are never transmitted while the vault is locked, while the app is offline, or while the privacy profile is active.

#### Acceptance Criteria

1. THE Custom_Provider_Adapter SHALL expose the value `custom` as its `name` property.
2. THE Provider_Sync SHALL register the Custom_Provider_Adapter under the identifier `custom`, SHALL leave the adapter registered under the identifier `ollama` unchanged, and SHALL leave the local-provider allowlist that exempts adapters from the CryptoVault-locked gate and the offline gate containing exactly the two identifiers `ollama` and `simulation`.
3. WHILE the CryptoVault is locked, WHEN the AI_Provider_Router routes a completion or streaming request, THE AI_Provider_Router SHALL perform zero invocations of the Custom_Provider_Adapter `complete` and `streamGenerate` operations and SHALL issue zero HTTP requests to the configured Base_URL.
4. WHILE the application reports no network connectivity, WHEN the AI_Provider_Router routes a completion or streaming request, THE AI_Provider_Router SHALL perform zero invocations of the Custom_Provider_Adapter `complete` and `streamGenerate` operations and SHALL issue zero HTTP requests to the configured Base_URL.
5. IF the CryptoVault is locked or the application reports no network connectivity, AND every remaining candidate adapter for the request is outside the local-provider allowlist, THEN THE AI_Provider_Router SHALL return an error to the caller indicating that the request was refused because the vault is locked or because the application is offline, and SHALL retain the unsent transcript text, screen text, and Knowledge_Base excerpts in local storage unmodified.
6. WHERE the active Profile is `privacy`, THE Model_Selector SHALL exclude every registry entry whose `providerId` equals `custom` from the candidate set and SHALL return no entry whose `providerId` equals `custom`.
7. WHEN the Custom_Provider_Adapter returns HTTP status 429, THE AI_Provider_Router SHALL record a cooldown start instant equal to the instant the 429 response is received and SHALL perform zero invocations of the Custom_Provider_Adapter `complete` and `streamGenerate` operations for the 300000 ms that follow that instant.
8. WHEN 300000 ms have elapsed since the recorded cooldown start instant, THE AI_Provider_Router SHALL restore the Custom_Provider_Adapter to its previous position in the failover order, subject to the CryptoVault-locked gate and the offline gate.
9. WHEN the Custom_Provider_Adapter assembles a request body, THE Redaction_Engine SHALL apply the User-defined rule set to every transcript text, screen text, and Knowledge_Base excerpt segment placed in that body before the body is transmitted to the Base_URL.
10. IF the Redaction_Engine does not complete rule application over every text segment of a Custom_Provider request body, THEN THE Custom_Provider_Adapter SHALL abort the request, SHALL issue zero HTTP requests to the configured Base_URL for that request, SHALL return an error indicating that redaction did not complete, and SHALL retain the unsent text in local storage unmodified.
11. WHERE the active Profile is `privacy`, IF the registry contains no entry whose `providerId` equals `ollama`, THEN THE Model_Selector SHALL return a selection error indicating that no local provider is available and SHALL return no entry whose `providerId` equals `custom`.

### Requirement 3: Protect the Custom Provider Credential

**User Story:** As a Zule user, I want my third-party API key stored and transmitted safely, so that it is not exposed in storage, logs, URLs, or telemetry.

#### Acceptance Criteria

1. WHEN the User saves an API_Key of 1 to 512 characters, THE Settings_Provider_Panel SHALL encrypt the API_Key through Secure_Key_Storage and SHALL write only the resulting ciphertext into the persisted Custom_Provider_Config, excluding the plaintext API_Key from every field written to IndexedDB.
2. WHERE an API_Key is configured, THE Custom_Provider_Adapter SHALL transmit the API_Key exclusively in the `Authorization` request header using the `Bearer` scheme, and SHALL exclude the API_Key value from the request body and from every other request header.
3. THE Custom_Provider_Adapter and THE Connection_Test SHALL construct request URLs that exclude the API_Key value from the path, from the query string, and from the URL fragment, for every configuration state including the state where no API_Key is configured.
4. WHERE the stored API_Key is absent, is an empty string, or contains only whitespace characters, THE Custom_Provider_Adapter SHALL omit the `Authorization` header from the request and SHALL issue the request carrying no other credential-bearing header.
5. WHILE the reveal control for the API_Key input is toggled off, THE Settings_Provider_Panel SHALL render every character of the API_Key input as a uniform masking character.
6. WHILE the reveal control for the API_Key input is toggled on, THE Settings_Provider_Panel SHALL render the API_Key characters unmasked.
7. WHEN the Custom_Provider_Adapter raises an error, THE Custom_Provider_Adapter SHALL produce an error whose message text and attached properties exclude the API_Key value and exclude the `Authorization` header value.
8. WHEN a Custom_Provider request completes, THE Telemetry_Module SHALL record an event containing provider id, model id, prompt token count, and completion token count, and SHALL exclude the API_Key value and the `Authorization` header value from every field of the recorded event.
9. THE Provider_Sync, THE Connection_Test, and THE Copilot_Error_Surface SHALL exclude the API_Key value from every Custom_Provider error message, User-visible message, and log message they emit, including messages written to the developer console.
10. IF Secure_Key_Storage cannot encrypt a submitted API_Key, THEN THE Settings_Provider_Panel SHALL leave the previously persisted API_Key ciphertext unchanged, SHALL write no plaintext API_Key to IndexedDB, and SHALL display an error message indicating that the credential could not be secured.
11. IF a submitted API_Key contains more than 512 characters, THEN THE Settings_Provider_Panel SHALL display a validation message naming the API_Key field and SHALL retain the previously stored API_Key ciphertext.
