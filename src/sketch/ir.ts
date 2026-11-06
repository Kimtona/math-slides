/**
 * Sketch-to-Slides intermediate representation (IR).
 *
 * The vision model never writes MathSlides JSON. It describes what is drawn in the sketch with this small,
 * explicit structure; `parseIR` validates it and `irToElements` (convert.ts) turns it into ordinary slide elements.
 *
 * Coordinates are normalized to 0..1000 on both axes of the (cropped) source image, so they do not depend on the
 * pixel size the model saw. The image's real width/height are supplied by the app, never by the model.
 */

export const IR_SCALE = 1000;

export type IRKind = 'text' | 'math' | 'shape' | 'arrow' | 'line' | 'curvedArrow' | 'curve' | 'table';
export const IR_KINDS: readonly IRKind[] = ['text', 'math', 'shape', 'arrow', 'line', 'curvedArrow', 'curve', 'table'];
/** Connector kinds (straight or curved). `curvedArrow`/`curve` are the curved forms of `arrow`/`line`. */
export const isConnectorKind = (k: IRKind) => k === 'arrow' || k === 'line' || k === 'curvedArrow' || k === 'curve';
export const hasArrowhead = (k: IRKind) => k === 'arrow' || k === 'curvedArrow';
/** Side a curved stroke bulges towards, as seen in the image. */
export type IRBend = 'up' | 'down' | 'left' | 'right';
export const IR_BENDS: readonly IRBend[] = ['up', 'down', 'left', 'right'];
/** Default depth of a curve whose bend side is known but not its depth (curve middle's distance / chord length). */
export const DEFAULT_BEND_DEPTH = 0.25;
export type IRPen = 'pen' | 'highlighter';
export const IR_PENS: readonly IRPen[] = ['pen', 'highlighter'];
export type IRShape = 'ellipse' | 'rect' | 'roundRect';
export const IR_SHAPES: readonly IRShape[] = ['ellipse', 'rect', 'roundRect'];
export type IRRole = 'title' | 'body' | 'annotation' | 'label';
export const IR_ROLES: readonly IRRole[] = ['title', 'body', 'annotation', 'label'];
export type IRColor = 'black' | 'blue' | 'red' | 'green' | 'gray';
export const IR_COLORS: readonly IRColor[] = ['black', 'blue', 'red', 'green', 'gray'];
export type IRRelationType = 'inside' | 'annotates' | 'points-to';
export const IR_RELATIONS: readonly IRRelationType[] = ['inside', 'annotates', 'points-to'];

export interface IRBox { x: number; y: number; w: number; h: number }
export interface IRPoint { x: number; y: number }

/**
 * Review flag. NOT a probability: it only says whether a human should look at this element.
 * `transcribed` = what is literally written; `inferred` = the model's reading where the writing is ambiguous.
 * The slide always starts from `transcribed`; the user may switch to `inferred` in the preview.
 */
export interface IRReview {
  needed: boolean;
  reason?: string;
  transcribed?: string;
  inferred?: string;
}

export interface IRRelation { type: IRRelationType; target: string }

/** A run of text with inline formatting; `$...$` inside `text` is inline math (as everywhere in the IR). */
export interface IRSpan { text: string; bold?: boolean; italic?: boolean; strike?: boolean; underline?: boolean }
/** Rich-text blocks: paragraphs, headings (level 1..4), block quotes and bullet / ordered lists (each item = spans). */
export type IRBlock =
  | { type: 'paragraph' | 'quote'; spans: IRSpan[] }
  | { type: 'heading'; level: number; spans: IRSpan[] }
  | { type: 'bullet' | 'ordered'; items: IRSpan[][]; start?: number };
/** A table: rows → cells → spans. `header`: the first row is a header row (never assumed). Rectangular after parseIR. */
export interface IRTable { header: boolean; rows: IRSpan[][][] }

export const IR_BLOCK_TYPES = ['paragraph', 'heading', 'quote', 'bullet', 'ordered'] as const;
export const IR_MAX_TABLE_ROWS = 40, IR_MAX_TABLE_COLS = 12, IR_MAX_BLOCKS = 60, IR_MAX_TEXT = 600;

