import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { useStore } from './store/store';
import { Toolbar } from './ui/Toolbar';
import { PropsBar } from './ui/PropsBar';
import { Navigator } from './ui/Navigator';
import { Canvas } from './canvas/Canvas';
import { MathPopover } from './editor/MathPopover';
import { EmojiPickerHost } from './editor/EmojiPicker';
import { Presenter } from './ui/Presenter';
import { PrintRoot } from './export/PrintRoot';
import { useShortcuts } from './ui/useShortcuts';

function NotesPanel() {
  const [open, setOpen] = useState(false);
  const slide = useStore((s) => s.deck.slides.find((x) => x.id === s.currentSlideId)!);
  return (
    <div className={`notes${open ? ' open' : ''}`}>
      <button className="notes-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} 발표자 노트{!open && slide.notes ? ' •' : ''}
      </button>
      {open && (
        <textarea className="notes-input" value={slide.notes} placeholder="이 슬라이드의 발표자 노트 (PPTX에 포함됩니다)"
          onFocus={() => useStore.getState().beginGesture()}
          onBlur={() => useStore.getState().endGesture()}
          onChange={(e) => {
            const v = e.target.value;
            useStore.getState().live((d) => { const s = d.slides.find((x) => x.id === slide.id); if (s) s.notes = v; });
          }} />
      )}
    </div>
  );
}

export default function App() {
  useShortcuts();
  // Printing from the browser menu (File → Print) also prints the slides.
  useEffect(() => {
    let ours = false;
    const before = () => {
      if (useStore.getState().exportMode) return;
      ours = true;
      useStore.getState().stopEditing();
      flushSync(() => useStore.setState({ exportMode: 'print' }));
    };
    const after = () => { if (ours) { ours = false; useStore.setState({ exportMode: null }); } };
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); };
  }, []);
  const presenting = useStore((s) => s.presenting);
  // Window / tab title follows the (synchronized) project title.
  const title = useStore((s) => s.deck.title);
  useEffect(() => { document.title = `${title} — MathSlides`; }, [title]);
  return (
    <>
      <div className="app">
        <Toolbar />
        <PropsBar />
        <div className="workspace">
          <Navigator />
          <main className="stage">
            <Canvas />
            <NotesPanel />
          </main>
        </div>
        <MathPopover />
        <EmojiPickerHost />
      </div>
      <PrintRoot />
      {presenting && <Presenter />}
    </>
  );
}
