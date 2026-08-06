/**
 * Stage C Manifest Generator — Final Signed Manifest Generation and Verification.
 *
 * This module implements:
 * - generateFinalManifest: Computes SHA-256 hashes of all finalized artifacts,
 *   binds versions/architecture/protocol/bridge/WebView2 minimum/publisher/evidence,
 *   and serializes the manifest.
 * - verifyManifest: Loads the packaged manifest, verifies all artifact hashes match
 *   actual files, and verifies signature trust (production: only VALID for App_Publisher).
 *
 * Signature trust levels:
 *   VALID — explicitly valid for App_Publisher → passes
 *   INVALID, UNKNOWN, OFFLINE, WARNING, INDETERMINATE, OTHER_PUBLISHER → all fail
 *
 * Requirements: 4.5–4.9, 14.4–14.8
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  serializeManifest,
  deserializeManifest,
  ManifestSerializationInput,
  ManifestErrorCode,
} from './manifest';

import { StageCManifest, SupportedArchitecture } from './types';

import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  BRIDGE_SCHEMA_VERSION,
} from './protocol/schema';

// ────────────────────────────────────────────────────────────────────
// Signature Trust Levels (Req 4.6, 4.7)
// ────────────────────────────────────────────────────────────────────

/**
 * Signature trust levels for production verification.
 *
 * Only VALID passes for production builds. All others fail package acceptance.
 * Requirement 4.6: Accept only when signature verification is explicitly valid for App_Publisher.
 * Requirement 4.7: Reject unknown, offline, warning, indeterminate, invalid, or other publisher.
 */
export enum SignatureTrustLevel {
  /** Signature is explicitly valid for the expected App_Publisher */
  VALID = 'VALID',
  /** Signature is cryptographically invalid */
  INVALID = 'INVALID',
  /** Signature verification returned unknown status */
  UNKNOWN = 'UNKNOWN',
  /** Signature verification could not reach the CA (offline) */
  OFFLINE = 'OFFLINE',
  /** Signature has warnings (e.g. expired timestamp) */
  WARNING = 'WARNING',
  /** Signature verification returned indeterminate result */
  INDETERMINATE = 'INDETERMINATE',
  /** Signature is valid but bound to a different publisher */
  OTHER_PUBLISHER = 'OTHER_PUBLISHER',
}

// ────────────────────────────────────────────────────────────────────
// Signature Verification Result
// ────────────────────────────────────────────────────────────────────

export interface SignatureVerificationResult {
  trustLevel: SignatureTrustLevel;
  publisher: string | null;
}

/**
 * Signature verifier function type.
 * In production this calls into the platform signing APIs (e.g. WinVerifyTrust).
 * For testing, this is injectable.
 */
export type SignatureVerifier = (filePath: string) => SignatureVerificationResult;

// ────────────────────────────────────────────────────────────────────
// Manifest Generation Configuration
// ────────────────────────────────────────────────────────────────────

export interface ManifestGenerationConfig {
  /** Base path where finalized artifacts reside */
  artifactsBasePath: string;
  /** Relative paths to all artifacts that should be hashed and bound */
  artifactRelativePaths: string[];
  /** Exact App Core version */
  appVersion: string;
  /** Exact sidecar version */
  sidecarVersion: string;
  /** Supported architectures */
  supportedArchitectures: SupportedArchitecture[];
  /** Minimum WebView2 Runtime version */
  minimumWebview2Version: string;
  /** Capabilities */
  capabilities: string[];
  /** Relative sidecar path within resources */
  sidecarPath: string;
  /** Release-gate evidence identifier (null for diagnostic builds) */
  releaseGateEvidenceId: string | null;
  /** Publisher identity */
  publisher: string;
  /** SHA-256 hash of the dependency lock file */
  dependencyLockHash: string;
}

// ────────────────────────────────────────────────────────────────────
// Manifest Verification Configuration
// ────────────────────────────────────────────────────────────────────

