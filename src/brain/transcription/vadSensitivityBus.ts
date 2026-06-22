// ============================================
// Zule AI — VAD Sensitivity Bus (design §"VAD Sensitivity Setting")
// ============================================
//
// Renderer-internal singleton EventTarget that broadcasts VAD
// sensitivity changes from the Settings UI to live transcription
// pipelines (`WhisperProvider` for the microphone path,
// `useSystemAudioTranscription` for the loopback path) so they can
// recompute the speech threshold on the next chunk WITHOUT tearing
// down and restarting audio capture.
//
// Acceptance criteria covered:
//   - 7.4 — Live sensitivity changes apply to the next chunk without
//     restarting capture (validated by Property 18 in tasks 11.3).
//
// Wiring (forward references — these consumers land in later tasks):
//   - Settings.tsx (task 11.1) calls `vadSensitivityBus.publish(...)`
//     immediately after `database.saveSetting('vadSensitivity', value)`.
//   - useSystemAudioTranscription (task 9.1) and WhisperProvider
//     (task 10.1) call `vadSensitivityBus.subscribe(...)` on `start`
//     and the returned unsubscribe on teardown.
//
// Design notes:
//   - Backed by a real EventTarget (already global in the renderer).
//     We never use it in the main process — tasks 9/10/11 live in
//     the renderer.
//   - `subscribe` returns an unsubscribe function so callers don't
//     need to keep a handle to the wrapped listener for
//     `removeEventListener`.
//   - `publish` dispatches a CustomEvent under the hood, but
//     subscribers receive the unwrapped `{ type, value }` object so
//     callers never have to unwrap `event.detail`.

/**
 * The 3-level sensitivity dial persisted in `STORE_SETTINGS` under
 * the stable key `vadSensitivity`. `medium` is the documented default
 * (Requirement 7.6) and maps to the same speech threshold the
 * microphone and loopback pipelines used before this feature.
 *
 * This is the canonical declaration of the union — task 8.1 imports
 * `VADSensitivity` from this module when defining
 * `mapSensitivityToThreshold` so the table and the bus stay in sync.
 */
export type VADSensitivity = 'low' | 'medium' | 'high';

/**
 * Payload broadcast on the bus when the user changes the sensitivity
 * in Settings. The `type` discriminant is fixed to `'change'` so the
 * shape is forward-compatible with future event variants without
 * breaking subscribers.
 */
export interface VADSensitivityChangeEvent {
  type: 'change';
  value: VADSensitivity;
}

/**
 * The public surface of the bus. Kept as an explicit interface so
 * tests and consumers can depend on the contract rather than the
 * concrete `EventTarget`-backed implementation.
 */
export interface VADSensitivityBus {
  /**
   * Register `listener` for sensitivity-change events. Returns an
   * unsubscribe function — call it on teardown. Calling the returned
   * function more than once is a no-op.
   */
  subscribe(listener: (event: VADSensitivityChangeEvent) => void): () => void;
  /**
   * Broadcast a sensitivity-change event to every subscriber.
   * Synchronous: every subscriber's listener has run by the time
   * `publish` returns.
   */
  publish(event: VADSensitivityChangeEvent): void;
}

const CHANGE_EVENT = 'change' as const;

function createVADSensitivityBus(): VADSensitivityBus {
  const target = new EventTarget();

  return {
    subscribe(listener) {
      const wrapped = (event: Event): void => {
        // Every event we dispatch is a CustomEvent created in `publish`
        // below, so `detail` is always present and well-typed.
        const detail = (event as CustomEvent<VADSensitivityChangeEvent>).detail;
        listener(detail);
      };
      target.addEventListener(CHANGE_EVENT, wrapped);
      return () => {
        target.removeEventListener(CHANGE_EVENT, wrapped);
      };
    },
    publish(event) {
      target.dispatchEvent(
        new CustomEvent<VADSensitivityChangeEvent>(CHANGE_EVENT, {
          detail: event,
        }),
      );
    },
  };
}

/**
 * The singleton instance. Importers MUST share this instance — there
 * is exactly one bus per renderer process so a `publish` from
 * Settings reaches every live pipeline.
 */
export const vadSensitivityBus: VADSensitivityBus = createVADSensitivityBus();
