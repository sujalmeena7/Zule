/**
 * Stage C Updater — Atomic Staging, Activation, and Rollback.
 *
 * This module implements complete-set atomic update semantics for Stage C:
 * - stageUpdate: Validates and stages all artifacts as one atomic transaction.
 * - activateUpdate: Activates the staged set ONLY while App Core/sidecar are stopped.
 * - rollbackUpdate: Restores the prior verified set on activation failure,
 *   independent of sidecar version (Layer 0 can always recover).
 *
 * Transaction semantics:
 * - Either all artifacts are installed or none are (no partial update state).
 * - Partial validation failure discards the staged set; installed set remains active.
 * - Activation failure triggers automatic rollback to the prior verified set.
 *
 * Requirements: 14.9–14.14
 */

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

/**
 * Result of staging a complete update set.
 */
export interface UpdateStageResult {
  /** Whether the complete set was successfully staged */
  staged: boolean;
  /** Validation or staging errors encountered */
  errors: string[];
  /** Path to the staged set (null on failure) */
  stagedPath: string | null;
}

/**
 * Result of activating a staged update set.
 */
export interface UpdateActivationResult {
  /** Whether the staged set was successfully activated */
  activated: boolean;
  /** Activation errors encountered */
  errors: string[];
  /** Whether a rollback was performed after activation failure */
  rolledBack: boolean;
}

/**
 * Filesystem abstraction for dependency injection in testing.
 */
export interface UpdaterFileSystem {
  /** Check if a path exists */
  exists(path: string): boolean;
  /** Read file contents as a buffer */
  readFile(path: string): Buffer | null;
  /** Copy a directory recursively (source → destination) */
  copyDir(source: string, destination: string): boolean;
  /** Remove a directory recursively */
  removeDir(path: string): boolean;
  /** Rename/move a directory atomically */
  renameDir(source: string, destination: string): boolean;
  /** List files recursively under a path */
  listFiles(path: string): string[];
  /** Compute SHA-256 hash of a file */
  hashFile(path: string): string | null;
}

/**
 * Injected dependencies for the updater.
 */
export interface UpdaterDeps {
  /** Filesystem operations (injectable for testing) */
  fileSystem: UpdaterFileSystem;
  /** Check whether App Core is currently stopped */
  isAppCoreStopped(): boolean;
  /** Check whether the sidecar is currently stopped */
  isSidecarStopped(): boolean;
  /** Base path for the active (installed) package set */
  activeSetPath: string;
  /** Base path for the staged (pending) package set */
  stagingPath: string;
  /** Base path for the backup (prior verified) package set */
  backupPath: string;
  /** Expected publisher for manifest verification */
  expectedPublisher: string;
}

// ────────────────────────────────────────────────────────────────────
// Required artifacts for a complete package set
// ────────────────────────────────────────────────────────────────────

/** Required Stage C artifacts */
const REQUIRED_STAGE_C_ARTIFACTS = [
  'stage-c/ZuleUI.exe',
  'stage-c/manifest.json',
  'stage-c/dependency-lock.json',
  'stage-c/overlay',
] as const;

/** Required Layer 0 assets (must be retained) */
const REQUIRED_LAYER_0_ASSETS = [
  'dist/index.html',
  'dist-electron/preload.mjs',
  'dist-electron/main.mjs',
] as const;

// ────────────────────────────────────────────────────────────────────
// Internal State
// ────────────────────────────────────────────────────────────────────

/**
 * Tracks the current updater state to prevent concurrent operations.
 */
export enum UpdaterPhase {
  IDLE = 'IDLE',
  STAGING = 'STAGING',
  ACTIVATING = 'ACTIVATING',
  ROLLING_BACK = 'ROLLING_BACK',
}

// ────────────────────────────────────────────────────────────────────
// Updater Implementation
// ────────────────────────────────────────────────────────────────────

/**
 * Stage C Updater — atomic package set staging, activation, and rollback.
 *
 * Requirement 14.9: Stage the complete version-matched package set as one atomic transaction.
 * Requirement 14.10: Verify every required artifact before activation.
 * Requirement 14.11: Leave installed set active on validation failure.
 * Requirement 14.12: Replace atomically while App Core and sidecar are stopped.
 * Requirement 14.13: Restore previously verified set on activation failure.
 * Requirement 14.14: Rollback restores App Core + Layer 0 without depending on older sidecar.
 */
