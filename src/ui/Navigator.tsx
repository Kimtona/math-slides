import { memo, useEffect, useRef, useState } from 'react';
import type { Slide } from '../model/types';
import { SLIDE_W } from '../model/types';
import { useStore } from '../store/store';
import { SlideView } from '../render/ElementView';
import { Icons } from './controls';
import { MOD } from './Toolbar';

const THUMB_W = 176;

const Thumb = memo(function Thumb({ slide, index, total }: { slide: Slide; index: number; total: number }) {
  const assets = useStore((s) => s.assets);
  const scale = THUMB_W / SLIDE_W;
  return (
    <div className="thumb-inner" style={{ width: THUMB_W, height: THUMB_W * 9 / 16 }}>
      <div style={{ transform: `scale(${scale})`, transformOrigin: '0 0' }}>
        <SlideView slide={slide} assets={assets} index={index} total={total} />
      </div>
    </div>
  );
});

export function Navigator() {
  const slides = useStore((s) => s.deck.slides);
  const current = useStore((s) => s.currentSlideId);
  const focus = useStore((s) => s.focusArea);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.querySelector('.thumb.current')?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);

  const st = useStore.getState;

  return (
    <aside className={`navigator${focus === 'navigator' ? ' focused' : ''}`}
      onPointerDown={() => useStore.setState({ focusArea: 'navigator' })}>
      <div className="nav-list" ref={listRef}>
        {slides.map((s, i) => (
          <div key={s.id}
            className={`thumb${s.id === current ? ' current' : ''}${dropAt === i && dragFrom !== null ? ' drop-before' : ''}${dropAt === i + 1 && i === slides.length - 1 && dragFrom !== null ? ' drop-after' : ''}`}
            draggable
            onDragStart={(e) => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-slide', String(i)); }}
            onDragOver={(e) => {
              if (dragFrom === null) return;
              e.preventDefault();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom !== null && dropAt !== null) st().moveSlide(dragFrom, dropAt > dragFrom ? dropAt - 1 : dropAt);
              setDragFrom(null); setDropAt(null);
            }}
            onDragEnd={() => { setDragFrom(null); setDropAt(null); }}
            onClick={() => st().goToSlide(s.id)}
            onContextMenu={(e) => { e.preventDefault(); st().goToSlide(s.id); setMenu({ x: e.clientX, y: e.clientY, id: s.id }); }}>
            <span className="thumb-num">{i + 1}</span>
            <Thumb slide={s} index={i} total={slides.length} />
          </div>
        ))}
        <button className="add-slide" title="새 슬라이드 (슬라이드 목록에서 Enter)" onClick={() => st().addSlide()}>
          {Icons.plus} 새 슬라이드
        </button>
      </div>
      {menu && (
        <div className="menu context" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          <div className="menu-item" onClick={() => { st().addSlide(menu.id); setMenu(null); }}>새 슬라이드 <span className="menu-kbd">↵</span></div>
          <div className="menu-item" onClick={() => { st().duplicateSlide(menu.id); setMenu(null); }}>슬라이드 복제 <span className="menu-kbd">{MOD}D</span></div>
          <div className="menu-item" onClick={() => { st().addTitleSlide(menu.id); setMenu(null); }}>제목 슬라이드 추가</div>
          <div className="menu-item" onClick={() => { st().addTocSlide(); setMenu(null); }}>
            {slides.some((x) => x.kind === 'toc') ? '목차 슬라이드로 이동' : '목차 슬라이드 추가'}
          </div>
          <div className="menu-item" onClick={() => { st().addThanksSlide(); setMenu(null); }}>감사 슬라이드 추가 (맨 끝)</div>
          <div className="menu-item danger" onClick={() => { st().deleteSlide(menu.id); setMenu(null); }}>슬라이드 삭제 <span className="menu-kbd">⌫</span></div>
        </div>
      )}
    </aside>
  );
}
