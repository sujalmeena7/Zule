/**
 * Stage C Manifest — Serialization and Strict Validation.
 *
 * This module provides:
 * - Exact-schema manifest serialization (for packaging)
 * - Exact-schema manifest deserialization/parsing with strict validation
 * - Binding validation: artifact paths/hashes, versions, architecture,
 *   protocol/bridge compatibility, WebView2 minimum, dependency-lock hash,
 *   capabilities, publisher, and release-gate evidence identifier
 * - All schema or binding mismatches are rejected before runtime probe use
 *
 * Requirements: 4.4–4.9, 14.5–14.8
 */

import { readFileSync, accessSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  StageCManifest,
  SupportedArchitecture,
  MANIFEST_REQUIRED_FIELDS,
  APP_CORE_PROTOCOL_MAJOR,
  APP_CORE_MIN_BRIDGE_SCHEMA,
  APP_CORE_MAX_BRIDGE_SCHEMA,
} from './types';

import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  BRIDGE_SCHEMA_VERSION,
} from './protocol/schema';

// ────────────────────────────────────────────────────────────────────
// Validation Error Types
// ────────────────────────────────────────────────────────────────────

export enum ManifestErrorCode {
  MISSING_FIELD = 'MISSING_FIELD',
  UNKNOWN_FIELD = 'UNKNOWN_FIELD',
  INVALID_TYPE = 'INVALID_TYPE',
  INVALID_VALUE = 'INVALID_VALUE',
  BINDING_MISMATCH = 'BINDING_MISMATCH',
  SCHEMA_MISMATCH = 'SCHEMA_MISMATCH',
  ARTIFACT_MISSING = 'ARTIFACT_MISSING',
  ARTIFACT_HASH_MISMATCH = 'ARTIFACT_HASH_MISMATCH',
  ARCHITECTURE_MISMATCH = 'ARCHITECTURE_MISMATCH',
  PROTOCOL_MISMATCH = 'PROTOCOL_MISMATCH',
  BRIDGE_SCHEMA_INCOMPATIBLE = 'BRIDGE_SCHEMA_INCOMPATIBLE',
  WEBVIEW2_VERSION_INVALID = 'WEBVIEW2_VERSION_INVALID',
  DEPENDENCY_LOCK_MISMATCH = 'DEPENDENCY_LOCK_MISMATCH',
  PUBLISHER_INVALID = 'PUBLISHER_INVALID',
  EVIDENCE_INVALID = 'EVIDENCE_INVALID',
}

export interface ManifestValidationError {
  code: ManifestErrorCode;
  field?: string;
  message: string;
}

export type ManifestValidationResult =
  | { valid: true; manifest: StageCManifest }
  | { valid: false; errors: ManifestValidationError[] };

// ────────────────────────────────────────────────────────────────────
// Serialization Context — represents final packaging artifacts
// ────────────────────────────────────────────────────────────────────

export interface ManifestSerializationInput {
  /** Exact App Core version from package */
  appVersion: string;
  /** Exact sidecar release version */
  sidecarVersion: string;
  /** Supported sidecar architectures */
  supportedArchitectures: SupportedArchitecture[];
  /** Minimum WebView2 Runtime version required */
  minimumWebview2Version: string;
  /** Capability identifiers */
  capabilities: string[];
  /** Relative path to sidecar binary within resources */
  sidecarPath: string;
  /** Release gate evidence identifier (null for diagnostic builds) */
  releaseGateEvidenceId: string | null;
  /** SHA-256 hash of each packaged artifact keyed by relative path */
  artifactHashes: Record<string, string>;
  /** Publisher identity for signature verification */
  publisher: string;
  /** SHA-256 hash of the dependency lock file */
  dependencyLockHash: string;
}

// ────────────────────────────────────────────────────────────────────
// Serialization — builds manifest from final artifact data (Req 14.5)
// ────────────────────────────────────────────────────────────────────

/**
 * Serializes a Stage C manifest from final packaging artifact data.
 *
 * Requirement 14.5: Serialize from only final artifacts.
 * Requirement 14.6: Bind exact versions, architecture, paths, hashes,
 *   protocol, bridge schema, WebView2 minimum, dependency-lock hash,
 *   capabilities, publisher, and release-evidence identifier.
 */
