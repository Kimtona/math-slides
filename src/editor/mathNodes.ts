import { InputRule, Node, type Editor } from '@tiptap/core';
import type { Node as PMNodeT } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { renderTex, activeMathColors, LEAF_SELECTOR, type MathColors } from '../math/mathjax';
import { parseHex } from '../model/colors';
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
  // Partial symbol colors are index-based (see MathColors): once the LaTeX changes they could hit the wrong symbols, so they reset (PoC).
  const colors = latex === node!.attrs.latex ? node!.attrs.colors : null;
  const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...node!.attrs, latex, colors });
  tr.setSelection(NodeSelection.create(tr.doc, pos));
  editor.view.dispatch(tr);
}

/**
 * Color (or, with null, reset to the equation's own color) the symbols picked by dragging over the rendered equation.
 * Only the `colors` attribute changes — never the LaTeX — in one history step. Returns false when nothing was selected.
 */
export function applyMathLeafColor(editor: Editor, color: string | null): boolean {
  const sel = useStore.getState().mathLeafSel;
  if (!sel || editor.isDestroyed) return false;
  const node = editor.state.doc.nodeAt(sel.pos);
  if (!isMathNode(node)) return false;
  const hex = color === null ? null : parseHex(color);
  if (color !== null && !hex) return false;
  const latex: string = node!.attrs.latex;
  const picked = new Set(sel.leaves);
  const items = activeMathColors(latex, node!.attrs.colors).filter((x) => !picked.has(x.i));
  if (hex) sel.leaves.forEach((i) => items.push({ i, c: hex }));
  items.sort((a, b) => a.i - b.i);
  const colors: MathColors | null = items.length ? { src: latex, items } : null;
  const tr = editor.state.tr.setNodeMarkup(sel.pos, undefined, { ...node!.attrs, colors });
  tr.setSelection(NodeSelection.create(tr.doc, sel.pos));
  editor.view.dispatch(tr);
  return true;
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

/** Clipboard/HTML round trip of the partial symbol colors (data-colors = JSON). */
const colorsHtml = (c: MathColors | null) => (c ? { 'data-colors': JSON.stringify(c) } : {});
function parseColors(el: HTMLElement): MathColors | null {
  try { const c = JSON.parse(el.dataset.colors ?? 'null'); return c && typeof c.src === 'string' && Array.isArray(c.items) ? c : null; } catch { return null; }
}

/** Pointer travel (px) that turns a click on a rendered equation into a symbol-picking drag. */
const DRAG_PX = 3;

const leafRange = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

/**
 * Keyboard side of the symbol selection (window keydown while symbols are picked and no text field has the focus):
 * Shift+←/→ moves the focus end one symbol (extends or shrinks, the anchor stays), Esc drops the selection.
 * With no symbols picked, a caret next to an equation enters it (see enterMathFromCaret). Returns true when the key was handled.
 */
export function handleMathLeafKey(e: KeyboardEvent, editor: Editor): boolean {
  const st = useStore.getState();
  const sel = st.mathLeafSel;
  if (st.mathEdit || editor.isDestroyed || e.isComposing) return false;
  const t = e.target as HTMLElement | null;
  if (t?.closest?.('input, textarea, select, [contenteditable="true"]:not(.ProseMirror)')) return false; // popover / other fields keep their own keys
  if (!sel) return enterMathFromCaret(e, editor, t);
  if (e.key === 'Escape') {
    if (document.querySelector('.text-palette')) return false; // an open palette closes first
    st.setMathLeafSel(null);
    return true;
  }
  if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return false;
  const dom = editor.view.nodeDOM(sel.pos) as HTMLElement | null;
  const count = dom?.querySelectorAll(LEAF_SELECTOR).length ?? 0;
  if (!count) return false;
  const anchor = sel.anchor ?? sel.leaves[0], focus = sel.focus ?? sel.leaves[sel.leaves.length - 1];
  const next = Math.max(0, Math.min(count - 1, focus + (e.key === 'ArrowRight' ? 1 : -1)));
  if (next !== focus) st.setMathLeafSel({ pos: sel.pos, leaves: leafRange(Math.min(anchor, next), Math.max(anchor, next)), anchor, focus: next });
  return true; // at the first / last symbol the key is still ours (no stray text selection)
}

/**
 * A text caret right next to an equation + Shift+←/→ (←: caret after it, →: caret before it) steps INTO the equation:
 * the equation becomes the selected node and the symbol on that side (last / first) the picked one; further Shift+←/→
 * then extend as usual. Anything else (caret elsewhere, a text range, other keys) is left to ProseMirror.
 */
function enterMathFromCaret(e: KeyboardEvent, editor: Editor, target: HTMLElement | null): boolean {
  if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return false;
  const { selection, doc } = editor.state;
  if (!(selection instanceof TextSelection) || !selection.empty || !target || !editor.view.dom.contains(target)) return false;
  const left = e.key === 'ArrowLeft';
  const node = left ? selection.$head.nodeBefore : selection.$head.nodeAfter;
  if (!isMathNode(node) || !String(node!.attrs.latex ?? '').trim()) return false;
  const pos = left ? selection.head - node!.nodeSize : selection.head;
  const count = (editor.view.nodeDOM(pos) as HTMLElement | null)?.querySelectorAll(LEAF_SELECTOR).length ?? 0;
  if (!count) return false; // a LaTeX error renders no symbols
  const leaf = left ? count - 1 : 0;
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(doc, pos)));
  useStore.getState().setMathLeafSel({ pos, leaves: [leaf], anchor: leaf, focus: leaf });
  return true;
}

