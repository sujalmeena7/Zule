#!/usr/bin/env node

/**
 * Schema Parity Check — TypeScript ↔ C++ Drift Detection
 *
 * Reads the canonical TypeScript schema constants and the C++ protocol_constants.h
 * header, then compares values including SCHEMA_HASH_VERSION and a deterministic
 * content hash. Exits non-zero if any constant drifts.
 *
 * This script is run as part of:
 * - The native build guard (stage-c:build, stage-c:package, stage-c:production-enable)
 * - The TypeScript test suite (via Vitest integration test)
 * - A standalone npm script (stage-c:check-schema)
 *
 * Both TypeScript and native builds will fail on drift.
 *
 * Requirements: 5.5–5.6, 6.14, 6.18–6.21, 7.4, 14.6
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');

// ────────────────────────────────────────────────────────────────────
// File paths
// ────────────────────────────────────────────────────────────────────

const TS_SCHEMA_PATH = resolve(ROOT, 'electron', 'stageC', 'protocol', 'schema.ts');
const CPP_CONSTANTS_PATH = resolve(__dirname, '..', 'src', 'protocol_constants.h');
const CPP_TYPES_PATH = resolve(__dirname, '..', 'src', 'protocol_types.h');

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function readFile(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    console.error(`ERROR: Cannot read file: ${path}`);
    console.error(err.message);
    process.exit(2);
  }
}

/**
 * Extract a numeric constant from TypeScript source.
 * Handles patterns like: export const NAME = 123;
 * Also handles underscore separators: 1_048_576
 */
function extractTsNumericConstant(source, name) {
  const pattern = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*([\\d_]+)`, 'm');
  const match = source.match(pattern);
  if (!match) return null;
  return parseInt(match[1].replace(/_/g, ''), 10);
}

/**
 * Extract a string constant from TypeScript source.
 * Handles patterns like: export const NAME = 'value';
 */
function extractTsStringConstant(source, name) {
  const pattern = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`, 'm');
  const match = source.match(pattern);
  return match ? match[1] : null;
}

/**
 * Extract a numeric constant from C++ header.
 * Handles patterns like: inline constexpr std::uint32_t NAME = 123;
 * Also handles digit separators: 1'048'576
 */
function extractCppNumericConstant(source, name) {
  const pattern = new RegExp(`(?:inline\\s+)?constexpr\\s+\\S+\\s+${name}\\s*=\\s*([\\d']+)`, 'm');
  const match = source.match(pattern);
  if (!match) return null;
  return parseInt(match[1].replace(/'/g, ''), 10);
}

/**
 * Extract a string_view constant from C++ header.
 * Handles patterns like: inline constexpr std::string_view NAME = "value";
 */
function extractCppStringConstant(source, name) {
  const pattern = new RegExp(`(?:inline\\s+)?constexpr\\s+std::string_view\\s+${name}\\s*=\\s*"([^"]*)"`, 'm');
  const match = source.match(pattern);
  return match ? match[1] : null;
}

/**
 * Extract TypeScript enum values.
 * Returns array of string values.
 */
function extractTsEnumValues(source, enumName) {
  const enumPattern = new RegExp(`enum\\s+${enumName}\\s*\\{([^}]+)\\}`, 's');
  const enumMatch = source.match(enumPattern);
  if (!enumMatch) return [];

  const valuePattern = /=\s*'([^']+)'/g;
  const values = [];
  let m;
  while ((m = valuePattern.exec(enumMatch[1])) !== null) {
    values.push(m[1]);
  }
  return values;
}

/**
 * Extract C++ string_view constants from a namespace block.
 */
function extractCppNamespaceConstants(source, namespaceName) {
  const nsPattern = new RegExp(`namespace\\s+${namespaceName}\\s*\\{([^}]+)\\}`, 's');
  const nsMatch = source.match(nsPattern);
  if (!nsMatch) return [];

  const valuePattern = /=\s*"([^"]+)"/g;
  const values = [];
  let m;
  while ((m = valuePattern.exec(nsMatch[1])) !== null) {
    values.push(m[1]);
  }
  return values;
}

// ────────────────────────────────────────────────────────────────────
// Main comparison logic
// ────────────────────────────────────────────────────────────────────

const tsSource = readFile(TS_SCHEMA_PATH);
const cppSource = readFile(CPP_CONSTANTS_PATH);

const errors = [];

function check(description, tsValue, cppValue) {
  if (tsValue === null || tsValue === undefined) {
    errors.push(`MISSING in TypeScript: ${description}`);
    return;
  }
  if (cppValue === null || cppValue === undefined) {
    errors.push(`MISSING in C++: ${description}`);
    return;
  }
  if (tsValue !== cppValue) {
    errors.push(`MISMATCH ${description}: TS=${JSON.stringify(tsValue)} C++=${JSON.stringify(cppValue)}`);
  }
}

