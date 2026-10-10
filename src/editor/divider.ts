import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { SLIDE_H, SLIDE_W } from '../model/types';
import { newDivider } from '../model/defaults';
import { isDocEmpty } from './docUtils';
import { useStore } from '../store/store';
import type { PMNode } from '../model/types';

/** Whether the caret sits in an empty, top-level, plain paragraph (a slide-level divider is appropriate there). */
export function inEmptyTopLevelParagraph(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  return empty && $from.depth === 1 && $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0;
}

/**
 * Turns the empty paragraph under the caret into a horizontal divider: one ordinary line element at the paragraph's
 * vertical middle, spanning 90% of the slide width, centered. A box that held nothing else is replaced by the divider; otherwise
 * editing continues on the next line. Shared by the `---` shortcut and `/divider`.
 */
export function convertToDivider(editor: Editor): boolean {
  if (!inEmptyTopLevelParagraph(editor)) return false;
  const st = useStore.getState();
  const editingId = st.editingId;
  if (!editingId) return false;
  const { view, state } = editor;
  const $from = state.selection.$from;
  const slideEl = view.dom.closest('.slide') as HTMLElement | null;
  const para = view.nodeDOM($from.before()) as HTMLElement | null;
  if (!slideEl || !para) return false;
  const k = slideEl.getBoundingClientRect().width / SLIDE_W || 1; // slide is CSS-scaled
  const sr = slideEl.getBoundingClientRect(), pr = para.getBoundingClientRect();
  const y = Math.min(Math.max(0, ((pr.top + pr.bottom) / 2 - sr.top) / k), SLIDE_H);
  const line = newDivider(Math.round(y));

  const el = st.deck.slides.find((s) => s.id === st.currentSlideId)?.elements.find((e) => e.id === editingId);
  const alone = el?.type === 'text' && !el.role && state.doc.childCount === 1;
  if (alone && isDocEmpty(editor.getJSON() as PMNode)) {
    st.insertDividerFromEditor(line, editingId);
    return true;
  }
  // Keep editing on the line after the divider.
  const after = $from.after();
  if (after >= state.doc.content.size) editor.view.dispatch(state.tr.insert(after, state.schema.nodes.paragraph.create()));
  const next = editor.state;
  editor.view.dispatch(next.tr.setSelection(TextSelection.near(next.doc.resolve($from.after() + 1))));
  st.insertDividerFromEditor(line);
  return true;
}
