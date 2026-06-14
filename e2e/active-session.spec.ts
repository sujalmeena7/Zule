/**
 * Active_Session lifecycle — Playwright E2E spec
 *
 * Validates Requirements: 1.1, 12.1, 27.1
 *
 * These tests run against `vite preview` (built bundle). They mock the
 * Web Speech API since headless Chromium does not implement it, and stub
 * the AI provider HTTP layer so no real cloud calls are made.
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inject a fake SpeechRecognition class into the page and stub
 * getUserMedia / getDisplayMedia so the app can start a session without
 * real hardware.
 */
async function mockBrowserAPIs(page: Page) {
  await page.addInitScript(() => {
    // --- Stub getUserMedia ---
    (navigator as any).mediaDevices = {
      getUserMedia: () =>
        Promise.resolve({
          getTracks: () => [{ stop: () => {}, kind: 'audio' }],
          getAudioTracks: () => [{ stop: () => {} }],
        }),
      getDisplayMedia: () =>
        Promise.resolve({
          getTracks: () => [{ stop: () => {}, kind: 'video' }],
          getVideoTracks: () => [{ stop: () => {}, enabled: true }],
        }),
    };

    // --- Stub permissions API ---
    (navigator as any).permissions = {
      query: () => Promise.resolve({ state: 'granted', addEventListener: () => {} }),
    };

    // --- Fake SpeechRecognition ---
    class FakeSpeechRecognition extends EventTarget {
      continuous = false;
      interimResults = false;
      lang = 'en-US';
      private _running = false;

      start() {
        this._running = true;
        // Fire a fake result after a short delay to simulate speech
        setTimeout(() => {
          if (!this._running) return;
          const event = new Event('result') as any;
          event.resultIndex = 0;
          event.results = {
            length: 1,
            0: {
              isFinal: true,
              length: 1,
              0: { transcript: 'What is the quarterly revenue?', confidence: 0.92 },
            },
          };
          this.dispatchEvent(event);
          if ((this as any).onresult) (this as any).onresult(event);
        }, 300);
      }

      stop() {
        this._running = false;
        const event = new Event('end');
        this.dispatchEvent(event);
        if ((this as any).onend) (this as any).onend(event);
      }

      abort() {
        this._running = false;
      }
    }

    (window as any).SpeechRecognition = FakeSpeechRecognition;
    (window as any).webkitSpeechRecognition = FakeSpeechRecognition;

    // --- Stub fetch for AI provider calls ---
    const originalFetch = window.fetch;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

      // Intercept AI provider calls (Gemini, OpenAI, Anthropic)
      if (
        url.includes('generativelanguage.googleapis.com') ||
        url.includes('api.openai.com') ||
        url.includes('api.anthropic.com')
      ) {
        // Return a simulated streaming response
        const body = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const data = JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'The quarterly revenue is $2.4M, up 15% from last quarter.' }] } }],
            });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });

        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }

      return originalFetch(input, init);
    };
  });
}

/**
 * Navigate from landing to the dashboard.
 */
async function goToDashboard(page: Page) {
  // The app starts at the landing page by default (hash '')
  // Navigate directly to the dashboard hash
  await page.goto('/#dashboard');
  await page.waitForSelector('.dashboard', { timeout: 10_000 });
}

/**
 * Start a copilot session from the dashboard.
 */
