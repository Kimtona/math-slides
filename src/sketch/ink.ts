/**
 * Measurements from the source image's pixels, used where a small local model's description is too coarse
 * (FullDuplex sketch, docs/SKETCH_DEVLOG.md stage 7):
 *
 * - Colored strokes of shapes (e.g. a lime highlighter loop around a word): the real ink color and stroke thickness are
 *   measured along the shape's outline. A light, thick, saturated stroke is a highlighter. Nothing is measured → nothing
 *   is changed (no color is invented).
 * - Straight arrows/lines the model did not mark as curved: if the dark ink between the endpoints consistently bulges
 *   away from the straight chord, the point in the middle of the stroke becomes the curve's `via` (control point). A
 *   control point or bend the model gave itself is never overwritten.
 *
 * Pure functions over an RGBA raster, so they run in the app (canvas) and in headless tests alike.
 */
import type { IRElement, IRIssue, SketchIR } from './ir';
import { IR_SCALE } from './ir';

export interface Raster { data: Uint8Array | Uint8ClampedArray; width: number; height: number }

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');

function px(img: Raster, x: number, y: number): [number, number, number] | null {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return null;
  const i = (yi * img.width + xi) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

/** Paper color: median of a sparse grid (most of a sketch is paper). */
function paper(img: Raster): { r: number; g: number; b: number; l: number } {
  const R: number[] = [], G: number[] = [], B: number[] = [];
  const step = Math.max(4, Math.floor(Math.min(img.width, img.height) / 40));
  for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) {
    const p = px(img, x, y)!; R.push(p[0]); G.push(p[1]); B.push(p[2]);
  }
  const r = median(R), g = median(G), b = median(B);
  return { r, g, b, l: lum(r, g, b) };
}

/** A pixel that belongs to colored ink (not paper, not black/gray pen). */
function isColored(p: [number, number, number], bg: ReturnType<typeof paper>) {
  const chroma = Math.max(...p) - Math.min(...p);
  const bgChroma = Math.max(bg.r, bg.g, bg.b) - Math.min(bg.r, bg.g, bg.b);
  const dist = Math.hypot(p[0] - bg.r, p[1] - bg.g, p[2] - bg.b);
  return chroma - bgChroma > 28 && dist > 40;
}
const isDark = (p: [number, number, number], bg: ReturnType<typeof paper>) => lum(...p) < bg.l - 70;

const toPx = (e: IRElement, img: Raster) => ({
  x: (e.bbox.x / IR_SCALE) * img.width, y: (e.bbox.y / IR_SCALE) * img.height,
  w: (e.bbox.w / IR_SCALE) * img.width, h: (e.bbox.h / IR_SCALE) * img.height,
});

/** Color and thickness of a shape's colored outline, or null when there is no consistent colored stroke. */
export function measureOutline(e: IRElement, img: Raster, bg = paper(img)) {
  const b = toPx(e, img);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, a = b.w / 2, c = b.h / 2;
  if (a < 4 || c < 4) return null;
  const R: number[] = [], G: number[] = [], B: number[] = [], widths: number[] = [];
  let hits = 0, probes = 0;
  const reach = 0.35 * Math.min(a, c); // search band across the outline (hand-drawn loops are not exact ellipses)
  for (let k = 0; k < 120; k++) {
    const t = (k / 120) * 2 * Math.PI;
    // Outline point and outward normal: ellipse, or the bbox rectangle for rect shapes.
    let ox: number, oy: number, nx: number, ny: number;
    if (e.shape === 'ellipse' || !e.shape) {
      ox = cx + a * Math.cos(t); oy = cy + c * Math.sin(t);
      const gx = Math.cos(t) / a, gy = Math.sin(t) / c, gl = Math.hypot(gx, gy);
      nx = gx / gl; ny = gy / gl;
    } else {
      const u = k / 120, per = 2 * (b.w + b.h), d = u * per;
      if (d < b.w) { ox = b.x + d; oy = b.y; nx = 0; ny = -1; }
      else if (d < b.w + b.h) { ox = b.x + b.w; oy = b.y + d - b.w; nx = 1; ny = 0; }
      else if (d < 2 * b.w + b.h) { ox = b.x + b.w - (d - b.w - b.h); oy = b.y + b.h; nx = 0; ny = 1; }
      else { ox = b.x; oy = b.y + b.h - (d - 2 * b.w - b.h); nx = -1; ny = 0; }
    }
    probes++;
    let run = 0, best = 0;
    const cols: [number, number, number][] = [];
    for (let s = -reach; s <= reach; s += 1) {
      const p = px(img, ox + nx * s, oy + ny * s);
      if (p && isColored(p, bg)) { run++; best = Math.max(best, run); cols.push(p); } else run = 0;
    }
    if (best >= 2) {
      hits++; widths.push(best);
      for (const p of cols) { R.push(p[0]); G.push(p[1]); B.push(p[2]); }
    }
  }
  if (hits < probes * 0.4) return null; // no consistent colored stroke around this shape
  // The stroke's core: the most saturated quarter of its pixels (edges blend with the paper).
  const idx = R.map((_, i) => i).sort((i, j) => (Math.max(R[j], G[j], B[j]) - Math.min(R[j], G[j], B[j])) - (Math.max(R[i], G[i], B[i]) - Math.min(R[i], G[i], B[i])));
  const core = idx.slice(0, Math.max(3, Math.ceil(idx.length / 4)));
  // White balance: photos of paper are often dim (paper ≈ #AFB1AD in the FullDuplex photo); scaling each channel so
  // the measured paper becomes white gives the ink color as it looks on paper, i.e. on a white slide.
  const wb = (v: number, paperV: number) => Math.min(255, (v * 255) / Math.max(1, paperV));
  const r = wb(median(core.map((i) => R[i])), bg.r), g = wb(median(core.map((i) => G[i])), bg.g), bl = wb(median(core.map((i) => B[i])), bg.b);
  return { colorHex: `#${hex(r)}${hex(g)}${hex(bl)}`.toUpperCase(), width: median(widths), lightness: lum(r, g, bl) / 255, coverage: hits / probes };
}

