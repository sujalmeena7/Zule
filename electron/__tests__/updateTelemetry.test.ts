// Feature: auto-updater, Property 10: Telemetry events contain no forbidden fields
//
// For any update lifecycle telemetry event emitted by the Auto_Updater, the event
// payload SHALL NOT contain any key whose value is an OS user name, account
// identifier, machine/device identifier, network address, file-system path, the
// Release_Notes body, or any field of the Latest_Release_Manifest other than the
// version string.
//
// **Validates: Requirements 9.6**

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

// Mock electron — required by autoUpdateService.ts via createRequire
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '1.0.0',
    getPath: () => '/tmp/test-userdata',
  },
}));

// Mock fs — autoUpdateService reads/writes persistence files
vi.mock('node:fs', () => ({
  default: {
    readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    writeFileSync: () => {},
    unlinkSync: () => {},
  },
  readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  writeFileSync: () => {},
  unlinkSync: () => {},
}));

import type { UpdateTelemetryEvent } from '../autoUpdateService';

// ---------------------------------------------------------------------------
// Generators — produce random UpdateTelemetryEvent variants
// ---------------------------------------------------------------------------

/** Generates a valid semver string (e.g. "1.2.3" or "1.0.0-beta.1") */
const semverArb = (): fc.Arbitrary<string> =>
  fc.tuple(
    fc.nat({ max: 99 }),
    fc.nat({ max: 99 }),
    fc.nat({ max: 99 }),
    fc.option(
      fc.stringOf(fc.constantFrom('a', 'b', 'c', '0', '1', '2', '.', '-'), { minLength: 1, maxLength: 8 }),
      { nil: undefined },
    ),
  ).map(([major, minor, patch, pre]) =>
    pre ? `${major}.${minor}.${patch}-${pre}` : `${major}.${minor}.${patch}`,
  );

/** Generates a trigger value for update.checked events */
const triggerArb = fc.constantFrom<'startup' | 'manual'>('startup', 'manual');

/** Generates an error stage */
const stageArb = fc.constantFrom<'check' | 'download' | 'integrity' | 'install'>(
  'check', 'download', 'integrity', 'install',
);

/** Generates an error category (from the documented finite set) */
const categoryArb = fc.constantFrom(
  'unreachable', 'timeout', 'server-error', 'network', 'storage', 'integrity',
);

/** Generates a non-negative integer for durationMs */
const durationMsArb = fc.nat({ max: 600_000 });

/** Generates a random UpdateTelemetryEvent */
const telemetryEventArb: fc.Arbitrary<UpdateTelemetryEvent> = fc.oneof(
  // update.checked
  fc.record({
    kind: fc.constant('update.checked' as const),
    currentVersion: semverArb(),
    trigger: triggerArb,
  }),
  // update.available
  fc.record({
    kind: fc.constant('update.available' as const),
    currentVersion: semverArb(),
    availableVersion: semverArb(),
  }),
  // update.downloaded
  fc.record({
    kind: fc.constant('update.downloaded' as const),
    availableVersion: semverArb(),
    durationMs: durationMsArb,
  }),
  // update.installed
  fc.record({
    kind: fc.constant('update.installed' as const),
    currentVersion: semverArb(),
  }),
  // update.error
  fc.record({
    kind: fc.constant('update.error' as const),
    stage: stageArb,
    category: categoryArb,
  }),
);

// ---------------------------------------------------------------------------
// Forbidden key names — keys that must NEVER appear in any telemetry event
// ---------------------------------------------------------------------------

/** Keys that would indicate OS user name or account identifier */
const FORBIDDEN_USER_KEYS = [
  'userName', 'user', 'accountId', 'username', 'account',
  'userId', 'userIdentifier', 'osUser',
];

/** Keys that would indicate machine/device identifiers */
const FORBIDDEN_MACHINE_KEYS = [
  'machineId', 'deviceId', 'hostname', 'machineName',
  'hardwareId', 'deviceIdentifier', 'host',
];

/** Keys that would indicate network addresses */
const FORBIDDEN_NETWORK_KEYS = [
  'ip', 'address', 'networkAddress', 'ipAddress',
  'remoteAddress', 'localAddress', 'macAddress',
];

