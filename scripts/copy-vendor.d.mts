// Ambient type declarations for `copy-vendor.mjs`. The script is plain
// JavaScript so it can be invoked as `node scripts/copy-vendor.mjs`
// without a transpile step, but `vite.config.ts` (compiled under
// `tsconfig.node.json` with `verbatimModuleSyntax`) needs an explicit
// declaration to resolve the import.

export interface CopyVendorEntry {
  /** Absolute path of the destination file (or directory mirror). */
  to: string;
  /** Number of files actually written for this mapping. */
  copied: number;
}

export interface CopyVendorOptions {
  /** Suppress the human-readable summary on stdout. */
  silent?: boolean;
}

export function copyVendorAssets(opts?: CopyVendorOptions): CopyVendorEntry[];
