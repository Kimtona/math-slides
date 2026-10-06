import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Full emoji picker for Callout icons: a compact, MathSlides-owned popover (no OS emoji dialog), opened from the
 * `⋯` button of the Callout's quick icon row. The data is the Unicode CLDR set from `emojibase-data` (labels,
 * tags, groups), loaded on first use; selecting calls `onPick` with the plain Unicode string — the same value path
 * as the quick icons. Picker state is transient UI state only.
 */
interface EmojiEntry { hexcode: string; unicode: string; label: string; tags?: string[]; group?: number; order?: number }
interface EmojiData { entries: EmojiEntry[]; groups: { key: string; message: string; order: number }[] }

let dataPromise: Promise<EmojiData> | null = null;
function loadEmojiData(): Promise<EmojiData> {
  dataPromise ??= Promise.all([import('emojibase-data/en/compact.json'), import('emojibase-data/en/messages.json')]).then(([c, m]) => ({
    // Skin-tone swatches ("component" group) and entries without a group are not pickable emoji.
    entries: (c.default as unknown as EmojiEntry[]).filter((e) => typeof e.group === 'number' && e.group !== 2).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    groups: (m.default as unknown as Pick<EmojiData, 'groups'>).groups,
  }));
  return dataPromise;
}

export interface EmojiPickerRequest { anchor: DOMRect; current: string; onPick: (emoji: string) => void }

let request: EmojiPickerRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export const openEmojiPicker = (r: EmojiPickerRequest) => { request = r; emit(); };
export const closeEmojiPicker = () => { if (request) { request = null; emit(); } };

const WIDTH = 328, HEIGHT = 360;

function Picker({ req }: { req: EmojiPickerRequest }) {
  const [data, setData] = useState<EmojiData | null>(null);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => { loadEmojiData().then(setData); }, []);
  // The editor may take focus back right after opening: focus the search once the popover is positioned and again when data arrives.
  useEffect(() => { if (at) input.current?.focus({ preventScroll: true }); }, [at, data]);
  // Anchored below the ⋯ button, flipped above / clamped when it would leave the window.
  useLayoutEffect(() => {
    const a = req.anchor, below = a.bottom + 6 + HEIGHT <= window.innerHeight - 8;
    setAt({
      left: Math.max(8, Math.min(a.left, window.innerWidth - WIDTH - 8)),
      top: below ? a.bottom + 6 : Math.max(8, a.top - 6 - HEIGHT),
    });
  }, [req]);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) closeEmojiPicker(); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('resize', closeEmojiPicker);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('resize', closeEmojiPicker); };
  }, []);

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!data || !q) return null;
    const words = q.split(/\s+/);
    return data.entries.filter((e) => { const hay = `${e.label} ${(e.tags ?? []).join(' ')}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  }, [data, q]);
  const sections = useMemo(() => {
    if (!data) return [];
    return data.groups.filter((g) => g.key !== 'component').map((g) => ({ ...g, items: data.entries.filter((e) => e.group === g.order) })).filter((g) => g.items.length);
  }, [data]);

  const cell = (e: EmojiEntry) => (
    <button key={e.hexcode} type="button" className={e.unicode === req.current ? 'on' : ''} title={e.label} aria-label={e.label}
      onClick={() => { closeEmojiPicker(); req.onPick(e.unicode); }}>{e.unicode}</button>
  );

  return createPortal(
    <div ref={ref} className="emoji-picker" role="dialog" aria-label="이모지" style={at ?? { visibility: 'hidden', left: 0, top: 0 }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); closeEmojiPicker(); } }}>
      <input ref={input} className="emoji-search" value={query} placeholder="이모지 검색…" spellCheck={false} aria-label="이모지 검색" onChange={(e) => setQuery(e.target.value)} />
      <div className="emoji-cats">
        {sections.map((g) => (
          <button key={g.key} type="button" title={g.message} aria-label={g.message} disabled={!!q}
            onClick={() => scroller.current?.querySelector(`[data-group="${g.key}"]`)?.scrollIntoView({ block: 'start' })}>{g.items[0].unicode}</button>
        ))}
      </div>
      <div className="emoji-scroll" ref={scroller}>
        {!data ? <div className="emoji-empty">불러오는 중…</div>
          : results ? (results.length ? <div className="emoji-grid">{results.map(cell)}</div> : <div className="emoji-empty">검색 결과 없음</div>)
          : sections.map((g) => (
            <section key={g.key} data-group={g.key}>
              <div className="emoji-heading">{g.message}</div>
              <div className="emoji-grid">{g.items.map(cell)}</div>
            </section>
          ))}
      </div>
    </div>,
    document.body,
  );
}

export function EmojiPickerHost() {
  const [, tick] = useState(0);
  useEffect(() => { const l = () => tick((n) => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return request ? <Picker key={`${request.anchor.left},${request.anchor.top}`} req={request} /> : null;
}
