import { Mark, getMarkRange, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { closeHistory } from '@tiptap/pm/history';
import { getLinkEdit, setLinkEdit } from './linkEdit';
import { pastedUrl, urlEndingAt } from '../model/linkUrl';

/**
 * User-created hyperlink (typed/pasted URL or Cmd+K on any text). A separate mark from the generated `link`
 * (References/TOC), so those keep their plain look and stored shape. Blue + underlined; an explicit text color wins
 * because the color span is inside the link.
 */
const MARK = 'userLink';
const NO_LINK_ZONES = ['code', 'link', MARK];

/** Click-to-open modifier while editing. */
const openHref = (href: string) => void window.open(href, '_blank', 'noopener');

/** Text of the textblock before `pos` with a doc position for each character (inline atoms count as one placeholder char). */
function textBefore(state: EditorState, pos: number) {
  const $pos = state.doc.resolve(pos);
  const base = $pos.start();
  let text = '';
  const at: number[] = [];
  $pos.parent.forEach((child, offset) => {
    if (offset >= $pos.parentOffset) return;
    if (child.isText) {
      const s = child.text!.slice(0, $pos.parentOffset - offset);
      for (let i = 0; i < s.length; i++) at.push(base + offset + i);
      text += s;
    } else { at.push(base + offset); text += '￼'; }
  });
  return { text, at, $pos };
}

/** The URL ending at `pos` (caret), or null: also null inside code, existing links, or when text follows without punctuation. */
function urlBefore(state: EditorState, pos: number) {
  const { text, at, $pos } = textBefore(state, pos);
  if ($pos.parent.type.spec.code) return null;
  const m = urlEndingAt(text);
  if (!m) return null;
  const from = at[m.start], to = at[m.end - 1] + 1;
  if (NO_LINK_ZONES.some((n) => state.schema.marks[n] && state.doc.rangeHasMark(from, to, state.schema.marks[n]))) return null;
  return { from, to, href: m.href };
}

const addLink = (state: EditorState, from: number, to: number, href: string) =>
  state.tr.addMark(from, to, state.schema.marks[MARK].create({ href }));

/** Own undo step for the link: the first Cmd+Z after auto-linking removes only the link and keeps the typed URL. */
function autoLink(view: EditorView, hit: { from: number; to: number; href: string }) {
  view.dispatch(closeHistory(addLink(view.state, hit.from, hit.to, hit.href)));
}

/** Ranges of this mark intersecting [from, to], merged across adjacent text nodes with the same href. */
function linkRanges(state: EditorState, from: number, to: number) {
  const type = state.schema.marks[MARK];
  const out: { from: number; to: number; href: string }[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    const m = node.isText ? node.marks.find((x) => x.type === type) : undefined;
    if (!m) return;
    const last = out[out.length - 1];
    if (last && last.to === pos && last.href === m.attrs.href) last.to = pos + node.nodeSize;
    else out.push({ from: pos, to: pos + node.nodeSize, href: m.attrs.href });
  });
  return out;
}

/** Cmd+K / toolbar: decide what the popover edits and open it. */
export function openLinkPopover(editor: Editor) {
  const { state } = editor;
  const type = state.schema.marks[MARK];
  const { from, to, $from } = state.selection;
  if (state.selection.constructor.name !== 'TextSelection' || $from.parent.type.spec.code) return false;
  if (from === to) {
    const r = getMarkRange($from, type);
    const href = r ? linkRanges(state, r.from, r.to)[0]?.href ?? '' : '';
    setLinkEdit({ editor, from: r?.from ?? from, to: r?.to ?? to, href, insert: !r });
    return true;
  }
  const ranges = linkRanges(state, from, to);
  const whole = ranges.length === 1 && ranges[0].from <= from && ranges[0].to >= to ? ranges[0] : null;
  const hrefs = new Set(ranges.map((r) => r.href));
  setLinkEdit({ editor, from: whole?.from ?? from, to: whole?.to ?? to, href: hrefs.size === 1 ? [...hrefs][0] : '', insert: false });
  return true;
}

