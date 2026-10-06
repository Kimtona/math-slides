import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import { insertMath } from './mathNodes';
import { pickImages } from '../canvas/insert';
import { convertToAcademicBlock, convertToCallout, convertToCodeBlock, convertToTodo } from './extensions';

interface Item {
  title: string;
  hint: string;
  icon: string;
  keys: string[];
  /** Only offered when the "/" starts the line (e.g. /code converts the whole line). */
  lineStart?: boolean;
  /** Hidden inside this node type (no nested callouts / blocks). */
  hideIn?: string;
  run: (editor: Editor, range: { from: number; to: number }) => void;
}

const ITEMS: Item[] = [
  { title: 'Block equation', hint: '블록 수식 — /math', icon: '∑', keys: ['math', 'equation', 'tex', 'latex', 'eq', 'display'],
    run: (ed, r) => insertMath(ed, true, r) },
  { title: 'Inline equation', hint: '인라인 수식 — ⌘⇧E, $$x$$', icon: '𝑥', keys: ['inline', 'imath', 'math', 'equation', 'tex', 'latex'],
    run: (ed, r) => insertMath(ed, false, r) },
  { title: 'Code block', hint: '코드 블록 — 줄 시작에서 /code', icon: '{ }', keys: ['code', 'codeblock', 'pre'], lineStart: true,
    run: (ed, r) => { convertToCodeBlock(ed, r); } },
  { title: 'Callout', hint: '콜아웃 — 줄 시작에서 /callout', icon: '💡', keys: ['callout', 'note', 'tip', 'warning'], lineStart: true, hideIn: 'callout',
    run: (ed, r) => { convertToCallout(ed, r); } },
  { title: 'Block', hint: '학술 블록 (Theorem, Definition…) — 줄 시작에서 /block', icon: '▭', keys: ['block', 'theorem', 'definition', 'lemma', 'proposition', 'example', 'remark', 'academic'], lineStart: true, hideIn: 'academicBlock',
    run: (ed, r) => { convertToAcademicBlock(ed, r); } },
  { title: 'Image', hint: '이미지 — 줄 시작에서 /image (툴바 이미지와 동일)', icon: '🖼', keys: ['image', 'img', 'picture', 'photo'], lineStart: true,
    run: (ed, r) => { ed.chain().focus().deleteRange(r).run(); pickImages(); } },
  { title: 'Todo', hint: '체크박스 — 줄 시작에서 /todo', icon: '☐', keys: ['todo', 'task', 'checkbox', 'check'], lineStart: true,
    run: (ed, r) => { convertToTodo(ed, r); } },
  { title: 'Bulleted list', hint: '글머리 기호 — "- "', icon: '•', keys: ['bullet', 'list', 'ul'],
    run: (ed, r) => ed.chain().focus().deleteRange(r).toggleBulletList().run() },
  { title: 'Numbered list', hint: '번호 목록 — "1. "', icon: '1.', keys: ['number', 'numbered', 'ordered', 'list', 'ol'],
    run: (ed, r) => ed.chain().focus().deleteRange(r).toggleOrderedList().run() },
];

function filter(q: string, lineStart: boolean, inside: string[] = []) {
  const s = q.toLowerCase();
  const rank = (it: Item) => (it.keys.includes(s) ? 0 : it.keys.some((k) => k.startsWith(s)) ? 1 : 2);
  return ITEMS.filter((it) => (!it.lineStart || lineStart) && !(it.hideIn && inside.includes(it.hideIn)) && (!s || it.keys.some((k) => k.startsWith(s)) || it.title.toLowerCase().includes(s)))
    .sort((a, b) => rank(a) - rank(b));
}

/** Longest the menu grows before its command list scrolls; it also never exceeds the room on its side of the caret. */
const MENU_MAX = 340, MENU_GAP = 6, MENU_MARGIN = 8;

interface MenuState { from: number; to: number; query: string; x: number; y: number; top: number; lineStart: boolean; inside: string[] }

/** Notion-like "/" command menu. `keyRef.current` is called from the editor's handleKeyDown. */
export function SlashMenu({ editor, keyRef }: { editor: Editor; keyRef: { current: ((e: KeyboardEvent) => boolean) | null } }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [index, setIndex] = useState(0);
  const dismissedAt = useRef<number | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const keyNav = useRef(false); // only keyboard moves scroll the list; hover must not make it jump

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
      const inside = ['callout', 'academicBlock'].filter((n) => editor.isActive(n));
      if (dismissedAt.current === from || !filter(m[1], lineStart, inside).length) return setMenu(null);
      const c = view.coordsAtPos(from);
      setMenu((prev) => {
        if (!prev || prev.query !== m[1]) setIndex(0);
        return { from, to: $from.pos, query: m[1], x: c.left, y: c.bottom, top: c.top, lineStart, inside };
      });
    };
    editor.on('transaction', update);
    return () => void editor.off('transaction', update);
  }, [editor]);

  const items = menu ? filter(menu.query, menu.lineStart, menu.inside) : [];

  keyRef.current = (e: KeyboardEvent) => {
    if (!menu || !items.length) return false;
    if (e.key === 'ArrowDown') { keyNav.current = true; setIndex((i) => (i + 1) % items.length); return true; }
    if (e.key === 'ArrowUp') { keyNav.current = true; setIndex((i) => (i - 1 + items.length) % items.length); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const it = items[Math.min(index, items.length - 1)];
      setMenu(null);
      it.run(editor, { from: menu.from, to: menu.to });
      return true;
    }
    if (e.key === 'Escape') { dismissedAt.current = menu.from; setMenu(null); return true; }
    return false;
  };

  // Keep the keyboard-active command inside the list's visible area (scrolls the list only, never the page).
  useLayoutEffect(() => {
    if (!keyNav.current) return;
    keyNav.current = false;
    const box = list.current, el = box?.children[Math.min(index, items.length - 1)] as HTMLElement | undefined;
    if (!box || !el) return;
    if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight;
  }, [index, items.length]);

  if (!menu || !items.length) return null;
  // Below the caret by default; flipped above it when there is little room below and more above.
  const below = window.innerHeight - (menu.y + MENU_GAP) - MENU_MARGIN, above = menu.top - MENU_GAP - MENU_MARGIN;
  const flip = below < 220 && above > below;
  const place = flip
    ? { bottom: window.innerHeight - menu.top + MENU_GAP, maxHeight: Math.min(MENU_MAX, above) }
    : { top: menu.y + MENU_GAP, maxHeight: Math.min(MENU_MAX, below) };
  return createPortal(
    <div className="slash-menu" style={{ left: menu.x, ...place }} onMouseDown={(e) => e.preventDefault()} onPointerDown={(e) => e.stopPropagation()}>
      <div className="slash-title">Commands</div>
      <div className="slash-list" ref={list}>
      {items.map((it, i) => (
        <div key={it.title} className={`slash-item ${i === index ? 'active' : ''}`}
          onMouseEnter={() => setIndex(i)}
          onClick={() => { setMenu(null); it.run(editor, { from: menu.from, to: menu.to }); }}>
          <span className="slash-icon">{it.icon}</span>
          <span><div className="slash-name">{it.title}</div><div className="slash-hint">{it.hint}</div></span>
        </div>
      ))}
      </div>
    </div>,
    document.body,
  );
}
