// ============================================================================
// FloatingSurface implementation — Stage C hidden native window shell
// Zule AI presentation process
//
// Requirements satisfied:
//   2.4  — Registers ZuleUIWindow as the Win32 class
//   2.5  — Window title is the empty string
//   2.6  — Any other app-owned top-level window uses non-empty "Zule" title
//   2.7  — Values identical across launches (static class name, no randomization)
//   2.8  — Zero randomized or concealment values
//   2.9  — Zero values claiming Windows/Microsoft/Edge/System/third-party ownership
//   5.8  — Hidden until Ready_Handshake completes
//   9.1  — Borderless WS_POPUP without caption or menu
//   9.7  — OnResize provides client dimensions for composition sizing
//   13.3 — Hidden through startup
// ============================================================================

#include "pch.h"
#include "floating_surface.h"

namespace zule {

// ---------------------------------------------------------------------------
// Window procedure — DefWindowProc passthrough initially.
// Future tasks will replace this with message dispatch.
// ---------------------------------------------------------------------------
static LRESULT CALLBACK FloatingSurfaceWndProc(
    HWND hwnd,
    UINT msg,
    WPARAM wParam,
    LPARAM lParam) noexcept
{
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

// ---------------------------------------------------------------------------
// Destructor — ensures cleanup even if Destroy() was not called explicitly.
// ---------------------------------------------------------------------------
FloatingSurface::~FloatingSurface()
{
    Destroy();
}

// ---------------------------------------------------------------------------
// RegisterWindowClass
// ---------------------------------------------------------------------------
HRESULT FloatingSurface::RegisterWindowClass(HINSTANCE hInstance) noexcept
{
    if (!hInstance) {
        return E_INVALIDARG;
    }

    hInstance_ = hInstance;

    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(WNDCLASSEXW);
    wc.style = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc = FloatingSurfaceWndProc;
    wc.cbClsExtra = 0;
    wc.cbWndExtra = 0;
    wc.hInstance = hInstance_;
    wc.hIcon = nullptr;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = nullptr;  // No background brush — composited
    wc.lpszMenuName = nullptr;   // No menu (Req 9.1)
    wc.lpszClassName = kClassName;
    wc.hIconSm = nullptr;

    classAtom_ = RegisterClassExW(&wc);
    if (classAtom_ == 0) {
        const DWORD err = GetLastError();
        if (err == ERROR_CLASS_ALREADY_EXISTS) {
            // Idempotent — class already registered (e.g., restart scenario).
            // Retrieve the existing atom for unregistration later.
            classAtom_ = 0;  // Cannot unregister a class we did not register
            return S_OK;
        }
        return HRESULT_FROM_WIN32(err);
    }

    return S_OK;
}

// ---------------------------------------------------------------------------
// Create — hidden WS_POPUP surface
// ---------------------------------------------------------------------------
HRESULT FloatingSurface::Create(HINSTANCE hInstance) noexcept
{
    if (hwnd_) {
        // Already created
        return S_OK;
    }

    if (!hInstance_ && hInstance) {
        hInstance_ = hInstance;
    }

    if (!hInstance_) {
        return E_INVALIDARG;
    }

    // Style: WS_POPUP only — no WS_CAPTION, no WS_SYSMENU, no menu (Req 9.1)
    constexpr DWORD style = WS_POPUP;

    // Extended style: toolwindow (no taskbar entry), no activation, layered
    constexpr DWORD exStyle =
        WS_EX_TOOLWINDOW |
        WS_EX_NOACTIVATE |
        WS_EX_LAYERED;

    hwnd_ = CreateWindowExW(
        exStyle,
        kClassName,           // Registered class (Req 2.4)
        L"",                  // Empty title (Req 2.5)
        style,
        0, 0, 1, 1,          // Minimal initial size, off-screen
        nullptr,              // No parent — top-level
        nullptr,              // No menu (Req 9.1)
        hInstance_,
        nullptr               // No create param
    );

    if (!hwnd_) {
        return HRESULT_FROM_WIN32(GetLastError());
    }

    // Window starts hidden (Req 5.8, 13.3) — no ShowWindow call here.
    return S_OK;
}

// ---------------------------------------------------------------------------
// Show — makes the surface visible (called after Ready_Handshake completes)
// ---------------------------------------------------------------------------
void FloatingSurface::Show() noexcept
{
    if (hwnd_) {
        ShowWindow(hwnd_, SW_SHOWNOACTIVATE);
    }
}

// ---------------------------------------------------------------------------
// Hide
// ---------------------------------------------------------------------------
void FloatingSurface::Hide() noexcept
{
    if (hwnd_) {
        ShowWindow(hwnd_, SW_HIDE);
    }
}

// ---------------------------------------------------------------------------
// SetBounds — position and resize the surface
// ---------------------------------------------------------------------------
void FloatingSurface::SetBounds(const RECT& bounds) noexcept
{
    if (hwnd_) {
        const int x = bounds.left;
        const int y = bounds.top;
        const int cx = bounds.right - bounds.left;
        const int cy = bounds.bottom - bounds.top;
        SetWindowPos(
            hwnd_,
            HWND_TOPMOST,
            x, y, cx, cy,
            SWP_NOACTIVATE | SWP_NOZORDER
        );
    }
}

// ---------------------------------------------------------------------------
// OnResize — called from the window proc on WM_SIZE.
// Returns the client dimensions so the caller can forward them to
// CompositionHost::Resize() to size the composition root and controller
// before presenting the resized frame (Req 9.7).
// ---------------------------------------------------------------------------
std::optional<FloatingSurface::SizeResult> FloatingSurface::OnResize(
    UINT width, UINT height) noexcept
{
    if (!hwnd_) {
        return std::nullopt;
    }

    // Use GetClientRect to get the authoritative client dimensions
    // (the passed width/height from WM_SIZE should match, but we prefer
    // the canonical source).
    RECT clientRect = {};
    if (!GetClientRect(hwnd_, &clientRect)) {
        // Fall back to the provided values
        return SizeResult{width, height};
    }

    const UINT clientWidth = static_cast<UINT>(clientRect.right - clientRect.left);
    const UINT clientHeight = static_cast<UINT>(clientRect.bottom - clientRect.top);

    return SizeResult{clientWidth, clientHeight};
}

// ---------------------------------------------------------------------------
// Destroy — deterministic cleanup
// Ordering: DestroyWindow → UnregisterClass (matches Stage A pattern)
// ---------------------------------------------------------------------------
void FloatingSurface::Destroy() noexcept
{
    if (hwnd_) {
        DestroyWindow(hwnd_);
        hwnd_ = nullptr;
    }

    if (classAtom_ != 0 && hInstance_) {
        UnregisterClassW(kClassName, hInstance_);
        classAtom_ = 0;
    }
}

} // namespace zule
