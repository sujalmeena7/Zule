/**
 * Low-end GPU detection for the landing page Hero 3D canvas.
 *
 * Combines two signals to decide whether the host environment should run
 * at a reduced device pixel ratio:
 *
 * 1. A heuristic on the reported `devicePixelRatio` and
 *    `navigator.hardwareConcurrency` (per the Low_End_GPU glossary
 *    definition in requirements.md).
 * 2. A check of the WebGL renderer string for known software-renderer
 *    substrings (`SwiftShader`, `llvmpipe`, `software`), exposed via the
 *    `WEBGL_debug_renderer_info` extension when available.
 *
 * Either signal is sufficient to flag the environment as low-end.
 *
 * Both this function and {@link computeDprCap} are pure with respect to
 * their inputs — the only side effect is creating a throwaway `<canvas>`
 * element to probe the WebGL renderer, which is wrapped in try/catch so
 * environments that block context creation simply return `false`.
 *
 * Requirements: 2.4
 */
export function detectLowEndGpu(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  const dpr = window.devicePixelRatio ?? 1;
  const conc = navigator.hardwareConcurrency ?? 8;
  const ratioHint = dpr > 1 && conc <= 4;

  // Software-rendered WebGL contexts (Chrome's SwiftShader fallback,
  // Mesa's llvmpipe, and other software backends) consistently present
  // themselves via the UNMASKED_RENDERER_WEBGL parameter.
  let software = false;
  try {
    if (typeof document !== 'undefined') {
      const gl = document.createElement('canvas').getContext('webgl');
      const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
      const renderer = dbg ? gl?.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
      software =
        typeof renderer === 'string' &&
        /SwiftShader|llvmpipe|software/i.test(renderer);
    }
  } catch {
    // Probe failed — treat as "no software renderer signal" and let the
    // ratio heuristic decide.
  }

  return ratioHint || software;
}

/**
 * Computes the `dpr` cap to apply to the Hero 3D canvas.
 *
 * Returns `1` when {@link detectLowEndGpu} reports a low-end environment
 * (Requirement 2.4), otherwise clamps the supplied `dpr` at `2` so the
 * canvas never renders at more than 2× regardless of the host's pixel
 * ratio.
 *
 * Requirements: 2.4
 */
export function computeDprCap(lowEndGpu: boolean, dpr: number): number {
  if (lowEndGpu) return 1;
  return Math.min(dpr, 2);
}