export function serializeManifest(input: ManifestSerializationInput): string {
  const manifest: StageCManifest = {
    app_version: input.appVersion,
    sidecar_version: input.sidecarVersion,
    protocol_major: PROTOCOL_MAJOR,
    protocol_minor: PROTOCOL_MINOR,
    bridge_schema_version: BRIDGE_SCHEMA_VERSION,
    supported_architectures: [...input.supportedArchitectures],
    minimum_webview2_version: input.minimumWebview2Version,
    capabilities: [...input.capabilities],
    dependency_lock_hash: input.dependencyLockHash,
    sidecar_path: input.sidecarPath,
    release_gate_evidence_id: input.releaseGateEvidenceId,
    artifact_hashes: { ...input.artifactHashes },
    publisher: input.publisher,
  };

  return JSON.stringify(manifest);
}

// ────────────────────────────────────────────────────────────────────
// Deserialization — strict schema validation (Req 14.7)
// ────────────────────────────────────────────────────────────────────

/** Valid version string: non-empty, dot-separated segments */
const VERSION_PATTERN = /^\d+(\.\d+)*(-[\w.]+)?$/;

/** Valid SHA-256 hex string: exactly 64 lowercase hex chars */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Valid supported architectures */
const VALID_ARCHITECTURES: readonly string[] = ['x64', 'arm64'];

/**
 * Parses raw JSON string into a validated StageCManifest.
 *
 * Requirement 14.7: Reject unknown fields, missing fields, duplicate fields,
 * invalid values, or artifact binding mismatches before Runtime_Probe use.
 *
 * Requirement 14.8: Round-trip serialization preserves equivalent model.
 */
export function deserializeManifest(raw: string): ManifestValidationResult {
  // Step 1: Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      valid: false,
      errors: [{ code: ManifestErrorCode.SCHEMA_MISMATCH, message: 'Invalid JSON' }],
    };
  }

  return validateManifestObject(parsed);
}

/**
 * Validates an already-parsed object against the exact manifest schema.
 * Returns typed errors for every violation found.
 */
export function validateManifestObject(data: unknown): ManifestValidationResult {
  const errors: ManifestValidationError[] = [];

  // Must be a non-null, non-array object
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      valid: false,
      errors: [{ code: ManifestErrorCode.SCHEMA_MISMATCH, message: 'Manifest must be a non-null object' }],
    };
  }

  const obj = data as Record<string, unknown>;
  const knownFields = new Set<string>(MANIFEST_REQUIRED_FIELDS);
  const presentFields = Object.keys(obj);

  // Reject unknown/extra fields (Req 14.7)
  for (const field of presentFields) {
    if (!knownFields.has(field)) {
      errors.push({
        code: ManifestErrorCode.UNKNOWN_FIELD,
        field,
        message: `Unknown field '${field}' in manifest`,
      });
    }
  }

  // Require all fields present (Req 14.7)
  for (const field of MANIFEST_REQUIRED_FIELDS) {
    if (!(field in obj)) {
      errors.push({
        code: ManifestErrorCode.MISSING_FIELD,
        field,
        message: `Missing required field '${field}'`,
      });
    }
  }

  // If structural issues found, return early — type checks won't make sense
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Type and value validation for each field
  validateStringField(obj, 'app_version', errors, { nonEmpty: true });
  validateStringField(obj, 'sidecar_version', errors, { nonEmpty: true });
  validateIntegerField(obj, 'protocol_major', errors, { min: 0 });
  validateIntegerField(obj, 'protocol_minor', errors, { min: 0 });
  validateIntegerField(obj, 'bridge_schema_version', errors, { min: 1 });
  validateArchitecturesField(obj, errors);
  validateStringField(obj, 'minimum_webview2_version', errors, { nonEmpty: true });
  validateCapabilitiesField(obj, errors);
  validateStringField(obj, 'dependency_lock_hash', errors, { nonEmpty: true });
  validateStringField(obj, 'sidecar_path', errors, { nonEmpty: true });
  validateReleaseGateEvidenceField(obj, errors);
  validateArtifactHashesField(obj, errors);
  validateStringField(obj, 'publisher', errors, { nonEmpty: true });

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, manifest: obj as unknown as StageCManifest };
}

