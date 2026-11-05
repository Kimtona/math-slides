/**
 * IR → ordinary MathSlides elements (text boxes, math blocks, shapes, lines/arrows).
 * Pure and deterministic: the same IR always yields the same layout (only element ids are random).
 *
 * Layout preservation. In the app the sketch is rebuilt INSIDE THE IMAGE'S FRAME on the slide (`frame`): IR coordinates
 * (0..1000 of the visible, cropped image) map linearly onto the frame, so elements land where they were drawn and
 * the rest of the slide is untouched; a stretched image (frame aspect ≠ image aspect) maps x and y separately, like
 * the picture itself. Without a frame (command-line tool) one uniform scale fits the content into the content area.
 * No beautification (alignment/spacing) is applied.
 */
import type { LineElement, PMNode, ShapeElement, SlideElement, TextElement } from '../model/types';
import { SLIDE_H, SLIDE_W } from '../model/types';
import { DEFAULT_TEXT_COLOR, lineBox, newLine, newShape, newText } from '../model/defaults';
import { renderTex } from '../math/mathjax';
import type { IRBox, IRColor, IRElement, IRIssue, IRPoint, SketchIR } from './ir';
import { IR_SCALE } from './ir';

/** Slide area the sketch content is fitted into (keeps a margin and the footer free). */
export const CONTENT_AREA = { x: 48, y: 40, w: SLIDE_W - 96, h: SLIDE_H - 96 };
const LINE_HEIGHT = 1.35;
const MIN_FONT = 16;
const MAX_FONT = 72;
const MIN_MATH_FONT = 20;
/** Gap between an arrow tip and the shape boundary it points at (px). */
const CONNECT_GAP = 4;

export const INK: Record<IRColor, string> = {
  black: DEFAULT_TEXT_COLOR,
  blue: '#1F77B4',
  red: '#D62728',
  green: '#2CA02C',
  gray: '#404040',
};

export interface Placement {
  /** slide px per source-image px, per axis (equal unless the image is stretched) */
  sx: number;
  sy: number;
  /** slide position of source pixel (0,0) */
  ox: number;
  oy: number;
  /** source image px per IR unit */
  ux: number;
  uy: number;
  /** Area the elements are kept inside: the image frame, or the slide's content area. */
  area: Frame;
}

/** A rectangle on the slide (the image element's x/y/w/h). */
export interface Frame { x: number; y: number; w: number; h: number }

export interface ConversionResult {
  elements: SlideElement[];
  /** IR element id → ids of the slide elements created from it (merged labels map to their shape). */
  map: Record<string, string[]>;
  placement: Placement;
  issues: IRIssue[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Whole slide with a small margin (the area when there is no image frame). */
const SLIDE_AREA: Frame = { x: 8, y: 8, w: SLIDE_W - 16, h: SLIDE_H - 16 };
const round = (v: number) => Math.round(v);

/**
 * With `frame`: the image's frame on the slide (IR 0..1000 → frame edges). Without: uniform scale from the union of
 * all element boxes into CONTENT_AREA.
 */
export function computePlacement(ir: SketchIR, frame?: Frame): Placement {
  const ux = ir.image.width / IR_SCALE, uy = ir.image.height / IR_SCALE;
  if (frame) {
    const sx = frame.w / ir.image.width, sy = frame.h / ir.image.height;
    return { sx, sy, ox: frame.x, oy: frame.y, ux, uy, area: frame };
  }
  const boxes = ir.elements.map((e) => e.bbox);
  let minX = 0, minY = 0, maxX = IR_SCALE, maxY = IR_SCALE;
  if (boxes.length) {
    minX = Math.min(...boxes.map((b) => b.x)); minY = Math.min(...boxes.map((b) => b.y));
    maxX = Math.max(...boxes.map((b) => b.x + b.w)); maxY = Math.max(...boxes.map((b) => b.y + b.h));
  }
  const cw = Math.max(1, (maxX - minX) * ux), ch = Math.max(1, (maxY - minY) * uy);
  // Text boxes are usually wider than handwriting; leave some room so the fitted layout rarely needs nudging.
  const s = Math.min((CONTENT_AREA.w * 0.94) / cw, (CONTENT_AREA.h * 0.94) / ch);
  const hasTitle = ir.elements.some((e) => e.role === 'title');
  const ox = CONTENT_AREA.x + (CONTENT_AREA.w - cw * s) / 2 - minX * ux * s;
  // With a title the sketch reads top-down like a slide: start at the top. A bare diagram is centered.
  const oy = (hasTitle ? CONTENT_AREA.y : CONTENT_AREA.y + (CONTENT_AREA.h - ch * s) / 2) - minY * uy * s;
  return { sx: s, sy: s, ox, oy, ux, uy, area: SLIDE_AREA };
}

export const mapPoint = (p: IRPoint, pl: Placement) => ({ x: pl.ox + p.x * pl.ux * pl.sx, y: pl.oy + p.y * pl.uy * pl.sy });
export function mapBox(b: IRBox, pl: Placement) {
  const tl = mapPoint(b, pl);
  return { x: tl.x, y: tl.y, w: b.w * pl.ux * pl.sx, h: b.h * pl.uy * pl.sy };
}

// ---------- text ----------

/** Rough rendered width of a string in em (Hangul/CJK ≈ 1em, Latin ≈ 0.55em). Deterministic; deliberately generous. */
export function textWidthEm(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x1100 && (c <= 0x11ff || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef))) w += 1;
    else if (ch === ' ') w += 0.3;
    else if (/[A-Z0-9MW]/.test(ch)) w += 0.66;
    else if (/[il.,:;'|!]/.test(ch)) w += 0.3;
    else w += 0.56;
  }
  return w;
}

/** Splits `a $x^2$ b` into text and inline-math nodes. Unbalanced `$` stays literal text. */
export function inlineNodes(line: string): PMNode[] {
  const nodes: PMNode[] = [];
  const re = /\$([^$]+)\$/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) nodes.push({ type: 'text', text: line.slice(last, m.index) });
    nodes.push({ type: 'mathInline', attrs: { latex: m[1].trim() } });
    last = m.index + m[0].length;
  }
  if (last < line.length) nodes.push({ type: 'text', text: line.slice(last) });
  return nodes;
}