/**
 * Offset of a stroke's middle from its straight chord, from dark pixels between the endpoints (image px, signed along
 * the chord's left normal), or null when the ink does not show a clear, consistent bulge.
 */
export function measureBulge(e: IRElement, img: Raster, bg = paper(img)) {
  if (!e.from || !e.to) return null;
  const p0 = { x: (e.from.x / IR_SCALE) * img.width, y: (e.from.y / IR_SCALE) * img.height };
  const p1 = { x: (e.to.x / IR_SCALE) * img.width, y: (e.to.y / IR_SCALE) * img.height };
  const L = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (L < 20) return null;
  const ux = (p1.x - p0.x) / L, uy = (p1.y - p0.y) / L, nx = -uy, ny = ux;
  // For slices across the chord, the dark ink closest to the chord. A real bend shows as the MIDDLE of the stroke lying
  // further from the chord than its ENDS; a uniform offset only means the model's endpoints are a little off the
  // stroke (a straight stroke), so only the difference counts.
  const at = (t: number) => {
    const bx = p0.x + ux * L * t, by = p0.y + uy * L * t;
    for (let d = 0; d <= 0.6 * L; d += 1) {
      for (const sgn of d === 0 ? [1] : [1, -1]) {
        const p = px(img, bx + nx * d * sgn, by + ny * d * sgn);
        if (p && isDark(p, bg)) return d * sgn;
      }
    }
    return null;
  };
  const sample = (ts: number[]) => ts.map(at).filter((v): v is number => v !== null);
  const ends = sample([0.12, 0.16, 0.2, 0.8, 0.84, 0.88]);
  const middle = sample([0.4, 0.45, 0.5, 0.55, 0.6]);
  if (ends.length < 4 || middle.length < 4) return null;
  const base = median(ends), curv = median(middle) - base;
  const consistent = middle.filter((o) => Math.sign(o - base) === Math.sign(curv) && Math.abs(o - base) > 0.05 * L).length;
  if (Math.abs(curv) < Math.max(6, 0.1 * L) || consistent < middle.length * 0.75) return null;
  return { offset: curv, normal: { x: nx, y: ny }, chord: L };
}

/** Applies the measurements to the IR (returns a new IR) and says what was measured. */
export function applyInkMeasurements(ir: SketchIR, img: Raster): { ir: SketchIR; issues: IRIssue[] } {
  const issues: IRIssue[] = [];
  const bg = paper(img);
  const els = ir.elements.map((src) => {
    const e: IRElement = structuredClone(src);
    if (e.kind === 'shape') {
      const m = measureOutline(e, img, bg);
      if (m) {
        e.colorHex = m.colorHex;
        e.inkWidth = m.width;
        // Light + thick + colored = a highlighter, unless the model said otherwise.
        if (!e.pen && m.lightness > 0.5 && m.width >= Math.max(5, 0.008 * Math.min(img.width, img.height))) e.pen = 'highlighter';
        issues.push({ severity: 'info', code: 'ink', id: e.id, message: `Outline color ${m.colorHex}, ${Math.round(m.width)} px thick (measured from the image)${e.pen === 'highlighter' ? ', highlighter' : ''}.` });
      }
    } else if ((e.kind === 'arrow' || e.kind === 'line') && !e.control && !e.bend) {
      const m = measureBulge(e, img, bg);
      if (m) {
        const mid = { x: (e.from!.x + e.to!.x) / 2, y: (e.from!.y + e.to!.y) / 2 };
        const via = { x: mid.x + (m.normal.x * m.offset * IR_SCALE) / img.width, y: mid.y + (m.normal.y * m.offset * IR_SCALE) / img.height };
        e.control = { x: 2 * via.x - mid.x, y: 2 * via.y - mid.y };
        e.kind = e.kind === 'arrow' ? 'curvedArrow' : 'curve';
        issues.push({ severity: 'info', code: 'ink', id: e.id, message: `Stroke bends ${Math.round(Math.abs(m.offset))} px off its chord in the image: drawn as a curve.` });
      }
    }
    return e;
  });
  return { ir: { ...ir, elements: els }, issues };
}
