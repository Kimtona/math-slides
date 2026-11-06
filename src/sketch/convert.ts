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
import type { LineElement, PMNode, ShapeElement, SlideElement, TableElement, TextElement } from '../model/types';
import { SLIDE_H, SLIDE_W } from '../model/types';
import { DEFAULT_TEXT_COLOR, emptyDoc, headingSize, lineBox, newLine, newShape, newText } from '../model/defaults';
import { estimateTableHeight, newTable, repairTable, scaleCols, TABLE_CELL_PAD_X, TABLE_CELL_PAD_Y } from '../model/table';
import { renderTex } from '../math/mathjax';
import type { IRBlock, IRBox, IRColor, IRElement, IRIssue, IRPoint, IRSpan, SketchIR } from './ir';
import { hasArrowhead, IR_SCALE, isConnectorKind, spansPlain } from './ir';

/** Slide area the sketch content is fitted into (keeps a margin and the footer free). */
export const CONTENT_AREA = { x: 48, y: 40, w: SLIDE_W - 96, h: SLIDE_H - 96 };
const LINE_HEIGHT = 1.35;
const MIN_FONT = 16;
const MAX_FONT = 72;
const MIN_MATH_FONT = 20;
/** Smallest font a long equation may be scaled to so that it fits its area (below this it is reported). */
const MIN_FIT_MATH_FONT = 10;
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
  /** Document Mode: content that did not fit on the slide continues here, one array per further slide (never cut off). */
  pages?: SlideElement[][];
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

/**
 * Inline-math delimiters accepted in text: `$...$`, `$$...$$`, `\(...\)` and `\[...\]` (models and papers use all of them;
 * the editor's own syntax is `$...$`). The content between delimiters is kept byte for byte.
 */
const INLINE_MATH = /\$\$([^$]+?)\$\$|\$([^$]+?)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;

/** Splits `a $x^2$ b \(y\)` into text and inline-math (`mathInline`) nodes. Unbalanced delimiters stay literal text. */
export function inlineNodes(line: string): PMNode[] {
  const nodes: PMNode[] = [];
  const re = new RegExp(INLINE_MATH.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const latex = (m[1] ?? m[2] ?? m[3] ?? m[4]).trim();
    if (!latex) continue;
    if (m.index > last) nodes.push({ type: 'text', text: line.slice(last, m.index) });
    nodes.push({ type: 'mathInline', attrs: { latex } });
    last = m.index + m[0].length;
  }
  if (last < line.length) nodes.push({ type: 'text', text: line.slice(last) });
  return nodes;
}

export function textToSketchDoc(text: string): PMNode {
  const lines = text.replace(/\r/g, '').split('\n');
  return { type: 'doc', content: lines.map((l) => (l ? { type: 'paragraph', content: inlineNodes(l) } : { type: 'paragraph' })) };
}

// ---------- structure: spans / blocks → the editor's own rich-text nodes (nothing new is invented) ----------

const marksOf = (sp: IRSpan) => {
  const m: { type: string }[] = [];
  if (sp.bold) m.push({ type: 'bold' });
  if (sp.italic) m.push({ type: 'italic' });
  if (sp.strike) m.push({ type: 'strike' });
  if (sp.underline) m.push({ type: 'underline' });
  return m.length ? m : undefined;
};

/** Spans → text nodes carrying real marks (bold/italic/strike/underline); `$...$` inside a span becomes an inline equation node. */
export function spansToNodes(spans: IRSpan[], withMath = true): PMNode[] {
  const out: PMNode[] = [];
  for (const sp of spans) {
    const marks = marksOf(sp);
    const parts: PMNode[] = withMath ? inlineNodes(sp.text) : [{ type: 'text', text: sp.text }];
    for (const n of parts) out.push(n.type === 'text' && marks ? { ...n, marks } : n);
  }
  return out;
}

/** Blocks → ProseMirror doc of the editor: paragraph, blockquote, bulletList/orderedList > listItem, and heading = paragraph with a larger fontSize (as `# ` does). */
export function blocksToDoc(blocks: IRBlock[], baseFont: number): PMNode {
  const para = (spans: IRSpan[], attrs?: Record<string, unknown>): PMNode => {
    const content = spansToNodes(spans);
    return { type: 'paragraph', ...(attrs ? { attrs } : {}), ...(content.length ? { content } : {}) };
  };
  return {
    type: 'doc',
    content: blocks.map((b): PMNode => {
      if ('items' in b) {
        const content = b.items.map((it): PMNode => ({ type: 'listItem', content: [para(it)] }));
        return b.type === 'ordered' ? { type: 'orderedList', attrs: { start: b.start ?? 1 }, content } : { type: 'bulletList', content };
      }
      if (b.type === 'quote') return { type: 'blockquote', content: [para(b.spans)] };
      if (b.type === 'heading') return para(b.spans, { fontSize: Math.max(baseFont, Math.min(headingSize(b.level), Math.round(baseFont * 1.6))) });
      return para(b.spans);
    }),
  };
}

