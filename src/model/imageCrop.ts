import type { Box, ImageCrop, ImageElement } from './types';

// Crop math works with two rectangles in slide coordinates:
//   F (frame)  = the element box, i.e. what is visible
//   R (source) = where the whole original image would be drawn at the current scale
// crop = position/size of F inside R, as fractions of R.

export const FULL_CROP: ImageCrop = { x: 0, y: 0, w: 1, h: 1 };
const MIN_FRAME = 12;

export const cropOf = (el: ImageElement): ImageCrop => el.crop ?? FULL_CROP;

export const isCropped = (c: ImageCrop | undefined) =>
  !!c && (c.x > 1e-4 || c.y > 1e-4 || c.w < 1 - 1e-4 || c.h < 1 - 1e-4);

/** Full-image rectangle R for an element. */
export function sourceRect(f: Box, c: ImageCrop): Box {
  const w = f.w / c.w, h = f.h / c.h;
  return { x: f.x - c.x * w, y: f.y - c.y * h, w, h };
}

/** Crop of frame F inside full-image rectangle R. Uncropped results are stored as `undefined`. */
export function cropFrom(f: Box, r: Box): ImageCrop | undefined {
  const c = { x: (f.x - r.x) / r.w, y: (f.y - r.y) / r.h, w: f.w / r.w, h: f.h / r.h };
  return isCropped(c) ? c : undefined;
}

/** Keep the frame inside the image: R must cover F (grow R if needed, then slide it). */
export function coverFrame(f: Box, r: Box): Box {
  let { x, y, w, h } = r;
  const k = Math.max(1, f.w / w, f.h / h);
  if (k > 1) {
    // Scale about the frame center so the image doesn't jump.
    const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
    x = cx - (cx - x) * k; y = cy - (cy - y) * k; w *= k; h *= k;
  }
  x = Math.min(f.x, Math.max(x, f.x + f.w - w));
  y = Math.min(f.y, Math.max(y, f.y + f.h - h));
  return { x, y, w, h };
}

/** Clamp a frame edge drag (crop) so the frame stays inside the image and keeps a minimum size. */
export function clampFrameToSource(
  f: { x1: number; y1: number; x2: number; y2: number }, r: Box,
  moving: { w: boolean; e: boolean; n: boolean; s: boolean },
) {
  let { x1, y1, x2, y2 } = f;
  if (moving.w) x1 = Math.min(Math.max(x1, r.x), x2 - MIN_FRAME);
  if (moving.e) x2 = Math.max(Math.min(x2, r.x + r.w), x1 + MIN_FRAME);
  if (moving.n) y1 = Math.min(Math.max(y1, r.y), y2 - MIN_FRAME);
  if (moving.s) y2 = Math.max(Math.min(y2, r.y + r.h), y1 + MIN_FRAME);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Effective corner radius (px): the stored value clamped to half the shorter side, so it never exceeds a full semicircle end. */
export const imageRadius = (el: Pick<ImageElement, 'w' | 'h' | 'radius'>) =>
  Math.max(0, Math.min(el.radius ?? 0, Math.min(el.w, el.h) / 2));

/**
 * OOXML `roundRect` adjustment for the same radius: the preset's corner radius is `min(w, h) * adj / 100000`
 * (adj pinned to 0..50000), which is exactly CSS `border-radius: r` on the element box.
 */
export const roundRectAdj = (el: Pick<ImageElement, 'w' | 'h' | 'radius'>) =>
  Math.round((imageRadius(el) / Math.min(el.w, el.h)) * 100000);

/** Default value (px) of the Corner Radius preset button. Single value; a Settings preference can later replace it. */
export const DEFAULT_RADIUS_PRESET = 50;
