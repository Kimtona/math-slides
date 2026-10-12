import type { PMNode, TableCell, TableElement } from './types';
import { SLIDE_W } from './types';
import { DEFAULT_TEXT_COLOR, emptyDoc, uid } from './defaults';
import { TYPOGRAPHY } from './typography';

/** Pure table operations. Everything here returns new data and never mutates its input, so it works on plain objects and immer drafts alike. */

export const TABLE_DEFAULT_ROWS = 3;
export const TABLE_DEFAULT_COLS = 3;
/** Initial width: ~60% of the slide. */
export const TABLE_DEFAULT_WIDTH = Math.round(SLIDE_W * 0.6);
export const TABLE_MIN_COL = 40;
/** Cell padding (px), shared by the renderer and the height estimate. */
export const TABLE_CELL_PAD_X = 14;
export const TABLE_CELL_PAD_Y = 10;
export const TABLE_MIN_FONT = 6;
export const TABLE_MAX_FONT = 300;

/** Cell padding of a table (px): the shared base scaled by its `padScale`. */
export const tablePad = (t: Pick<TableElement, 'padScale'>) => ({ x: TABLE_CELL_PAD_X * (t.padScale ?? 1), y: TABLE_CELL_PAD_Y * (t.padScale ?? 1) });

type Grid = Pick<TableElement, 'cols' | 'rows' | 'w'>;

export const emptyCell = (): TableCell => ({ doc: emptyDoc() });
export const cellText = (text: string): TableCell => ({ doc: text ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } : emptyDoc() });

/** Rough height before the browser has measured it (rows of one line); the canvas replaces it with the real value. */
export const estimateTableHeight = (rows: number, fontSize: number, lineHeight: number, padScale = 1) =>
  Math.round(rows * (fontSize * lineHeight + 2 * TABLE_CELL_PAD_Y * padScale));

export function newTable(cx: number, cy: number, opts: { rows?: number; cols?: number; w?: number } = {}): TableElement {
  const rows = opts.rows ?? TABLE_DEFAULT_ROWS, cols = opts.cols ?? TABLE_DEFAULT_COLS, w = opts.w ?? TABLE_DEFAULT_WIDTH;
  const textStyle = { fontSize: TYPOGRAPHY.body, color: DEFAULT_TEXT_COLOR, align: 'left' as const, lineHeight: 1.35, fill: null };
  const h = estimateTableHeight(rows, textStyle.fontSize, textStyle.lineHeight);
  return {
    id: uid(), type: 'table',
    x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h,
    cols: splitWidth(w, cols),
    rows: Array.from({ length: rows }, () => Array.from({ length: cols }, emptyCell)),
    style: 'minimal', headerRow: true, textStyle,
  };
}

/** `n` integer widths summing exactly to `total` (the remainder goes to the last columns). */
export function splitWidth(total: number, n: number): number[] {
  const base = Math.floor(total / n), extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i >= n - extra ? 1 : 0));
}

/**
 * Scale widths to a new total: integers, each ≥ `min`, summing exactly to `total`, ratios kept as far as the minimum allows.
 * Columns whose proportional share would fall below the minimum are pinned to it; the others share the rest proportionally.
 */
export function scaleCols(cols: number[], total: number, min = TABLE_MIN_COL): number[] {
  const n = cols.length;
  if (total < n * min) min = 1; // not enough room for the minimum width: stay proportional
  const out = new Array<number>(n).fill(0);
  let free = cols.map((_, i) => i);
  let remaining = total;
  for (;;) {
    const sum = free.reduce((a, i) => a + cols[i], 0) || 1;
    const pinned = free.filter((i) => (cols[i] * remaining) / sum < min);
    if (!pinned.length || pinned.length === free.length) {
      if (pinned.length === free.length) pinned.forEach((i) => { out[i] = min; remaining -= min; });
      free = pinned.length === free.length ? [] : free;
      break;
    }
    pinned.forEach((i) => { out[i] = min; remaining -= min; });
    free = free.filter((i) => !pinned.includes(i));
  }
  if (free.length) {
    const sum = free.reduce((a, i) => a + cols[i], 0) || 1;
    free.forEach((i) => { out[i] = Math.round((cols[i] * remaining) / sum); });
    // Rounding drift goes to the widest free column.
    const drift = remaining - free.reduce((a, i) => a + out[i], 0);
    const widest = free.reduce((a, i) => (out[i] > out[a] ? i : a), free[0]);
    out[widest] += drift;
  } else {
    out[out.indexOf(Math.max(...out))] += remaining; // all pinned: leftover (0 when total == n × min)
  }
  return out;
}

