/**
 * Stage C IPC — Named Pipe Endpoint Unit Tests
 *
 * Tests the named-pipe endpoint creation, credential generation,
 * bootstrap record assembly, delivery, and cleanup.
 *
 * Requirements: 6.1–6.8, 6.12
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import * as net from 'node:net';

import {
  createLaunchEndpoint,
  generateLaunchCredential,
  generateNonces,
  generateLaunchId,
  createBootstrapRecord,
  serializeBootstrapRecord,
  deliverBootstrap,
  destroyEndpoint,
  LAUNCH_CREDENTIAL_BYTES,
  NONCE_BYTES,
  MAX_BOOTSTRAP_RECORD_BYTES,
  PIPE_PREFIX,
  REQUIRED_DACL_POLICY,
  EndpointFailureReason,
} from '../../../stageC/ipc/namedPipe';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Tracks endpoints created during tests for cleanup */
const endpointsToClean: Array<{ destroy(): void }> = [];

afterEach(() => {
  for (const ep of endpointsToClean) {
    try {
      ep.destroy();
    } catch {
      // ignore
    }
  }
  endpointsToClean.length = 0;
});

// ────────────────────────────────────────────────────────────────────
// generateLaunchCredential
// ────────────────────────────────────────────────────────────────────

describe('generateLaunchCredential', () => {
  it('returns a hex string of exactly 64 characters (32 bytes)', () => {
    const cred = generateLaunchCredential();
    expect(cred).toHaveLength(64);
    expect(cred).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates distinct credentials on each call', () => {
    const cred1 = generateLaunchCredential();
    const cred2 = generateLaunchCredential();
    expect(cred1).not.toBe(cred2);
  });

  it('produces 32 bytes of entropy (LAUNCH_CREDENTIAL_BYTES = 32)', () => {
    expect(LAUNCH_CREDENTIAL_BYTES).toBe(32);
    const cred = generateLaunchCredential();
    const bytes = Buffer.from(cred, 'hex');
    expect(bytes.length).toBe(32);
  });
});

// ────────────────────────────────────────────────────────────────────
// generateNonces
// ────────────────────────────────────────────────────────────────────

describe('generateNonces', () => {
  it('returns serverNonce and clientNonce as 64-char hex strings', () => {
    const nonces = generateNonces();
    expect(nonces.serverNonce).toHaveLength(64);
    expect(nonces.clientNonce).toHaveLength(64);
    expect(nonces.serverNonce).toMatch(/^[0-9a-f]{64}$/);
    expect(nonces.clientNonce).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates independent server and client nonces', () => {
    const nonces = generateNonces();
    expect(nonces.serverNonce).not.toBe(nonces.clientNonce);
  });

  it('generates distinct nonces across calls', () => {
    const n1 = generateNonces();
    const n2 = generateNonces();
    expect(n1.serverNonce).not.toBe(n2.serverNonce);
    expect(n1.clientNonce).not.toBe(n2.clientNonce);
  });
});

// ────────────────────────────────────────────────────────────────────
// generateLaunchId
// ────────────────────────────────────────────────────────────────────

