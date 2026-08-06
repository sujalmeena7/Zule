#pragma once

// ============================================================================
// Stage C Protocol Types — C++ Payload Structs and Enums
// Generated from the canonical TypeScript schema source:
//   electron/stageC/protocol/schema.ts
//
// These types match the TypeScript interfaces exactly. The parity check
// validates constant alignment; struct layout is verified by conformance tests.
//
// Requirements: 5.5–5.6, 6.14, 6.18–6.21, 7.4, 14.6
// ============================================================================

#include <cstdint>
#include <string>
#include <vector>
#include <optional>

namespace zule::protocol {

// ────────────────────────────────────────────────────────────────────
// Overlay Mode (mirrors TypeScript OverlayMode enum)
// ────────────────────────────────────────────────────────────────────

enum class OverlayMode : std::uint8_t {
    Compact   = 0,
    Expanded  = 1,
    Maximized = 2,
};

// String representations matching TypeScript enum values
inline constexpr std::string_view OverlayModeStr_Compact   = "compact";
inline constexpr std::string_view OverlayModeStr_Expanded  = "expanded";
inline constexpr std::string_view OverlayModeStr_Maximized = "maximized";

// ────────────────────────────────────────────────────────────────────
// Message Direction (mirrors TypeScript MessageDirection enum)
// ────────────────────────────────────────────────────────────────────

enum class MessageDirection : std::uint8_t {
    ControllerToSidecar = 0,
    SidecarToController = 1,
};

// ────────────────────────────────────────────────────────────────────
// Geometry (mirrors TypeScript DipRectangle interface)
// ────────────────────────────────────────────────────────────────────

/** Rectangle in Device-Independent Pixels. */
struct DipRectangle {
    double left   = 0.0;
    double top    = 0.0;
    double width  = 0.0;
    double height = 0.0;
};

// ────────────────────────────────────────────────────────────────────
// Protocol Version
// ────────────────────────────────────────────────────────────────────

struct ProtocolVersion {
    std::uint32_t major = 0;
    std::uint32_t minor = 0;
};

// ────────────────────────────────────────────────────────────────────
// Controller → Sidecar Payloads
// ────────────────────────────────────────────────────────────────────

struct LifecycleShutdownPayload {
    std::string reason;
};

struct StateSnapshotPayload {
    std::uint64_t revision          = 0;
    bool          visibility_requested = false;
    DipRectangle  bounds_dip        = {};
    OverlayMode   mode              = OverlayMode::Compact;
    bool          capture_protection = false;
    std::string   render_state_json;  // Opaque JSON object as string
};

struct StatePatchPayload {
    std::uint64_t base_revision = 0;
    std::uint64_t next_revision = 0;
    std::optional<bool>         visibility_requested;
    std::optional<DipRectangle> bounds_dip;
    std::optional<OverlayMode>  mode;
    std::optional<bool>         capture_protection;
    std::optional<std::string>  render_state_patch_json;
};

struct SurfaceSetBoundsPayload {
    DipRectangle bounds_dip = {};
};

struct SurfaceSetVisibilityPayload {
    bool visible = false;
};

struct SurfaceSetCaptureProtectionPayload {
    bool enabled = false;
};

struct AiStreamDeltaPayload {
    std::string   stream_id;
    std::string   delta;
    std::uint64_t sequence = 0;
};

struct AiStreamCompletedPayload {
    std::string   stream_id;
    std::uint64_t final_sequence = 0;
};

struct AiStreamFailedPayload {
    std::string stream_id;
    std::string error_code;
};

struct OperationResultPayload {
    std::string            operation_id;
    bool                   success = false;
    std::optional<std::string> error_code;
    std::optional<std::string> data_json;  // Opaque JSON object as string
};

// ────────────────────────────────────────────────────────────────────
// Sidecar → Controller Payloads
// ────────────────────────────────────────────────────────────────────

struct LifecycleReadyPayload {
    std::string              launch_id;
    std::string              sidecar_version;
    std::uint32_t            protocol_major          = 0;
    std::uint32_t            protocol_minor          = 0;
    std::uint32_t            bridge_schema_version   = 0;
    std::vector<std::string> capabilities;
    std::string              webview2_runtime_version;
};

struct LifecycleShutdownAckPayload {
    std::string launch_id;
};

struct SurfaceFirstFrameReadyPayload {
    std::uint64_t revision = 0;
};

struct StateSnapshotAckPayload {
    std::uint64_t revision = 0;
};

struct StatePatchAckPayload {
    std::uint64_t revision = 0;
};

struct SurfaceBoundsChangedPayload {
    DipRectangle bounds_dip = {};
};

struct SurfaceCaptureProtectionResultPayload {
    bool enabled        = false;
    bool success        = false;
    bool read_back_value = false;
};

struct IntentOverlayPayload {
    std::string            action;
    std::optional<std::string> parameters_json;  // Opaque JSON object as string
};

struct IntentAiPayload {
    std::string            action;
    std::optional<std::string> parameters_json;
};

struct IntentAudioPayload {
    std::string            action;
    std::optional<std::string> parameters_json;
};

struct IntentScreenCapturePayload {
    std::string            action;
    std::optional<std::string> parameters_json;
};

struct DiagnosticContentPolicyEventPayload {
    std::string event_type;
    std::string detail;
};

} // namespace zule::protocol