const PICK_EVENT = 'math-pick-begin';
interface ArmedPick { id: string; ordinal: number; x: number; y: number; released: boolean; endX: number; endY: number; at: number }
let armed: ArmedPick | null = null;

/**
 * A press on a rendered equation symbol of an already selected text box that is not being edited: instead of moving the box,
 * the box enters edit mode and the press continues as a symbol pick (drag) or a click (LaTeX popover). Returns false when
 * the press is not on a rendered equation, so the caller keeps its normal move behavior.
 */
export function armMathPick(e: { target: EventTarget | null; clientX: number; clientY: number }, id: string): boolean {
  const t = e.target as Element | null;
  const eq = t?.closest?.('.math-inline, .math-block');
  const box = t?.closest?.('.el');
  if (!eq || !box || !eq.querySelector('svg')) return false;
  const ordinal = [...box.querySelectorAll('.math-inline, .math-block')].indexOf(eq);
  if (ordinal < 0) return false;
  const pick: ArmedPick = { id, ordinal, x: e.clientX, y: e.clientY, released: false, endX: e.clientX, endY: e.clientY, at: Date.now() };
  armed = pick;
  window.addEventListener('mouseup', (ev) => { pick.released = true; pick.endX = ev.clientX; pick.endY = ev.clientY; }, { capture: true, once: true });
  return true;
}

/** A press on a symbol is waiting for this box's editor (it is mounting). */
export const hasArmedMathPick = (id: string) => !!armed && armed.id === id && Date.now() - armed.at < 3000;

/** Called by the text editor once it has settled (entering edit mode can remount it): continues the armed press on the equation it points at. */
export function runArmedMathPick(editor: Editor, id: string): boolean {
  const pick = armed;
  armed = null;
  if (!pick || pick.id !== id) return false;
  let n = 0, pos = -1;
  editor.state.doc.descendants((node, p) => { if (isMathNode(node)) { if (n++ === pick.ordinal) pos = p; return false; } return pos < 0; });
  if (pos < 0) return false;
  const moved = Math.hypot(pick.endX - pick.x, pick.endY - pick.y) >= DRAG_PX;
  if (pick.released && !moved) { openMath(editor, pos); return true; }
  (editor.view.nodeDOM(pos) as HTMLElement | null)?.dispatchEvent(new CustomEvent(PICK_EVENT, { detail: { x: pick.x, y: pick.y } }));
  if (pick.released) {
    // A quick flick: the button was already up before the editor mounted — replay where it ended.
    for (const type of ['mousemove', 'mouseup']) window.dispatchEvent(new MouseEvent(type, { clientX: pick.endX, clientY: pick.endY }));
  }
  return true;
}