export function textToSketchDoc(text: string): PMNode {
  const lines = text.replace(/\r/g, '').split('\n');
  return { type: 'doc', content: lines.map((l) => (l ? { type: 'paragraph', content: inlineNodes(l) } : { type: 'paragraph' })) };
}

/** Width of one line in em, measuring inline math with MathJax. */
function lineWidthEm(line: string): number {
  let w = 0;
  for (const n of inlineNodes(line)) {
    if (n.type === 'text') w += textWidthEm(n.text ?? '');
    else {
      const r = renderTex(n.attrs!.latex, false);
      w += 'error' in r && r.error ? textWidthEm(n.attrs!.latex) * 0.6 : (r as any).widthEm;
    }
  }
  return w;
}

const FONT_STEPS = [16, 18, 20, 22, 24, 25, 28, 30, 32, 36, 40, 44, 48, 50, 56, 60, 66, 72];
const snapFont = (v: number) => FONT_STEPS.reduce((best, f) => (Math.abs(f - v) < Math.abs(best - v) ? f : best), FONT_STEPS[0]);

/**
 * Largest font per role. Handwriting is usually much larger than typeset slide text, so a literal size
 * mapping turns a small margin note into a headline; the caps keep the written hierarchy readable.
 */
export const ROLE_MAX_FONT: Record<string, number> = { title: MAX_FONT, label: 60, body: 48, annotation: 40 };

/** Font size from the height of one handwritten line (handwriting ink ≈ 0.8 of the line box). */
export function fontFromInk(lineInkPx: number, role?: string) {
  const min = role === 'title' ? 32 : MIN_FONT;
  return snapFont(clamp(lineInkPx * 0.8, min, ROLE_MAX_FONT[role ?? 'body'] ?? 48));
}

/**
 * Keeps a box inside the placement area (the image frame in the app) and always inside the slide. A box larger than
 * the area (typeset text can be wider than handwriting) is centered on it instead.
 */
function keepInside(b: { x: number; y: number; w: number; h: number }, issues: IRIssue[], id: string, area: Frame) {
  const fit = (pos: number, size: number, lo: number, len: number) => (size <= len ? clamp(pos, lo, lo + len - size) : lo + (len - size) / 2);
  const w = Math.min(b.w, SLIDE_W - 16), h = Math.min(b.h, SLIDE_H - 16);
  let x = fit(b.x, w, area.x, area.w), y = fit(b.y, h, area.y, area.h);
  x = clamp(x, 8, SLIDE_W - 8 - w); y = clamp(y, 8, SLIDE_H - 8 - h);
  if (Math.abs(x - b.x) > 1 || Math.abs(y - b.y) > 1 || w < b.w || h < b.h)
    issues.push({ severity: 'info', code: 'bounds', id, message: `Moved inside the ${area === SLIDE_AREA ? 'slide' : 'image area'} (by ${round(x - b.x)}, ${round(y - b.y)} px).` });
  return { x, y, w, h };
}

