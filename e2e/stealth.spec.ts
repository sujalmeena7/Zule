import { test, expect } from '@playwright/test';

/**
 * Stealth & Privacy E2E Tests
 *
 * Validates Requirements 15.5 and 15.7:
 * - 15.5: The floating overlay sets data-zule-stealth="true" so browser extensions
 *         and OS-level capture filters can identify and exclude it.
 * - 15.7: CSP meta tag restricts script-src to 'self' and explicit provider origins;
 *         no third-party CDN scripts are loaded.
 */

test.describe('Stealth and Privacy', () => {
  test('copilot overlay has data-zule-stealth="true" attribute when rendered', async ({ page }) => {
    await page.goto('/');

    // Navigate to an active session so the FloatingCopilot renders
    // The overlay should be present on the page with the stealth attribute
    const overlay = page.locator('[data-zule-stealth="true"]');
    await expect(overlay).toBeAttached({ timeout: 10_000 });
    await expect(overlay).toHaveAttribute('data-zule-stealth', 'true');
  });

  test('CSP meta tag is present with script-src self', async ({ page }) => {
    await page.goto('/');

    const cspMeta = page.locator('meta[http-equiv="Content-Security-Policy"]');
    await expect(cspMeta).toBeAttached();

    const content = await cspMeta.getAttribute('content');
    expect(content).toBeTruthy();
    expect(content).toContain("script-src 'self'");
  });

  test('no script tags reference third-party CDN domains', async ({ page }) => {
    await page.goto('/');

    const thirdPartyCdns = [
      'cdnjs.cloudflare.com',
      'unpkg.com',
      'cdn.jsdelivr.net',
      'ajax.googleapis.com',
      'code.jquery.com',
      'stackpath.bootstrapcdn.com',
    ];

    const scripts = await page.locator('script[src]').all();

    for (const script of scripts) {
      const src = await script.getAttribute('src');
      if (src) {
        for (const cdn of thirdPartyCdns) {
          expect(src, `Script src "${src}" must not reference third-party CDN "${cdn}"`).not.toContain(cdn);
        }
      }
    }
  });

  test('panic-hide shortcut hides the overlay', async ({ page }) => {
    await page.goto('/');

    // Wait for the overlay to be visible
    const overlay = page.locator('[data-zule-stealth="true"]');
    await expect(overlay).toBeAttached({ timeout: 10_000 });

    // The suggestion card should be visible initially
    const suggestionCard = overlay.locator('.suggestion-card');
    await expect(suggestionCard).toBeAttached();
    await expect(suggestionCard).not.toHaveClass(/hidden/);

    // Simulate the panic-hide shortcut: Ctrl+Shift+\
    await page.keyboard.press('Control+Shift+Backslash');

    // After panic-hide, the suggestion card should have the hidden class
    await expect(suggestionCard).toHaveClass(/hidden/, { timeout: 2_000 });
  });
});