export interface IRElement {
  id: string;
  kind: IRKind;
  /** Bounding box of the ink, normalized 0..1000. For arrows/lines: the box around both endpoints. */
  bbox: IRBox;
  /** text: plain text, `\n` separates written lines, `$...$` marks inline math. shape: the label written inside. */
  text?: string;
  /** text: the same content as structured blocks (formatting, lists, headings, quotes). When present it wins over `text`, which then only holds its plain text. */
  blocks?: IRBlock[];
  /** table: the cells. */
  table?: IRTable;
  /** math: LaTeX of the displayed equation (no surrounding $). */
  latex?: string;
  shape?: IRShape;
  /** arrow/line: drawn endpoints (arrowhead at `to`), normalized 0..1000. */
  from?: IRPoint;
  to?: IRPoint;
  /** arrow/line: ids of the elements the endpoints touch, if any. */
  fromId?: string;
  toId?: string;
  /**
   * curvedArrow/curve (also accepted on arrow/line, which then become curved): the quadratic Bézier control point,
   * normalized 0..1000. Alternatively `bend` (+ optional `bendDepth`): the side the stroke bulges towards and how far its
   * middle lies from the straight from→to chord, as a fraction of the chord length. `parseIR` always resolves a curve
   * to a `control` point.
   */
  control?: IRPoint;
  bend?: IRBend;
  bendDepth?: number;
  role?: IRRole;
  color?: IRColor;
  /**
   * Pen kind: 'highlighter' = a thick, light marker stroke (e.g. a lime loop around a word), drawn as a thick light
   * outline under the text; absent/'pen' = an ordinary pen stroke.
   */
  pen?: IRPen;
  /** Ink color measured from the source image's pixels (#rrggbb), when it could be measured. Wins over `color`. */
  colorHex?: string;
  /** Stroke thickness measured from the source image, in source-image pixels. */
  inkWidth?: number;
  relations?: IRRelation[];
  review?: IRReview;
}

export interface SketchIR {
  version: 1;
  /** Pixel size of the source image (set by the app). */
  image: { width: number; height: number };
  elements: IRElement[];
  /** Free-form remarks from the model (things it saw but could not represent). */
  notes?: string[];
}

/** What the model returns: the IR without the app-owned `version`/`image`. */
export interface ModelIR {
  elements: IRElement[];
  notes?: string[];
}

// ---------- JSON Schema for the model's structured output ----------

const num = { type: 'number' } as const;
const box = { type: 'object', properties: { x: num, y: num, w: num, h: num }, required: ['x', 'y', 'w', 'h'], additionalProperties: false } as const;
const point = { type: 'object', properties: { x: num, y: num }, required: ['x', 'y'], additionalProperties: false } as const;

const bool = { type: 'boolean' } as const;
const spansSchema = {
  type: 'array',
  items: { type: 'object', properties: { text: { type: 'string' }, bold: bool, italic: bool, strike: bool, underline: bool }, required: ['text'], additionalProperties: false },
} as const;
const blockSchema = {
  type: 'object',
  properties: { type: { type: 'string', enum: [...IR_BLOCK_TYPES] }, level: num, spans: spansSchema, items: { type: 'array', items: spansSchema }, start: num },
  required: ['type'],
  additionalProperties: false,
} as const;
const tableSchema = {
  type: 'object',
  properties: { header: bool, rows: { type: 'array', items: { type: 'array', items: spansSchema } } },
  required: ['rows'],
  additionalProperties: false,
} as const;

export const IR_ELEMENT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: [...IR_KINDS] },
    bbox: box,
    text: { type: 'string' },
    blocks: { type: 'array', items: blockSchema },
    table: tableSchema,
    latex: { type: 'string' },
    shape: { type: 'string', enum: [...IR_SHAPES] },
    from: point,
    to: point,
    fromId: { type: 'string' },
    toId: { type: 'string' },
    control: point,
    bend: { type: 'string', enum: [...IR_BENDS] },
    bendDepth: { type: 'number' },
    role: { type: 'string', enum: [...IR_ROLES] },
    color: { type: 'string', enum: [...IR_COLORS] },
    pen: { type: 'string', enum: [...IR_PENS] },
    relations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { type: { type: 'string', enum: [...IR_RELATIONS] }, target: { type: 'string' } },
        required: ['type', 'target'],
        additionalProperties: false,
      },
    },
    review: {
      type: 'object',
      properties: { needed: { type: 'boolean' }, reason: { type: 'string' }, transcribed: { type: 'string' }, inferred: { type: 'string' } },
      required: ['needed'],
      additionalProperties: false,
    },
  },
  required: ['id', 'kind', 'bbox'],
  additionalProperties: false,
} as const;

