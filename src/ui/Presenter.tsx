import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SLIDE_H, SLIDE_W } from '../model/types';
import { useStore } from '../store/store';
import { SlideView } from '../render/ElementView';

/** Full-screen slideshow: ← → / space / click to navigate, Esc to exit. */
export function Presenter() {
  const deck = useStore((s) => s.deck);
  const assets = useStore((s) => s.assets);
  const start = useStore((s) => s.deck.slides.findIndex((x) => x.id === s.currentSlideId));
  const [idx, setIdx] = useState(Math.max(0, start));
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const idxRef = useRef(idx);
  idxRef.current = idx;

  useLayoutEffect(() => {
    document.documentElement.requestFullscreen?.().catch(() => {});
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    const onFs = () => { if (!document.fullscreenElement) exit(); };
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, []);

  const exit = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    const s = useStore.getState();
    useStore.setState({ presenting: false, currentSlideId: s.deck.slides[Math.min(idxRef.current, s.deck.slides.length - 1)].id, selection: [] });
  };

  useEffect(() => {
    const n = deck.slides.length;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter', 'n'].includes(e.key)) setIdx((i) => Math.min(n - 1, i + 1));
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'].includes(e.key)) setIdx((i) => Math.max(0, i - 1));
      else if (e.key === 'Home') setIdx(0);
      else if (e.key === 'End') setIdx(n - 1);
      else if (e.key === 'Escape') exit();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const scale = Math.min(size.w / SLIDE_W, size.h / SLIDE_H);
  const slide = deck.slides[idx];
  return (
    <div className="presenter" onClick={(e) => setIdx((i) => (e.clientX < size.w * 0.25 ? Math.max(0, i - 1) : Math.min(deck.slides.length - 1, i + 1)))}>
      <div style={{ width: SLIDE_W * scale, height: SLIDE_H * scale, overflow: 'hidden' }}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: '0 0' }}>
          {slide && <SlideView slide={slide} assets={assets} />}
        </div>
      </div>
      <div className="presenter-count">{idx + 1} / {deck.slides.length}</div>
    </div>
  );
}
