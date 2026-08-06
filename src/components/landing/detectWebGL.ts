/**
 * Synchronously probes whether the current browser environment can create a
 * WebGL rendering context. The result is used by `LandingPage` to decide
 * whether to lazy-mount `Hero3DCanvas`.
 *
 * Returns `false` when:
 *   - `window` is unavailable (SSR / non-browser runtime)
 *   - none of `webgl2`, `webgl`, or `experimental-webgl` produce a context
 *   - `canvas.getContext` throws (some sandboxed environments do this)
 *
 * The function never throws.
 */
export function detectWebGL(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ||
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl");
    return gl != null;
  } catch {
    return false;
  }
}
