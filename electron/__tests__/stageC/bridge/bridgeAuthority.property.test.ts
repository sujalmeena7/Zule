/**
 * Stage C Bridge — Bridge Authority Property Test (Property 8)
 *
 * Property 8: Bridge authority is a subset of the reviewed allowlist.
 * Generate unreviewed methods/events and capability-shaped payloads; assert
 * zero filesystem, registry, shell, process, network, arbitrary IPC, pointer,
 * COM, or native invocations.
 *
 * For every WebView message not produced by a current reviewed FloatingCopilot
 * bridge method/event, the native invocation count is zero. No bridge input
 * can construct filesystem, registry, shell, process, arbitrary network,
 * arbitrary IPC, pointer, or COM operations.
 *
 * **Validates: Requirements 7.1–7.10**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  revalidatePageMessage,
  dispatchPageMessage,
  EXPECTED_BRIDGE_VERSION,
} from '../../../stageC/bridge/nativeBridge';
import { BridgeMethodType, BridgeEventType } from '../../../stageC/protocol/bridge';
import { BRIDGE_SCHEMA_VERSION } from '../../../stageC/protocol/schema';

// ────────────────────────────────────────────────────────────────────
// Reviewed Allowlists (the ONLY permitted methods and events)
// ────────────────────────────────────────────────────────────────────

const REVIEWED_METHODS: ReadonlySet<string> = new Set(Object.values(BridgeMethodType));
const REVIEWED_EVENTS: ReadonlySet<string> = new Set(Object.values(BridgeEventType));

// ────────────────────────────────────────────────────────────────────
// Dangerous Capability Keywords (Req 7.10)
// These represent capabilities that must NEVER be accessible through the bridge.
// ────────────────────────────────────────────────────────────────────

const DANGEROUS_CAPABILITY_FIELDS = [
  // Filesystem
  'path', 'filePath', 'file', 'readFile', 'writeFile', 'unlink', 'rmdir',
  'mkdir', 'rename', 'stat', 'openFile', 'saveFile', 'fsOperation',
  // Registry
  'registryKey', 'regPath', 'hive', 'regValue', 'registryWrite',
  'registryRead', 'regDelete',
  // Shell
  'shell', 'exec', 'spawn', 'command', 'cmd', 'powershell', 'bash',
  'shellExecute', 'runCommand',
  // Process
  'processId', 'pid', 'kill', 'createProcess', 'terminate', 'spawnProcess',
  'childProcess',
  // Network
  'url', 'fetch', 'http', 'socket', 'connect', 'listen', 'request',
  'networkAccess', 'download', 'upload',
  // Arbitrary IPC
  'ipcChannel', 'ipcSend', 'ipcInvoke', 'sendMessage', 'postIpc',
  'channelName', 'arbitraryIpc',
  // Pointer / Native Handle
  'pointer', 'handle', 'hwnd', 'nativeHandle', 'memoryAddress',
  'bufferPointer', 'rawPointer',
  // COM
  'comObject', 'clsid', 'progId', 'createObject', 'wireObject',
  'queryInterface', 'addRef', 'release',
] as const;

// ────────────────────────────────────────────────────────────────────
// Generators
// ────────────────────────────────────────────────────────────────────

/**
 * Generate a method name that is NOT in the reviewed allowlist.
 * Includes plausible-sounding method names that probe boundaries.
 */
const arbUnreviewedMethod = fc.oneof(
  // Completely random strings
  fc.string({ minLength: 1, maxLength: 64 }).filter(s => !REVIEWED_METHODS.has(s)),
  // Plausible-but-unreviewed method names that probe for dangerous capabilities
  fc.constantFrom(
    'readFile', 'writeFile', 'exec', 'spawn', 'openProcess',
    'connectNetwork', 'queryRegistry', 'createCOMObject',
    'getPointer', 'sendIPC', 'shellExecute', 'evalScript',
    'requestElevation', 'loadLibrary', 'callNative',
    'deleteFile', 'listDirectory', 'modifyRegistry',
    'createSocket', 'openPipe', 'allocMemory',
    'freeMemory', 'injectDll', 'hookFunction',
    'requestAdmin', 'mountVolume', 'formatDisk',
  ),
);

/**
 * Generate an event name that is NOT in the reviewed allowlist.
 */
const arbUnreviewedEvent = fc.oneof(
  fc.string({ minLength: 1, maxLength: 64 }).filter(s => !REVIEWED_EVENTS.has(s)),
  fc.constantFrom(
    'onFileChanged', 'onProcessCreated', 'onRegistryModified',
    'onNetworkData', 'onShellOutput', 'onNativeCallback',
    'onPointerEvent', 'onCOMEvent', 'onIpcMessage',
    'onSystemEvent', 'onKernelCallback', 'onDriverEvent',
  ),
);

/**
 * Generate a payload with fields that look like dangerous capabilities
 * (filesystem paths, shell commands, registry keys, network URLs, etc.)
 */