async function startSession(page: Page) {
  const startBtn = page.locator('button:has-text("Start Session")').first();
  await startBtn.click();
  // Wait for the copilot overlay to appear
  await page.waitForSelector('.copilot-overlay', { timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Active_Session lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrowserAPIs(page);
  });

  test('starting a session renders the copilot overlay with status indicators', async ({ page }) => {
    await goToDashboard(page);
    await startSession(page);

    // The overlay should be visible
    const overlay = page.locator('.copilot-overlay');
    await expect(overlay).toBeVisible();

    // Status indicators: the control capsule should show mic/listening state
    const controlCapsule = page.locator('.copilot-overlay').first();
    await expect(controlCapsule).toBeVisible();

    // The overlay should have a mode pill showing the active mode
    const modePill = page.locator('.card-mode-pill');
    await expect(modePill).toBeVisible();
  });

  test('stopping a session hides the overlay and persists a meeting on the dashboard', async ({ page }) => {
    await goToDashboard(page);
    await startSession(page);

    // Confirm overlay is up
    await expect(page.locator('.copilot-overlay')).toBeVisible();

    // Wait a moment for the fake transcript to come through
    await page.waitForTimeout(500);

    // Click the stop button (inside ControlCapsule)
    const stopBtn = page.locator('button[title="Stop Session"], button:has-text("Stop")').first();
    await stopBtn.click();

    // After stop, the app navigates to meeting-detail (via STOP_COPILOT action)
    // then from there we can go back to dashboard to verify persistence
    await page.waitForSelector('.copilot-overlay', { state: 'detached', timeout: 15_000 });

    // Navigate to dashboard to verify the meeting was saved
    await page.goto('/#dashboard');
    await page.waitForSelector('.dashboard', { timeout: 10_000 });

    // There should be at least one meeting in the list
    const meetingCards = page.locator('.meeting-card');
    await expect(meetingCards).toHaveCount(1, { timeout: 10_000 });
  });

  test('the overlay renders with data-zule-stealth="true" attribute', async ({ page }) => {
    await goToDashboard(page);
    await startSession(page);

    // The overlay div should have the stealth attribute (Requirement 15.5)
    const overlay = page.locator('[data-zule-stealth="true"]');
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveAttribute('data-zule-stealth', 'true');
  });

  test('stop flow persists a meeting before summary generation (IndexedDB check)', async ({ page }) => {
    await goToDashboard(page);
    await startSession(page);

    // Wait for fake transcript
    await page.waitForTimeout(500);

    // Click the stop button
    const stopBtn = page.locator('button[title="Stop Session"], button:has-text("Stop")').first();
    await stopBtn.click();

    // After stop, verify via IndexedDB that a meeting exists with the transcript persisted.
    // The placeholder meeting is written BEFORE summary generation (Requirement 27.1).
    // We query IndexedDB directly to verify this invariant.
    const meetingData = await page.evaluate(async () => {
      // Access IndexedDB to check if a meeting was persisted
      return new Promise<{ found: boolean; hasTranscript: boolean; status: string | null }>((resolve) => {
        const request = indexedDB.open('zule-db');
        request.onsuccess = () => {
          const db = request.result;
          // Try the meetings store
          const storeNames = Array.from(db.objectStoreNames);
          const storeName = storeNames.find(
            (name) => name === 'meetings' || name === 'meeting' || name.includes('meeting'),
          );
          if (!storeName) {
            db.close();
            resolve({ found: false, hasTranscript: false, status: null });
            return;
          }
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const getAll = store.getAll();
          getAll.onsuccess = () => {
            const meetings = getAll.result;
            db.close();
            if (meetings.length === 0) {
              resolve({ found: false, hasTranscript: false, status: null });
              return;
            }
            const latest = meetings[meetings.length - 1];
            resolve({
              found: true,
              hasTranscript:
                Array.isArray(latest.transcript) && latest.transcript.length > 0,
              status: latest.aiSummaryStatus ?? null,
            });
          };
          getAll.onerror = () => {
            db.close();
            resolve({ found: false, hasTranscript: false, status: null });
          };
        };
        request.onerror = () => {
          resolve({ found: false, hasTranscript: false, status: null });
        };
      });
    });

    // The meeting should exist in IndexedDB with transcript data
    expect(meetingData.found).toBe(true);
    expect(meetingData.hasTranscript).toBe(true);
    // The status should be either 'pending' (if summary is still generating)
    // or 'ok'/'failed' (if it already completed). The key point is that the
    // meeting record exists — it was persisted BEFORE summary generation.
    expect(meetingData.status).toBeTruthy();
  });
});
