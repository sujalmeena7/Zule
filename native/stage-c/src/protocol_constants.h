#pragma once

// ============================================================================
// Stage C Protocol Constants — Deterministic C++ Bindings
// Generated from the canonical TypeScript schema source:
//   electron/stageC/protocol/schema.ts
//
// This header MUST stay in exact sync with the TypeScript constants.
// The schema parity check (native/stage-c/scripts/check-schema-parity.mjs)
// will fail the build if these values drift.
//
// Requirements: 5.5–5.6, 6.14, 6.18–6.21, 7.4, 14.6
// ============================================================================

#include <cstdint>
#include <string_view>

namespace zule::protocol {

// ────────────────────────────────────────────────────────────────────
// Protocol Version Constants
// ────────────────────────────────────────────────────────────────────

/** Protocol major version — both sides must match exactly. */
inline constexpr std::uint32_t PROTOCOL_MAJOR = 1;

/** Protocol minor version — additive capabilities. */
inline constexpr std::uint32_t PROTOCOL_MINOR = 0;

/** Bridge schema version for WebView2 adapter validation. */
inline constexpr std::uint32_t BRIDGE_SCHEMA_VERSION = 1;

/** Schema revision identifier for drift detection between TS and C++. */
inline constexpr std::string_view SCHEMA_HASH_VERSION = "1.0.0";

/**
 * Deterministic content hash of the canonical TypeScript schema (first 16 hex chars of SHA-256).
 * Both TypeScript and native builds fail if this value does not match the computed hash.
 * Regenerate with: npm run stage-c:check-schema
 */
inline constexpr std::string_view SCHEMA_CONTENT_HASH = "d86f0f0bd5ad49de";

// ────────────────────────────────────────────────────────────────────
// Size Limits
// ────────────────────────────────────────────────────────────────────

/** Maximum frame size in bytes (Req 6.16). */
inline constexpr std::uint32_t MAX_FRAME_BYTES = 1'048'576;

/** Maximum bridge message size in bytes (Req 7.6). */
inline constexpr std::uint32_t MAX_BRIDGE_MESSAGE_BYTES = 65'536;

/** Maximum telemetry event size in bytes (Req 15.8). */
inline constexpr std::uint32_t MAX_TELEMETRY_EVENT_BYTES = 4'096;

/** Maximum replay cache entries per launch (Req 6.23). */
inline constexpr std::uint32_t MAX_REPLAY_CACHE_ENTRIES = 4'096;

/** Maximum queued messages per connection (Req 6.24). */
inline constexpr std::uint32_t MAX_QUEUED_MESSAGES = 256;

/** Maximum aggregate queued bytes per connection (Req 6.24). */
inline constexpr std::uint32_t MAX_QUEUED_BYTES = 1'048'576;

// ────────────────────────────────────────────────────────────────────
// Message Types — Controller → Sidecar (Req 6.18)
// ────────────────────────────────────────────────────────────────────

namespace controller_to_sidecar {

inline constexpr std::string_view LIFECYCLE_SHUTDOWN        = "lifecycle.shutdown";
inline constexpr std::string_view STATE_SNAPSHOT            = "state.snapshot";
inline constexpr std::string_view STATE_PATCH               = "state.patch";
inline constexpr std::string_view SURFACE_SET_BOUNDS        = "surface.setBounds";
inline constexpr std::string_view SURFACE_SET_VISIBILITY    = "surface.setVisibility";
inline constexpr std::string_view SURFACE_SET_CAPTURE_PROTECTION = "surface.setCaptureProtection";
inline constexpr std::string_view AI_STREAM_DELTA           = "ai.streamDelta";
inline constexpr std::string_view AI_STREAM_COMPLETED       = "ai.streamCompleted";
inline constexpr std::string_view AI_STREAM_FAILED          = "ai.streamFailed";
inline constexpr std::string_view OPERATION_RESULT          = "operation.result";

/** Total count of controller→sidecar message types. */
inline constexpr std::uint32_t COUNT = 10;

} // namespace controller_to_sidecar

// ────────────────────────────────────────────────────────────────────
// Message Types — Sidecar → Controller (Req 6.19)
// ────────────────────────────────────────────────────────────────────

namespace sidecar_to_controller {

inline constexpr std::string_view LIFECYCLE_READY                   = "lifecycle.ready";
inline constexpr std::string_view LIFECYCLE_SHUTDOWN_ACK            = "lifecycle.shutdownAck";
inline constexpr std::string_view SURFACE_FIRST_FRAME_READY        = "surface.firstFrameReady";
inline constexpr std::string_view STATE_SNAPSHOT_ACK               = "state.snapshotAck";
inline constexpr std::string_view STATE_PATCH_ACK                  = "state.patchAck";
inline constexpr std::string_view SURFACE_BOUNDS_CHANGED           = "surface.boundsChanged";
inline constexpr std::string_view SURFACE_CAPTURE_PROTECTION_RESULT = "surface.captureProtectionResult";
inline constexpr std::string_view INTENT_OVERLAY                   = "intent.overlay";
inline constexpr std::string_view INTENT_AI                        = "intent.ai";
inline constexpr std::string_view INTENT_AUDIO                     = "intent.audio";
inline constexpr std::string_view INTENT_SCREEN_CAPTURE            = "intent.screenCapture";
inline constexpr std::string_view DIAGNOSTIC_CONTENT_POLICY_EVENT  = "diagnostic.contentPolicyEvent";

/** Total count of sidecar→controller message types. */
inline constexpr std::uint32_t COUNT = 12;

} // namespace sidecar_to_controller

// ────────────────────────────────────────────────────────────────────
// Validation Error Codes
// ────────────────────────────────────────────────────────────────────

namespace validation {

inline constexpr std::string_view UNKNOWN_FIELD          = "UNKNOWN_FIELD";
inline constexpr std::string_view MISSING_FIELD          = "MISSING_FIELD";
inline constexpr std::string_view INVALID_TYPE           = "INVALID_TYPE";
inline constexpr std::string_view INVALID_VALUE          = "INVALID_VALUE";
inline constexpr std::string_view WRONG_DIRECTION        = "WRONG_DIRECTION";
inline constexpr std::string_view UNKNOWN_MESSAGE_TYPE   = "UNKNOWN_MESSAGE_TYPE";
inline constexpr std::string_view SIZE_EXCEEDED          = "SIZE_EXCEEDED";
inline constexpr std::string_view INVALID_REVISION       = "INVALID_REVISION";
inline constexpr std::string_view INCOMPATIBLE_PROTOCOL  = "INCOMPATIBLE_PROTOCOL";

} // namespace validation

} // namespace zule::protocol