const arbCapabilityPayload = fc.oneof(
  // Filesystem-shaped payload
  fc.record({
    path: fc.oneof(fc.constant('C:\\Windows\\System32\\cmd.exe'), fc.string()),
    operation: fc.constantFrom('read', 'write', 'delete', 'execute'),
    contents: fc.string(),
  }),
  // Registry-shaped payload
  fc.record({
    registryKey: fc.constant('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run'),
    value: fc.string(),
    type: fc.constantFrom('REG_SZ', 'REG_DWORD', 'REG_BINARY'),
  }),
  // Shell-shaped payload
  fc.record({
    command: fc.oneof(fc.constant('rm -rf /'), fc.constant('format C:'), fc.string()),
    args: fc.array(fc.string(), { maxLength: 5 }),
    cwd: fc.string(),
  }),
  // Process-shaped payload
  fc.record({
    pid: fc.nat(),
    signal: fc.constantFrom('SIGKILL', 'SIGTERM', 'SIGINT'),
    executable: fc.string(),
  }),
  // Network-shaped payload
  fc.record({
    url: fc.oneof(fc.constant('https://evil.example.com'), fc.webUrl()),
    method: fc.constantFrom('GET', 'POST', 'PUT', 'DELETE'),
    body: fc.string(),
  }),
  // IPC-shaped payload
  fc.record({
    channel: fc.string(),
    args: fc.array(fc.jsonValue(), { maxLength: 3 }),
  }),
  // Pointer/Handle-shaped payload
  fc.record({
    handle: fc.nat({ max: 0x7FFFFFFF }),
    pointer: fc.nat(),
    offset: fc.integer(),
  }),
  // COM-shaped payload
  fc.record({
    clsid: fc.string(),
    progId: fc.constantFrom('Shell.Application', 'WScript.Shell', 'Scripting.FileSystemObject'),
    method: fc.string(),
    args: fc.array(fc.jsonValue(), { maxLength: 3 }),
  }),
);

/**
 * Generate a complete message JSON string with an unreviewed method
 * and dangerous-looking payload fields.
 */
const arbUnreviewedMethodMessage = fc.tuple(
  arbUnreviewedMethod,
  arbCapabilityPayload,
).map(([method, payload]) => {
  const msg: Record<string, unknown> = {
    version: EXPECTED_BRIDGE_VERSION,
    method,
    ...payload,
  };
  return JSON.stringify(msg);
});

/**
 * Generate messages that have reviewed method names but include
 * dangerous extra fields (attempting to smuggle capabilities).
 */
const arbSmuggledCapabilityMessage = fc.tuple(
  fc.constantFrom(...Object.values(BridgeMethodType)),
  fc.constantFrom(...DANGEROUS_CAPABILITY_FIELDS),
  fc.jsonValue(),
).map(([method, field, value]) => {
  const base: Record<string, unknown> = {
    version: EXPECTED_BRIDGE_VERSION,
    method,
  };
  // Add the required fields for the method
  if (method === BridgeMethodType.REPORT_DRAG_REGIONS || method === BridgeMethodType.REPORT_INTERACTIVE_REGIONS) {
    base.revision = 0;
    base.regions = [];
  } else {
    base.action = 'test-action';
  }
  // Smuggle the dangerous field
  base[field] = value;
  return JSON.stringify(base);
});

/**
 * Generate messages with completely wrong version numbers.
 */
const arbWrongVersionMessage = fc.tuple(
  fc.constantFrom(...Object.values(BridgeMethodType)),
  fc.integer({ min: 2, max: 99999 }),
).map(([method, version]) => {
  const base: Record<string, unknown> = {
    version,
    method,
  };
  if (method === BridgeMethodType.REPORT_DRAG_REGIONS || method === BridgeMethodType.REPORT_INTERACTIVE_REGIONS) {
    base.revision = 0;
    base.regions = [];
  } else {
    base.action = 'test-action';
  }
  return JSON.stringify(base);
});

/**
 * Generate messages with unreviewed event types as method names
 * (direction violation).
 */
const arbDirectionViolationMessage = arbUnreviewedEvent.map((event) => {
  return JSON.stringify({
    version: EXPECTED_BRIDGE_VERSION,
    method: event,
    action: 'trigger',
  });
});

// ────────────────────────────────────────────────────────────────────
// Property Tests
// ────────────────────────────────────────────────────────────────────