/** Violations of the table invariants (empty = valid): rectangular grid, ≥1 row/column, widths sum to `w`. */
export function tableProblems(t: Grid): string[] {
  const p: string[] = [];
  if (!t.rows.length) p.push('no rows');
  if (!t.cols.length) p.push('no columns');
  t.rows.forEach((r, i) => { if (r.length !== t.cols.length) p.push(`row ${i} has ${r.length} cells for ${t.cols.length} columns`); });
  if (t.cols.some((c) => !(c > 0))) p.push('non-positive column width');
  const sum = t.cols.reduce((a, b) => a + b, 0);
  if (sum !== t.w) p.push(`column widths sum to ${sum}, element width is ${t.w}`);
  return p;
}

/** Defensive repair for files from elsewhere: pad/trim ragged rows, restore at least a 1×1 grid, make widths sum to `w`. */
export function repairTable<T extends Grid>(t: T): T {
  if (!tableProblems(t).length) return t;
  const n = Math.max(1, t.cols.length || Math.max(0, ...t.rows.map((r) => r.length)));
  const rows = (t.rows.length ? t.rows : [[]]).map((r) => Array.from({ length: n }, (_, i) => r[i] ?? emptyCell()));
  const w = t.w > 0 ? t.w : TABLE_DEFAULT_WIDTH;
  const cols = t.cols.length === n && t.cols.every((c) => c > 0) ? scaleCols(t.cols, w) : splitWidth(w, n);
  return { ...t, rows, cols, w };
}

export interface TableEdit {
  rows: TableCell[][];
  cols: number[];
  w: number;
}

// ---------- merged cells ----------
// A merge keeps the grid rectangular: the top-left cell (the anchor) carries `rowSpan` / `colSpan`, and every other cell of the block stays in
// `rows` as an empty `covered` cell. So all grid invariants, paste and the width logic work unchanged, and unmerging just uncovers them.

export interface CellRect { r1: number; c1: number; r2: number; c2: number }
const rs = (c: TableCell) => c.rowSpan ?? 1;
const cs = (c: TableCell) => c.colSpan ?? 1;
const coveredCell = (): TableCell => ({ doc: emptyDoc(), covered: true });

/** The block that contains (r, c): a single cell, or the whole merged cell with its anchor at the top-left. */
export function rectOf(rows: TableCell[][], r: number, c: number): CellRect {
  if (rows[r]?.[c]?.covered) {
    for (let i = 0; i <= r; i++) for (let j = 0; j <= c; j++) {
      const a = rows[i][j];
      if (!a.covered && i + rs(a) > r && j + cs(a) > c) return { r1: i, c1: j, r2: i + rs(a) - 1, c2: j + cs(a) - 1 };
    }
  }
  const a = rows[r]?.[c];
  return { r1: r, c1: c, r2: r + (a ? rs(a) : 1) - 1, c2: c + (a ? cs(a) : 1) - 1 };
}
/** The anchor (editable) cell for any cell: a covered cell maps to the merged cell that hides it. */
export const anchorOf = (rows: TableCell[][], r: number, c: number): { row: number; col: number } => { const k = rectOf(rows, r, c); return { row: k.r1, col: k.c1 }; };
export const isMerged = (rows: TableCell[][], r: number, c: number) => { const k = rectOf(rows, r, c); return k.r2 > k.r1 || k.c2 > k.c1; };

