#pragma once

// ============================================================================
// FloatingSurface — Stage C hidden native window shell
// Zule AI presentation process
//
// Owns the single borderless WS_POPUP floating surface with:
//   - Stable class name: ZuleUIWindow (no randomization)
//   - Empty title (no concealment naming)
//   - Initially hidden until Ready_Handshake completes
//   - Deterministic cleanup of HWND and class registration
//
// Requirements: 2.4–2.9, 5.8, 9.1, 13.3
// ============================================================================

#include "pch.h"

namespace zule {

class FloatingSurface final {
public:
    FloatingSurface() = default;
    ~FloatingSurface();

    FloatingSurface(const FloatingSurface&) = delete;
    FloatingSurface& operator=(const FloatingSurface&) = delete;
    FloatingSurface(FloatingSurface&&) = delete;
    FloatingSurface& operator=(FloatingSurface&&) = delete;

    // Register the ZuleUIWindow class. Idempotent — handles
    // ERROR_CLASS_ALREADY_EXISTS gracefully.
    // Returns S_OK on success, or HRESULT_FROM_WIN32 on failure.
    [[nodiscard]] HRESULT RegisterWindowClass(HINSTANCE hInstance) noexcept;

    // Create the hidden WS_POPUP floating surface.
    // Must be called after RegisterWindowClass.
    // Returns S_OK on success, or HRESULT_FROM_WIN32 on failure.
    [[nodiscard]] HRESULT Create(HINSTANCE hInstance) noexcept;

    // Show the floating surface (called after Ready_Handshake completes).
    void Show() noexcept;

    // Hide the floating surface.
    void Hide() noexcept;

    // Set position and size of the floating surface.
    void SetBounds(const RECT& bounds) noexcept;

    // Handle WM_SIZE: returns the new client width and height.
    // The caller (window proc) should forward these to CompositionHost::Resize().
    struct SizeResult {
        UINT width;
        UINT height;
    };
    [[nodiscard]] std::optional<SizeResult> OnResize(UINT width, UINT height) noexcept;

    // Deterministic cleanup: DestroyWindow, then UnregisterClass.
    void Destroy() noexcept;

    // Accessor for the underlying window handle.
    [[nodiscard]] HWND GetHwnd() const noexcept { return hwnd_; }

    // Stable class name — no randomization, no concealment (Req 2.4, 2.7, 2.8).
    static constexpr const wchar_t* kClassName = L"ZuleUIWindow";

private:
    HWND hwnd_ = nullptr;
    HINSTANCE hInstance_ = nullptr;
    ATOM classAtom_ = 0;
};

} // namespace zule
