#pragma once

// ============================================================================
// WebView2Probe — Stage C WebView2 runtime availability check
// Zule AI presentation process
//
// Checks whether the WebView2 Evergreen runtime is installed and meets the
// minimum version required by the Stage C manifest, without downloading,
// installing, or updating the runtime (Req 14.16).
//
// Uses GetAvailableCoreWebView2BrowserVersionString() from the WebView2 SDK,
// which queries the installed runtime without spawning a process (Req 4.4).
//
// Requirements satisfied:
//   4.4   — Verify WebView2_Runtime presence and minimum version
//   5.4   — Ready_Handshake sent after WebView2 initialization completes
//   5.5   — Ready_Handshake includes WebView2 runtime version
//   5.8   — Surface remains hidden during probe
//   14.16 — Zero downloads at startup
// ============================================================================

#include "pch.h"

namespace zule {

// ---------------------------------------------------------------------------
// Availability status
// ---------------------------------------------------------------------------
enum class WebView2Availability {
    Available,      // Runtime found and version meets minimum
    NotFound,       // Runtime not installed
    VersionTooOld   // Runtime found but below minimum version
};

// ---------------------------------------------------------------------------
// Typed probe result
// ---------------------------------------------------------------------------
struct WebView2ProbeResult {
    WebView2Availability status = WebView2Availability::NotFound;

    // The installed runtime version string (e.g., "120.0.2210.55").
    // Empty when status == NotFound.
    std::wstring installedVersion;

    // The minimum version that was required.
    // Populated when status == VersionTooOld for diagnostics.
    std::wstring requiredVersion;
};

// ---------------------------------------------------------------------------
// Compare two dotted version strings (e.g., "120.0.2210.55" vs "119.0.2151.0").
// Returns:
//   > 0  if a > b
//   == 0 if a == b
//   < 0  if a < b
// Handles unequal segment counts by treating missing segments as 0.
// ---------------------------------------------------------------------------
[[nodiscard]] int CompareVersions(std::wstring_view a, std::wstring_view b) noexcept;

// ---------------------------------------------------------------------------
// Query WebView2 Evergreen runtime availability.
//
// Uses GetAvailableCoreWebView2BrowserVersionString() which reads the
// registry — never spawns a process, never downloads anything.
//
// Parameters:
//   minimumVersion — the minimum acceptable version string from the manifest
//                    (e.g., L"119.0.2151.0")
//
// Returns a typed WebView2ProbeResult.
// ---------------------------------------------------------------------------
[[nodiscard]] WebView2ProbeResult QueryWebView2Availability(
    std::wstring_view minimumVersion) noexcept;

} // namespace zule
