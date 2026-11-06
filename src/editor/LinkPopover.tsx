import { useLayoutEffect, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getActiveEditor } from './active';
import { getLinkEdit, subscribeLinkEdit } from './linkEdit';
import { applyLink, closeLinkPopover } from './linkMark';
import { toHref } from '../model/linkUrl';

/** Cmd+K link field under the selected text: URL input with 적용 / 제거 / 열기. Enter applies, Esc cancels. */
export function LinkPopover() {
  const edit = useSyncExternalStore(subscribeLinkEdit, getLinkEdit);
  const [value, setValue] = useState('');
  const [bad, setBad] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // (Re)load the field when a new edit starts.
  useLayoutEffect(() => {
    if (!edit) return setPos(null);
    setValue(edit.href);
    setBad(false);
    const view = edit.editor.view;
    const a = view.coordsAtPos(edit.from), b = view.coordsAtPos(edit.to);
    const w = 360;
    const x = Math.max(8, Math.min((a.left + b.right) / 2 - w / 2, window.innerWidth - w - 8));
    let y = b.bottom + 8;
    if (y + 90 > window.innerHeight) y = Math.max(8, a.top - 98);
    setPos({ x, y });
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  }, [edit]);

  // Outside click or leaving the text editor closes it.
  useEffect(() => {
    if (!edit) return;
    const onDown = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) closeLinkPopover(); };
    const stale = setInterval(() => { if (getActiveEditor() !== edit.editor) closeLinkPopover(); }, 250);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('pointerdown', onDown, true); clearInterval(stale); };
  }, [edit]);

  if (!edit || !pos) return null;

  const apply = () => {
    if (!value.trim()) return applyLink(null);
    const href = toHref(value);
    if (!href) return setBad(true);
    applyLink(href, value.trim());
  };
  const open = () => {
    const href = toHref(value);
    if (href) window.open(href, '_blank', 'noopener');
  };

  return createPortal(
    <div ref={box} className="link-popover" style={{ left: pos.x, top: pos.y }}>
      <input
        ref={input}
        className={'link-input' + (bad ? ' bad' : '')}
        value={value}
        spellCheck={false}
        placeholder="https://"
        onChange={(e) => { setValue(e.target.value); setBad(false); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') { e.preventDefault(); apply(); }
          else if (e.key === 'Escape') { e.preventDefault(); closeLinkPopover(); }
        }}
      />
      <div className="link-popover-foot">
        <span className={bad ? 'math-err-msg' : 'math-help'}>{bad ? '올바른 http(s) 주소가 아닙니다' : edit.insert ? '링크 텍스트로 삽입됩니다' : '표시 텍스트는 바뀌지 않습니다'}</span>
        {!edit.insert && edit.href && <button type="button" className="btn small" onClick={() => applyLink(null)}>제거</button>}
        {!!edit.href && <button type="button" className="btn small" onClick={open}>열기</button>}
        <button type="button" className="btn primary small" onClick={apply}>적용 ↵</button>
      </div>
    </div>,
    document.body,
  );
}