export const MODEL_IR_SCHEMA = {
  type: 'object',
  properties: {
    elements: { type: 'array', items: IR_ELEMENT_SCHEMA },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['elements'],
  additionalProperties: false,
} as const;

/** AI review result: verdict + patch operations on the IR (by element id). */
export interface ReviewPatch {
  op: 'update' | 'add' | 'remove';
  id: string;
  /** update: fields to replace; add: the full element. */
  element?: Partial<IRElement>;
  reason: string;
}
export interface ReviewResult {
  ok: boolean;
  summary: string;
  patches: ReviewPatch[];
}

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    patches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['update', 'add', 'remove'] },
          id: { type: 'string' },
          element: { ...IR_ELEMENT_SCHEMA, required: [] },
          reason: { type: 'string' },
        },
        required: ['op', 'id', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['ok', 'summary', 'patches'],
  additionalProperties: false,
} as const;

// ---------- validation ----------

/**
 * A display equation's LaTeX without surrounding math delimiters: `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, and the
 * mis-escaped `\\(` a model produced for the PPO capture (in TeX `\\` is a line break, so it rendered as a stray "(").
 * Only delimiters are removed (also an unpaired opening or closing one); the formula itself is never changed, and a
 * plain "(" without backslash is content.
 */
export function stripMathDelimiters(latex: string): string {
  let s = latex.trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/^(?:\\\\\(|\\\\\[|\\\(|\\\[|\$\$|\$)\s*/, '').replace(/\s*(?:\\\\\)|\\\\\]|\\\)|\\\]|\$\$|\$)$/, '').trim();
    if (s === before) break;
  }
  return s;
}

export interface IRIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  id?: string;
  message: string;
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ---------- untrusted structure: spans, blocks, tables ----------

function cleanSpan(v: unknown): IRSpan | null {
  if (typeof v === 'string') return v ? { text: v.slice(0, IR_MAX_TEXT) } : null;
  if (!isObj(v) || typeof v.text !== 'string' || !v.text) return null;
  const s: IRSpan = { text: v.text.slice(0, IR_MAX_TEXT) };
  for (const k of ['bold', 'italic', 'strike', 'underline'] as const) if (v[k] === true) s[k] = true;
  return s;
}
/** Accepts a string, one span or an array of either; anything else is empty. Only known fields survive. */
export function cleanSpans(v: unknown): IRSpan[] {
  const arr = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return arr.map(cleanSpan).filter((x): x is IRSpan => !!x);
}
export const spansPlain = (spans: IRSpan[]) => spans.map((x) => x.text).join('');
/** Plain text of blocks, one line per paragraph / list item. */
export const blocksPlain = (blocks: IRBlock[]) => blocks.flatMap((b) => ('items' in b ? b.items.map(spansPlain) : [spansPlain(b.spans)])).join('\n');

export function cleanBlocks(v: unknown): IRBlock[] {
  if (!Array.isArray(v)) return [];
  const out: IRBlock[] = [];
  for (const b of v.slice(0, IR_MAX_BLOCKS)) {
    if (!isObj(b)) continue;
    const type = (IR_BLOCK_TYPES as readonly string[]).includes(b.type) ? b.type : b.items ? 'bullet' : 'paragraph'; // unknown type: keep the content as a plain paragraph / list
    if (type === 'bullet' || type === 'ordered') {
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, IR_MAX_BLOCKS).map(cleanSpans).filter((x) => x.length);
      if (items.length) out.push(type === 'ordered' ? { type, items, ...(finite(b.start) && b.start >= 1 && b.start < 1000 ? { start: Math.round(b.start) } : {}) } : { type, items });
      continue;
    }
    const spans = cleanSpans(b.spans);
    if (!spans.length) continue;
    out.push(type === 'heading' ? { type, level: finite(b.level) ? Math.max(1, Math.min(4, Math.round(b.level))) : 2, spans } : { type: type as 'paragraph' | 'quote', spans });
  }
  return out;
}

