import { Editor, Extension, InputRule, Mark, Node as TipNode, mergeAttributes, type Extensions } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';
import Blockquote from '@tiptap/extension-blockquote';
import { closeHistory } from '@tiptap/pm/history';
import { findWrapping } from '@tiptap/pm/transform';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNodeType } from '@tiptap/pm/model';
import { CODE_LANGUAGES, highlightCode, isSupportedLanguage } from './codeHighlight';
import { uid } from '../model/defaults';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextStyle from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import Placeholder from '@tiptap/extension-placeholder';
import { MathBlock, MathInline } from './mathNodes';
import type { PMNode } from '../model/types';
import { MARKDOWN_SIZES, TYPOGRAPHY } from '../model/typography';
import { ACADEMIC_BLOCK_TYPES, DEFAULT_BLOCK_TYPE, blockTypeInfo } from '../model/academicBlocks';
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
    if ((n.type === 'paragraph' || n.type === 'codeBlock') && n.attrs?.fontSize) out.attrs = { ...n.attrs, fontSize: Math.max(6, Math.round(n.attrs.fontSize * k * 2) / 2) };
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

/** One indentation level inside a Code Block. */
const CODE_INDENT = '    ';

/** Line-start offsets (within the code block) of the lines touched by the selection, or null outside code. */
function selectedCodeLines(state: EditorState) {
  const { $from, $to, empty } = state.selection;
  if ($from.parent.type.name !== 'codeBlock' || !$from.sameParent($to)) return null;
  const text = $from.parent.textContent;
  const starts: number[] = [];
  let line = text.lastIndexOf('\n', $from.parentOffset - 1) + 1;
  for (;;) {
    starts.push(line);
    const nl = text.indexOf('\n', line);
    if (nl < 0) break;
    const next = nl + 1;
    // A selection ending exactly at the start of a line does not include that line.
    if (next > $to.parentOffset || (next === $to.parentOffset && !empty)) break;
    line = next;
  }
  return { base: $from.start(), text, starts };
}

/**
 * Code Block: TipTap's semantic codeBlock (<pre><code>, plain text: Enter adds a line, whitespace
 * kept, triple Enter or ↓ at the end leaves it). Created with `/code` (slash menu); ``` is not used.
 * Separate from the inline `code` mark.
 * - fontSize attribute: px size of the code, set to TYPOGRAPHY.code by `/code` (older blocks: none)
 * - language attribute (TipTap's): null = Plain Text; drives syntax highlighting (decorations only)
 * - Tab / Shift+Tab: indent / outdent the selected lines by 4 spaces (only inside code)
 */
const SlideCodeBlock = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      fontSize: {
        default: null,
        parseHTML: (el) => parseFloat((el as HTMLElement).style.fontSize) || null,
        renderHTML: (attrs) => (attrs.fontSize ? { style: `font-size: ${attrs.fontSize}px`, 'data-code-size': '' } : {}),
      },
    };
  },
  addInputRules() {
    return [];
  },
  addKeyboardShortcuts() {
    const indent = (dir: 1 | -1) => () => {
      const { state, view } = this.editor;
      const lines = selectedCodeLines(state);
      if (!lines) return false; // outside a code block: Tab keeps its usual behavior
      const tr = state.tr;
      for (const at of [...lines.starts].reverse()) {
        if (dir > 0) tr.insertText(CODE_INDENT, lines.base + at);
        else {
          let n = 0;
          while (n < CODE_INDENT.length && lines.text[at + n] === ' ') n++;
          if (!n && lines.text[at] === '\t') n = 1;
          if (n) tr.delete(lines.base + at, lines.base + at + n);
        }
      }
      if (tr.docChanged) view.dispatch(tr);
      return true; // consumed: never moves focus while in code
    };
    return { ...this.parent?.(), Tab: indent(1), 'Shift-Tab': indent(-1) };
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;
      const dom = document.createElement('pre');
      // Language selector: editor-only UI, outside the editable content.
      const bar = document.createElement('div');
      bar.className = 'code-lang';
      bar.contentEditable = 'false';
      const select = document.createElement('select');
      select.title = '코드 언어 (Language)';
      for (const l of CODE_LANGUAGES) {
        const o = document.createElement('option');
        o.value = l.id ?? '';
        o.textContent = l.label;
        select.append(o);
      }
      bar.append(select);
      const code = document.createElement('code');
      dom.append(bar, code);
      const sync = () => {
        const lang = isSupportedLanguage(current.attrs.language) ? current.attrs.language : '';
        select.value = lang;
        code.className = lang ? `language-${lang}` : '';
        const fs = current.attrs.fontSize as number | null;
        dom.style.fontSize = fs ? `${fs}px` : '';
        if (fs) dom.setAttribute('data-code-size', ''); else dom.removeAttribute('data-code-size');
      };
      sync();
      select.addEventListener('change', () => {
        const pos = getPos();
        if (typeof pos !== 'number') return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, language: select.value || null }));
        editor.view.focus();
      });
      return {
        dom,
        contentDOM: code,
        update(n: PMNodeType) {
          if (n.type !== current.type) return false;
          current = n;
          sync();
          return true;
        },
        stopEvent: (e: Event) => bar.contains(e.target as Node),
        ignoreMutation: (m: MutationRecord | { type: 'selection'; target: Node }) =>
          bar.contains(m.target) || (m.type === 'attributes' && (m.target === dom || m.target === code)),
      };
    };
  },
  addProseMirrorPlugins() {
    // Syntax highlighting as decorations derived from (text, language) — nothing is stored.
    const decorate = (doc: PMNodeType) => {
      const decos: Decoration[] = [];
      doc.descendants((n, pos) => {
        if (n.type.name !== 'codeBlock') return true;
        let at = pos + 1;
        for (const t of highlightCode(n.textContent, n.attrs.language)) {
          if (t.classes.length) decos.push(Decoration.inline(at, at + t.text.length, { class: t.classes.join(' ') }));
          at += t.text.length;
        }
        return false;
      });
      return DecorationSet.create(doc, decos);
    };
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        key: new PluginKey('codeHighlight'),
        state: {
          init: (_, state) => decorate(state.doc),
          apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
        },
        props: { decorations(state) { return this.getState(state); } },
      }),
    ];
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

