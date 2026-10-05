import type { Editor } from '@tiptap/core';
import type { TextElement, TextStyle } from '../model/types';
import { currentSlide, useStore } from '../store/store';
import { getActiveEditor } from '../editor/active';
import { docAllMarked, transformDoc } from '../editor/extensions';

const selectedTexts = () => {
  const st = useStore.getState();
  return currentSlide().elements.filter((e): e is TextElement => e.type === 'text' && st.selection.includes(e.id));
};

/** Run an editor command on the live editor, or on the whole content of each selected text box. */
function applyEditor(fn: (ed: Editor) => void, forBoxes?: (doc: TextElement['doc']) => (ed: Editor) => void) {
  const ed = getActiveEditor();
  if (ed && useStore.getState().editingId) {
    fn(ed);
    return;
  }
  const texts = selectedTexts();
  if (!texts.length) return;
  useStore.getState().updateElements(texts.map((t) => t.id), (d) => {
    const t = d as TextElement;
    t.doc = transformDoc(t.doc as any, forBoxes ? forBoxes(t.doc as any) : fn);
  });
}

export type MarkName = 'bold' | 'italic' | 'underline' | 'strike';

export function toggleMark(mark: MarkName) {
  const cmd: Record<MarkName, (ed: Editor) => void> = {
    bold: (ed) => ed.chain().focus().toggleBold().run(),
    italic: (ed) => ed.chain().focus().toggleItalic().run(),
    underline: (ed) => ed.chain().focus().toggleUnderline().run(),
    strike: (ed) => ed.chain().focus().toggleStrike().run(),
  };
  // For whole boxes: if every run already has the mark, remove it; otherwise add it everywhere.
  applyEditor(cmd[mark], (doc) => (ed) => {
    if (docAllMarked(doc, mark)) ed.chain().unsetMark(mark).run();
    else ed.chain().setMark(mark).run();
  });
}

export function setTextColor(color: string) {
  const ed = getActiveEditor();
  if (ed && useStore.getState().editingId && !ed.state.selection.empty) {
    ed.chain().focus().setColor(color).run();
    return;
  }
  // No text selected: change the box's base color and clear per-run colors.
  const st = useStore.getState();
  const ids = st.editingId ? [st.editingId] : selectedTexts().map((t) => t.id);
  if (ed && st.editingId) {
    // Clear run colors in place, keeping the caret where it is.
    const { tr, schema } = ed.state;
    tr.removeMark(0, tr.doc.content.size, schema.marks.textStyle);
    tr.setStoredMarks([]);
    ed.view.dispatch(tr);
    ed.view.focus();
  }
  st.updateElements(ids, (d) => {
    const t = d as TextElement;
    t.style.color = color;
    if (!st.editingId) t.doc = transformDoc(t.doc as any, (e) => e.chain().unsetColor().run());
  });
}

export function toggleList(kind: 'bullet' | 'ordered') {
  applyEditor((ed) => (kind === 'bullet' ? ed.chain().focus().toggleBulletList().run() : ed.chain().focus().toggleOrderedList().run()));
}

export function setTextStyle(partial: Partial<TextStyle>) {
  const st = useStore.getState();
  const ids = st.editingId ? [st.editingId] : selectedTexts().map((t) => t.id);
  st.updateElements(ids, (d) => Object.assign((d as TextElement).style, partial));
}

/** Current mark state for toolbar highlighting. */
export function markActive(mark: MarkName, el: TextElement | undefined, editing: boolean): boolean {
  const ed = getActiveEditor();
  if (editing && ed) return ed.isActive(mark);
  return !!el && docAllMarked(el.doc, mark);
}
