import type { ShapeElement } from './types';

/**
 * Block Arrow (두꺼운 화살표): a right-facing filled arrow, a rectangular shaft plus a triangular head.
 * Two proportional parameters, so the arrow keeps its look when the element is resized:
 * - `shaft` — shaft thickness as a fraction of the height
 * - `head`  — arrowhead length as a fraction of the width
 * This file is the single geometry source for the editor, thumbnails, presenter, PDF and PPTX export.
 */
export const BLOCK_ARROW_DEFAULTS = { shaft: 0.5, head: 0.4 } as const;
export const BLOCK_ARROW_SHAFT_RANGE = [0.1, 0.95] as const;
export const BLOCK_ARROW_HEAD_RANGE = [0.1, 0.9] as const;

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
export const clampShaft = (v: number) => clamp(v, BLOCK_ARROW_SHAFT_RANGE);
export const clampHead = (v: number) => clamp(v, BLOCK_ARROW_HEAD_RANGE);

type ArrowLike = Pick<ShapeElement, 'w' | 'h' | 'stroke' | 'strokeWidth' | 'shaft' | 'head'>;

export function blockArrowParams(el: Pick<ShapeElement, 'shaft' | 'head'>) {
  return { shaft: clampShaft(el.shaft ?? BLOCK_ARROW_DEFAULTS.shaft), head: clampHead(el.head ?? BLOCK_ARROW_DEFAULTS.head) };
}

/** Outline vertices (tip on the right, clockwise from the shaft's top-left) of an arrow filling a w × h box. */
export function blockArrowPoints(w: number, h: number, shaft: number, head: number): [number, number][] {
  const top = (h * (1 - shaft)) / 2, bottom = h - top, neck = w * (1 - head);
  return [[0, top], [neck, top], [neck, 0], [w, h / 2], [neck, h], [neck, bottom], [0, bottom]];
}

/** The outline sits inside the element box: the stroke is drawn inward, like the other shapes. */
const inset = (el: ArrowLike) => (el.stroke ? el.strokeWidth : 0) / 2;

/** Outline in element coordinates (what the SVG draws). */
export function blockArrowOutline(el: ArrowLike): [number, number][] {
  const o = inset(el), { shaft, head } = blockArrowParams(el);
  return blockArrowPoints(Math.max(1, el.w - 2 * o), Math.max(1, el.h - 2 * o), shaft, head).map(([x, y]) => [x + o, y + o]);
}

/** Adjustment handle positions in element coordinates: shaft = top edge of the shaft, head = where the head begins (on the axis). */
export function blockArrowHandles(el: ArrowLike) {
  const pts = blockArrowOutline(el);
  const [left, shaftTop] = pts[0], [neck] = pts[1];
  return { shaft: { x: left + (neck - left) * 0.4, y: shaftTop }, head: { x: neck, y: el.h / 2 } };
}

/** Parameters for a handle dragged to element-local point (x, y). */
export function blockArrowFromShaftDrag(el: ArrowLike, y: number) {
  const o = inset(el), h = Math.max(1, el.h - 2 * o);
  return clampShaft(((el.h / 2 - y) * 2) / h);
}
export function blockArrowFromHeadDrag(el: ArrowLike, x: number) {
  const o = inset(el), w = Math.max(1, el.w - 2 * o);
  return clampHead((el.w - o - x) / w);
}
