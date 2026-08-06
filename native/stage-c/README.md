# Stage C Native Dependency Lock

This directory contains the deterministic dependency lock for the Stage C native build (`ZuleUI.exe`). The lock pins every tool, SDK, and library to exact reviewed versions. No floating ranges, automatic downloads, or alternate compiler fallbacks are permitted.

## Files

| File | Purpose |
|------|---------|
| `dependency-lock.json` | Machine-parseable exact-version inventory for all native dependencies |

## Lock File Structure

### Top-level fields

| Field | Description |
|-------|-------------|
| `lockVersion` | Schema version of this lock file (integer) |
| `generatedAt` | ISO 8601 UTC timestamp when the lock was last regenerated |
| `architecture` | Target CPU architecture (`x64` or `arm64`) |
| `reviewedBy` | Identity of the reviewer who approved the current lock state |
| `reviewDate` | ISO 8601 UTC date the review was completed |
| `notes` | Human-readable context |

### Sections

- **`toolchain`** — Build tools required to compile Stage C (MSVC, MSBuild, Windows SDK)
- **`dependencies`** — Direct SDK/library dependencies (WebView2 SDK)
- **`transitiveDependencies`** — Indirect dependencies pulled in by toolchain or direct deps
- **`ciEnvironment`** — Pinned CI image digest and installed component list
- **`policy`** — Enforcement rules that the toolchain probe and build system check

### Per-item fields

Every locked item records:

| Field | Description |
|-------|-------------|
| `description` | Human-readable purpose |
| `version` | Exact pinned version string (no ranges, no wildcards) |
| `componentIds` | Visual Studio installer component identifiers (where applicable) |
| `packageId` | NuGet or package-manager identifier (where applicable) |
| `source` | Download or acquisition URL |
| `integrity.algorithm` | Hash algorithm (`sha256`) |
| `integrity.digest` | Hex-encoded hash of the artifact |
| `license` | SPDX identifier or license description |
| `architecture` | Supported CPU architecture |
| `reviewStatus` | One of: `approved`, `pending`, `rejected` |
| `transitiveDependencies` | Array of keys into the `transitiveDependencies` section |

## Policy Rules

The `policy` section enforces:

1. **No floating ranges** — Every version must be exact. `^`, `~`, `>=`, `*`, and `latest` are rejected.
2. **No unlisted dependencies** — Any native dependency not present in the lock causes a build failure before compilation.
3. **No auto-download** — The build system and toolchain probe never install, download, upgrade, or fetch missing tools.
4. **No alternate compilers** — No .NET, Rust, MinGW, Clang, or ad-hoc compiler fallback is permitted.
5. **Review required before update** — Changing any version, hash, component, or CI image requires a new review.

## Review Process

When any native dependency changes (version bump, transitive addition, CI image update, or component identifier change), the following review checklist must pass before the lock is updated:

1. **Integrity** — Record the sha256 hash of the exact artifact from the official source.
2. **License** — Confirm the license permits the intended use and redistribution.
3. **Vulnerability** — Check for known CVEs against the exact version.
4. **Publisher** — Verify the artifact is published by the expected party (Microsoft for toolchain/SDK).
5. **Architecture** — Confirm the artifact supports the locked architecture.
6. **Reproducibility** — Verify the CI image produces identical artifacts from identical source.

The reviewer records their identity in `reviewedBy`, the date in `reviewDate`, and sets each item's `reviewStatus` to `approved`. Items with `pending` or `rejected` status prevent production builds.

## Toolchain Probe Integration

The Stage C toolchain probe (`native/stage-c/toolchain-probe.mjs` — Task 16.2) reads this lock file and checks:

1. Every tool in `toolchain` is present on the system at the exact locked version.
2. Every component identifier matches the installed Visual Studio component set.
3. The CI image digest (in CI) matches `ciEnvironment.imageDigest`.
4. No dependency uses a floating range.
5. No dependency is absent from the lock.

If any check fails, the probe returns `UNAVAILABLE`. This is the expected state on developer workstations without Visual Studio Build Tools. JavaScript development, Layer 0, and all non-Stage-C targets continue normally.

## Build System Behavior

- **Toolchain UNAVAILABLE**: JavaScript/TypeScript development works. Layer 0 works. `npm run dev`, `npm run build`, `npm run test` all succeed. Stage C native build, packaging, and production-enablement targets fail closed.
- **Toolchain AVAILABLE**: Stage C builds using only locked versions. The `.vcxproj` references locked SDK and WebView2 paths. Any drift from the lock causes an immediate build failure.

## Relationship to Manifest

The dependency lock hash is included in the `Stage_C_Manifest` (Requirement 14.6). The runtime probe verifies dependency lock integrity as part of its prelaunch checks (Requirement 4.4). This creates a chain: lock → manifest → probe → runtime, ensuring no unlocked dependency reaches a production sidecar.

## Adding arm64 Support

The lock currently pins `x64` only, matching the current Electron distribution. Adding `arm64` requires:

1. A matching Electron `arm64` artifact
2. A separate lock entry or architecture array per item
3. An `arm64` CI image with matching components
4. Full review of arm64-specific dependencies
5. Release gate evidence for the arm64 matrix

## Release runner readiness

The release workflow uses npm, immutable self-hosted Windows VM snapshots, pre-provisioned fixed WebView2 runtimes, real collector executables, and Azure Artifact Signing through GitHub OIDC. Provisioning and registration are documented in [`docs/stage-c-release-runner-setup.md`](../../docs/stage-c-release-runner-setup.md).

`npm run stage-c:verify-toolchain` is the production-strict entry point. It exits nonzero for `pending`, `rejected`, `REVIEW_REQUIRED`, missing/invalid SHA-256 digests, absent reviewer/date, runner-label/image-manifest mismatch, collector-manifest mismatch, missing fixed runtimes, tool version drift, or executable-integrity drift. `npm run stage-c:probe` remains a non-mutating diagnostic that prints the same structured result but exits zero. Neither command installs or downloads anything.

`npm run stage-c:build` invokes `native/stage-c/build-native.mjs`, which runs the strict probe and then builds only `ZuleUI.vcxproj` with package restore disabled and the locked pre-provisioned `WebView2SdkRoot`. The present lock intentionally remains pending, so production build/sign/gate paths remain disabled until external review is complete.