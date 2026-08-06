/**
 * Stage C Bridge — WebView2 Content Policy
 *
 * Enforces least-privilege content restrictions:
 * - Navigation restricted to packaged virtual origin only
 * - Deny: new windows, downloads, permissions, external URIs, drag/drop
 * - Deny: developer tools, context menus, browser accelerator keys in production
 * - Emit diagnostic.contentPolicyEvent on denials
 *
 * Requirements: 7.11–7.15
 */

import {
  SidecarToControllerType,
  type DiagnosticContentPolicyEventPayload,
} from '../protocol/schema';

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

/** Default packaged virtual origin for the overlay. */
export const PACKAGED_VIRTUAL_ORIGIN = 'https://zule-overlay.localhost';

/** Maximum detail string length in content policy events. */
const MAX_DETAIL_LENGTH = 256;

// ────────────────────────────────────────────────────────────────────
// Content Policy Event Types
// ────────────────────────────────────────────────────────────────────

export enum ContentPolicyEventType {
  NAVIGATION_DENIED = 'navigation_denied',
  NEW_WINDOW_DENIED = 'new_window_denied',
  DOWNLOAD_DENIED = 'download_denied',
  PERMISSION_DENIED = 'permission_denied',
  EXTERNAL_URI_DENIED = 'external_uri_denied',
  DRAG_DROP_DENIED = 'drag_drop_denied',
  DEV_TOOLS_DENIED = 'dev_tools_denied',
  CONTEXT_MENU_DENIED = 'context_menu_denied',
  ACCELERATOR_KEY_DENIED = 'accelerator_key_denied',
}

// ────────────────────────────────────────────────────────────────────
// Content Policy Decision
// ────────────────────────────────────────────────────────────────────

export interface ContentPolicyDecision {
  allowed: boolean;
  event?: DiagnosticContentPolicyEventPayload;
}

// ────────────────────────────────────────────────────────────────────
// Content Policy Configuration
// ────────────────────────────────────────────────────────────────────

export interface ContentPolicyConfig {
  /** The allowed packaged virtual origin (read-only). */
  virtualOrigin: string;

  /** Whether this is a production build (disables dev tools, etc.). */
  isProduction: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Content Policy Implementation
// ────────────────────────────────────────────────────────────────────

/**
 * WebView2 Content Policy enforcer.
 *
 * Serves only the read-only packaged virtual origin. Denies all operations
 * listed in Requirements 7.13–7.14.
 */
export class WebView2ContentPolicy {
  private readonly config: ContentPolicyConfig;

  constructor(config: ContentPolicyConfig) {
    this.config = config;
  }

  /**
   * Evaluate a navigation request.
   * Only the packaged virtual origin is allowed (Req 7.12).
   */
  evaluateNavigation(targetUri: string): ContentPolicyDecision {
    if (this.isPackagedOrigin(targetUri)) {
      return { allowed: true };
    }

    return this.deny(
      ContentPolicyEventType.NAVIGATION_DENIED,
      `Navigation to non-packaged origin denied: ${this.safeUri(targetUri)}`,
    );
  }

  /**
   * Evaluate a new window request (Req 7.13).
   * Always denied — no popups allowed.
   */
  evaluateNewWindow(targetUri: string): ContentPolicyDecision {
    return this.deny(
      ContentPolicyEventType.NEW_WINDOW_DENIED,
      `New window request denied: ${this.safeUri(targetUri)}`,
    );
  }

  /**
   * Evaluate a download request (Req 7.13).
   * Always denied.
   */
  evaluateDownload(uri: string): ContentPolicyDecision {
    return this.deny(
      ContentPolicyEventType.DOWNLOAD_DENIED,
      `Download denied: ${this.safeUri(uri)}`,
    );
  }

  /**
   * Evaluate a permission request (Req 7.13).
   * Always denied — the overlay page has no granted permissions.
   */
  evaluatePermission(permission: string): ContentPolicyDecision {
    return this.deny(
      ContentPolicyEventType.PERMISSION_DENIED,
      `Permission request denied: ${this.safeString(permission)}`,
    );
  }

