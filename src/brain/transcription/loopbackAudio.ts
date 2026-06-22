// ============================================
// Zule AI — System Audio (Loopback) Acquisition
// ============================================
//
// Captures the OS audio output ("system audio" / loopback) as a MediaStream
// so it can be transcribed by the WhisperProvider. This is what lets Zule hear
// the *other* party in a call even when the user is wearing headphones — the
// microphone alone never carries that audio.
//
// On Electron (Windows) this works because the main process registers a
// `setDisplayMediaRequestHandler` that returns `{ video, audio: 'loopback' }`
// (see electron/main.ts). The browser SpeechRecognition API cannot consume a
// MediaStream, which is why this audio must be routed through Whisper.
//
// `getDisplayMedia` requires a video track to satisfy the handler, so we
// request video, then immediately drop it — we only want the audio.

import type { ZuleError } from '../../types/errors';

/** Error thrown by `acquireLoopbackStream` when capture cannot be started. */
export class LoopbackError extends Error {
  /** Canonical Zule error for surfacing through the toast pipeline. */
  readonly zuleError: ZuleError;

  constructor(message: string, zuleError: ZuleError) {
    super(message);
    this.name = 'LoopbackError';
    this.zuleError = zuleError;
  }
}

/**
 * Acquire a system-audio (loopback) MediaStream containing only audio tracks.
 *
 * Requests a display-media stream (video is mandatory for the Electron
 * loopback handler), strips the video track, and validates that an audio
 * track is present. The caller owns the returned stream and is responsible
 * for stopping its tracks.
 *
 * @throws {LoopbackError} when display media is unsupported, the user declines,
 *         or no system-audio track is available (e.g. non-Windows platforms).
 */
export async function acquireLoopbackStream(): Promise<MediaStream> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    !navigator.mediaDevices.getDisplayMedia
  ) {
    throw new LoopbackError('getDisplayMedia is not available', {
      kind: 'transcription.unsupported',
    });
  }

  let stream: MediaStream;
  try {
    // eslint-disable-next-line no-console
    console.info('[loopbackAudio] requesting system-audio (getDisplayMedia)…');
    stream = await navigator.mediaDevices.getDisplayMedia({
      // Video is required so the Electron handler hits the loopback branch.
      // Keep the frame rate minimal — we discard the video immediately.
      video: { frameRate: { ideal: 1, max: 1 } },
      audio: true,
    });
    // eslint-disable-next-line no-console
    console.info(
      `[loopbackAudio] stream acquired (audio tracks: ${stream.getAudioTracks().length}, ` +
        `video tracks: ${stream.getVideoTracks().length})`,
    );
  } catch (err) {
    // User declined the picker, or capture failed.
    const denied =
      err instanceof DOMException &&
      (err.name === 'NotAllowedError' || err.name === 'AbortError');
    throw new LoopbackError(
      err instanceof Error ? err.message : 'getDisplayMedia failed',
      { kind: denied ? 'transcription.permission-denied' : 'transcription.audio-capture' },
    );
  }

  // Drop the video track — we only want system audio.
  for (const track of stream.getVideoTracks()) {
    track.stop();
    stream.removeTrack(track);
  }

  // On platforms without loopback support (e.g. macOS/web) the audio track
  // may be absent. Treat that as an audio-capture failure and clean up.
  if (stream.getAudioTracks().length === 0) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    throw new LoopbackError('No system-audio track available (loopback unsupported)', {
      kind: 'transcription.audio-capture',
    });
  }

  return stream;
}