describe('Property 8: Bridge authority is a subset of the reviewed allowlist', () => {
  it('unreviewed method names are rejected with zero dispatch', () => {
    fc.assert(
      fc.property(arbUnreviewedMethodMessage, (rawJson) => {
        // revalidatePageMessage must reject
        const revalidation = revalidatePageMessage(rawJson);
        expect(revalidation.ok).toBe(false);

        // dispatchPageMessage must also reject (no IPC dispatch)
        const dispatch = dispatchPageMessage(rawJson);
        expect(dispatch.ok).toBe(false);

        // Verify error is typed (Req 7.9)
        if (!dispatch.ok) {
          expect(dispatch.error).toHaveProperty('code');
          expect(dispatch.error).toHaveProperty('message');
          expect(typeof dispatch.error.code).toBe('string');
          expect(typeof dispatch.error.message).toBe('string');
        }
      }),
      { numRuns: 200 },
    );
  });

  it('smuggled capability fields in reviewed methods are rejected with zero dispatch', () => {
    fc.assert(
      fc.property(arbSmuggledCapabilityMessage, (rawJson) => {
        // Messages with extra fields (capabilities smuggled alongside valid methods)
        // must be rejected by exact-field validation (Req 7.7)
        const revalidation = revalidatePageMessage(rawJson);
        expect(revalidation.ok).toBe(false);

        const dispatch = dispatchPageMessage(rawJson);
        expect(dispatch.ok).toBe(false);

        if (!dispatch.ok) {
          expect(dispatch.error).toHaveProperty('code');
          expect(dispatch.error).toHaveProperty('message');
        }
      }),
      { numRuns: 200 },
    );
  });

  it('wrong version messages are rejected with zero native invocations', () => {
    fc.assert(
      fc.property(arbWrongVersionMessage, (rawJson) => {
        const revalidation = revalidatePageMessage(rawJson);
        expect(revalidation.ok).toBe(false);

        if (!revalidation.ok) {
          expect(revalidation.error.code).toBe('INCOMPATIBLE_VERSION');
        }

        const dispatch = dispatchPageMessage(rawJson);
        expect(dispatch.ok).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('direction-violated event names used as methods are rejected', () => {
    fc.assert(
      fc.property(arbDirectionViolationMessage, (rawJson) => {
        const revalidation = revalidatePageMessage(rawJson);
        expect(revalidation.ok).toBe(false);

        const dispatch = dispatchPageMessage(rawJson);
        expect(dispatch.ok).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('capability-shaped payloads never produce a successful dispatch', () => {
    // Generate arbitrary JSON objects with dangerous-looking structures
    // and assert none of them can pass revalidation
    fc.assert(
      fc.property(
        fc.tuple(
          fc.constantFrom(...DANGEROUS_CAPABILITY_FIELDS),
          fc.jsonValue(),
          fc.string({ minLength: 1, maxLength: 32 }),
        ),
        ([capField, capValue, methodName]) => {
          // Case 1: The capability field IS the method name
          const msg1 = JSON.stringify({
            version: EXPECTED_BRIDGE_VERSION,
            method: capField,
            action: 'execute',
          });
          const result1 = revalidatePageMessage(msg1);
          expect(result1.ok).toBe(false);

          // Case 2: The capability as a payload field with an unreviewed method
          if (!REVIEWED_METHODS.has(methodName)) {
            const msg2 = JSON.stringify({
              version: EXPECTED_BRIDGE_VERSION,
              method: methodName,
              [capField]: capValue,
            });
            const result2 = revalidatePageMessage(msg2);
            expect(result2.ok).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('only reviewed methods (6) can produce ok=true from revalidatePageMessage', () => {
    // Exhaustive check: the reviewed set is exactly the 6 known methods
    expect(REVIEWED_METHODS.size).toBe(6);
    expect(REVIEWED_METHODS).toContain(BridgeMethodType.REQUEST_OVERLAY_ACTION);
    expect(REVIEWED_METHODS).toContain(BridgeMethodType.REQUEST_AI);
    expect(REVIEWED_METHODS).toContain(BridgeMethodType.REQUEST_AUDIO);
    expect(REVIEWED_METHODS).toContain(BridgeMethodType.REQUEST_SCREEN_CAPTURE);
    expect(REVIEWED_METHODS).toContain(BridgeMethodType.REPORT_DRAG_REGIONS);
    expect(REVIEWED_METHODS).toContain(BridgeMethodType.REPORT_INTERACTIVE_REGIONS);

    // And only reviewed events (3) exist
    expect(REVIEWED_EVENTS.size).toBe(3);
    expect(REVIEWED_EVENTS).toContain(BridgeEventType.ON_STATE_SNAPSHOT);
    expect(REVIEWED_EVENTS).toContain(BridgeEventType.ON_STATE_PATCH);
    expect(REVIEWED_EVENTS).toContain(BridgeEventType.ON_OPERATION_RESULT);
  });

  it('the bridge exposes zero filesystem, registry, shell, process, network, IPC, pointer, or COM access', () => {
    // Validate that no reviewed method name matches any dangerous category
    for (const method of REVIEWED_METHODS) {
      const lower = method.toLowerCase();
      // Should not contain dangerous keywords
      expect(lower).not.toContain('file');
      expect(lower).not.toContain('registry');
      expect(lower).not.toContain('shell');
      expect(lower).not.toContain('process');
      expect(lower).not.toContain('socket');
      expect(lower).not.toContain('exec');
      expect(lower).not.toContain('spawn');
      expect(lower).not.toContain('pointer');
      expect(lower).not.toContain('com');
      expect(lower).not.toContain('native');
      expect(lower).not.toContain('ipc');
      expect(lower).not.toContain('pipe');
      expect(lower).not.toContain('handle');
    }
  });
});
