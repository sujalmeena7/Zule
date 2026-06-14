import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { OverlayShell } from './components/OverlayShell'
import { telemetry, buildErrorTelemetryEvent } from './brain/telemetry'

// ---------------------------------------------------------------------------
// Top-level unhandledrejection listener (Requirement 20.5)
// ---------------------------------------------------------------------------
// Routes unhandled promise rejections through the Telemetry_Module as
// content-free error events. This ensures that even rejections outside
// React component trees are captured for diagnostics.
window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  const reason = event.reason;
  const telemetryEvent = buildErrorTelemetryEvent(
    reason,
    ['unhandledrejection'],
  );
  telemetry.emit(telemetryEvent);

  // Log for development visibility
  if (import.meta.env?.DEV) {
    console.error('[Zule] Unhandled rejection:', reason);
  }
});

// ---------------------------------------------------------------------------
// Overlay route detection (Requirements 10.1, 10.2, 11.3, 11.4)
// ---------------------------------------------------------------------------
// The Overlay_Window loads the renderer at #overlay so we can mount
// FloatingCopilot in isolation without any dashboard chrome. The main
// window (or web mode) continues to render the full <App />.
const isOverlayRoute = window.location.hash === '#overlay';

// Persist the overlay flag at the window level BEFORE React mounts.
// ZuleProvider's hash-sync effect would otherwise overwrite #overlay
// with #dashboard (because '#overlay' isn't a routable Page), causing
// FloatingCopilot to render its Mode 1 workspace background (with the
// "Exit Copilot" button) inside the overlay window. The flag is stable
// for the life of the window and is read by FloatingCopilot/ZuleContext
// instead of re-reading window.location.hash.
if (isOverlayRoute) {
  (window as Window & { __zuleIsOverlay?: boolean }).__zuleIsOverlay = true;
}

const root = createRoot(document.getElementById('root')!);

if (isOverlayRoute) {
  // Overlay window: mount FloatingCopilot in isolation via OverlayShell.
  // No StrictMode wrapper to avoid double-mount side effects on the
  // transparent native window (zone detector RAF, IPC listeners).
  root.render(<OverlayShell />);
} else {
  // Main window or web mode: mount full App.
  // App.tsx internally handles not rendering FloatingCopilot in the
  // Main_Window when isElectron() is true (Requirement 11.4).
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
