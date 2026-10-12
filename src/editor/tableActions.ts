import type { TableElement, TableStyle } from '../model/types';
import { anchorOf, deleteCol, deleteRow, expandRect, insertCol, insertRow, isMerged, mergeCells, rectOf, setAllFills, setCellFill, unmergeCells } from '../model/table';
import { currentSlide, useStore } from '../store/store';

/** Row/column actions of the toolbar and Tab: act on the cell being edited, else on the end of the table. Each is one undo step. */

const tableOf = (id: string) => currentSlide().elements.find((e): e is TableElement => e.id === id && e.type === 'table');
const cellOf = (id: string) => { const st = useStore.getState(); return st.editingId === id ? st.editCell : null; };

/** `end`: append at the end of the table (the edge "+" controls) instead of after the cell being edited; editing then stays in the same cell. */
export function addRow(id: string, opts: { end?: boolean } = {}) {
  const t = tableOf(id);
  if (!t) return;
  const cell = cellOf(id);
  const at = cell && !opts.end ? rectOf(t.rows, cell.row, cell.col).r2 + 1 : t.rows.length;
  useStore.getState().editTable(id, (d) => Object.assign(d, insertRow(d, at)), cell ? (opts.end ? cell : { row: at, col: cell.col }) : null);
}

export function removeRow(id: string) {
  const t = tableOf(id);
  if (!t || t.rows.length <= 1) return;
  const cell = cellOf(id);
  const at = cell ? cell.row : t.rows.length - 1;
  useStore.getState().editTable(id, (d) => Object.assign(d, deleteRow(d, at)), cell ? { row: Math.min(at, t.rows.length - 2), col: cell.col } : null);
}

export function addCol(id: string, opts: { end?: boolean } = {}) {
  const t = tableOf(id);
  if (!t) return;
  const cell = cellOf(id);
  const at = cell && !opts.end ? rectOf(t.rows, cell.row, cell.col).c2 + 1 : t.cols.length;
  useStore.getState().editTable(id, (d) => Object.assign(d, insertCol(d, at)), cell ? (opts.end ? cell : { row: cell.row, col: at }) : null);
}

export function removeCol(id: string) {
  const t = tableOf(id);
  if (!t || t.cols.length <= 1) return;
  const cell = cellOf(id);
  const at = cell ? cell.col : t.cols.length - 1;
  useStore.getState().editTable(id, (d) => Object.assign(d, deleteCol(d, at)), cell ? { row: cell.row, col: Math.min(at, t.cols.length - 2) } : null);
}

/** The next cell in reading order that is not hidden under a merged cell (null past either end). */
function stepCell(t: TableElement, from: { row: number; col: number }, backwards: boolean): { row: number; col: number } | null {
  const R = t.rows.length, C = t.cols.length;
  let { row, col } = from;
  for (;;) {
    if (backwards) { if (col > 0) col--; else if (row > 0) { row--; col = C - 1; } else return null; }
    else if (col < C - 1) col++;
    else if (row < R - 1) { row++; col = 0; }
    else return null;
    if (!t.rows[row][col].covered) return { row, col };
  }
}

/** Tab / Shift+Tab. Tab on the last cell appends a row. Returns true when handled. */
export function tabFrom(id: string, backwards: boolean): boolean {
  const t = tableOf(id), cell = cellOf(id);
  if (!t || !cell) return false;
  const st = useStore.getState();
  const next = stepCell(t, cell, backwards);
  if (!next && backwards) return true;
  if (!next) { st.editTable(id, (d) => Object.assign(d, insertRow(d, t.rows.length)), { row: t.rows.length, col: 0 }); return true; }
  st.startCellEditing(id, next.row, next.col, 'all');
  return true;
}

export type ArrowDir = 'up' | 'down' | 'left' | 'right';

/**
 * ←↑↓→ at the edge of a cell's text moves to the neighbouring cell (a merged cell counts as one cell). `from` is the caret's screen x/y, used to
 * keep the horizontal position when moving up or down. Returns false when there is no neighbour (the key then behaves as usual).
 */
