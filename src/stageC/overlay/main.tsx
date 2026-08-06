/**
 * Stage C Overlay — Entry Point
 *
 * Bootstrap for the Stage C overlay loaded inside the WebView2 sidecar.
 * This entry point mounts the StageCOverlay component and does NOT import
 * any Electron, service, storage, capture, or provider modules.
 *
 * The overlay consumes state from `window.zuleOverlay` bridge events and
 * emits user actions as intents through the same bridge.
 *
 * Requirements: 7.11–7.15, 8.1–8.7, 9.9, 14.1–14.2
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StageCOverlay } from './StageCOverlay';

// Import base styles (shared with Layer 0 for visual parity)
import '../../index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('[Stage C Overlay] Root element #root not found');
}

createRoot(container).render(
  <StrictMode>
    <StageCOverlay />
  </StrictMode>,
);
