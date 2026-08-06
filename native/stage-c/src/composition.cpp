// ============================================================================
// CompositionHost implementation — DirectComposition + WebView2 composition
// controller for Stage C transparent rendering.
// Zule AI presentation process
//
// Requirements satisfied:
//   9.2 — WebView2 hosted through composition-controller path with
//          DirectComposition visual tree
//   9.3 — Default background alpha set to 0 on initialization
//   9.4 — Alpha 0 in rendered content yields alpha 0 at the surface pixel
//   9.5 — Premultiplied partial alpha preserved within 1 unit error
//   9.6 — Declared transparent regions present zero alpha-positive pixels
//   9.7 — Composition root and controller sized to full client rect before
//          presenting a resized frame (atomic commit)
//   9.8 — Zero visible desktop pixels while the surface is hidden
//   9.9 — Compact/expanded/maximized mode semantics without service logic
//
// The composition tree is sized to the client area and committed before any
// frame can be shown. The floating surface remains hidden throughout this
// initialization (Req 9.8) — Show() is called only after Ready_Handshake.
// ============================================================================

#include "pch.h"
#include "composition.h"

namespace zule {

// ---------------------------------------------------------------------------
// Destructor — ensures cleanup even if Destroy() was not called explicitly.
// ---------------------------------------------------------------------------
CompositionHost::~CompositionHost()
{
    Destroy();
}

// ---------------------------------------------------------------------------
// InitializeComposition — create DirectComposition device, target, and root
// visual bound to the floating surface HWND.
// ---------------------------------------------------------------------------
HRESULT CompositionHost::InitializeComposition(HWND hwnd) noexcept
{
    if (!hwnd || !IsWindow(hwnd)) {
        return E_INVALIDARG;
    }

    hwnd_ = hwnd;

    // Create the DirectComposition device.
    // Passing nullptr uses the default D3D device (sufficient for WebView2
    // composition which manages its own rendering pipeline).
    HRESULT hr = DCompositionCreateDevice(
        nullptr,
        IID_PPV_ARGS(&dcompDevice_));
    if (FAILED(hr)) {
        return hr;
    }

    // Create a composition target bound to the floating surface window.
    hr = dcompDevice_->CreateTargetForHwnd(
        hwnd_,
        TRUE,  // topmost — visual tree renders above window content
        &dcompTarget_);
    if (FAILED(hr)) {
        dcompDevice_.Reset();
        return hr;
    }

    // Create the root visual that will host the WebView2 content visual.
    hr = dcompDevice_->CreateVisual(&rootVisual_);
    if (FAILED(hr)) {
        dcompTarget_.Reset();
        dcompDevice_.Reset();
        return hr;
    }

    // Set the root visual on the target.
    hr = dcompTarget_->SetRoot(rootVisual_.Get());
    if (FAILED(hr)) {
        rootVisual_.Reset();
        dcompTarget_.Reset();
        dcompDevice_.Reset();
        return hr;
    }

    // Commit the initial (empty) visual tree.
    hr = dcompDevice_->Commit();
    if (FAILED(hr)) {
        rootVisual_.Reset();
        dcompTarget_.Reset();
        dcompDevice_.Reset();
        return hr;
    }

    compositionReady_ = true;
    return S_OK;
}

// ---------------------------------------------------------------------------
// InitializeWebView2 — create the WebView2 environment and composition
// controller. This is asynchronous: the controller is created in a callback.
//
// The composition controller path (not the windowed host path) is used so
// that rendering goes through the DirectComposition visual tree, which
// enables per-pixel alpha transparency (Req 9.2).
// ---------------------------------------------------------------------------
HRESULT CompositionHost::InitializeWebView2(
    HWND hwnd,
    const wchar_t* browserFolder,
    const wchar_t* userDataFolder) noexcept
{
    if (!compositionReady_) {
        return E_FAIL;  // Must call InitializeComposition first
    }

    if (!hwnd || !IsWindow(hwnd)) {
        return E_INVALIDARG;
    }

    // Capture 'this' safely — CompositionHost outlives all callbacks because
    // it is destroyed only after the message loop exits and the controller
    // is released.
    HWND capturedHwnd = hwnd;

    // Step 1: Create the WebView2 environment.
    HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
        browserFolder,    // Fixed runtime path or nullptr for Evergreen
        userDataFolder,   // User data folder for profile/cache
        nullptr,          // No custom environment options needed
        Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [this, capturedHwnd](
                HRESULT envResult,
                ICoreWebView2Environment* environment) -> HRESULT
            {
                if (FAILED(envResult) || !environment) {
                    return envResult;
                }

                webviewEnvironment_ = environment;

                // Step 2: Create the composition controller (not the
                // windowed controller). This attaches WebView2's renderer
                // output to our DirectComposition visual tree.
                Microsoft::WRL::ComPtr<ICoreWebView2Environment3> env3;
                HRESULT hr = webviewEnvironment_.As(&env3);
                if (FAILED(hr)) {
                    return hr;
                }

                hr = env3->CreateCoreWebView2CompositionController(
                    capturedHwnd,
                    Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2CompositionControllerCompletedHandler>(
                        [this, capturedHwnd](
                            HRESULT controllerResult,
                            ICoreWebView2CompositionController* compositionCtrl) -> HRESULT
                        {
                            if (FAILED(controllerResult) || !compositionCtrl) {
                                return controllerResult;
                            }

                            compositionController_ = compositionCtrl;

                            // Obtain the base controller interface.
                            HRESULT hr = compositionController_.As(&controller_);
                            if (FAILED(hr)) {
                                return hr;
                            }

                            // Obtain ICoreWebView2Controller3 for background
                            // color control.
                            hr = controller_.As(&controller3_);
                            if (FAILED(hr)) {
                                return hr;
                            }

                            // Req 9.3: Set WebView2 default background to
                            // fully transparent (alpha = 0).
                            COREWEBVIEW2_COLOR transparent = {0, 0, 0, 0};
                            hr = controller3_->put_DefaultBackgroundColor(transparent);
                            if (FAILED(hr)) {
                                return hr;
                            }

                            // Attach the WebView2 content visual to our
                            // DirectComposition root visual. This connects
                            // the WebView2 renderer to the composition tree
                            // (Req 9.2).
                            hr = compositionController_->put_RootVisualTarget(
                                rootVisual_.Get());
                            if (FAILED(hr)) {
                                return hr;
                            }

                            // Size the controller bounds to the full client
                            // area so that composition root matches the
                            // surface before any frame is shown (Req 9.8).
                            RECT clientRect = {};
                            if (GetClientRect(capturedHwnd, &clientRect)) {
                                hr = controller_->put_Bounds(clientRect);
                                if (FAILED(hr)) {
                                    return hr;
                                }
                            }

                            // Commit the updated visual tree with the
                            // WebView2 content attached.
                            if (dcompDevice_) {
                                dcompDevice_->Commit();
                            }

                            webviewReady_ = true;
                            return S_OK;
                        }
                    ).Get());

                return hr;
            }
        ).Get());

    return hr;
}

