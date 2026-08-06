import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateLockForProduction, type DependencyLock } from '../../native/stage-c/dependency-lock.types';
import { createArtifactManifest } from '../../scripts/stage-c/artifact-manifest.mjs';
import { assembleEvidence } from '../../scripts/stage-c/assemble-evidence.mjs';

const ROOT = resolve(__dirname, '../..');
const tempPaths: string[] = [];
function temp(): string { const path = mkdtempSync(join(tmpdir(), 'zule-stage-c-')); tempPaths.push(path); return path; }
afterEach(() => tempPaths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe('Stage C production lock validation', () => {
  it('rejects the intentionally pending lock and REVIEW_REQUIRED digests', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'native/stage-c/dependency-lock.json'), 'utf8')) as DependencyLock;
    const errors = validateLockForProduction(lock);
    expect(errors.some((error) => error.path === 'reviewedBy')).toBe(true);
    expect(errors.some((error) => error.path === 'toolchain.msvc.reviewStatus')).toBe(true);
    expect(errors.some((error) => error.path === 'ciEnvironment.snapshots.0.collectorManifestDigest')).toBe(true);
  });

  it('strict toolchain verification exits nonzero without mutating the pending lock', () => {
    const path = join(ROOT, 'native/stage-c/toolchain-probe.mjs');
    const before = readFileSync(join(ROOT, 'native/stage-c/dependency-lock.json'));
    const run = spawnSync(process.execPath, [path, '--require-available'], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout).reason).toBe('LOCK_NOT_PRODUCTION_READY');
    expect(readFileSync(join(ROOT, 'native/stage-c/dependency-lock.json'))).toEqual(before);
  });
});

describe('Stage C artifact and CLI validation', () => {
  it('derives the build hash from finalized artifact bytes', () => {
    const root = temp();
    writeFileSync(join(root, 'ZuleUI.exe'), 'unsigned');
    const unsigned = createArtifactManifest(root);
    writeFileSync(join(root, 'ZuleUI.exe'), 'signed-final');
    const signed = createArtifactManifest(root);
    expect(signed.buildHash).not.toBe(unsigned.buildHash);
    expect(signed.buildHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects unknown CLI arguments', () => {
    const cli = join(ROOT, 'scripts/stage-c/artifact-manifest.mjs');
    const run = spawnSync(process.execPath, [cli, '--unknown', 'value'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Unknown argument');
  });

  it('fails closed and names every unavailable real collector', () => {
    const root = temp();
    const artifacts = join(root, 'artifacts');
    const output = join(root, 'evidence');
    mkdirSync(artifacts);
    writeFileSync(join(artifacts, 'ZuleUI.exe'), 'signed-final');
    const manifest = createArtifactManifest(artifacts);
    const manifestPath = join(root, 'artifact-manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const cli = join(ROOT, 'scripts/stage-c/run-gates.mjs');
    const run = spawnSync(process.execPath, [cli,
      '--artifact-manifest', manifestPath, '--artifacts-dir', artifacts,
      '--os-build', 'win10_22h2', '--architecture', 'x64',
      '--webview2-version', '119.0.2151.0', '--app-version', '1.2.0',
      '--sidecar-version', '1.2.0', '--output-dir', output,
    ], { encoding: 'utf8', env: { ...process.env, STAGE_C_REQUIRED_WEBVIEW2_RUNTIME: '119.0.2151.0', STAGE_C_COLLECTOR_MANIFEST: '' } });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('unavailable collectors: metadata');
    const failure = JSON.parse(readFileSync(join(output, 'collector-failure.json'), 'utf8'));
    expect(failure.outcome).toBe('failed');
    expect(failure.missingCollectors).toContain('state_update');
  });
});

describe('Stage C evidence assembly', () => {
  it('never emits approval for incomplete evidence', () => {
    const manifest = { schemaVersion: 1, buildHash: 'a'.repeat(64), artifacts: { 'ZuleUI.exe': 'b'.repeat(64) } };
    const archive = assembleEvidence(manifest, [], '2026-01-01T00:00:00.000Z');
    expect(archive.decision.outcome).toBe('failed');
    expect(archive.decision.approvalId).toBeNull();
    expect(archive.decision.failures).toHaveLength(19 * 9);
  });
});

describe('Stage C workflow invariants', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/stage-c-release-gates.yml'), 'utf8');

  it('uses npm and immutable self-hosted labels without runtime downloads', () => {
    expect(workflow).toContain('npm ci --ignore-scripts');
    expect(workflow).toContain('self-hosted, Windows, X64');
    expect(workflow).toContain('stage-c-win10-22h2-v1');
    expect(workflow).toContain('stage-c-win11-23h2-v1');
    expect(workflow).toContain('stage-c-win11-24h2-v1');
    expect(workflow).not.toContain('pnpm');
    expect(workflow).not.toContain('Invoke-WebRequest');
    expect(workflow).not.toContain('actions/setup-node');
    expect(workflow).not.toContain('windows-2022');
  });

  it('signs with OIDC before deriving the authoritative build hash', () => {
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('azure/login@v2');
    expect(workflow).toContain('Invoke-ArtifactSigning');
    expect(workflow).not.toContain('build_hash:\n');
    expect(workflow.indexOf('Invoke-ArtifactSigning')).toBeLessThan(workflow.indexOf('stage-c:hash-artifacts'));
  });

  it('invokes the explicit project with restore disabled', () => {
    const source = readFileSync(join(ROOT, 'native/stage-c/build-native.mjs'), 'utf8');
    expect(source).toContain('ZuleUI.vcxproj');
    expect(source).toContain("'/restore:false'");
    expect(source).toContain('WebView2SdkRoot');
    expect(source).not.toContain('Invoke-WebRequest');
  });
});