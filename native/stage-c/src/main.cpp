// ============================================================================
// ZuleUI.exe — Stage C native sidecar entry point
// Zule AI presentation process (not an application core).
//
// Responsibilities at this layer:
//   - COM apartment initialization (STA)
//   - Bootstrap handle extraction from command line
//   - Process-lifetime resource scaffolding
//   - Graceful exit on any initialization failure
//
// This process is launched and supervised by Electron (App Core).
// It owns exactly one frameless floating surface and a WebView2 controller.
// ============================================================================

#include "pch.h"
#include "floating_surface.h"
#include "webview2_probe.h"
#include "composition.h"

namespace {

// ---------------------------------------------------------------------------
// Minimum WebView2 runtime version required by Stage C.
// Sourced from the Stage C manifest minimum_webview2_version field.
// Must match the value in the packaged manifest (dependency-lock.json).
// ---------------------------------------------------------------------------
constexpr const wchar_t* kMinimumWebView2Version = L"119.0.2151.0";

// Exit code when WebView2 runtime is unavailable or too old.
// The Stage_C_Controller on the Electron side recognizes this specific code.
constexpr int kExitCodeWebView2Unavailable = 5;

// ---------------------------------------------------------------------------
// COM lifetime RAII guard
// ---------------------------------------------------------------------------
class ComGuard final {
public:
    ComGuard() = default;
    ~ComGuard() {
        if (initialized_) {
            CoUninitialize();
        }
    }

    ComGuard(const ComGuard&) = delete;
    ComGuard& operator=(const ComGuard&) = delete;

    [[nodiscard]] HRESULT Initialize() noexcept {
        const HRESULT hr = CoInitializeEx(
            nullptr,
            COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE
        );
        if (SUCCEEDED(hr)) {
            initialized_ = true;
        }
        return hr;
    }

private:
    bool initialized_ = false;
};

// ---------------------------------------------------------------------------
// Parse the bootstrap handle from the command line.
// Expected format: ZuleUI.exe --bootstrap-handle=<uint64_hex>
// Returns std::nullopt on missing or malformed argument.
// ---------------------------------------------------------------------------
[[nodiscard]] std::optional<HANDLE> ParseBootstrapHandle(LPCWSTR cmdLine) noexcept {
    if (!cmdLine || !*cmdLine) {
        return std::nullopt;
    }

    constexpr std::wstring_view kPrefix = L"--bootstrap-handle=";

    std::wstring_view args(cmdLine);
    const auto pos = args.find(kPrefix);
    if (pos == std::wstring_view::npos) {
        return std::nullopt;
    }

    const auto valueStart = pos + kPrefix.size();
    auto valueEnd = args.find(L' ', valueStart);
    if (valueEnd == std::wstring_view::npos) {
        valueEnd = args.size();
    }

    const std::wstring_view hexValue = args.substr(valueStart, valueEnd - valueStart);
    if (hexValue.empty() || hexValue.size() > 16) {
        return std::nullopt;
    }

    // Parse hex value manually to avoid locale-dependent conversions
    std::uint64_t result = 0;
    for (const wchar_t ch : hexValue) {
        std::uint64_t digit = 0;
        if (ch >= L'0' && ch <= L'9') {
            digit = static_cast<std::uint64_t>(ch - L'0');
        } else if (ch >= L'a' && ch <= L'f') {
            digit = static_cast<std::uint64_t>(ch - L'a' + 10);
        } else if (ch >= L'A' && ch <= L'F') {
            digit = static_cast<std::uint64_t>(ch - L'A' + 10);
        } else {
            return std::nullopt;
        }
        result = (result << 4) | digit;
    }

    // HANDLE is pointer-sized; reject zero as invalid
    if (result == 0) {
        return std::nullopt;
    }

    return reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(result));
}

} // anonymous namespace