/** Grow a selection until it cuts no merged cell in half (the result is what Merge actually merges). */
export function expandRect(rows: TableCell[][], rect: CellRect): CellRect {
  let k = { r1: Math.min(rect.r1, rect.r2), c1: Math.min(rect.c1, rect.c2), r2: Math.max(rect.r1, rect.r2), c2: Math.max(rect.c1, rect.c2) };
  for (let again = true; again;) {
    again = false;
    for (let r = k.r1; r <= k.r2; r++) for (let c = k.c1; c <= k.c2; c++) {
      const m = rectOf(rows, r, c);
      if (m.r1 < k.r1 || m.c1 < k.c1 || m.r2 > k.r2 || m.c2 > k.c2) {
        k = { r1: Math.min(k.r1, m.r1), c1: Math.min(k.c1, m.c1), r2: Math.max(k.r2, m.r2), c2: Math.max(k.c2, m.c2) };
        again = true;
      }
    }
  }
  return k;
}

const isEmptyDoc = (d: PMNode) => !cellPlainText(d).trim();

/**
 * Merge the (expanded) block into its top-left cell. The texts of the other non-empty cells are appended to the anchor as paragraphs,
 * so nothing a user typed is lost. A block of one cell is returned unchanged.
 */
export function mergeCells(rows: TableCell[][], rect: CellRect): { rows: TableCell[][]; rect: CellRect } {
  const k = expandRect(rows, rect);
  if (k.r1 === k.r2 && k.c1 === k.c2) return { rows, rect: k };
  const anchor = rows[k.r1][k.c1];
  const extra: PMNode[] = [];
  for (let r = k.r1; r <= k.r2; r++) for (let c = k.c1; c <= k.c2; c++) {
    if ((r === k.r1 && c === k.c1) || rows[r][c].covered || isEmptyDoc(rows[r][c].doc)) continue;
    extra.push(...(rows[r][c].doc.content ?? []));
  }
  const base = isEmptyDoc(anchor.doc) ? [] : anchor.doc.content ?? [];
  const doc = extra.length || base.length ? { ...anchor.doc, content: [...base, ...extra] } : anchor.doc;
  const out = rows.map((row, r) => row.map((cell, c) => {
    if (r < k.r1 || r > k.r2 || c < k.c1 || c > k.c2) return cell;
    if (r === k.r1 && c === k.c1) return { ...anchor, doc, rowSpan: k.r2 - k.r1 + 1 || undefined, colSpan: k.c2 - k.c1 + 1 || undefined };
    return coveredCell();
  }));
  const a = out[k.r1][k.c1];
  if (a.rowSpan === 1) delete a.rowSpan;
  if (a.colSpan === 1) delete a.colSpan;
  return { rows: out, rect: k };
}

/** Split the merged cell containing (r, c) back into single cells (the text stays in the top-left one). */
export function unmergeCells(rows: TableCell[][], r: number, c: number): TableCell[][] {
  const k = rectOf(rows, r, c);
  if (k.r1 === k.r2 && k.c1 === k.c2) return rows;
  return rows.map((row, i) => row.map((cell, j) => {
    if (i < k.r1 || i > k.r2 || j < k.c1 || j > k.c2) return cell;
    const { rowSpan: _r, colSpan: _c, covered: _v, ...rest } = cell;
    return rest;
  }));
}

/** Swap rows and columns (spans swap too): column operations are the row operations on the transposed grid. */
function transpose(rows: TableCell[][]): TableCell[][] {
  return (rows[0] ?? []).map((_, j) => rows.map((row) => {
    const cell = row[j];
    if (cell.rowSpan === undefined && cell.colSpan === undefined) return cell;
    const { rowSpan, colSpan, ...rest } = cell;
    return { ...rest, ...(colSpan !== undefined ? { rowSpan: colSpan } : {}), ...(rowSpan !== undefined ? { colSpan: rowSpan } : {}) };
  }));
}

/** Insert an empty row at index `i`; a merged cell that spans across the new position grows by one row (the new cells under it are covered). */
function insertRowIn(rows: TableCell[][], i: number, cols: number): TableCell[][] {
  const row = Array.from({ length: cols }, emptyCell);
  const grown = new Map<string, CellRect>();
  if (i > 0 && i < rows.length) {
    for (let j = 0; j < cols; j++) {
      const k = rectOf(rows, i, j);
      if (k.r1 < i) { row[j] = coveredCell(); grown.set(`${k.r1}:${k.c1}`, k); }
    }
  }
  const out = [...rows.slice(0, i), row, ...rows.slice(i)];
  grown.forEach((k) => { out[k.r1] = out[k.r1].map((cell, j) => (j === k.c1 ? { ...cell, rowSpan: k.r2 - k.r1 + 2 } : cell)); });
  return out;
}

