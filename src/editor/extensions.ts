import { Editor, Extension, InputRule, Mark, type Extensions } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';
import Blockquote from '@tiptap/extension-blockquote';
import { closeHistory } from '@tiptap/pm/history';
import { findWrapping } from '@tiptap/pm/transform';
import { Plugin } from '@tiptap/pm/state';
import { uid } from '../model/defaults';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextStyle from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import Placeholder from '@tiptap/extension-placeholder';
import { MathBlock, MathInline } from './mathNodes';
import type { PMNode } from '../model/types';
import { MARKDOWN_SIZES } from '../model/typography';
import { Highlight, InlineCode } from './formattingMarks';

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

/** Hyperlink mark (References entries). External links open in a new window. */
const LinkMark = Mark.create({
  name: 'link',
  inclusive: false,
  addAttributes() {
    return { href: { default: null } };
  },
  parseHTML() {
    return [{ tag: 'a[href]', getAttrs: (el) => ({ href: (el as HTMLElement).getAttribute('href') }) }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['a', { ...HTMLAttributes, class: 'doc-link', target: '_blank', rel: 'noopener noreferrer' }, 0];
  },
});

/**
 * Table of Contents entries: each top-level list item carries a stable `sectionId`.
 * In the TOC box (`toc: true`) a plugin gives every list item a unique id (new items, pasted
 * duplicates) — ids are assigned inside the editor so they survive typing, undo and paste.
 */
const TocSections = Extension.create<{ enabled: boolean }>({
  name: 'tocSections',
  addOptions() {
    return { enabled: false };
  },
  addGlobalAttributes() {
    return [{
      types: ['listItem'],
      attributes: {
        sectionId: {
          default: null,
          keepOnSplit: false,
          parseHTML: (el) => (el as HTMLElement).getAttribute('data-section-id'),
          renderHTML: (attrs) => (attrs.sectionId ? { 'data-section-id': attrs.sectionId } : {}),
        },
      },
    }];
  },
  addProseMirrorPlugins() {
    if (!this.options.enabled) return [];
    return [new Plugin({
      appendTransaction: (trs, _old, state) => {
        if (!trs.some((t) => t.docChanged)) return null;
        const seen = new Set<string>();
        const tr = state.tr;
        state.doc.descendants((node, pos) => {
          if (node.type.name !== 'listItem') return true;
          const id = node.attrs.sectionId as string | null;
          if (!id || seen.has(id)) {
            const fresh = uid();
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, sectionId: fresh });
            seen.add(fresh);
          } else seen.add(id);
          return true;
        });
        return tr.docChanged ? tr : null;
      },
    })];
  },
});

/**
 * Code Block (semantic <pre><code>, plain text: Enter adds a line, whitespace kept, triple Enter or
 * ↓ at the end leaves it). Created with `/code` at the start of a line (slash menu); TipTap's
 * ``` markdown rule is not used. Separate from the inline `code` mark.
 */
const SlideCodeBlock = CodeBlock.extend({
  addInputRules() {
    return [];
  },
});

/** Quote (semantic <blockquote>): `| ` at the very start of a line wraps it. `P(A | B)` never triggers. */
const SlideBlockquote = Blockquote.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /^\|\s$/,
        handler: ({ state, range }) => {
          const tr = state.tr;
          const $start = tr.doc.resolve(range.from);
          if ($start.parent.type.name !== 'paragraph') return null; // the regex already anchors to the line start
          tr.delete(range.from, range.to);
          const blockRange = tr.doc.resolve(range.from).blockRange();
          const wrapping = blockRange && findWrapping(blockRange, this.type);
          if (!blockRange || !wrapping) return null;
          closeHistory(tr); // the conversion is its own undo step
          tr.wrap(blockRange, wrapping);
        },
      }),
    ];
  },
});

/** Turn the current line into a Code Block, removing the typed trigger (one undo step). */
export function convertToCodeBlock(editor: Editor, range: { from: number; to: number }) {
  return editor.chain().focus()
    .command(({ tr }) => { closeHistory(tr); return true; })
    .deleteRange(range)
    .setNode('codeBlock')
    .run();
}

export function makeExtensions(withPlaceholder = true, opts: { toc?: boolean } = {}): Extensions {
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
    Highlight, // priority 102 → wraps the TextStyle color span (see formattingMarks.ts)
    InlineCode,
    MathInline,
    MathBlock,
    ParagraphFontSize,
    SlideCodeBlock,
    SlideBlockquote,
    LinkMark,
    TocSections.configure({ enabled: !!opts.toc }),
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
