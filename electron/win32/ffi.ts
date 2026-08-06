// ============================================
// Zule AI — Shared Win32 FFI Surface
// ============================================
//
// Centralizes koffi loading, DLL bindings, struct definitions, and memory
// helpers for all Win32 interop in the Electron main process.
//
// Design contracts:
//   - Single load-once semantics with permanent failure latch
//   - Never throws to callers; returns null on failure or non-Windows
//   - Loads koffi lazily via createRequire so the bundler treats it as external
//   - No new runtime dependencies beyond koffi + OS-provided DLLs
//
// Requirements: 10.1, 10.3, 10.4

// ── Types ────────────────────────────────────────────────────────────────────

/** Opaque pointer type for HWND and other Win32 handles. */
export type HwndPtr = unknown;

/**
 * HWND accepted at Electron/Win32 boundaries. Electron returns a Buffer whose
 * bytes contain the HWND value; koffi itself returns raw pointer values.
 */
export type HwndInput = Buffer | HwndPtr;

/** JS function matching the WNDPROC signature. */
export type WndProcJs = (hwnd: HwndPtr, msg: number, wParam: bigint | number, lParam: bigint | number) => bigint | number;

/** JS function matching the WNDENUMPROC callback signature. */
export type WndEnumProcJs = (hwnd: HwndPtr, lParam: bigint | number) => boolean | number;

/** user32.dll function bindings — Stage A */
export interface User32Bindings {
  RegisterClassExW: (cls: unknown) => number;
  UnregisterClassW: (className: string, hInstance: HwndPtr) => boolean;
  CreateWindowExW: (
    exStyle: number,
    className: string,
    windowName: string,
    style: number,
    x: number,
    y: number,
    w: number,
    h: number,
    parent: HwndPtr,
    menu: HwndPtr,
    instance: HwndPtr,
    param: HwndPtr,
  ) => HwndPtr;
  DestroyWindow: (hwnd: HwndPtr) => boolean;
  SetParent: (child: HwndPtr, newParent: HwndPtr) => HwndPtr;
  GetParent: (hwnd: HwndPtr) => HwndPtr;
  GetWindowLongPtrW: (hwnd: HwndPtr, index: number) => number;
  SetWindowLongPtrW: (hwnd: HwndPtr, index: number, newLong: number) => number;
  SetWindowPos: (
    hwnd: HwndPtr,
    insertAfter: HwndPtr,
    x: number,
    y: number,
    cx: number,
    cy: number,
    flags: number,
  ) => boolean;
  ShowWindow: (hwnd: HwndPtr, cmdShow: number) => boolean;
  DefWindowProcW: (hwnd: HwndPtr, msg: number, wParam: number, lParam: number) => number;
  GetClientRect: (hwnd: HwndPtr, rect: unknown) => boolean;
  GetWindowRect: (hwnd: HwndPtr, rect: unknown) => boolean;
  GetClassNameW: (hwnd: HwndPtr, buf: unknown, maxCount: number) => number;
  LoadCursorW: (instance: HwndPtr, cursorName: HwndPtr) => HwndPtr;
  SetWindowDisplayAffinity: (hwnd: HwndPtr, affinity: number) => boolean;
  GetWindowDisplayAffinity: (hwnd: HwndPtr, affinityOut: unknown) => boolean;
  EnumWindows: (callback: HwndPtr, lParam: bigint | number) => boolean;
  GetWindowThreadProcessId: (hwnd: HwndPtr, processIdOut: unknown) => number;
  // Stage B user32 additions (lazily bound via gdi32.ensureLoaded):
  UpdateLayeredWindow?: (hwnd: HwndPtr, hdcDst: HwndPtr, pptDst: unknown, psize: unknown, hdcSrc: HwndPtr, pptSrc: unknown, crKey: number, pblend: unknown, flags: number) => boolean;
  GetDC?: (hwnd: HwndPtr) => HwndPtr;
  ReleaseDC?: (hwnd: HwndPtr, hdc: HwndPtr) => number;
  SetCapture?: (hwnd: HwndPtr) => HwndPtr;
  ReleaseCapture?: () => boolean;
  ScreenToClient?: (hwnd: HwndPtr, pt: unknown) => boolean;
  ClientToScreen?: (hwnd: HwndPtr, pt: unknown) => boolean;
  TrackMouseEvent?: (ev: unknown) => boolean;
}

