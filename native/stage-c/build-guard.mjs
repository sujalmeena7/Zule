/**
 * Stage C Build Guard — Fail-closed gate for native build targets.
 *
 * This script runs the toolchain probe and fails the process if the
 * toolchain is UNAVAILABLE. Used by `stage-c:build`, `stage-c:package`,
 * and `stage-c:production-enable` npm targets.
 *
 * Exit codes:
 *   0 — Toolchain available, safe to proceed with Stage C build
 *   1 — Toolchain unavailable, Stage C target must fail closed
 *
 * Requirements: 3.5, 3.6, 3.9, 3.12
 *
 * This guard ensures:
 * - JavaScript development and Layer 0 remain unaffected (Req 3.5)
 * - Stage C native-build, packaging, and production-enablement fail when
 *   toolchain is unavailable (Req 3.6)
 * - No automatic .NET, Rust, MinGW, Clang, ad-hoc compiler,
 *   runtime-download, or SDK-download fallback (Req 3.12)
 */

import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const probePath = resolve(__dirname, 'toolchain-probe.mjs');

const targetName = process.argv[2] || 'stage-c:build';

try {
  const output = execSync(`node "${probePath}"`, {
    encoding: 'utf-8',
    timeout: 30000,
    windowsHide: true,
  });

  const result = JSON.parse(output.trim());

  if (result.status === 'AVAILABLE') {
    console.log(`[stage-c] Toolchain probe: AVAILABLE — proceeding with ${targetName}`);
    process.exit(0);
  } else {
    console.error(`[stage-c] Toolchain probe: UNAVAILABLE — ${targetName} fails closed.`);
    console.error(`[stage-c] Reason: ${result.reason || 'unknown'}`);
    console.error(`[stage-c] JavaScript development and Layer 0 remain available.`);
    console.error(`[stage-c] No fallback compiler will be used (Req 3.12).`);
    process.exit(1);
  }
} catch (err) {
  // If the probe itself fails to execute, fail closed
  console.error(`[stage-c] Toolchain probe execution failed — ${targetName} fails closed.`);
  console.error(`[stage-c] Error: ${err.message}`);
  console.error(`[stage-c] JavaScript development and Layer 0 remain available.`);
  process.exit(1);
}