// ────────────────────────────────────────────────────────────────────
// Binding Validation — checks against runtime environment (Req 4.4–4.9)
// ────────────────────────────────────────────────────────────────────

export interface ManifestBindingContext {
  /** Current App Core architecture (process.arch mapped) */
  appArchitecture: SupportedArchitecture;
  /** Base path where Stage C resources reside */
  stageCResourcesPath: string;
  /** SHA-256 hash of the actual dependency-lock.json file */
  actualDependencyLockHash: string;
  /** Installed WebView2 Runtime version (null if not found) */
  webView2Version: string | null;
  /** Whether this is a production build */
  isProduction: boolean;
  /** App Core version for production version-equality check */
  appVersion?: string;
}

export interface ManifestBindingResult {
  valid: boolean;
  errors: ManifestValidationError[];
}

/**
 * Validates manifest bindings against the runtime environment.
 *
 * This validates that the manifest's declared values actually match
 * the deployed artifacts and environment. Called after schema validation
 * and before the runtime probe proceeds.
 *
 * Requirements: 4.4–4.9
 */
export function validateManifestBindings(
  manifest: StageCManifest,
  context: ManifestBindingContext,
): ManifestBindingResult {
  const errors: ManifestValidationError[] = [];

  // 1. Architecture binding (Req 4.4)
  if (!manifest.supported_architectures.includes(context.appArchitecture)) {
    errors.push({
      code: ManifestErrorCode.ARCHITECTURE_MISMATCH,
      field: 'supported_architectures',
      message: `App architecture '${context.appArchitecture}' not in manifest supported set`,
    });
  }

  // 2. Protocol major equality (Req 4.4)
  if (manifest.protocol_major !== APP_CORE_PROTOCOL_MAJOR) {
    errors.push({
      code: ManifestErrorCode.PROTOCOL_MISMATCH,
      field: 'protocol_major',
      message: `Protocol major ${manifest.protocol_major} does not match App Core expected ${APP_CORE_PROTOCOL_MAJOR}`,
    });
  }

  // 3. Bridge schema compatibility (Req 4.4)
  if (manifest.bridge_schema_version < APP_CORE_MIN_BRIDGE_SCHEMA ||
      manifest.bridge_schema_version > APP_CORE_MAX_BRIDGE_SCHEMA) {
    errors.push({
      code: ManifestErrorCode.BRIDGE_SCHEMA_INCOMPATIBLE,
      field: 'bridge_schema_version',
      message: `Bridge schema ${manifest.bridge_schema_version} outside supported range [${APP_CORE_MIN_BRIDGE_SCHEMA}, ${APP_CORE_MAX_BRIDGE_SCHEMA}]`,
    });
  }

  // 4. Sidecar path existence (Req 4.4)
  const sidecarAbsPath = join(context.stageCResourcesPath, manifest.sidecar_path);
  try {
    accessSync(sidecarAbsPath, fsConstants.R_OK);
  } catch {
    errors.push({
      code: ManifestErrorCode.ARTIFACT_MISSING,
      field: 'sidecar_path',
      message: `Sidecar binary not found at '${manifest.sidecar_path}'`,
    });
  }

  // 5. Artifact hash verification for sidecar
  if (manifest.artifact_hashes[manifest.sidecar_path]) {
    const actualHash = sha256File(sidecarAbsPath);
    if (actualHash !== null && actualHash !== manifest.artifact_hashes[manifest.sidecar_path]) {
      errors.push({
        code: ManifestErrorCode.ARTIFACT_HASH_MISMATCH,
        field: `artifact_hashes.${manifest.sidecar_path}`,
        message: `Sidecar hash mismatch`,
      });
    }
  }

  // 6. WebView2 minimum version (Req 4.4)
  if (context.webView2Version === null) {
    errors.push({
      code: ManifestErrorCode.WEBVIEW2_VERSION_INVALID,
      field: 'minimum_webview2_version',
      message: 'WebView2 Runtime not found',
    });
  } else if (compareVersions(context.webView2Version, manifest.minimum_webview2_version) < 0) {
    errors.push({
      code: ManifestErrorCode.WEBVIEW2_VERSION_INVALID,
      field: 'minimum_webview2_version',
      message: `Installed WebView2 ${context.webView2Version} below minimum ${manifest.minimum_webview2_version}`,
    });
  }

  // 7. Dependency lock hash integrity (Req 4.4)
  if (context.actualDependencyLockHash !== manifest.dependency_lock_hash) {
    errors.push({
      code: ManifestErrorCode.DEPENDENCY_LOCK_MISMATCH,
      field: 'dependency_lock_hash',
      message: 'Dependency lock hash does not match manifest declaration',
    });
  }

  // 8. Publisher must be non-empty (already schema-validated, but binding re-check)
  if (!manifest.publisher || manifest.publisher.trim().length === 0) {
    errors.push({
      code: ManifestErrorCode.PUBLISHER_INVALID,
      field: 'publisher',
      message: 'Publisher identity is empty',
    });
  }

  // 9. Production-specific checks (Req 4.5, 4.8)
  if (context.isProduction) {
    // Release gate evidence must be present and non-empty
    if (!manifest.release_gate_evidence_id ||
        manifest.release_gate_evidence_id.trim().length === 0) {
      errors.push({
        code: ManifestErrorCode.EVIDENCE_INVALID,
        field: 'release_gate_evidence_id',
        message: 'Release gate evidence identifier required for production',
      });
    }

    // Exact version equality (Req 4.8)
    if (context.appVersion) {
      if (manifest.app_version !== context.appVersion) {
        errors.push({
          code: ManifestErrorCode.BINDING_MISMATCH,
          field: 'app_version',
          message: `Manifest app_version '${manifest.app_version}' does not match App Core '${context.appVersion}'`,
        });
      }
      if (manifest.sidecar_version !== context.appVersion) {
        errors.push({
          code: ManifestErrorCode.BINDING_MISMATCH,
          field: 'sidecar_version',
          message: `Manifest sidecar_version '${manifest.sidecar_version}' does not match App Core '${context.appVersion}'`,
        });
      }
    }

    // Artifact hashes must be non-empty for production
    if (Object.keys(manifest.artifact_hashes).length === 0) {
      errors.push({
        code: ManifestErrorCode.BINDING_MISMATCH,
        field: 'artifact_hashes',
        message: 'Production manifest must declare at least one artifact hash',
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ────────────────────────────────────────────────────────────────────
// Internal field validators
// ────────────────────────────────────────────────────────────────────

function validateStringField(
  obj: Record<string, unknown>,
  field: string,
  errors: ManifestValidationError[],
  opts: { nonEmpty?: boolean } = {},
): void {
  const value = obj[field];
  if (typeof value !== 'string') {
    errors.push({
      code: ManifestErrorCode.INVALID_TYPE,
      field,
      message: `'${field}' must be a string`,
    });
    return;
  }
  if (opts.nonEmpty && value.length === 0) {
    errors.push({
      code: ManifestErrorCode.INVALID_VALUE,
      field,
      message: `'${field}' must be non-empty`,
    });
  }
}

function validateIntegerField(
  obj: Record<string, unknown>,
  field: string,
  errors: ManifestValidationError[],
  opts: { min?: number } = {},
): void {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors.push({
      code: ManifestErrorCode.INVALID_TYPE,
      field,
      message: `'${field}' must be an integer`,
    });
    return;
  }
  if (opts.min !== undefined && value < opts.min) {
    errors.push({
      code: ManifestErrorCode.INVALID_VALUE,
      field,
      message: `'${field}' must be >= ${opts.min}`,
    });
  }
}

function validateArchitecturesField(
  obj: Record<string, unknown>,
  errors: ManifestValidationError[],
): void {
  const value = obj.supported_architectures;
  if (!Array.isArray(value)) {
    errors.push({
      code: ManifestErrorCode.INVALID_TYPE,
      field: 'supported_architectures',
      message: "'supported_architectures' must be an array",
    });
    return;
  }
  if (value.length === 0) {
    errors.push({
      code: ManifestErrorCode.INVALID_VALUE,
      field: 'supported_architectures',
      message: "'supported_architectures' must contain at least one architecture",
    });
    return;
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string' || !VALID_ARCHITECTURES.includes(value[i])) {
      errors.push({
        code: ManifestErrorCode.INVALID_VALUE,
        field: `supported_architectures[${i}]`,
        message: `Invalid architecture '${value[i]}'; must be one of: ${VALID_ARCHITECTURES.join(', ')}`,
      });
    }
  }
}

function validateCapabilitiesField(
  obj: Record<string, unknown>,
  errors: ManifestValidationError[],
): void {
  const value = obj.capabilities;
  if (!Array.isArray(value)) {
    errors.push({
      code: ManifestErrorCode.INVALID_TYPE,
      field: 'capabilities',
      message: "'capabilities' must be an array",
    });
    return;
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') {
      errors.push({
        code: ManifestErrorCode.INVALID_TYPE,
        field: `capabilities[${i}]`,
        message: `Each capability must be a string`,
      });
    }
  }
}

function validateReleaseGateEvidenceField(
  obj: Record<string, unknown>,
  errors: ManifestValidationError[],
): void {
  const value = obj.release_gate_evidence_id;
  // May be null (diagnostic builds) or a non-empty string
  if (value !== null && typeof value !== 'string') {
    errors.push({
      code: ManifestErrorCode.INVALID_TYPE,
      field: 'release_gate_evidence_id',
      message: "'release_gate_evidence_id' must be a string or null",
    });
    return;
  }
  // If it's a string, it must be non-empty (empty string is invalid)
  if (typeof value === 'string' && value.length === 0) {
    errors.push({
      code: ManifestErrorCode.INVALID_VALUE,
      field: 'release_gate_evidence_id',
      message: "'release_gate_evidence_id' must be non-empty if provided",
    });
  }
}

function validateArtifactHashesField(
  obj: Record<string, unknown>,
  errors: ManifestValidationError[],
): void {
  const value = obj.artifact_hashes;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push({
      code: ManifestErrorCode.INVALID_TYPE,
      field: 'artifact_hashes',
      message: "'artifact_hashes' must be a non-null object",
    });
    return;
  }
  const hashes = value as Record<string, unknown>;
  for (const [key, hash] of Object.entries(hashes)) {
    if (typeof key !== 'string' || key.length === 0) {
      errors.push({
        code: ManifestErrorCode.INVALID_VALUE,
        field: `artifact_hashes`,
        message: 'Artifact hash keys must be non-empty strings',
      });
    }
    if (typeof hash !== 'string' || hash.length === 0) {
      errors.push({
        code: ManifestErrorCode.INVALID_VALUE,
        field: `artifact_hashes.${key}`,
        message: `Artifact hash for '${key}' must be a non-empty string`,
      });
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Utility — version comparison (duplicated to avoid circular import)
// ────────────────────────────────────────────────────────────────────

/**
 * Compares dotted version strings (e.g., "119.0.2151.0" >= "118.0.2088.0").
 * Returns positive if a > b, 0 if equal, negative if a < b.
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * Computes SHA-256 hex digest of a file.
 */
function sha256File(filePath: string): string | null {
  try {
    const content = readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// Convenience — full pipeline: parse, validate schema, validate bindings
// ────────────────────────────────────────────────────────────────────

/**
 * Parses, validates schema, and validates bindings in one call.
 * Returns the validated manifest or aggregated errors.
 *
 * This is the primary entry point for the runtime probe.
 */
export function loadAndValidateManifest(
  raw: string,
  context: ManifestBindingContext,
): ManifestValidationResult {
  // Step 1: Schema validation
  const schemaResult = deserializeManifest(raw);
  if (!schemaResult.valid) {
    return schemaResult;
  }

  // Step 2: Binding validation
  const bindingResult = validateManifestBindings(schemaResult.manifest, context);
  if (!bindingResult.valid) {
    return { valid: false, errors: bindingResult.errors };
  }

  return { valid: true, manifest: schemaResult.manifest };
}