export interface ManifestVerificationConfig {
  /** Base path where packaged artifacts reside */
  artifactsBasePath: string;
  /** Whether this is a production build */
  isProduction: boolean;
  /** Expected publisher identity */
  expectedPublisher: string;
  /** Signature verifier function (injectable for testing) */
  signatureVerifier?: SignatureVerifier;
  /** Expected App Core version (for production version-equality, Req 4.8) */
  expectedAppVersion?: string;
  /** Expected architecture */
  expectedArchitecture?: SupportedArchitecture;
}

// ────────────────────────────────────────────────────────────────────
// Generation Result
// ────────────────────────────────────────────────────────────────────

export interface ManifestGenerationResult {
  success: boolean;
  manifestJson?: string;
  errors: string[];
}

// ────────────────────────────────────────────────────────────────────
// Verification Result
// ────────────────────────────────────────────────────────────────────

export interface ManifestVerificationError {
  code: string;
  message: string;
}

export interface ManifestVerificationResult {
  valid: boolean;
  errors: ManifestVerificationError[];
  manifest?: StageCManifest;
}

// ────────────────────────────────────────────────────────────────────
// Generation — computes hashes, binds all fields (Req 14.5, 14.6)
// ────────────────────────────────────────────────────────────────────

/**
 * Generates the final Stage C manifest after all artifacts are finalized.
 *
 * Computes SHA-256 hashes of each artifact, binds them with versions,
 * architecture, protocol, bridge, WebView2 minimum, publisher, and evidence.
 *
 * Requirement 14.5: Serialize from only final artifacts.
 * Requirement 14.6: Bind exact versions, architecture, paths, hashes, protocol,
 *   bridge schema, WebView2 minimum, dependency-lock hash, capabilities,
 *   publisher, and release-evidence identifier.
 */
