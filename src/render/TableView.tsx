import { useMemo, type CSSProperties } from 'react';
import type { TableElement } from '../model/types';
import { expandRect, repairTable, tableColors, tablePad } from '../model/table';
import { StaticText } from './StaticText';
import { CellEditor } from '../editor/CellEditor';
import { getActiveEditor } from '../editor/active';
import { useStore } from '../store/store';
import '../table.css';

/**
 * A table element: one real <table> (fixed layout, widths from `cols`). Rows grow with their content; the cells use the same
 * static text renderer as text boxes. `edit` = the cell being edited, which swaps in the cell editor.
 */
export function TableView({ el, edit, active }: { el: TableElement; edit?: { row: number; col: number } | null; active?: { row: number; col: number } | null }) {
  const t = useMemo(() => repairTable(el), [el]);
  const st = t.textStyle;
  const colors = tableColors(t);
  const pad = tablePad(t);
  const range = useStore((st) => (edit && st.cellRange?.id === el.id ? st.cellRange : null));
  const block = useMemo(() => (range ? expandRect(t.rows, range) : null), [range, t.rows]);
  const style = {
    '--tbl-pad-x': `${pad.x}px`, '--tbl-pad-y': `${pad.y}px`,
    width: t.w, fontSize: st.fontSize, color: st.color, lineHeight: st.lineHeight, textAlign: st.align,
    // Line / header colors come from the model (one source for the CSS and the PPTX export).
    '--tbl-line': colors.line, '--tbl-last': colors.last, '--tbl-head': colors.head, '--tbl-head-fill': colors.headFill ?? 'transparent',
  } as CSSProperties;
  // `active` (editor only, never passed by thumbnails / presenter / print) outlines the cell that cell-level actions target.
  const marked = edit ?? active;

  // While editing, a press on another cell moves the caret there; a press on this cell's padding focuses its editor.
  const onCellDown = (e: React.PointerEvent, r: number, c: number) => {
    if (!edit) return;
    if (e.shiftKey && !(edit.row === r && edit.col === c && !useStore.getState().cellRange)) {
      // Shift+click extends the selection from the cell being edited (the block Merge acts on).
      e.preventDefault();
      e.stopPropagation();
      const from = useStore.getState().cellRange;
      useStore.getState().setCellRange({ id: el.id, r1: from?.r1 ?? edit.row, c1: from?.c1 ?? edit.col, r2: r, c2: c });
      return;
    }
    if (edit.row === r && edit.col === c) {
      if ((e.target as Element).tagName === 'TD') { e.preventDefault(); getActiveEditor()?.commands.focus('end'); }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    useStore.getState().startCellEditing(el.id, r, c, { x: e.clientX, y: e.clientY });
  };

  // Dragging from the cell being edited into another cell selects the block of cells between them (for Merge).
  const onTableDown = (e: React.PointerEvent) => {
    if (!edit || e.button !== 0) return;
    const from = (e.target as Element).closest('td');
    if (!from || from.dataset.r !== String(edit.row) || from.dataset.c !== String(edit.col)) return;
    const move = (ev: PointerEvent) => {
      const td = (document.elementFromPoint(ev.clientX, ev.clientY)?.closest('td[data-r]') ?? null) as HTMLElement | null;
      if (!td || !from.closest('table')?.contains(td)) return;
      const r = Number(td.dataset.r), c = Number(td.dataset.c);
      if (r === edit.row && c === edit.col && !useStore.getState().cellRange) return;
      window.getSelection()?.removeAllRanges();
      useStore.getState().setCellRange({ id: el.id, r1: edit.row, c1: edit.col, r2: r, c2: c });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <table className="ms-table" data-table-style={t.style} data-header={t.headerRow ? '' : undefined} style={style} onPointerDown={edit ? onTableDown : undefined}>
      <colgroup>{t.cols.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
      <tbody>
        {t.rows.map((row, r) => (
          <tr key={r} className={t.headerRow && r === 0 ? 'ms-head' : undefined}>
            {row.map((cell, c) => cell.covered ? null : (
              <td key={c} data-r={r} data-c={c} rowSpan={cell.rowSpan} colSpan={cell.colSpan}
                className={[marked?.row === r && marked.col === c && !block ? 'ms-active' : '', block && r >= block.r1 && r <= block.r2 && c >= block.c1 && c <= block.c2 ? 'ms-range' : ''].filter(Boolean).join(' ') || undefined}
                style={cell.fill ? { background: cell.fill } : undefined} onPointerDown={edit ? (e) => onCellDown(e, r, c) : undefined}>
                {edit?.row === r && edit.col === c ? <CellEditor key={`${el.id}:${r}:${c}`} el={el} row={r} col={c} /> : <StaticText doc={cell.doc} />}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
