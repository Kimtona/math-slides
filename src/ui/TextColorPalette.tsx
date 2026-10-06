import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { HIGHLIGHT_COLORS, parseHex, sameColor, STANDARD_COLORS, THEME_COLORS } from '../model/colors';
import { captureTextSelection, setHighlight, setTextColor } from './textFormat';
import { Icons, Popover } from './controls';
import { getSavedColors, removeSavedColor, saveColor, subscribeUserPrefs } from '../store/userPrefs';

function Swatch({ color, label, value, apply }: { color: string; label: string; value: string | null; apply: (color: string) => void }) {
  return <button type="button" className={`text-swatch${sameColor(value, color) ? ' selected' : ''}`}
    style={{ background: color }} title={`${label} (${color})`} aria-label={label} aria-pressed={sameColor(value, color)}
    onClick={() => apply(color)} />;
}

/** The user's saved colors (a user-level preference, one list for every palette) as ordinary swatches. */
function SavedColorSwatches({ value, apply, remove }: { value: string | null; apply: (color: string) => void; remove?: boolean }) {
  const saved = useSyncExternalStore(subscribeUserPrefs, getSavedColors);
  return <>{saved.map((c) => remove
    ? <button type="button" key={c} className="text-swatch removing" style={{ background: c }} title={`삭제 (${c})`} aria-label={`Remove ${c}`} onClick={() => removeSavedColor(c)} />
    : <Swatch key={c} color={c} label={`My Color`} value={value} apply={apply} />)}</>;
}

/** My Colors row for palettes that only offer saved colors (Highlight, Shape Fill); hidden while the user has none. */
function SavedColorsRow({ value, apply }: { value: string | null; apply: (color: string) => void }) {
  const saved = useSyncExternalStore(subscribeUserPrefs, getSavedColors);
  if (!saved.length) return null;
  return <><div className="palette-heading">My Colors</div><div className="my-colors"><SavedColorSwatches value={value} apply={apply} /></div></>;
}

function ColorPalette({ value, apply, close, noneLabel, onNone }: { value: string | null; apply: (color: string) => void; close: () => void; noneLabel?: string; onNone?: () => void }) {
  const [custom, setCustom] = useState(false);
  const [hex, setHex] = useState(value || '#3B82F6');
  const [manage, setManage] = useState(false);
  const valid = parseHex(hex);
  const saved = useSyncExternalStore(subscribeUserPrefs, getSavedColors);
  // Chromium's EyeDropper (native screen sampler); simply absent where unsupported.
  const eyeDropper = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
  const pick = () => { if (eyeDropper) new eyeDropper().open().then((r) => setHex(parseHex(r.sRGBHex) ?? r.sRGBHex)).catch(() => {}); };
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
    <div className="palette-heading palette-heading-row">My Colors
      {saved.length > 0 && <button type="button" className={'palette-tool' + (manage ? ' on' : '')} title={manage ? '편집 완료' : '저장한 색 편집'} aria-pressed={manage} onClick={() => setManage(!manage)}>{manage ? '완료' : '✎'}</button>}
    </div>
    <div className="my-colors">
      <SavedColorSwatches value={value} apply={choose} remove={manage} />
      <button type="button" className="text-swatch add" title="내 색 추가 — HEX 또는 스포이트" aria-label="Add to My Colors" onClick={() => { setCustom(true); setManage(false); }}>+</button>
    </div>
    {onNone && <button className="palette-other" onClick={() => { onNone(); close(); }}>{noneLabel ?? 'None'}</button>}
    <button className="palette-other" onClick={() => setCustom(!custom)} aria-expanded={custom}>Other Colors...</button>
    {custom && <form className="custom-color" onSubmit={(e) => { e.preventDefault(); if (valid) choose(valid); }}>
      <div className="custom-color-row">
        <input type="color" aria-label="Visual color picker" value={valid ?? '#3B82F6'} onChange={(e) => setHex(e.target.value.toUpperCase())} />
        <input aria-label="HEX color" value={hex} placeholder="#3B82F6" spellCheck={false} aria-invalid={!valid}
          onChange={(e) => setHex(e.target.value)} />
        <button type="submit" disabled={!valid}>Apply</button>
      </div>
      <div className="custom-color-row custom-color-actions">
        <span className="custom-preview" aria-label="Current color" style={{ background: valid ?? 'transparent' }} />
        {eyeDropper && <button type="button" className="eyedropper" title="스포이트 — 화면에서 색 선택" aria-label="Eyedropper" onClick={pick}>{Icons.eyedropper}</button>}
        <button type="button" className="save-color" disabled={!valid || saved.includes(valid)} title={valid && saved.includes(valid) ? '이미 저장됨' : 'My Colors에 저장'}
          onClick={() => valid && saveColor(valid)}>{valid && saved.includes(valid) ? '★ 저장됨' : '☆ 저장'}</button>
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

/**
 * The full PowerPoint-style palette (Theme / Standard / Other colors) for a plain color property — slide
 * background, shape border. `onNone` adds a "no value" entry for properties that can be off (e.g. no border).
 */
export function PaletteColorButton({ title, label, value, onChange, onNone, noneLabel = '없음' }: {
  title: string; label: ReactNode; value: string | null; onChange: (c: string) => void; onNone?: () => void; noneLabel?: string;
}) {
  return <Popover title={`${title}: ${value ?? noneLabel}`} button={
    <span className="color-btn">{label}<span className={`swatch${value ? '' : ' none'}`} style={{ backgroundColor: value ?? undefined }} /></span>
  }>
    {(close) => <ColorPalette value={value} close={close} apply={onChange} onNone={onNone} noneLabel={noneLabel} />}
  </Popover>;
}

/** Presentation Theme Color: the Text Color palette (Theme / Standard / Other colors), stored as Deck.themeColor. */
export function ThemeColorButton({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return <Popover title={`Theme: ${value}`} button={
    <span className="color-btn"><span className="small-label">Theme</span><span className="swatch" style={{ backgroundColor: value }} /></span>
  }>
    {(close) => <ColorPalette value={value} close={close} apply={onChange} />}
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
        <SavedColorsRow value={value} apply={apply} />
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
        <SavedColorsRow value={value} apply={apply} />
        <button className="palette-other" onClick={() => apply(null)}>None / Remove Highlight</button>
      </div>;
    }}
  </Popover>;
}
