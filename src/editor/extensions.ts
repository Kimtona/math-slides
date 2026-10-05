import { Editor, Extension, InputRule, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextStyle from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import Placeholder from '@tiptap/extension-placeholder';
import { MathBlock, MathInline } from './mathNodes';
import type { PMNode } from '../model/types';
import { MARKDOWN_SIZES } from '../model/typography';

/**
 * Per-line font size (paragraph attribute `fontSize`, px) + Notion-style Markdown shortcuts:
 * typing `# `, `## `, `### `, `#### ` at the start of a line removes the prefix and sizes that line
 * (sizes from model/typography.ts). A `#` anywhere else stays plain text.
 */
const ParagraphFontSize = Extension.create({
  name: 'paragraphFontSize',
  addGlobalAttributes() {
    return [{
      types: ['paragraph'],
      attributes: {
        fontSize: {
          default: null,
          keepOnSplit: false, // Enter after a heading line starts a normal line
          parseHTML: (el) => parseFloat((el as HTMLElement).style.fontSize) || null,
          renderHTML: (attrs) => (attrs.fontSize ? { style: `font-size: ${attrs.fontSize}px` } : {}),
        },
      },
    }];
  },
  addInputRules() {
    return [
      new InputRule({
        find: /^(#{1,4})\s$/,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name !== 'paragraph') return null;
          const size = MARKDOWN_SIZES[match[1].length];
          state.tr.delete(range.from, range.to);
          state.tr.setNodeMarkup($from.before(), undefined, { ...$from.parent.attrs, fontSize: size });
        },
      }),
    ];
  },
  addKeyboardShortcuts() {
    return {
      // Backspace at the start of a sized line turns it back into normal text (like Notion).
      Backspace: ({ editor }) => {
        const { selection } = editor.state;
        const { $from, empty } = selection;
        if (!empty || $from.parentOffset !== 0 || $from.parent.type.name !== 'paragraph' || !$from.parent.attrs.fontSize) return false;
        return editor.commands.updateAttributes('paragraph', { fontSize: null });
      },
    };
  },
});

/** Scale per-line font sizes (used when a text box is scaled by its corner). */
export function scaleParagraphSizes(doc: PMNode, k: number): PMNode {
  const walk = (n: PMNode): PMNode => {
    const out: PMNode = { ...n };
    if (n.type === 'paragraph' && n.attrs?.fontSize) out.attrs = { ...n.attrs, fontSize: Math.max(6, Math.round(n.attrs.fontSize * k * 2) / 2) };
    if (n.content) out.content = n.content.map(walk);
    return out;
  };
  return walk(doc);
}

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
    ParagraphFontSize,
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
