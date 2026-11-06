import type { ShapeElement } from './types';
import { SLIDE_H, SLIDE_W } from './types';
import { newShape } from './defaults';

/** Quick Draw (⌥⇧ + drag): a red 2px outline rectangle with a transparent inside and square corners. */
export const QUICK_DRAW_COLOR = '#FF0000';
export const QUICK_DRAW_WIDTH = 2;
/** Boxes whose width or height is below this (slide px) are treated as an accidental drag and not created. */
export const QUICK_DRAW_MIN = 6;

export interface QuickBox { x: number; y: number; w: number; h: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The normalized, slide-clamped box spanned by the drag start and the current point. */
export function quickDrawBox(a: { x: number; y: number }, b: { x: number; y: number }): QuickBox {
  const x1 = clamp(Math.min(a.x, b.x), 0, SLIDE_W), x2 = clamp(Math.max(a.x, b.x), 0, SLIDE_W);
  const y1 = clamp(Math.min(a.y, b.y), 0, SLIDE_H), y2 = clamp(Math.max(a.y, b.y), 0, SLIDE_H);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export const isQuickDrawBigEnough = (b: QuickBox) => b.w >= QUICK_DRAW_MIN && b.h >= QUICK_DRAW_MIN;

/** An ordinary Rectangle ShapeElement, so selection, styling, export and persistence need nothing new. */
export function newQuickDrawRect(b: QuickBox): ShapeElement {
  const el = newShape('rect', Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h));
  el.fill = null;
  el.stroke = QUICK_DRAW_COLOR;
  el.strokeWidth = QUICK_DRAW_WIDTH;
  el.radius = 0;
  return el;
}
