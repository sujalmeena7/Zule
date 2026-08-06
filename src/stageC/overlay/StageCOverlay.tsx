/**
 * Stage C Overlay — Main Presentation Component
 *
 * Reuses Layer 0 presentation sub-components (ControlCapsule, SuggestionCard,
 * InputBar, QuickActions) but is wired exclusively through the Stage C bridge
 * adapter. NO Electron IPC, service, storage, capture, or provider modules
 * are imported.
 *
 * State arrives via `window.zuleOverlay.onStateSnapshot` / `onStatePatch`.
 * User actions emit as intents via `window.zuleOverlay.requestOverlayAction`,
 * `requestAI`, `requestAudio`, `requestScreenCapture`.
 *
 * Supports compact/expanded/maximized modes per Req 9.9.
 *
 * Requirements: 7.11–7.15, 8.1–8.7, 9.9, 14.1–14.2
 */

import { useRef, useCallback, useEffect } from 'react';
import { ControlCapsule } from '../../components/copilot/ControlCapsule';
import { SuggestionCard } from '../../components/copilot/SuggestionCard';
import { InputBar } from '../../components/copilot/InputBar';
import { useBridge } from './bridgeAdapter';
import type { RegionRect } from './types';

// Import the shared overlay CSS for Layer 0 presentation parity
import '../../components/FloatingCopilot.css';

/**
 * Stage C floating overlay root component.
 *
 * This component is presentation-only. It renders the same visual semantics
 * as the Layer 0 FloatingCopilot but sources all state from the bridge
 * projection and emits all user actions as intents.
 */
export function StageCOverlay() {
  const { state, actions } = useBridge();
  const { renderState, mode, revision } = state;
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // ── Drag/Interactive Region Reporting ──
  // After each layout change (mode transition), report the drag and interactive
  // regions to the native sidecar so WM_NCHITTEST can route correctly.
  useEffect(() => {
    if (!rootRef.current) return;

    // The capsule is the drag region (matches Layer 0 -webkit-app-region: drag)
    const capsule = rootRef.current.querySelector('.control-capsule');
    if (capsule) {
      const rect = capsule.getBoundingClientRect();
      const dragRegion: RegionRect = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
      actions.reportDragRegions(revision, [dragRegion]);
    }

    // Interactive regions: buttons, inputs, scrollable areas
    const interactiveElements = rootRef.current.querySelectorAll(
      'button, input, [role="button"], .card-suggestion, .card-input-bar',
    );
    const interactiveRegions: RegionRect[] = [];
    interactiveElements.forEach((el) => {
      const rect = el.getBoundingClientRect();
      interactiveRegions.push({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });
    });
    actions.reportInteractiveRegions(revision, interactiveRegions);
  }, [mode, revision, actions]);

  // ── Intent Handlers ──

  const handleToggleMode = useCallback(() => {
    actions.requestOverlayAction({ type: 'toggle-mode' });
  }, [actions]);

  const handleStop = useCallback(() => {
    actions.requestOverlayAction({ type: 'stop-session' });
  }, [actions]);

  const handleToggleStealth = useCallback(
    (enabled: boolean) => {
      actions.requestOverlayAction({ type: 'toggle-stealth', enabled });
    },
    [actions],
  );

  const handleToggleSystemAudio = useCallback(() => {
    actions.requestAudio({ type: 'toggle-system-audio' });
  }, [actions]);

  const handleInputChange = useCallback(
    (text: string) => {
      actions.requestOverlayAction({ type: 'set-input', text });
    },
    [actions],
  );

  const handleSubmit = useCallback(() => {
    actions.requestOverlayAction({ type: 'submit-input', text: renderState.inputText });
  }, [actions, renderState.inputText]);

  const handleTriggerAI = useCallback(
    (query: string) => {
      actions.requestAI({ type: 'follow-up', text: query });
    },
    [actions],
  );

  const handleStopGeneration = useCallback(() => {
    actions.requestAI({ type: 'stop-generation' });
  }, [actions]);

  const handleUseScreen = useCallback(() => {
    actions.requestScreenCapture({ type: 'use-screen' });
  }, [actions]);

  // ── Render ──
  // Mirror Layer 0 class structure for CSS parity

  const isCompact = mode === 'compact';
  const isMaximized = mode === 'maximized';

  return (
    <div
      ref={rootRef}
      className={`floating-copilot stage-c-overlay native-overlay-mode mode-${mode}`}
      data-stage="c"
      data-mode={mode}
    >
      {/* Control Capsule — always visible, provides drag handle */}
      <ControlCapsule
        isHidden={isCompact}
        onToggleHidden={handleToggleMode}
        onStop={handleStop}
        handleRef={() => {}}
        overlayMode={mode}
        onToggleMode={handleToggleMode}
        isStealth={renderState.captureProtection}
        onToggleStealth={handleToggleStealth}
        isSystemAudioActive={renderState.isSystemAudioActive}
        onToggleSystemAudio={handleToggleSystemAudio}
      />

      {/* Expanded/Maximized content */}
      {!isCompact && (
        <div className="suggestion-card">
          {/* AI Response Area — visible in maximized mode */}
          {isMaximized && (
            <SuggestionCard
              isLoading={renderState.isLoading}
              isStreaming={renderState.isStreaming}
              streamingText={renderState.streamingText}
              aiResponse={renderState.aiResponse}
              onTriggerAI={handleTriggerAI}
            />
          )}

          {/* Input Bar — visible in expanded and maximized */}
          <InputBar
            inputText={renderState.inputText}
            onInputChange={handleInputChange}
            onSubmit={handleSubmit}
            isLoading={renderState.isLoading}
            inputRef={inputRef}
            onUseScreen={handleUseScreen}
            isScreenActive={false}
            isGenerating={renderState.isLoading || renderState.isStreaming}
            onStopGeneration={handleStopGeneration}
          />
        </div>
      )}
    </div>
  );
}