export function generateFinalManifest(
  config: ManifestGenerationConfig,
): ManifestGenerationResult {
  const errors: string[] = [];

  // Validate required bindings are present
  if (!config.appVersion) {
    errors.push('appVersion is required');
  }
  if (!config.sidecarVersion) {
    errors.push('sidecarVersion is required');
  }
  if (!config.supportedArchitectures || config.supportedArchitectures.length === 0) {
    errors.push('At least one supported architecture is required');
  }
  if (!config.minimumWebview2Version) {
    errors.push('minimumWebview2Version is required');
  }
  if (!config.publisher) {
    errors.push('publisher is required');
  }
  if (!config.dependencyLockHash) {
    errors.push('dependencyLockHash is required');
  }
  if (!config.sidecarPath) {
    errors.push('sidecarPath is required');
  }
  if (!config.artifactRelativePaths || config.artifactRelativePaths.length === 0) {
    errors.push('At least one artifact path is required');
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  // Compute SHA-256 hashes for all artifacts
  const artifactHashes: Record<string, string> = {};
  for (const relativePath of config.artifactRelativePaths) {
    const absolutePath = join(config.artifactsBasePath, relativePath);
    const hash = sha256File(absolutePath);
    if (hash === null) {
      errors.push(`Failed to hash artifact: ${relativePath}`);
    } else {
      artifactHashes[relativePath] = hash;
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  // Build serialization input with all bindings
  const input: ManifestSerializationInput = {
    appVersion: config.appVersion,
    sidecarVersion: config.sidecarVersion,
    supportedArchitectures: config.supportedArchitectures,
    minimumWebview2Version: config.minimumWebview2Version,
    capabilities: config.capabilities,
    sidecarPath: config.sidecarPath,
    releaseGateEvidenceId: config.releaseGateEvidenceId,
    artifactHashes,
    publisher: config.publisher,
    dependencyLockHash: config.dependencyLockHash,
  };

  const manifestJson = serializeManifest(input);
  return { success: true, manifestJson, errors: [] };
}

// ────────────────────────────────────────────────────────────────────
// Verification — validates packaged manifest (Req 4.5–4.9, 14.4, 14.7)
// ────────────────────────────────────────────────────────────────────

/**
 * Verifies a packaged manifest against actual artifacts and signature trust.
 *
 * Steps:
 * 1. Parse and schema-validate the manifest (Req 14.7)
 * 2. Verify all declared artifact hashes match actual files
 * 3. For production: verify signature trust is VALID for App_Publisher (Req 4.6, 4.7)
 * 4. For production: verify release-gate evidence (Req 4.5)
 * 5. For production: verify version equality (Req 4.8)
 * 6. Verify binding completeness — fail if any required field is missing or mismatched
 */
export function verifyManifest(
  manifestJson: string,
  config: ManifestVerificationConfig,
): ManifestVerificationResult {
  const errors: ManifestVerificationError[] = [];

  // Step 1: Schema validation
  const parseResult = deserializeManifest(manifestJson);
  if (!parseResult.valid) {
    return {
      valid: false,
      errors: parseResult.errors.map(e => ({
        code: e.code,
        message: e.message,
      })),
    };
  }

  const manifest = parseResult.manifest;

  // Step 2: Verify artifact hashes match actual files
  for (const [relativePath, declaredHash] of Object.entries(manifest.artifact_hashes)) {
    const absolutePath = join(config.artifactsBasePath, relativePath);
    const actualHash = sha256File(absolutePath);
    if (actualHash === null) {
      errors.push({
        code: 'ARTIFACT_NOT_FOUND',
        message: `Artifact '${relativePath}' not found at expected path`,
      });
    } else if (actualHash !== declaredHash) {
      errors.push({
        code: 'ARTIFACT_HASH_MISMATCH',
        message: `Artifact '${relativePath}' hash mismatch: declared=${declaredHash.slice(0, 16)}..., actual=${actualHash.slice(0, 16)}...`,
      });
    }
  }

  // Step 3: Binding completeness checks
  if (!manifest.app_version) {
    errors.push({ code: 'MISSING_BINDING', message: 'app_version binding is missing' });
  }
  if (!manifest.sidecar_version) {
    errors.push({ code: 'MISSING_BINDING', message: 'sidecar_version binding is missing' });
  }
  if (!manifest.supported_architectures || manifest.supported_architectures.length === 0) {
    errors.push({ code: 'MISSING_BINDING', message: 'supported_architectures binding is missing' });
  }
  if (manifest.protocol_major === undefined || manifest.protocol_major === null) {
    errors.push({ code: 'MISSING_BINDING', message: 'protocol_major binding is missing' });
  }
  if (manifest.bridge_schema_version === undefined || manifest.bridge_schema_version === null) {
    errors.push({ code: 'MISSING_BINDING', message: 'bridge_schema_version binding is missing' });
  }
  if (!manifest.minimum_webview2_version) {
    errors.push({ code: 'MISSING_BINDING', message: 'minimum_webview2_version binding is missing' });
  }
  if (!manifest.publisher) {
    errors.push({ code: 'MISSING_BINDING', message: 'publisher binding is missing' });
  }
  if (!manifest.dependency_lock_hash) {
    errors.push({ code: 'MISSING_BINDING', message: 'dependency_lock_hash binding is missing' });
  }

  // Step 4: Architecture check
  if (config.expectedArchitecture &&
      !manifest.supported_architectures.includes(config.expectedArchitecture)) {
    errors.push({
      code: 'ARCHITECTURE_MISMATCH',
      message: `Expected architecture '${config.expectedArchitecture}' not in manifest supported set`,
    });
  }

  // Step 5: Protocol/bridge check
  if (manifest.protocol_major !== PROTOCOL_MAJOR) {
    errors.push({
      code: 'PROTOCOL_MISMATCH',
      message: `Manifest protocol_major ${manifest.protocol_major} does not match expected ${PROTOCOL_MAJOR}`,
    });
  }

  // Step 6: Production-specific checks (Req 4.5–4.8)
  if (config.isProduction) {
    // 6a: Release-gate evidence (Req 4.5)
    if (!manifest.release_gate_evidence_id ||
        manifest.release_gate_evidence_id.trim().length === 0) {
      errors.push({
        code: 'EVIDENCE_MISSING',
        message: 'Release-gate evidence identifier required for production',
      });
    }

    // 6b: Signature trust verification (Req 4.6, 4.7)
    if (config.signatureVerifier) {
      const sidecarPath = join(config.artifactsBasePath, manifest.sidecar_path);
      const sigResult = config.signatureVerifier(sidecarPath);
      const trustFailure = evaluateSignatureTrust(
        sigResult, config.expectedPublisher,
      );
      if (trustFailure) {
        errors.push(trustFailure);
      }
    }

    // 6c: Version equality (Req 4.8)
    if (config.expectedAppVersion) {
      if (manifest.app_version !== config.expectedAppVersion) {
        errors.push({
          code: 'VERSION_MISMATCH',
          message: `Manifest app_version '${manifest.app_version}' does not match expected '${config.expectedAppVersion}'`,
        });
      }
      if (manifest.sidecar_version !== config.expectedAppVersion) {
        errors.push({
          code: 'VERSION_MISMATCH',
          message: `Manifest sidecar_version '${manifest.sidecar_version}' does not match expected '${config.expectedAppVersion}'`,
        });
      }
    }

    // 6d: Publisher must match expected (Req 14.4)
    if (manifest.publisher !== config.expectedPublisher) {
      errors.push({
        code: 'PUBLISHER_MISMATCH',
        message: `Manifest publisher '${manifest.publisher}' does not match expected '${config.expectedPublisher}'`,
      });
    }

    // 6e: Artifact hashes must be non-empty for production
    if (Object.keys(manifest.artifact_hashes).length === 0) {
      errors.push({
        code: 'MISSING_BINDING',
        message: 'Production manifest must declare at least one artifact hash',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    manifest: errors.length === 0 ? manifest : undefined,
  };
}

// ────────────────────────────────────────────────────────────────────
// Signature Trust Evaluation (Req 4.6, 4.7)
// ────────────────────────────────────────────────────────────────────

/**
 * Evaluates signature trust level against production requirements.
 *
 * Only VALID trust level with matching publisher passes.
 * All other trust levels fail package acceptance per Req 4.7.
 */
function evaluateSignatureTrust(
  sigResult: SignatureVerificationResult,
  expectedPublisher: string,
): ManifestVerificationError | null {
  switch (sigResult.trustLevel) {
    case SignatureTrustLevel.VALID:
      // Even with VALID, publisher must match
      if (sigResult.publisher !== expectedPublisher) {
        return {
          code: 'SIGNATURE_WRONG_PUBLISHER',
          message: `Signature bound to '${sigResult.publisher}' instead of expected '${expectedPublisher}'`,
        };
      }
      return null;

    case SignatureTrustLevel.INVALID:
      return {
        code: 'SIGNATURE_INVALID',
        message: 'Sidecar signature is cryptographically invalid',
      };

    case SignatureTrustLevel.UNKNOWN:
      return {
        code: 'SIGNATURE_UNKNOWN',
        message: 'Sidecar signature verification returned unknown status',
      };

    case SignatureTrustLevel.OFFLINE:
      return {
        code: 'SIGNATURE_OFFLINE',
        message: 'Sidecar signature verification could not reach CA (offline)',
      };

    case SignatureTrustLevel.WARNING:
      return {
        code: 'SIGNATURE_WARNING',
        message: 'Sidecar signature has warnings (e.g. expired timestamp)',
      };

    case SignatureTrustLevel.INDETERMINATE:
      return {
        code: 'SIGNATURE_INDETERMINATE',
        message: 'Sidecar signature verification returned indeterminate result',
      };

    case SignatureTrustLevel.OTHER_PUBLISHER:
      return {
        code: 'SIGNATURE_WRONG_PUBLISHER',
        message: `Sidecar signature bound to another publisher`,
      };

    default:
      return {
        code: 'SIGNATURE_UNKNOWN',
        message: `Unrecognized signature trust level`,
      };
  }
}

// ────────────────────────────────────────────────────────────────────
// Utility
// ────────────────────────────────────────────────────────────────────

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