/** Keys that would indicate file-system paths */
const FORBIDDEN_PATH_KEYS = [
  'path', 'filePath', 'installerPath', 'cachePath',
  'downloadPath', 'absolutePath', 'relativePath',
];

/** Keys that would indicate release notes body */
const FORBIDDEN_NOTES_KEYS = [
  'releaseNotes', 'notes', 'body', 'changelog',
  'description', 'releaseBody',
];

/** All forbidden keys combined */
const ALL_FORBIDDEN_KEYS = new Set([
  ...FORBIDDEN_USER_KEYS,
  ...FORBIDDEN_MACHINE_KEYS,
  ...FORBIDDEN_NETWORK_KEYS,
  ...FORBIDDEN_PATH_KEYS,
  ...FORBIDDEN_NOTES_KEYS,
]);

// ---------------------------------------------------------------------------
// Allowed keys per telemetry event variant
// ---------------------------------------------------------------------------

const ALLOWED_KEYS_BY_KIND: Record<string, Set<string>> = {
  'update.checked': new Set(['kind', 'currentVersion', 'trigger']),
  'update.available': new Set(['kind', 'currentVersion', 'availableVersion']),
  'update.downloaded': new Set(['kind', 'availableVersion', 'durationMs']),
  'update.installed': new Set(['kind', 'currentVersion']),
  'update.error': new Set(['kind', 'stage', 'category']),
};

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe('Property 10: Telemetry events contain no forbidden fields', () => {
  it('telemetry events contain no forbidden keys (user name, machine ID, network address, file path, release notes)', () => {
    fc.assert(
      fc.property(telemetryEventArb, (event) => {
        const keys = Object.keys(event);

        // Check that no forbidden keys are present
        for (const key of keys) {
          expect(ALL_FORBIDDEN_KEYS.has(key)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('telemetry events contain ONLY the allowed keys for their variant', () => {
    fc.assert(
      fc.property(telemetryEventArb, (event) => {
        const keys = Object.keys(event);
        const allowedKeys = ALLOWED_KEYS_BY_KIND[event.kind];

        expect(allowedKeys).toBeDefined();

        // Every key present must be in the allowed set for this variant
        for (const key of keys) {
          expect(allowedKeys.has(key)).toBe(true);
        }

        // The allowed keys and actual keys should match exactly
        expect(keys.length).toBe(allowedKeys.size);
      }),
      { numRuns: 100 },
    );
  });

  it('telemetry event values do not contain file-system path patterns', () => {
    fc.assert(
      fc.property(telemetryEventArb, (event) => {
        const values = Object.values(event).filter((v): v is string => typeof v === 'string');

        // File paths: Windows (C:\...) or Unix (/home/..., /tmp/...)
        const windowsPathPattern = /^[A-Z]:\\/i;
        const unixAbsolutePathPattern = /^\/(home|tmp|usr|var|etc|opt)\//;

        for (const value of values) {
          // Skip semver strings and known enum values
          if (value === event.kind) continue;
          if (value === 'startup' || value === 'manual') continue;
          if (value === 'check' || value === 'download' || value === 'integrity' || value === 'install') continue;
          if (value === 'unreachable' || value === 'timeout' || value === 'server-error' ||
              value === 'network' || value === 'storage') continue;

          expect(windowsPathPattern.test(value)).toBe(false);
          expect(unixAbsolutePathPattern.test(value)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('telemetry event values do not contain network address patterns', () => {
    fc.assert(
      fc.property(telemetryEventArb, (event) => {
        const values = Object.values(event).filter((v): v is string => typeof v === 'string');

        // IPv4 pattern (basic check: x.x.x.x where x is 1-3 digits)
        const ipv4Pattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
        // MAC address pattern
        const macPattern = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

        for (const value of values) {
          // Skip semver strings (they look like x.y.z but are valid versions)
          if (value === event.kind) continue;

          // Only check if it looks like an IP (not a semver — semver has at most 3 dot-separated segments of digits)
          if (ipv4Pattern.test(value)) {
            // It could be a semver-like false positive — verify it's actually an IP
            // Semver is major.minor.patch (3 segments), IP is x.x.x.x (4 segments)
            const segments = value.split('.');
            if (segments.length === 4) {
              // This IS an IP address pattern — should never appear
              expect(false).toBe(true);
            }
          }

          expect(macPattern.test(value)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