/** Delete row `at`; a merged cell loses one row, and when its anchor row goes, the cell below becomes the anchor. */
function deleteRowIn(rows: TableCell[][], at: number): TableCell[][] {
  const out = rows.slice(); // rows are copied only when a merge needs them changed
  const own = new Set<number>();
  const edit = (r: number, c: number, cell: TableCell) => { if (!own.has(r)) { out[r] = out[r].slice(); own.add(r); } out[r][c] = cell; };
  const seen = new Set<string>();
  for (let j = 0; j < (rows[at]?.length ?? 0); j++) {
    const k = rectOf(rows, at, j);
    const key = `${k.r1}:${k.c1}`;
    if (k.r2 === k.r1 || seen.has(key)) continue;
    seen.add(key);
    const a = rows[k.r1][k.c1];
    const span = k.r2 - k.r1; // rows left after removing one
    const next = { ...a, ...(span > 1 ? { rowSpan: span } : {}) };
    if (span === 1) delete next.rowSpan;
    if (k.r1 < at) edit(k.r1, k.c1, next);
    else { const { covered: _c, ...rest } = next; edit(at + 1, k.c1, rest); }
  }
  return out.filter((_, i) => i !== at);
}

/** Insert an empty row so it becomes row index `at` (0..rows). A header row stays the first row: `at` is clamped to ≥ 1 then. */
export function insertRow(t: Pick<TableElement, 'rows' | 'cols' | 'w' | 'headerRow'>, at: number): TableEdit {
  const i = Math.max(t.headerRow && t.rows.length ? 1 : 0, Math.min(at, t.rows.length));
  return { rows: insertRowIn(t.rows, i, t.cols.length), cols: t.cols, w: t.w };
}

/** Delete row `at`; the last remaining row can't be deleted (returns the table unchanged). */
export function deleteRow(t: Grid, at: number): TableEdit {
  if (t.rows.length <= 1 || at < 0 || at >= t.rows.length) return { rows: t.rows, cols: t.cols, w: t.w };
  return { rows: deleteRowIn(t.rows, at), cols: t.cols, w: t.w };
}

/**
 * Insert an empty column so it becomes column index `at` (0..cols). The new column takes the average width and the table grows by it;
 * if that would run off the slide, all columns are scaled back so the table keeps its width.
 */
export function insertCol(t: Grid & { x: number }, at: number): TableEdit {
  const i = Math.max(0, Math.min(at, t.cols.length));
  const add = Math.max(TABLE_MIN_COL, Math.round(t.w / t.cols.length));
  let cols = [...t.cols.slice(0, i), add, ...t.cols.slice(i)];
  let w = t.w + add;
  if (t.x + w > SLIDE_W) { cols = scaleCols(cols, t.w); w = t.w; }
  return { rows: transpose(insertRowIn(transpose(t.rows), i, t.rows.length)), cols, w };
}

/** Delete column `at` (the table gets narrower by its width); the last remaining column can't be deleted. */
export function deleteCol(t: Grid, at: number): TableEdit {
  if (t.cols.length <= 1 || at < 0 || at >= t.cols.length) return { rows: t.rows, cols: t.cols, w: t.w };
  const cols = t.cols.filter((_, i) => i !== at);
  return { rows: transpose(deleteRowIn(transpose(t.rows), at)), cols, w: cols.reduce((a, b) => a + b, 0) };
}

/** Plain text of a cell (paragraphs joined with newlines) — for tests, copy and the PPTX spike's fallbacks. */
export function cellPlainText(doc: PMNode): string {
  return (doc.content ?? []).map((p) => (p.content ?? []).map((n) => n.text ?? (n.type === 'hardBreak' ? '\n' : '')).join('')).join('\n');
}

/** Column widths for a new total table width: proportional to the current widths (ratios preserved), total never below `cols × TABLE_MIN_COL`. */
export function resizeToWidth(cols: number[], width: number): { cols: number[]; w: number } {
  const w = Math.max(cols.length * TABLE_MIN_COL, Math.round(width));
  return { cols: scaleCols(cols, w), w };
}

