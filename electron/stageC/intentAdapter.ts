/**
 * Stage C — Intent Adapter (App Core)
 *
 * Routes allowlisted overlay/AI/audio/screen-capture intents from the
 * Stage C sidecar to existing Electron-owned services. Updates canonical
 * overlay state ONLY after validation and successful execution. Projects
 * snapshots, patches, streams, and operation results back to the sidecar
 * WITHOUT credentials, raw media, screenshot bytes, unrestricted paths,
 * service handles, or database values.
 *
 * Creates ZERO duplicate service pipelines — all operations delegate to
 * existing Electron IPC handlers or service modules.
 *
 * Requirements: 8.1–8.10
 */

import type { OverlayMode } from './protocol/schema';
import type { OverlayProjection, OverlayPatch } from './protocol/projection';
import type { CanonicalOverlayState } from './projectionBuilder';
import { ProjectionBuilder, isRenderStateSafe } from './projectionBuilder';

// ────────────────────────────────────────────────────────────────────
// Intent Action Types (allowlisted from sidecar)
// ────────────────────────────────────────────────────────────────────

/** Overlay intent actions that are allowlisted for routing. */
export type OverlayIntentAction =
  | 'toggle-mode'
  | 'toggle-maximize'
  | 'set-mode'
  | 'toggle-visibility'
  | 'stop-session'
  | 'toggle-stealth'
  | 'set-input'
  | 'submit-input';

/** AI intent actions that are allowlisted for routing. */
export type AIIntentAction =
  | 'trigger'
  | 'stop-generation'
  | 'follow-up';

/** Audio intent actions that are allowlisted for routing. */
export type AudioIntentAction =
  | 'toggle-system-audio';

/** Screen-capture intent actions that are allowlisted for routing. */
export type ScreenCaptureIntentAction =
  | 'use-screen';

// ────────────────────────────────────────────────────────────────────
// Intent Payloads
// ────────────────────────────────────────────────────────────────────

export interface OverlayIntent {
  action: OverlayIntentAction;
  parameters?: Record<string, unknown>;
}

export interface AIIntent {
  action: AIIntentAction;
  parameters?: Record<string, unknown>;
}

export interface AudioIntent {
  action: AudioIntentAction;
  parameters?: Record<string, unknown>;
}

