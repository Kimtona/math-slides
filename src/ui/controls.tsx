import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Btn(props: {
  title?: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode; className?: string; wide?: boolean;
}) {
  return (
    <button
      className={`tbtn${props.active ? ' active' : ''}${props.wide ? ' wide' : ''} ${props.className ?? ''}`}
      title={props.title} disabled={props.disabled}
      onMouseDown={(e) => e.preventDefault()} // keep the text editor focused
      onClick={props.onClick}>
      {props.children}
    </button>
  );
}

export const Sep = () => <div className="tsep" />;

/** Click-to-open popover anchored under a button. */
export function Popover({ button, children, title, className }: { button: ReactNode; children: (close: () => void) => ReactNode; title?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', h, true);
    return () => window.removeEventListener('pointerdown', h, true);
  }, [open]);
  return (
    <div className={`pop-wrap ${className ?? ''}`} ref={ref}>
      <button className={`tbtn${open ? ' active' : ''}`} title={title} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>
        {button}
      </button>
      {open && <div className="pop" onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault(); }}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function MenuItem({ onClick, children, shortcut }: { onClick: () => void; children: ReactNode; shortcut?: string }) {
  return (
    <div className="menu-item" onClick={onClick}>
      <span>{children}</span>
      {shortcut && <span className="menu-kbd">{shortcut}</span>}
    </div>
  );
}

const PALETTE = [
  '#1f2328', '#57606a', '#8c959f', '#ffffff',
  '#cf222e', '#bc4c00', '#bf8700', '#1a7f37',
  '#0969da', '#2f6feb', '#8250df', '#bf3989',
  '#ffebe9', '#fff8c5', '#dafbe1', '#dbe6fd',
];

export function ColorButton({ value, onChange, allowNone, title, label }: {
  value: string | null; onChange: (c: string | null) => void; allowNone?: boolean; title: string; label?: ReactNode;
}) {
  return (
    <Popover title={title} button={
      <span className="color-btn">
        {label}
        <span className={`swatch${value ? '' : ' none'}`} style={{ background: value ?? undefined }} />
      </span>
    }>
      {(close) => (
        <div className="palette">
          <div className="palette-grid">
            {PALETTE.map((c) => (
              <button key={c} className={`pal${c === value ? ' sel' : ''}`} style={{ background: c }} title={c}
                onClick={() => { onChange(c); close(); }} />
            ))}
          </div>
          <div className="palette-row">
            {allowNone && <button className="btn small" onClick={() => { onChange(null); close(); }}>없음</button>}
            <label className="btn small custom-color">
              직접 선택
              <input type="color" value={value ?? '#000000'} onChange={(e) => onChange(e.target.value)} />
            </label>
          </div>
        </div>
      )}
    </Popover>
  );
}

export function NumberField({ value, onChange, min = 1, max = 400, step = 1, title, width = 44 }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; title?: string; width?: number;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (v: string) => {
    const n = parseFloat(v);
    if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
    else setText(String(value));
  };
  return (
    <input className="num" title={title} style={{ width }} value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); onChange(Math.min(max, value + step)); }
        if (e.key === 'ArrowDown') { e.preventDefault(); onChange(Math.max(min, value - step)); }
      }} />
  );
}

// Minimal stroke icons (24×24)
const I = ({ d, children }: { d?: string; children?: ReactNode }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {d && <path d={d} />}{children}
  </svg>
);
export const Icons = {
  undo: <I d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  redo: <I d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />,
  text: <I d="M4 7V4h16v3M9 20h6M12 4v16" />,
  image: <I><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" /></I>,
  shape: <I><rect x="3" y="3" width="10" height="10" rx="1" /><circle cx="16" cy="16" r="5" /></I>,
  play: <I d="M6 4l14 8-14 8z" />,
  download: <I d="M12 3v12m0 0-4-4m4 4 4-4M4 17v3h16v-3" />,
  file: <I d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6" />,
  alignL: <I d="M4 3v18M8 7h12M8 12h7M8 17h10" />,
  alignC: <I d="M12 3v18M5 7h14M8 12h8M6 17h12" />,
  alignR: <I d="M20 3v18M4 7h12M9 12h7M6 17h10" />,
  alignT: <I d="M3 4h18M7 8v12M12 8v7M17 8v10" />,
  alignM: <I d="M3 12h18M7 5v14M12 8v8M17 6v12" />,
  alignB: <I d="M3 20h18M7 4v12M12 9v7M17 6v10" />,
  distH: <I d="M4 4v16M20 4v16M10 8h4v8h-4z" />,
  distV: <I d="M4 4h16M4 20h16M8 10h8v4H8z" />,
  tAlignL: <I d="M4 6h16M4 10h10M4 14h16M4 18h10" />,
  tAlignC: <I d="M4 6h16M7 10h10M4 14h16M7 18h10" />,
  tAlignR: <I d="M4 6h16M10 10h10M4 14h16M10 18h10" />,
  list: <I d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  olist: <I d="M10 6h10M10 12h10M10 18h10M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />,
  front: <I><rect x="8" y="8" width="12" height="12" rx="1" fill="currentColor" /><path d="M4 16V5a1 1 0 0 1 1-1h11" /></I>,
  back: <I><rect x="4" y="4" width="12" height="12" rx="1" fill="currentColor" /><path d="M20 8v11a1 1 0 0 1-1 1H8" /></I>,
  trash: <I d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />,
  copy: <I><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M4 16V5a1 1 0 0 1 1-1h11" /></I>,
  plus: <I d="M12 5v14M5 12h14" />,
};
