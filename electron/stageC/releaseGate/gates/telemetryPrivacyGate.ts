/**
 * Stage C Release Gate — Telemetry Privacy Gate
 *
 * Injects unique canaries into every prohibited secret and content category
 * and observes zero canary values in recorded or transmitted Stage_C_Telemetry.
 *
 * Prohibited categories (from Req 15.11):
 * - Bootstrap records
 * - Launch_Credentials
 * - Endpoint values
 * - Provider credentials
 * - Prompts
 * - Responses
 * - Transcripts
 * - Entered text
 * - Audio
 * - Screenshots
 * - OCR data
 * - Captured content
 * - Protocol_Envelope payloads
 * - Message payload text
 *
 * Requirement 17.20
 */

import type { EnvironmentMatrixRow, GateResultRecord } from '../types';
import { ReleaseGateId } from '../types';

// ────────────────────────────────────────────────────────────────────
// Prohibited Content Categories
// ────────────────────────────────────────────────────────────────────

/**
 * Each prohibited content category that must have a unique canary injected.
 */
export enum ProhibitedCategory {
  BOOTSTRAP_RECORDS = 'bootstrap_records',
  LAUNCH_CREDENTIALS = 'launch_credentials',
  ENDPOINT_VALUES = 'endpoint_values',
  PROVIDER_CREDENTIALS = 'provider_credentials',
  PROMPTS = 'prompts',
  RESPONSES = 'responses',
  TRANSCRIPTS = 'transcripts',
  ENTERED_TEXT = 'entered_text',
  AUDIO = 'audio',
  SCREENSHOTS = 'screenshots',
  OCR_DATA = 'ocr_data',
  CAPTURED_CONTENT = 'captured_content',
  PROTOCOL_ENVELOPE_PAYLOADS = 'protocol_envelope_payloads',
  MESSAGE_PAYLOAD_TEXT = 'message_payload_text',
}

/**
 * Complete list of all prohibited categories for enumeration.
 */
export const ALL_PROHIBITED_CATEGORIES: readonly ProhibitedCategory[] =
  Object.values(ProhibitedCategory);

// ────────────────────────────────────────────────────────────────────
// Canary Types
// ────────────────────────────────────────────────────────────────────

/**
 * A canary is a unique identifiable value injected into a specific
 * prohibited category. If this value appears in telemetry output,
 * the gate fails.
 */
export interface CanaryInjection {
  /** The prohibited category being tested */
  readonly category: ProhibitedCategory;
  /** The unique canary value injected */
  readonly canaryValue: string;
  /** Human-readable description of the injection point */
  readonly description: string;
}

/**
 * Result of observing telemetry output for canary leaks.
 */
export interface CanaryObservationResult {
  /** The canary injection being checked */
  readonly injection: CanaryInjection;
  /** Whether the canary was found in telemetry output (true = leak detected) */
  readonly leaked: boolean;
  /** Where the canary was found, if leaked */
  readonly leakLocation: string | null;
}

// ────────────────────────────────────────────────────────────────────
// Canary Generation
// ────────────────────────────────────────────────────────────────────

/**
 * Generates a unique canary value for a given category.
 * The canary is a recognizable tagged string that should never appear
 * in content-free telemetry.
 *
 * @param category The prohibited category
 * @param salt A unique salt per test run to ensure canaries are unique
 */
export function generateCanary(category: ProhibitedCategory, salt: string): string {
  return `CANARY_${category.toUpperCase()}_${salt}`;
}

/**
 * Generates canary injections for all prohibited categories.
 *
 * @param salt A unique salt per test run
 * @returns Array of CanaryInjection objects, one per prohibited category
 */
export function generateAllCanaryInjections(salt: string): readonly CanaryInjection[] {
  return ALL_PROHIBITED_CATEGORIES.map((category) => ({
    category,
    canaryValue: generateCanary(category, salt),
    description: getCanaryDescription(category),
  }));
}