/** Width of one line in em, measuring inline math with MathJax. */
export function lineWidthEm(line: string): number {
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
  // One scale per text line, in the order blocksPlain() writes them: a heading is drawn up to 1.6× the note's font, so its line needs that much room.
  const scales = e.blocks ? e.blocks.flatMap((b) => ('items' in b ? b.items.map(() => 1) : [b.type === 'heading' ? 1.6 : 1])) : [];
  const widthEm = Math.max(...lines.map((l, i) => lineWidthEm(l) * (scales[i] ?? 1))) + (e.blocks?.some((b) => 'items' in b || b.type === 'quote') ? 1.8 : 0); // + list markers / quote bar indent
  // Typeset text is often wider than the handwriting. If it does not fit between its written position and the edge
  // of the placement area, the font gets smaller instead of the box being pushed sideways onto its neighbours
  // (real GUI run: a right-hand note moved 107 px left over the left-hand note).
  const a = pl.area, cx = b.x + b.w / 2;
  const room = align === 'center' ? 2 * Math.min(cx - a.x, a.x + a.w - cx) : a.x + a.w - b.x;
  let wrapTo = 0;
  if (widthEm * fontSize * 1.06 + 8 > room && room > 8) {
    const fitted = Math.floor((room - 8) / (widthEm * 1.06));
    if (fitted >= MIN_FONT && fitted >= fontSize * 0.7) {
      issues.push({ severity: 'info', code: 'fit', id: e.id, message: `Font reduced from ${fontSize} to ${fitted} px to keep the text in place inside the image area.` });
      fontSize = fitted;
    } else {
      // A paragraph (e.g. a paper's body text the model returned as one line): keep the font and wrap it
      // within the area instead of shrinking it to nothing or widening it past the image (PPO capture).
      wrapTo = room;
      issues.push({ severity: 'info', code: 'wrap', id: e.id, message: `Text wraps within the image area (${Math.round(room)} px wide).` });
    }
  }
  const contentW = widthEm * fontSize;
  let w: number, h: number, x: number, y: number;
  if (wrapTo) {
    w = wrapTo;
    const usable = Math.max(1, w - 8);
    const rows = lines.reduce((n, l) => n + Math.max(1, Math.ceil((lineWidthEm(l) * fontSize * 1.06) / usable)), 0);
    h = rows * fontSize * LINE_HEIGHT;
    x = align === 'center' ? cx - w / 2 : b.x;
    y = b.y; // grows downward from where the text starts
  } else {
    // The written box, widened to what the typeset text needs (never narrowed: wrapping changes the layout).
    w = Math.max(b.w, contentW * 1.06 + 8);
    h = lines.length * fontSize * LINE_HEIGHT;
    // Centered text keeps its written center; left-aligned text keeps its written left edge.
    x = align === 'center' ? b.x + b.w / 2 - w / 2 : b.x;
    y = b.y + b.h / 2 - h / 2;
  }
  const box = keepInside({ x, y, w, h }, issues, e.id, pl.area);
  const el = newText(round(box.x), round(box.y), {
    w: round(box.w),
    doc: e.blocks ? blocksToDoc(e.blocks, fontSize) : textToSketchDoc(text),
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
    // Never wider than the placement area: a long display equation (e.g. the PPO objective) is scaled down by its
    // real typeset width (MathJax) instead of running off the slide. The LaTeX itself is never changed.
    const maxW = Math.min(pl.area.w, SLIDE_W - 16) - 24;
    if (m.widthEm * fontSize > maxW) {
      const fitted = Math.max(MIN_FIT_MATH_FONT, Math.floor(maxW / m.widthEm));
      issues.push({ severity: 'info', code: 'fit', id: e.id, message: `Equation scaled from ${fontSize} to ${fitted} px to fit the available width.` });
      fontSize = fitted;
    }
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
  // Hand-drawn shapes are outlines in the pen color: the color measured from the image when available
  // (e.g. a lime highlighter), else the model's named color. A highlighter keeps its thick stroke; shapes are drawn
  // under text and connectors, so the light opaque stroke reads like a marker without needing transparency.
  el.fill = null;
  el.stroke = e.colorHex ?? INK[e.color ?? 'black'];
  const sy = pl.sy;
  if (e.pen === 'highlighter') el.strokeWidth = round(clamp(e.inkWidth ? e.inkWidth * sy : 0.012 * Math.min(pl.area.w, pl.area.h), 4, 28));
  else el.strokeWidth = e.inkWidth ? round(clamp(e.inkWidth * sy, 2, 8)) : 3;
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
  // Curved connector: its control point is mapped like any other point (same image → slide transform).
  const curved = (e.kind === 'curvedArrow' || e.kind === 'curve') && e.control;
  let c = curved ? mapPoint(e.control!, pl) : undefined;
  // Connectors: an endpoint attached to a shape starts/ends on its outline, in the drawn direction
  // (for a curve: towards its control point, i.e. along the curve's tangent at that end).
  const s1 = e.fromId ? shapes.get(e.fromId) : undefined;
  const s2 = e.toId ? shapes.get(e.toId) : undefined;
  if (s1) p1 = boundaryPoint(s1, c ?? p2);
  if (s2) p2 = boundaryPoint(s2, c ?? p1);
  const a = pl.area;
  const inside = (p: { x: number; y: number }) => ({ x: clamp(clamp(p.x, a.x, a.x + a.w), 4, SLIDE_W - 4), y: clamp(clamp(p.y, a.y, a.y + a.h), 4, SLIDE_H - 4) });
  p1 = inside(p1); p2 = inside(p2);
  // A quadratic Bézier stays inside the triangle of its three points, so clamping the control point too keeps the
  // whole curve inside the image's area.
  if (c) c = inside(c);
  const el = newLine(round(p1.x), round(p1.y), round(p2.x), round(p2.y), hasArrowhead(e.kind), c);
  el.stroke = e.colorHex ?? INK[e.color ?? 'black'];
  Object.assign(el, lineBox(el));
  return el;
}

/**
 * A recognized table → the editor's own TableElement (newTable + rich-text cells), not text and not an image.
 * Font from the row pitch of the source, column widths from the typeset text of each column, header row = the table's own header style.
 */
function tableElement(e: IRElement, pl: Placement, issues: IRIssue[]): TableElement {
  const t = e.table!;
  const b = mapBox(e.bbox, pl);
  const nRows = t.rows.length, nCols = t.rows[0].length, lh = 1.35;
  let fontSize = snapFont(clamp((b.h / nRows - 2 * TABLE_CELL_PAD_Y) / lh, 14, 40));
  const colEm = Array.from({ length: nCols }, (_, c) => Math.max(1, ...t.rows.map((r) => lineWidthEm(spansPlain(r[c])))));
  const natural = (f: number) => colEm.map((em) => em * f * 1.06 + 2 * TABLE_CELL_PAD_X + 8);
  const sum = (v: number[]) => v.reduce((a, x) => a + x, 0);
  const maxW = Math.max(120, pl.area.w - 8);
  if (sum(natural(fontSize)) > maxW) fontSize = Math.max(12, Math.floor((fontSize * maxW) / sum(natural(fontSize))));
  // Rows must not grow past the space the sketch gave the table (a tall page is scaled down, the font has a floor): trim the
  // cell padding (the table's own padScale) so the following elements are not overlapped.
  const fitPad = clamp(((b.h / nRows) - fontSize * lh) / (2 * TABLE_CELL_PAD_Y), 0.2, 1);
  const widths = natural(fontSize);
  const total = Math.round(Math.min(maxW, Math.max(b.w, sum(widths))));
  const el = newTable(0, 0, { rows: nRows, cols: nCols, w: total });
  el.cols = scaleCols(widths, total);
  el.rows = t.rows.map((r) => r.map((c) => ({ doc: c.length ? ({ type: 'doc', content: [{ type: 'paragraph', content: spansToNodes(c, false) }] } as PMNode) : emptyDoc() })));
  el.textStyle = { ...el.textStyle, fontSize, color: INK[e.color ?? 'black'] };
  el.headerRow = t.header;
  el.w = total;
  if (fitPad < 1) el.padScale = Math.round(fitPad * 100) / 100;
  el.h = estimateTableHeight(nRows, fontSize, lh, el.padScale ?? 1);
  const box = keepInside({ x: b.x, y: b.y, w: el.w, h: el.h }, issues, e.id, pl.area);
  el.x = round(box.x); el.y = round(box.y);
  return repairTable(el);
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
    if (isConnectorKind(e.kind)) el = lineElement(e, pl, shapes);
    else if (e.kind === 'math') el = mathElement(e, pl, issues);
    else if (e.kind === 'table') el = tableElement(e, pl, issues);
    else el = textElement(e, pl, issues);
    map[e.id] = [el.id];
    out.push({ z: isConnectorKind(e.kind) ? 1 : 2, el });
  }
  // Stable z-order: shapes, then connectors, then text on top.
  out.sort((a, b) => a.z - b.z);
  return { elements: out.map((o) => o.el), map, placement: pl, issues };
}
