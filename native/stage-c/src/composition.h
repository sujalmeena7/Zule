#pragma once

// ============================================================================
// CompositionHost — DirectComposition visual tree and WebView2 composition
// controller for Stage C transparent rendering.
// Zule AI presentation process
//
// Responsibilities:
//   - Creates IDCompositionDevice, target, and root visual
//   - Attaches WebView2 via the composition-controller path
//   - Sets default background alpha to 0 (transparent)
//   - Sizes the composition root to the full client area
//   - Manages visibility (hidden-surface presents zero desktop pixels)
//   - Keeps the surface hidden until explicitly released
//   - Releases COM/graphics resources in deterministic order
//
// Requirements: 9.2–9.9
// ============================================================================

#include "pch.h"
#include "overlay_mode.h"

namespace zule {

// ---------------------------------------------------------------------------
// CompositionHost owns the DirectComposition device, target, root visual,
// and the WebView2 composition controller. It is initialized after the
// floating surface exists and after the WebView2 probe passes.
//
// The surface MUST remain hidden until Ready_Handshake completes (Req 9.8).
// ---------------------------------------------------------------------------
class CompositionHost final {
public:
    CompositionHost() = default;
    ~CompositionHost();

    CompositionHost(const CompositionHost&) = delete;
    CompositionHost& operator=(const CompositionHost&) = delete;
    CompositionHost(CompositionHost&&) = delete;
    CompositionHost& operator=(CompositionHost&&) = delete;

    // -----------------------------------------------------------------------
    // Initialize the DirectComposition device, target, and root visual.
    // Must be called with a valid HWND (the floating surface).
    // Returns S_OK on success.
    // -----------------------------------------------------------------------
    [[nodiscard]] HRESULT InitializeComposition(HWND hwnd) noexcept;

    // -----------------------------------------------------------------------
    // Create the WebView2 environment and composition controller.
    // Attaches the controller's root visual to the DirectComposition tree.
    // Sets the default background alpha to 0.
    //
    // This is asynchronous (callback-based). The caller should enter the
    // message loop after calling this method.
    //
    // Parameters:
    //   hwnd           — The floating surface HWND
    //   browserFolder  — Optional path to a fixed WebView2 runtime folder
    //                    (nullptr uses the installed Evergreen runtime)
    //   userDataFolder — Path for WebView2 user data (profile, cache)
    //
    // Returns S_OK if the async creation was initiated successfully.
    // -----------------------------------------------------------------------
    [[nodiscard]] HRESULT InitializeWebView2(
        HWND hwnd,
        const wchar_t* browserFolder,
        const wchar_t* userDataFolder) noexcept;

    // -----------------------------------------------------------------------
    // Resize the composition root visual and WebView2 controller bounds
    // to the specified client area dimensions. Both the DComp visual and
    // the controller bounds are sized atomically before presenting the
    // resized frame (Req 9.7).
    // -----------------------------------------------------------------------
    void Resize(UINT widthPixels, UINT heightPixels) noexcept;

    // -----------------------------------------------------------------------
    // Set visibility of the composition tree (Req 9.8).
    // When hiding: sets controller visibility to false, removes root visual
    //              from target — presenting zero visible desktop pixels.
    // When showing: restores root visual on target, sets controller visible.
    // -----------------------------------------------------------------------
    void SetVisible(bool visible) noexcept;

    // -----------------------------------------------------------------------
    // Set the overlay mode (Req 9.9). The mode determines the surface
    // layout semantics (compact/expanded/maximized) without implementing
    // application service logic. Mode changes trigger a resize of the
    // composition to the new bounds provided by the caller.
    // -----------------------------------------------------------------------
    void SetMode(OverlayMode mode) noexcept;

    // -----------------------------------------------------------------------
    // Returns the current overlay mode.
    // -----------------------------------------------------------------------
    [[nodiscard]] OverlayMode GetMode() const noexcept { return mode_; }

    // -----------------------------------------------------------------------
    // Returns current visibility state.
    // -----------------------------------------------------------------------
    [[nodiscard]] bool IsVisible() const noexcept { return visible_; }

    // -----------------------------------------------------------------------
    // Release all COM resources in deterministic order:
    //   Controller → Environment → Visual → Target → Device
    // -----------------------------------------------------------------------
    void Destroy() noexcept;

    // -----------------------------------------------------------------------
    // Returns true when both the composition tree and WebView2 controller
    // are initialized and ready to render.
    // -----------------------------------------------------------------------
    [[nodiscard]] bool IsReady() const noexcept;

    // -----------------------------------------------------------------------
    // Accessors for integration (e.g., input forwarding, resize).
    // -----------------------------------------------------------------------
    [[nodiscard]] ICoreWebView2CompositionController* GetCompositionController() const noexcept {
        return compositionController_.Get();
    }

    [[nodiscard]] ICoreWebView2Controller* GetController() const noexcept {
        return controller_.Get();
    }

    [[nodiscard]] IDCompositionVisual* GetRootVisual() const noexcept {
        return rootVisual_.Get();
    }

private:
    // DirectComposition objects
    Microsoft::WRL::ComPtr<IDCompositionDevice> dcompDevice_;
    Microsoft::WRL::ComPtr<IDCompositionTarget> dcompTarget_;
    Microsoft::WRL::ComPtr<IDCompositionVisual> rootVisual_;

    // WebView2 objects
    Microsoft::WRL::ComPtr<ICoreWebView2Environment> webviewEnvironment_;
    Microsoft::WRL::ComPtr<ICoreWebView2CompositionController> compositionController_;
    Microsoft::WRL::ComPtr<ICoreWebView2Controller> controller_;
    Microsoft::WRL::ComPtr<ICoreWebView2Controller3> controller3_;

    // State
    HWND hwnd_ = nullptr;
    bool compositionReady_ = false;
    bool webviewReady_ = false;
    bool visible_ = false;          // Hidden until Show; Req 9.8
    OverlayMode mode_ = OverlayMode::Compact;
};

} // namespace zule
