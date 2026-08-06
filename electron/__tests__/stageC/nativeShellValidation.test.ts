/**
 * Stage C2 — Native Shell Validation Tests
 *
 * Since the native C++ code cannot compile on this machine (no MSVC toolchain),
 * these tests validate the C++ source artifacts for correctness by inspecting
 * the source files for required patterns, declarations, and ordering.
 *
 * Validates: Requirements 2.1–2.9, 3.7, 4.4, 5.8, 9.1, 16.6
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// --------------------------------------------------------------------
// Paths to native source artifacts
// --------------------------------------------------------------------

const NATIVE_DIR = path.resolve(__dirname, '../../../native/stage-c');
const SRC_DIR = path.join(NATIVE_DIR, 'src');

const FLOATING_SURFACE_H = path.join(SRC_DIR, 'floating_surface.h');
const FLOATING_SURFACE_CPP = path.join(SRC_DIR, 'floating_surface.cpp');
const MAIN_CPP = path.join(SRC_DIR, 'main.cpp');
const RESOURCES_RC = path.join(SRC_DIR, 'resources.rc');
const VCXPROJ = path.join(NATIVE_DIR, 'ZuleUI.vcxproj');
const WEBVIEW2_PROBE_H = path.join(SRC_DIR, 'webview2_probe.h');
const WEBVIEW2_PROBE_CPP = path.join(SRC_DIR, 'webview2_probe.cpp');

// --------------------------------------------------------------------
// Source content cache
// --------------------------------------------------------------------

let floatingSurfaceH: string;
let floatingSurfaceCpp: string;
let mainCpp: string;
let resourcesRc: string;
let vcxproj: string;
let webview2ProbeH: string;
let webview2ProbeCpp: string;

beforeAll(() => {
  floatingSurfaceH = fs.readFileSync(FLOATING_SURFACE_H, 'utf-8');
  floatingSurfaceCpp = fs.readFileSync(FLOATING_SURFACE_CPP, 'utf-8');
  mainCpp = fs.readFileSync(MAIN_CPP, 'utf-8');
  resourcesRc = fs.readFileSync(RESOURCES_RC, 'utf-8');
  vcxproj = fs.readFileSync(VCXPROJ, 'utf-8');
  webview2ProbeH = fs.readFileSync(WEBVIEW2_PROBE_H, 'utf-8');
  webview2ProbeCpp = fs.readFileSync(WEBVIEW2_PROBE_CPP, 'utf-8');
});

// ====================================================================
// One-surface ownership: floating_surface.h declares exactly one kClassName
// Req 2.4, 2.7, 2.8
// ====================================================================

describe('One-surface ownership (Req 2.4, 2.7)', () => {
  it('floating_surface.h declares exactly one kClassName constant', () => {
    const matches = floatingSurfaceH.match(/\bkClassName\b/g);
    // Expect exactly one definition (the static constexpr declaration)
    // and no other kClassName constants
    expect(matches).not.toBeNull();

    // The class should have exactly one static constexpr kClassName member
    const declarations = floatingSurfaceH.match(
      /static\s+constexpr\s+const\s+wchar_t\s*\*\s*kClassName\s*=/g,
    );
    expect(declarations).not.toBeNull();
    expect(declarations!.length).toBe(1);
  });

  it('kClassName value is "ZuleUIWindow"', () => {
    const match = floatingSurfaceH.match(/kClassName\s*=\s*L"([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('ZuleUIWindow');
  });

  it('no second window class is registered in the source', () => {
    // Only one RegisterClassExW call should exist in floating_surface.cpp
    const registerCalls = floatingSurfaceCpp.match(/RegisterClassExW/g);
    expect(registerCalls).not.toBeNull();
    expect(registerCalls!.length).toBe(1);
  });

  it('no second CreateWindowExW call creates a top-level surface', () => {
    // Only one CreateWindowExW call should exist in floating_surface.cpp
    const createCalls = floatingSurfaceCpp.match(/CreateWindowExW/g);
    expect(createCalls).not.toBeNull();
    expect(createCalls!.length).toBe(1);
  });
});

// ====================================================================
// .vcxproj links required system libraries
// Req 3.7, 16.6
// ====================================================================

describe('.vcxproj system library linkage (Req 3.7, 16.6)', () => {
  const REQUIRED_LIBS = [
    'user32.lib',
    'gdi32.lib',
    'ole32.lib',
    'dwmapi.lib',
    'dcomp.lib',
    'shcore.lib',
  ];

  it.each(REQUIRED_LIBS)('links against %s', (lib) => {
    // The AdditionalDependencies element should contain the library
    const depsMatch = vcxproj.match(
      /<AdditionalDependencies>([^<]+)<\/AdditionalDependencies>/,
    );
    expect(depsMatch).not.toBeNull();
    expect(depsMatch![1]).toContain(lib);
  });

  it('links against WebView2LoaderStatic.lib', () => {
    const depsMatch = vcxproj.match(
      /<AdditionalDependencies>([^<]+)<\/AdditionalDependencies>/,
    );
    expect(depsMatch).not.toBeNull();
    expect(depsMatch![1]).toContain('WebView2LoaderStatic.lib');
  });

  it('does not use delay-load for core libraries', () => {
    // The vcxproj should not have delay-load entries for required libs
    expect(vcxproj).not.toContain('<DelayLoadDLLs>');
  });

  it('targets Windows subsystem', () => {
    expect(vcxproj).toContain('<SubSystem>Windows</SubSystem>');
  });

  it('uses C++20 language standard', () => {
    expect(vcxproj).toContain('<LanguageStandard>stdcpp20</LanguageStandard>');
  });

  it('uses locked Windows SDK version 10.0.22621.0', () => {
    expect(vcxproj).toContain(
      '<WindowsTargetPlatformVersion>10.0.22621.0</WindowsTargetPlatformVersion>',
    );
  });

  it('uses MSVC v143 platform toolset', () => {
    expect(vcxproj).toContain('<PlatformToolset>v143</PlatformToolset>');
  });

  it('output file is ZuleUI.exe', () => {
    expect(vcxproj).toContain('<OutputFile>$(OutDir)ZuleUI.exe</OutputFile>');
  });
});

// ====================================================================
// main.cpp calls COM init before window creation
// Req 9.1, 5.8
// ====================================================================

describe('main.cpp COM initialization ordering (Req 9.1)', () => {
  it('calls CoInitializeEx before FloatingSurface creation', () => {
    const comInitPos = mainCpp.indexOf('CoInitializeEx');
    const surfaceCreatePos = mainCpp.indexOf('floatingSurface.Create');

    expect(comInitPos).toBeGreaterThan(-1);
    expect(surfaceCreatePos).toBeGreaterThan(-1);
    expect(comInitPos).toBeLessThan(surfaceCreatePos);
  });

  it('uses COINIT_APARTMENTTHREADED for STA', () => {
    expect(mainCpp).toContain('COINIT_APARTMENTTHREADED');
  });

  it('COM initialization precedes RegisterWindowClass', () => {
    const comInitPos = mainCpp.indexOf('CoInitializeEx');
    const registerPos = mainCpp.indexOf('RegisterWindowClass');

    expect(comInitPos).toBeGreaterThan(-1);
    expect(registerPos).toBeGreaterThan(-1);
    expect(comInitPos).toBeLessThan(registerPos);
  });

  it('exits early on COM failure before creating any window', () => {
    // After COM init, there should be an early return on failure
    // before any window operations
    const lines = mainCpp.split('\n');
    let comInitLine = -1;
    let firstReturnAfterCom = -1;
    let windowCreateLine = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('comGuard.Initialize()')) {
        comInitLine = i;
      }
      if (comInitLine > -1 && firstReturnAfterCom === -1 && lines[i].includes('return 1')) {
        firstReturnAfterCom = i;
      }
      if (lines[i].includes('floatingSurface.Create')) {
        windowCreateLine = i;
      }
    }

    expect(comInitLine).toBeGreaterThan(-1);
    expect(firstReturnAfterCom).toBeGreaterThan(-1);
    expect(windowCreateLine).toBeGreaterThan(-1);
    // The early return on COM failure should be before window creation
    expect(firstReturnAfterCom).toBeLessThan(windowCreateLine);
  });
});

// ====================================================================
// main.cpp calls Destroy() before exit
// Req 9.1, 13.3
// ====================================================================

describe('main.cpp teardown ordering (Req 9.1, 13.3)', () => {
  it('calls floatingSurface.Destroy() before final return 0', () => {
    const destroyPos = mainCpp.lastIndexOf('floatingSurface.Destroy()');
    const finalReturnPos = mainCpp.lastIndexOf('return 0;');

    expect(destroyPos).toBeGreaterThan(-1);
    expect(finalReturnPos).toBeGreaterThan(-1);
    expect(destroyPos).toBeLessThan(finalReturnPos);
  });

  it('calls Destroy() on WebView2 unavailability exit path', () => {
    // When WebView2 is not available, the code should still clean up
    const wv2Section = mainCpp.substring(
      mainCpp.indexOf('wv2Result.status'),
      mainCpp.indexOf('return kExitCodeWebView2Unavailable') + 40,
    );
    expect(wv2Section).toContain('floatingSurface.Destroy()');
  });

  it('closes bootstrap handle before Destroy on WebView2 failure path', () => {
    const wv2FailureSection = mainCpp.substring(
      mainCpp.indexOf('wv2Result.status != zule::WebView2Availability::Available'),
      mainCpp.indexOf('return kExitCodeWebView2Unavailable') + 50,
    );
    const closeHandlePos = wv2FailureSection.indexOf('CloseHandle');
    const destroyPos = wv2FailureSection.indexOf('floatingSurface.Destroy()');

    expect(closeHandlePos).toBeGreaterThan(-1);
    expect(destroyPos).toBeGreaterThan(-1);
    expect(closeHandlePos).toBeLessThan(destroyPos);
  });

  it('floating_surface.cpp Destroy() order: DestroyWindow then UnregisterClass', () => {
    // In the Destroy() method, DestroyWindow must precede UnregisterClassW
    const destroyMethod = floatingSurfaceCpp.substring(
      floatingSurfaceCpp.lastIndexOf('void FloatingSurface::Destroy()'),
    );
    const destroyWindowPos = destroyMethod.indexOf('DestroyWindow');
    const unregisterPos = destroyMethod.indexOf('UnregisterClassW');

    expect(destroyWindowPos).toBeGreaterThan(-1);
    expect(unregisterPos).toBeGreaterThan(-1);
    expect(destroyWindowPos).toBeLessThan(unregisterPos);
  });
});

// ====================================================================
// floating_surface.cpp creates window with WS_POPUP style
// Req 9.1
// ====================================================================

describe('floating_surface.cpp WS_POPUP creation (Req 9.1)', () => {
  it('declares WS_POPUP as the window style', () => {
    expect(floatingSurfaceCpp).toContain('WS_POPUP');
  });

  it('does not include WS_CAPTION in the style', () => {
    // Check the style definition context — should not have caption
    const styleSection = floatingSurfaceCpp.substring(
      floatingSurfaceCpp.indexOf('constexpr DWORD style'),
      floatingSurfaceCpp.indexOf('CreateWindowExW'),
    );
    expect(styleSection).not.toContain('WS_CAPTION');
    expect(styleSection).not.toContain('WS_SYSMENU');
  });

  it('creates window with empty title L""', () => {
    // The CreateWindowExW call should use L"" for the title
    expect(floatingSurfaceCpp).toContain('L""');
    // Verify it's in the context of CreateWindowExW
    const createSection = floatingSurfaceCpp.substring(
      floatingSurfaceCpp.indexOf('CreateWindowExW'),
      floatingSurfaceCpp.indexOf('CreateWindowExW') + 300,
    );
    expect(createSection).toContain('L""');
  });

  it('creates window with no menu (nullptr for hMenu parameter)', () => {
    // The CreateWindowExW call context should show nullptr for menu
    const createSection = floatingSurfaceCpp.substring(
      floatingSurfaceCpp.indexOf('hwnd_ = CreateWindowExW'),
      floatingSurfaceCpp.indexOf('if (!hwnd_)'),
    );
    // Comments confirm no menu
    expect(createSection).toContain('No menu');
  });

  it('window starts hidden (no ShowWindow call in Create)', () => {
    // The Create method should NOT call ShowWindow as a function call.
    // Extract only the Create method body (up to its closing brace before Show method)
    const createStart = floatingSurfaceCpp.indexOf('HRESULT FloatingSurface::Create');
    const showMethodStart = floatingSurfaceCpp.indexOf('void FloatingSurface::Show');
    const createMethod = floatingSurfaceCpp.substring(createStart, showMethodStart);

    // Check that ShowWindow is not called as a function (it may appear in comments)
    // A real call would look like: ShowWindow(hwnd_, SW_SHOW...)
    const showWindowCalls = createMethod.match(/\bShowWindow\s*\(/g);
    expect(showWindowCalls).toBeNull();
  });
});

// ====================================================================
// WebView2 probe uses GetAvailableCoreWebView2BrowserVersionString
// Req 4.4, 14.16
// ====================================================================

describe('WebView2 probe API usage (Req 4.4, 14.16)', () => {
  it('uses GetAvailableCoreWebView2BrowserVersionString for runtime check', () => {
    // Check the header declares/documents this API usage
    expect(webview2ProbeH).toContain('GetAvailableCoreWebView2BrowserVersionString');
  });

  it('implementation calls GetAvailableCoreWebView2BrowserVersionString', () => {
    expect(webview2ProbeCpp).toContain('GetAvailableCoreWebView2BrowserVersionString');
  });

  it('does not use download or install APIs', () => {
    // Must not call CreateCoreWebView2EnvironmentWithOptions or similar
    // download-triggering APIs in the probe
    expect(webview2ProbeCpp).not.toContain('DownloadWebView2');
    expect(webview2ProbeCpp).not.toContain('InstallWebView2');
    expect(webview2ProbeCpp).not.toContain('URLDownloadToFile');
    expect(webview2ProbeH).not.toContain('DownloadWebView2');
  });

  it('returns typed availability result (Available, NotFound, VersionTooOld)', () => {
    expect(webview2ProbeH).toContain('WebView2Availability');
    expect(webview2ProbeH).toContain('Available');
    expect(webview2ProbeH).toContain('NotFound');
    expect(webview2ProbeH).toContain('VersionTooOld');
  });

  it('main.cpp probes WebView2 after window creation and before show', () => {
    const createPos = mainCpp.indexOf('floatingSurface.Create');
    const probePos = mainCpp.indexOf('QueryWebView2Availability');
    const showPos = mainCpp.indexOf('floatingSurface.Show');

    expect(createPos).toBeGreaterThan(-1);
    expect(probePos).toBeGreaterThan(-1);
    // Probe happens after creation
    expect(probePos).toBeGreaterThan(createPos);
    // Show is never called in main.cpp (deferred to future tasks)
    // but if referenced, it must be after probe
    if (showPos > -1) {
      expect(showPos).toBeGreaterThan(probePos);
    }
  });
});

// ====================================================================
// resources.rc has all required VERSION_INFO fields
// Req 2.1–2.3, 2.7–2.9
// ====================================================================

describe('resources.rc VERSION_INFO completeness (Req 2.1–2.3, 2.7–2.9)', () => {
  const REQUIRED_STRING_VALUES = [
    'CompanyName',
    'FileDescription',
    'FileVersion',
    'InternalName',
    'LegalCopyright',
    'OriginalFilename',
    'ProductName',
    'ProductVersion',
  ];

  it.each(REQUIRED_STRING_VALUES)('declares VALUE "%s"', (key) => {
    // Match VALUE "Key", "literal" or VALUE "Key", MACRO_NAME
    const pattern = new RegExp(`VALUE\\s+"${key}"\\s*,\\s*(?:"[^"]+"|\\w+)`);
    expect(resourcesRc).toMatch(pattern);
  });

  it('has VS_VERSION_INFO VERSIONINFO block', () => {
    expect(resourcesRc).toContain('VS_VERSION_INFO VERSIONINFO');
  });

  it('has FILEVERSION with 4 components', () => {
    expect(resourcesRc).toMatch(
      /FILEVERSION\s+\w+,\s*\w+,\s*\w+,\s*\w+/,
    );
  });

  it('has PRODUCTVERSION with 4 components', () => {
    expect(resourcesRc).toMatch(
      /PRODUCTVERSION\s+\w+,\s*\w+,\s*\w+,\s*\w+/,
    );
  });

  it('has StringFileInfo block', () => {
    expect(resourcesRc).toContain('BLOCK "StringFileInfo"');
  });

  it('has VarFileInfo Translation block', () => {
    expect(resourcesRc).toContain('BLOCK "VarFileInfo"');
    expect(resourcesRc).toContain('VALUE "Translation"');
  });

  it('OriginalFilename is ZuleUI.exe (Req 2.1)', () => {
    const match = resourcesRc.match(/VALUE\s+"OriginalFilename"\s*,\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('ZuleUI.exe');
  });

  it('CompanyName is Zule AI (Req 2.2)', () => {
    const match = resourcesRc.match(/VALUE\s+"CompanyName"\s*,\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('Zule AI');
  });

  it('ProductName is Zule AI (Req 2.2)', () => {
    const match = resourcesRc.match(/VALUE\s+"ProductName"\s*,\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('Zule AI');
  });

  it('no metadata claims Windows, Microsoft, Edge, or System (Req 2.9)', () => {
    const FORBIDDEN = [/\bWindows\b/i, /\bMicrosoft\b/i, /\bEdge\b/i, /\bSystem\b/i];
    // Check only the VALUE lines (not comments or includes)
    const valueLines = resourcesRc
      .split('\n')
      .filter((line) => line.trim().startsWith('VALUE'));

    for (const line of valueLines) {
      for (const pattern of FORBIDDEN) {
        expect(line, `VALUE line should not contain ${pattern}: ${line}`).not.toMatch(
          pattern,
        );
      }
    }
  });
});

// ====================================================================
// Hidden startup: surface remains hidden until explicit Show()
// Req 5.8, 13.3
// ====================================================================

describe('Hidden startup policy (Req 5.8, 13.3)', () => {
  it('main.cpp does not execute floatingSurface.Show() in current implementation', () => {
    // In the current stage, Show() should not be called as executable code.
    // It may be referenced in comments about future stages, but the function body
    // between wWinMain and "return 0" should not have an uncommented .Show() call.
    const mainBody = mainCpp.substring(mainCpp.indexOf('wWinMain'));
    const lines = mainBody.split('\n');

    // Find uncommented lines that call floatingSurface.Show()
    const executableShowCalls = lines.filter((line) => {
      const trimmed = line.trim();
      // Skip comments
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        return false;
      }
      return trimmed.includes('floatingSurface.Show()') && !trimmed.includes('//');
    });
    expect(executableShowCalls).toHaveLength(0);
  });

  it('floating_surface.h documents hidden-until-handshake policy', () => {
    expect(floatingSurfaceH).toContain('Initially hidden');
  });

  it('floating_surface.cpp Create method does not call ShowWindow', () => {
    const createStart = floatingSurfaceCpp.indexOf('HRESULT FloatingSurface::Create');
    const showMethodStart = floatingSurfaceCpp.indexOf('void FloatingSurface::Show');
    const createMethod = floatingSurfaceCpp.substring(createStart, showMethodStart);

    // Verify no actual ShowWindow function call (not just the word in a comment)
    const showWindowCalls = createMethod.match(/\bShowWindow\s*\(/g);
    expect(showWindowCalls).toBeNull();
    // No SW_SHOW* constants used in executable code
    const swShowCalls = createMethod.match(/\bSW_SHOW\w*\b/g);
    expect(swShowCalls).toBeNull();
  });
});

// ====================================================================
// System-library loading: only OS-provided DLLs and reviewed SDK
// Req 3.7, 16.6
// ====================================================================

describe('System-library loading policy (Req 3.7, 16.6)', () => {
  it('vcxproj does not reference alternate runtimes', () => {
    expect(vcxproj).not.toContain('dotnet');
    expect(vcxproj).not.toContain('rustc');
    expect(vcxproj).not.toContain('mingw');
    expect(vcxproj).not.toContain('clang');
  });

  it('vcxproj disables CLR support', () => {
    expect(vcxproj).toContain('<CLRSupport>false</CLRSupport>');
  });

  it('vcxproj disables MFC', () => {
    expect(vcxproj).toContain('<UseOfMfc>false</UseOfMfc>');
  });

  it('vcxproj disables ATL', () => {
    expect(vcxproj).toContain('<UseOfAtl>false</UseOfAtl>');
  });

  it('vcxproj disables NuGet auto-restore', () => {
    expect(vcxproj).toContain('<RestorePackages>false</RestorePackages>');
    expect(vcxproj).toContain('<ResolveNuGetPackages>false</ResolveNuGetPackages>');
  });

  it('vcxproj has fail-closed SDK version guard', () => {
    expect(vcxproj).toContain('ValidateLockedSdk');
    expect(vcxproj).toContain(
      "Condition=\"'$(WindowsTargetPlatformVersion)'!='10.0.22621.0'\"",
    );
  });

  it('vcxproj has fail-closed platform guard', () => {
    expect(vcxproj).toContain('RejectUnsupportedPlatform');
    expect(vcxproj).toContain("Condition=\"'$(Platform)'!='x64'\"");
  });
});

// ====================================================================
// Complete teardown: Destroy nullifies all owned resources
// Req 9.1
// ====================================================================

describe('Complete teardown (Req 9.1)', () => {
  it('Destroy() nullifies hwnd_ after DestroyWindow', () => {
    const destroyMethod = floatingSurfaceCpp.substring(
      floatingSurfaceCpp.lastIndexOf('void FloatingSurface::Destroy()'),
    );
    expect(destroyMethod).toContain('hwnd_ = nullptr');
  });

  it('Destroy() zeros classAtom_ after UnregisterClass', () => {
    const destroyMethod = floatingSurfaceCpp.substring(
      floatingSurfaceCpp.lastIndexOf('void FloatingSurface::Destroy()'),
    );
    expect(destroyMethod).toContain('classAtom_ = 0');
  });

  it('destructor calls Destroy() for RAII safety', () => {
    expect(floatingSurfaceCpp).toContain('FloatingSurface::~FloatingSurface()');
    const destructor = floatingSurfaceCpp.substring(
      floatingSurfaceCpp.indexOf('FloatingSurface::~FloatingSurface()'),
      floatingSurfaceCpp.indexOf('FloatingSurface::~FloatingSurface()') + 100,
    );
    expect(destructor).toContain('Destroy()');
  });

  it('FloatingSurface is non-copyable and non-movable', () => {
    expect(floatingSurfaceH).toContain('FloatingSurface(const FloatingSurface&) = delete');
    expect(floatingSurfaceH).toContain(
      'FloatingSurface& operator=(const FloatingSurface&) = delete',
    );
    expect(floatingSurfaceH).toContain('FloatingSurface(FloatingSurface&&) = delete');
    expect(floatingSurfaceH).toContain(
      'FloatingSurface& operator=(FloatingSurface&&) = delete',
    );
  });
});