/** Apply (href) or remove (null) the link on the popover's target; display text is never changed except when inserting. */
export function applyLink(href: string | null, display?: string) {
  const e = getLinkEdit();
  if (!e || e.editor.isDestroyed) return;
  const { editor } = e;
  const type = editor.state.schema.marks[MARK];
  let { from, to } = e;
  const tr = editor.state.tr;
  if (e.insert) {
    if (!href) return setLinkEdit(null);
    const text = display || href;
    tr.insertText(text, from, to);
    to = from + text.length;
  } else tr.removeMark(from, to, type);
  if (href) tr.addMark(from, to, type.create({ href }));
  tr.setSelection(TextSelection.create(tr.doc, to));
  tr.setStoredMarks([]);
  editor.view.dispatch(tr.scrollIntoView());
  setLinkEdit(null);
  editor.view.focus();
}

export function closeLinkPopover() {
  const e = getLinkEdit();
  setLinkEdit(null);
  if (e && !e.editor.isDestroyed) e.editor.view.focus();
}

export const UserLink = Mark.create({
  name: MARK,
  priority: 1000,
  inclusive: false,
  excludes: `${MARK} link`,
  addAttributes() {
    return { href: { default: null } };
  },
  parseHTML() {
    // Links pasted from outside become user links; copies of the generated References/TOC links stay generated.
    return [{
      tag: 'a[href]',
      getAttrs: (el) => {
        const a = el as HTMLElement;
        const href = a.getAttribute('href') ?? '';
        if (!/^https?:\/\//i.test(href)) return false;
        return a.classList.contains('doc-link') && !a.classList.contains('user-link') ? false : { href };
      },
    }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['a', { ...HTMLAttributes, class: 'doc-link user-link', target: '_blank', rel: 'noopener noreferrer' }, 0];
  },
  addKeyboardShortcuts() {
    return { 'Mod-k': () => openLinkPopover(this.editor) };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      key: new PluginKey('userLinks'),
      props: {
        // Space after a typed URL.
        handleTextInput(view, from, to, text) {
          if (text !== ' ' || from !== to || view.composing) return false;
          const hit = urlBefore(view.state, from);
          if (!hit) return false;
          view.dispatch(view.state.tr.insertText(' ', from, to).scrollIntoView());
          autoLink(view, hit);
          return true;
        },
        // Enter / Shift+Enter after a typed URL: the line break goes first, then the link (own undo step).
        handleKeyDown(view, event) {
          if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || view.composing) return false;
          const { selection } = view.state;
          if (!selection.empty) return false;
          const hit = urlBefore(view.state, selection.from);
          if (!hit) return false;
          const text = view.state.doc.textBetween(hit.from, hit.to);
          queueMicrotask(() => {
            if (editor.isDestroyed || view.state.doc.textBetween(hit.from, hit.to, '', '') !== text) return;
            autoLink(view, hit);
          });
          return false;
        },
        // A pasted bare URL: linked text at the caret, or the selected text becomes the link.
        handlePaste(view, event) {
          const href = pastedUrl(event.clipboardData?.getData('text/plain') ?? '');
          if (!href) return false;
          const { state } = view;
          const { from, to, empty, $from } = state.selection;
          if ($from.parent.type.spec.code) return false;
          const marks = empty ? state.storedMarks ?? $from.marks() : [];
          if (NO_LINK_ZONES.some((n) => marks.some((m) => m.type.name === n) || (!empty && state.doc.rangeHasMark(from, to, state.schema.marks[n])))) return false;
          const tr = state.tr;
          if (empty) {
            const text = event.clipboardData!.getData('text/plain').trim();
            tr.insertText(text, from).addMark(from, from + text.length, state.schema.marks[MARK].create({ href }));
          } else tr.addMark(from, to, state.schema.marks[MARK].create({ href }));
          view.dispatch(tr.scrollIntoView());
          return true;
        },
        // Cmd/Ctrl+click opens the link; a plain click only places the caret.
        handleDOMEvents: {
          click(_view, event) {
            const a = (event.target as Element | null)?.closest?.('a.user-link') as HTMLAnchorElement | null;
            if (!a) return false;
            event.preventDefault();
            if (event.metaKey || event.ctrlKey) openHref(a.getAttribute('href') ?? '');
            return false;
          },
        },
        // Keep the edited text visibly selected while the popover input has focus.
        decorations(state) {
          const e = getLinkEdit();
          if (!e || e.editor !== editor || e.from >= e.to || e.to > state.doc.content.size) return null;
          return DecorationSet.create(state.doc, [Decoration.inline(e.from, e.to, { class: 'link-target' })]);
        },
      },
    })];
  },
});