/** Drag the boundary after column `i` by `delta` px: only columns `i` and `i+1` change, their sum (and so the table width) stays. */
export function resizeColumn(cols: number[], i: number, delta: number, min = TABLE_MIN_COL): number[] {
  if (i < 0 || i >= cols.length - 1) return cols;
  const pair = cols[i] + cols[i + 1];
  const lo = Math.min(min, Math.floor(pair / 2));
  const left = Math.max(lo, Math.min(pair - lo, cols[i] + Math.round(delta)));
  const out = cols.slice();
  out[i] = left;
  out[i + 1] = pair - left;
  return out;
}

/**
 * Drag the OUTER right edge of the last column by `delta` px: only that column changes (≥ min) and the table width follows it.
 * The table's left edge stays, and its right edge stays on the slide (a table that already pokes out may still shrink).
 */
export function resizeLastColumn(cols: number[], x: number, delta: number, min = TABLE_MIN_COL): { cols: number[]; w: number } {
  const last = cols.length - 1;
  const others = cols.reduce((a, b) => a + b, 0) - cols[last];
  const lo = Math.min(min, cols[last]);
  const hi = Math.max(lo, cols[last], SLIDE_W - x - others);
  const width = Math.max(lo, Math.min(hi, cols[last] + Math.round(delta)));
  const out = cols.slice();
  out[last] = width;
  return { cols: out, w: others + width };
}

/** Plain text (newlines → paragraphs) as a cell. */
export const textCell = (text: string): TableCell => ({
  doc: text ? { type: 'doc', content: text.split(/\r\n|\r|\n/).map((l) => (l ? { type: 'paragraph', content: [{ type: 'text', text: l }] } : { type: 'paragraph' })) } : emptyDoc(),
});

/**
 * Paste a grid of text into the table starting at (row, col): cells are overwritten, and rows/columns are appended as needed
 * (new columns grow the table like insertCol, or are scaled back to fit the slide). The result is always a valid table.
 */
export function pasteGrid(t: Pick<TableElement, 'rows' | 'cols' | 'w' | 'x' | 'headerRow'>, row: number, col: number, data: string[][]): TableEdit {
  const need = { rows: row + data.length, cols: col + Math.max(0, ...data.map((r) => r.length)) };
  let cur: TableEdit = { rows: t.rows, cols: t.cols, w: t.w };
  while (cur.rows.length < need.rows) cur = { ...cur, ...insertRow({ ...cur, headerRow: t.headerRow }, cur.rows.length) };
  while (cur.cols.length < need.cols) cur = { ...cur, ...insertCol({ ...cur, x: t.x }, cur.cols.length) };
  const rows = cur.rows.map((r) => r.slice());
  data.forEach((line, i) => line.forEach((text, j) => { const old = rows[row + i][col + j]; rows[row + i][col + j] = { ...textCell(text), ...(old.fill ? { fill: old.fill } : {}), ...(old.rowSpan ? { rowSpan: old.rowSpan } : {}), ...(old.colSpan ? { colSpan: old.colSpan } : {}), ...(old.covered ? { covered: true as const } : {}) }; }));
  return { rows, cols: cur.cols, w: cur.w };
}

// ---------- appearance (single source for the renderer's CSS variables and the PPTX export) ----------

export const TABLE_LINE = '#E5E7EB';        // Minimal / Header: row dividers
export const TABLE_LINE_LAST = '#D1D5DB';   // Minimal / Header: line under the last row
export const TABLE_LINE_HEAD = '#9CA3AF';   // Minimal / Header: line under the header row
export const TABLE_GRID_LINE = '#D1D5DB';   // Grid: every cell border
export const TABLE_HEAD_FILL = '#F3F4F6';   // Header style: neutral light gray header fill

type Look = Pick<TableElement, 'style' | 'headerRow' | 'borderColor'>;

/** Line and header-fill colors of a table. A custom `borderColor` replaces every line color; widths never change. */
export function tableColors(t: Look): { line: string; last: string; head: string; headFill: string | null } {
  const grid = t.style === 'grid';
  const c = t.borderColor;
  return {
    line: c ?? (grid ? TABLE_GRID_LINE : TABLE_LINE),
    last: c ?? (grid ? TABLE_GRID_LINE : TABLE_LINE_LAST),
    head: c ?? (grid ? TABLE_GRID_LINE : TABLE_LINE_HEAD),
    headFill: t.style === 'header' && t.headerRow ? TABLE_HEAD_FILL : null,
  };
}

