/**
 * Stage C Packaging — Fixed Resource Path Resolution and Package Set Validation.
 *
 * This module defines exact paths under `process.resourcesPath` for each Stage C
 * artifact and validates the complete architecture-matched package set. Layer 0
 * assets remain at their existing `dist/` locations unchanged.
 *
 * Key invariants:
 * - All artifact paths are resolved from `process.resourcesPath` only.
 * - No PATH or CWD lookup is performed.
 * - Sidecar architecture must match App Core architecture.
 * - ZuleUI.exe metadata is independent from Electron executable metadata.
 * - Layer 0 source/runtime assets are retained at their existing locations.
 *
 * Requirements: 14.1–14.4, 14.15–14.16, 18.1
 */

import { accessSync, constants as fsConstants } from 'node:fs';
import { join, isAbsolute } from 'node:path';

import { SupportedArchitecture, STAGE_C_RESOURCES_DIR } from './types';

// ────────────────────────────────────────────────────────────────────
// Stage C Artifact Identifiers
// ────────────────────────────────────────────────────────────────────

/**
 * Enumeration of all Stage C artifact identifiers.
 * Each maps to a fixed relative path under process.resourcesPath.
 */
export enum StageCArtefact {
  /** The signed sidecar binary */
  SIDECAR_BINARY = 'sidecar-binary',
  /** The Stage C manifest (exact-schema JSON) */
  MANIFEST = 'manifest',
  /** The reviewed dependency lock */
  DEPENDENCY_LOCK = 'dependency-lock',
  /** The versioned overlay web assets directory */
  OVERLAY_RESOURCES = 'overlay-resources',
}

// ────────────────────────────────────────────────────────────────────
// Fixed relative paths — resolved from process.resourcesPath only
// ────────────────────────────────────────────────────────────────────

/**
 * Maps each Stage C artifact to its fixed relative path under
 * `process.resourcesPath`. These paths are never derived from
 * PATH, CWD, environment variables, or user input.
 *
 * Requirement 14.2: Resolve every Stage C artifact from
 * `process.resourcesPath` without PATH or working-directory search.
 */
const ARTIFACT_RELATIVE_PATHS: Readonly<Record<StageCArtefact, string>> = {
  [StageCArtefact.SIDECAR_BINARY]: `${STAGE_C_RESOURCES_DIR}/ZuleUI.exe`,
  [StageCArtefact.MANIFEST]: `${STAGE_C_RESOURCES_DIR}/manifest.json`,
  [StageCArtefact.DEPENDENCY_LOCK]: `${STAGE_C_RESOURCES_DIR}/dependency-lock.json`,
  [StageCArtefact.OVERLAY_RESOURCES]: `${STAGE_C_RESOURCES_DIR}/overlay`,
};

// ────────────────────────────────────────────────────────────────────
// Layer 0 paths — retained at existing locations unchanged (Req 18.1)
// ────────────────────────────────────────────────────────────────────

/**
 * Layer 0 assets remain under `dist/` in `process.resourcesPath`.
 * Stage C packaging does not move, rename, or alter these paths.
 */
export const LAYER_0_RELATIVE_PATHS = {
  /** Main renderer HTML */
  rendererHtml: 'dist/index.html',
  /** Preload script */
  preload: 'dist-electron/preload.mjs',
  /** Main process entry */
  mainEntry: 'dist-electron/main.mjs',
} as const;

// ────────────────────────────────────────────────────────────────────
// Path Resolution
// ────────────────────────────────────────────────────────────────────

/**
 * Configuration for the packaging module, allowing dependency injection.
 */
export interface PackagingConfig {
  /** Override process.resourcesPath for testing */
  resourcesPath?: string;
  /** Override process.arch for testing */
  arch?: string;
}

/**
 * Resolves the base resources path.
 * Always returns an absolute path derived from process.resourcesPath.
 * Never uses PATH, CWD, or environment-variable-based discovery.
 *
 * Requirement 14.2: No PATH or CWD lookup.
 */
