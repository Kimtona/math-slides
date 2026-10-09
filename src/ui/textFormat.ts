import type { Editor } from '@tiptap/core';
import type { TextElement, TextStyle } from '../model/types';
import { currentSlide, useStore } from '../store/store';
import { getActiveEditor } from '../editor/active';
import { docAllMarked, transformDoc } from '../editor/extensions';
import type { Mark } from '@tiptap/pm/model';
import { normalizeTextColor } from '../model/colors';
import { shapeTextStyle } from '../model/defaults';
import { DEFAULT_FONT, clearRunFonts, deckFont, type SlideFont } from '../model/fonts';

/** Capture before a palette input takes focus. Refuse stale targets instead of coloring another box. */
export function captureTextSelection(): () => boolean {
  const ed = getActiveEditor();
  const { editingId, currentSlideId, selection } = useStore.getState();
  const bookmark = ed && editingId ? ed.state.selection.getBookmark() : null;
  const storedMarks = ed?.state.storedMarks ?? null;
  const doc = ed?.state.doc;
  return () => {
    const st = useStore.getState();
    if (st.currentSlideId !== currentSlideId || st.editingId !== editingId) return false;
    if (editingId) {
      if (!ed || ed.isDestroyed || getActiveEditor() !== ed || ed.state.doc !== doc || !bookmark) return false;
      ed.view.dispatch(ed.state.tr.setSelection(bookmark.resolve(ed.state.doc)).setStoredMarks(storedMarks));
    } else if (selection.join() !== st.selection.join()) return false;
    return true;
  };
}

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

export type MarkName = 'bold' | 'italic' | 'underline' | 'strike' | 'code';

export function toggleMark(mark: MarkName) {
  const cmd: Record<MarkName, (ed: Editor) => void> = {
    bold: (ed) => ed.chain().focus().toggleBold().run(),
    italic: (ed) => ed.chain().focus().toggleItalic().run(),
    underline: (ed) => ed.chain().focus().toggleUnderline().run(),
    strike: (ed) => ed.chain().focus().toggleStrike().run(),
    code: (ed) => ed.chain().focus().toggleMark('code').run(),
  };
  // For whole boxes: if every run already has the mark, remove it; otherwise add it everywhere.
  applyEditor(cmd[mark], (doc) => (ed) => {
    if (docAllMarked(doc, mark)) ed.chain().unsetMark(mark).run();
    else ed.chain().setMark(mark).run();
  });
}

/**
 * Text color:
 * - an actual text range selected (while editing) → only that range gets a color mark;
 * - caret only, or the box itself selected → the box's default color (TextStyle.color) changes and
 *   per-run colors are cleared, so block equations and list markers, which inherit the box color,
 *   follow too. No per-character marks are added in this case.
 */
/** The style object a text-like element keeps its defaults in (text box: `style`; shape: `textStyle`). */
function styleOf(d: any): TextStyle {
  if (d.type === 'shape') return (d.textStyle ??= { ...shapeTextStyle(d) });
  if (d.type === 'table') return d.textStyle;
  return d.style;
}

export function setTextColor(color: string) {
  const ed = getActiveEditor();
  const st = useStore.getState();
  if (ed && st.editingId && !ed.state.selection.empty) {
    ed.chain().focus().setColor(color).run();
    return;
  }
  if (ed && st.editingId) {
    // Clear run colors in place (one text-history step), keeping the caret and other stored marks.
    const { tr, schema, selection } = ed.state;
    const type = schema.marks.textStyle;
    // Only the color goes: a per-range font (same textStyle mark) is kept.
    const dropColor = (m: Mark) => (m.attrs.fontFamily ? [type.create({ ...m.attrs, color: null })] : []);
    tr.doc.descendants((node, pos) => {
      for (const m of node.marks) {
        if (m.type !== type || !m.attrs.color) continue;
        tr.removeMark(pos, pos + node.nodeSize, m);
        dropColor(m).forEach((k) => tr.addMark(pos, pos + node.nodeSize, k));
      }
    });
    const stored = ed.state.storedMarks ?? selection.$from.marks();
    tr.setStoredMarks(stored.flatMap((m) => (m.type === type ? dropColor(m) : [m])));
    if (tr.docChanged || tr.storedMarksSet) ed.view.dispatch(tr);
    ed.view.focus();
  }
  const ids = st.editingId ? [st.editingId] : selectedTexts().map((t) => t.id);
  st.updateElements(ids, (d) => {
    const t = d as TextElement;
    styleOf(d).color = color;
    if (!st.editingId) t.doc = transformDoc(t.doc as any, (e) => e.chain().unsetColor().run());
  });
}

