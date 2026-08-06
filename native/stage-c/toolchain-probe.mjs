import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExactKeys, findSnapshot, validateProductionLock } from './lock-validation.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const allowedArgs = new Set(['--require-available']);
if (process.argv.slice(2).some((arg) => !allowedArgs.has(arg)) || process.argv.slice(2).length > 1) {
  console.error('Usage: node toolchain-probe.mjs [--require-available]');
  process.exit(2);
}
const strict = process.argv.includes('--require-available');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function unavailable(reason, details = {}) { return { status: 'UNAVAILABLE', reason, details }; }
function exactDigest(path, expected) {
  if (!existsSync(path)) return { match: false, observed: null, path };
  const observed = sha256(path);
  return { match: observed === expected, observed, path };
}
function loadLock() {
  return JSON.parse(readFileSync(resolve(here, 'dependency-lock.json'), 'utf8'));
}
function locateVs(lock) {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
    'C:\\Program Files\\Microsoft Visual Studio\\Installer\\vswhere.exe',
  ];
  const vswhere = candidates.find(existsSync);
  if (!vswhere) return null;
  const components = Object.values(lock.toolchain).flatMap((item) => item.componentIds);
  const args = ['-format', 'json', '-all', '-products', '*', ...components.flatMap((id) => ['-requires', id])];
  const installations = JSON.parse(execFileSync(vswhere, args, { encoding: 'utf8', timeout: 15000, windowsHide: true }));
  return installations[0]?.installationPath ?? null;
}

function readVersion(executable, args, pattern) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const match = output.match(pattern);
  return match ? match[match.length - 1] : null;
}
function verifyImage(lock, details) {
  const label = process.env.STAGE_C_EXPECTED_IMAGE_LABEL;
  const manifestPath = process.env.STAGE_C_IMAGE_MANIFEST;
  if (!label || !manifestPath || !existsSync(manifestPath)) return 'CI_IMAGE_MANIFEST_MISSING';
  const snapshot = findSnapshot(lock, label);
  if (!snapshot) return 'CI_IMAGE_LABEL_NOT_LOCKED';
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assertExactKeys(manifest, ['schemaVersion', 'runnerLabel', 'imageDigest', 'collectorManifestDigest', 'webView2Runtimes'], 'CI image manifest');
  if (manifest.schemaVersion !== 1 || manifest.runnerLabel !== label || manifest.imageDigest !== snapshot.imageDigest || manifest.collectorManifestDigest !== snapshot.collectorManifestDigest) return 'CI_IMAGE_MISMATCH';
  if (sha256(manifestPath) !== snapshot.integrity.digest) return 'CI_IMAGE_MANIFEST_DIGEST_MISMATCH';
  if (!Array.isArray(manifest.webView2Runtimes)) return 'CI_IMAGE_RUNTIME_SCHEMA_INVALID';
  for (const runtime of snapshot.webView2Runtimes) {
    const observed = manifest.webView2Runtimes.find((entry) => entry.version === runtime.version);
    const runtimeExecutable = resolve(runtime.path, 'msedgewebview2.exe');
    if (!observed || observed.path !== runtime.path || observed.digest !== runtime.integrity.digest || !existsSync(runtimeExecutable) || sha256(runtimeExecutable) !== runtime.integrity.digest) {
      return `WEBVIEW2_RUNTIME_NOT_PROVISIONED:${runtime.version}`;
    }
  }
  const requiredRuntime = process.env.STAGE_C_REQUIRED_WEBVIEW2_RUNTIME;
  if (requiredRuntime && !snapshot.webView2Runtimes.some((runtime) => runtime.version === requiredRuntime)) {
    return `WEBVIEW2_RUNTIME_NOT_LOCKED:${requiredRuntime}`;
  }
  details.image = { label, manifestPath, imageDigest: manifest.imageDigest, requiredRuntime: requiredRuntime ?? null };
  return null;
}

