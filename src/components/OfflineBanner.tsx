// ============================================
// Zule AI — Offline Banner
// ============================================
//
// Non-blocking banner rendered above main content when the browser
// reports `navigator.onLine === false`. Informs the user that Zule
// will use local providers (ollama / simulation) until connectivity
// returns.
//
// Requirements: 20.1, 20.2

import { WifiOff } from 'lucide-react';
import './OfflineBanner.css';

/**
 * A small, non-blocking banner/toast that renders when the application
 * detects an offline state. Placed above the main content area in the
 * App layout.
 *
 * The banner is purely informational — it does not block user interaction.
 * The AI pipeline handles the actual provider switch (preferring `ollama`
 * and `simulation` adapters when offline).
 */
export function OfflineBanner() {
  return (
    <div
      className="offline-banner"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <WifiOff size={16} aria-hidden="true" />
      <span>
        You're offline. Zule will use local providers until connectivity returns.
      </span>
    </div>
  );
}
