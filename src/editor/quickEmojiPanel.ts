import { closeEmojiPicker, openEmojiPicker } from './EmojiPicker';
import { getQuickEmojis, resetQuickEmojis, setQuickEmoji, subscribeUserPrefs } from '../store/userPrefs';

/**
 * The Quick Emojis row: `[10 quick emojis] [✎] [⋯]`, plus a slot editor behind `✎`. It is a view/editor of the single
 * user-level `quickEmojis` preference (store/userPrefs) and is hosted by both the Callout icon popover (pick = change
 * the Callout's icon) and the top-toolbar Emoji tool (pick = insert a standalone emoji). Only `onPick` differs; the
 * preference, the edit mode, Reset and the full picker are identical. Nothing here touches presentation state.
 */
export interface QuickEmojiPanelOptions {
  /** Emoji chosen from the quick row or the full picker. */
  onPick: (emoji: string) => void;
  /** Called just before `⋯` opens the full picker (the host usually closes itself). */
  onMore?: () => void;
  /** Currently selected emoji to highlight (e.g. the Callout's icon). */
  current?: () => string | undefined;
}

export function createQuickEmojiPanel(opts: QuickEmojiPanelOptions): { el: HTMLElement; destroy: () => void } {
  const el = document.createElement('div');
  el.className = 'callout-icons';
  let editSlot: number | null = null; // null = normal quick row; 0-9 = editing that slot
  const mkButton = (text: string, cls: string, title: string, onMouseDown: () => void) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = text; b.title = title; if (cls) b.className = cls;
    b.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); onMouseDown(); });
    return b;
  };
  const render = () => {
    el.replaceChildren();
    el.classList.toggle('editing', editSlot !== null);
    const quick = getQuickEmojis();
    if (editSlot === null) {
      const current = opts.current?.();
      quick.forEach((em) => el.append(mkButton(em, em === current ? 'on' : '', '', () => opts.onPick(em))));
      // ✎ = customize the quick row (left of ⋯); ⋯ = the full searchable picker, unchanged.
      el.append(mkButton('✎', 'edit', '빠른 이모지 편집', () => { editSlot = 0; render(); }));
      el.append(mkButton('⋯', 'more', '더 많은 이모지', () => {
        const anchor = el.querySelector('.more')!.getBoundingClientRect();
        opts.onMore?.();
        openEmojiPicker({ anchor, current: current ?? '', onPick: opts.onPick });
      }));
    } else {
      quick.forEach((em, i) => el.append(mkButton(em, i === editSlot ? 'slot on' : 'slot', `${i + 1}번 슬롯 교체`, () => {
        editSlot = i; render();
        // The slot is replaced through the existing full picker (same catalog/search), anchored below the editor row.
        openEmojiPicker({ anchor: el.getBoundingClientRect(), current: em, onPick: (v) => setQuickEmoji(i, v) });
      })));
      el.append(mkButton('기본값', 'reset', 'Reset to Default', () => { resetQuickEmojis(); }));
      el.append(mkButton('완료', 'done', '편집 완료', () => { editSlot = null; closeEmojiPicker(); render(); }));
    }
  };
  render();
  const unsub = subscribeUserPrefs(render); // a changed preference updates every open quick row immediately
  return { el, destroy: unsub };
}
