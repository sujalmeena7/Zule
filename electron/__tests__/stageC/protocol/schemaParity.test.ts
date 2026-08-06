/**
 * Stage C Protocol Schema Parity — Cross-language Drift Detection Test
 *
 * This test validates that the C++ protocol_constants.h stays in exact
 * sync with the canonical TypeScript schema source. If this test fails,
 * the C++ bindings need to be regenerated/updated.
 *
 * The test performs the same checks as the standalone script at
 * native/stage-c/scripts/check-schema-parity.mjs, but integrated into
 * the Vitest suite so that `npm test` catches drift without requiring
 * the native toolchain or a separate CI step.
 *
 * Requirements: 5.5–5.6, 6.14, 6.18–6.21, 7.4, 14.6
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  BRIDGE_SCHEMA_VERSION,
  SCHEMA_HASH_VERSION,
  MAX_FRAME_BYTES,
  MAX_BRIDGE_MESSAGE_BYTES,
  MAX_TELEMETRY_EVENT_BYTES,
  MAX_REPLAY_CACHE_ENTRIES,
  MAX_QUEUED_MESSAGES,
  MAX_QUEUED_BYTES,
  ControllerToSidecarType,
  SidecarToControllerType,
  ValidationErrorCode,
} from '../../../stageC/protocol';

// ────────────────────────────────────────────────────────────────────
// Paths
// ────────────────────────────────────────────────────────────────────

const ROOT = resolve(__dirname, '../../../../');
const CPP_CONSTANTS_PATH = resolve(ROOT, 'native/stage-c/src/protocol_constants.h');
const TS_SCHEMA_PATH = resolve(ROOT, 'electron/stageC/protocol/schema.ts');

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function readCppConstants(): string {
  return readFileSync(CPP_CONSTANTS_PATH, 'utf-8');
}

function readTsSchema(): string {
  return readFileSync(TS_SCHEMA_PATH, 'utf-8');
}

function extractCppNumeric(source: string, name: string): number | null {
  const pattern = new RegExp(`(?:inline\\s+)?constexpr\\s+\\S+\\s+${name}\\s*=\\s*([\\d']+)`, 'm');
  const match = source.match(pattern);
  if (!match) return null;
  return parseInt(match[1].replace(/'/g, ''), 10);
}

function extractCppString(source: string, name: string): string | null {
  const pattern = new RegExp(
    `(?:inline\\s+)?constexpr\\s+std::string_view\\s+${name}\\s*=\\s*"([^"]*)"`,
    'm',
  );
  const match = source.match(pattern);
  return match ? match[1] : null;
}

function extractCppNamespaceStrings(source: string, namespaceName: string): string[] {
  const nsPattern = new RegExp(`namespace\\s+${namespaceName}\\s*\\{([^}]+)\\}`, 's');
  const nsMatch = source.match(nsPattern);
  if (!nsMatch) return [];
  const valuePattern = /=\s*"([^"]+)"/g;
  const values: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = valuePattern.exec(nsMatch[1])) !== null) {
    values.push(m[1]);
  }
  return values;
}

/**
 * Compute deterministic content hash of the canonical TS schema.
 * Same algorithm as check-schema-parity.mjs — SHA-256 of normalized
 * content (comments and whitespace stripped), first 16 hex chars.
 */
