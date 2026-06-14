/**
 * Accessibility — Playwright E2E spec (axe-core)
 *
 * Validates Requirements: 18.5, 18.6
 *
 * Runs automated axe-core checks against the main application pages to verify
 * that there are zero critical or serious WCAG violations. Minor and moderate
 * violations are logged for informational purposes but do not fail the test.
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Filter axe results to only critical and serious violations.
 */
function criticalOrSerious(results: Awaited<ReturnType<AxeBuilder['analyze']>>) {
  return results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
}

/**
 * Log minor/moderate violations for visibility without failing the test.
 */
function logMinorViolations(results: Awaited<ReturnType<AxeBuilder['analyze']>>, pageName: string) {
  const minor = results.violations.filter(
    (v) => v.impact === 'minor' || v.impact === 'moderate',
  );
  if (minor.length > 0) {
    console.log(
      `[a11y] ${pageName}: ${minor.length} minor/moderate violation(s):`,
      minor.map((v) => `${v.id} (${v.impact}): ${v.help}`),
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Accessibility (axe-core)', () => {
  test('landing page has zero critical/serious violations', async ({ page }) => {
    await page.goto('/');
    // Wait for the landing page to render
    await page.waitForSelector('.landing-container', { timeout: 10_000 });

    const results = await new AxeBuilder({ page }).analyze();
    logMinorViolations(results, 'Landing');

    const serious = criticalOrSerious(results);
    expect(serious, `Critical/serious a11y violations on landing page: ${JSON.stringify(serious.map((v) => ({ id: v.id, impact: v.impact, help: v.help })), null, 2)}`).toHaveLength(0);
  });

  test('dashboard page has zero critical/serious violations', async ({ page }) => {
    await page.goto('/#dashboard');
    // Wait for the dashboard to render
    await page.waitForSelector('.dashboard', { timeout: 10_000 });

    const results = await new AxeBuilder({ page }).analyze();
    logMinorViolations(results, 'Dashboard');

    const serious = criticalOrSerious(results);
    expect(serious, `Critical/serious a11y violations on dashboard: ${JSON.stringify(serious.map((v) => ({ id: v.id, impact: v.impact, help: v.help })), null, 2)}`).toHaveLength(0);
  });

  test('settings page has zero critical/serious violations', async ({ page }) => {
    await page.goto('/#settings');
    // Wait for the settings page to render
    await page.waitForSelector('.settings', { timeout: 10_000 });

    const results = await new AxeBuilder({ page }).analyze();
    logMinorViolations(results, 'Settings');

    const serious = criticalOrSerious(results);
    expect(serious, `Critical/serious a11y violations on settings page: ${JSON.stringify(serious.map((v) => ({ id: v.id, impact: v.impact, help: v.help })), null, 2)}`).toHaveLength(0);
  });
});
