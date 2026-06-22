// ============================================
// Zule AI — UpdateBanner property tests
// ============================================
// Feature: auto-updater, Property 6: Non-actionable states disable user controls
//
// Validates: Requirements 3.3, 6.7
//
// Property 6: For any update state in the set {checking, downloading, installing},
// all user-facing action controls SHALL be rendered as non-interactive,
// rejecting both pointer and keyboard activation.
//
// Since the banner only renders for {available, downloading, ready, installing},
// the "checking" state is tested via the Settings "Check for updates" button logic.
// This test focuses on:
// - `installing` state: "Restart and install" and "Install on next quit" buttons
//   are rendered but disabled
// - `downloading` state: "Cancel" button is enabled (user can cancel), but the
//   primary "Update now" action is not available (replaced by Cancel)
// - Verifying the correct disabled/enabled state of controls per status

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { UpdateBanner } from '../UpdateBanner';
import type { UpdateState, DownloadProgress } from '../../types/electron';

// ─── Generators ──────────────────────────────────────────────────────────────

/** Generate a valid semantic version string. */
const semverArb = () =>
  fc.tuple(
    fc.nat({ max: 20 }),
    fc.nat({ max: 20 }),
    fc.nat({ max: 99 }),
  ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

/** Generate download progress for downloading state. */
const progressArb = (): fc.Arbitrary<DownloadProgress> =>
  fc.record({
    totalBytes: fc.integer({ min: 1, max: 200_000_000 }),
    bytesReceived: fc.integer({ min: 0, max: 200_000_000 }),
    percent: fc.integer({ min: 0, max: 100 }),
  }).map(({ totalBytes, bytesReceived, percent }) => ({
    totalBytes,
    bytesReceived: Math.min(bytesReceived, totalBytes),
    percent,
  }));

/** Generate an UpdateState with status === 'installing'. */
const installingStateArb = (): fc.Arbitrary<UpdateState> =>
  fc.record({
    availableVersion: semverArb(),
    currentVersion: semverArb(),
    releaseNotes: fc.oneof(
      fc.constant(null),
      fc.string({ minLength: 0, maxLength: 200 }),
    ),
  }).map(({ availableVersion, currentVersion, releaseNotes }) => ({
    status: 'installing' as const,
    availableVersion,
    currentVersion,
    releaseNotes,
    progress: null,
    error: null,
  }));

/** Generate an UpdateState with status === 'downloading'. */
const downloadingStateArb = (): fc.Arbitrary<UpdateState> =>
  fc.record({
    availableVersion: semverArb(),
    currentVersion: semverArb(),
    releaseNotes: fc.oneof(
      fc.constant(null),
      fc.string({ minLength: 0, maxLength: 200 }),
    ),
    progress: progressArb(),
  }).map(({ availableVersion, currentVersion, releaseNotes, progress }) => ({
    status: 'downloading' as const,
    availableVersion,
    currentVersion,
    releaseNotes,
    progress,
    error: null,
  }));

/** Generate an UpdateState with status === 'available' (actionable state for comparison). */
const availableStateArb = (): fc.Arbitrary<UpdateState> =>
  fc.record({
    availableVersion: semverArb(),
    currentVersion: semverArb(),
    releaseNotes: fc.oneof(
      fc.constant(null),
      fc.string({ minLength: 0, maxLength: 200 }),
    ),
  }).map(({ availableVersion, currentVersion, releaseNotes }) => ({
    status: 'available' as const,
    availableVersion,
    currentVersion,
    releaseNotes,
    progress: null,
    error: null,
  }));

/** Generate an UpdateState with status === 'ready' (actionable state for comparison). */
const readyStateArb = (): fc.Arbitrary<UpdateState> =>
  fc.record({
    availableVersion: semverArb(),
    currentVersion: semverArb(),
    releaseNotes: fc.oneof(
      fc.constant(null),
      fc.string({ minLength: 0, maxLength: 200 }),
    ),
  }).map(({ availableVersion, currentVersion, releaseNotes }) => ({
    status: 'ready' as const,
    availableVersion,
    currentVersion,
    releaseNotes,
    progress: null,
    error: null,
  }));

// ─── No-op callbacks ─────────────────────────────────────────────────────────

const noop = () => {};

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 6: Non-actionable states disable user controls', () => {
  /**
   * **Validates: Requirements 3.3, 6.7**
   *
   * For any UpdateState with status === 'installing', the "Restart and install"
   * and "Install on next quit" buttons SHALL be disabled.
   */
  it('all action buttons are disabled in installing state', () => {
    fc.assert(
      fc.property(installingStateArb(), (state) => {
        const { container, unmount } = render(
          createElement(UpdateBanner, { state, dismissed: false, onDownload: noop, onCancel: noop, onInstall: noop, onDefer: noop, onDismiss: noop }),
        );

        // In installing state, the banner renders with ready/installing buttons
        const buttons = Array.from(container.querySelectorAll('button.update-banner-btn'));

        // All action buttons must be disabled
        for (const button of buttons) {
          expect((button as HTMLButtonElement).disabled).toBe(true);
        }

        // Specifically check the primary and secondary action buttons
        const restartBtn = container.querySelector('[aria-label="Restart and install"]');
        const deferBtn = container.querySelector('[aria-label="Install on next quit"]');

        expect(restartBtn).not.toBeNull();
        expect(deferBtn).not.toBeNull();
        expect((restartBtn as HTMLButtonElement).disabled).toBe(true);
        expect((deferBtn as HTMLButtonElement).disabled).toBe(true);

        unmount();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.3, 6.7**
   *
   * For any UpdateState with status === 'downloading', the "Cancel" button
   * SHALL be enabled (user can cancel an active download), and the primary
   * "Update now" action SHALL NOT be rendered (replaced by Cancel).
   */
  it('Cancel button is enabled in downloading state and Update now is not rendered', () => {
    fc.assert(
      fc.property(downloadingStateArb(), (state) => {
        const { container, unmount } = render(
          createElement(UpdateBanner, { state, dismissed: false, onDownload: noop, onCancel: noop, onInstall: noop, onDefer: noop, onDismiss: noop }),
        );

        // Cancel button should exist and be enabled
        const cancelBtn = container.querySelector('[aria-label="Cancel"]');
        expect(cancelBtn).not.toBeNull();
        expect((cancelBtn as HTMLButtonElement).disabled).toBe(false);

        // "Update now" should NOT be rendered during downloading
        const updateNowBtn = container.querySelector('[aria-label="Update now"]');
        expect(updateNowBtn).toBeNull();

        // "Restart and install" should NOT be rendered during downloading
        const restartBtn = container.querySelector('[aria-label="Restart and install"]');
        expect(restartBtn).toBeNull();

        unmount();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.3, 6.7**
   *
   * For any UpdateState with status === 'available', the "Update now" and
   * "Later" buttons SHALL be enabled (this is an actionable state).
   * This verifies the inverse — actionable states have enabled controls.
   */
  it('action buttons are enabled in available state (actionable)', () => {
    fc.assert(
      fc.property(availableStateArb(), (state) => {
        const { container, unmount } = render(
          createElement(UpdateBanner, { state, dismissed: false, onDownload: noop, onCancel: noop, onInstall: noop, onDefer: noop, onDismiss: noop }),
        );

        const updateNowBtn = container.querySelector('[aria-label="Update now"]');
        const laterBtn = container.querySelector('[aria-label="Later"]');

        expect(updateNowBtn).not.toBeNull();
        expect(laterBtn).not.toBeNull();
        expect((updateNowBtn as HTMLButtonElement).disabled).toBe(false);
        expect((laterBtn as HTMLButtonElement).disabled).toBe(false);

        unmount();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 3.3, 6.7**
   *
   * For any UpdateState with status === 'ready', the "Restart and install"
   * and "Install on next quit" buttons SHALL be enabled (ready is actionable).
   */
  it('action buttons are enabled in ready state (actionable)', () => {
    fc.assert(
      fc.property(readyStateArb(), (state) => {
        const { container, unmount } = render(
          createElement(UpdateBanner, { state, dismissed: false, onDownload: noop, onCancel: noop, onInstall: noop, onDefer: noop, onDismiss: noop }),
        );

        const restartBtn = container.querySelector('[aria-label="Restart and install"]');
        const deferBtn = container.querySelector('[aria-label="Install on next quit"]');

        expect(restartBtn).not.toBeNull();
        expect(deferBtn).not.toBeNull();
        expect((restartBtn as HTMLButtonElement).disabled).toBe(false);
        expect((deferBtn as HTMLButtonElement).disabled).toBe(false);

        unmount();
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property 7 Generators ────────────────────────────────────────────────────

/** Generates a non-empty release notes string (alphanumeric, safe for Markdown). */
const releaseNotesContentArb = () =>
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), {
    minLength: 1,
    maxLength: 100,
  });

/** Generates either null, empty string, or a non-empty release notes string. */
const optionalReleaseNotesArb = () =>
  fc.oneof(
    fc.constant(null),
    fc.constant(''),
    releaseNotesContentArb(),
  );

/** Generates a visible banner status (available or ready). */
const visibleStatusArb = () =>
  fc.constantFrom<'available' | 'ready'>('available', 'ready');

// ── Property 7 Test ──────────────────────────────────────────────────────────

// Feature: auto-updater, Property 7: Banner renders complete update information
describe('Property 7: Banner renders complete update information', () => {
  /**
   * **Validates: Requirements 4.2, 4.3, 4.4**
   *
   * For any (availableVersion, currentVersion, releaseNotes) triple where
   * state is `available` or `ready`:
   * - The rendered banner contains the availableVersion string
   * - The rendered banner contains the currentVersion string
   * - If releaseNotes is non-null/non-empty: rendered content includes the notes
   * - If releaseNotes is null/empty: rendered content includes placeholder text
   *   "Release notes are not available"
   */
  it('renders version information and release notes (or placeholder) for any input', () => {
    fc.assert(
      fc.property(
        semverArb(),
        semverArb(),
        optionalReleaseNotesArb(),
        visibleStatusArb(),
        (availableVersion, currentVersion, releaseNotes, status) => {
          const state: UpdateState = {
            status,
            availableVersion,
            currentVersion,
            releaseNotes,
            progress: null,
            error: null,
          };

          const noop = () => {};
          const { container, unmount } = render(
            createElement(UpdateBanner, {
              state,
              dismissed: false,
              onDownload: noop,
              onCancel: noop,
              onInstall: noop,
              onDefer: noop,
              onDismiss: noop,
            }),
          );

          const textContent = container.textContent ?? '';

          // Banner must contain the available version
          expect(textContent).toContain(availableVersion);

          // Banner must contain the current version
          expect(textContent).toContain(currentVersion);

          // Release notes or placeholder
          if (releaseNotes != null && releaseNotes.length > 0) {
            // Notes are rendered via react-markdown — check innerHTML for content
            const innerHTML = container.innerHTML;
            expect(innerHTML).toContain(releaseNotes);
          } else {
            // Placeholder text must appear
            expect(textContent).toContain('Release notes are not available');
          }

          unmount();
        },
      ),
      { numRuns: 100 },
    );
  });
});