export function arrowFrom(id: string, dir: ArrowDir, from?: { x: number }): boolean {
  const t = tableOf(id), cell = cellOf(id);
  if (!t || !cell) return false;
  const k = rectOf(t.rows, cell.row, cell.col);
  const r = dir === 'up' ? k.r1 - 1 : dir === 'down' ? k.r2 + 1 : cell.row;
  const c = dir === 'left' ? k.c1 - 1 : dir === 'right' ? k.c2 + 1 : cell.col;
  if (r < 0 || c < 0 || r >= t.rows.length || c >= t.cols.length) return false;
  const to = anchorOf(t.rows, r, c);
  let caret: Parameters<ReturnType<typeof useStore.getState>['startCellEditing']>[3] = dir === 'left' || dir === 'up' ? 'end' : 'start';
  if (from && (dir === 'up' || dir === 'down')) {
    const td = document.querySelector(`[data-el-id="${id}"] td[data-r="${to.row}"][data-c="${to.col}"]`)?.getBoundingClientRect();
    if (td) caret = { x: from.x, y: dir === 'down' ? td.top + 12 : td.bottom - 12 };
  }
  useStore.getState().startCellEditing(id, to.row, to.col, caret);
  return true;
}

// ---------- merged cells ----------

/** Merge the selected block of cells into one (one undo step). Editing continues in the merged cell. */
export function mergeSelectedCells(id: string) {
  const st = useStore.getState(), t = tableOf(id), range = st.cellRange;
  if (!t || !range || range.id !== id) return;
  const k = expandRect(t.rows, range);
  if (k.r1 === k.r2 && k.c1 === k.c2) return;
  st.editTable(id, (d) => { d.rows = mergeCells(d.rows, k).rows; }, st.editingId === id ? { row: k.r1, col: k.c1 } : null);
  useStore.getState().setCellRange(null);
  useStore.setState({ activeCell: { id, row: k.r1, col: k.c1 } });
}

/** Split the merged cell the cell actions target back into single cells (one undo step). */
export function unmergeSelectedCell(id: string) {
  const t = tableOf(id);
  const cell = t && targetCell(t);
  if (!t || !cell || !isMerged(t.rows, cell.row, cell.col)) return;
  const k = rectOf(t.rows, cell.row, cell.col);
  restyle(id, (d) => { d.rows = unmergeCells(d.rows, k.r1, k.c1); });
}

// ---------- appearance: each one undo step, and an open cell editor stays open ----------

/** Run an appearance change as its own undo step. While a cell is being edited it stays in edit mode in the same cell. */
const restyle = (id: string, fn: (t: import('immer').Draft<TableElement>) => void) => useStore.getState().editTable(id, fn, cellOf(id));

export const setTableStyle = (id: string, style: TableStyle) => restyle(id, (d) => { d.style = style; });
export const setHeaderRow = (id: string, on: boolean) => restyle(id, (d) => { d.headerRow = on; });
/** Add / remove the caption. Leaves cell editing (so the caption field can take focus and the undo steps stay separate). */
export const addTableCaption = (id: string) => useStore.getState().editTable(id, (d) => { d.caption = ''; }, null);
export const removeTableCaption = (id: string) => useStore.getState().editTable(id, (d) => { delete d.caption; }, null);
export const setTableBorder = (id: string, color: string | null) => restyle(id, (d) => { if (color) d.borderColor = color; else delete d.borderColor; });

/** The cell that cell-level actions (fill) target: the cell being edited, else the one last edited; null = the whole table. */
export function targetCell(t: TableElement): { row: number; col: number } | null {
  const st = useStore.getState();
  const c = st.editingId === t.id ? st.editCell : st.activeCell?.id === t.id && st.selection.length === 1 && st.selection[0] === t.id ? st.activeCell : null;
  return c ? { row: Math.min(c.row, t.rows.length - 1), col: Math.min(c.col, t.cols.length - 1) } : null;
}

/** Fill the target cell, or every cell when only the table is selected. null removes the custom fill (the style default shows again). */
export function setTableFill(id: string, color: string | null) {
  const t = tableOf(id);
  if (!t) return;
  const cell = targetCell(t);
  restyle(id, (d) => { d.rows = cell ? setCellFill(d.rows, cell.row, cell.col, color) : setAllFills(d.rows, color); });
}