/** Icon presets offered by the Callout icon popover (any emoji can be stored; these are just the quick picks). */
export const CALLOUT_ICONS = ['💡', 'ℹ️', '⚠️', '✅', '❌', '📌', '🔥', '💬', '⭐', '🚀'];
export const DEFAULT_CALLOUT_ICON = CALLOUT_ICONS[0];

/**
 * Callout (semantic block): icon + rich-text content. The icon is a node attribute (`icon`), so it is
 * stored in the normal document JSON and is never part of the typed text. Content is ordinary blocks
 * (paragraphs with all marks, math, code…); Enter on an empty last line leaves it (stock behavior).
 * Created with `/callout` (slash menu). The icon button/popover exist only in the editor node view.
 */
const Callout = TipNode.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      icon: {
        default: DEFAULT_CALLOUT_ICON,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-icon') || DEFAULT_CALLOUT_ICON,
        renderHTML: (attrs) => ({ 'data-icon': attrs.icon }),
      },
    };
  },
  parseHTML() { return [{ tag: 'div[data-callout]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'callout' }), 0]; },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'callout';
      dom.setAttribute('data-callout', '');
      const icon = document.createElement('span');
      icon.className = 'callout-icon';
      icon.contentEditable = 'false';
      icon.title = '아이콘 변경';
      const body = document.createElement('div');
      body.className = 'callout-body';
      dom.append(icon, body);
      let pop: HTMLElement | null = null;
      const closePop = () => { pop?.remove(); pop = null; document.removeEventListener('mousedown', outside, true); };
      function outside(e: MouseEvent) { if (pop && !pop.contains(e.target as Node) && e.target !== icon) closePop(); }
      const setIcon = (value: string) => {
        const pos = getPos();
        closePop();
        if (typeof pos !== 'number' || value === current.attrs.icon) return;
        const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, icon: value });
        closeHistory(tr); // an icon change is its own undo step
        editor.view.dispatch(tr);
        editor.view.focus();
      };
      icon.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (pop) return closePop();
        pop = document.createElement('div');
        pop.className = 'callout-icons';
        pop.contentEditable = 'false';
        for (const em of CALLOUT_ICONS) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = em;
          b.className = em === current.attrs.icon ? 'on' : '';
          b.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); setIcon(em); });
          pop.append(b);
        }
        dom.append(pop);
        document.addEventListener('mousedown', outside, true);
      });
      const sync = () => { icon.textContent = current.attrs.icon; dom.setAttribute('data-icon', current.attrs.icon); };
      sync();
      return {
        dom,
        contentDOM: body,
        update(n: PMNodeType) {
          if (n.type !== current.type) return false;
          current = n;
          sync();
          return true;
        },
        stopEvent: (e: Event) => icon.contains(e.target as Node) || !!pop?.contains(e.target as Node),
        ignoreMutation: (m: MutationRecord | { type: 'selection'; target: Node }) =>
          m.type !== 'selection' && (icon.contains(m.target) || m.target === icon || !!pop?.contains(m.target) || m.target === pop || m.target === dom),
        destroy: closePop,
      };
    };
  },
});

/**
 * Academic Block (semantic block): `type` (Block / Theorem / Definition …) + optional `title` + rich
 * body. One node type; both values are node attributes in the normal document JSON. The header's type
 * selector and title input exist only in this editor node view (StaticText renders label + title only).
 * Related to Callout only by pattern; Enter on an empty last line leaves it (stock behavior).
 */
