#pragma once

// ============================================================================
// ZuleUI precompiled header
// Stage C native sidecar — Zule AI
// ============================================================================

// Reduce Windows header bloat
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#ifndef NOMINMAX
#define NOMINMAX
#endif

// Target Windows 10 21H2+ (matches SDK 10.0.22621.0)
#ifndef WINVER
#define WINVER 0x0A00
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

// Windows core headers
#include <windows.h>
#include <windowsx.h>
#include <shellscalingapi.h>

// COM
#include <objbase.h>
#include <combaseapi.h>
#include <wrl/client.h>

// DirectComposition
#include <dcomp.h>

// Direct2D base types (D2D_RECT_F used by IDCompositionVisual::SetClip)
#include <d2d1.h>

// DWM
#include <dwmapi.h>

// Common controls (v6 manifest)
#include <commctrl.h>

// WebView2 C++ interfaces
#include <WebView2.h>
#include <WebView2EnvironmentOptions.h>

// C++ standard library (C++20)
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <optional>
#include <expected>
#include <format>
#include <span>
