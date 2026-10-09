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

type Grid = Pick<TableElement, 'cols' | 'rows' | 'w'>;

export const emptyCell = (): TableCell => ({ doc: emptyDoc() });
export const cellText = (text: string): TableCell => ({ doc: text ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } : emptyDoc() });

/** Rough height before the browser has measured it (rows of one line); the canvas replaces it with the real value. */
export const estimateTableHeight = (rows: number, fontSize: number, lineHeight: number) =>
  Math.round(rows * (fontSize * lineHeight + 2 * TABLE_CELL_PAD_Y));

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

/** Insert an empty row so it becomes row index `at` (0..rows). A header row stays the first row: `at` is clamped to ≥ 1 then. */
export function insertRow(t: Pick<TableElement, 'rows' | 'cols' | 'w' | 'headerRow'>, at: number): TableEdit {
  const i = Math.max(t.headerRow && t.rows.length ? 1 : 0, Math.min(at, t.rows.length));
  const row = Array.from({ length: t.cols.length }, emptyCell);
  return { rows: [...t.rows.slice(0, i), row, ...t.rows.slice(i)], cols: t.cols, w: t.w };
}

/** Delete row `at`; the last remaining row can't be deleted (returns the table unchanged). */
export function deleteRow(t: Grid, at: number): TableEdit {
  if (t.rows.length <= 1 || at < 0 || at >= t.rows.length) return { rows: t.rows, cols: t.cols, w: t.w };
  return { rows: t.rows.filter((_, i) => i !== at), cols: t.cols, w: t.w };
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
  return { rows: t.rows.map((r) => [...r.slice(0, i), emptyCell(), ...r.slice(i)]), cols, w };
}

/** Delete column `at` (the table gets narrower by its width); the last remaining column can't be deleted. */
export function deleteCol(t: Grid, at: number): TableEdit {
  if (t.cols.length <= 1 || at < 0 || at >= t.cols.length) return { rows: t.rows, cols: t.cols, w: t.w };
  const cols = t.cols.filter((_, i) => i !== at);
  return { rows: t.rows.map((r) => r.filter((_, i) => i !== at)), cols, w: cols.reduce((a, b) => a + b, 0) };
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
  data.forEach((line, i) => line.forEach((text, j) => { rows[row + i][col + j] = textCell(text); }));
  return { rows, cols: cur.cols, w: cur.w };
}
