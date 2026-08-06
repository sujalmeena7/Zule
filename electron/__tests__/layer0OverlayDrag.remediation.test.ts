import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const overlayManager = readFileSync(resolve(ROOT, 'electron/overlayManager.ts'), 'utf8');
const main = readFileSync(resolve(ROOT, 'electron/main.ts'), 'utf8');
const copilot = readFileSync(resolve(ROOT, 'src/components/FloatingCopilot.tsx'), 'utf8');
const css = readFileSync(resolve(ROOT, 'src/components/FloatingCopilot.css'), 'utf8');

function appRegionSelectors(value: 'drag' | 'no-drag'): string {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return rules
    .filter(([, , declarations]) =>
      new RegExp(`-webkit-app-region\\s*:\\s*${value}\\s*;`).test(declarations))
    .map(([, selectors]) => selectors)
    .join(',');
}

describe('Layer 0 native overlay drag remediation', () => {
  it('permits movement only on the dedicated overlay BrowserWindow', () => {
    expect(overlayManager).toMatch(/resizable\s*:\s*true[\s\S]*?movable\s*:\s*true/);
    expect(overlayManager).not.toMatch(/movable\s*:\s*false/);
    expect(main).not.toMatch(/\bmovable\s*:/);
  });

  it('applies the draggable root class only in native overlay mode', () => {
    expect(copilot).toContain('isNativeOverlay ? `native-overlay-mode mode-2-card-root');
  });

  it('keeps native card surfaces draggable and controls/scrolling interactive', () => {
    const drag = appRegionSelectors('drag');
    const noDrag = appRegionSelectors('no-drag');
    expect(drag).toContain('.mode-2-card-root');
    for (const selector of ['button', 'a', 'input', '[role="button"]', '.card-scroll-body']) {
      expect(noDrag).toContain(`.mode-2-card-root ${selector}`);
    }
    expect(noDrag).not.toContain('.mode-2-card-root .control-capsule');
  });
});