export interface ScreenCaptureIntent {
  action: ScreenCaptureIntentAction;
  parameters?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────────
// Operation Result
// ────────────────────────────────────────────────────────────────────

export interface OperationResult {
  operation_id: string;
  success: boolean;
  error_code?: string;
  data?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────────
// Service Dependencies (injected — no duplicate pipelines)
// ────────────────────────────────────────────────────────────────────

/**
 * Delegate interface for Electron-owned overlay operations.
 * These map to EXISTING Electron main-process services;
 * the intent adapter does NOT create new service pipelines.
 */
export interface OverlayServiceDelegate {
  toggleMode(): Promise<void>;
  toggleMaximize(): Promise<void>;
  setMode(mode: OverlayMode): Promise<void>;
  toggleVisibility(): Promise<void>;
  stopSession(): Promise<void>;
  toggleStealth(enabled: boolean): Promise<void>;
  setInput(text: string): Promise<void>;
  submitInput(text: string): Promise<void>;
}

/**
 * Delegate interface for Electron-owned AI operations.
 * Routes to existing AI pipeline without creating duplicates.
 */
export interface AIServiceDelegate {
  trigger(query?: string): Promise<void>;
  stopGeneration(): Promise<void>;
  followUp(text: string): Promise<void>;
}

/**
 * Delegate interface for Electron-owned audio operations.
 * Routes to existing audio capture pipeline.
 */
export interface AudioServiceDelegate {
  toggleSystemAudio(): Promise<void>;
}

/**
 * Delegate interface for Electron-owned screen-capture operations.
 * Routes to existing capture pipeline.
 */
export interface ScreenCaptureServiceDelegate {
  useScreen(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────
// Sidecar Sender (outbound messages to sidecar)
// ────────────────────────────────────────────────────────────────────

/**
 * Sends protocol messages to the connected sidecar.
 * Used by the intent adapter to project state and operation results.
 */
export interface SidecarSender {
  sendSnapshot(projection: OverlayProjection): void;
  sendPatch(patch: OverlayPatch): void;
  sendAiStreamDelta(streamId: string, delta: string, sequence: number): void;
  sendAiStreamCompleted(streamId: string, finalSequence: number): void;
  sendAiStreamFailed(streamId: string, errorCode: string): void;
  sendOperationResult(result: OperationResult): void;
}

// ────────────────────────────────────────────────────────────────────
// Allowlists — These define the exact set of accepted intent actions.
// Any action not in these sets is rejected before service invocation.
// ────────────────────────────────────────────────────────────────────

const ALLOWED_OVERLAY_ACTIONS: ReadonlySet<string> = new Set<OverlayIntentAction>([
  'toggle-mode',
  'toggle-maximize',
  'set-mode',
  'toggle-visibility',
  'stop-session',
  'toggle-stealth',
  'set-input',
  'submit-input',
]);

const ALLOWED_AI_ACTIONS: ReadonlySet<string> = new Set<AIIntentAction>([
  'trigger',
  'stop-generation',
  'follow-up',
]);

const ALLOWED_AUDIO_ACTIONS: ReadonlySet<string> = new Set<AudioIntentAction>([
  'toggle-system-audio',
]);

const ALLOWED_SCREEN_CAPTURE_ACTIONS: ReadonlySet<string> = new Set<ScreenCaptureIntentAction>([
  'use-screen',
]);

/** Valid overlay mode values for parameter validation. */
const VALID_MODES: ReadonlySet<string> = new Set(['compact', 'expanded', 'maximized']);

// ────────────────────────────────────────────────────────────────────
// Validation Helpers
// ────────────────────────────────────────────────────────────────────

export interface IntentValidationError {
  code: 'UNKNOWN_ACTION' | 'INVALID_PARAMETERS' | 'EXECUTION_FAILED';
  message: string;
}

function validateOverlayParameters(
  action: OverlayIntentAction,
  parameters?: Record<string, unknown>,
): IntentValidationError | null {
  switch (action) {
    case 'set-mode': {
      if (!parameters || typeof parameters.mode !== 'string' || !VALID_MODES.has(parameters.mode)) {
        return {
          code: 'INVALID_PARAMETERS',
          message: `set-mode requires a 'mode' parameter of 'compact', 'expanded', or 'maximized'`,
        };
      }
      return null;
    }
    case 'toggle-stealth': {
      if (!parameters || typeof parameters.enabled !== 'boolean') {
        return {
          code: 'INVALID_PARAMETERS',
          message: `toggle-stealth requires an 'enabled' boolean parameter`,
        };
      }
      return null;
    }
    case 'set-input':
    case 'submit-input': {
      if (!parameters || typeof parameters.text !== 'string') {
        return {
          code: 'INVALID_PARAMETERS',
          message: `${action} requires a 'text' string parameter`,
        };
      }
      return null;
    }
    case 'toggle-mode':
    case 'toggle-maximize':
    case 'toggle-visibility':
    case 'stop-session':
      // These take no parameters
      return null;
    default:
      return { code: 'UNKNOWN_ACTION', message: `Unknown overlay action: ${action}` };
  }
}

function validateAIParameters(
  action: AIIntentAction,
  parameters?: Record<string, unknown>,
): IntentValidationError | null {
  switch (action) {
    case 'trigger':
      // Optional 'query' parameter
      if (parameters && 'query' in parameters && typeof parameters.query !== 'string') {
        return { code: 'INVALID_PARAMETERS', message: `trigger 'query' must be a string` };
      }
      return null;
    case 'follow-up': {
      if (!parameters || typeof parameters.text !== 'string') {
        return { code: 'INVALID_PARAMETERS', message: `follow-up requires a 'text' string parameter` };
      }
      return null;
    }
    case 'stop-generation':
      return null;
    default:
      return { code: 'UNKNOWN_ACTION', message: `Unknown AI action: ${action}` };
  }
}

// ────────────────────────────────────────────────────────────────────
// Intent Adapter
// ────────────────────────────────────────────────────────────────────

let operationCounter = 0;

function nextOperationId(): string {
  operationCounter++;
  return `op-${Date.now()}-${operationCounter}`;
}

export interface IntentAdapterDeps {
  overlay: OverlayServiceDelegate;
  ai: AIServiceDelegate;
  audio: AudioServiceDelegate;
  screenCapture: ScreenCaptureServiceDelegate;
  sender: SidecarSender;
  getCanonicalState: () => CanonicalOverlayState;
  projectionBuilder: ProjectionBuilder;
}

/**
 * The App Core Intent Adapter.
 *
 * - Routes allowlisted intents to EXISTING Electron-owned services
 * - Validates intent action type and parameters BEFORE invoking any service
 * - Updates canonical overlay state ONLY after validated execution
 * - Projects state as snapshots/patches WITHOUT sensitive data
 * - Routes AI stream events to sidecar
 * - Sends operation results after each intent
 * - Creates ZERO duplicate service pipelines
 */
export class IntentAdapter {
  private deps: IntentAdapterDeps;

  constructor(deps: IntentAdapterDeps) {
    this.deps = deps;
  }

  // ── Overlay Intent Routing ────────────────────────────────────────

  /**
   * Route an overlay intent from the sidecar to existing Electron services.
   * Validates action and parameters before any service call.
   * Updates canonical state and projects result only after successful execution.
   */
  async handleOverlayIntent(intent: OverlayIntent): Promise<OperationResult> {
    const operationId = nextOperationId();

    // 1. Validate action is in the allowlist
    if (!ALLOWED_OVERLAY_ACTIONS.has(intent.action)) {
      const result: OperationResult = {
        operation_id: operationId,
        success: false,
        error_code: 'UNKNOWN_ACTION',
      };
      this.deps.sender.sendOperationResult(result);
      return result;
    }

    // 2. Validate parameters
    const validationError = validateOverlayParameters(
      intent.action as OverlayIntentAction,
      intent.parameters,
    );
    if (validationError) {
      const result: OperationResult = {
        operation_id: operationId,
        success: false,
        error_code: validationError.code,
      };
      this.deps.sender.sendOperationResult(result);
      return result;
    }

    // 3. Execute via existing Electron service
    try {
      await this.executeOverlayAction(intent.action as OverlayIntentAction, intent.parameters);
    } catch (err) {
      const result: OperationResult = {
        operation_id: operationId,
        success: false,
        error_code: 'EXECUTION_FAILED',
      };
      this.deps.sender.sendOperationResult(result);
      return result;
    }

    // 4. Project updated canonical state (only after successful execution)
    this.projectCurrentState();

    // 5. Send operation result
    const result: OperationResult = {
      operation_id: operationId,
      success: true,
    };
    this.deps.sender.sendOperationResult(result);
    return result;
  }

  // ── AI Intent Routing ─────────────────────────────────────────────

  /**
   * Route an AI intent from the sidecar to existing Electron AI services.
   * No new AI pipeline is created — all operations delegate to the existing one.
   */
  async handleAIIntent(intent: AIIntent): Promise<OperationResult> {
    const operationId = nextOperationId();

    // 1. Validate action is in the allowlist
    if (!ALLOWED_AI_ACTIONS.has(intent.action)) {
      const result: OperationResult = {
        operation_id: operationId,
        success: false,
        error_code: 'UNKNOWN_ACTION',
      };
      this.deps.sender.sendOperationResult(result);
      return result;
    }

    // 2. Validate parameters
    const validationError = validateAIParameters(
      intent.action as AIIntentAction,
      intent.parameters,
    );
    if (validationError) {
      const result: OperationResult = {
        operation_id: operationId,
        success: false,
        error_code: validationError.code,
      };
      this.deps.sender.sendOperationResult(result);
      return result;
    }

    // 3. Execute via existing Electron AI service
    try {
      await this.executeAIAction(intent.action as AIIntentAction, intent.parameters);
    } catch (err) {
      const result: OperationResult = {
        operation_id: operationId,
        success: false,
        error_code: 'EXECUTION_FAILED',
      };
      this.deps.sender.sendOperationResult(result);
      return result;
    }

    // 4. Project updated canonical state
    this.projectCurrentState();

    // 5. Send operation result
    const result: OperationResult = {
      operation_id: operationId,
      success: true,
    };
    this.deps.sender.sendOperationResult(result);
    return result;
  }

  // ── Audio Intent Routing ──────────────────────────────────────────

  /**
   * Route an audio intent to existing Electron audio services.
   * No duplicate audio pipeline is created.
   */
  async handleAudioIntent(intent: AudioIntent): Promise<OperationResult> {
    const operationId = nextOperationId();

    // 1. Validate action
    if (!ALLOWED_AUDIO_ACTIONS.has(intent.action)) {
      const result: OperationResult = {
        operation_id: operationId,
        success: false,
        error_code: 'UNKNOWN_ACTION',
      };
      this.deps.sender.sendOperationResult(result);
      return result;
    }

    // 2. Execute
    try {
      await this.deps.audio.toggleSystemAudio();
    } catch (err) {
      const result: OperationResult = {
        operation_id: operationId,
        success: false,
        error_code: 'EXECUTION_FAILED',
      };
      this.deps.sender.sendOperationResult(result);
      return result;
    }

    // 3. Project updated canonical state
    this.projectCurrentState();

    // 4. Send result
    const result: OperationResult = {
      operation_id: operationId,
      success: true,
    };
    this.deps.sender.sendOperationResult(result);
    return result;
  }

  // ── Screen-Capture Intent Routing ─────────────────────────────────

  /**
   * Route a screen-capture intent to existing Electron capture services.
   * No duplicate capture pipeline is created.
   */
  async handleScreenCaptureIntent(intent: ScreenCaptureIntent): Promise<OperationResult> {
    const operationId = nextOperationId();

    // 1. Validate action
    if (!ALLOWED_SCREEN_CAPTURE_ACTIONS.has(intent.action)) {
      const result: OperationResult = {
        operation_id: operationId,
        success: false,
        error_code: 'UNKNOWN_ACTION',
      };
      this.deps.sender.sendOperationResult(result);
      return result;
    }

    // 2. Execute
    try {
      await this.deps.screenCapture.useScreen();
    } catch (err) {
      const result: OperationResult = {
        operation_id: operationId,
        success: false,
        error_code: 'EXECUTION_FAILED',
      };
      this.deps.sender.sendOperationResult(result);
      return result;
    }

    // 3. Project updated canonical state
    this.projectCurrentState();

    // 4. Send result
    const result: OperationResult = {
      operation_id: operationId,
      success: true,
    };
    this.deps.sender.sendOperationResult(result);
    return result;
  }

  // ── AI Stream Routing ─────────────────────────────────────────────

  /**
   * Forward an AI stream delta to the sidecar.
   * Called by the existing Electron AI pipeline during streaming.
   * No state mutation — streams are pass-through projections.
   */
  routeAiStreamDelta(streamId: string, delta: string, sequence: number): void {
    this.deps.sender.sendAiStreamDelta(streamId, delta, sequence);
  }

  /**
   * Forward AI stream completion to the sidecar.
   */
  routeAiStreamCompleted(streamId: string, finalSequence: number): void {
    this.deps.sender.sendAiStreamCompleted(streamId, finalSequence);
  }

  /**
   * Forward AI stream failure to the sidecar.
   */
  routeAiStreamFailed(streamId: string, errorCode: string): void {
    this.deps.sender.sendAiStreamFailed(streamId, errorCode);
  }

  // ── State Projection ──────────────────────────────────────────────

  /**
   * Project the current canonical state to the sidecar as a full snapshot.
   * Used on initial connection and after reconnect.
   */
  sendFullSnapshot(): void {
    const state = this.deps.getCanonicalState();
    const projection = this.deps.projectionBuilder.buildSnapshot(state);

    // Safety check: ensure no sensitive data leaks
    if (!isRenderStateSafe(projection.render_state)) {
      // This should never happen if buildSafeRenderState is correct,
      // but defense-in-depth prevents projection of sensitive data.
      console.error('[IntentAdapter] CRITICAL: render_state contains redacted keys — blocking projection');
      return;
    }

    this.deps.sender.sendSnapshot(projection);
  }

  /**
   * Project the current canonical state as an incremental patch.
   * Used after each accepted intent updates canonical state.
   * Returns false if no changes detected (no patch sent).
   */
  sendPatch(): boolean {
    const state = this.deps.getCanonicalState();
    const patch = this.deps.projectionBuilder.buildPatch(state);

    if (patch === null) {
      return false;
    }

    // Safety check: ensure no sensitive data in patch render_state
    if (patch.render_state_patch && !isRenderStateSafe(patch.render_state_patch)) {
      console.error('[IntentAdapter] CRITICAL: render_state_patch contains redacted keys — blocking patch');
      return false;
    }

    this.deps.sender.sendPatch(patch);
    return true;
  }

  /**
   * Reset projection state (on reconnect). Next projection must be a full snapshot.
   */
  resetProjection(): void {
    this.deps.projectionBuilder.reset();
  }

  // ── Private Execution Helpers ─────────────────────────────────────

  private async executeOverlayAction(
    action: OverlayIntentAction,
    parameters?: Record<string, unknown>,
  ): Promise<void> {
    switch (action) {
      case 'toggle-mode':
        await this.deps.overlay.toggleMode();
        break;
      case 'toggle-maximize':
        await this.deps.overlay.toggleMaximize();
        break;
      case 'set-mode':
        await this.deps.overlay.setMode(parameters!.mode as OverlayMode);
        break;
      case 'toggle-visibility':
        await this.deps.overlay.toggleVisibility();
        break;
      case 'stop-session':
        await this.deps.overlay.stopSession();
        break;
      case 'toggle-stealth':
        await this.deps.overlay.toggleStealth(parameters!.enabled as boolean);
        break;
      case 'set-input':
        await this.deps.overlay.setInput(parameters!.text as string);
        break;
      case 'submit-input':
        await this.deps.overlay.submitInput(parameters!.text as string);
        break;
    }
  }

  private async executeAIAction(
    action: AIIntentAction,
    parameters?: Record<string, unknown>,
  ): Promise<void> {
    switch (action) {
      case 'trigger':
        await this.deps.ai.trigger(parameters?.query as string | undefined);
        break;
      case 'stop-generation':
        await this.deps.ai.stopGeneration();
        break;
      case 'follow-up':
        await this.deps.ai.followUp(parameters!.text as string);
        break;
    }
  }

  /**
   * Project the current canonical state to the sidecar.
   * Sends a patch if possible; falls back to a full snapshot if no previous state.
   */
  private projectCurrentState(): void {
    const sent = this.sendPatch();
    if (!sent) {
      // No patch (no previous state or no changes) — send full snapshot
      this.sendFullSnapshot();
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────────

/**
 * Create an IntentAdapter with the given dependencies.
 * All service delegates must route to EXISTING Electron-owned services.
 */
export function createIntentAdapter(deps: IntentAdapterDeps): IntentAdapter {
  return new IntentAdapter(deps);
}
