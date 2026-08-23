// ============================================
// Zule AI — Phone Camera Capture Overlay
// ============================================

import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { Smartphone, X, Copy, Check } from 'lucide-react';
import './PhoneCapture.css';

export interface PhoneCaptureProps {
  isOpen: boolean;
  onClose: () => void;
  serverUrl: string | null;
  isServerActive: boolean;
  onStartServer: () => void;
  onStopServer: () => void;
  lastImageTime: number | null;
}

export function PhoneCapture({
  isOpen,
  onClose,
  serverUrl,
  isServerActive,
}: PhoneCaptureProps) {
  const [qrSvg, setQrSvg] = useState<string>('');
  const [copied, setCopied] = useState(false);

  // Generate crisp high-contrast QR Code SVG whenever serverUrl changes
  useEffect(() => {
    if (!serverUrl) {
      setQrSvg('');
      return;
    }

    let isMounted = true;
    QRCode.toString(serverUrl, {
      type: 'svg',
      margin: 0,
      color: {
        dark: '#090d16',
        light: '#ffffff',
      },
    })
      .then((svg) => {
        if (isMounted) setQrSvg(svg);
      })
      .catch((err) => {
        console.error('[PhoneCapture] Failed to generate QR code SVG:', err);
      });

    return () => {
      isMounted = false;
    };
  }, [serverUrl]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleCopyUrl = async () => {
    if (!serverUrl) return;
    let successful = false;

    // Primary: modern navigator.clipboard
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(serverUrl);
        successful = true;
      }
    } catch {
      successful = false;
    }

    // Fallback: textarea + document.execCommand for Electron sandboxes
    if (!successful) {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = serverUrl;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '-9999px';
        textarea.setAttribute('readonly', '');
        document.body.appendChild(textarea);
        textarea.select();
        successful = document.execCommand('copy');
        document.body.removeChild(textarea);
      } catch (err) {
        console.error('[PhoneCapture] Fallback copy failed:', err);
      }
    }

    if (successful) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      className="phone-capture-card-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="phone-capture-title"
    >
      {/* Top Bar */}
      <div className="phone-capture-card-header">
        <div className="phone-capture-brand-pill">
          <Smartphone size={13} className="phone-capture-pill-icon" />
          <span id="phone-capture-title" className="phone-capture-brand-title">
            Phone Camera Input
          </span>
        </div>
        <button
          className="phone-capture-card-close"
          onClick={onClose}
          aria-label="Close phone capture"
        >
          <X size={15} />
        </button>
      </div>

      {/* Main Content Body */}
      <div className="phone-capture-card-body">
        {/* QR Code Container with sharp contrast */}
        <div className="phone-capture-qr-wrapper">
          <div className="phone-capture-qr-card">
            {qrSvg ? (
              <div
                dangerouslySetInnerHTML={{ __html: qrSvg }}
                className="phone-capture-qr-svg"
              />
            ) : (
              <div className="phone-capture-qr-placeholder">
                {isServerActive ? 'Generating QR...' : 'Starting server...'}
              </div>
            )}
          </div>
        </div>

        {/* LAN URL with Copy Button */}
        {serverUrl && (
          <div className="phone-capture-url-pill">
            <span className="phone-capture-url-text">
              {serverUrl}
            </span>
            <button
              className="phone-capture-copy-btn"
              onClick={handleCopyUrl}
              aria-label="Copy LAN URL"
            >
              {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        )}

        {/* Live Status Indicator */}
        <div className="phone-capture-status-badge">
          <span className="phone-capture-radar-dot" />
          <span className="phone-capture-status-text">
            Waiting for photo from smartphone...
          </span>
        </div>

        {/* Step Guide */}
        <div className="phone-capture-instructions">
          <span className="instruction-step">1. Same Wi-Fi</span>
          <span className="instruction-sep">•</span>
          <span className="instruction-step">2. Scan QR</span>
          <span className="instruction-sep">•</span>
          <span className="instruction-step">3. Take Photo</span>
        </div>
      </div>
    </div>
  );
}
