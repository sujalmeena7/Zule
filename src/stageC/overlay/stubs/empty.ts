/**
 * Stage C Overlay — Empty Stub Module
 *
 * Used by the Stage C Vite build to replace heavy/service modules that
 * are transitively imported by shared presentation components but are
 * never executed in the Stage C overlay context.
 *
 * This keeps the Stage C overlay bundle small and free of native/ML/service code.
 * Exports a Proxy-based default + named exports to satisfy any import shape.
 */

// Provide named exports that the transitive imports expect
export const pipeline = () => { throw new Error('Stage C stub: not available'); };
export const env = {};
export const AutoTokenizer = {};
export const AutoProcessor = {};

export default new Proxy({}, {
  get: () => () => { throw new Error('Stage C stub: not available'); },
});