function getCanaryDescription(category: ProhibitedCategory): string {
  const descriptions: Record<ProhibitedCategory, string> = {
    [ProhibitedCategory.BOOTSTRAP_RECORDS]:
      'Bootstrap record content injected during Stage C initialization',
    [ProhibitedCategory.LAUNCH_CREDENTIALS]:
      '32-byte Launch_Credential hex string injected at sidecar launch',
    [ProhibitedCategory.ENDPOINT_VALUES]:
      'IPC endpoint pipe path injected at connection setup',
    [ProhibitedCategory.PROVIDER_CREDENTIALS]:
      'Provider API key (sk-...) injected into provider config',
    [ProhibitedCategory.PROMPTS]:
      'User prompt text injected into AI pipeline',
    [ProhibitedCategory.RESPONSES]:
      'AI response text injected into response handling',
    [ProhibitedCategory.TRANSCRIPTS]:
      'Conversation transcript injected into session history',
    [ProhibitedCategory.ENTERED_TEXT]:
      'User-entered text content injected into input handling',
    [ProhibitedCategory.AUDIO]:
      'Base64-encoded audio payload injected into transcription',
    [ProhibitedCategory.SCREENSHOTS]:
      'Base64-encoded screenshot data injected into capture pipeline',
    [ProhibitedCategory.OCR_DATA]:
      'OCR-extracted text injected into screen context',
    [ProhibitedCategory.CAPTURED_CONTENT]:
      'Screen capture content injected into capture pipeline',
    [ProhibitedCategory.PROTOCOL_ENVELOPE_PAYLOADS]:
      'Protocol_Envelope JSON payload injected into IPC handling',
    [ProhibitedCategory.MESSAGE_PAYLOAD_TEXT]:
      'Message payload text injected into bridge message handling',
  };
  return descriptions[category];
}

// ────────────────────────────────────────────────────────────────────
// Telemetry Privacy Gate Dependencies
// ────────────────────────────────────────────────────────────────────

/**
 * Injectable dependencies for the telemetry privacy gate.
 */
export interface TelemetryPrivacyGateDeps {
  /**
   * Injects a unique canary value into the specified prohibited category.
   * The system under test processes this injected value through its normal paths.
   */
  injectCanary(injection: CanaryInjection): void;

  /**
   * After injection, triggers the system to process the injected content
   * through the Stage C telemetry pipeline (emission, recording, transmission).
   */
  triggerTelemetryPipeline(): void;

  /**
   * Observes all recorded and transmitted Stage_C_Telemetry events
   * for the presence of a specific canary value.
   *
   * @returns true if the canary was found (privacy violation), false if not found (correct)
   */
  observeCanaryInTelemetry(canaryValue: string): CanaryObservationResult['leakLocation'];
}

// ────────────────────────────────────────────────────────────────────
// Telemetry Privacy Gate Execution
// ────────────────────────────────────────────────────────────────────

/**
 * Executes the telemetry-privacy gate for a given environment matrix row.
 *
 * For each prohibited content category (per Req 15.11, 17.20):
 * 1. Generates a unique canary value
 * 2. Injects it into the category's data path
 * 3. Triggers the telemetry pipeline
 * 4. Observes all recorded/transmitted telemetry for the canary
 * 5. Fails if ANY canary is found in output
 *
 * @param row The environment matrix row under test
 * @param deps Injectable dependencies
 * @param buildHash The SHA-256 build hash for evidence binding
 * @param appVersion The App Core version under test
 * @param sidecarVersion The sidecar version under test
 * @param salt Unique salt for this test run (ensures canary uniqueness)
 * @returns A complete GateResultRecord
 */
export function executeTelemetryPrivacyGate(
  row: EnvironmentMatrixRow,
  deps: TelemetryPrivacyGateDeps,
  buildHash: string,
  appVersion: string,
  sidecarVersion: string,
  salt: string,
): GateResultRecord {
  const injections = generateAllCanaryInjections(salt);
  const observations: CanaryObservationResult[] = [];
  const failures: string[] = [];

  for (const injection of injections) {
    // Step 1: Inject the canary into the prohibited category
    deps.injectCanary(injection);

    // Step 2: Trigger telemetry pipeline processing
    deps.triggerTelemetryPipeline();

    // Step 3: Observe telemetry output for canary presence
    const leakLocation = deps.observeCanaryInTelemetry(injection.canaryValue);
    const leaked = leakLocation !== null;

    observations.push({
      injection,
      leaked,
      leakLocation,
    });

    if (leaked) {
      failures.push(
        `Canary for '${injection.category}' leaked to telemetry at: ${leakLocation}`,
      );
    }
  }

  const verdict = failures.length === 0 ? 'pass' : 'fail';

  return {
    gateId: ReleaseGateId.TELEMETRY_PRIVACY,
    buildHash,
    osBuild: row.osBuild,
    architecture: row.architecture,
    webView2Version: row.webView2Version,
    appVersion,
    sidecarVersion,
    rawMeasurementSummary: JSON.stringify({
      categoriesTested: ALL_PROHIBITED_CATEGORIES.length,
      canariesInjected: injections.length,
      leaksDetected: failures.length,
      observations: observations.map((o) => ({
        category: o.injection.category,
        leaked: o.leaked,
        leakLocation: o.leakLocation,
      })),
    }),
    verdict,
    executedAt: new Date().toISOString(),
  };
}
