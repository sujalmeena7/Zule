// ============================================
// Zule AI — Crop-to-Content-Area Utility (Requirement 15.6)
// ============================================
//
// Provides standalone helper functions for the Region Capture API
// (BrowserCaptureMediaStreamTrack.cropTo) to exclude the Zule overlay
// from a captured tab stream.
//
// LIMITATIONS:
//   - This mode applies ONLY to tab capture (getDisplayMedia with
//     displaySurface: "browser"). Window capture and entire-screen
//     capture do NOT support CropTarget/cropTo.
//   - BrowserCaptureMediaStreamTrack.cropTo is an experimental API
//     currently available only in Chromium-based browsers (Chrome 104+).
//   - The CropTarget element must be in the same tab that is being captured.
//   - If the captured tab navigates away, the crop target may become invalid.
//   - cropTo(null) removes the crop and restores the full captured area.
//
// Usage:
//   import { isCropToContentSupported, cropToContentArea, removeCrop } from './cropToContent';
//
//   if (isCropToContentSupported()) {
//     const videoTrack = stream.getVideoTracks()[0];
//     await cropToContentArea(videoTrack, document.getElementById('main-content')!);
//   }

// ---------------------------------------------------------------------------
// TypeScript declarations for the experimental Region Capture API
// ---------------------------------------------------------------------------

/**
 * A CropTarget represents an element that defines the visible crop area
 * for a captured tab stream. Created via CropTarget.fromElement().
 */
interface CropTarget {
  readonly __brand: 'CropTarget';
}

interface CropTargetConstructor {
  fromElement(element: Element): Promise<CropTarget>;
}

/**
 * Extension of MediaStreamTrack that includes the experimental cropTo method.
 * Available only on video tracks obtained from getDisplayMedia tab capture.
 */
interface BrowserCaptureMediaStreamTrack extends MediaStreamTrack {
  cropTo(cropTarget: CropTarget | null): Promise<void>;
}

// Augment the global scope for the experimental CropTarget constructor
declare global {
  // eslint-disable-next-line no-var
  var CropTarget: CropTargetConstructor | undefined;
}

// ---------------------------------------------------------------------------
// Feature Detection
// ---------------------------------------------------------------------------

/**
 * Checks whether the browser supports the Region Capture API
 * (CropTarget constructor + cropTo on BrowserCaptureMediaStreamTrack).
 *
 * This checks for the presence of the `CropTarget` global which is a
 * necessary precondition. Full support can only be confirmed at runtime
 * when a captured video track is available and exposes `cropTo`.
 *
 * @returns true if the CropTarget API is available in the current environment.
 */
export function isCropToContentSupported(): boolean {
  if (typeof globalThis === 'undefined') return false;
  return typeof globalThis.CropTarget !== 'undefined';
}

/**
 * Checks whether a given MediaStreamTrack has the `cropTo` method,
 * confirming it is a BrowserCaptureMediaStreamTrack from tab capture.
 *
 * @param track - The MediaStreamTrack to check.
 * @returns true if the track supports cropTo (i.e., is from tab capture).
 */
export function isCroppableTrack(
  track: MediaStreamTrack,
): track is BrowserCaptureMediaStreamTrack {
  return typeof (track as BrowserCaptureMediaStreamTrack).cropTo === 'function';
}

// ---------------------------------------------------------------------------
// Crop Operations
// ---------------------------------------------------------------------------

/**
 * Crops the captured tab stream to the bounding box of the given element,
 * effectively excluding everything outside that element (such as the Zule overlay)
 * from the captured video.
 *
 * This uses the experimental `BrowserCaptureMediaStreamTrack.cropTo` API and
 * only works when:
 * 1. The browser supports `CropTarget` (Chromium 104+)
 * 2. The capture is a **tab capture** (displaySurface: "browser")
 * 3. The video track exposes the `cropTo` method
 * 4. The element is visible in the captured tab
 *
 * @param track - The video MediaStreamTrack from getDisplayMedia (must be tab capture).
 * @param element - The DOM element representing the content area to crop to.
 *                  The captured output will show only this element's bounding box.
 *
 * @throws {Error} If the CropTarget API is not supported in the current browser.
 * @throws {Error} If the track does not support cropTo (not a tab capture track).
 * @throws {DOMException} If cropTo fails at the browser level (e.g., element not
 *         in captured tab, track ended, or other browser-level errors).
 */
export async function cropToContentArea(
  track: MediaStreamTrack,
  element: Element,
): Promise<void> {
  if (!isCropToContentSupported() || !globalThis.CropTarget) {
    throw new Error(
      'Region Capture API (CropTarget) is not supported in this browser. ' +
        'This feature requires Chromium 104+ with tab capture.',
    );
  }

  if (!isCroppableTrack(track)) {
    throw new Error(
      'The provided track does not support cropTo. ' +
        'Crop-to-content only works with tab capture tracks ' +
        '(not window or entire-screen capture).',
    );
  }

  const cropTarget = await globalThis.CropTarget.fromElement(element);
  await track.cropTo(cropTarget);
}

/**
 * Removes a previously applied crop from the track, restoring the full
 * captured tab view.
 *
 * @param track - The video track that was previously cropped via cropToContentArea.
 *
 * @throws {Error} If the track does not support cropTo.
 * @throws {DOMException} If the browser-level uncrop operation fails.
 */
export async function removeCrop(track: MediaStreamTrack): Promise<void> {
  if (!isCroppableTrack(track)) {
    throw new Error(
      'The provided track does not support cropTo. Cannot remove crop.',
    );
  }

  await track.cropTo(null);
}
