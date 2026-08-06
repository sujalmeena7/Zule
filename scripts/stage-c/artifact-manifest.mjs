import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashArtifacts, parseArgs, stableJson } from './common.mjs';

export function createArtifactManifest(artifactsDirectory) {
  const { buildHash, artifacts } = hashArtifacts(artifactsDirectory);
  return { schemaVersion: 1, buildHash, artifacts };
}

export function main(argv) {
  const args = parseArgs(argv, {
    'artifacts-dir': (value) => value.trim().length > 0,
    output: (value) => value.trim().length > 0,
  });
  const root = resolve(args['artifacts-dir']);
  const output = resolve(args.output);
  const outputRelative = relative(root, output);
  if (outputRelative === '' || (!outputRelative.startsWith('..') && !isAbsolute(outputRelative))) {
    throw new Error('Artifact manifest output must be outside the artifact directory');
  }
  const manifest = createArtifactManifest(root);
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  writeFileSync(temporary, `${stableJson(manifest)}\n`, { encoding: 'utf8', flag: 'w' });
  renameSync(temporary, output);
  console.log(`[stage-c] Computed build hash ${manifest.buildHash} from ${Object.keys(manifest.artifacts).length} finalized signed artifact(s).`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`[stage-c] ${error.message}`); process.exit(error.exitCode ?? 1); }
}