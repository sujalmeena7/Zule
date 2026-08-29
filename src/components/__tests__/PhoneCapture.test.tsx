// ============================================
// Zule AI — PhoneCapture Component Tests
// ============================================

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PhoneCapture } from '../copilot/PhoneCapture';

describe('PhoneCapture Component', () => {
  it('does not render when isOpen is false', () => {
    const { container } = render(
      <PhoneCapture
        isOpen={false}
        onClose={vi.fn()}
        serverUrl="http://192.168.1.100:9473"
        isServerActive={true}
        onStartServer={vi.fn()}
        onStopServer={vi.fn()}
        lastImageTime={null}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('renders overlay with server URL when open', async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(
        <PhoneCapture
          isOpen={true}
          onClose={onClose}
          serverUrl="http://192.168.1.100:9473"
          isServerActive={true}
          onStartServer={vi.fn()}
          onStopServer={vi.fn()}
          lastImageTime={null}
        />,
      );
    });

    expect(screen.getByText('Phone Camera Input')).toBeInTheDocument();
    expect(screen.getByText('http://192.168.1.100:9473')).toBeInTheDocument();
    expect(screen.getByText('Waiting for photo from smartphone...')).toBeInTheDocument();

    // Close button
    const closeBtn = screen.getByLabelText('Close phone capture');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('generates QR code SVG when serverUrl is provided', async () => {
    await act(async () => {
      render(
        <PhoneCapture
          isOpen={true}
          onClose={vi.fn()}
          serverUrl="http://192.168.1.100:9473"
          isServerActive={true}
          onStartServer={vi.fn()}
          onStopServer={vi.fn()}
          lastImageTime={null}
        />,
      );
    });

    await waitFor(() => {
      const svg = document.querySelector('.phone-capture-qr-card svg');
      expect(svg).toBeInTheDocument();
    });
  });

  it('copies LAN URL to clipboard when copy button is clicked', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    await act(async () => {
      render(
        <PhoneCapture
          isOpen={true}
          onClose={vi.fn()}
          serverUrl="http://192.168.1.100:9473"
          isServerActive={true}
          onStartServer={vi.fn()}
          onStopServer={vi.fn()}
          lastImageTime={null}
        />,
      );
    });

    const copyBtn = screen.getByLabelText('Copy LAN URL');
    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(writeTextMock).toHaveBeenCalledWith('http://192.168.1.100:9473');
  });
});