  /**
   * Evaluate an external URI launch request (Req 7.13).
   * Always denied.
   */
  evaluateExternalUri(uri: string): ContentPolicyDecision {
    return this.deny(
      ContentPolicyEventType.EXTERNAL_URI_DENIED,
      `External URI launch denied: ${this.safeUri(uri)}`,
    );
  }

  /**
   * Evaluate a drag/drop operation (Req 7.13).
   * Always denied.
   */
  evaluateDragDrop(): ContentPolicyDecision {
    return this.deny(
      ContentPolicyEventType.DRAG_DROP_DENIED,
      'Drag/drop operation denied',
    );
  }

  /**
   * Evaluate developer tools access (Req 7.14).
   * Denied in production builds.
   */
  evaluateDevTools(): ContentPolicyDecision {
    if (!this.config.isProduction) {
      return { allowed: true };
    }

    return this.deny(
      ContentPolicyEventType.DEV_TOOLS_DENIED,
      'Developer tools denied in production',
    );
  }

  /**
   * Evaluate context menu (Req 7.14).
   * Denied in production builds.
   */
  evaluateContextMenu(): ContentPolicyDecision {
    if (!this.config.isProduction) {
      return { allowed: true };
    }

    return this.deny(
      ContentPolicyEventType.CONTEXT_MENU_DENIED,
      'Context menu denied in production',
    );
  }

  /**
   * Evaluate browser accelerator keys (Req 7.14).
   * Denied in production builds.
   */
  evaluateAcceleratorKey(): ContentPolicyDecision {
    if (!this.config.isProduction) {
      return { allowed: true };
    }

    return this.deny(
      ContentPolicyEventType.ACCELERATOR_KEY_DENIED,
      'Browser accelerator key denied in production',
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * Check if a URI belongs to the packaged virtual origin.
   * Only exact origin prefix match is allowed.
   */
  private isPackagedOrigin(uri: string): boolean {
    // Normalize both for comparison
    const normalizedOrigin = this.config.virtualOrigin.replace(/\/$/, '');
    const normalizedUri = uri.replace(/\/$/, '');

    // Must start with the virtual origin exactly (with path separator)
    return (
      normalizedUri === normalizedOrigin ||
      uri.startsWith(normalizedOrigin + '/') ||
      uri.startsWith(this.config.virtualOrigin + '/')
    );
  }

  /**
   * Create a denial decision with a diagnostic content policy event.
   */
  private deny(eventType: ContentPolicyEventType, detail: string): ContentPolicyDecision {
    return {
      allowed: false,
      event: {
        event_type: eventType,
        detail: this.truncateDetail(detail),
      },
    };
  }

  /**
   * Sanitize a URI for safe inclusion in diagnostic detail.
   * Remove potentially sensitive query parameters and limit length.
   */
  private safeUri(uri: string): string {
    try {
      const parsed = new URL(uri);
      // Only include scheme + host + path (no query/fragment)
      const safe = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
      return this.safeString(safe);
    } catch {
      // If not parseable as URL, just truncate
      return this.safeString(uri);
    }
  }

  /**
   * Safely truncate a string for diagnostic output.
   */
  private safeString(value: string): string {
    if (value.length > 128) {
      return value.substring(0, 128) + '...';
    }
    return value;
  }

  /**
   * Truncate detail to maximum allowed length.
   */
  private truncateDetail(detail: string): string {
    if (detail.length > MAX_DETAIL_LENGTH) {
      return detail.substring(0, MAX_DETAIL_LENGTH);
    }
    return detail;
  }
}

// ────────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────────

/**
 * Create a content policy instance with default configuration.
 */
export function createContentPolicy(
  options?: Partial<ContentPolicyConfig>,
): WebView2ContentPolicy {
  const config: ContentPolicyConfig = {
    virtualOrigin: options?.virtualOrigin ?? PACKAGED_VIRTUAL_ORIGIN,
    isProduction: options?.isProduction ?? true,
  };
  return new WebView2ContentPolicy(config);
}

/**
 * Get the IPC message type for content policy events.
 */
export function getContentPolicyIpcType(): SidecarToControllerType {
  return SidecarToControllerType.DIAGNOSTIC_CONTENT_POLICY_EVENT;
}
