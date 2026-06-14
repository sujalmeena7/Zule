// ============================================
// Zule AI — Tab Crop Hook (Requirement 15.6)
// ============================================
//
// Provides a "crop tab to content area" mode that excludes the overlay region
// from the captured tab stream, using the experimental
// BrowserCaptureMediaStreamTrack.cropTo API.
//
// Limitations:
//   - This mode applies ONLY to tab capture (not window or screen capture).
//   - BrowserCaptureMediaStreamTrack.cropTo is an experimental API and is
//     currently only available in Chromium-based browsers behind a flag.
//   - When unsupported, the feature is simply not exposed (graceful degradation).

import { useState, useCallback, useRef } from 'react';
import {
  isCropToContentSupported,
  isCroppableTrack,
  cropToContentArea,
  removeCrop,
} from '../utils/cropToContent';

// ---------------------------------------------------------------------------
// Hook interface
// ---------------------------------------------------------------------------

export interface UseTabCropResult {
  /** Whether the browser supports the Region Capture API (CropTarget + cropTo). */
  isCropSupported: boolean;

  /** Whether the current capture stream is actively cropped. */
  isCropped: boolean;

  /**
   * Crops the captured tab stream to the content area, excluding the overlay.
   * The contentElement should be the root content area of the page (excluding
   * the Zule overlay).
   *
   * @param track - The video track from getDisplayMedia (must be tab capture).
   * @param contentElement - The DOM element representing the content area to crop to.
   * @returns true if cropping succeeded, false otherwise.
   */
  cropToContent: (
    track: MediaStreamTrack,
    contentElement: Element,
  ) => Promise<boolean>;

  /**
   * Removes the crop, restoring the full captured tab view.
   *
   * @param track - The video track that was previously cropped.
   * @returns true if uncrop succeeded, false otherwise.
   */
  uncrop: (track: MediaStreamTrack) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

/**
 * useTabCrop — provides crop-to-content-area functionality for tab capture.
 *
 * Uses the experimental BrowserCaptureMediaStreamTrack.cropTo API to exclude
 * the Zule overlay region from the captured stream. This only works when:
 * 1. The browser supports CropTarget (Chromium-based, behind flag)
 * 2. The capture is a tab capture (not window or entire screen)
 * 3. The video track exposes the cropTo method
 *
 * When unsupported, `isCropSupported` is false and crop functions are no-ops
 * that return false.
 */
export function useTabCrop(): UseTabCropResult {
  const [isCropped, setIsCropped] = useState(false);
  const activeCropRef = useRef<boolean>(false);
  const isCropSupported = isCropToContentSupported();

  const cropToContent = useCallback(
    async (track: MediaStreamTrack, contentElement: Element): Promise<boolean> => {
      // Graceful degradation: if unsupported, return false
      if (!isCropSupported) {
        return false;
      }

      // Verify the track supports cropTo (tab capture only)
      if (!isCroppableTrack(track)) {
        return false;
      }

      try {
        await cropToContentArea(track, contentElement);
        activeCropRef.current = true;
        setIsCropped(true);
        return true;
      } catch (error: unknown) {
        // cropTo can fail if:
        // - The track is not from tab capture
        // - The element is not in the captured tab
        // - The browser implementation throws for other reasons
        console.warn('[useTabCrop] cropToContent failed:', error);
        setIsCropped(false);
        return false;
      }
    },
    [isCropSupported],
  );

  const uncrop = useCallback(
    async (track: MediaStreamTrack): Promise<boolean> => {
      if (!isCroppableTrack(track)) {
        return false;
      }

      try {
        await removeCrop(track);
        activeCropRef.current = false;
        setIsCropped(false);
        return true;
      } catch (error: unknown) {
        console.warn('[useTabCrop] uncrop failed:', error);
        return false;
      }
    },
    [],
  );

  return {
    isCropSupported,
    isCropped,
    cropToContent,
    uncrop,
  };
}
