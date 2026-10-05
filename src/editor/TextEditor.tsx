import { useEffect, useMemo, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import type { TextElement } from '../model/types';
import type { PMNode } from '../model/types';
import { currentSlide, useStore } from '../store/store';
import { makeExtensions } from './extensions';
import { setActiveEditor } from './active';
import { SlashMenu } from './SlashMenu';
import { openMath } from './mathNodes';
import { insertImageFiles } from '../canvas/insert';

/** In-place rich text editor for the text box being edited. */
export function TextEditor({ el }: { el: TextElement }) {
  const slashKey = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  const extensions = useMemo(() => makeExtensions(true, { toc: el.role === 'toc' }), [el.role]);

  const editor = useEditor({
    extensions,
    content: el.doc,
    editorProps: {
      attributes: { class: 'tb-content', spellcheck: 'false' },
      handleKeyDown: (_view, event) => {
        if (slashKey.current?.(event)) return true;
        if (event.key === 'Escape' && !useStore.getState().mathEdit) {
          useStore.getState().stopEditing();
          const exists = currentSlide().elements.some((e) => e.id === el.id);
          useStore.setState({ selection: exists ? [el.id] : [] });
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (files.length) {
          useStore.getState().stopEditing();
          insertImageFiles(files);
          return true;
        }
        return false;
      },
      handleDrop: () => true, // images dropped on a text box go to the canvas handler
    },
    onUpdate: ({ editor }) => {
      const doc = editor.getJSON() as PMNode;
      useStore.getState().updateElements([el.id], (e) => { (e as TextElement).doc = doc; }, true);
    },
  });

  useEffect(() => {
    if (!editor) return;
    setActiveEditor(editor);
    const { editCaret } = useStore.getState();
    const view = editor.view;
    view.focus();
    if (editCaret === 'all') editor.commands.selectAll();
    else if (editCaret === 'math') openMath(editor, 0);
    else if (editCaret && typeof editCaret === 'object') {
      const hit = view.posAtCoords({ left: editCaret.x, top: editCaret.y });
      if (hit) {
        const node = hit.inside >= 0 ? view.state.doc.nodeAt(hit.inside) : null;
        if (node && (node.type.name === 'mathInline' || node.type.name === 'mathBlock')) openMath(editor, hit.inside);
        else view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(hit.pos))));
      } else editor.commands.focus('end');
    } else editor.commands.focus('end');
    return () => setActiveEditor(null);
  }, [editor]);

  return (
    <>
      <EditorContent editor={editor} />
      {editor && <SlashMenu editor={editor} keyRef={slashKey} />}
    </>
  );
}
