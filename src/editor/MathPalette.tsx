import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { renderTex } from '../math/mathjax';
import { MATH_CATEGORIES, type MathItem } from './mathPaletteItems';
import { getMathFavorites, removeMathFavoriteAt, resetMathFavorites, subscribeUserPrefs } from '../store/userPrefs';

/**
 * Compact optional helper under the equation textarea (opened by Ω). Cells show the rendered symbol (the normal
 * MathJax path), the LaTeX stays a hover hint. mousedown is default-prevented so the textarea keeps focus and
 * selection until `onPick` reads them. The first tab (자주 사용) shows the user's Math Favorites (a user-level preference,
 * see store/userPrefs); ✎ there switches to a small manage mode (remove, reset to the built-in set).
 */
export function MathPalette({ onPick, onClose, flip }: { onPick: (item: MathItem) => void; onClose: () => void; flip: boolean }) {
  const [cat, setCat] = useState(MATH_CATEGORIES[0].key);
  const ref = useRef<HTMLDivElement>(null);
  const favs = useSyncExternalStore(subscribeUserPrefs, getMathFavorites);
  const [manage, setManage] = useState(false);
  const favTab = cat === 'freq';
  const items: readonly MathItem[] = favTab ? favs.map((f) => ({ ...f, tip: f.tip ?? f.pre })) : MATH_CATEGORIES.find((c) => c.key === cat)!.items;

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
      <div className="math-pal-head">
        <div className="math-pal-tabs">
          {MATH_CATEGORIES.map((c) => (
            <button key={c.key} type="button" className={c.key === cat ? 'on' : ''} data-cat={c.key} onClick={() => { setCat(c.key); setManage(false); }}>{c.label}</button>
          ))}
        </div>
        {favTab && (
          <span className="math-pal-tools">
            {manage && <button type="button" className="reset" title="Reset to Default" onClick={resetMathFavorites}>기본값</button>}
            <button type="button" className={'edit' + (manage ? ' on' : '')} title={manage ? '편집 완료' : '즐겨찾기 편집'} aria-pressed={manage} onClick={() => setManage((v) => !v)}>{manage ? '완료' : '✎'}</button>
          </span>
        )}
      </div>
      <div className={'math-pal-grid' + (favTab ? ' flow' : '')}>
        {favTab && !items.length && <div className="math-pal-empty">즐겨찾기가 없습니다 — 수식 편집기의 ☆ 로 추가</div>}
        {items.map((it, i) => {
          const r = renderTex(it.show ?? it.pre + (it.post ?? ''), false);
          return (
            <button key={cat + i} type="button" title={manage ? '삭제 · ' + it.tip : it.tip} aria-label={it.tip} className={'math-pal-cell' + (manage ? ' removing' : '')}
              onClick={() => (manage ? removeMathFavoriteAt(i) : onPick(it))}>
              {r.error === undefined ? <span dangerouslySetInnerHTML={{ __html: r.svg }} /> : it.pre}
              {manage && <span className="math-pal-x" aria-hidden>×</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
