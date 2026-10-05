import type { Box, SlideElement } from './types';
import { SLIDE_H, SLIDE_W } from './types';

export const boxOf = (el: SlideElement): Box => ({ x: el.x, y: el.y, w: el.w, h: el.h });

export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Moves an element by (dx, dy) starting from its original state `o`. Mutates `el`. */
export function translate(el: SlideElement, o: SlideElement, dx: number, dy: number) {
  el.x = o.x + dx;
  el.y = o.y + dy;
  if (el.type === 'line' && o.type === 'line') {
    el.x1 = o.x1 + dx; el.y1 = o.y1 + dy;
    el.x2 = o.x2 + dx; el.y2 = o.y2 + dy;
  }
}

// ---------- snapping ----------

export interface Guide { axis: 'x' | 'y'; pos: number }

export interface SnapTargets { xs: number[]; ys: number[] }

export function snapTargets(others: Box[]): SnapTargets {
  const xs = [0, SLIDE_W / 2, SLIDE_W];
  const ys = [0, SLIDE_H / 2, SLIDE_H];
  for (const b of others) {
    xs.push(b.x, b.x + b.w / 2, b.x + b.w);
    ys.push(b.y, b.y + b.h / 2, b.y + b.h);
  }
  return { xs, ys };
}

/** Finds the smallest offset that aligns any of `values` with any of `targets`. */
export function snap1(values: number[], targets: number[], threshold: number): { delta: number; pos: number } | null {
  let best: { delta: number; pos: number } | null = null;
  for (const v of values) {
    for (const t of targets) {
      const d = t - v;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, pos: t };
    }
  }
  return best;
}

/** Snap a moving box; returns adjusted dx/dy and guide lines to draw. */
export function snapMove(box: Box, t: SnapTargets, threshold: number) {
  const guides: Guide[] = [];
  const sx = snap1([box.x, box.x + box.w / 2, box.x + box.w], t.xs, threshold);
  const sy = snap1([box.y, box.y + box.h / 2, box.y + box.h], t.ys, threshold);
  if (sx) guides.push({ axis: 'x', pos: sx.pos });
  if (sy) guides.push({ axis: 'y', pos: sy.pos });
  return { dx: sx?.delta ?? 0, dy: sy?.delta ?? 0, guides };
}
