# Stage C release runners and Azure signing

Stage C release CI runs only on customer-managed, immutable, self-hosted Windows x64 VM snapshots. The committed dependency lock is intentionally `pending` and contains `REVIEW_REQUIRED` integrity values, so the workflow currently fails closed. Do not replace those values until the artifacts and VM images have completed the lock review documented in `native/stage-c/README.md`.

## Required immutable snapshots

Create three independently versioned snapshots and register only disposable clones:

| OS snapshot | Required GitHub labels | Purpose |
|---|---|---|
| Windows 10 22H2 (19045) | `self-hosted`, `Windows`, `X64`, `stage-c-win10-22h2-v1` | Gate rows only |
| Windows 11 23H2 (22631) | `self-hosted`, `Windows`, `X64`, `stage-c-win11-23h2-v1` | Gate rows only |
| Windows 11 24H2 (26100) | `self-hosted`, `Windows`, `X64`, `stage-c-win11-24h2-v1` | Build/sign/assemble and gate rows |

The `v1` suffix identifies snapshot content, not a mutable pool. Any OS patch, tool, runtime, collector, or image change requires a new label and dependency-lock review. Never reuse a label for changed bits.

Each snapshot must preinstall, without workflow-time restoration or download:

- The exact MSVC, MSBuild, Windows SDK, component IDs, and WebView2 SDK recorded in `native/stage-c/dependency-lock.json`.
- The WebView2 SDK at `C:\StageC\packages\Microsoft.Web.WebView2.1.0.2903.40\build\native` with `include\WebView2.h` and `x64\WebView2LoaderStatic.lib`.
- Fixed-version WebView2 runtimes `119.0.2151.0`, `120.0.2210.0`, and `124.0.2478.0` at `C:\StageC\runtimes\<version>`. Each directory must contain `msedgewebview2.exe`; the lock/marker runtime digest is the SHA-256 of that executable. Collectors must launch the requested fixed runtime from that path; they must not install or select an Evergreen runtime.
- Node.js and npm compatible with the committed `package-lock.json`, Git for Windows, PowerShell, Azure CLI, and `ArtifactSigning` PowerShell module version `0.1.8`.
- Every real Stage C collector executable. Unit-test doubles, synthetic pass emitters, and scripts that merely replay prior evidence are prohibited.

## Reviewed image marker

Bake `C:\ProgramData\Zule\stage-c-image.json` into each snapshot with exactly these fields:

```json
{
  "schemaVersion": 1,
  "runnerLabel": "stage-c-win10-22h2-v1",
  "imageDigest": "<reviewed 64-character image digest>",
  "collectorManifestDigest": "<sha256 of stage-c-collectors.json>",
  "webView2Runtimes": [
    { "version": "119.0.2151.0", "path": "C:\\StageC\\runtimes\\119.0.2151.0", "digest": "<reviewed runtime digest>" },
    { "version": "120.0.2210.0", "path": "C:\\StageC\\runtimes\\120.0.2210.0", "digest": "<reviewed runtime digest>" },
    { "version": "124.0.2478.0", "path": "C:\\StageC\\runtimes\\124.0.2478.0", "digest": "<reviewed runtime digest>" }
  ]
}
```

The SHA-256 of this marker, image digest, runtime digests, and collector-manifest digest must exactly match the reviewed lock. Placeholders, `pending`, `rejected`, missing reviewer/date, and mismatches keep production disabled.

## Real collector registration

Bake `C:\ProgramData\Zule\stage-c-collectors.json` with exact schema version `1` and one absolute executable path for every gate ID in `electron/stageC/releaseGate/types.ts`:

```json
{
  "schemaVersion": 1,
  "collectors": {
    "metadata": "C:\\StageC\\collectors\\metadata.exe",
    "scope_honesty": "C:\\StageC\\collectors\\scope_honesty.exe"
  }
}
```

