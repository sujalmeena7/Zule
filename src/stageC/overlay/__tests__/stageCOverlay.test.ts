/**
 * Stage C Overlay — Module Isolation Tests
 *
 * Verifies that the Stage C overlay entry point and its dependency tree
 * do NOT import any Electron IPC, service, storage, capture, or provider
 * modules. The overlay must be purely presentation + bridge.
 *
 * Requirements: 7.11–7.15, 8.1–8.7
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STAGE_C_ROOT = resolve(__dirname, '..');

/**
 * Forbidden import patterns — these modules must NEVER appear in
 * the Stage C overlay source files. They belong to App Core only.
 */
const FORBIDDEN_PATTERNS = [
  // Electron IPC and services
  /from\s+['"]\..*electron/i,
  /from\s+['"]electron['"]/,
  /require\s*\(\s*['"]electron['"]\s*\)/,
  /window\.electronAPI/,

  // Brain/service modules (AI providers, audio, capture, storage)
  /from\s+['"]\..*brain\/aiProvider/,
  /from\s+['"]\..*brain\/providers\//,
  /from\s+['"]\..*brain\/transcription\//,
  /from\s+['"]\..*brain\/speakerManager/,
  /from\s+['"]\..*brain\/contextManager/,
  /from\s+['"]\..*brain\/vectorStore/,
  /from\s+['"]\..*brain\/responseCache/,
  /from\s+['"]\..*brain\/telemetry/,
  /from\s+['"]\..*brain\/stopSession/,
  /from\s+['"]\..*brain\/questionDetector/,
  /from\s+['"]\..*brain\/sentimentAnalyzer/,
  /from\s+['"]\..*brain\/screenContextGuard/,

  // Hooks that use Electron IPC directly
  /from\s+['"]\..*hooks\/useTranscription/,
  /from\s+['"]\..*hooks\/useSystemAudioTranscription/,
  /from\s+['"]\..*hooks\/useScreenCapture/,
  /from\s+['"]\..*hooks\/useElectronBridge/,
  /from\s+['"]\..*hooks\/useCrossWindowSync/,
  /from\s+['"]\..*hooks\/useAutoUpdate/,

  // Database/storage
  /from\s+['"]\..*data\/database/,
  /from\s+['"]\..*firebase\//,

  // Context providers that depend on Electron services
  /from\s+['"]\..*context\/ZuleContext/,
  /from\s+['"]\..*context\/SubscriptionContext/,

  // Native modules
  /from\s+['"]koffi['"]/,
  /from\s+['"]hnswlib-node['"]/,
  /from\s+['"]sharp['"]/,
];

/**
 * Read all TypeScript/TSX source files in the Stage C overlay directory.
 */
function getStageCOverlayFiles(): { path: string; content: string }[] {
  const fs = await_import_fs();
  const files: { path: string; content: string }[] = [];

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') {
          walk(fullPath);
        }
      } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        files.push({ path: fullPath, content: readFileSync(fullPath, 'utf-8') });
      }
    }
  }

  walk(STAGE_C_ROOT);
  return files;
}

function await_import_fs() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:fs') as typeof import('node:fs');
}

describe('Stage C Overlay — Module Isolation', () => {
  const files = getStageCOverlayFiles();

  it('should contain at least the expected entry files', () => {
    const names = files.map((f) => f.path.replace(STAGE_C_ROOT, '').replace(/\\/g, '/'));
    expect(names).toContain('/main.tsx');
    expect(names).toContain('/StageCOverlay.tsx');
    expect(names).toContain('/bridgeAdapter.ts');
    expect(names).toContain('/types.ts');
  });

  it('should not import forbidden Electron/service/storage/capture/provider modules', () => {
    const violations: { file: string; pattern: string; line: string }[] = [];

    for (const file of files) {
      const lines = file.content.split('\n');
      for (const [lineIdx, line] of lines.entries()) {
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(line)) {
            violations.push({
              file: file.path.replace(STAGE_C_ROOT, ''),
              pattern: pattern.source,
              line: `L${lineIdx + 1}: ${line.trim()}`,
            });
          }
        }
      }
    }

    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file} ${v.line}\n    matched: ${v.pattern}`)
        .join('\n');
      expect.fail(
        `Stage C overlay imports forbidden modules:\n${report}`,
      );
    }
  });

  it('should only use window.zuleOverlay for state and intent communication', () => {
    // The bridge adapter should reference window.zuleOverlay
    const bridgeFile = files.find((f) => f.path.includes('bridgeAdapter'));
    expect(bridgeFile).toBeDefined();
    expect(bridgeFile!.content).toContain('window.zuleOverlay');
  });

  it('should export StageCOverlay component from the main entry', () => {
    const mainFile = files.find((f) => f.path.endsWith('main.tsx'));
    expect(mainFile).toBeDefined();
    expect(mainFile!.content).toContain('StageCOverlay');
  });

  it('should support compact, expanded, and maximized modes', () => {
    const overlayFile = files.find((f) => f.path.includes('StageCOverlay'));
    expect(overlayFile).toBeDefined();
    expect(overlayFile!.content).toContain('compact');
    expect(overlayFile!.content).toContain('expanded');
    expect(overlayFile!.content).toContain('maximized');
  });

  it('should emit intents via bridge actions (not direct service calls)', () => {
    const overlayFile = files.find((f) => f.path.includes('StageCOverlay'));
    expect(overlayFile).toBeDefined();
    // Should use actions.requestOverlayAction, not direct Electron calls
    expect(overlayFile!.content).toContain('requestOverlayAction');
    expect(overlayFile!.content).toContain('requestAI');
    expect(overlayFile!.content).toContain('requestAudio');
    expect(overlayFile!.content).toContain('requestScreenCapture');
    expect(overlayFile!.content).toContain('reportDragRegions');
    expect(overlayFile!.content).toContain('reportInteractiveRegions');
  });
});