/** Rectangular, size-limited table or null. Ragged rows are padded with empty cells (reported); too many rows/columns are cut (reported). */
export function cleanTable(v: unknown, issues: IRIssue[], id: string): IRTable | null {
  if (!isObj(v) || !Array.isArray(v.rows)) return null;
  const rawRows = v.rows.filter(Array.isArray);
  if (rawRows.length > IR_MAX_TABLE_ROWS || rawRows.some((r: unknown[]) => r.length > IR_MAX_TABLE_COLS))
    issues.push({ severity: 'warning', code: 'table', id, message: `Table cut to ${IR_MAX_TABLE_ROWS} rows × ${IR_MAX_TABLE_COLS} columns.` });
  const rows = rawRows.slice(0, IR_MAX_TABLE_ROWS).map((r: unknown[]) => r.slice(0, IR_MAX_TABLE_COLS).map(cleanSpans));
  const cols = Math.max(0, ...rows.map((r) => r.length));
  if (!rows.length || !cols || rows.every((r) => r.every((c) => !c.length))) return null;
  if (rows.some((r) => r.length !== cols)) {
    issues.push({ severity: 'warning', code: 'table', id, message: 'Rows had different numbers of cells; short rows were padded with empty cells (check the table).' });
    for (const r of rows) while (r.length < cols) r.push([]);
  }
  return { header: v.header === true, rows };
}
const clampN = (v: number) => Math.max(0, Math.min(IR_SCALE, v));

function cleanBox(b: unknown): IRBox | null {
  if (!isObj(b) || !finite(b.x) || !finite(b.y) || !finite(b.w) || !finite(b.h)) return null;
  const x = clampN(b.x), y = clampN(b.y);
  return { x, y, w: Math.max(0, Math.min(IR_SCALE - x, b.w)), h: Math.max(0, Math.min(IR_SCALE - y, b.h)) };
}
function cleanPoint(p: unknown): IRPoint | null {
  return isObj(p) && finite(p.x) && finite(p.y) ? { x: clampN(p.x), y: clampN(p.y) } : null;
}

/**
 * Curved connectors end up with a `control` point (straight ones without): an explicit control point wins; otherwise
 * `bend` (+ `bendDepth`) gives the side and depth; otherwise the bulge is estimated from how far the ink's bbox reaches
 * beyond the chord. A straight `arrow`/`line` that carries a control point or bend becomes curved (compatible
 * upgrade); a `curvedArrow`/`curve` whose bend cannot be determined stays straight, with an issue. Geometry is
 * computed in image pixels (the 0..1000 axes are not to scale).
 */
function resolveCurve(el: IRElement, image: { width: number; height: number }, issues: IRIssue[]) {
  const curvedKind = el.kind === 'curvedArrow' || el.kind === 'curve';
  const { bend, bendDepth } = el;
  delete el.bend; delete el.bendDepth;
  if (el.control) {
    if (!curvedKind) el.kind = el.kind === 'arrow' ? 'curvedArrow' : 'curve';
    return;
  }
  if (!curvedKind && !bend) return;
  const sx = image.width / IR_SCALE, sy = image.height / IR_SCALE;
  const p0 = { x: el.from!.x * sx, y: el.from!.y * sy }, p2 = { x: el.to!.x * sx, y: el.to!.y * sy };
  const dx = p2.x - p0.x, dy = p2.y - p0.y, len = Math.hypot(dx, dy);
  const straight = (why: string) => {
    el.kind = hasArrowhead(el.kind) ? 'arrow' : 'line';
    issues.push({ severity: 'warning', code: 'geometry', id: el.id, message: `Curve drawn straight: ${why}` });
  };
  if (len < 1e-6) { straight('its endpoints coincide.'); return; }
  // Unit left normal of the chord in image coordinates (y down).
  const n = { x: dy / len, y: -dx / len };
  const mid = { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 };
  let side = 0, depth = 0; // side: +1 = towards n, -1 = away; depth: px of the curve's middle from the chord
  if (bend) {
    const dir = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }[bend];
    const dot = dir.x * n.x + dir.y * n.y;
    if (Math.abs(dot) < 0.2) { straight(`bend "${bend}" is along the stroke's own direction.`); return; }
    side = Math.sign(dot);
    depth = (bendDepth ?? DEFAULT_BEND_DEPTH) * len;
  } else {
    // How far the ink's box reaches beyond the chord on either side.
    const b = el.bbox;
    const corners = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => (x * sx - mid.x) * n.x + (y * sy - mid.y) * n.y);
    const pos = Math.max(0, ...corners), neg = Math.max(0, ...corners.map((c) => -c));
    // For a diagonal chord the box's corners overshoot the ink, so only clear one-sided bulges count.
    if (Math.max(pos, neg) < 0.08 * len || Math.min(pos, neg) > 0.6 * Math.max(pos, neg)) { straight('no bend direction or control point, and the ink box shows no clear bulge.'); return; }
    side = pos > neg ? 1 : -1;
    depth = Math.min(Math.max(pos, neg), 0.8 * len);
    issues.push({ severity: 'info', code: 'geometry', id: el.id, message: 'Curve bend estimated from the ink bounding box.' });
  }
  // The curve's middle is halfway between the chord midpoint and the control point.
  const c = { x: mid.x + n.x * side * 2 * depth, y: mid.y + n.y * side * 2 * depth };
  el.control = { x: clampN(c.x / sx), y: clampN(c.y / sy) };
  if (!curvedKind) el.kind = el.kind === 'arrow' ? 'curvedArrow' : 'curve';
}

