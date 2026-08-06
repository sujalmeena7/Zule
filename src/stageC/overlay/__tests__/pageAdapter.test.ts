/**
 * Stage C Overlay — Page Adapter Unit Tests
 *
 * Verifies:
 * 1. The adapter is frozen (cannot be modified)
 * 2. Only the 6 methods and 3 events exist (no extras)
 * 3. Messages exceeding 65,536 bytes are rejected
 * 4. Invalid schemas are rejected
 * 5. No native authority is exposed
 *
 * Requirements: 7.1–7.10
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createPageAdapter,
  createPageAdapterWithDispatch,
  installPageAdapter,
  _testing,
  type NativeBridgePort,
  type BridgeValidationError,
} from '../pageAdapter';

// ────────────────────────────────────────────────────────────────────
// Test Helpers
// ────────────────────────────────────────────────────────────────────

function createMockPort(): NativeBridgePort & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    messages,
    postMessage(msg: unknown) {
      messages.push(msg);
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('Stage C Page Adapter — Frozen Adapter (Req 7.1)', () => {
  it('should be frozen and not allow property addition', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    expect(Object.isFrozen(adapter)).toBe(true);

    // Attempting to add a property should fail silently or throw in strict mode
    expect(() => {
      (adapter as any).newProp = 'test';
    }).toThrow();
  });

  it('should not allow property modification', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    expect(() => {
      (adapter as any).requestAI = () => {};
    }).toThrow();
  });

  it('should not allow property deletion', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    expect(() => {
      delete (adapter as any).requestAI;
    }).toThrow();
  });

  it('should not allow property reconfiguration', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    expect(() => {
      Object.defineProperty(adapter, 'requestAI', { value: () => {} });
    }).toThrow();
  });
});

describe('Stage C Page Adapter — Exact Surface (Req 7.2, 7.3)', () => {
  const EXPECTED_METHODS = [
    'requestOverlayAction',
    'requestAI',
    'requestAudio',
    'requestScreenCapture',
    'reportDragRegions',
    'reportInteractiveRegions',
  ] as const;

  const EXPECTED_EVENTS = [
    'onStateSnapshot',
    'onStatePatch',
    'onOperationResult',
  ] as const;

  it('should expose exactly 6 methods and 3 events', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);
    const keys = Object.keys(adapter).sort();
    const expected = [...EXPECTED_METHODS, ...EXPECTED_EVENTS].sort();

    expect(keys).toEqual(expected);
    expect(keys.length).toBe(9);
  });

  it('should have all 6 methods as functions', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    for (const method of EXPECTED_METHODS) {
      expect(typeof adapter[method]).toBe('function');
    }
  });

  it('should have all 3 event subscriptions as functions', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    for (const event of EXPECTED_EVENTS) {
      expect(typeof adapter[event]).toBe('function');
    }
  });

  it('should not expose any other properties via prototype chain', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    // Object.keys only shows own enumerable — check that getOwnPropertyNames
    // also gives us the same set (no hidden non-enumerable properties added)
    const ownProps = Object.getOwnPropertyNames(adapter).sort();
    const expected = [...EXPECTED_METHODS, ...EXPECTED_EVENTS].sort();
    expect(ownProps).toEqual(expected);
  });
});

describe('Stage C Page Adapter — Size Limit Enforcement (Req 7.6)', () => {
  it('should reject messages exceeding 65,536 bytes', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    // Create a payload that will exceed 65,536 bytes when serialized
    const largeText = 'x'.repeat(70_000);

    expect(() => {
      adapter.requestOverlayAction({ type: 'set-input', text: largeText });
    }).toThrow();

    try {
      adapter.requestOverlayAction({ type: 'set-input', text: largeText });
    } catch (err) {
      const error = err as BridgeValidationError;
      expect(error.code).toBe('SIZE_EXCEEDED');
    }

    // No message should have been posted
    expect(port.messages.length).toBe(0);
  });

  it('should allow messages within the 65,536 byte limit', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    // A small message within limits
    adapter.requestOverlayAction({ type: 'toggle-mode' });
    expect(port.messages.length).toBe(1);
  });

  it('should measure size limit in UTF-8 bytes, not characters', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    // Each '🎉' is 4 UTF-8 bytes. We need total serialized envelope to exceed 65,536.
    // Envelope overhead: {"method":"requestOverlayAction","args":{"type":"set-input","text":"..."}}
    // That's ~70 bytes of overhead. So we need text bytes > 65,536 - 70 ≈ 65,466.
    // 65,466 / 4 ≈ 16,367 emojis to push over the limit.
    const emojiText = '🎉'.repeat(16_400);

    expect(() => {
      adapter.requestOverlayAction({ type: 'set-input', text: emojiText });
    }).toThrow();
  });
});

describe('Stage C Page Adapter — Schema Validation (Req 7.7)', () => {
  let port: ReturnType<typeof createMockPort>;
  let adapter: ReturnType<typeof createPageAdapter>;

  beforeEach(() => {
    port = createMockPort();
    adapter = createPageAdapter(port);
  });

  describe('requestOverlayAction', () => {
    it('should accept valid toggle-mode action', () => {
      adapter.requestOverlayAction({ type: 'toggle-mode' });
      expect(port.messages.length).toBe(1);
    });

    it('should accept valid set-mode action', () => {
      adapter.requestOverlayAction({ type: 'set-mode', mode: 'expanded' });
      expect(port.messages.length).toBe(1);
    });

    it('should accept valid toggle-stealth action', () => {
      adapter.requestOverlayAction({ type: 'toggle-stealth', enabled: true });
      expect(port.messages.length).toBe(1);
    });

    it('should accept valid set-input action', () => {
      adapter.requestOverlayAction({ type: 'set-input', text: 'hello' });
      expect(port.messages.length).toBe(1);
    });

    it('should reject unknown action type', () => {
      expect(() => {
        adapter.requestOverlayAction({ type: 'unknown-action' } as any);
      }).toThrow();
      expect(port.messages.length).toBe(0);
    });

    it('should reject action with extra fields', () => {
      expect(() => {
        adapter.requestOverlayAction({ type: 'toggle-mode', extra: 'bad' } as any);
      }).toThrow();
      expect(port.messages.length).toBe(0);
    });

    it('should reject set-mode with invalid mode', () => {
      expect(() => {
        adapter.requestOverlayAction({ type: 'set-mode', mode: 'invalid' } as any);
      }).toThrow();
      expect(port.messages.length).toBe(0);
    });

    it('should reject toggle-stealth with non-boolean enabled', () => {
      expect(() => {
        adapter.requestOverlayAction({ type: 'toggle-stealth', enabled: 'yes' } as any);
      }).toThrow();
      expect(port.messages.length).toBe(0);
    });

    it('should reject non-object actions', () => {
      expect(() => {
        adapter.requestOverlayAction(null as any);
      }).toThrow();
      expect(() => {
        adapter.requestOverlayAction('toggle-mode' as any);
      }).toThrow();
      expect(port.messages.length).toBe(0);
    });
  });

  describe('requestAI', () => {
    it('should accept valid trigger action', () => {
      adapter.requestAI({ type: 'trigger' });
      expect(port.messages.length).toBe(1);
    });

    it('should accept trigger with optional query', () => {
      adapter.requestAI({ type: 'trigger', query: 'hello' });
      expect(port.messages.length).toBe(1);
    });

    it('should accept valid follow-up action', () => {
      adapter.requestAI({ type: 'follow-up', text: 'more info' });
      expect(port.messages.length).toBe(1);
    });

    it('should reject unknown AI action type', () => {
      expect(() => {
        adapter.requestAI({ type: 'invalid' } as any);
      }).toThrow();
    });

    it('should reject trigger with extra fields', () => {
      expect(() => {
        adapter.requestAI({ type: 'trigger', query: 'ok', extra: true } as any);
      }).toThrow();
    });

    it('should reject follow-up with non-string text', () => {
      expect(() => {
        adapter.requestAI({ type: 'follow-up', text: 123 } as any);
      }).toThrow();
    });
  });

  describe('requestAudio', () => {
    it('should accept valid toggle-system-audio action', () => {
      adapter.requestAudio({ type: 'toggle-system-audio' });
      expect(port.messages.length).toBe(1);
    });

    it('should reject unknown audio action type', () => {
      expect(() => {
        adapter.requestAudio({ type: 'start-recording' } as any);
      }).toThrow();
    });

    it('should reject action with extra fields', () => {
      expect(() => {
        adapter.requestAudio({ type: 'toggle-system-audio', volume: 50 } as any);
      }).toThrow();
    });
  });

  describe('requestScreenCapture', () => {
    it('should accept valid use-screen action', () => {
      adapter.requestScreenCapture({ type: 'use-screen' });
      expect(port.messages.length).toBe(1);
    });

    it('should reject unknown screen capture action type', () => {
      expect(() => {
        adapter.requestScreenCapture({ type: 'capture-window' } as any);
      }).toThrow();
    });
  });

  describe('reportDragRegions', () => {
    it('should accept valid drag regions', () => {
      adapter.reportDragRegions(1, [{ left: 0, top: 0, width: 100, height: 30 }]);
      expect(port.messages.length).toBe(1);
    });

    it('should accept empty regions array', () => {
      adapter.reportDragRegions(0, []);
      expect(port.messages.length).toBe(1);
    });

    it('should reject negative revision', () => {
      expect(() => {
        adapter.reportDragRegions(-1, []);
      }).toThrow();
    });

    it('should reject non-integer revision', () => {
      expect(() => {
        adapter.reportDragRegions(1.5, []);
      }).toThrow();
    });

    it('should reject region with missing fields', () => {
      expect(() => {
        adapter.reportDragRegions(1, [{ left: 0, top: 0 } as any]);
      }).toThrow();
    });

    it('should reject region with extra fields', () => {
      expect(() => {
        adapter.reportDragRegions(1, [{ left: 0, top: 0, width: 10, height: 10, extra: 1 } as any]);
      }).toThrow();
    });

    it('should reject region with non-finite number', () => {
      expect(() => {
        adapter.reportDragRegions(1, [{ left: Infinity, top: 0, width: 10, height: 10 }]);
      }).toThrow();
    });

    it('should reject region with NaN', () => {
      expect(() => {
        adapter.reportDragRegions(1, [{ left: NaN, top: 0, width: 10, height: 10 }]);
      }).toThrow();
    });
  });

  describe('reportInteractiveRegions', () => {
    it('should accept valid interactive regions', () => {
      adapter.reportInteractiveRegions(2, [{ left: 10, top: 20, width: 200, height: 50 }]);
      expect(port.messages.length).toBe(1);
    });

    it('should reject non-array regions', () => {
      expect(() => {
        adapter.reportInteractiveRegions(1, 'not-an-array' as any);
      }).toThrow();
    });
  });
});

describe('Stage C Page Adapter — Event Subscriptions (Req 7.3)', () => {
  it('should accept function callbacks for onStateSnapshot', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    expect(() => {
      adapter.onStateSnapshot(() => {});
    }).not.toThrow();
  });

  it('should reject non-function callback for onStateSnapshot', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    expect(() => {
      adapter.onStateSnapshot('not a function' as any);
    }).toThrow();
  });

  it('should reject non-function callback for onStatePatch', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    expect(() => {
      adapter.onStatePatch(null as any);
    }).toThrow();
  });

  it('should reject non-function callback for onOperationResult', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    expect(() => {
      adapter.onOperationResult(123 as any);
    }).toThrow();
  });
});

describe('Stage C Page Adapter — Event Dispatch', () => {
  it('should dispatch state snapshots to registered callback', () => {
    const port = createMockPort();
    const { adapter, dispatch } = createPageAdapterWithDispatch(port);

    const received: any[] = [];
    adapter.onStateSnapshot((snapshot) => received.push(snapshot));

    const snapshot = {
      revision: 1,
      bounds_dip: { left: 0, top: 0, width: 400, height: 300 },
      render_state: {
        visible: true,
        mode: 'compact' as const,
        captureProtection: true,
        isSystemAudioActive: false,
        isLoading: false,
        isStreaming: false,
        streamingText: '',
        aiResponse: null,
        inputText: '',
        elapsedTime: 0,
      },
    };

    dispatch.dispatchStateSnapshot(snapshot);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(snapshot);
  });

  it('should dispatch state patches to registered callback', () => {
    const port = createMockPort();
    const { adapter, dispatch } = createPageAdapterWithDispatch(port);

    const received: any[] = [];
    adapter.onStatePatch((patch) => received.push(patch));

    const patch = { base_revision: 1, next_revision: 2, mode: 'expanded' as const };
    dispatch.dispatchStatePatch(patch);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(patch);
  });

  it('should dispatch operation results to registered callback', () => {
    const port = createMockPort();
    const { adapter, dispatch } = createPageAdapterWithDispatch(port);

    const received: any[] = [];
    adapter.onOperationResult((result) => received.push(result));

    const result = { operation_id: 'op-1', success: true };
    dispatch.dispatchOperationResult(result);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(result);
  });

  it('should not throw when dispatching without a registered callback', () => {
    const port = createMockPort();
    const { dispatch } = createPageAdapterWithDispatch(port);

    // No callbacks registered — should be a no-op
    expect(() => {
      dispatch.dispatchStateSnapshot({ revision: 1, bounds_dip: { left: 0, top: 0, width: 100, height: 100 }, render_state: {} as any });
    }).not.toThrow();
  });
});

describe('Stage C Page Adapter — No Native Authority (Req 7.10)', () => {
  it('should not expose any native pipe, credential, or environment access', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    // The adapter should have no properties related to native authority
    const dangerousKeys = [
      'pipe', 'credential', 'env', 'process', 'fs', 'filesystem',
      'registry', 'shell', 'exec', 'spawn', 'network', 'socket',
      'handle', 'pointer', 'ipc', 'com', 'native',
    ];

    const adapterKeys = Object.keys(adapter).map((k) => k.toLowerCase());
    for (const dangerous of dangerousKeys) {
      expect(adapterKeys.some((k) => k.includes(dangerous))).toBe(false);
    }
  });

  it('should only post structured messages through the provided port', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    adapter.requestOverlayAction({ type: 'toggle-mode' });

    // The posted message should be a structured envelope, not raw data
    expect(port.messages.length).toBe(1);
    const msg = port.messages[0] as any;
    expect(msg).toHaveProperty('method', 'requestOverlayAction');
    expect(msg).toHaveProperty('args');
    expect(msg.args).toEqual({ type: 'toggle-mode' });
  });

  it('should not have access to globalThis properties beyond the bridge', () => {
    const port = createMockPort();
    const adapter = createPageAdapter(port);

    // Verify adapter doesn't reference window, process, require, etc.
    const adapterStr = JSON.stringify(Object.keys(adapter));
    expect(adapterStr).not.toContain('require');
    expect(adapterStr).not.toContain('process');
    expect(adapterStr).not.toContain('__dirname');
  });
});

describe('Stage C Page Adapter — installPageAdapter', () => {
  it('should install window.zuleOverlay as non-writable', () => {
    const port = createMockPort();

    // Clean up any existing definition (if configurable from a previous run)
    const existing = Object.getOwnPropertyDescriptor(window, 'zuleOverlay');
    if (existing && existing.configurable) {
      delete (window as any).zuleOverlay;
    } else if (existing) {
      // Already installed as non-configurable from a prior test — verify it's frozen
      expect(Object.isFrozen(window.zuleOverlay)).toBe(true);
      const descriptor = Object.getOwnPropertyDescriptor(window, 'zuleOverlay');
      expect(descriptor?.writable).toBe(false);
      expect(descriptor?.configurable).toBe(false);
      return;
    }

    installPageAdapter(port);

    expect(window.zuleOverlay).toBeDefined();
    expect(Object.isFrozen(window.zuleOverlay)).toBe(true);

    // Should not be writable
    const descriptor = Object.getOwnPropertyDescriptor(window, 'zuleOverlay');
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
  });
});