const AcademicBlock = TipNode.create({
  name: 'academicBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      type: {
        default: DEFAULT_BLOCK_TYPE,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-type') || DEFAULT_BLOCK_TYPE,
        renderHTML: (attrs) => ({ 'data-type': attrs.type }),
      },
      title: {
        default: '',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-title') || '',
        renderHTML: (attrs) => (attrs.title ? { 'data-title': attrs.title } : {}),
      },
    };
  },
  parseHTML() { return [{ tag: 'div[data-academic-block]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-academic-block': '', class: 'ablock' }), 0]; },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;
      const el = (tag: string, cls: string) => { const e = document.createElement(tag); e.className = cls; return e; };
      const dom = el('div', 'ablock');
      dom.setAttribute('data-academic-block', '');
      const head = el('div', 'ablock-head');
      head.contentEditable = 'false';
      const label = el('span', 'ablock-type');
      label.title = '블록 유형 변경';
      const caret = el('span', 'ablock-caret');
      caret.textContent = '▾';
      const sep = el('span', 'ablock-sep');
      sep.textContent = ' — ';
      const input = document.createElement('input');
      input.className = 'ablock-title-input';
      input.placeholder = '제목 (선택)';
      input.spellcheck = false;
      head.append(label, caret, sep, input);
      const body = el('div', 'ablock-body');
      dom.append(head, body);
      let pop: HTMLElement | null = null;
      function outside(e: MouseEvent) { if (pop && !pop.contains(e.target as Node) && !label.contains(e.target as Node) && e.target !== caret) closePop(); }
      function closePop() { pop?.remove(); pop = null; document.removeEventListener('mousedown', outside, true); }
      const setAttrs = (patch: Record<string, unknown>, ownStep: boolean) => {
        const pos = getPos();
        if (typeof pos !== 'number') return;
        const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...patch });
        if (ownStep) closeHistory(tr);
        editor.view.dispatch(tr);
      };
      const openPop = (e: Event) => {
        e.preventDefault();
        if (pop) return closePop();
        pop = el('div', 'ablock-types');
        pop.contentEditable = 'false';
        for (const t of ACADEMIC_BLOCK_TYPES) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = t.label;
          b.setAttribute('data-family', t.family);
          if (t.id === current.attrs.type) b.className = 'on';
          b.addEventListener('mousedown', (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            closePop();
            if (t.id !== current.attrs.type) setAttrs({ type: t.id }, true);
            editor.view.focus();
          });
          pop.append(b);
        }
        dom.append(pop);
        document.addEventListener('mousedown', outside, true);
      };
      label.addEventListener('mousedown', openPop);
      caret.addEventListener('mousedown', openPop);
      input.addEventListener('input', () => setAttrs({ title: input.value }, false));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); editor.view.focus(); } });
      const sync = () => {
        const info = blockTypeInfo(current.attrs.type);
        label.textContent = info.label;
        dom.setAttribute('data-type', info.id);
        dom.setAttribute('data-family', info.family);
        const title = (current.attrs.title as string) || '';
        if (input.value !== title) input.value = title;
        sep.hidden = !title;
      };
      sync();
      return {
        dom,
        contentDOM: body,
        update(n: PMNodeType) {
          if (n.type !== current.type) return false;
          current = n;
          sync();
          return true;
        },
        stopEvent: (e: Event) => head.contains(e.target as Node) || !!pop?.contains(e.target as Node),
        ignoreMutation: (m: MutationRecord | { type: 'selection'; target: Node }) =>
          m.type !== 'selection' && (head.contains(m.target) || m.target === dom || !!pop?.contains(m.target) || m.target === pop),
        destroy: closePop,
      };
    };
  },
});

/** Turn the current line into an Academic Block (wraps its block), removing the typed trigger (one undo step). */
export function convertToAcademicBlock(editor: Editor, range: { from: number; to: number }) {
  return editor.chain().focus()
    .command(({ tr }) => { closeHistory(tr); return true; })
    .deleteRange(range)
    .wrapIn('academicBlock', { type: DEFAULT_BLOCK_TYPE, title: '' })
    .run();
}

/** Turn the current line into a Callout (wraps its block), removing the typed trigger (one undo step). */
export function convertToCallout(editor: Editor, range: { from: number; to: number }) {
  return editor.chain().focus()
    .command(({ tr }) => { closeHistory(tr); return true; })
    .deleteRange(range)
    .wrapIn('callout', { icon: DEFAULT_CALLOUT_ICON })
    .run();
}

/** Turn the current line into a Code Block, removing the typed trigger (one undo step). */
export function convertToCodeBlock(editor: Editor, range: { from: number; to: number }) {
  return editor.chain().focus()
    .command(({ tr }) => { closeHistory(tr); return true; })
    .deleteRange(range)
    .setNode('codeBlock', { fontSize: TYPOGRAPHY.code, language: null })
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
    Callout,
    AcademicBlock,
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