// ── Protocol version constants ──
check(
  'PROTOCOL_MAJOR',
  extractTsNumericConstant(tsSource, 'PROTOCOL_MAJOR'),
  extractCppNumericConstant(cppSource, 'PROTOCOL_MAJOR'),
);

check(
  'PROTOCOL_MINOR',
  extractTsNumericConstant(tsSource, 'PROTOCOL_MINOR'),
  extractCppNumericConstant(cppSource, 'PROTOCOL_MINOR'),
);

check(
  'BRIDGE_SCHEMA_VERSION',
  extractTsNumericConstant(tsSource, 'BRIDGE_SCHEMA_VERSION'),
  extractCppNumericConstant(cppSource, 'BRIDGE_SCHEMA_VERSION'),
);

check(
  'SCHEMA_HASH_VERSION',
  extractTsStringConstant(tsSource, 'SCHEMA_HASH_VERSION'),
  extractCppStringConstant(cppSource, 'SCHEMA_HASH_VERSION'),
);

// ── Size limits ──
check(
  'MAX_FRAME_BYTES',
  extractTsNumericConstant(tsSource, 'MAX_FRAME_BYTES'),
  extractCppNumericConstant(cppSource, 'MAX_FRAME_BYTES'),
);

check(
  'MAX_BRIDGE_MESSAGE_BYTES',
  extractTsNumericConstant(tsSource, 'MAX_BRIDGE_MESSAGE_BYTES'),
  extractCppNumericConstant(cppSource, 'MAX_BRIDGE_MESSAGE_BYTES'),
);

check(
  'MAX_TELEMETRY_EVENT_BYTES',
  extractTsNumericConstant(tsSource, 'MAX_TELEMETRY_EVENT_BYTES'),
  extractCppNumericConstant(cppSource, 'MAX_TELEMETRY_EVENT_BYTES'),
);

check(
  'MAX_REPLAY_CACHE_ENTRIES',
  extractTsNumericConstant(tsSource, 'MAX_REPLAY_CACHE_ENTRIES'),
  extractCppNumericConstant(cppSource, 'MAX_REPLAY_CACHE_ENTRIES'),
);

check(
  'MAX_QUEUED_MESSAGES',
  extractTsNumericConstant(tsSource, 'MAX_QUEUED_MESSAGES'),
  extractCppNumericConstant(cppSource, 'MAX_QUEUED_MESSAGES'),
);

check(
  'MAX_QUEUED_BYTES',
  extractTsNumericConstant(tsSource, 'MAX_QUEUED_BYTES'),
  extractCppNumericConstant(cppSource, 'MAX_QUEUED_BYTES'),
);

// ── Message types — Controller → Sidecar ──
const tsC2sTypes = extractTsEnumValues(tsSource, 'ControllerToSidecarType');
const cppC2sTypes = extractCppNamespaceConstants(cppSource, 'controller_to_sidecar');

check(
  'Controller→Sidecar type count',
  tsC2sTypes.length,
  cppC2sTypes.length,
);

// Check every TS type exists in C++
for (const tsType of tsC2sTypes) {
  if (!cppC2sTypes.includes(tsType)) {
    errors.push(`MISSING in C++ controller_to_sidecar: "${tsType}"`);
  }
}

// Check every C++ type exists in TS
for (const cppType of cppC2sTypes) {
  if (!tsC2sTypes.includes(cppType)) {
    errors.push(`EXTRA in C++ controller_to_sidecar: "${cppType}" not in TypeScript`);
  }
}

// ── Message types — Sidecar → Controller ──
const tsS2cTypes = extractTsEnumValues(tsSource, 'SidecarToControllerType');
const cppS2cTypes = extractCppNamespaceConstants(cppSource, 'sidecar_to_controller');

check(
  'Sidecar→Controller type count',
  tsS2cTypes.length,
  cppS2cTypes.length,
);

for (const tsType of tsS2cTypes) {
  if (!cppS2cTypes.includes(tsType)) {
    errors.push(`MISSING in C++ sidecar_to_controller: "${tsType}"`);
  }
}

for (const cppType of cppS2cTypes) {
  if (!tsS2cTypes.includes(cppType)) {
    errors.push(`EXTRA in C++ sidecar_to_controller: "${cppType}" not in TypeScript`);
  }
}

// ── Validation error codes ──
const tsValidationCodes = extractTsEnumValues(tsSource, 'ValidationErrorCode');
const cppValidationCodes = extractCppNamespaceConstants(cppSource, 'validation');