/** gdi32.dll function bindings — Stage B (lazily sub-loaded) */
export interface Gdi32Bindings {
  loaded: boolean;
  /** Lazily load gdi32 + Stage B user32 bindings. Returns true on success. */
  ensureLoaded(): boolean;
  // Stage B gdi32 functions (only available after ensureLoaded)
  CreateCompatibleDC?: (hdc: HwndPtr) => HwndPtr;
  CreateDIBSection?: (hdc: HwndPtr, pbmi: unknown, usage: number, bits: unknown, section: HwndPtr, offset: number) => HwndPtr;
  SelectObject?: (hdc: HwndPtr, obj: HwndPtr) => HwndPtr;
  DeleteObject?: (obj: HwndPtr) => boolean;
  DeleteDC?: (hdc: HwndPtr) => boolean;
}

/** dwmapi.dll function bindings */
export interface DwmapiBindings {
  DwmSetWindowAttribute: (hwnd: HwndPtr, attr: number, value: unknown, size: number) => number;
}

/** kernel32.dll function bindings */
export interface Kernel32Bindings {
  GetModuleHandleW: (name: string | null) => HwndPtr;
  /** Resolves an ANSI export name to its native function pointer. */
  GetProcAddress: (module: HwndPtr, symbol: string) => HwndPtr;
  GetLastError: () => number;
}

/** Struct type constructors/definitions exposed through the FFI surface */
export interface Win32StructTypes {
  POINT: string;
  SIZE: string;
  RECT: string;
  BLENDFUNCTION: string;
  WNDPROC: string;
  WNDCLASSEXW: string;
  // Stage B structs (available after gdi32.ensureLoaded)
  BITMAPINFOHEADER: string;
  BITMAPINFO: string;
  TRACKMOUSEEVENT: string;
}

/** The complete Win32 FFI surface. */
export interface Win32Ffi {
  readonly user32: User32Bindings;
  readonly gdi32: Gdi32Bindings;
  readonly dwmapi: DwmapiBindings;
  readonly kernel32: Kernel32Bindings;
  readonly types: Win32StructTypes;
  registerCallback(fn: WndProcJs, protoName: 'WNDPROC'): HwndPtr;
  registerEnumCallback(fn: WndEnumProcJs): HwndPtr;
  unregisterCallback(ptr: HwndPtr): void;
  alloc(type: string, value?: unknown): unknown;
  decode(ptr: unknown, type: string): unknown;
  procAddress(module: 'user32.dll', symbol: string): HwndPtr | null;
}

// ── State ────────────────────────────────────────────────────────────────────

let ffiInstance: Win32Ffi | null = null;
let ffiLoaded = false;
let ffiLoadFailed = false;

// ── Platform Guard ───────────────────────────────────────────────────────────

/**
 * Returns true when running on Windows. Use this to skip Win32 code paths
 * on other platforms without loading koffi.
 */
export function isWin32(): boolean {
  return process.platform === 'win32';
}

/**
 * Convert Electron's native-window-handle Buffer into the raw HWND value that
 * koffi expects for a `void *` argument. Passing the Buffer itself would pass
 * the address of the Buffer's storage, not the pointer value stored in it.
 *
 * Raw koffi pointers are returned unchanged, making this safe and idempotent
 * at shared boundaries. HWND bytes are little-endian on supported Windows
 * architectures. BigInt is used for both widths so 64-bit handles are never
 * rounded through a JavaScript Number.
 */
export function normalizeHwnd(hwnd: HwndInput): HwndPtr {
  if (!Buffer.isBuffer(hwnd)) return hwnd;

  if (hwnd.byteLength === 8) {
    return hwnd.readBigUInt64LE(0);
  }
  if (hwnd.byteLength === 4) {
    return BigInt(hwnd.readUInt32LE(0));
  }

  throw new RangeError(
    `Invalid Electron HWND buffer length ${hwnd.byteLength}; expected 4 or 8 bytes`,
  );
}

/**
 * Resolve a named DLL export through the documented Win32 loader APIs.
 * GetProcAddress takes an ANSI symbol name and returns the raw native pointer;
 * the function is never invoked while resolving it.
 */
