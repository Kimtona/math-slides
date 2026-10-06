import { useEffect, useRef, useState } from 'react';
import { renderTex } from '../math/mathjax';
import { MATH_CATEGORIES, type MathItem } from './mathPalette';

/**
 * Compact optional helper under the equation textarea (opened by Ω). Cells show the rendered symbol (the normal
 * MathJax path), the LaTeX stays a hover hint. mousedown is default-prevented so the textarea keeps focus and
 * selection until `onPick` reads them.
 */
export function MathPalette({ onPick, onClose, flip }: { onPick: (item: MathItem) => void; onClose: () => void; flip: boolean }) {
  const [cat, setCat] = useState(MATH_CATEGORIES[0].key);
  const ref = useRef<HTMLDivElement>(null);
  const items = MATH_CATEGORIES.find((c) => c.key === cat)!.items;

  // Clicking elsewhere inside the popover (outside the palette and its Ω button) closes the palette only.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest?.('.math-pal-btn')) return;
      onClose();
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [onClose]);

  return (
    <div ref={ref} className={'math-palette' + (flip ? ' flip' : '')} role="dialog" aria-label="수식 팔레트" onMouseDown={(e) => e.preventDefault()}>
      <div className="math-pal-tabs">
        {MATH_CATEGORIES.map((c) => (
          <button key={c.key} type="button" className={c.key === cat ? 'on' : ''} data-cat={c.key} onClick={() => setCat(c.key)}>{c.label}</button>
        ))}
      </div>
      <div className="math-pal-grid">
        {items.map((it, i) => {
          const r = renderTex(it.show ?? it.pre + (it.post ?? ''), false);
          return (
            <button key={cat + i} type="button" title={it.tip} aria-label={it.tip} className="math-pal-cell" onClick={() => onPick(it)}>
              {r.error === undefined ? <span dangerouslySetInnerHTML={{ __html: r.svg }} /> : it.pre}
            </button>
          );
        })}
      </div>
    </div>
  );
}