export class StageCUpdater {
  private phase: UpdaterPhase = UpdaterPhase.IDLE;
  private readonly deps: UpdaterDeps;

  constructor(deps: UpdaterDeps) {
    this.deps = deps;
  }

  /**
   * Returns the current updater phase.
   */
  getPhase(): UpdaterPhase {
    return this.phase;
  }

  /**
   * Stage a complete update set as one atomic transaction.
   *
   * Validates ALL artifacts in the new set before accepting the staged copy.
   * If any artifact fails validation, the staged set is discarded entirely
   * and the currently installed set remains active.
   *
   * Requirement 14.9: Stage the complete version-matched package set as one
   * atomic transaction.
   * Requirement 14.10: Verify every required artifact, architecture, hash,
   * signature, publisher, version, protocol, bridge schema, dependency lock,
   * release evidence, and Layer 0 asset before activation.
   * Requirement 14.11: If staged transaction is partial, missing, mismatched,
   * unsigned, invalid, or indeterminate, leave the installed set active.
   *
   * @param newSetPath - Path to the new complete package set to stage
   * @returns Staging result with success state, errors, and staged path
   */
  stageUpdate(newSetPath: string): UpdateStageResult {
    if (this.phase !== UpdaterPhase.IDLE) {
      return {
        staged: false,
        errors: [`Cannot stage while updater is in phase: ${this.phase}`],
        stagedPath: null,
      };
    }

    this.phase = UpdaterPhase.STAGING;
    const errors: string[] = [];

    try {
      const { fileSystem, stagingPath } = this.deps;

      // Step 1: Verify the new set path exists
      if (!fileSystem.exists(newSetPath)) {
        errors.push('New package set path does not exist');
        return { staged: false, errors, stagedPath: null };
      }

      // Step 2: Validate all required artifacts are present
      const presenceErrors = this.validateArtifactPresence(newSetPath);
      if (presenceErrors.length > 0) {
        errors.push(...presenceErrors);
        return { staged: false, errors, stagedPath: null };
      }

      // Step 3: Verify the manifest is valid and parseable
      const manifestErrors = this.validateManifest(newSetPath);
      if (manifestErrors.length > 0) {
        errors.push(...manifestErrors);
        return { staged: false, errors, stagedPath: null };
      }

      // Step 4: Verify all artifact hashes match the manifest
      const hashErrors = this.verifyAllArtifactHashes(newSetPath);
      if (hashErrors.length > 0) {
        errors.push(...hashErrors);
        return { staged: false, errors, stagedPath: null };
      }

      // Step 5: Clean any previously failed staging directory
      if (fileSystem.exists(stagingPath)) {
        if (!fileSystem.removeDir(stagingPath)) {
          errors.push('Failed to clean previous staging directory');
          return { staged: false, errors, stagedPath: null };
        }
      }

      // Step 6: Copy the complete new set to staging atomically
      if (!fileSystem.copyDir(newSetPath, stagingPath)) {
        errors.push('Failed to copy package set to staging directory');
        // Clean up partial staging on failure
        fileSystem.removeDir(stagingPath);
        return { staged: false, errors, stagedPath: null };
      }

      // Step 7: Re-verify the staged copy (integrity after copy)
      const stagedHashErrors = this.verifyAllArtifactHashes(stagingPath);
      if (stagedHashErrors.length > 0) {
        errors.push(...stagedHashErrors.map((e) => `Post-copy verification: ${e}`));
        // Discard the staged set — it failed post-copy verification
        fileSystem.removeDir(stagingPath);
        return { staged: false, errors, stagedPath: null };
      }

      return { staged: true, errors: [], stagedPath: stagingPath };
    } finally {
      this.phase = UpdaterPhase.IDLE;
    }
  }

