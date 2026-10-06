import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store/store';
import { getActiveEditor } from './active';
import { commitMath, setMathLatex } from './mathNodes';
import { renderTex } from '../math/mathjax';
import { MathPalette } from './MathPalette';
import { applyMathItem, type MathItem } from './mathPalette';

/**
 * Notion-style equation editor: a small floating textarea under the equation.
 * Every keystroke updates the node, so the equation re-renders live on the slide.
 */
export function MathPopover() {
  const mathEdit = useStore((s) => s.mathEdit);
  const editor = getActiveEditor();
  const [latex, setLatex] = useState('');
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [palette, setPalette] = useState(false);
  const caretAfter = useRef<number | null>(null);

  const node = mathEdit && editor && !editor.isDestroyed ? editor.state.doc.nodeAt(mathEdit.pos) : null;
  const display = node?.type.name === 'mathBlock';

  // Load the node's LaTeX when the popover opens on a (new) node.
  useLayoutEffect(() => {
    if (!mathEdit || !node) return;
    setLatex(node.attrs.latex ?? '');
    ta.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mathEdit?.pos, !!node]);

  // Position under the equation; follow it as it grows.
  useLayoutEffect(() => {
    if (!mathEdit || !editor) return setPos(null);
    const dom = editor.view.nodeDOM(mathEdit.pos) as HTMLElement | null;
    if (!dom) return;
    const r = dom.getBoundingClientRect();
    const w = 460;
    let x = display ? r.left + r.width / 2 - w / 2 : r.left;
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    let y = r.bottom + 8;
    if (y + 140 > window.innerHeight) y = Math.max(8, r.top - 150);
    setPos({ x, y });
  }, [mathEdit, editor, latex, display]);

  // Close the palette when the equation changes or closes.
  useEffect(() => { setPalette(false); }, [mathEdit?.pos]);
  // Restore the caret after a palette insertion (controlled textarea: set it once the new value is rendered).
  useLayoutEffect(() => {
    const c = caretAfter.current, t = ta.current;
    if (c === null || !t) return;
    caretAfter.current = null;
    t.focus(); t.setSelectionRange(c, c);
  }, [latex]);

  // Auto-grow the textarea with its content.
  useLayoutEffect(() => {
    const t = ta.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(220, t.scrollHeight + 2) + 'px';
  }, [latex, pos]);

  // Clicking anywhere else closes (commits) the equation.
  useEffect(() => {
    if (!mathEdit || !editor) return;
    const onDown = (e: PointerEvent) => {
      if (box.current?.contains(e.target as Node)) return;
      const dom = editor.view.nodeDOM(mathEdit.pos) as HTMLElement | null;
      if (dom?.contains(e.target as Node)) return;
      const inEditor = editor.view.dom.contains(e.target as Node);
      commitMath(editor, mathEdit.pos, inEditor);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [mathEdit, editor]);

  if (!mathEdit || !editor || !node || !pos) return null;

  const res = latex.trim() ? renderTex(latex, display) : null;
  const error = res && res.error !== undefined ? res.error : null;

  const onChange = (v: string) => {
    setLatex(v);
    setMathLatex(editor, mathEdit.pos, v);
  };

  const insert = (item: MathItem) => {
    const t = ta.current;
    const r = applyMathItem(latex, t?.selectionStart ?? latex.length, t?.selectionEnd ?? latex.length, item);
    caretAfter.current = r.caret;
    onChange(r.value);
    if (r.value === latex) { t?.focus(); t?.setSelectionRange(r.caret, r.caret); caretAfter.current = null; }
  };

  return createPortal(
    <div ref={box} className="math-popover" style={{ left: pos.x, top: pos.y }}>
      <textarea
        ref={ta}
        autoFocus
        onFocus={(e) => { const t = e.currentTarget; t.setSelectionRange(t.value.length, t.value.length); }}
        className="math-input"
        value={latex}
        spellCheck={false}
        placeholder={display ? '\\min(r_t(\\theta)\\hat{A}_t, \\dots)' : 'E = mc^2'}
        rows={1}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' && palette) { e.preventDefault(); setPalette(false); return; }
          if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') {
            e.preventDefault();
            commitMath(editor, mathEdit.pos, true);
          }
        }}
      />
      <div className="math-popover-foot">
        <span className={error ? 'math-err-msg' : 'math-help'}>
          {error ?? (display ? 'Shift+Enter 줄바꿈 · 블록 수식' : 'Shift+Enter 줄바꿈 · 인라인 수식')}
        </span>
        <button type="button" className={'math-pal-btn' + (palette ? ' on' : '')} title="수식 팔레트" aria-label="수식 팔레트" aria-expanded={palette}
          onMouseDown={(e) => e.preventDefault()} onClick={() => setPalette((v) => !v)}>Ω</button>
        <button className="btn primary small" onMouseDown={(e) => e.preventDefault()}
          onClick={() => commitMath(editor, mathEdit.pos, true)}>Done ↵</button>
      </div>
      {palette && <MathPalette onPick={insert} onClose={() => { setPalette(false); ta.current?.focus(); }} flip={pos.y + 330 > window.innerHeight} />}
    </div>,
    document.body,
  );
}
