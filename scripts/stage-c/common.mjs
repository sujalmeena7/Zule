import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

export const SHA256 = /^[a-f0-9]{64}$/;
export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/;
export const GATE_IDS = [
  'metadata', 'scope_honesty', 'runtime_probe', 'startup', 'transparency',
  'input', 'geometry', 'ipc_security', 'bridge_security', 'capture',
  'capture_fallback', 'fallback', 'diagnostic_retry', 'performance',
  'stability', 'packaging', 'telemetry_privacy', 'telemetry_schema', 'state_update',
];
export const OS_BUILDS = ['win10_22h2', 'win11_23h2', 'win11_24h2'];
export const WEBVIEW2_VERSIONS = ['119.0.2151.0', '120.0.2210.0', '124.0.2478.0'];

export function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}
export function parseArgs(argv, definitions) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) fail(`Invalid argument sequence near '${name ?? ''}'`, 2);
    const key = name.slice(2);
    if (!(key in definitions)) fail(`Unknown argument --${key}`, 2);
    if (key in result) fail(`Duplicate argument --${key}`, 2);
    result[key] = value;
  }
  for (const [key, validate] of Object.entries(definitions)) {
    if (!(key in result)) fail(`Missing required argument --${key}`, 2);
    if (validate && !validate(result[key])) fail(`Invalid value for --${key}`, 2);
  }
  return result;
}
export function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} fields must be exactly: ${expected.join(', ')}`);
  }
}

export function stableJson(value) {
  const canonicalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(canonicalize);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonicalize(nested)]));
    }
    return entry;
  };
  return JSON.stringify(canonicalize(value));
}
export function sha256Buffer(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
export function readJson(path, label = path) {
  if (!existsSync(path)) fail(`${label} is missing: ${path}`);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`); }
}
export function listFiles(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) fail(`Artifact directory is missing: ${root}`);
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else fail(`Unsupported artifact entry: ${path}`);
    }
  };
  visit(resolve(root));
  return files.sort((a, b) => a.localeCompare(b));
}
export function hashArtifacts(root) {
  const artifacts = {};
  for (const path of listFiles(root)) {
    const key = relative(resolve(root), path).replaceAll('\\', '/');
    artifacts[key] = sha256Buffer(readFileSync(path));
  }
  if (Object.keys(artifacts).length === 0) fail('Artifact directory is empty');
  const buildHash = sha256Buffer(Buffer.from(Object.entries(artifacts).map(([path, digest]) => `${path}\0${digest}\n`).join(''), 'utf8'));
  return { buildHash, artifacts };
}
export function validateArtifactManifest(value) {
  exactKeys(value, ['schemaVersion', 'buildHash', 'artifacts'], 'artifact manifest');
  if (value.schemaVersion !== 1 || !SHA256.test(value.buildHash)) fail('Artifact manifest header is invalid');
  if (!value.artifacts || typeof value.artifacts !== 'object' || Array.isArray(value.artifacts) || Object.keys(value.artifacts).length === 0) fail('Artifact manifest has no artifacts');
  for (const [path, digest] of Object.entries(value.artifacts)) {
    if (!path || path.includes('..') || path.startsWith('/') || !SHA256.test(digest)) fail(`Invalid artifact binding: ${path}`);
  }
  return value;
}
export function verifyArtifactManifest(manifest, root) {
  validateArtifactManifest(manifest);
  const observed = hashArtifacts(root);
  if (observed.buildHash !== manifest.buildHash || stableJson(observed.artifacts) !== stableJson(manifest.artifacts)) fail('Finalized artifact hashes do not match artifact manifest');
  return manifest;
}