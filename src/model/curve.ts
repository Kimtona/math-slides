/**
 * Curved lines / curved arrows: a LineElement with a quadratic Bézier control point (`cx`, `cy`, slide px).
 * Without a control point a line is straight (older files, plain lines and arrows).
 *
 * The control point itself lies off the curve, so the editor's handle sits ON the curve at its middle
 * (t = 0.5); dragging that handle moves the control point to keep the curve's middle under the pointer.
 */
import type { LineElement } from './types';

export interface Pt { x: number; y: number }

type Ends = Pick<LineElement, 'x1' | 'y1' | 'x2' | 'y2'>;
type MaybeCurve = Ends & Partial<Pick<LineElement, 'cx' | 'cy'>>;

/** Default bend of a new curve: control point offset from the chord's midpoint, as a fraction of the chord length. */
export const DEFAULT_BEND = 0.5;

export const isCurved = (l: MaybeCurve): l is Ends & { cx: number; cy: number } =>
  typeof l.cx === 'number' && typeof l.cy === 'number' && Number.isFinite(l.cx) && Number.isFinite(l.cy);

/** Point on the quadratic Bézier p0–c–p2 at t. */
export function quadAt(p0: Pt, c: Pt, p2: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p2.y };
}

/** Middle of the curve (t = 0.5): where the bend handle is drawn. */
export const curveMid = (l: Ends & { cx: number; cy: number }): Pt =>
  quadAt({ x: l.x1, y: l.y1 }, { x: l.cx, y: l.cy }, { x: l.x2, y: l.y2 }, 0.5);

/** Control point that puts the curve's middle (t = 0.5) at `m`. */
export const controlFromMid = (p0: Pt, p2: Pt, m: Pt): Pt => ({ x: 2 * m.x - (p0.x + p2.x) / 2, y: 2 * m.y - (p0.y + p2.y) / 2 });

/**
 * Control point bending the chord p0→p2 to one side: `bend` is the control point's distance from the chord midpoint as
 * a fraction of the chord length (the curve's middle then lies at half that distance). Positive bends to the LEFT
 * of the direction of travel on screen (y down): for a left-to-right chord, upwards.
 */
export function bendControl(p0: Pt, p2: Pt, bend = DEFAULT_BEND): Pt {
  const dx = p2.x - p0.x, dy = p2.y - p0.y;
  // Left normal of (dx, dy) in screen coordinates (y grows downward) is (dy, -dx).
  return { x: (p0.x + p2.x) / 2 + dy * bend, y: (p0.y + p2.y) / 2 - dx * bend };
}

/** Exact bounding box of the quadratic Bézier (endpoints plus the per-axis extremum, if inside 0..1). */
export function quadBounds(p0: Pt, c: Pt, p2: Pt) {
  const xs = [p0.x, p2.x], ys = [p0.y, p2.y];
  for (const axis of ['x', 'y'] as const) {
    const den = p0[axis] - 2 * c[axis] + p2[axis];
    if (Math.abs(den) < 1e-9) continue;
    const t = (p0[axis] - c[axis]) / den;
    if (t > 0 && t < 1) (axis === 'x' ? xs : ys).push(quadAt(p0, c, p2, t)[axis]);
  }
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Bounding box of a straight or curved line. */
export function curveBox(l: MaybeCurve) {
  if (!isCurved(l)) return { x: Math.min(l.x1, l.x2), y: Math.min(l.y1, l.y2), w: Math.abs(l.x2 - l.x1), h: Math.abs(l.y2 - l.y1) };
  return quadBounds({ x: l.x1, y: l.y1 }, { x: l.cx, y: l.cy }, { x: l.x2, y: l.y2 });
}

/**
 * When an endpoint moves, the control point follows the similarity transform (move + rotate + scale) that maps the old
 * chord onto the new one, so the curve keeps its bend direction and relative depth instead of warping.
 */
export function reframeControl(old: Ends, c: Pt, next: Ends): Pt {
  const ox = old.x2 - old.x1, oy = old.y2 - old.y1;
  const len2 = ox * ox + oy * oy;
  if (len2 < 1e-9) return { x: c.x + next.x1 - old.x1, y: c.y + next.y1 - old.y1 };
  // c in the old chord's frame: along (a) and across (b), as fractions of the chord vector.
  const rx = c.x - old.x1, ry = c.y - old.y1;
  const a = (rx * ox + ry * oy) / len2, b = (ry * ox - rx * oy) / len2;
  const nx = next.x2 - next.x1, ny = next.y2 - next.y1;
  return { x: next.x1 + a * nx - b * ny, y: next.y1 + a * ny + b * nx };
}

/** Control points of the part of p0–c–p2 between t0 and t1 (still a quadratic Bézier). */
export function quadSegment(p0: Pt, c: Pt, p2: Pt, t0: number, t1: number): [Pt, Pt, Pt] {
  const a = quadAt(p0, c, p2, t0), b = quadAt(p0, c, p2, t1);
  // Derivative at t0 is 2[(1-t0)(c-p0) + t0(p2-c)]; the segment's control point is a + (t1-t0)/2 * B'(t0).
  const k = t1 - t0;
  const d = { x: (1 - t0) * (c.x - p0.x) + t0 * (p2.x - c.x), y: (1 - t0) * (c.y - p0.y) + t0 * (p2.y - c.y) };
  return [a, { x: a.x + k * d.x, y: a.y + k * d.y }, b];
}

/** Parameter t at which the curve is `dist` px (arc length) away from its start (fromEnd: from its end). */
export function tAtDistance(p0: Pt, c: Pt, p2: Pt, dist: number, fromEnd = false): number {
  const N = 64;
  let acc = 0, prev = quadAt(p0, c, p2, fromEnd ? 1 : 0);
  for (let i = 1; i <= N; i++) {
    const t = fromEnd ? 1 - i / N : i / N;
    const p = quadAt(p0, c, p2, t);
    const seg = Math.hypot(p.x - prev.x, p.y - prev.y);
    if (acc + seg >= dist) {
      const f = seg ? (dist - acc) / seg : 0;
      const tPrev = fromEnd ? 1 - (i - 1) / N : (i - 1) / N;
      return tPrev + (t - tPrev) * f;
    }
    acc += seg; prev = p;
  }
  return fromEnd ? 0 : 1;
}

/** Unit tangent direction pointing OUT of the curve at its end (atStart: out of its start). */
export function endTangent(p0: Pt, c: Pt, p2: Pt, atStart = false): Pt {
  // A control point on top of the endpoint has no tangent there: fall back to the chord.
  let dx = atStart ? p0.x - c.x : p2.x - c.x, dy = atStart ? p0.y - c.y : p2.y - c.y;
  if (Math.hypot(dx, dy) < 1e-6) { dx = atStart ? p0.x - p2.x : p2.x - p0.x; dy = atStart ? p0.y - p2.y : p2.y - p0.y; }
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}