function probe() {
  const lock = loadLock();
  const details = { platform: process.platform, arch: process.arch, checks: {} };
  const lockErrors = validateProductionLock(lock);
  details.checks.lock = { pass: lockErrors.length === 0, errors: lockErrors };
  if (lockErrors.length) return unavailable('LOCK_NOT_PRODUCTION_READY', details);
  if (process.platform !== 'win32') return unavailable('PLATFORM_NOT_WIN32', details);
  if (process.arch !== lock.architecture) return unavailable('ARCHITECTURE_MISMATCH', details);
  const imageFailure = verifyImage(lock, details);
  if (imageFailure) return unavailable(imageFailure, details);

  const installationPath = locateVs(lock);
  if (!installationPath) return unavailable('NO_MATCHING_VS_INSTALLATION', details);
  const toolsetVersion = lock.transitiveDependencies['msvc-crt-headers']?.version;
  const clPath = resolve(installationPath, 'VC', 'Tools', 'MSVC', toolsetVersion, 'bin', 'Hostx64', 'x64', 'cl.exe');
  const msbuildPath = resolve(installationPath, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe');
  const sdkRoot = 'C:\\Program Files (x86)\\Windows Kits\\10';
  const rcPath = resolve(sdkRoot, 'bin', lock.toolchain.windowsSdk.version, 'x64', 'rc.exe');
  const webViewRoot = lock.dependencies.webview2Sdk.provisionedRoot;
  const loaderPath = resolve(webViewRoot, 'x64', 'WebView2LoaderStatic.lib');
  const headerPath = resolve(webViewRoot, 'include', 'WebView2.h');

  const msvcVersion = existsSync(clPath) ? readVersion(clPath, [], /Compiler Version\s+([\d.]+)/i) : null;
  const msbuildVersion = existsSync(msbuildPath) ? readVersion(msbuildPath, ['-version', '-nologo'], /(^|\n)([\d.]+)\s*$/m)?.replace(/^\n/, '') : null;
  const msvcIntegrity = exactDigest(clPath, lock.toolchain.msvc.integrity.digest);
  const msbuildIntegrity = exactDigest(msbuildPath, lock.toolchain.msbuild.integrity.digest);
  const sdkIntegrity = exactDigest(rcPath, lock.toolchain.windowsSdk.integrity.digest);
  const webViewIntegrity = exactDigest(loaderPath, lock.dependencies.webview2Sdk.integrity.digest);
  details.checks.msvc = { match: msvcVersion === lock.toolchain.msvc.version && msvcIntegrity.match, observed: msvcVersion, integrity: msvcIntegrity };
  details.checks.msbuild = { match: msbuildVersion === lock.toolchain.msbuild.version && msbuildIntegrity.match, observed: msbuildVersion, integrity: msbuildIntegrity };
  details.checks.windowsSdk = { match: existsSync(resolve(sdkRoot, 'Include', lock.toolchain.windowsSdk.version, 'um', 'windows.h')) && sdkIntegrity.match, observed: lock.toolchain.windowsSdk.version, integrity: sdkIntegrity };
  details.checks.webView2Sdk = { match: existsSync(headerPath) && webViewIntegrity.match, observed: lock.dependencies.webview2Sdk.version, integrity: webViewIntegrity };
  details.msbuildPath = msbuildPath;
  details.webView2SdkRoot = webViewRoot;

  for (const [name, check] of Object.entries(details.checks)) {
    if (name !== 'lock' && (!check.match || check.observed === null)) return unavailable(`${name.toUpperCase()}_MISMATCH`, details);
  }
  return { status: 'AVAILABLE', details };
}

try {
  const result = probe();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(strict && result.status !== 'AVAILABLE' ? 1 : 0);
} catch (error) {
  const result = unavailable('PROBE_ERROR', { platform: process.platform, arch: process.arch, error: error instanceof Error ? error.message : String(error) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(strict ? 1 : 0);
}