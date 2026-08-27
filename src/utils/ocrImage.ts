// ============================================
// Zule AI — OCR a captured still image
// ============================================
//
// The OCR worker (`recognizeText`) accepts a canvas or a video element, because
// every existing caller OCRs the live `getDisplayMedia` frame. The native
// capture paths do not produce either: `captureDesktopBitBlt` returns a
// base64-encoded JPEG, and so does Phone Camera Input.
//
// That gap has a visible consequence. When UI Automation fails to yield text,
// the capture chain falls through to BitBlt, which succeeds — and hands back an
// image. Against a vision adapter that is fine. Against a text-only model
// (Nemotron, most local Ollama builds) the image is dropped before dispatch, so
// a capture that *worked* still arrives at the model as an empty prompt and the
// answer comes back as "no conversation context was included". The image was
// never unusable; there was simply no route from it to text.
//
// This module is that route: decode → canvas → existing OCR worker.

import { recognizeText } from '../workers/ocrWorker';

/**
 * OCR a base64-encoded still image.
 *
 * Resolves to trimmed text, or `''` on any failure (undecodable data, no 2D
 * context, OCR error). Never throws — callers are on a capture fallback path
 * where the correct response to failure is to try the next source, not to
 * unwind the dispatch.
 *
 * Note this is genuinely expensive: a full-resolution desktop frame is a large
 * Tesseract job. It belongs only where the alternative is no screen text at all.
 */
export async function ocrBase64Image(
  base64: string,
  mimeType = 'image/jpeg',
  language = 'eng',
): Promise<string> {
  if (!base64) return '';
  if (typeof document === 'undefined') return '';

  try {
    const canvas = await decodeToCanvas(base64, mimeType);
    if (!canvas) return '';

    const text = await recognizeText(canvas, language);
    return (text ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Decode base64 image data onto a canvas sized to the image's natural pixel
 * dimensions. Returns `null` if the data will not decode.
 *
 * Deliberately does not downscale. Tesseract accuracy on small UI text degrades
 * quickly with resolution, and the whole point of reaching this path is that
 * this OCR pass is the only remaining source of the question text.
 */
async function decodeToCanvas(
  base64: string,
  mimeType: string,
): Promise<HTMLCanvasElement | null> {
  const image = new Image();
  const decoded = new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
  });
  image.src = `data:${mimeType};base64,${base64}`;

  if (!(await decoded)) return null;

  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.drawImage(image, 0, 0);
  return canvas;
}
