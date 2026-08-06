// ============================================================================
// WebView2Probe implementation — Stage C WebView2 runtime availability check
// Zule AI presentation process
//
// Requirements satisfied:
//   4.4   — Verify WebView2_Runtime presence and minimum version through the
//           supported runtime query API without spawning the sidecar
//   5.5   — Ready_Handshake includes WebView2 runtime version (stored here)
//   5.8   — Surface remains hidden during this probe
//   14.16 — Zero downloads at startup; uses
//           GetAvailableCoreWebView2BrowserVersionString which only reads
//           registry state
// ============================================================================

#include "pch.h"
#include "webview2_probe.h"

namespace zule {

// ---------------------------------------------------------------------------
// CompareVersions — dotted numeric version comparison
// ---------------------------------------------------------------------------
int CompareVersions(std::wstring_view a, std::wstring_view b) noexcept
{
    // Parse segments from each version string and compare numerically.
    // Treats missing trailing segments as 0.

    auto parseNext = [](std::wstring_view& s) -> int {
        if (s.empty()) return 0;

        int value = 0;
        size_t i = 0;
        while (i < s.size() && s[i] != L'.') {
            if (s[i] >= L'0' && s[i] <= L'9') {
                value = value * 10 + static_cast<int>(s[i] - L'0');
            }
            ++i;
        }

        // Skip past the dot separator
        if (i < s.size() && s[i] == L'.') {
            ++i;
        }
        s = s.substr(i);
        return value;
    };

    std::wstring_view aCopy = a;
    std::wstring_view bCopy = b;

    // Iterate through all segments. Continue as long as either has content.
    while (!aCopy.empty() || !bCopy.empty()) {
        const int va = parseNext(aCopy);
        const int vb = parseNext(bCopy);
        if (va != vb) {
            return va - vb;
        }
    }

    return 0;
}

// ---------------------------------------------------------------------------
// QueryWebView2Availability
// ---------------------------------------------------------------------------
WebView2ProbeResult QueryWebView2Availability(std::wstring_view minimumVersion) noexcept
{
    WebView2ProbeResult result;
    result.requiredVersion = std::wstring(minimumVersion);

    // Use GetAvailableCoreWebView2BrowserVersionString from the WebView2 SDK.
    // This API queries the registry for the installed Evergreen runtime version
    // without launching any process or downloading anything (Req 4.4, 14.16).
    //
    // Parameters:
    //   browserExecutableFolder = nullptr → query the Evergreen runtime
    //                                       (not a fixed-version distribution)
    //   versionInfo             = output pointer to the version string
    //
    // The function allocates the string with CoTaskMemAlloc; caller must free
    // with CoTaskMemFree.

    LPWSTR versionInfo = nullptr;
    const HRESULT hr = GetAvailableCoreWebView2BrowserVersionString(
        nullptr,         // nullptr = Evergreen runtime (no fixed version folder)
        &versionInfo
    );

    if (FAILED(hr) || versionInfo == nullptr || versionInfo[0] == L'\0') {
        // Runtime not found
        if (versionInfo) {
            CoTaskMemFree(versionInfo);
        }
        result.status = WebView2Availability::NotFound;
        return result;
    }

    // Store the found version
    result.installedVersion = versionInfo;
    CoTaskMemFree(versionInfo);

    // Compare against the minimum version from the manifest
    if (CompareVersions(result.installedVersion, minimumVersion) < 0) {
        result.status = WebView2Availability::VersionTooOld;
        return result;
    }

    result.status = WebView2Availability::Available;
    return result;
}

} // namespace zule