function getResourcesPath(config?: PackagingConfig): string | null {
  const resourcesPath = config?.resourcesPath
    ?? (process as { resourcesPath?: string }).resourcesPath
    ?? null;

  if (resourcesPath === null || !isAbsolute(resourcesPath)) {
    return null;
  }

  return resourcesPath;
}

/**
 * Resolves the absolute path to a Stage C artifact.
 *
 * All paths are resolved exclusively from `process.resourcesPath`.
 * No PATH, CWD, or environment-variable-based lookup is performed.
 *
 * Requirement 14.2: Resolve every Stage C artifact from
 * `process.resourcesPath` without PATH or working-directory search.
 *
 * @param artifact - The Stage C artifact identifier
 * @param config - Optional configuration override (for testing)
 * @returns The absolute path to the artifact, or null if resourcesPath is unavailable
 */
export function resolveStageCPath(
  artifact: StageCArtefact,
  config?: PackagingConfig,
): string | null {
  const basePath = getResourcesPath(config);
  if (basePath === null) {
    return null;
  }

  const relativePath = ARTIFACT_RELATIVE_PATHS[artifact];
  return join(basePath, relativePath);
}

/**
 * Resolves a Layer 0 asset path from process.resourcesPath.
 * Layer 0 assets are retained at their existing dist/ locations unchanged.
 *
 * Requirement 18.1: Preserve existing Layer 0 source, assets, and runtime.
 *
 * @param assetKey - Key from LAYER_0_RELATIVE_PATHS
 * @param config - Optional configuration override (for testing)
 * @returns The absolute path to the Layer 0 asset, or null
 */
export function resolveLayer0Path(
  assetKey: keyof typeof LAYER_0_RELATIVE_PATHS,
  config?: PackagingConfig,
): string | null {
  const basePath = getResourcesPath(config);
  if (basePath === null) {
    return null;
  }

  return join(basePath, LAYER_0_RELATIVE_PATHS[assetKey]);
}

// ────────────────────────────────────────────────────────────────────
// Architecture Validation
// ────────────────────────────────────────────────────────────────────

/**
 * Maps process.arch to our SupportedArchitecture type.
 * Returns null for unsupported architectures.
 */
function mapArchitecture(arch: string): SupportedArchitecture | null {
  switch (arch) {
    case 'x64': return 'x64';
    case 'arm64': return 'arm64';
    default: return null;
  }
}

/**
 * Validates that the packaged sidecar architecture matches App Core architecture.
 *
 * Requirement 14.3: Include one ZuleUI.exe whose architecture equals
 * each distributed Windows App Core architecture.
 *
 * @param sidecarArchitectures - Architectures supported by the packaged sidecar
 * @param config - Optional configuration override
 * @returns Validation result with typed error
 */
export function validateArchitectureMatch(
  sidecarArchitectures: SupportedArchitecture[],
  config?: PackagingConfig,
): PackageValidationResult {
  const arch = config?.arch ?? process.arch;
  const mappedArch = mapArchitecture(arch);

  if (mappedArch === null) {
    return {
      valid: false,
      errors: [{
        code: PackageErrorCode.ARCHITECTURE_UNSUPPORTED,
        artifact: null,
        message: `App Core architecture '${arch}' is not supported`,
      }],
    };
  }

  if (!sidecarArchitectures.includes(mappedArch)) {
    return {
      valid: false,
      errors: [{
        code: PackageErrorCode.ARCHITECTURE_MISMATCH,
        artifact: StageCArtefact.SIDECAR_BINARY,
        message: `Sidecar does not support App Core architecture '${mappedArch}'`,
      }],
    };
  }

  return { valid: true, errors: [] };
}

// ────────────────────────────────────────────────────────────────────
// Package Set Validation
// ────────────────────────────────────────────────────────────────────

