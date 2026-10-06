import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PRESET_COLORS, colorName, sameColor } from '../model/colors';

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

/**
 * Click-to-open popover anchored under a button. Rendered in a portal with fixed positioning
 * so it is never clipped by a scrolling toolbar.
 */
export function Popover({ button, children, title, className, onOpen }: { button: ReactNode; children: (close: () => void) => ReactNode; title?: string; className?: string; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !popRef.current?.contains(t) && !(t as Element).closest?.('.emoji-picker')) setOpen(false);
    };
    const close = () => setOpen(false);
    window.addEventListener('pointerdown', h, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('pointerdown', h, true); window.removeEventListener('resize', close); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return setAt(null);
    const r = ref.current!.getBoundingClientRect();
    const w = popRef.current?.offsetWidth ?? 0;
    setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), top: r.bottom + 6 });
  }, [open]);
  return (
    <div className={`pop-wrap ${className ?? ''}`} ref={ref}>
      <button className={`tbtn${open ? ' active' : ''}`} title={title} aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => { if (!open) onOpen?.(); setOpen(!open); }}>
        {button}
      </button>
      {open && createPortal(
        <div ref={popRef} className="pop" style={at ?? { visibility: 'hidden', left: 0, top: 0 }}
          onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault(); }}>
          {children(() => setOpen(false))}
        </div>,
        document.body,
      )}
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

/** Small preset palette (colors come from model/colors.ts). `allowNone` adds a transparent / "no color" cell. */
export function ColorButton({ value, onChange, allowNone, noneLabel = '없음', title, label }: {
  value: string | null; onChange: (c: string | null) => void; allowNone?: boolean; noneLabel?: string; title: string; label?: ReactNode;
}) {
  return (
    <Popover title={`${title}: ${value ? colorName(value) : noneLabel}`} button={
      <span className="color-btn">
        {label}
        <span className={`swatch${value ? '' : ' none'}`} style={{ background: value ?? undefined }} />
      </span>
    }>
      {(close) => (
        <div className="palette" aria-label={title}>
          <div className="palette-grid">
            {PRESET_COLORS.map((c) => (
              <button key={c.hex} className={`pal${sameColor(c.hex, value) ? ' sel' : ''}`} style={{ background: c.hex }}
                title={c.name} aria-label={c.name} data-color={c.name}
                onClick={() => { onChange(c.hex); close(); }} />
            ))}
            {allowNone && (
              <button className={`pal none${value ? '' : ' sel'}`} title={noneLabel} aria-label={noneLabel} data-color="none"
                onClick={() => { onChange(null); close(); }} />
            )}
          </div>
          <div className="palette-caption">{value ? colorName(value) : noneLabel}</div>
        </div>
      )}
    </Popover>
  );
}

/** Practical stroke widths (px on the 1280×720 slide; 1px = 0.75pt in PowerPoint). */
export const STROKE_WIDTHS = [1, 2, 3, 4, 6, 8, 12];

/** Border / line width: a few presets with a visual preview, plus optional "none". */
export function WidthButton({ value, onChange, allowNone, title }: {
  value: number | null; onChange: (w: number | null) => void; allowNone?: boolean; title: string;
}) {
  return (
    <Popover title={title} button={<span className="small-label width-btn">
      <span className="width-preview" style={{ height: value ? Math.min(value, 8) : 1, opacity: value ? 1 : 0.3 }} />
      {value ? `${value}px` : '없음'}
    </span>}>
      {(close) => (
        <div className="menu width-menu" aria-label={title}>
          {allowNone && (
            <div className={`menu-item${value === null ? ' sel' : ''}`} data-width="none" onClick={() => { onChange(null); close(); }}>
              <span>없음</span>
            </div>
          )}
          {STROKE_WIDTHS.map((w) => (
            <div key={w} className={`menu-item${w === value ? ' sel' : ''}`} data-width={w} onClick={() => { onChange(w); close(); }}>
              <span className="width-row"><span className="width-preview" style={{ height: w }} /></span>
              <span className="menu-kbd">{w}px</span>
            </div>
          ))}
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
  highlight: <I d="m14 3 7 7-9 9-7-7zM5 12l-2 6 3 3 6-2M3 21h7" />,
  code: <I d="m7 6-5 6 5 6m10-12 5 6-5 6M14 4l-4 16" />,
  undo: <I d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  redo: <I d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />,
  text: <I d="M4 7V4h16v3M9 20h6M12 4v16" />,
  image: <I><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" /></I>,
  shape: <I><rect x="3" y="3" width="10" height="10" rx="1" /><circle cx="16" cy="16" r="5" /></I>,
  emoji: <I><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01" /></I>,
  eyedropper: <I d="m2 22 1-1h3l9-9M3 21v-3l9-9M15 6l3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3z" />,
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