function textElement(e: IRElement, pl: Placement, issues: IRIssue[]): TextElement {
  const b = mapBox(e.bbox, pl);
  const text = (e.text ?? '').trim();
  const lines = text.split('\n');
  let fontSize = fontFromInk(b.h / lines.length, e.role);
  const align: TextElement['style']['align'] = e.role === 'annotation' || e.role === 'label' ? 'center' : 'left';
  const widthEm = Math.max(...lines.map(lineWidthEm));
  // Typeset text is often wider than the handwriting. If it does not fit between its written position and the edge
  // of the placement area, the font gets smaller instead of the box being pushed sideways onto its neighbours
  // (real GUI run: a right-hand note moved 107 px left over the left-hand note).
  const a = pl.area, cx = b.x + b.w / 2;
  const room = align === 'center' ? 2 * Math.min(cx - a.x, a.x + a.w - cx) : a.x + a.w - b.x;
  if (widthEm * fontSize * 1.06 + 8 > room && room > 8) {
    const fitted = Math.max(MIN_FONT, Math.floor((room - 8) / (widthEm * 1.06)));
    if (fitted < fontSize) {
      issues.push({ severity: 'info', code: 'fit', id: e.id, message: `Font reduced from ${fontSize} to ${fitted} px to keep the text in place inside the image area.` });
      fontSize = fitted;
    }
  }
  const contentW = widthEm * fontSize;
  // The written box, widened to what the typeset text needs (never narrowed: wrapping changes the layout).
  const w = Math.max(b.w, contentW * 1.06 + 8);
  const h = lines.length * fontSize * LINE_HEIGHT;
  // Centered text keeps its written center; left-aligned text keeps its written left edge.
  const x = align === 'center' ? b.x + b.w / 2 - w / 2 : b.x;
  const y = b.y + b.h / 2 - h / 2;
  const box = keepInside({ x, y, w, h }, issues, e.id, pl.area);
  const el = newText(round(box.x), round(box.y), {
    w: round(box.w),
    doc: textToSketchDoc(text),
    style: { fontSize, align, color: INK[e.color ?? 'black'] },
  });
  el.h = round(box.h);
  return el;
}

function mathElement(e: IRElement, pl: Placement, issues: IRIssue[]): TextElement {
  const b = mapBox(e.bbox, pl);
  const latex = e.latex ?? '';
  const r = renderTex(latex, true);
  let fontSize: number, w: number, h: number;
  if ('error' in r && r.error) {
    issues.push({ severity: 'error', code: 'latex', id: e.id, message: `LaTeX does not render: ${r.error}` });
    fontSize = snapFont(clamp(b.h / 1.6, MIN_MATH_FONT, MAX_FONT));
    w = b.w; h = b.h;
  } else {
    const m = r as { widthEm: number; heightEm: number };
    // Fit the typeset equation to the written one: the smaller of the width and height fits wins
    // (handwriting is usually taller than typeset math, so height gets some slack).
    const byW = b.w / m.widthEm, byH = (b.h * 1.15) / m.heightEm;
    fontSize = round(clamp(Math.min(byW, byH), MIN_MATH_FONT, MAX_FONT));
    w = m.widthEm * fontSize + 24;
    h = (m.heightEm + 0.3) * fontSize;
  }
  const box = keepInside({ x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h }, issues, e.id, pl.area);
  const el = newText(round(box.x), round(box.y), {
    w: round(box.w),
    doc: { type: 'doc', content: [{ type: 'mathBlock', attrs: { latex } }] },
    style: { fontSize, align: 'center', color: INK[e.color ?? 'black'] },
  });
  el.h = round(box.h);
  return el;
}

function shapeElement(e: IRElement, label: IRElement | undefined, pl: Placement, issues: IRIssue[]): ShapeElement {
  const b = keepInside(mapBox(e.bbox, pl), issues, e.id, pl.area);
  const el = newShape(e.shape ?? 'rect', round(b.x), round(b.y), round(Math.max(8, b.w)), round(Math.max(8, b.h)));
  // Hand-drawn shapes are outlines in the pen color.
  el.fill = null;
  el.stroke = INK[e.color ?? 'black'];
  el.strokeWidth = 3;
  const text = (label?.text ?? e.text ?? '').trim();
  if (text) {
    const ink = label ? mapBox(label.bbox, pl).h / text.split('\n').length : b.h * 0.35;
    el.doc = textToSketchDoc(text);
    el.textStyle = { fontSize: fontFromInk(ink, 'label'), color: INK[label?.color ?? e.color ?? 'black'], align: 'center', lineHeight: LINE_HEIGHT, fill: null };
  }
  return el;
}

