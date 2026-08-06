import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXACT_VERSION, GATE_IDS, OS_BUILDS, SHA256, WEBVIEW2_VERSIONS, exactKeys,
  parseArgs, readJson, sha256Buffer, stableJson, verifyArtifactManifest,
} from './common.mjs';

const RESULT_FIELDS = [
  'gateId', 'buildHash', 'osBuild', 'architecture', 'webView2Version',
  'appVersion', 'sidecarVersion', 'rawMeasurementSummary', 'verdict', 'executedAt',
];
export function expectedMatrix() {
  return OS_BUILDS.flatMap((osBuild) => WEBVIEW2_VERSIONS.map((webView2Version) => ({ osBuild, architecture: 'x64', webView2Version })));
}
function evidenceFiles(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Evidence directory is missing: ${root}`);
  const files = [];
  const visit = (dir) => readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
  });
  visit(root);
  return files.sort();
}
function validateResult(result, buildHash, path) {
  exactKeys(result, RESULT_FIELDS, `gate evidence ${path}`);
  if (!GATE_IDS.includes(result.gateId) || !OS_BUILDS.includes(result.osBuild) || result.architecture !== 'x64' || !WEBVIEW2_VERSIONS.includes(result.webView2Version)) throw new Error(`Unexpected gate or environment in ${path}`);
  if (result.buildHash !== buildHash || !SHA256.test(result.buildHash)) throw new Error(`Build hash mismatch in ${path}`);
  if (!EXACT_VERSION.test(result.appVersion) || !EXACT_VERSION.test(result.sidecarVersion) || !['pass', 'fail'].includes(result.verdict) || Number.isNaN(Date.parse(result.executedAt))) throw new Error(`Invalid gate result fields in ${path}`);
  const summary = JSON.parse(result.rawMeasurementSummary);
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw new Error(`Invalid raw measurement summary in ${path}`);
  return result;
}

export function assembleEvidence(artifactManifest, results, assembledAt = new Date().toISOString()) {
  const matrix = expectedMatrix();
  const failures = [];
  const byKey = new Map();
  for (const result of results) {
    const key = `${result.gateId}|${result.osBuild}|${result.architecture}|${result.webView2Version}`;
    if (byKey.has(key)) failures.push({ reason: `Duplicate result: ${key}` });
    else byKey.set(key, result);
  }
  for (const gateId of GATE_IDS) {
    for (const row of matrix) {
      const key = `${gateId}|${row.osBuild}|${row.architecture}|${row.webView2Version}`;
      const result = byKey.get(key);
      if (!result) failures.push({ reason: `Missing result: ${key}`, gateId, matrixRow: row });
      else if (result.verdict !== 'pass') failures.push({ reason: `Gate failed: ${key}`, gateId, matrixRow: row });
    }
  }
  const evidence = {
    buildHash: artifactManifest.buildHash,
    artifactHashes: artifactManifest.artifacts,
    matrix, results: [...results].sort((a, b) => `${a.gateId}|${a.osBuild}|${a.webView2Version}`.localeCompare(`${b.gateId}|${b.osBuild}|${b.webView2Version}`)),
    assembledAt,
  };
  const evidenceSignature = sha256Buffer(Buffer.from(stableJson(evidence), 'utf8'));
  const approved = failures.length === 0;
  const approvalId = approved
    ? createHash('sha256').update(`${artifactManifest.buildHash}:${assembledAt}:stage-c-release-approved`).digest('hex')
    : null;
  return {
    evidence, evidenceSignature,
    decision: { outcome: approved ? 'approved' : 'failed', buildHash: approved ? artifactManifest.buildHash : null, approvalId, failures },
    archivedAt: assembledAt,
  };
}

export function main(argv) {
  const args = parseArgs(argv, {
    'artifact-manifest': Boolean, 'artifacts-dir': Boolean,
    'evidence-dir': Boolean, output: Boolean,
  });
  const artifactManifest = verifyArtifactManifest(readJson(resolve(args['artifact-manifest'])), resolve(args['artifacts-dir']));
  const results = evidenceFiles(resolve(args['evidence-dir'])).map((path) => validateResult(readJson(path), artifactManifest.buildHash, path));
  const archive = assembleEvidence(artifactManifest, results);
  const output = resolve(args.output);
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  writeFileSync(temporary, `${stableJson(archive)}\n`);
  renameSync(temporary, output);
  if (archive.decision.outcome !== 'approved') {
    throw new Error(`Evidence incomplete or failed (${archive.decision.failures.length} failure(s)); production remains disabled`);
  }
  console.log(`[stage-c] Approved build ${artifactManifest.buildHash}; approval ${archive.decision.approvalId}`);
  return archive;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`[stage-c] ${error.message}`); process.exit(error.exitCode ?? 1); }
}