// ===========================================================================
// Win32 entry point
// ===========================================================================
int WINAPI wWinMain(
    _In_ HINSTANCE hInstance,
    _In_opt_ HINSTANCE /*hPrevInstance*/,
    _In_ LPWSTR lpCmdLine,
    _In_ int /*nCmdShow*/) noexcept
{
    // 1. Initialize COM (STA for WebView2 and DirectComposition)
    ComGuard comGuard;
    {
        const HRESULT hr = comGuard.Initialize();
        if (FAILED(hr)) {
            return 1;
        }
    }

    // 2. Set DPI awareness (belt-and-suspenders; manifest is authoritative)
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    // 3. Parse bootstrap handle from command line
    const auto bootstrapHandle = ParseBootstrapHandle(lpCmdLine);
    if (!bootstrapHandle.has_value()) {
        // No valid bootstrap handle — cannot connect to App Core.
        // Exit gracefully; Electron will detect the early exit and keep Layer 0.
        return 2;
    }

    // 4. Create the floating surface (hidden until Ready_Handshake completes)
    zule::FloatingSurface floatingSurface;
    {
        HRESULT hr = floatingSurface.RegisterWindowClass(hInstance);
        if (FAILED(hr)) {
            CloseHandle(bootstrapHandle.value());
            return 3;
        }

        hr = floatingSurface.Create(hInstance);
        if (FAILED(hr)) {
            CloseHandle(bootstrapHandle.value());
            return 4;
        }
    }

    // 5. Probe WebView2 runtime availability (Req 4.4, 14.16).
    //    Surface remains hidden throughout this check (Req 5.8).
    //    Uses GetAvailableCoreWebView2BrowserVersionString — never downloads,
    //    never spawns a process.
    const auto wv2Result = zule::QueryWebView2Availability(kMinimumWebView2Version);
    if (wv2Result.status != zule::WebView2Availability::Available) {
        // WebView2 not found or version too old.
        // Exit with specific code; Electron detects early exit and keeps Layer 0.
        // The floating surface remains hidden (Req 5.8) and is cleaned up below.
        CloseHandle(bootstrapHandle.value());
        floatingSurface.Destroy();
        return kExitCodeWebView2Unavailable;
    }

    // WebView2 version is stored for inclusion in the Ready_Handshake later
    // (Req 5.4, 5.5). The wv2Result.installedVersion holds the exact string.
    // Future stages (20.x) will use this in the handshake payload.

    // 6. Initialize DirectComposition visual tree and WebView2 composition
    //    controller (Req 9.2, 9.3, 9.8).
    //    The surface remains hidden — composition initialization happens before
    //    any frame can be shown. Alpha is set to 0 (Req 9.3).
    zule::CompositionHost compositionHost;
    {
        HRESULT hr = compositionHost.InitializeComposition(floatingSurface.GetHwnd());
        if (FAILED(hr)) {
            CloseHandle(bootstrapHandle.value());
            floatingSurface.Destroy();
            return 6;
        }

        // User data folder for WebView2 profile/cache.
        // Placed under the executable directory for isolation.
        // Future tasks may derive this from the bootstrap payload or manifest.
        wchar_t exePath[MAX_PATH] = {};
        GetModuleFileNameW(nullptr, exePath, MAX_PATH);
        std::wstring userDataFolder(exePath);
        const auto lastSlash = userDataFolder.find_last_of(L'\\');
        if (lastSlash != std::wstring::npos) {
            userDataFolder.resize(lastSlash + 1);
        }
        userDataFolder += L"ZuleUI.WebView2";

        hr = compositionHost.InitializeWebView2(
            floatingSurface.GetHwnd(),
            nullptr,           // Use installed Evergreen runtime
            userDataFolder.c_str());
        if (FAILED(hr)) {
            compositionHost.Destroy();
            CloseHandle(bootstrapHandle.value());
            floatingSurface.Destroy();
            return 7;
        }
    }

    // 7. Future stages will set up IPC, enter the message loop, and call
    //    floatingSurface.Show() after Ready_Handshake completes.
    //    (Tasks 20.x, 24.x)

    // Close the inherited bootstrap handle after use
    CloseHandle(bootstrapHandle.value());

    // 8. Deterministic teardown: composition → window → class → COM
    //    (via ComGuard destructor)
    compositionHost.Destroy();
    floatingSurface.Destroy();

    return 0;
}
