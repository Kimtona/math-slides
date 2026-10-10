import type { TableElement, TableStyle } from '../model/types';
import { deleteCol, deleteRow, insertCol, insertRow, setAllFills, setCellFill } from '../model/table';
import { currentSlide, useStore } from '../store/store';

/** Row/column actions of the toolbar and Tab: act on the cell being edited, else on the end of the table. Each is one undo step. */

const tableOf = (id: string) => currentSlide().elements.find((e): e is TableElement => e.id === id && e.type === 'table');
const cellOf = (id: string) => { const st = useStore.getState(); return st.editingId === id ? st.editCell : null; };

/** `end`: append at the end of the table (the edge "+" controls) instead of after the cell being edited; editing then stays in the same cell. */
export function addRow(id: string, opts: { end?: boolean } = {}) {
  const t = tableOf(id);
  if (!t) return;
  const cell = cellOf(id);
  const at = cell && !opts.end ? cell.row + 1 : t.rows.length;
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
  const at = cell && !opts.end ? cell.col + 1 : t.cols.length;
  useStore.getState().editTable(id, (d) => Object.assign(d, insertCol(d, at)), cell ? (opts.end ? cell : { row: cell.row, col: at }) : null);
}

export function removeCol(id: string) {
  const t = tableOf(id);
  if (!t || t.cols.length <= 1) return;
  const cell = cellOf(id);
  const at = cell ? cell.col : t.cols.length - 1;
  useStore.getState().editTable(id, (d) => Object.assign(d, deleteCol(d, at)), cell ? { row: cell.row, col: Math.min(at, t.cols.length - 2) } : null);
}

/** Tab / Shift+Tab. Tab on the last cell appends a row. Returns true when handled. */
export function tabFrom(id: string, backwards: boolean): boolean {
  const t = tableOf(id), cell = cellOf(id);
  if (!t || !cell) return false;
  const st = useStore.getState();
  const R = t.rows.length, C = t.cols.length;
  let { row, col } = cell;
  if (backwards) {
    if (col > 0) col--; else if (row > 0) { row--; col = C - 1; } else return true;
  } else if (col < C - 1) col++;
  else if (row < R - 1) { row++; col = 0; }
  else { st.editTable(id, (d) => Object.assign(d, insertRow(d, R)), { row: R, col: 0 }); return true; }
  st.startCellEditing(id, row, col, 'all');
  return true;
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