  /**
   * Activate a previously staged and verified update set.
   *
   * Activation ONLY proceeds while both App Core and sidecar are stopped.
   * Re-verifies the manifest and all hashes before committing activation.
   * On activation failure, automatically rolls back to the prior verified set.
   *
   * Requirement 14.12: Replace the complete package set atomically while
   * App Core and sidecar are stopped.
   * Requirement 14.13: If atomic activation fails, restore the previously
   * verified complete package set before application startup.
   *
   * @param stagedPath - Path to the staged verified set to activate
   * @returns Activation result with success state, errors, and rollback status
   */
  activateUpdate(stagedPath: string): UpdateActivationResult {
    if (this.phase !== UpdaterPhase.IDLE) {
      return {
        activated: false,
        errors: [`Cannot activate while updater is in phase: ${this.phase}`],
        rolledBack: false,
      };
    }

    this.phase = UpdaterPhase.ACTIVATING;
    const errors: string[] = [];

    try {
      const { fileSystem, activeSetPath, backupPath } = this.deps;

      // Gate: Both App Core and sidecar must be stopped
      if (!this.deps.isAppCoreStopped()) {
        errors.push('Cannot activate update: App Core is still running');
        return { activated: false, errors, rolledBack: false };
      }

      if (!this.deps.isSidecarStopped()) {
        errors.push('Cannot activate update: Sidecar is still running');
        return { activated: false, errors, rolledBack: false };
      }

      // Step 1: Verify the staged path exists
      if (!fileSystem.exists(stagedPath)) {
        errors.push('Staged package set path does not exist');
        return { activated: false, errors, rolledBack: false };
      }

      // Step 2: Re-verify manifest and all hashes before committing
      const manifestErrors = this.validateManifest(stagedPath);
      if (manifestErrors.length > 0) {
        errors.push(...manifestErrors.map((e) => `Pre-activation: ${e}`));
        return { activated: false, errors, rolledBack: false };
      }

      const hashErrors = this.verifyAllArtifactHashes(stagedPath);
      if (hashErrors.length > 0) {
        errors.push(...hashErrors.map((e) => `Pre-activation hash: ${e}`));
        return { activated: false, errors, rolledBack: false };
      }

      // Step 3: Backup the current active set
      if (fileSystem.exists(activeSetPath)) {
        // Clean previous backup if it exists
        if (fileSystem.exists(backupPath)) {
          fileSystem.removeDir(backupPath);
        }
        if (!fileSystem.renameDir(activeSetPath, backupPath)) {
          errors.push('Failed to backup current active set');
          return { activated: false, errors, rolledBack: false };
        }
      }

      // Step 4: Atomically move staged set to active
      if (!fileSystem.renameDir(stagedPath, activeSetPath)) {
        errors.push('Failed to move staged set to active path');
        // Activation failed — rollback
        const rollbackResult = this.performRollback(errors);
        return {
          activated: false,
          errors,
          rolledBack: rollbackResult,
        };
      }

      // Step 5: Final verification of the activated set
      const finalHashErrors = this.verifyAllArtifactHashes(activeSetPath);
      if (finalHashErrors.length > 0) {
        errors.push(
          ...finalHashErrors.map((e) => `Post-activation verification: ${e}`),
        );
        // Activation verification failed — rollback
        const rollbackResult = this.performRollback(errors);
        return {
          activated: false,
          errors,
          rolledBack: rollbackResult,
        };
      }

      return { activated: true, errors: [], rolledBack: false };
    } finally {
      this.phase = UpdaterPhase.IDLE;
    }
  }

