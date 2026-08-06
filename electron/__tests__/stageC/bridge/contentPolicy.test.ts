/**
 * Stage C Bridge — Content Policy Unit Tests
 *
 * Tests navigation restriction, denial of popups/downloads/permissions/
 * external URIs/drag-drop, production dev tools/context menu/accelerator
 * key denial, and diagnostic event emission.
 *
 * Requirements: 7.11–7.15
 */

import { describe, it, expect } from 'vitest';
import {
  WebView2ContentPolicy,
  createContentPolicy,
  getContentPolicyIpcType,
  ContentPolicyEventType,
  PACKAGED_VIRTUAL_ORIGIN,
} from '../../../stageC/bridge/contentPolicy';
import { SidecarToControllerType } from '../../../stageC/protocol/schema';

// ────────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────────

function createProductionPolicy(): WebView2ContentPolicy {
  return createContentPolicy({ isProduction: true });
}

function createDevPolicy(): WebView2ContentPolicy {
  return createContentPolicy({ isProduction: false });
}

// ────────────────────────────────────────────────────────────────────
// Navigation Tests (Req 7.12)
// ────────────────────────────────────────────────────────────────────

describe('WebView2ContentPolicy — Navigation', () => {
  const policy = createProductionPolicy();

  it('allows navigation to packaged virtual origin root', () => {
    const result = policy.evaluateNavigation(PACKAGED_VIRTUAL_ORIGIN + '/');
    expect(result.allowed).toBe(true);
    expect(result.event).toBeUndefined();
  });

  it('allows navigation to packaged virtual origin subpath', () => {
    const result = policy.evaluateNavigation(PACKAGED_VIRTUAL_ORIGIN + '/index.html');
    expect(result.allowed).toBe(true);
  });

  it('allows navigation to packaged virtual origin deep path', () => {
    const result = policy.evaluateNavigation(PACKAGED_VIRTUAL_ORIGIN + '/assets/main.js');
    expect(result.allowed).toBe(true);
  });

  it('denies navigation to external HTTPS site', () => {
    const result = policy.evaluateNavigation('https://evil.com/phish');
    expect(result.allowed).toBe(false);
    expect(result.event).toBeDefined();
    expect(result.event!.event_type).toBe(ContentPolicyEventType.NAVIGATION_DENIED);
  });

  it('denies navigation to HTTP site', () => {
    const result = policy.evaluateNavigation('http://example.com');
    expect(result.allowed).toBe(false);
    expect(result.event!.event_type).toBe(ContentPolicyEventType.NAVIGATION_DENIED);
  });

  it('denies navigation to file:// URI', () => {
    const result = policy.evaluateNavigation('file:///etc/passwd');
    expect(result.allowed).toBe(false);
    expect(result.event!.event_type).toBe(ContentPolicyEventType.NAVIGATION_DENIED);
  });

  it('denies navigation to data: URI', () => {
    const result = policy.evaluateNavigation('data:text/html,<script>alert(1)</script>');
    expect(result.allowed).toBe(false);
  });

  it('denies navigation to javascript: URI', () => {
    const result = policy.evaluateNavigation('javascript:alert(1)');
    expect(result.allowed).toBe(false);
  });

  it('denies navigation to similar-but-different origin', () => {
    const result = policy.evaluateNavigation('https://zule-overlay.localhost.evil.com/');
    expect(result.allowed).toBe(false);
  });

  it('denies navigation to bare origin without trailing slash or path', () => {
    // "https://zule-overlay.localhost" without trailing slash should be allowed
    const result = policy.evaluateNavigation(PACKAGED_VIRTUAL_ORIGIN);
    expect(result.allowed).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// New Window Denial (Req 7.13)
// ────────────────────────────────────────────────────────────────────

describe('WebView2ContentPolicy — New Window', () => {
  const policy = createProductionPolicy();

  it('denies new window requests', () => {
    const result = policy.evaluateNewWindow('https://example.com');
    expect(result.allowed).toBe(false);
    expect(result.event!.event_type).toBe(ContentPolicyEventType.NEW_WINDOW_DENIED);
  });

  it('denies new window even for packaged origin', () => {
    const result = policy.evaluateNewWindow(PACKAGED_VIRTUAL_ORIGIN + '/popup.html');
    expect(result.allowed).toBe(false);
  });

  it('includes safe detail about the target', () => {
    const result = policy.evaluateNewWindow('https://example.com/page');
    expect(result.event!.detail).toContain('New window request denied');
  });
});

// ────────────────────────────────────────────────────────────────────
// Download Denial (Req 7.13)
// ────────────────────────────────────────────────────────────────────

describe('WebView2ContentPolicy — Download', () => {
  const policy = createProductionPolicy();

  it('denies download requests', () => {
    const result = policy.evaluateDownload('https://cdn.example.com/malware.exe');
    expect(result.allowed).toBe(false);
    expect(result.event!.event_type).toBe(ContentPolicyEventType.DOWNLOAD_DENIED);
  });
});

// ────────────────────────────────────────────────────────────────────
// Permission Denial (Req 7.13)
// ────────────────────────────────────────────────────────────────────

describe('WebView2ContentPolicy — Permission', () => {
  const policy = createProductionPolicy();

  it('denies all permission requests', () => {
    const permissions = ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read'];
    for (const perm of permissions) {
      const result = policy.evaluatePermission(perm);
      expect(result.allowed).toBe(false);
      expect(result.event!.event_type).toBe(ContentPolicyEventType.PERMISSION_DENIED);
    }
  });

  it('includes permission name in detail', () => {
    const result = policy.evaluatePermission('camera');
    expect(result.event!.detail).toContain('camera');
  });
});

// ────────────────────────────────────────────────────────────────────
// External URI Denial (Req 7.13)
// ────────────────────────────────────────────────────────────────────

describe('WebView2ContentPolicy — External URI', () => {
  const policy = createProductionPolicy();

  it('denies external URI launch', () => {
    const result = policy.evaluateExternalUri('https://example.com');
    expect(result.allowed).toBe(false);
    expect(result.event!.event_type).toBe(ContentPolicyEventType.EXTERNAL_URI_DENIED);
  });

  it('denies custom protocol URI', () => {
    const result = policy.evaluateExternalUri('myapp://do-something');
    expect(result.allowed).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// Drag/Drop Denial (Req 7.13)
// ────────────────────────────────────────────────────────────────────

describe('WebView2ContentPolicy — Drag/Drop', () => {
  const policy = createProductionPolicy();

  it('denies drag/drop operations', () => {
    const result = policy.evaluateDragDrop();
    expect(result.allowed).toBe(false);
    expect(result.event!.event_type).toBe(ContentPolicyEventType.DRAG_DROP_DENIED);
  });
});

// ────────────────────────────────────────────────────────────────────
// Production Dev Tools / Context Menu / Accelerator Keys (Req 7.14)
// ────────────────────────────────────────────────────────────────────

describe('WebView2ContentPolicy — Production UI Restrictions', () => {
  describe('production mode', () => {
    const policy = createProductionPolicy();

    it('denies developer tools', () => {
      const result = policy.evaluateDevTools();
      expect(result.allowed).toBe(false);
      expect(result.event!.event_type).toBe(ContentPolicyEventType.DEV_TOOLS_DENIED);
    });

    it('denies context menu', () => {
      const result = policy.evaluateContextMenu();
      expect(result.allowed).toBe(false);
      expect(result.event!.event_type).toBe(ContentPolicyEventType.CONTEXT_MENU_DENIED);
    });

    it('denies accelerator keys', () => {
      const result = policy.evaluateAcceleratorKey();
      expect(result.allowed).toBe(false);
      expect(result.event!.event_type).toBe(ContentPolicyEventType.ACCELERATOR_KEY_DENIED);
    });
  });

  describe('development mode', () => {
    const policy = createDevPolicy();

    it('allows developer tools', () => {
      const result = policy.evaluateDevTools();
      expect(result.allowed).toBe(true);
    });

    it('allows context menu', () => {
      const result = policy.evaluateContextMenu();
      expect(result.allowed).toBe(true);
    });

    it('allows accelerator keys', () => {
      const result = policy.evaluateAcceleratorKey();
      expect(result.allowed).toBe(true);
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// Diagnostic Event Emission
// ────────────────────────────────────────────────────────────────────

describe('WebView2ContentPolicy — Diagnostic Events', () => {
  const policy = createProductionPolicy();

  it('emits content policy events on all denials', () => {
    const denials = [
      () => policy.evaluateNavigation('https://evil.com'),
      () => policy.evaluateNewWindow('https://evil.com'),
      () => policy.evaluateDownload('https://evil.com/file'),
      () => policy.evaluatePermission('camera'),
      () => policy.evaluateExternalUri('https://evil.com'),
      () => policy.evaluateDragDrop(),
      () => policy.evaluateDevTools(),
      () => policy.evaluateContextMenu(),
      () => policy.evaluateAcceleratorKey(),
    ];

    for (const denial of denials) {
      const result = denial();
      expect(result.allowed).toBe(false);
      expect(result.event).toBeDefined();
      expect(result.event!.event_type).toBeTruthy();
      expect(result.event!.detail).toBeTruthy();
    }
  });

  it('truncates long detail strings', () => {
    const longUri = 'https://' + 'x'.repeat(500) + '.com/path';
    const result = policy.evaluateNavigation(longUri);
    expect(result.event!.detail.length).toBeLessThanOrEqual(256);
  });
});

// ────────────────────────────────────────────────────────────────────
// Factory and IPC Type
// ────────────────────────────────────────────────────────────────────

describe('createContentPolicy', () => {
  it('creates a policy with default configuration', () => {
    const policy = createContentPolicy();
    // Default is production mode, should deny dev tools
    const result = policy.evaluateDevTools();
    expect(result.allowed).toBe(false);
  });

  it('accepts custom virtual origin', () => {
    const policy = createContentPolicy({
      virtualOrigin: 'https://custom-origin.localhost',
    });
    const result = policy.evaluateNavigation('https://custom-origin.localhost/index.html');
    expect(result.allowed).toBe(true);

    const denied = policy.evaluateNavigation(PACKAGED_VIRTUAL_ORIGIN + '/index.html');
    expect(denied.allowed).toBe(false);
  });
});

describe('getContentPolicyIpcType', () => {
  it('returns diagnostic.contentPolicyEvent', () => {
    expect(getContentPolicyIpcType()).toBe(SidecarToControllerType.DIAGNOSTIC_CONTENT_POLICY_EVENT);
  });
});
