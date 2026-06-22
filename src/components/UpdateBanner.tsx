// ============================================
// Zule AI — Update Banner Component
// ============================================
//
// Renders the in-app update notification banner when an update is
// available, downloading, or ready to install. Uses the existing
// glass-card and pill design language.
//
// This component displays version information, release notes,
// action buttons, download progress, and inline error indication.
//
// Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.10,
//               5.1, 5.2, 5.4, 5.5, 5.6, 5.7, 5.8,
//               6.1, 6.2, 6.3, 6.5, 6.7, 8.2

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { UpdateState } from '../types/electron';
import { computeProgressDisplay } from '../hooks/progressDisplay';
import './UpdateBanner.css';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum characters of release notes to render before truncation. */
const RELEASE_NOTES_MAX_CHARS = 20_000;

// ─── Props ───────────────────────────────────────────────────────────────────

export interface UpdateBannerProps {
  state: UpdateState;
  dismissed: boolean;
  onDownload: () => void;
  onCancel: () => void;
  onInstall: () => void;
  onDefer: () => void;
  onDismiss: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * In-app update notification banner rendered at the top of the Dashboard
 * layout when the Auto_Updater identifies a candidate update.
 *
 * - Conditionally renders only when status is `available`, `downloading`, or `ready`.
 * - Displays Available_Version and Current_Version using `pill` badges.
 * - Renders Release_Notes as Markdown (truncated at 20,000 chars with expand control).
 * - Shows placeholder text when release notes are unavailable.
 * - Uses `glass-card` container class.
 * - Renders in normal document flow (not position: fixed) so it pushes content down.
 * - Uses `aria-live="polite"` for screen-reader announcements.
 * - Action buttons:
 *   - `available` state: "Update now" (primary) + "Later" (secondary)
 *   - `downloading` state: "Cancel" (enabled)
 *   - `ready` state: "Restart and install" (primary) + "Install on next quit" (secondary)
 *   - `installing` state: all action buttons disabled
 */
export function UpdateBanner({
  state,
  dismissed,
  onDownload,
  onCancel,
  onInstall,
  onDefer,
  onDismiss,
}: UpdateBannerProps) {
  const [expanded, setExpanded] = useState(false);

  // Only render for actionable update states
  const visibleStates: UpdateState['status'][] = ['available', 'downloading', 'ready', 'installing'];
  if (!visibleStates.includes(state.status)) return null;
  if (dismissed) return null;

  const { status, availableVersion, currentVersion, releaseNotes, progress, error } = state;

  // Determine if release notes need truncation
  const notesAvailable = releaseNotes != null && releaseNotes.length > 0;
  const isTruncated = notesAvailable && releaseNotes.length > RELEASE_NOTES_MAX_CHARS;
  const displayedNotes =
    notesAvailable && !expanded && isTruncated
      ? releaseNotes.slice(0, RELEASE_NOTES_MAX_CHARS)
      : releaseNotes;

  // Determine if actions should be disabled (non-actionable states)
  const isInstalling = status === 'installing';

  return (
    <div
      className="update-banner glass-card"
      aria-live="polite"
      aria-atomic="true"
    >
      {/* Header with version info */}
      <div className="update-banner-header">
        <span className="update-banner-title" aria-label="New version available">
          🆕 Version{' '}
          <span className="pill pill-blue">{availableVersion}</span>
          {' '}available
        </span>
        <span className="update-banner-current">
          you're on <span className="pill pill-purple">{currentVersion}</span>
        </span>
      </div>

      {/* Release notes */}
      <div className="update-banner-notes">
        {notesAvailable ? (
          <>
            <div className="update-banner-notes-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {displayedNotes!}
              </ReactMarkdown>
            </div>
            {isTruncated && (
              <button
                className="update-banner-expand-btn"
                onClick={() => setExpanded((prev) => !prev)}
                aria-expanded={expanded}
                aria-label={expanded ? 'Collapse release notes' : 'Expand release notes'}
              >
                {expanded ? 'Collapse ▴' : 'Expand ▾'}
              </button>
            )}
          </>
        ) : (
          <p className="update-banner-placeholder">
            Release notes are not available for this version.
          </p>
        )}
      </div>

      {/* Download progress (downloading state only) */}
      {status === 'downloading' && progress && (
        <div className="update-banner-progress">
          <div className="update-banner-progress-bar">
            <div
              className="update-banner-progress-fill"
              style={{ width: `${progress.percent}%` }}
              role="progressbar"
              aria-valuenow={progress.percent}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
          <span className="update-banner-progress-text">
            {(() => {
              const display = computeProgressDisplay(progress.bytesReceived, progress.totalBytes);
              return `${display.percent}% \u2022 ${display.displayReceived} MB / ${display.displayTotal} MB`;
            })()}
          </span>
        </div>
      )}

      {/* Error message */}
      {error && (
        <p className="update-banner-error" role="alert">
          Update failed: {error.category}
        </p>
      )}

      {/* Action buttons */}
      <div className="update-banner-actions">
        {status === 'available' && (
          <>
            <button
              className="update-banner-btn update-banner-btn-primary"
              onClick={onDownload}
              disabled={isInstalling}
              aria-label="Update now"
            >
              Update now
            </button>
            <button
              className="update-banner-btn update-banner-btn-secondary"
              onClick={onDismiss}
              disabled={isInstalling}
              aria-label="Later"
            >
              Later
            </button>
          </>
        )}

        {status === 'downloading' && (
          <button
            className="update-banner-btn update-banner-btn-primary"
            onClick={onCancel}
            disabled={isInstalling}
            aria-label="Cancel"
          >
            Cancel
          </button>
        )}

        {(status === 'ready' || status === 'installing') && (
          <>
            <button
              className="update-banner-btn update-banner-btn-primary"
              onClick={onInstall}
              disabled={isInstalling}
              aria-label="Restart and install"
            >
              Restart and install
            </button>
            <button
              className="update-banner-btn update-banner-btn-secondary"
              onClick={onDefer}
              disabled={isInstalling}
              aria-label="Install on next quit"
            >
              Install on next quit
            </button>
          </>
        )}
      </div>
    </div>
  );
}
