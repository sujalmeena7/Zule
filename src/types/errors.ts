// ============================================
// Zule AI — ZuleError discriminated union
// ============================================
//
// Canonical error shape used across the domain layer. Every external surface
// (microphone, screen capture, IndexedDB, Web Speech API, OCR worker, fetch
// to providers, Whisper runtime, Transformers.js) categorises its failures
// at the boundary into one of the variants below, then carries the value
// through the system as a `Result<T, ZuleError>` (see design.md §Error
// Handling).
//
// The recovery policy for every variant is documented in design.md
// §Error Handling > "Recovery policy".

export type ZuleError =
  // Transcription_Engine (Web Speech / local Whisper)
  | { kind: 'transcription.permission-denied' }
  | { kind: 'transcription.permission-revoked' }
  | { kind: 'transcription.unsupported' }
  | { kind: 'transcription.no-speech' }
  | { kind: 'transcription.audio-capture' }
  | { kind: 'transcription.network'; recoverable: true }
  | {
      kind: 'transcription.vad-failed';
      pipeline: 'loopback' | 'microphone';
      cause: 'threw' | 'invalid-score';
    }

  // Screen_Capture_Module
  | { kind: 'screen.permission-denied' }
  | { kind: 'screen.autoplay-blocked' }
  | { kind: 'screen.unsupported' }

  // OCR_Worker
  | { kind: 'ocr.worker-failed'; consecutiveFailures: number }

  // Vector_Index (Transformers.js embedding pipeline)
  | { kind: 'vector-index.init-failed'; attempts: number }
  | { kind: 'vector-index.query-invalid'; reason: 'k-non-positive' | 'dim-mismatch' }
  | {
      kind: 'vector-index.snapshot-corrupt';
      reason:
        | 'truncated'
        | 'manifest-missing'
        | 'version-mismatch'
        | 'dim-mismatch'
        | 'modelId-mismatch';
    }

  // AI_Provider_Router and Provider_Adapters
  | { kind: 'provider.network'; providerId: string }
  | { kind: 'provider.timeout'; providerId: string }
  | { kind: 'provider.rate-limited'; providerId: string; retryAfterMs?: number }
  | { kind: 'provider.server-error'; providerId: string; status: number }
  | { kind: 'provider.unauthorized'; providerId: string }
  | { kind: 'provider.aborted' }

  // Persistence (IndexedDB) and import/export
  | { kind: 'storage.quota-exceeded' }
  | { kind: 'storage.corrupted' }
  | { kind: 'storage.import-invalid'; reason: string }

  // CryptoVault
  | { kind: 'crypto.decrypt-failed' }
  | { kind: 'crypto.passphrase-wrong' }

  // Document_Parser
  | { kind: 'document.unsupported-extension'; ext: string }
  | { kind: 'document.encrypted-pdf' }

  // Cross_Window_Sync
  | { kind: 'cross-window.popup-blocked' }
  | { kind: 'cross-window.host-disconnected' }
  | { kind: 'cross-window.broadcast-unsupported' }

  // Catch-all for the top-level `unhandledrejection` listener
  | { kind: 'unhandled-rejection'; name: string };

/** The discriminator key for `ZuleError` variants. */
export type ZuleErrorKind = ZuleError['kind'];