// ---------------------------------------------------------------------------
// Resize — update both the DirectComposition root visual offset/size and the
// WebView2 controller bounds to match the new client area.
//
// Both the DComp visual and the controller bounds are sized atomically
// before presenting the resized frame (Req 9.7). The commit happens only
// after both are set to prevent partially-sized content from being visible.
// ---------------------------------------------------------------------------
void CompositionHost::Resize(UINT widthPixels, UINT heightPixels) noexcept
{
    if (!compositionReady_) {
        return;
    }

    // Size the root visual content (offset/clip) if available.
    // DCompositionVisual doesn't have explicit width/height, but we set
    // a clip rectangle to bound rendering to the client area.
    if (rootVisual_) {
        D2D_RECT_F clipRect = {
            0.0f,
            0.0f,
            static_cast<FLOAT>(widthPixels),
            static_cast<FLOAT>(heightPixels)
        };
        rootVisual_->SetClip(clipRect);
    }

    // Update the controller bounds if WebView2 is ready.
    if (controller_) {
        RECT bounds = {0, 0, static_cast<LONG>(widthPixels), static_cast<LONG>(heightPixels)};
        controller_->put_Bounds(bounds);
    }

    // Commit the visual tree change only after both visual and controller
    // are sized — atomic presentation (Req 9.7).
    if (dcompDevice_) {
        dcompDevice_->Commit();
    }
}

