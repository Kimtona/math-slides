import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import { insertMath } from './mathNodes';
import { convertToCallout, convertToCodeBlock } from './extensions';

interface Item {
  title: string;
  hint: string;
  icon: string;
  keys: string[];
  /** Only offered when the "/" starts the line (e.g. /code converts the whole line). */
  lineStart?: boolean;
  /** Hidden inside a Callout (no nested callouts). */
  noCallout?: boolean;
  run: (editor: Editor, range: { from: number; to: number }) => void;
}

const ITEMS: Item[] = [
  { title: 'Block equation', hint: '블록 수식 — /math', icon: '∑', keys: ['math', 'equation', 'block', 'tex', 'latex', 'eq', 'display'],
    run: (ed, r) => insertMath(ed, true, r) },
  { title: 'Inline equation', hint: '인라인 수식 — ⌘⇧E, $$x$$', icon: '𝑥', keys: ['inline', 'imath', 'math', 'equation', 'tex', 'latex'],
    run: (ed, r) => insertMath(ed, false, r) },
  { title: 'Code block', hint: '코드 블록 — 줄 시작에서 /code', icon: '{ }', keys: ['code', 'codeblock', 'pre'], lineStart: true,
    run: (ed, r) => { convertToCodeBlock(ed, r); } },
  { title: 'Callout', hint: '콜아웃 — 줄 시작에서 /callout', icon: '💡', keys: ['callout', 'note', 'tip', 'warning'], lineStart: true, noCallout: true,
    run: (ed, r) => { convertToCallout(ed, r); } },
  { title: 'Bulleted list', hint: '글머리 기호 — "- "', icon: '•', keys: ['bullet', 'list', 'ul'],
    run: (ed, r) => ed.chain().focus().deleteRange(r).toggleBulletList().run() },
  { title: 'Numbered list', hint: '번호 목록 — "1. "', icon: '1.', keys: ['number', 'numbered', 'ordered', 'list', 'ol'],
    run: (ed, r) => ed.chain().focus().deleteRange(r).toggleOrderedList().run() },
];

function filter(q: string, lineStart: boolean, inCallout = false) {
  const s = q.toLowerCase();
  return ITEMS.filter((it) => (!it.lineStart || lineStart) && !(it.noCallout && inCallout) && (!s || it.keys.some((k) => k.startsWith(s)) || it.title.toLowerCase().includes(s)));
}

interface MenuState { from: number; to: number; query: string; x: number; y: number; lineStart: boolean; inCallout: boolean }

/** Notion-like "/" command menu. `keyRef.current` is called from the editor's handleKeyDown. */
export function SlashMenu({ editor, keyRef }: { editor: Editor; keyRef: { current: ((e: KeyboardEvent) => boolean) | null } }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [index, setIndex] = useState(0);
  const dismissedAt = useRef<number | null>(null);

  useEffect(() => {
    const update = () => {
      const { state, view } = editor;
      const sel = state.selection;
      // No commands inside a code block: "/" there is code.
      if (!sel.empty || !sel.$from.parent.isTextblock || sel.$from.parent.type.spec.code) return setMenu(null);
      const $from = sel.$from;
      const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 40), $from.parentOffset, undefined, '￼');
      const m = /(?:^|\s)\/([a-zA-Z]*)$/.exec(before);
      if (!m) {
        dismissedAt.current = null;
        return setMenu(null);
      }
      const from = $from.pos - m[1].length - 1;
      // Line start = "/" is the first character of the paragraph and that paragraph could become a code block.
      const lineStart = from === $from.start() && editor.can().setNode('codeBlock');
      const inCallout = editor.isActive('callout');
      if (dismissedAt.current === from || !filter(m[1], lineStart, inCallout).length) return setMenu(null);
      const c = view.coordsAtPos(from);
      setMenu((prev) => {
        if (!prev || prev.query !== m[1]) setIndex(0);
        return { from, to: $from.pos, query: m[1], x: c.left, y: c.bottom, lineStart, inCallout };
      });
    };
    editor.on('transaction', update);
    return () => void editor.off('transaction', update);
  }, [editor]);

  const items = menu ? filter(menu.query, menu.lineStart, menu.inCallout) : [];

  keyRef.current = (e: KeyboardEvent) => {
    if (!menu || !items.length) return false;
    if (e.key === 'ArrowDown') { setIndex((i) => (i + 1) % items.length); return true; }
    if (e.key === 'ArrowUp') { setIndex((i) => (i - 1 + items.length) % items.length); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const it = items[Math.min(index, items.length - 1)];
      setMenu(null);
      it.run(editor, { from: menu.from, to: menu.to });
      return true;
    }
    if (e.key === 'Escape') { dismissedAt.current = menu.from; setMenu(null); return true; }
    return false;
  };

  if (!menu || !items.length) return null;
  return createPortal(
    <div className="slash-menu" style={{ left: menu.x, top: menu.y + 6 }} onMouseDown={(e) => e.preventDefault()} onPointerDown={(e) => e.stopPropagation()}>
      <div className="slash-title">Commands</div>
      {items.map((it, i) => (
        <div key={it.title} className={`slash-item ${i === index ? 'active' : ''}`}
          onMouseEnter={() => setIndex(i)}
          onClick={() => { setMenu(null); it.run(editor, { from: menu.from, to: menu.to }); }}>
          <span className="slash-icon">{it.icon}</span>
          <span><div className="slash-name">{it.title}</div><div className="slash-hint">{it.hint}</div></span>
        </div>
      ))}
    </div>,
    document.body,
  );
}