export enum PackageErrorCode {
  /** process.resourcesPath is unavailable or not absolute */
  RESOURCES_PATH_UNAVAILABLE = 'RESOURCES_PATH_UNAVAILABLE',
  /** A required Stage C artifact is missing at the expected path */
  ARTIFACT_MISSING = 'ARTIFACT_MISSING',
  /** A required Layer 0 asset is missing */
  LAYER_0_ASSET_MISSING = 'LAYER_0_ASSET_MISSING',
  /** Sidecar architecture does not match App Core */
  ARCHITECTURE_MISMATCH = 'ARCHITECTURE_MISMATCH',
  /** App Core architecture is not supported */
  ARCHITECTURE_UNSUPPORTED = 'ARCHITECTURE_UNSUPPORTED',
}

export interface PackageValidationError {
  code: PackageErrorCode;
  artifact: StageCArtefact | string | null;
  message: string;
}

export interface PackageValidationResult {
  valid: boolean;
  errors: PackageValidationError[];
}

/**
 * Validates that all required Stage C artifacts exist at their expected
 * fixed paths under process.resourcesPath, and that Layer 0 assets
 * remain in place.
 *
 * This function:
 * - Resolves all paths from process.resourcesPath only (Req 14.2)
 * - Checks Stage C artifact existence
 * - Checks Layer 0 asset existence (Req 18.1)
 * - Does NOT perform PATH or CWD lookup (Req 14.2)
 * - Does NOT download or install anything (Req 14.16)
 *
 * Requirements: 14.1–14.2, 14.15–14.16, 18.1
 *
 * @param config - Optional configuration override
 * @returns Validation result listing all missing artifacts/assets
 */
export function validatePackageSet(config?: PackagingConfig): PackageValidationResult {
  const errors: PackageValidationError[] = [];

  // 1. Verify resourcesPath is available and absolute
  const basePath = getResourcesPath(config);
  if (basePath === null) {
    return {
      valid: false,
      errors: [{
        code: PackageErrorCode.RESOURCES_PATH_UNAVAILABLE,
        artifact: null,
        message: 'process.resourcesPath is unavailable or not an absolute path',
      }],
    };
  }

  // 2. Check all Stage C artifacts exist
  for (const artifact of Object.values(StageCArtefact)) {
    const relativePath = ARTIFACT_RELATIVE_PATHS[artifact];
    const absolutePath = join(basePath, relativePath);

    // For directory artifacts (overlay/), check directory existence
    // For file artifacts, check file existence
    try {
      accessSync(absolutePath, fsConstants.R_OK);
    } catch {
      errors.push({
        code: PackageErrorCode.ARTIFACT_MISSING,
        artifact,
        message: `Stage C artifact missing at '${STAGE_C_RESOURCES_DIR}/${relativePath.replace(`${STAGE_C_RESOURCES_DIR}/`, '')}'`,
      });
    }
  }

  // 3. Check Layer 0 assets are retained (Req 18.1)
  for (const [key, relativePath] of Object.entries(LAYER_0_RELATIVE_PATHS)) {
    const absolutePath = join(basePath, relativePath);
    try {
      accessSync(absolutePath, fsConstants.R_OK);
    } catch {
      errors.push({
        code: PackageErrorCode.LAYER_0_ASSET_MISSING,
        artifact: key,
        message: `Layer 0 asset missing at '${relativePath}'`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ────────────────────────────────────────────────────────────────────
// Metadata Independence
// ────────────────────────────────────────────────────────────────────

/**
 * Metadata identity for the Stage C sidecar binary.
 * These values are independent from Electron executable metadata (Req 14.15).
 * They are truthful and Zule-owned (Req 2.1–2.3).
 */
export const SIDECAR_METADATA = {
  originalFilename: 'ZuleUI.exe',
  companyName: 'Zule AI',
  productName: 'Zule AI',
  internalName: 'ZuleUI',
  fileDescription: 'Zule UI Presentation Sidecar',
} as const;

/**
 * Returns the fixed relative paths for all Stage C artifacts.
 * Useful for build tooling that assembles the package set.
 */
export function getArtifactRelativePaths(): Readonly<Record<StageCArtefact, string>> {
  return ARTIFACT_RELATIVE_PATHS;
}

/**
 * Returns the Stage C resources subdirectory name.
 */
export function getStageCResourcesDir(): string {
  return STAGE_C_RESOURCES_DIR;
}