/**
 * Font of the selected text (a per-range textStyle mark). Needs an actual selection while editing, or a caret
 * (applies to what is typed next); with a whole box selected it applies to all of that box's text.
 * The presentation-wide font is a separate action (setDeckFont).
 */
export function setSelectionFont(font: SlideFont) {
  applyEditor((ed) => ed.chain().focus().setMark('textStyle', { fontFamily: font }).run());
}

/** The font of the selected text: the run's own font, else the deck's. null = mixed. */
export function activeTextFont(el: TextElement, editing: boolean): SlideFont | null {
  const deck = deckFont(useStore.getState().deck.fontFamily);
  const values = new Set<SlideFont>();
  const collect = (marks: readonly Mark[] | NonNullable<TextElement['doc']['marks']>) => {
    const found = marks.find((m) => (typeof m.type === 'string' ? m.type : m.type.name) === 'textStyle');
    values.add(deckFont(found?.attrs?.fontFamily ?? deck));
  };
  const ed = editing ? getActiveEditor() : null;
  if (ed) {
    const { from, to, empty, $from } = ed.state.selection;
    if (empty) collect(ed.state.storedMarks ?? $from.marks());
    else ed.state.doc.nodesBetween(from, to, (node) => { if (node.isInline) collect(node.marks); });
  } else {
    const walk = (n: TextElement['doc']) => {
      if (n.type === 'text' || n.type === 'mathInline') collect(n.marks ?? []);
      n.content?.forEach(walk);
    };
    walk(el.doc);
  }
  return values.size > 1 ? null : [...values][0] ?? deck;
}

/** "Apply this font to all text in the presentation": sets the deck font and clears every per-range font override. */
export function setDeckFont(font: SlideFont) {
  useStore.getState().commit((d) => {
    if (font === DEFAULT_FONT) delete d.fontFamily;
    else d.fontFamily = font;
    for (const slide of d.slides) for (const el of slide.elements) if ((el.type === 'text' || el.type === 'shape') && el.doc) clearRunFonts(el.doc as any);
  });
}

export function setHighlight(color: string | null) {
  applyEditor((ed) => {
    const chain = ed.chain().focus();
    if (color) chain.setMark('highlight', { color }).run();
    else chain.unsetMark('highlight').run();
  });
}

/** null = mixed; base color/absence are included rather than taking the first marked run. */
export function activeTextColor(el: TextElement, editing: boolean, kind: 'textStyle' | 'highlight' = 'textStyle'): string | null {
  const fallback = kind === 'textStyle' ? el.style.color : '';
  const values = new Set<string>();
  const collect = (marks: readonly Mark[] | NonNullable<TextElement['doc']['marks']>) => {
    const found = marks.find((m) => (typeof m.type === 'string' ? m.type : m.type.name) === kind);
    const value = found?.attrs?.color || fallback;
    values.add(normalizeTextColor(value));
  };
  const ed = editing ? getActiveEditor() : null;
  if (ed) {
    const { from, to, empty, $from } = ed.state.selection;
    if (empty) collect(ed.state.storedMarks ?? $from.marks());
    else ed.state.doc.nodesBetween(from, to, (node) => { if (node.isInline) collect(node.marks); });
  } else {
    const walk = (n: TextElement['doc']) => {
      if (n.type === 'text' || n.type === 'mathInline') collect(n.marks ?? []);
      n.content?.forEach(walk);
    };
    walk(el.doc);
  }
  return values.size > 1 ? null : [...values][0] ?? fallback;
}

export function toggleList(kind: 'bullet' | 'ordered') {
  applyEditor((ed) => (kind === 'bullet' ? ed.chain().focus().toggleBulletList().run() : ed.chain().focus().toggleOrderedList().run()));
}

export function setTextStyle(partial: Partial<TextStyle>) {
  const st = useStore.getState();
  const ids = st.editingId ? [st.editingId] : selectedTexts().map((t) => t.id);
  st.updateElements(ids, (d) => Object.assign(styleOf(d), partial));
}

/** Current mark state for toolbar highlighting. */
export function markActive(mark: MarkName, el: TextElement | undefined, editing: boolean): boolean {
  const ed = getActiveEditor();
  if (editing && ed) return ed.isActive(mark);
  return !!el && docAllMarked(el.doc, mark);
}
