import { useRef, useState } from 'react';
import { HIGHLIGHT_COLORS, parseHex, sameColor, STANDARD_COLORS, THEME_COLORS } from '../model/colors';
import { captureTextSelection, setHighlight, setTextColor } from './textFormat';
import { Icons, Popover } from './controls';

function Swatch({ color, label, value, apply }: { color: string; label: string; value: string | null; apply: (color: string) => void }) {
  return <button type="button" className={`text-swatch${sameColor(value, color) ? ' selected' : ''}`}
    style={{ background: color }} title={`${label} (${color})`} aria-label={label} aria-pressed={sameColor(value, color)}
    onClick={() => apply(color)} />;
}

function ColorPalette({ value, apply, close }: { value: string | null; apply: (color: string) => void; close: () => void }) {
  const [custom, setCustom] = useState(false);
  const [hex, setHex] = useState(value || '#3B82F6');
  const valid = parseHex(hex);
  const choose = (color: string) => { apply(color); close(); };
  return <div className="text-palette" role="dialog" aria-label="Text Color" onKeyDown={(e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }}>
    <div className="palette-heading">Theme Colors</div>
    <div className="theme-colors">
      {THEME_COLORS.map((column) => <div className="theme-column" key={column.name}>
        <Swatch color={column.base} label={`Theme ${column.name}`} value={value} apply={choose} />
        <div className="theme-shades">{column.shades.map((color, i) =>
          <Swatch key={color} color={color} label={`${column.name} shade ${i + 1}`} value={value} apply={choose} />)}</div>
      </div>)}
    </div>
    <div className="palette-heading">Standard Colors</div>
    <div className="standard-colors">{STANDARD_COLORS.map((c) =>
      <Swatch key={c.name} color={c.hex} label={`Standard ${c.name}`} value={value} apply={choose} />)}</div>
    <button className="palette-other" onClick={() => setCustom(!custom)} aria-expanded={custom}>Other Colors...</button>
    {custom && <form className="custom-color" onSubmit={(e) => { e.preventDefault(); if (valid) choose(valid); }}>
      <div className="custom-color-row">
        <input type="color" aria-label="Visual color picker" value={valid ?? '#3B82F6'} onChange={(e) => setHex(e.target.value.toUpperCase())} />
        <input aria-label="HEX color" value={hex} placeholder="#3B82F6" spellCheck={false} aria-invalid={!valid}
          onChange={(e) => setHex(e.target.value)} />
        <button type="submit" disabled={!valid}>Apply</button>
      </div>
      {!valid && <div className="color-error" role="alert">Enter 3 or 6 HEX digits, e.g. #3B82F6.</div>}
    </form>}
  </div>;
}

export function TextColorButton({ value }: { value: string | null }) {
  const restore = useRef<() => boolean>(() => true);
  return <Popover title={`글자 색 (Text Color): ${value ?? 'Mixed'}`} onOpen={() => { restore.current = captureTextSelection(); }} button={
    <span className="color-btn"><span className="a-glyph">A</span>
      <span className={`swatch${value === null ? ' mixed' : ''}`} style={{ backgroundColor: value ?? undefined }} /></span>
  }>
    {(close) => <ColorPalette value={value} close={close} apply={(c) => { if (restore.current()) setTextColor(c); }} />}
  </Popover>;
}

/** Shape Fill: the Highlight palette (shared HIGHLIGHT_COLORS) applied to a shape's fill; null = no fill. */
export function ShapeFillButton({ value, onChange }: { value: string | null; onChange: (c: string | null) => void }) {
  return <Popover title={`채우기 (Fill): ${value ?? 'None'}`} button={
    <span className="color-btn"><span className="small-label">채우기</span><span className={`swatch${value ? '' : ' none'}`} style={{ backgroundColor: value ?? undefined }} /></span>
  }>
    {(close) => {
      const apply = (color: string | null) => { onChange(color); close(); };
      return <div className="highlight-palette" role="dialog" aria-label="Fill" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}>
        <div className="palette-heading">Fill</div>
        <div className="highlight-colors">{HIGHLIGHT_COLORS.map((c) =>
          <Swatch key={c.name} color={c.hex} label={`Fill ${c.name}`} value={value} apply={apply} />)}</div>
        <button className="palette-other" onClick={() => apply(null)}>None / Remove Fill</button>
      </div>;
    }}
  </Popover>;
}

export function HighlightButton({ value }: { value: string | null }) {
  const restore = useRef<() => boolean>(() => true);
  return <Popover title={`강조 (Highlight): ${value === null ? 'Mixed' : value || 'None'}`} onOpen={() => { restore.current = captureTextSelection(); }} button={
    <span className="color-btn">{Icons.highlight}<span className={`swatch${value === null ? ' mixed' : !value ? ' none' : ''}`} style={{ backgroundColor: value || undefined }} /></span>
  }>
    {(close) => {
      const apply = (color: string | null) => { if (restore.current()) setHighlight(color); close(); };
      return <div className="highlight-palette" role="dialog" aria-label="Highlight" onKeyDown={(e) => {
        e.stopPropagation(); if (e.key === 'Escape') close();
      }}>
        <div className="palette-heading">Highlight</div>
        <div className="highlight-colors">{HIGHLIGHT_COLORS.map((c) =>
          <Swatch key={c.name} color={c.hex} label={`Highlight ${c.name}`} value={value} apply={apply} />)}</div>
        <button className="palette-other" onClick={() => apply(null)}>None / Remove Highlight</button>
      </div>;
    }}
  </Popover>;
}
