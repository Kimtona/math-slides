import type { TableElement } from '../model/types';
import { deleteCol, deleteRow, insertCol, insertRow } from '../model/table';
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