The abbreviated example is not runnable: all 19 entries are mandatory. `stage-c:run-gates` reports every missing collector and exits nonzero. Each executable receives `--request <absolute-json-path> --output <absolute-json-path>`, must collect real measurements on the current VM, and must return the exact `GateResultRecord` schema. The runner verifies build, artifact, OS, architecture, runtime, and version bindings. It never converts collector absence or failure into passing evidence.

## GitHub runner registration and isolation

1. Create a dedicated runner group that only the release repository and protected `stage-c-release` environment can use.
2. Register each clone with the four exact labels in the table. Disable default labels only if you explicitly add `self-hosted`, `Windows`, and `X64` yourself.
3. Use a narrowly scoped registration token only during bootstrap. Do not bake registration tokens, PATs, GitHub credentials, Azure tokens, or signing credentials into snapshots.
4. Run the GitHub runner service as a dedicated non-administrator account. Grant only workspace, runner service, fixed-runtime read/execute, collector read/execute, and required Azure CLI cache access. Deny interactive logon where operationally possible.
5. Use ephemeral registration (`--ephemeral`) or destroy and recreate the VM after every job. A stopped job must never return its dirty disk to the pool.
6. Start each clone from a read-only approved snapshot with an empty work directory. After use, revoke the runner session and destroy the clone. Do not rely on `git clean` as isolation.
7. Restrict outbound traffic to GitHub Actions/artifact endpoints, npm registry for `npm ci`, Microsoft Entra/Azure signing endpoints, and the reviewed timestamp endpoint. WebView2/runtime/toolchain acquisition endpoints are not required at job time.
8. Monitor runner group and environment approvals. Pull requests from forks must not reach this runner group or the signing environment.

## Azure Artifact Signing with GitHub OIDC

Create a Microsoft Entra application or managed identity with a federated identity restricted to this repository and the protected `stage-c-release` GitHub environment. Assign only the role required to sign with the selected account/profile. Do not create a client secret.

Configure GitHub as follows:

| Kind | Name | Value |
|---|---|---|
| Environment secret | `AZURE_TRUSTED_SIGNING_CLIENT_ID` | Federated application/client ID (not a client secret) |
| Environment variable | `AZURE_TRUSTED_SIGNING_TENANT_ID` | Entra tenant ID |
| Environment variable | `AZURE_TRUSTED_SIGNING_SUBSCRIPTION_ID` | Azure subscription ID |
| Environment variable | `AZURE_TRUSTED_SIGNING_ENDPOINT` | Regional Artifact Signing endpoint |
| Environment variable | `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME` | Signing account name |
| Environment variable | `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME` | Certificate profile name |
| Environment variable | `AZURE_TRUSTED_SIGNING_EXPECTED_SUBJECT` | Exact expected Authenticode signer subject |
| Environment variable | `AZURE_TRUSTED_SIGNING_TIMESTAMP_URL` | Reviewed RFC 3161 HTTPS timestamp URL |

The workflow requests `id-token: write`, authenticates with `azure/login`, imports only preinstalled `ArtifactSigning` `0.1.8`, signs `ZuleUI.exe`, and requires `Get-AuthenticodeSignature` to report `Valid` with the exact expected subject. Missing configuration fails before signing. Final artifact and build hashes are computed only after signing; there is no user-supplied authoritative build hash.

## npm lockfile prerequisite

`package-lock.json` is committed, so CI uses `npm ci --ignore-scripts`. If it is ever absent or intentionally regenerated, stop release work. On a reviewed maintenance workstation with the already approved dependency set installed, run `npm install --package-lock-only --ignore-scripts`, inspect the full lock diff (versions, resolved URLs, integrity, transitive additions/removals, license/security review), and commit it only after approval. Do not create or refresh the lock in the release workflow, and do not use `npm install` there.

## Activation checklist

Production remains disabled until all of the following external evidence exists: every lock and snapshot/runtime/collector digest is reviewed and recorded; `reviewedBy`/`reviewDate` are set; every `reviewStatus` is `approved`; all three ephemeral runner pools are online; OIDC and Artifact Signing configuration is present; all real collectors are installed; and one workflow run completes all 171 gate results against the final signed artifact set. Never copy approval IDs or passing mock data into a production manifest.