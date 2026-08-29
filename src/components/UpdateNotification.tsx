// ============================================================================
// Zule AI — Minimal Update Notification Toast
// ============================================================================

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowUpCircle, RefreshCw, X } from 'lucide-react';
import type { UpdateState } from '../types/electron';
import './UpdateNotification.css';

export interface UpdateNotificationProps {
  state: UpdateState;
  dismissed: boolean;
  onInstall: () => void;
  onDefer: () => void;
  onDismiss: () => void;
  onDownload?: () => void;
}

export function UpdateNotification({
  state,
  dismissed,
  onInstall,
  onDismiss,
}: UpdateNotificationProps) {
  const { status, availableVersion, progress } = state;
  const [isInstalling, setIsInstalling] = useState(false);

  const isVisible =
    !dismissed && (status === 'downloading' || status === 'ready' || status === 'installing');

  const handleInstallClick = () => {
    setIsInstalling(true);
    onInstall();
  };

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          className="update-toast"
          initial={{ opacity: 0, y: -12, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.96 }}
          transition={{ duration: 0.25, ease: [0.25, 1, 0.5, 1] }}
        >
          {/* Downloading state — quiet progress line */}
          {status === 'downloading' && (
            <>
              <div className="update-toast-content">
                <ArrowUpCircle size={15} className="update-toast-icon downloading" />
                <span className="update-toast-text">
                  Downloading v{availableVersion ?? 'latest'}
                  <span className="update-toast-pct">{progress?.percent ?? 0}%</span>
                </span>
                <button className="update-toast-dismiss" onClick={onDismiss} aria-label="Dismiss">
                  <X size={13} />
                </button>
              </div>
              <div className="update-toast-progress">
                <motion.div
                  className="update-toast-progress-bar"
                  initial={{ width: 0 }}
                  animate={{ width: `${progress?.percent ?? 0}%` }}
                  transition={{ ease: 'easeOut', duration: 0.3 }}
                />
              </div>
            </>
          )}

          {/* Ready state — one action */}
          {status === 'ready' && !isInstalling && (
            <div className="update-toast-content">
              <ArrowUpCircle size={15} className="update-toast-icon ready" />
              <span className="update-toast-text">
                v{availableVersion} ready
              </span>
              <button className="update-toast-action" onClick={handleInstallClick}>
                Restart to update
              </button>
              <button className="update-toast-dismiss" onClick={onDismiss} aria-label="Dismiss">
                <X size={13} />
              </button>
            </div>
          )}

          {/* Installing state */}
          {(status === 'installing' || isInstalling) && (
            <div className="update-toast-content">
              <RefreshCw size={14} className="update-toast-icon installing" />
              <span className="update-toast-text">Restarting…</span>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
