import { Editor, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextStyle from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import Placeholder from '@tiptap/extension-placeholder';
import { MathBlock, MathInline } from './mathNodes';
import type { PMNode } from '../model/types';

export function makeExtensions(withPlaceholder = true): Extensions {
  const exts: Extensions = [
    StarterKit.configure({
      heading: false,
      blockquote: false,
      codeBlock: false,
      code: false,
      horizontalRule: false,
      dropcursor: false,
      gapcursor: false,
    }),
    Underline,
    TextStyle,
    Color,
    MathInline,
    MathBlock,
  ];
  if (withPlaceholder) exts.push(Placeholder.configure({ placeholder: "텍스트 입력, '/' 로 명령 (/math)" }));
  return exts;
}

/** Applies editor commands to a whole stored document (used when a box is selected but not being edited). */
export function transformDoc(doc: PMNode, fn: (editor: Editor) => void): PMNode {
  const ed = new Editor({ extensions: makeExtensions(false), content: doc });
  ed.commands.selectAll();
  fn(ed);
  const out = ed.getJSON() as PMNode;
  ed.destroy();
  return out;
}

/** Whether every text run in the doc has the given mark. */
export function docAllMarked(doc: PMNode, mark: string): boolean {
  let any = false, all = true;
  const walk = (n: PMNode) => {
    if (n.type === 'text' && n.text?.trim()) {
      any = true;
      if (!n.marks?.some((m) => m.type === mark)) all = false;
    }
    n.content?.forEach(walk);
  };
  walk(doc);
  return any && all;
}
