// ============================================
// Zule AI — Update Popup Component
// ============================================
//
// Premium, Apple/Cursor-inspired update notification popup.
// Shows as a centered modal overlay when an update is available,
// downloading, or ready to install.
//
// Requirements: 4.1–4.6, 4.10, 5.1–5.8, 6.1–6.7, 8.2

import { useState } from 'react';
import type { UpdateState } from '../types/electron';
import { computeProgressDisplay } from '../hooks/progressDisplay';
import { Sparkles, Download, RefreshCw, X, ArrowRight } from 'lucide-react';
import './UpdateBanner.css';

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
 * Premium update notification popup rendered as a centered modal overlay.
 * Inspired by Apple's software update and Cursor's update flow.
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
  const [closing, setClosing] = useState(false);

  // Only render for actionable update states
  const visibleStates: UpdateState['status'][] = ['available', 'downloading', 'ready', 'installing'];
  if (!visibleStates.includes(state.status)) return null;
  if (dismissed) return null;

  const { status, availableVersion, currentVersion, progress, error } = state;
  const isInstalling = status === 'installing';

  const handleDismiss = () => {
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      onDismiss();
    }, 250);
  };

  const handleDefer = () => {
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      onDefer();
    }, 250);
  };

  // Status-specific messaging
  const statusConfig = {
    available: {
      icon: <Sparkles size={22} />,
      title: 'A new update is available',
      subtitle: `Zule ${availableVersion} is ready to download`,
      accentClass: 'accent-blue',
    },
    downloading: {
      icon: <Download size={22} />,
      title: 'Downloading update…',
      subtitle: progress
        ? `${computeProgressDisplay(progress.bytesReceived, progress.totalBytes).percent}% complete`
        : 'Preparing download…',
      accentClass: 'accent-blue',
    },
    ready: {
      icon: <RefreshCw size={22} />,
      title: 'Update ready to install',
      subtitle: `Zule ${availableVersion} has been downloaded`,
      accentClass: 'accent-green',
    },
    installing: {
      icon: <RefreshCw size={22} className="spin" />,
      title: 'Installing update…',
      subtitle: 'Zule will restart shortly',
      accentClass: 'accent-green',
    },
  };

  const config = statusConfig[status as keyof typeof statusConfig] ?? statusConfig.available;

  return (
    <div
      className={`update-popup-overlay ${closing ? 'is-closing' : ''}`}
      onClick={handleDismiss}
      aria-modal="true"
      role="dialog"
      aria-label="Software update"
    >
      <div
        className={`update-popup ${config.accentClass} ${closing ? 'is-closing' : ''}`}
        onClick={(e) => e.stopPropagation()}
        aria-live="polite"
        aria-atomic="true"
      >
        {/* Close button */}
        <button
          className="update-popup-close"
          onClick={handleDismiss}
          aria-label="Dismiss update notification"
        >
          <X size={16} />
        </button>

        {/* Icon + shimmer */}
        <div className="update-popup-icon-wrap">
          <div className="update-popup-icon">
            {config.icon}
          </div>
        </div>

        {/* Title */}
        <h2 className="update-popup-title">{config.title}</h2>

        {/* Subtitle */}
        <p className="update-popup-subtitle">{config.subtitle}</p>

        {/* Version badges */}
        <div className="update-popup-versions">
          <span className="update-popup-version-badge current">
            v{currentVersion}
          </span>
          <ArrowRight size={14} className="update-popup-version-arrow" />
          <span className="update-popup-version-badge next">
            v{availableVersion}
          </span>
        </div>

        {/* Download progress */}
        {status === 'downloading' && progress && (
          <div className="update-popup-progress">
            <div className="update-popup-progress-track">
              <div
                className="update-popup-progress-fill"
                style={{ width: `${progress.percent}%` }}
                role="progressbar"
                aria-valuenow={progress.percent}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
            <span className="update-popup-progress-text">
              {(() => {
                const display = computeProgressDisplay(progress.bytesReceived, progress.totalBytes);
                return `${display.displayReceived} / ${display.displayTotal} MB`;
              })()}
            </span>
          </div>
        )}

        {/* Error message */}
        {error && (
          <p className="update-popup-error" role="alert">
            ⚠ Update failed: {error.category}
          </p>
        )}

        {/* Action buttons */}
        <div className="update-popup-actions">
          {status === 'available' && (
            <>
              <button
                className="update-popup-btn primary"
                onClick={onDownload}
                disabled={isInstalling}
              >
                <Download size={15} />
                Update Now
              </button>
              <button
                className="update-popup-btn secondary"
                onClick={handleDismiss}
                disabled={isInstalling}
              >
                Not Now
              </button>
            </>
          )}

          {status === 'downloading' && (
            <button
              className="update-popup-btn secondary"
              onClick={onCancel}
              disabled={isInstalling}
            >
              Cancel Download
            </button>
          )}

          {(status === 'ready' || status === 'installing') && (
            <>
              <button
                className="update-popup-btn primary"
                onClick={onInstall}
                disabled={isInstalling}
              >
                <RefreshCw size={15} className={isInstalling ? 'spin' : ''} />
                {isInstalling ? 'Installing…' : 'Restart & Install'}
              </button>
              <button
                className="update-popup-btn secondary"
                onClick={handleDefer}
                disabled={isInstalling}
              >
                Install Later
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
