import { InputRule, Node, type Editor } from '@tiptap/core';
import type { Node as PMNodeT } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { renderTex } from '../math/mathjax';
import { useStore } from '../store/store';

const isMathNode = (n: PMNodeT | null | undefined) => !!n && (n.type.name === 'mathInline' || n.type.name === 'mathBlock');

/** Select a math node and open the LaTeX popover for it. */
export function openMath(editor: Editor, pos: number) {
  const node = editor.state.doc.nodeAt(pos);
  if (!isMathNode(node)) return;
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
  useStore.getState().setMathEdit({ pos });
}

export function setMathLatex(editor: Editor, pos: number, latex: string) {
  const node = editor.state.doc.nodeAt(pos);
  if (!isMathNode(node)) return;
  const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...node!.attrs, latex });
  tr.setSelection(NodeSelection.create(tr.doc, pos));
  editor.view.dispatch(tr);
}

/** Close the popover: drop empty equations, move the caret after the equation. */
export function commitMath(editor: Editor, pos: number, focus = true) {
  useStore.getState().setMathEdit(null);
  if (editor.isDestroyed) return;
  const { state } = editor;
  const node = state.doc.nodeAt(pos);
  if (!isMathNode(node)) return;
  const tr = state.tr;
  if (!String(node!.attrs.latex).trim()) {
    tr.delete(pos, pos + node!.nodeSize);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size))));
  } else if (node!.type.name === 'mathInline') {
    tr.setSelection(TextSelection.create(tr.doc, pos + 1));
  } else {
    const after = pos + node!.nodeSize;
    const next = tr.doc.resolve(after).nodeAfter;
    if (!next || !next.isTextblock) tr.insert(after, state.schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
  }
  editor.view.dispatch(tr);
  if (focus) editor.view.focus();
}

/** Insert a new (empty, or from the selected text) equation at the selection and open the popover. */
export function insertMath(editor: Editor, display: boolean, range?: { from: number; to: number }) {
  const { state } = editor;
  const type = state.schema.nodes[display ? 'mathBlock' : 'mathInline'];
  let tr = state.tr;
  let from = range?.from ?? state.selection.from;
  let latex = '';
  if (range) tr.delete(range.from, range.to);
  else if (!state.selection.empty) {
    latex = state.doc.textBetween(state.selection.from, state.selection.to, ' ');
    tr.deleteSelection();
    from = tr.selection.from;
  }
  const node = type.create({ latex });
  let pos = from;
  if (!display) {
    tr.insert(from, node);
  } else {
    const $p = tr.doc.resolve(from);
    const para = $p.parent;
    const inListItemHead = $p.depth >= 2 && $p.node($p.depth - 1).type.name === 'listItem' && $p.index($p.depth - 1) === 0;
    if (para.content.size === 0 && !inListItemHead) {
      // "/math" on its own line: the equation replaces the empty paragraph (Notion behaviour).
      pos = $p.before();
      tr.replaceWith(pos, $p.after(), node);
    } else if ($p.parentOffset === para.content.size) {
      pos = $p.after();
      tr.insert(pos, node);
    } else if ($p.parentOffset === 0 && !inListItemHead) {
      pos = $p.before();
      tr.insert(pos, node);
    } else {
      tr.split(from);
      pos = from + 1;
      tr.insert(pos, node);
    }
  }
  tr.setSelection(NodeSelection.create(tr.doc, pos));
  editor.view.dispatch(tr);
  editor.view.focus();
  useStore.getState().setMathEdit({ pos });
}

function mathNodeView(display: boolean) {
  return ({ node, getPos, editor }: { node: PMNodeT; getPos: () => number | undefined; editor: Editor }) => {
    const dom: HTMLElement = document.createElement(display ? 'div' : 'span');
    let current = node;
    let lastGood = '';
    const draw = () => {
      const latex: string = current.attrs.latex ?? '';
      dom.className = display ? 'math-block' : 'math-inline';
      if (!latex.trim()) {
        dom.classList.add('math-empty');
        dom.textContent = display ? '새 수식 (New equation)' : '수식';
        return;
      }
      const r = renderTex(latex, display);
      if (r.error === undefined) {
        dom.innerHTML = r.svg;
        lastGood = r.svg;
      } else if (lastGood) {
        dom.innerHTML = lastGood; // keep showing the last valid render while typing
        dom.classList.add('math-stale');
      } else {
        dom.textContent = latex;
        dom.classList.add('math-error');
      }
    };
    draw();
    dom.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const pos = getPos();
      if (typeof pos === 'number') openMath(editor, pos);
    });
    return {
      dom,
      update(n: PMNodeT) {
        if (n.type !== current.type) return false;
        current = n;
        draw();
        return true;
      },
      selectNode() { dom.classList.add('ProseMirror-selectednode'); },
      deselectNode() { dom.classList.remove('ProseMirror-selectednode'); },
      ignoreMutation: () => true,
      stopEvent: (e: Event) => e.type === 'mousedown',
    };
  };
}

const mathKeys = (editor: Editor) => ({
  // Enter / Space on a selected equation re-opens it.
  Enter: () => {
    const sel = editor.state.selection;
    if (sel instanceof NodeSelection && isMathNode(sel.node)) {
      openMath(editor, sel.from);
      return true;
    }
    return false;
  },
  // Notion: ⌘⇧E creates an inline equation (from the selection, if any).
  'Mod-Shift-e': () => {
    insertMath(editor, false);
    return true;
  },
});

export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { latex: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'span[data-latex]', getAttrs: (el) => ({ latex: (el as HTMLElement).dataset.latex }) }];
  },
  renderHTML({ node }) {
    return ['span', { 'data-latex': node.attrs.latex, class: 'math-inline' }];
  },
  renderText({ node }) {
    return `$${node.attrs.latex}$`;
  },
  addNodeView() {
    return mathNodeView(false) as any;
  },
  addKeyboardShortcuts() {
    return mathKeys(this.editor);
  },
  addInputRules() {
    // Notion-style: $$x^2$$ typed inline becomes an inline equation.
    return [
      new InputRule({
        find: /\$\$([^$]+)\$\$$/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex: match[1] }));
        },
      }),
    ];
  },
});

export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { latex: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'div[data-latex]', getAttrs: (el) => ({ latex: (el as HTMLElement).dataset.latex }) }];
  },
  renderHTML({ node }) {
    return ['div', { 'data-latex': node.attrs.latex, class: 'math-block' }];
  },
  renderText({ node }) {
    return `$$${node.attrs.latex}$$`;
  },
  addNodeView() {
    return mathNodeView(true) as any;
  },
});