// ---------------------------------------------------------------------------
// SetVisible — control visibility of the composition tree (Req 9.8).
//
// While hidden, the Stage C sidecar presents zero visible desktop pixels.
// This is achieved by removing the root visual from the target (no content
// is composited to the surface) and hiding the WebView2 controller.
// ---------------------------------------------------------------------------
void CompositionHost::SetVisible(bool visible) noexcept
{
    if (!compositionReady_) {
        return;
    }

    if (visible_ == visible) {
        return;  // No-op if already in requested state
    }

    visible_ = visible;

    if (visible) {
        // Restore: set root visual back on target, then make controller visible
        if (dcompTarget_ && rootVisual_) {
            dcompTarget_->SetRoot(rootVisual_.Get());
        }
        if (controller_) {
            controller_->put_IsVisible(TRUE);
        }
    } else {
        // Hide: set controller invisible, then remove root from target
        if (controller_) {
            controller_->put_IsVisible(FALSE);
        }
        if (dcompTarget_) {
            dcompTarget_->SetRoot(nullptr);
        }
    }

    // Commit the visibility change
    if (dcompDevice_) {
        dcompDevice_->Commit();
    }
}

// ---------------------------------------------------------------------------
// SetMode — update the overlay mode (Req 9.9).
//
// The mode represents the Layer_0 presentation semantics:
//   Compact   — minimal capsule layout
//   Expanded  — standard working layout
//   Maximized — fills work area
//
// This does NOT implement application service logic; it simply records the
// mode for use by the caller when determining surface bounds. The actual
// resize to match the mode's target bounds is done by the caller via
// Resize() after determining the appropriate dimensions.
// ---------------------------------------------------------------------------
void CompositionHost::SetMode(OverlayMode mode) noexcept
{
    mode_ = mode;
}

// ---------------------------------------------------------------------------
// Destroy — release all COM resources in deterministic reverse order.
//
// Cleanup ordering (Req 9.7, 9.8):
//   1. Controller.Close() → release controller pointers
//   2. Release environment
//   3. Release visuals (root visual)
//   4. Release target
//   5. Release device
//
// Handles the case where visibility was toggled (root visual may have been
// removed from target via SetVisible(false)).
// ---------------------------------------------------------------------------
void CompositionHost::Destroy() noexcept
{
    webviewReady_ = false;
    compositionReady_ = false;
    visible_ = false;

    // 1. Release WebView2 controller resources first (they reference the visual).
    if (controller_) {
        controller_->Close();
    }
    controller3_.Reset();
    controller_.Reset();
    compositionController_.Reset();

    // 2. Release environment
    webviewEnvironment_.Reset();

    // 3. Release the root visual (may already be detached from target if
    //    SetVisible(false) was called).
    rootVisual_.Reset();

    // 4. Release the composition target
    dcompTarget_.Reset();

    // 5. Release the composition device last
    dcompDevice_.Reset();

    hwnd_ = nullptr;
}

// ---------------------------------------------------------------------------
// IsReady — returns true when both the composition tree and WebView2
// controller are initialized.
// ---------------------------------------------------------------------------
bool CompositionHost::IsReady() const noexcept
{
    return compositionReady_ && webviewReady_;
}

} // namespace zule