function mathNodeView(display: boolean) {
  return ({ node, getPos, editor }: { node: PMNodeT; getPos: () => number | undefined; editor: Editor }) => {
    const dom: HTMLElement = document.createElement(display ? 'div' : 'span');
    let current = node;
    let lastGood = '';
    const render = () => {
      const latex: string = current.attrs.latex ?? '';
      dom.className = display ? 'math-block' : 'math-inline';
      if (!latex.trim()) {
        dom.classList.add('math-empty');
        dom.textContent = display ? '새 수식 (New equation)' : '수식';
        return;
      }
      const r = renderTex(latex, display, current.attrs.colors);
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
    const leaves = () => [...dom.querySelectorAll<SVGGElement>(LEAF_SELECTOR)];
    /** Highlight of the dragged-over symbols: plain overlay boxes (outside the <svg>, so they never reach PDF/PPTX). */
    const paintSel = () => {
      dom.querySelectorAll('.math-leaf-hl').forEach((el) => el.remove());
      const sel = useStore.getState().mathLeafSel;
      const on = !!sel && sel.pos === getPos() && !!sel.leaves.length;
      dom.classList.toggle('leaf-selecting', on);
      if (!on) return;
      const base = dom.getBoundingClientRect();
      const k = dom.offsetWidth ? base.width / dom.offsetWidth : 1; // slide zoom
      const all = leaves();
      for (const i of sel!.leaves) {
        const r = all[i]?.getBoundingClientRect();
        if (!r) continue;
        const box = document.createElement('span');
        box.className = 'math-leaf-hl';
        box.style.cssText = `left:${(r.left - base.left) / k - 1}px;top:${(r.top - base.top) / k - 1}px;width:${r.width / k + 2}px;height:${r.height / k + 2}px`;
        dom.appendChild(box);
      }
    };
    const draw = () => { render(); paintSel(); };
    draw();
    /** Index of the symbol under (or, failing that, nearest to) a point. */
    const leafAt = (x: number, y: number) => {
      let best = -1, bestD = Infinity;
      leaves().forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    };
    // A plain click opens the LaTeX editor (as before); a drag over the rendered equation picks symbols to color instead.
    const begin = (x0: number, y0: number) => {
      const pos = getPos();
      if (typeof pos !== 'number') return;
      // Also while the LaTeX popover is open (right after typing an equation): the drag then closes it and picks symbols.
      const canPick = !!current.attrs.latex?.trim();
      const from = canPick ? leafAt(x0, y0) : -1;
      let dragging = false;
      const move = (ev: MouseEvent) => {
        if (from < 0) return;
        const to = leafAt(ev.clientX, ev.clientY);
        if (to < 0) return;
        // A drag = moved a few px, or reached another symbol; anything smaller is still a click (jitter).
        if (!dragging && to === from && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_PX) return;
        if (!dragging) {
          dragging = true;
          if (useStore.getState().mathEdit) { useStore.getState().setMathEdit(null); editor.view.focus(); }
          const cur = editor.state.selection;
          if (!(cur instanceof NodeSelection && cur.from === pos)) editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
        }
        const lo = Math.min(from, to), hi = Math.max(from, to);
        const prev = useStore.getState().mathLeafSel;
        if (prev && prev.pos === pos && prev.anchor === from && prev.focus === to) return;
        useStore.getState().setMathLeafSel({ pos, leaves: leafRange(lo, hi), anchor: from, focus: to });
      };
      const up = () => {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        if (!dragging) { const p = getPos(); if (typeof p === 'number') openMath(editor, p); }
      };
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
    };
    dom.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      begin(e.clientX, e.clientY);
    });
    // Gesture handed over from the static (not editing) box, see armMathPick.
    dom.addEventListener(PICK_EVENT, (e) => { const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail; begin(x, y); });
    const unsub = useStore.subscribe((s, prev) => { if (s.mathLeafSel !== prev.mathLeafSel) paintSel(); });
    // Moving the editor selection elsewhere drops the symbol selection.
    const onSelection = () => {
      const sel = useStore.getState().mathLeafSel;
      if (!sel || sel.pos !== getPos()) return;
      const cur = editor.state.selection;
      if (!(cur instanceof NodeSelection && cur.from === sel.pos)) useStore.getState().setMathLeafSel(null);
    };
    editor.on('selectionUpdate', onSelection);
    return {
      dom,
      update(n: PMNodeT) {
        if (n.type !== current.type) return false;
        current = n;
        draw();
        return true;
      },
      destroy() {
        unsub();
        editor.off('selectionUpdate', onSelection);
        const sel = useStore.getState().mathLeafSel;
        if (sel && sel.pos === getPos()) useStore.getState().setMathLeafSel(null);
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
    return { latex: { default: '' }, colors: { default: null } };
  },
  parseHTML() {
    return [{ tag: 'span[data-latex]', getAttrs: (el) => ({ latex: (el as HTMLElement).dataset.latex, colors: parseColors(el as HTMLElement) }) }];
  },
  renderHTML({ node }) {
    return ['span', { 'data-latex': node.attrs.latex, class: 'math-inline', ...colorsHtml(node.attrs.colors) }];
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
    return { latex: { default: '' }, colors: { default: null } };
  },
  parseHTML() {
    return [{ tag: 'div[data-latex]', getAttrs: (el) => ({ latex: (el as HTMLElement).dataset.latex, colors: parseColors(el as HTMLElement) }) }];
  },
  renderHTML({ node }) {
    return ['div', { 'data-latex': node.attrs.latex, class: 'math-block', ...colorsHtml(node.attrs.colors) }];
  },
  renderText({ node }) {
    return `$$${node.attrs.latex}$$`;
  },
  addNodeView() {
    return mathNodeView(true) as any;
  },
});
