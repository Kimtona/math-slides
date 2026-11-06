import type { CSSProperties } from 'react';
import { CAPTION_GAP } from './typography';
import { SLIDE_W, type SlideElement } from './types';

/** Narrowest caption box under a line (vertical / very short lines would otherwise wrap one letter per row). */
export const LINE_CAPTION_MIN_W = 120;

/** Generated / structure-managed text boxes are rewritten automatically, so they take no caption. */
export const canCaption = (el: SlideElement) => !(el.type === 'text' && el.role);

/**
 * Per-element placement of the caption box, relative to the element box. Everything but a line hangs below the box
 * at the box's left edge and width; a line is captioned below its endpoint bounding box (centered, at least
 * LINE_CAPTION_MIN_W wide, kept inside the slide, clear of the stroke / arrowheads).
 */
export function captionBox(el: SlideElement): CSSProperties {
  if (el.type !== 'line') return {};
  const w = Math.max(el.w, LINE_CAPTION_MIN_W);
  const left = Math.min(Math.max(el.x + (el.w - w) / 2, 0), SLIDE_W - w) - el.x;
  const clear = el.arrowStart || el.arrowEnd ? Math.max(5, el.strokeWidth * 1.8) : el.strokeWidth / 2; // = arrowSize(...).half
  return { left, width: w, marginTop: CAPTION_GAP + clear };
}