function computeSchemaContentHash(tsSource: string): string {
  const meaningful = tsSource
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').trim())
    .filter(line => line.length > 0)
    .join('\n');
  return createHash('sha256').update(meaningful, 'utf-8').digest('hex').slice(0, 16);
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('Schema parity — C++ matches TypeScript canonical source', () => {
  const cppSource = readCppConstants();
  const tsSource = readTsSchema();

  describe('Protocol version constants', () => {
    it('PROTOCOL_MAJOR matches', () => {
      expect(extractCppNumeric(cppSource, 'PROTOCOL_MAJOR')).toBe(PROTOCOL_MAJOR);
    });

    it('PROTOCOL_MINOR matches', () => {
      expect(extractCppNumeric(cppSource, 'PROTOCOL_MINOR')).toBe(PROTOCOL_MINOR);
    });

    it('BRIDGE_SCHEMA_VERSION matches', () => {
      expect(extractCppNumeric(cppSource, 'BRIDGE_SCHEMA_VERSION')).toBe(BRIDGE_SCHEMA_VERSION);
    });

    it('SCHEMA_HASH_VERSION matches', () => {
      expect(extractCppString(cppSource, 'SCHEMA_HASH_VERSION')).toBe(SCHEMA_HASH_VERSION);
    });
  });

  describe('Schema content hash', () => {
    it('C++ SCHEMA_CONTENT_HASH matches computed hash of TypeScript schema', () => {
      const expectedHash = computeSchemaContentHash(tsSource);
      const cppHash = extractCppString(cppSource, 'SCHEMA_CONTENT_HASH');
      expect(cppHash).not.toBeNull();
      expect(cppHash).toBe(expectedHash);
    });
  });

  describe('Size limit constants', () => {
    it('MAX_FRAME_BYTES matches', () => {
      expect(extractCppNumeric(cppSource, 'MAX_FRAME_BYTES')).toBe(MAX_FRAME_BYTES);
    });

    it('MAX_BRIDGE_MESSAGE_BYTES matches', () => {
      expect(extractCppNumeric(cppSource, 'MAX_BRIDGE_MESSAGE_BYTES')).toBe(MAX_BRIDGE_MESSAGE_BYTES);
    });

    it('MAX_TELEMETRY_EVENT_BYTES matches', () => {
      expect(extractCppNumeric(cppSource, 'MAX_TELEMETRY_EVENT_BYTES')).toBe(MAX_TELEMETRY_EVENT_BYTES);
    });

    it('MAX_REPLAY_CACHE_ENTRIES matches', () => {
      expect(extractCppNumeric(cppSource, 'MAX_REPLAY_CACHE_ENTRIES')).toBe(MAX_REPLAY_CACHE_ENTRIES);
    });

    it('MAX_QUEUED_MESSAGES matches', () => {
      expect(extractCppNumeric(cppSource, 'MAX_QUEUED_MESSAGES')).toBe(MAX_QUEUED_MESSAGES);
    });

    it('MAX_QUEUED_BYTES matches', () => {
      expect(extractCppNumeric(cppSource, 'MAX_QUEUED_BYTES')).toBe(MAX_QUEUED_BYTES);
    });
  });

  describe('Controller → Sidecar message types', () => {
    const cppC2sTypes = extractCppNamespaceStrings(cppSource, 'controller_to_sidecar');
    const tsC2sValues = Object.values(ControllerToSidecarType);

    it('has matching count', () => {
      expect(cppC2sTypes.length).toBe(tsC2sValues.length);
    });

    it('every TypeScript type exists in C++', () => {
      for (const tsType of tsC2sValues) {
        expect(cppC2sTypes).toContain(tsType);
      }
    });

    it('no extra types in C++', () => {
      for (const cppType of cppC2sTypes) {
        expect(tsC2sValues).toContain(cppType as ControllerToSidecarType);
      }
    });
  });

  describe('Sidecar → Controller message types', () => {
    const cppS2cTypes = extractCppNamespaceStrings(cppSource, 'sidecar_to_controller');
    const tsS2cValues = Object.values(SidecarToControllerType);

    it('has matching count', () => {
      expect(cppS2cTypes.length).toBe(tsS2cValues.length);
    });

    it('every TypeScript type exists in C++', () => {
      for (const tsType of tsS2cValues) {
        expect(cppS2cTypes).toContain(tsType);
      }
    });

    it('no extra types in C++', () => {
      for (const cppType of cppS2cTypes) {
        expect(tsS2cValues).toContain(cppType as SidecarToControllerType);
      }
    });
  });

  describe('Validation error codes', () => {
    const cppValidationCodes = extractCppNamespaceStrings(cppSource, 'validation');
    const tsValidationValues = Object.values(ValidationErrorCode);

    it('every TypeScript validation code exists in C++', () => {
      for (const tsCode of tsValidationValues) {
        expect(cppValidationCodes).toContain(tsCode);
      }
    });

    it('no extra validation codes in C++', () => {
      for (const cppCode of cppValidationCodes) {
        expect(tsValidationValues).toContain(cppCode as ValidationErrorCode);
      }
    });
  });
});
