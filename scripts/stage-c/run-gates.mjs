import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXACT_VERSION, GATE_IDS, OS_BUILDS, SHA256, WEBVIEW2_VERSIONS, exactKeys,
  parseArgs, readJson, sha256Buffer, stableJson, verifyArtifactManifest,
} from './common.mjs';

const RESULT_FIELDS = [
  'gateId', 'buildHash', 'osBuild', 'architecture', 'webView2Version',
  'appVersion', 'sidecarVersion', 'rawMeasurementSummary', 'verdict', 'executedAt',
];
function writeFailure(outputDir, missingCollectors, reason) {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(resolve(outputDir, 'collector-failure.json'), `${stableJson({
    schemaVersion: 1, outcome: 'failed', reason, missingCollectors,
  })}\n`);
}
function loadCollectorRegistry(outputDir) {
  const registryPath = process.env.STAGE_C_COLLECTOR_MANIFEST;
  const imageManifestPath = process.env.STAGE_C_IMAGE_MANIFEST;
  if (!registryPath || !existsSync(registryPath)) {
    writeFailure(outputDir, GATE_IDS, 'COLLECTOR_MANIFEST_MISSING');
    throw new Error(`Real gate collector manifest is missing; unavailable collectors: ${GATE_IDS.join(', ')}`);
  }
  if (!imageManifestPath || !existsSync(imageManifestPath)) {
    writeFailure(outputDir, GATE_IDS, 'CI_IMAGE_MANIFEST_MISSING');
    throw new Error('Reviewed CI image manifest is missing');
  }
  const imageManifest = readJson(imageManifestPath, 'CI image manifest');
  const digest = sha256Buffer(readFileSync(registryPath));
  if (!SHA256.test(imageManifest.collectorManifestDigest ?? '') || digest !== imageManifest.collectorManifestDigest) {
    writeFailure(outputDir, GATE_IDS, 'COLLECTOR_MANIFEST_DIGEST_MISMATCH');
    throw new Error('Gate collector manifest does not match the reviewed VM image');
  }
  const registry = readJson(registryPath, 'gate collector manifest');
  exactKeys(registry, ['schemaVersion', 'collectors'], 'gate collector manifest');
  if (registry.schemaVersion !== 1 || !registry.collectors || typeof registry.collectors !== 'object') throw new Error('Gate collector manifest schema is invalid');
  return registry.collectors;
}

export function validateGateResult(result, expected) {
  exactKeys(result, RESULT_FIELDS, `collector result ${expected.gateId}`);
  if (result.gateId !== expected.gateId || result.buildHash !== expected.buildHash || result.osBuild !== expected.osBuild || result.architecture !== 'x64' || result.webView2Version !== expected.webView2Version || result.appVersion !== expected.appVersion || result.sidecarVersion !== expected.sidecarVersion) {
    throw new Error(`Collector '${expected.gateId}' returned evidence bound to the wrong build or environment`);
  }
  if (!SHA256.test(result.buildHash) || !['pass', 'fail'].includes(result.verdict) || Number.isNaN(Date.parse(result.executedAt))) throw new Error(`Collector '${expected.gateId}' returned invalid result fields`);
  if (typeof result.rawMeasurementSummary !== 'string' || !result.rawMeasurementSummary) throw new Error(`Collector '${expected.gateId}' omitted raw measurements`);
  const summary = JSON.parse(result.rawMeasurementSummary);
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw new Error(`Collector '${expected.gateId}' raw measurements must be a JSON object`);
  return result;
}

export function main(argv) {
  const args = parseArgs(argv, {
    'artifact-manifest': Boolean, 'artifacts-dir': Boolean,
    'os-build': (value) => OS_BUILDS.includes(value),
    architecture: (value) => value === 'x64',
    'webview2-version': (value) => WEBVIEW2_VERSIONS.includes(value),
    'app-version': (value) => EXACT_VERSION.test(value),
    'sidecar-version': (value) => EXACT_VERSION.test(value),
    'output-dir': Boolean,
  });
  if (process.env.STAGE_C_REQUIRED_WEBVIEW2_RUNTIME !== args['webview2-version']) throw new Error('Runner runtime selection does not match the requested matrix row');
  const outputDir = resolve(args['output-dir']);
  const artifactManifest = verifyArtifactManifest(readJson(resolve(args['artifact-manifest'])), resolve(args['artifacts-dir']));
  const collectors = loadCollectorRegistry(outputDir);
  const missing = GATE_IDS.filter((gateId) => typeof collectors[gateId] !== 'string' || !isAbsolute(collectors[gateId]) || !existsSync(collectors[gateId]));
  const extras = Object.keys(collectors).filter((gateId) => !GATE_IDS.includes(gateId));
  if (missing.length || extras.length) {
    writeFailure(outputDir, missing, extras.length ? `UNREVIEWED_COLLECTORS:${extras.join(',')}` : 'COLLECTORS_MISSING');
    throw new Error(`Real gate collectors unavailable: ${missing.join(', ') || 'none'}${extras.length ? `; unreviewed entries: ${extras.join(', ')}` : ''}`);
  }

  mkdirSync(outputDir, { recursive: true });
  for (const gateId of GATE_IDS) {
    const requestPath = resolve(outputDir, `.${gateId}-request.json`);
    const responsePath = resolve(outputDir, `.${gateId}-response.json`);
    const request = {
      schemaVersion: 1, gateId, buildHash: artifactManifest.buildHash,
      artifactHashes: artifactManifest.artifacts, artifactsDirectory: resolve(args['artifacts-dir']),
      environment: { osBuild: args['os-build'], architecture: args.architecture, webView2Version: args['webview2-version'] },
      appVersion: args['app-version'], sidecarVersion: args['sidecar-version'],
    };
    writeFileSync(requestPath, `${stableJson(request)}\n`);
    const run = spawnSync(collectors[gateId], ['--request', requestPath, '--output', responsePath], { encoding: 'utf8', timeout: 30 * 60 * 1000, windowsHide: true });
    if (run.status !== 0 || !existsSync(responsePath)) {
      writeFailure(outputDir, [gateId], `COLLECTOR_EXECUTION_FAILED:${gateId}`);
      throw new Error(`Real collector '${gateId}' failed: ${run.stderr || run.error?.message || `exit ${run.status}`}`);
    }
    const expected = { gateId, buildHash: artifactManifest.buildHash, osBuild: args['os-build'], webView2Version: args['webview2-version'], appVersion: args['app-version'], sidecarVersion: args['sidecar-version'] };
    const result = validateGateResult(readJson(responsePath), expected);
    writeFileSync(resolve(outputDir, `${gateId}.json`), `${stableJson(result)}\n`);
    rmSync(requestPath, { force: true }); rmSync(responsePath, { force: true });
    if (result.verdict !== 'pass') throw new Error(`Gate '${gateId}' returned fail; production remains disabled`);
  }
  console.log(`[stage-c] Collected ${GATE_IDS.length} real gate results for ${args['os-build']} / ${args['webview2-version']}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`[stage-c] ${error.message}`); process.exit(error.exitCode ?? 1); }
}