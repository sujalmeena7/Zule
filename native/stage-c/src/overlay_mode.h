#pragma once

// ============================================================================
// OverlayMode — capsule layout modes for the Stage C floating surface.
// Zule AI presentation process
//
// The mode determines the surface size and position (Layer_0 presentation
// semantics) without implementing application service logic. Mode changes
// are received from App Core via IPC and trigger a composition resize.
//
// Requirements: 9.9
// ============================================================================

namespace zule {

// ---------------------------------------------------------------------------
// OverlayMode represents the three static capsule layout modes.
// These correspond to the Layer_0 presentation semantics that Stage C must
// reproduce without implementing application service logic (Req 9.9).
// ---------------------------------------------------------------------------
enum class OverlayMode : std::uint8_t {
    // Compact capsule — minimal footprint, shows essential controls only.
    Compact = 0,

    // Expanded capsule — standard working size with full panel content.
    Expanded = 1,

    // Maximized capsule — fills the available work area.
    Maximized = 2
};

} // namespace zule