  /**
   * Rollback to the prior verified package set.
   *
   * This operation is independent of the sidecar version — Layer 0 can
   * always recover even without a matching sidecar installed.
   *
   * Requirement 14.13: Restore the previously verified complete package set
   * before application startup.
   * Requirement 14.14: Rollback restores a version-matched App Core and Layer 0
   * without depending on an older sidecar remaining installed.
   *
   * @returns Activation result indicating rollback success
   */
  rollbackUpdate(): UpdateActivationResult {
    if (this.phase !== UpdaterPhase.IDLE) {
      return {
        activated: false,
        errors: [`Cannot rollback while updater is in phase: ${this.phase}`],
        rolledBack: false,
      };
    }

    this.phase = UpdaterPhase.ROLLING_BACK;
    const errors: string[] = [];

    try {
      const rollbackResult = this.performRollback(errors);
      return {
        activated: false,
        errors,
        rolledBack: rollbackResult,
      };
    } finally {
      this.phase = UpdaterPhase.IDLE;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * Performs the actual rollback: restores backup to active path.
   *
   * Rollback is independent of the sidecar — it restores App Core + Layer 0
   * which can operate without a matching sidecar (Req 14.14).
   */
  private performRollback(errors: string[]): boolean {
    const previousPhase = this.phase;
    this.phase = UpdaterPhase.ROLLING_BACK;

    try {
      const { fileSystem, activeSetPath, backupPath } = this.deps;

      if (!fileSystem.exists(backupPath)) {
        errors.push('Rollback failed: no backup set available');
        return false;
      }

      // Remove the failed active set if it exists
      if (fileSystem.exists(activeSetPath)) {
        if (!fileSystem.removeDir(activeSetPath)) {
          errors.push('Rollback failed: could not remove failed active set');
          return false;
        }
      }

      // Restore backup to active
      if (!fileSystem.renameDir(backupPath, activeSetPath)) {
        errors.push('Rollback failed: could not restore backup to active path');
        return false;
      }

      return true;
    } finally {
      this.phase = previousPhase;
    }
  }

  /**
   * Validates that all required artifacts are present at the given base path.
   */
  private validateArtifactPresence(basePath: string): string[] {
    const { fileSystem } = this.deps;
    const errors: string[] = [];

    for (const artifact of REQUIRED_STAGE_C_ARTIFACTS) {
      const fullPath = `${basePath}/${artifact}`;
      if (!fileSystem.exists(fullPath)) {
        errors.push(`Missing required Stage C artifact: ${artifact}`);
      }
    }

    for (const asset of REQUIRED_LAYER_0_ASSETS) {
      const fullPath = `${basePath}/${asset}`;
      if (!fileSystem.exists(fullPath)) {
        errors.push(`Missing required Layer 0 asset: ${asset}`);
      }
    }

    return errors;
  }

  /**
   * Validates the manifest at the given path is parseable and has required fields.
   */
  private validateManifest(basePath: string): string[] {
    const { fileSystem } = this.deps;
    const errors: string[] = [];
    const manifestPath = `${basePath}/stage-c/manifest.json`;
    const manifestBuffer = fileSystem.readFile(manifestPath);

    if (!manifestBuffer) {
      errors.push('Cannot read manifest file');
      return errors;
    }

    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(manifestBuffer.toString('utf8'));
    } catch {
      errors.push('Cannot parse manifest JSON');
      return errors;
    }

    // Validate required fields
    const requiredFields = [
      'app_version',
      'sidecar_version',
      'protocol_major',
      'protocol_minor',
      'bridge_schema_version',
      'supported_architectures',
      'minimum_webview2_version',
      'capabilities',
      'dependency_lock_hash',
      'sidecar_path',
      'artifact_hashes',
      'publisher',
    ];

    for (const field of requiredFields) {
      if (!(field in manifest)) {
        errors.push(`Manifest missing required field: ${field}`);
      }
    }

    // Validate publisher matches expected
    if (manifest.publisher && manifest.publisher !== this.deps.expectedPublisher) {
      errors.push(
        `Manifest publisher '${manifest.publisher}' does not match expected '${this.deps.expectedPublisher}'`,
      );
    }

    // Validate artifact_hashes is a non-empty object
    if (manifest.artifact_hashes) {
      if (
        typeof manifest.artifact_hashes !== 'object' ||
        Object.keys(manifest.artifact_hashes as object).length === 0
      ) {
        errors.push('Manifest artifact_hashes must be a non-empty object');
      }
    }

    return errors;
  }

  /**
   * Verifies all artifact hashes in the package set at the given path.
   * Returns an array of error messages (empty on success).
   */
  private verifyAllArtifactHashes(basePath: string): string[] {
    const { fileSystem } = this.deps;
    const errors: string[] = [];

    // Read manifest to get expected hashes
    const manifestPath = `${basePath}/stage-c/manifest.json`;
    const manifestBuffer = fileSystem.readFile(manifestPath);

    if (!manifestBuffer) {
      errors.push('Cannot read manifest for hash verification');
      return errors;
    }

    let manifest: { artifact_hashes?: Record<string, string> };
    try {
      manifest = JSON.parse(manifestBuffer.toString('utf8'));
    } catch {
      errors.push('Cannot parse manifest JSON for hash verification');
      return errors;
    }

    if (!manifest.artifact_hashes || typeof manifest.artifact_hashes !== 'object') {
      errors.push('Manifest missing artifact_hashes');
      return errors;
    }

    // Verify each declared artifact hash
    for (const [relativePath, expectedHash] of Object.entries(manifest.artifact_hashes)) {
      const artifactPath = `${basePath}/${relativePath}`;
      const actualHash = fileSystem.hashFile(artifactPath);

      if (actualHash === null) {
        errors.push(`Artifact not found: ${relativePath}`);
      } else if (actualHash !== expectedHash) {
        errors.push(
          `Hash mismatch for ${relativePath}: expected ${expectedHash.slice(0, 16)}..., got ${actualHash.slice(0, 16)}...`,
        );
      }
    }

    return errors;
  }
}