/** Point where the ray from the shape's center towards `p` leaves the shape (plus a small gap). */
export function boundaryPoint(shape: ShapeElement, p: { x: number; y: number }) {
  const cx = shape.x + shape.w / 2, cy = shape.y + shape.h / 2;
  const dx = p.x - cx, dy = p.y - cy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return p;
  const ux = dx / len, uy = dy / len;
  const a = shape.w / 2, b = shape.h / 2;
  const t = shape.shape === 'ellipse'
    ? 1 / Math.sqrt((ux * ux) / (a * a) + (uy * uy) / (b * b))
    : Math.min(Math.abs(ux) > 1e-9 ? a / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-9 ? b / Math.abs(uy) : Infinity);
  return { x: cx + ux * (t + CONNECT_GAP), y: cy + uy * (t + CONNECT_GAP) };
}

function lineElement(e: IRElement, pl: Placement, shapes: Map<string, ShapeElement>): LineElement {
  let p1 = mapPoint(e.from!, pl), p2 = mapPoint(e.to!, pl);
  // Connectors: an endpoint attached to a shape starts/ends on its outline, in the drawn direction.
  const s1 = e.fromId ? shapes.get(e.fromId) : undefined;
  const s2 = e.toId ? shapes.get(e.toId) : undefined;
  if (s1) p1 = boundaryPoint(s1, p2);
  if (s2) p2 = boundaryPoint(s2, p1);
  const a = pl.area;
  const inside = (p: { x: number; y: number }) => ({ x: clamp(clamp(p.x, a.x, a.x + a.w), 4, SLIDE_W - 4), y: clamp(clamp(p.y, a.y, a.y + a.h), 4, SLIDE_H - 4) });
  p1 = inside(p1); p2 = inside(p2);
  const el = newLine(round(p1.x), round(p1.y), round(p2.x), round(p2.y), e.kind === 'arrow');
  el.stroke = INK[e.color ?? 'black'];
  Object.assign(el, lineBox(el));
  return el;
}

/** Text written inside a shape becomes the shape's own text instead of a separate box. */
function insideTarget(e: IRElement, ir: SketchIR): string | undefined {
  if (e.kind !== 'text') return undefined;
  const rel = e.relations?.find((r) => r.type === 'inside');
  if (!rel) return undefined;
  const target = ir.elements.find((t) => t.id === rel.target);
  return target?.kind === 'shape' && !target.text?.trim() ? target.id : undefined;
}

/** frame: the source image's x/y/w/h on the slide (the app); omit to fit the content into the slide (CLI). */
export function irToElements(ir: SketchIR, frame?: Frame): ConversionResult {
  const issues: IRIssue[] = [];
  const pl = computePlacement(ir, frame);
  const map: Record<string, string[]> = {};
  const labels = new Map<string, IRElement>(); // shape id → its label
  const absorbed = new Set<string>();
  for (const e of ir.elements) {
    const t = insideTarget(e, ir);
    if (t && !labels.has(t)) { labels.set(t, e); absorbed.add(e.id); }
  }
  const shapes = new Map<string, ShapeElement>();
  const out: { z: number; el: SlideElement }[] = [];
  for (const e of ir.elements) {
    if (e.kind !== 'shape') continue;
    const label = labels.get(e.id);
    const el = shapeElement(e, label, pl, issues);
    shapes.set(e.id, el);
    map[e.id] = [el.id];
    if (label) map[label.id] = [el.id];
    out.push({ z: 0, el });
  }
  for (const e of ir.elements) {
    if (e.kind === 'shape' || absorbed.has(e.id)) continue;
    let el: SlideElement;
    if (e.kind === 'arrow' || e.kind === 'line') el = lineElement(e, pl, shapes);
    else if (e.kind === 'math') el = mathElement(e, pl, issues);
    else el = textElement(e, pl, issues);
    map[e.id] = [el.id];
    out.push({ z: e.kind === 'arrow' || e.kind === 'line' ? 1 : 2, el });
  }
  // Stable z-order: shapes, then connectors, then text on top.
  out.sort((a, b) => a.z - b.z);
  return { elements: out.map((o) => o.el), map, placement: pl, issues };
}