/**
 * Validates and normalizes model output. Elements that cannot be represented are dropped with an issue
 * (never silently): unknown kinds, missing content, bad geometry. Coordinates are clamped into 0..1000.
 */
export function parseIR(raw: unknown, image: { width: number; height: number }): { ir: SketchIR; issues: IRIssue[] } {
  const issues: IRIssue[] = [];
  const out: IRElement[] = [];
  const src = isObj(raw) && Array.isArray(raw.elements) ? raw.elements : null;
  if (!src) issues.push({ severity: 'error', code: 'schema', message: 'Model output has no "elements" array.' });
  const seen = new Set<string>();
  for (const [i, e] of (src ?? []).entries()) {
    const id = isObj(e) && typeof e.id === 'string' && e.id.trim() ? e.id.trim() : `e${i + 1}`;
    const drop = (code: string, message: string) => issues.push({ severity: 'warning', code, id, message });
    if (!isObj(e)) { drop('schema', `Element ${i} is not an object.`); continue; }
    if (seen.has(id)) { drop('schema', `Duplicate element id "${id}".`); continue; }
    if (!IR_KINDS.includes(e.kind)) { drop('unsupported', `Unsupported element kind "${String(e.kind)}" was not converted.`); continue; }
    const bbox = cleanBox(e.bbox);
    if (!bbox) { drop('schema', 'Missing or invalid bounding box.'); continue; }
    const el: IRElement = { id, kind: e.kind, bbox };
    if (typeof e.text === 'string') el.text = e.text;
    if (typeof e.latex === 'string') el.latex = stripMathDelimiters(e.latex);
    if (IR_SHAPES.includes(e.shape)) el.shape = e.shape;
    if (IR_ROLES.includes(e.role)) el.role = e.role;
    if (IR_COLORS.includes(e.color)) el.color = e.color;
    if (IR_PENS.includes(e.pen)) el.pen = e.pen;
    if (typeof e.colorHex === 'string' && /^#[0-9a-fA-F]{6}$/.test(e.colorHex)) el.colorHex = e.colorHex.toUpperCase();
    if (finite(e.inkWidth) && e.inkWidth > 0) el.inkWidth = e.inkWidth;
    const from = cleanPoint(e.from), to = cleanPoint(e.to);
    if (from) el.from = from;
    if (to) el.to = to;
    if (typeof e.fromId === 'string' && e.fromId) el.fromId = e.fromId;
    if (typeof e.toId === 'string' && e.toId) el.toId = e.toId;
    const control = cleanPoint(e.control);
    if (control) el.control = control;
    if (IR_BENDS.includes(e.bend)) el.bend = e.bend;
    if (finite(e.bendDepth) && e.bendDepth > 0) el.bendDepth = Math.min(1, e.bendDepth);
    if (Array.isArray(e.relations)) {
      const rel = e.relations.filter((r: any) => isObj(r) && IR_RELATIONS.includes(r.type) && typeof r.target === 'string');
      if (rel.length) el.relations = rel.map((r: any) => ({ type: r.type, target: r.target }));
    }
    if (isObj(e.review) && typeof e.review.needed === 'boolean') {
      const r: IRReview = { needed: e.review.needed };
      for (const k of ['reason', 'transcribed', 'inferred'] as const) if (typeof e.review[k] === 'string' && e.review[k]) r[k] = e.review[k];
      el.review = r;
    }
    // Structure (untrusted): blocks and tables are cleaned field by field; whatever cannot be used is dropped, never guessed.
    if (e.blocks !== undefined) {
      const blocks = cleanBlocks(e.blocks);
      if (blocks.length) { el.blocks = blocks; if (!el.text?.trim()) el.text = blocksPlain(blocks); }
      else if (el.kind === 'text') issues.push({ severity: 'info', code: 'structure', id, message: 'Ignored an empty or invalid "blocks" field.' });
    }
    if (el.kind === 'table') {
      const table = cleanTable(e.table, issues, id);
      if (table) el.table = table;
      else if (el.text?.trim()) { el.kind = 'text'; issues.push({ severity: 'warning', code: 'table', id, message: 'Table without usable rows: kept its text as a plain note.' }); }
      else { drop('schema', 'Table without usable rows.'); continue; }
    } else delete el.table;
    if (el.kind !== 'text') delete el.blocks;
    // Kind-specific content requirements.
    if (el.kind === 'text' && !el.text?.trim()) { drop('schema', 'Text element without text.'); continue; }
    if (el.kind === 'math' && !el.latex) { drop('schema', 'Math element without LaTeX.'); continue; }
    if (el.kind === 'shape' && !el.shape) el.shape = 'rect';
    if (isConnectorKind(el.kind) && !(el.from && el.to)) {
      // Fall back to the bbox diagonal's main axis: a horizontal or vertical stroke through the box.
      const b = el.bbox;
      const horizontal = b.w >= b.h;
      el.from = horizontal ? { x: b.x, y: b.y + b.h / 2 } : { x: b.x + b.w / 2, y: b.y };
      el.to = horizontal ? { x: b.x + b.w, y: b.y + b.h / 2 } : { x: b.x + b.w / 2, y: b.y + b.h };
      issues.push({ severity: 'warning', code: 'geometry', id, message: 'Arrow/line endpoints missing; derived from its bounding box.' });
    }
    if (isConnectorKind(el.kind)) resolveCurve(el, image, issues);
    else { delete el.control; delete el.bend; delete el.bendDepth; }
    seen.add(id);
    out.push(el);
  }
  // References to unknown ids are removed (with an issue) so later stages can trust them.
  for (const el of out) {
    for (const key of ['fromId', 'toId'] as const) {
      if (el[key] && !seen.has(el[key]!)) {
        issues.push({ severity: 'warning', code: 'reference', id: el.id, message: `${key} points to unknown element "${el[key]}".` });
        delete el[key];
      }
    }
    if (el.relations) {
      const ok = el.relations.filter((r) => seen.has(r.target));
      if (ok.length !== el.relations.length) issues.push({ severity: 'warning', code: 'reference', id: el.id, message: 'Relation to an unknown element was removed.' });
      if (ok.length) el.relations = ok; else delete el.relations;
    }
  }
  const notes = isObj(raw) && Array.isArray(raw.notes) ? raw.notes.filter((n: unknown) => typeof n === 'string') : undefined;
  return { ir: { version: 1, image: { width: image.width, height: image.height }, elements: out, ...(notes?.length ? { notes } : {}) }, issues };
}

/** Applies review patches to an IR (returns a new, re-validated IR). Unknown ids are ignored with an issue. */
export function applyPatches(ir: SketchIR, patches: ReviewPatch[]): { ir: SketchIR; issues: IRIssue[] } {
  const issues: IRIssue[] = [];
  let els: any[] = ir.elements.map((e) => structuredClone(e));
  for (const p of patches) {
    const idx = els.findIndex((e) => e.id === p.id);
    if (p.op === 'remove') {
      if (idx < 0) issues.push({ severity: 'warning', code: 'patch', id: p.id, message: 'remove: unknown id' });
      else els.splice(idx, 1);
    } else if (p.op === 'update') {
      if (idx < 0) issues.push({ severity: 'warning', code: 'patch', id: p.id, message: 'update: unknown id' });
      else els[idx] = { ...els[idx], ...(p.element ?? {}), id: p.id };
    } else if (p.op === 'add') {
      if (idx >= 0) issues.push({ severity: 'warning', code: 'patch', id: p.id, message: 'add: id already exists' });
      else els.push({ ...(p.element ?? {}), id: p.id });
    }
  }
  const res = parseIR({ elements: els, notes: ir.notes }, ir.image);
  return { ir: res.ir, issues: [...issues, ...res.issues] };
}