export function resolveProcAddress(
  kernel32: Kernel32Bindings,
  moduleName: 'user32.dll',
  symbol: string,
): HwndPtr | null {
  if (!symbol) return null;

  try {
    const moduleHandle = kernel32.GetModuleHandleW(moduleName);
    if (!moduleHandle) return null;

    return kernel32.GetProcAddress(moduleHandle, symbol) || null;
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the shared Win32 FFI surface. Returns null on non-Windows or if koffi
 * cannot be loaded. Uses load-once semantics with a permanent failure latch:
 * after the first failure, all subsequent calls return null immediately
 * without retrying.
 */
export function getFfi(): Win32Ffi | null {
  if (ffiLoaded) return ffiInstance;
  if (ffiLoadFailed) return null;

  if (!isWin32()) {
    ffiLoadFailed = true;
    return null;
  }

  try {
    ffiInstance = loadKoffiSurface();
    ffiLoaded = true;
    console.log('[Win32/FFI] Bindings loaded successfully');
    return ffiInstance;
  } catch (err: unknown) {
    ffiLoadFailed = true;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Win32/FFI] Load failed (Layer 0 fallback): ${msg}`);
    return null;
  }
}

// ── Internal: koffi loading ──────────────────────────────────────────────────

function loadKoffiSurface(): Win32Ffi {
  // Dynamic import via createRequire so the bundler leaves koffi external.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRequire } = require('node:module') as typeof import('node:module');
  const koffi = createRequire(import.meta.url)('koffi') as any;

  // ── Struct definitions ──────────────────────────────────────────────────

  const POINT = koffi.struct('POINT', {
    x: 'int32',
    y: 'int32',
  });

  const SIZE = koffi.struct('SIZE', {
    cx: 'int32',
    cy: 'int32',
  });

  const RECT = koffi.struct('RECT', {
    left: 'int32',
    top: 'int32',
    right: 'int32',
    bottom: 'int32',
  });

  const BLENDFUNCTION = koffi.struct('BLENDFUNCTION', {
    BlendOp: 'uint8',
    BlendFlags: 'uint8',
    SourceConstantAlpha: 'uint8',
    AlphaFormat: 'uint8',
  });

  // WNDPROC callback prototype: LRESULT (HWND, UINT, WPARAM, LPARAM)
  const WNDPROC = koffi.proto('int64 WNDPROC(void *hwnd, uint32_t msg, int64 wParam, int64 lParam)');

  // WNDENUMPROC callback prototype: BOOL CALLBACK (HWND, LPARAM)
  const WNDENUMPROC = koffi.proto('bool WNDENUMPROC(void *hwnd, int64 lParam)');

  const WNDCLASSEXW = koffi.struct('WNDCLASSEXW', {
    cbSize: 'uint32',
    style: 'uint32',
    lpfnWndProc: 'WNDPROC *',
    cbClsExtra: 'int32',
    cbWndExtra: 'int32',
    hInstance: 'void *',
    hIcon: 'void *',
    hCursor: 'void *',
    hbrBackground: 'void *',
    lpszMenuName: 'str16',
    lpszClassName: 'str16',
    hIconSm: 'void *',
  });

  // ── DLL loading ─────────────────────────────────────────────────────────

  const user32Lib = koffi.load('user32.dll');
  const kernel32Lib = koffi.load('kernel32.dll');
  const dwmapiLib = koffi.load('dwmapi.dll');

  // ── user32.dll bindings ─────────────────────────────────────────────────

  const user32: User32Bindings = {
    RegisterClassExW: user32Lib.func(
      'uint16 RegisterClassExW(WNDCLASSEXW *cls)',
    ),
    UnregisterClassW: user32Lib.func(
      'bool UnregisterClassW(str16 className, void *hInstance)',
    ),
    CreateWindowExW: user32Lib.func(
      'void *CreateWindowExW(uint32_t exStyle, str16 className, str16 windowName, uint32_t style, int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)',
    ),
    DestroyWindow: user32Lib.func('bool DestroyWindow(void *hwnd)'),
    SetParent: user32Lib.func('void *SetParent(void *child, void *newParent)'),
    GetParent: user32Lib.func('void *GetParent(void *hwnd)'),
    GetWindowLongPtrW: user32Lib.func('int64 GetWindowLongPtrW(void *hwnd, int index)'),
    SetWindowLongPtrW: user32Lib.func('int64 SetWindowLongPtrW(void *hwnd, int index, int64 newLong)'),
    SetWindowPos: user32Lib.func(
      'bool SetWindowPos(void *hwnd, void *insertAfter, int x, int y, int cx, int cy, uint32_t flags)',
    ),
    ShowWindow: user32Lib.func('bool ShowWindow(void *hwnd, int cmdShow)'),
    DefWindowProcW: user32Lib.func('int64 DefWindowProcW(void *hwnd, uint32_t msg, int64 wParam, int64 lParam)'),
    GetClientRect: user32Lib.func('bool GetClientRect(void *hwnd, _Out_ RECT *rect)'),
    GetWindowRect: user32Lib.func('bool GetWindowRect(void *hwnd, _Out_ RECT *rect)'),
    GetClassNameW: user32Lib.func('int GetClassNameW(void *hwnd, _Out_ str16 buf, int maxCount)'),
    LoadCursorW: user32Lib.func('void *LoadCursorW(void *instance, void *cursorName)'),
    SetWindowDisplayAffinity: user32Lib.func('bool SetWindowDisplayAffinity(void *hwnd, uint32_t affinity)'),
    GetWindowDisplayAffinity: user32Lib.func('bool GetWindowDisplayAffinity(void *hwnd, _Out_ uint32_t *affinity)'),
    EnumWindows: user32Lib.func('bool EnumWindows(WNDENUMPROC *callback, int64 lParam)'),
    GetWindowThreadProcessId: user32Lib.func('uint32_t GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *processId)'),
  };

  // ── kernel32.dll bindings ───────────────────────────────────────────────

  const kernel32: Kernel32Bindings = {
    GetModuleHandleW: kernel32Lib.func('void *GetModuleHandleW(str16 name)'),
    // GetProcAddress's symbol parameter is LPCSTR (ANSI), not UTF-16. FARPROC
    // is represented as void* so koffi returns the pointer-safe BigInt value.
    GetProcAddress: kernel32Lib.func(
      'void *__stdcall GetProcAddress(void *module, str symbol)',
    ),
    GetLastError: kernel32Lib.func('uint32_t GetLastError()'),
  };

  // ── dwmapi.dll bindings ─────────────────────────────────────────────────

  const dwmapi: DwmapiBindings = {
    DwmSetWindowAttribute: dwmapiLib.func(
      'int32_t DwmSetWindowAttribute(void *hwnd, uint32_t attr, void *value, uint32_t size)',
    ),
  };

  // ── gdi32.dll (lazy, Stage B only) ─────────────────────────────────────

  let gdi32LoadAttempted = false;

  const gdi32: Gdi32Bindings = {
    loaded: false,
    ensureLoaded(): boolean {
      // Already loaded or already failed — return latched result
      if (gdi32.loaded) return true;
      if (gdi32LoadAttempted) return false;
      gdi32LoadAttempted = true;

      try {
        const gdi32Lib = koffi.load('gdi32.dll');

        // ── Stage B struct definitions ────────────────────────────────────
        koffi.struct('BITMAPINFOHEADER', {
          biSize: 'uint32',
          biWidth: 'int32',
          biHeight: 'int32',
          biPlanes: 'uint16',
          biBitCount: 'uint16',
          biCompression: 'uint32',
          biSizeImage: 'uint32',
          biXPelsPerMeter: 'int32',
          biYPelsPerMeter: 'int32',
          biClrUsed: 'uint32',
          biClrImportant: 'uint32',
        });

        koffi.struct('BITMAPINFO', {
          bmiHeader: 'BITMAPINFOHEADER',
          bmiColors: koffi.array('uint32', 1),
        });

        koffi.struct('TRACKMOUSEEVENT', {
          cbSize: 'uint32',
          dwFlags: 'uint32',
          hwndTrack: 'void *',
          dwHoverTime: 'uint32',
        });

        // ── gdi32.dll bindings ────────────────────────────────────────────
        gdi32.CreateCompatibleDC = gdi32Lib.func('void *CreateCompatibleDC(void *hdc)');
        gdi32.CreateDIBSection = gdi32Lib.func(
          'void *CreateDIBSection(void *hdc, BITMAPINFO *pbmi, uint32_t usage, ' +
          '_Out_ void **bits, void *section, uint32_t offset)',
        );
        gdi32.SelectObject = gdi32Lib.func('void *SelectObject(void *hdc, void *obj)');
        gdi32.DeleteObject = gdi32Lib.func('bool DeleteObject(void *obj)');
        gdi32.DeleteDC = gdi32Lib.func('bool DeleteDC(void *hdc)');

        // ── Stage B user32 bindings ───────────────────────────────────────
        user32.UpdateLayeredWindow = user32Lib.func(
          'bool UpdateLayeredWindow(void *hwnd, void *hdcDst, POINT *pptDst, SIZE *psize, ' +
          'void *hdcSrc, POINT *pptSrc, uint32_t crKey, BLENDFUNCTION *pblend, uint32_t flags)',
        );
        user32.GetDC = user32Lib.func('void *GetDC(void *hwnd)');
        user32.ReleaseDC = user32Lib.func('int ReleaseDC(void *hwnd, void *hdc)');
        user32.SetCapture = user32Lib.func('void *SetCapture(void *hwnd)');
        user32.ReleaseCapture = user32Lib.func('bool ReleaseCapture()');
        user32.ScreenToClient = user32Lib.func('bool ScreenToClient(void *hwnd, POINT *pt)');
        user32.ClientToScreen = user32Lib.func('bool ClientToScreen(void *hwnd, POINT *pt)');
        user32.TrackMouseEvent = user32Lib.func('bool TrackMouseEvent(TRACKMOUSEEVENT *ev)');

        gdi32.loaded = true;
        console.log('[Win32/FFI] Stage B (gdi32 + user32 extensions) loaded successfully');
        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Win32/FFI] Stage B gdi32 sub-load failed: ${msg}`);
        return false;
      }
    },
  };

  // ── Struct type names (for alloc/decode callers) ────────────────────────

  const types: Win32StructTypes = {
    POINT: 'POINT',
    SIZE: 'SIZE',
    RECT: 'RECT',
    BLENDFUNCTION: 'BLENDFUNCTION',
    WNDPROC: 'WNDPROC',
    WNDCLASSEXW: 'WNDCLASSEXW',
    // Stage B (available after gdi32.ensureLoaded())
    BITMAPINFOHEADER: 'BITMAPINFOHEADER',
    BITMAPINFO: 'BITMAPINFO',
    TRACKMOUSEEVENT: 'TRACKMOUSEEVENT',
  };

  // ── Helpers ─────────────────────────────────────────────────────────────

  function registerCallback(fn: WndProcJs, _protoName: 'WNDPROC'): HwndPtr {
    return koffi.register(fn, koffi.pointer(WNDPROC));
  }

  function registerEnumCallback(fn: WndEnumProcJs): HwndPtr {
    return koffi.register(fn, koffi.pointer(WNDENUMPROC));
  }

  function unregisterCallback(ptr: HwndPtr): void {
    koffi.unregister(ptr);
  }

  function alloc(type: string, value?: unknown): unknown {
    // koffi.alloc(type, length) takes an element count, not an initial value.
    // Always allocate one value, then initialize it explicitly when requested.
    const ptr = koffi.alloc(type, 1);
    if (value !== undefined) {
      koffi.encode(ptr, type, value);
    }
    return ptr;
  }

  function decode(ptr: unknown, type: string): unknown {
    return koffi.decode(ptr, type);
  }

  function procAddress(module: 'user32.dll', symbol: string): HwndPtr | null {
    return resolveProcAddress(kernel32, module, symbol);
  }

  // Keep references to prevent GC of koffi structs
  void POINT;
  void SIZE;
  void RECT;
  void BLENDFUNCTION;
  void WNDPROC;
  void WNDENUMPROC;
  void WNDCLASSEXW;

  return {
    user32,
    gdi32,
    dwmapi,
    kernel32,
    types,
    registerCallback,
    registerEnumCallback,
    unregisterCallback,
    alloc,
    decode,
    procAddress,
  };
}
