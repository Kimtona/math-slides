import { useEffect, useMemo } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import type { PMNode, TableElement } from '../model/types';
import { useStore } from '../store/store';
import { makeExtensions } from './extensions';
import { setActiveEditor } from './active';
import { tabFrom } from './tableActions';
import { isGrid, parseTsv } from '../model/tsv';
import { pasteGrid } from '../model/table';

/** In-place rich text editor for ONE table cell (the same TipTap setup as text boxes, minus blocks, lists and math). */
export function CellEditor({ el, row, col }: { el: TableElement; row: number; col: number }) {
  const extensions = useMemo(() => makeExtensions(false, { cell: true }), []);
  const cell = el.rows[row]?.[col];

  const editor = useEditor({
    extensions,
    content: cell?.doc ?? { type: 'doc', content: [{ type: 'paragraph' }] },
    editorProps: {
      attributes: { class: 'tb-content', spellcheck: 'false' },
      handleKeyDown: (_view, event) => {
        if (event.isComposing || event.keyCode === 229) return false; // IME in progress
        if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) return tabFrom(el.id, event.shiftKey);
        if (event.key === 'Escape') {
          useStore.getState().stopEditing();
          useStore.setState({ selection: [el.id] });
          return true;
        }
        return false;
      },
      // Spreadsheet data (tabs / newlines): a grid fills the table from this cell as ONE undo step; anything else pastes as normal text.
      handlePaste: (view, event) => {
        const text = event.clipboardData?.getData('text/plain') ?? '';
        const st = useStore.getState();
        if (!/[\t\r\n]/.test(text) || st.editingId !== el.id || !st.editCell) return false;
        const grid = parseTsv(text);
        event.preventDefault();
        if (!isGrid(grid)) { view.pasteText(grid[0][0]); return true; } // one cell (spreadsheets add a trailing newline / quotes)
        const { row, col } = st.editCell;
        st.editTable(el.id, (d) => Object.assign(d, pasteGrid(d, row, col, grid)), null);
        return true;
      },
      handleDrop: () => true,
    },
    onUpdate: ({ editor }) => {
      const doc = editor.getJSON() as PMNode;
      useStore.getState().beginGesture(); // this cell edit = one undo step (closed when leaving the cell / table)
      useStore.getState().updateElements([el.id], (e) => {
        const c = (e as TableElement).rows[row]?.[col];
        if (c) c.doc = doc;
      }, true);
    },
  });

  useEffect(() => {
    if (!editor) return;
    setActiveEditor(editor);
    const { editCaret } = useStore.getState();
    const view = editor.view;
    view.focus();
    if (editCaret === 'all') editor.commands.selectAll();
    else if (editCaret && typeof editCaret === 'object') {
      const hit = view.posAtCoords({ left: editCaret.x, top: editCaret.y });
      if (hit) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(hit.pos))));
      else editor.commands.focus('end');
    } else editor.commands.focus('end');
    return () => setActiveEditor(null);
  }, [editor]);

  return <EditorContent editor={editor} />;
}