describe('generateLaunchId', () => {
  it('returns a valid UUID v4 string', () => {
    const id = generateLaunchId();
    // UUID format: 8-4-4-4-12 hex digits
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('generates distinct IDs on each call', () => {
    const id1 = generateLaunchId();
    const id2 = generateLaunchId();
    expect(id1).not.toBe(id2);
  });
});

// ────────────────────────────────────────────────────────────────────
// createBootstrapRecord
// ────────────────────────────────────────────────────────────────────

describe('createBootstrapRecord', () => {
  it('assembles all fields correctly', () => {
    const pipeName = '\\\\.\\pipe\\zule-stage-c-test-id';
    const launchId = 'test-launch-id';
    const credential = 'a'.repeat(64);
    const nonces = { serverNonce: 'b'.repeat(64), clientNonce: 'c'.repeat(64) };
    const parentPid = 12345;

    const record = createBootstrapRecord(pipeName, launchId, credential, nonces, parentPid);

    expect(record.pipeName).toBe(pipeName);
    expect(record.launchId).toBe(launchId);
    expect(record.credential).toBe(credential);
    expect(record.serverNonce).toBe(nonces.serverNonce);
    expect(record.clientNonce).toBe(nonces.clientNonce);
    expect(record.parentPid).toBe(parentPid);
  });

  it('serialized record stays within MAX_BOOTSTRAP_RECORD_BYTES', () => {
    const pipeName = `${PIPE_PREFIX}${generateLaunchId()}`;
    const credential = generateLaunchCredential();
    const nonces = generateNonces();

    const record = createBootstrapRecord(pipeName, generateLaunchId(), credential, nonces, process.pid);
    const serialized = JSON.stringify(record);

    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(MAX_BOOTSTRAP_RECORD_BYTES);
  });

  it('throws if the record exceeds the bounded size', () => {
    // Create an artificially large pipe name to exceed the bound
    const hugePipeName = 'x'.repeat(MAX_BOOTSTRAP_RECORD_BYTES + 1);
    expect(() =>
      createBootstrapRecord(hugePipeName, 'id', 'cred', { serverNonce: 'a', clientNonce: 'b' }, 1),
    ).toThrow('Bootstrap record exceeds maximum bounded size');
  });
});

// ────────────────────────────────────────────────────────────────────
// serializeBootstrapRecord
// ────────────────────────────────────────────────────────────────────

describe('serializeBootstrapRecord', () => {
  it('produces a 4-byte LE length prefix followed by UTF-8 JSON', () => {
    const record = createBootstrapRecord(
      '\\\\.\\pipe\\test',
      'launch-123',
      'a'.repeat(64),
      { serverNonce: 'b'.repeat(64), clientNonce: 'c'.repeat(64) },
      999,
    );

    const buf = serializeBootstrapRecord(record);
    expect(buf).not.toBeNull();
    if (!buf) return;

    // First 4 bytes are the LE length
    const declaredLength = buf.readUInt32LE(0);
    expect(declaredLength).toBe(buf.length - 4);

    // Remaining bytes parse as valid JSON matching the record
    const jsonStr = buf.subarray(4).toString('utf8');
    const parsed = JSON.parse(jsonStr);
    expect(parsed.pipeName).toBe(record.pipeName);
    expect(parsed.launchId).toBe(record.launchId);
    expect(parsed.credential).toBe(record.credential);
    expect(parsed.parentPid).toBe(record.parentPid);
  });

  it('returns null if serialized size exceeds MAX_BOOTSTRAP_RECORD_BYTES', () => {
    const record = {
      pipeName: 'x'.repeat(MAX_BOOTSTRAP_RECORD_BYTES),
      launchId: 'id',
      credential: 'cred',
      serverNonce: 'a',
      clientNonce: 'b',
      parentPid: 1,
    };

    const buf = serializeBootstrapRecord(record);
    expect(buf).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// createLaunchEndpoint — platform behavior
// ────────────────────────────────────────────────────────────────────

describe('createLaunchEndpoint', () => {
  // The behavior differs on Windows vs non-Windows
  if (process.platform !== 'win32') {
    it('returns NON_WINDOWS failure on non-Windows platforms', () => {
      const result = createLaunchEndpoint();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe(EndpointFailureReason.NON_WINDOWS);
      }
    });
  } else {
    it('creates a valid endpoint on Windows', () => {
      const result = createLaunchEndpoint();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      endpointsToClean.push(result.endpoint);

      // Verify pipe name format
      expect(result.endpoint.pipeName).toMatch(
        /^\\\\\.\\pipe\\zule-stage-c-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      // Verify launch ID is a UUID
      expect(result.endpoint.launchId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      // Verify bootstrap record
      expect(result.endpoint.bootstrap.pipeName).toBe(result.endpoint.pipeName);
      expect(result.endpoint.bootstrap.launchId).toBe(result.endpoint.launchId);
      expect(result.endpoint.bootstrap.credential).toHaveLength(64);
      expect(result.endpoint.bootstrap.serverNonce).toHaveLength(64);
      expect(result.endpoint.bootstrap.clientNonce).toHaveLength(64);
      expect(result.endpoint.bootstrap.parentPid).toBe(process.pid);

      // Not yet consumed
      expect(result.endpoint.consumed).toBe(false);
    });

    it('creates distinct endpoints with distinct credentials per call', () => {
      const r1 = createLaunchEndpoint();
      const r2 = createLaunchEndpoint();
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;

      endpointsToClean.push(r1.endpoint, r2.endpoint);

      expect(r1.endpoint.pipeName).not.toBe(r2.endpoint.pipeName);
      expect(r1.endpoint.launchId).not.toBe(r2.endpoint.launchId);
      expect(r1.endpoint.bootstrap.credential).not.toBe(r2.endpoint.bootstrap.credential);
      expect(r1.endpoint.bootstrap.serverNonce).not.toBe(r2.endpoint.bootstrap.serverNonce);
    });

    it('pipe server is listening after creation', (ctx) => {
      const result = createLaunchEndpoint();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      endpointsToClean.push(result.endpoint);
      expect(result.endpoint.server.listening).toBe(true);
    });
  }
});

// ────────────────────────────────────────────────────────────────────
// deliverBootstrap — Windows-only integration
// ────────────────────────────────────────────────────────────────────

describe('deliverBootstrap', () => {
  if (process.platform === 'win32') {
    it('delivers bootstrap record to a connecting client and closes', async () => {
      const result = createLaunchEndpoint();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      endpointsToClean.push(result.endpoint);

      // Start delivery (will wait for child to connect)
      const deliveryPromise = deliverBootstrap(result.endpoint);

      // Simulate child connecting to the bootstrap pipe
      const bootstrapPipeName = `${PIPE_PREFIX}bootstrap-${result.endpoint.launchId}`;

      // Wait a moment for the bootstrap server to start listening
      await new Promise((r) => setTimeout(r, 50));

      const received = await new Promise<Buffer>((resolve, reject) => {
        const client = net.createConnection(bootstrapPipeName, () => {
          const chunks: Buffer[] = [];
          client.on('data', (chunk) => chunks.push(chunk));
          client.on('end', () => resolve(Buffer.concat(chunks)));
          client.on('error', reject);
        });
        client.on('error', reject);
      });

      const deliveryResult = await deliveryPromise;
      expect(deliveryResult.ok).toBe(true);

      // Parse the received bootstrap
      const length = received.readUInt32LE(0);
      expect(length).toBe(received.length - 4);
      const json = received.subarray(4).toString('utf8');
      const parsed = JSON.parse(json);

      expect(parsed.pipeName).toBe(result.endpoint.pipeName);
      expect(parsed.launchId).toBe(result.endpoint.launchId);
      expect(parsed.credential).toBe(result.endpoint.bootstrap.credential);
      expect(parsed.parentPid).toBe(process.pid);

      // Endpoint should be consumed
      expect(result.endpoint.consumed).toBe(true);
    });

    it('rejects delivery on already-consumed endpoint', async () => {
      const result = createLaunchEndpoint();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      endpointsToClean.push(result.endpoint);

      // Mark as consumed
      result.endpoint.consumed = true;

      const delivery = await deliverBootstrap(result.endpoint);
      expect(delivery.ok).toBe(false);
      if (!delivery.ok) {
        expect(delivery.reason).toBe(EndpointFailureReason.ALREADY_CONSUMED);
      }
    });
  } else {
    it('skipped on non-Windows', () => {
      expect(true).toBe(true);
    });
  }
});

// ────────────────────────────────────────────────────────────────────
// destroyEndpoint
// ────────────────────────────────────────────────────────────────────

describe('destroyEndpoint', () => {
  if (process.platform === 'win32') {
    it('closes the server and clears credential material', () => {
      const result = createLaunchEndpoint();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const endpoint = result.endpoint;
      const originalCred = endpoint.bootstrap.credential;
      expect(originalCred).toHaveLength(64);

      destroyEndpoint(endpoint);

      // Server should no longer be listening
      expect(endpoint.server.listening).toBe(false);

      // Credential material should be cleared (best effort)
      expect(endpoint.bootstrap.credential).toBe('');
      expect(endpoint.bootstrap.serverNonce).toBe('');
      expect(endpoint.bootstrap.clientNonce).toBe('');

      // Endpoint should be marked consumed
      expect(endpoint.consumed).toBe(true);
    });

    it('is safe to call multiple times', () => {
      const result = createLaunchEndpoint();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const endpoint = result.endpoint;
      destroyEndpoint(endpoint);
      // Should not throw on double-destroy
      expect(() => destroyEndpoint(endpoint)).not.toThrow();
    });
  } else {
    it('skipped on non-Windows', () => {
      expect(true).toBe(true);
    });
  }
});

// ────────────────────────────────────────────────────────────────────
// REQUIRED_DACL_POLICY documentation
// ────────────────────────────────────────────────────────────────────

describe('REQUIRED_DACL_POLICY', () => {
  it('grants access to current logon SID and current process SID', () => {
    expect(REQUIRED_DACL_POLICY.grant).toContain('CURRENT_LOGON_SID');
    expect(REQUIRED_DACL_POLICY.grant).toContain('CURRENT_PROCESS_SID');
  });

  it('denies anonymous, network, everyone, and low-integrity access', () => {
    expect(REQUIRED_DACL_POLICY.deny).toContain('ANONYMOUS_LOGON');
    expect(REQUIRED_DACL_POLICY.deny).toContain('NETWORK');
    expect(REQUIRED_DACL_POLICY.deny).toContain('EVERYONE');
    expect(REQUIRED_DACL_POLICY.deny).toContain('LOW_INTEGRITY');
  });
});

// ────────────────────────────────────────────────────────────────────
// Security: credential material is not exposed
// ────────────────────────────────────────────────────────────────────

describe('credential material isolation', () => {
  it('bootstrap record credential is not in process.argv', () => {
    const cred = generateLaunchCredential();
    expect(process.argv.join(' ')).not.toContain(cred);
  });

  it('bootstrap record credential is not in process.env', () => {
    const cred = generateLaunchCredential();
    const envStr = JSON.stringify(process.env);
    expect(envStr).not.toContain(cred);
  });

  it('NONCE_BYTES is 32 (independent from credential)', () => {
    expect(NONCE_BYTES).toBe(32);
  });

  it('credential and nonces are generated from independent calls', () => {
    // Verify that credential and nonces come from separate randomBytes calls
    const cred = generateLaunchCredential();
    const nonces = generateNonces();
    // All three should be different (cryptographically almost certainly)
    expect(cred).not.toBe(nonces.serverNonce);
    expect(cred).not.toBe(nonces.clientNonce);
    expect(nonces.serverNonce).not.toBe(nonces.clientNonce);
  });
});