export interface Edge { color: string; px: number }
/** Cell borders [top, right, bottom, left] (null = none) — what the CSS in table.css draws, for the PPTX export. */
export function cellBorders(t: Look & { rows: unknown[] }, r: number): [Edge | null, Edge | null, Edge | null, Edge | null] {
  const c = tableColors(t);
  if (t.style === 'grid') { const e = { color: c.line, px: 1 }; return [e, e, e, e]; }
  const bottom = t.headerRow && r === 0 ? { color: c.head, px: 1.5 } : r === t.rows.length - 1 ? { color: c.last, px: 1 } : { color: c.line, px: 1 };
  return [null, null, bottom, null];
}

/** Background of one cell: the custom fill, else the Header style's default (header row only), else none. */
export const cellFill = (t: Look, r: number, cell: TableCell): string | null => cell.fill ?? (r === 0 ? tableColors(t).headFill : null);

/** Set (or with null clear) the custom fill of one cell; other cells keep their objects. */
export function setCellFill(rows: TableCell[][], row: number, col: number, color: string | null): TableCell[][] {
  return rows.map((r, i) => (i !== row ? r : r.map((c, j) => (j !== col ? c : withFill(c, color)))));
}
/** Set (or clear) the custom fill of every cell. */
export const setAllFills = (rows: TableCell[][], color: string | null): TableCell[][] => rows.map((r) => r.map((c) => withFill(c, color)));
const withFill = (c: TableCell, color: string | null): TableCell => {
  const { fill: _old, ...rest } = c;
  return color ? { ...rest, fill: color } : rest;
};
/** The fill shared by every cell (null when none, or when the cells differ). */
export function uniformFill(rows: TableCell[][]): string | null {
  const all = rows.flat().map((c) => c.fill ?? null);
  return all.length && all.every((f) => f === all[0]) ? all[0] : null;
}

// ---------- whole-table scaling ----------

/** Multiply the per-paragraph font sizes of a cell doc (the same factor as the table text). Returns the same object when nothing is sized. */
function scaleDocFonts(doc: PMNode, k: number): PMNode {
  let changed = false;
  const content = (doc.content ?? []).map((p) => {
    const size = p.attrs?.fontSize as number | null | undefined;
    if (!size) return p;
    changed = true;
    return { ...p, attrs: { ...p.attrs, fontSize: Math.max(TABLE_MIN_FONT, Math.round(size * k * 10) / 10) } };
  });
  return changed ? { ...doc, content } : doc;
}

/**
 * Resize the WHOLE table to `width` (from the table `o` as it was when the gesture began): the columns keep their ratios and the text size,
 * paragraph sizes and cell padding scale by the same factor, so the table looks the same only bigger / smaller. The factor is limited so the
 * text stays between TABLE_MIN_FONT and TABLE_MAX_FONT and every column keeps its minimum width. Height follows by itself (content-driven).
 */
export function scaleTable(o: Pick<TableElement, 'rows' | 'cols' | 'w' | 'textStyle' | 'padScale'>, width: number):
  { w: number; cols: number[]; rows: TableCell[][]; fontSize: number; padScale: number; ratio: number } {
  const minW = o.cols.length * TABLE_MIN_COL;
  let k = Math.max(minW, width) / o.w;
  k = Math.min(k, TABLE_MAX_FONT / o.textStyle.fontSize);
  k = Math.max(k, TABLE_MIN_FONT / o.textStyle.fontSize, minW / o.w);
  const w = Math.round(o.w * k);
  const f = w / o.w; // the factor actually applied after rounding the width
  const resized = f !== 1;
  return {
    w, cols: scaleCols(o.cols, w), ratio: f,
    fontSize: resized ? Math.round(o.textStyle.fontSize * f * 10) / 10 : o.textStyle.fontSize,
    padScale: Math.round((o.padScale ?? 1) * f * 1000) / 1000,
    rows: resized ? o.rows.map((row) => row.map((c) => { const doc = scaleDocFonts(c.doc, f); return doc === c.doc ? c : { ...c, doc }; })) : o.rows,
  };
}
