import { useEffect, useReducer } from 'react';
import type { TableElement, TextElement } from '../model/types';
import { getActiveEditor, onActiveEditorChange } from '../editor/active';
import { Btn, Icons, MenuItem, NumberField, Popover, Sep } from './controls';
import { HighlightButton, PaletteColorButton, TextColorButton } from './TextColorPalette';
import { useStore } from '../store/store';
import { uniformFill } from '../model/table';
import type { TableStyle } from '../model/types';
import { activeTextColor, markActive, setTextStyle, toggleMark } from './textFormat';
import { emptyDoc } from '../model/defaults';
import { addCol, addRow, removeCol, removeRow, setHeaderRow, setTableBorder, setTableFill, setTableStyle, targetCell } from '../editor/tableActions';
import { openLinkPopover } from '../editor/linkMark';

/** The table seen through the text-format helpers (they read `style` and the active editor). */
const tableAsText = (el: TableElement): TextElement => ({ ...el, type: 'text', doc: emptyDoc(), style: el.textStyle } as unknown as TextElement);

/** Re-render on every transaction of the active (cell) editor, for the B/I/U state. */
function useEditorTick() {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    let off: (() => void) | null = null;
    const attach = () => {
      off?.();
      const ed = getActiveEditor();
      if (ed) { ed.on('transaction', tick); off = () => ed.off('transaction', tick); } else off = null;
      tick();
    };
    attach();
    const un = onActiveEditorChange(attach);
    return () => { un(); off?.(); };
  }, []);
}

/** Properties of a selected table (Phase 1): text formatting of the cell being edited, and row/column actions. */
const STYLE_LABELS: Record<TableStyle, string> = { minimal: 'Minimal', grid: 'Grid', header: 'Header' };

export function TableProps({ el, editing }: { el: TableElement; editing: boolean }) {
  useEditorTick();
  // Re-render when the cell being edited / last edited changes: the fill control follows it.
  useStore((s) => s.editCell); useStore((s) => s.activeCell);
  const cell = targetCell(el);
  const fillValue = cell ? el.rows[cell.row][cell.col].fill ?? null : uniformFill(el.rows);
  const t = tableAsText(el);
  const ed = editing ? getActiveEditor() : null;
  const size = el.textStyle.fontSize;
  return (
    <>
      {editing && (
        <>
          <Btn title="글자 작게" onClick={() => setTextStyle({ fontSize: Math.max(6, size - 2) })}>−</Btn>
          <NumberField value={size} min={6} max={300} title="표 글자 크기 (px)" onChange={(v) => setTextStyle({ fontSize: v })} />
          <Btn title="글자 크게" onClick={() => setTextStyle({ fontSize: size + 2 })}>+</Btn>
          <Sep />
          <Btn title="굵게 ⌘B" active={markActive('bold', t, true)} onClick={() => toggleMark('bold')}><b>B</b></Btn>
          <Btn title="기울임 ⌘I" active={markActive('italic', t, true)} onClick={() => toggleMark('italic')}><i style={{ fontFamily: 'serif' }}>I</i></Btn>
          <Btn title="밑줄 ⌘U" active={markActive('underline', t, true)} onClick={() => toggleMark('underline')}><u>U</u></Btn>
          <Btn title="취소선" active={markActive('strike', t, true)} onClick={() => toggleMark('strike')}><s>S</s></Btn>
          <TextColorButton value={activeTextColor(t, true)} />
          <HighlightButton value={activeTextColor(t, true, 'highlight')} />
          <Btn title="링크 ⌘K" active={!!ed?.isActive('userLink')} disabled={!ed} onClick={() => ed && openLinkPopover(ed)}>🔗</Btn>
          <Sep />
          <Btn title="왼쪽 정렬" active={el.textStyle.align === 'left'} onClick={() => setTextStyle({ align: 'left' })}>{Icons.tAlignL}</Btn>
          <Btn title="가운데 정렬" active={el.textStyle.align === 'center'} onClick={() => setTextStyle({ align: 'center' })}>{Icons.tAlignC}</Btn>
          <Btn title="오른쪽 정렬" active={el.textStyle.align === 'right'} onClick={() => setTextStyle({ align: 'right' })}>{Icons.tAlignR}</Btn>
          <Sep />
        </>
      )}
      <Popover title="표 스타일" button={<span className="small-label">{STYLE_LABELS[el.style]} ▾</span>}>
        {(close) => (
          <div className="menu">
            {(Object.keys(STYLE_LABELS) as TableStyle[]).map((s) => (
              <MenuItem key={s} onClick={() => { setTableStyle(el.id, s); close(); }}>{s === el.style ? '✓ ' : ''}{STYLE_LABELS[s]}</MenuItem>
            ))}
          </div>
        )}
      </Popover>
      <Btn wide title="헤더 행 강조 켜기/끄기" active={el.headerRow} onClick={() => setHeaderRow(el.id, !el.headerRow)}>헤더</Btn>
      <PaletteColorButton title={cell ? '셀 채우기' : '표 전체 채우기'} label={<span className="small-label">{cell ? '셀 채우기' : '표 채우기'}</span>} value={fillValue}
        onChange={(c) => setTableFill(el.id, c)} onNone={() => setTableFill(el.id, null)} noneLabel="기본" />
      <PaletteColorButton title="표 선 색" label={<span className="small-label">표 선</span>} value={el.borderColor ?? null}
        onChange={(c) => setTableBorder(el.id, c)} onNone={() => setTableBorder(el.id, null)} noneLabel="기본" />
      <Sep />
      <span className="small-label">표</span>
      <Btn wide title="아래에 행 추가 (끝 셀에서 Tab)" onClick={() => addRow(el.id)}>+ 행</Btn>
      <Btn wide title="현재 행 삭제" disabled={el.rows.length <= 1} onClick={() => removeRow(el.id)}>− 행</Btn>
      <Btn wide title="오른쪽에 열 추가" onClick={() => addCol(el.id)}>+ 열</Btn>
      <Btn wide title="현재 열 삭제" disabled={el.cols.length <= 1} onClick={() => removeCol(el.id)}>− 열</Btn>
    </>
  );
}
