import { useMemo, type CSSProperties } from 'react';
import type { TableElement } from '../model/types';
import { repairTable } from '../model/table';
import { StaticText } from './StaticText';
import { CellEditor } from '../editor/CellEditor';
import { getActiveEditor } from '../editor/active';
import { useStore } from '../store/store';
import '../table.css';

/**
 * A table element: one real <table> (fixed layout, widths from `cols`). Rows grow with their content; the cells use the same
 * static text renderer as text boxes. `edit` = the cell being edited, which swaps in the cell editor.
 */
export function TableView({ el, edit }: { el: TableElement; edit?: { row: number; col: number } | null }) {
  const t = useMemo(() => repairTable(el), [el]);
  const st = t.textStyle;
  const style: CSSProperties = { width: t.w, fontSize: st.fontSize, color: st.color, lineHeight: st.lineHeight, textAlign: st.align };

  // While editing, a press on another cell moves the caret there; a press on this cell's padding focuses its editor.
  const onCellDown = (e: React.PointerEvent, r: number, c: number) => {
    if (!edit) return;
    if (edit.row === r && edit.col === c) {
      if ((e.target as Element).tagName === 'TD') { e.preventDefault(); getActiveEditor()?.commands.focus('end'); }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    useStore.getState().startCellEditing(el.id, r, c, { x: e.clientX, y: e.clientY });
  };

  return (
    <table className="ms-table" data-table-style={t.style} data-header={t.headerRow ? '' : undefined} style={style}>
      <colgroup>{t.cols.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
      <tbody>
        {t.rows.map((row, r) => (
          <tr key={r} className={t.headerRow && r === 0 ? 'ms-head' : undefined}>
            {row.map((cell, c) => (
              <td key={c} data-r={r} data-c={c} onPointerDown={edit ? (e) => onCellDown(e, r, c) : undefined}>
                {edit?.row === r && edit.col === c ? <CellEditor key={`${el.id}:${r}:${c}`} el={el} row={r} col={c} /> : <StaticText doc={cell.doc} />}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