// ValidationErrorCode uses VALUE = 'VALUE' pattern, extract differently
const tsValidationPattern = /enum\s+ValidationErrorCode\s*\{([^}]+)\}/s;
const tsValMatch = tsSource.match(tsValidationPattern);
const tsValCodes = [];
if (tsValMatch) {
  const entries = tsValMatch[1].matchAll(/(\w+)\s*=\s*'([^']+)'/g);
  for (const entry of entries) {
    tsValCodes.push(entry[2]);
  }
}

for (const code of tsValCodes) {
  if (!cppValidationCodes.includes(code)) {
    errors.push(`MISSING in C++ validation namespace: "${code}"`);
  }
}

for (const code of cppValidationCodes) {
  if (!tsValCodes.includes(code)) {
    errors.push(`EXTRA in C++ validation namespace: "${code}" not in TypeScript`);
  }
}

// ────────────────────────────────────────────────────────────────────
// Report results
// ────────────────────────────────────────────────────────────────────

// Compute deterministic content hash of the canonical TS schema.
// This is a SHA-256 of the normalized schema content (stripped of
// comments and whitespace variation) that both sides can verify.
function computeSchemaContentHash(tsSource) {
  // Extract semantically meaningful lines (strip comments, normalize whitespace)
  const meaningful = tsSource
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').trim())
    .filter(line => line.length > 0)
    .join('\n');
  return createHash('sha256').update(meaningful, 'utf-8').digest('hex').slice(0, 16);
}

const schemaContentHash = computeSchemaContentHash(tsSource);

// Verify that the C++ header embeds the content hash (if present)
const cppHashConstant = extractCppStringConstant(cppSource, 'SCHEMA_CONTENT_HASH');
if (cppHashConstant !== null && cppHashConstant !== schemaContentHash) {
  errors.push(`MISMATCH SCHEMA_CONTENT_HASH: TS computed="${schemaContentHash}" C++="${cppHashConstant}"`);
} else if (cppHashConstant === null) {
  errors.push(`MISSING in C++: SCHEMA_CONTENT_HASH (expected "${schemaContentHash}")`);
}

// Verify that both sides agree on SCHEMA_HASH_VERSION
const tsSchemaHashVersion = extractTsStringConstant(tsSource, 'SCHEMA_HASH_VERSION');
const cppSchemaHashVersion = extractCppStringConstant(cppSource, 'SCHEMA_HASH_VERSION');
if (tsSchemaHashVersion && cppSchemaHashVersion && tsSchemaHashVersion !== cppSchemaHashVersion) {
  // This is already checked above, but emphasize it
  // (already reported via check() call earlier, so no double-add needed)
}

// Output as JSON when --json flag is passed (for Vitest integration)
const jsonMode = process.argv.includes('--json');

if (errors.length === 0) {
  const result = {
    status: 'PASSED',
    protocolVersion: `${extractTsNumericConstant(tsSource, 'PROTOCOL_MAJOR')}.${extractTsNumericConstant(tsSource, 'PROTOCOL_MINOR')}`,
    schemaHashVersion: tsSchemaHashVersion,
    schemaContentHash,
    controllerToSidecarTypes: tsC2sTypes.length,
    sidecarToControllerTypes: tsS2cTypes.length,
  };

  if (jsonMode) {
    console.log(JSON.stringify(result));
  } else {
    console.log('✓ Schema parity check PASSED — C++ constants match TypeScript canonical source.');
    console.log(`  Protocol version: ${result.protocolVersion}`);
    console.log(`  Schema hash version: ${result.schemaHashVersion}`);
    console.log(`  Schema content hash: ${result.schemaContentHash}`);
    console.log(`  Controller→Sidecar types: ${result.controllerToSidecarTypes}`);
    console.log(`  Sidecar→Controller types: ${result.sidecarToControllerTypes}`);
  }
  process.exit(0);
} else {
  const result = {
    status: 'FAILED',
    errors,
    schemaContentHash,
    schemaHashVersion: tsSchemaHashVersion,
  };

  if (jsonMode) {
    console.log(JSON.stringify(result));
  } else {
    console.error('✗ Schema parity check FAILED — drift detected between TypeScript and C++:');
    console.error('');
    for (const err of errors) {
      console.error(`  • ${err}`);
    }
    console.error('');
    console.error(`  Expected schema content hash: ${schemaContentHash}`);
    console.error('');
    console.error('Fix: Update native/stage-c/src/protocol_constants.h to match');
    console.error('     electron/stageC/protocol/schema.ts (the canonical source).');
    console.error('     Then run: npm run stage-c:check-schema');
  }
  process.exit(1);
}
