import type { Editor } from '@tiptap/core';

/** The link being inserted/edited with Cmd+K: its target range in the active editor. Drives LinkPopover. */
export interface LinkEdit {
  editor: Editor;
  from: number;
  to: number;
  /** Current href of the range ('' = none yet). */
  href: string;
  /** No selection and no link at the caret: applying inserts the URL as linked text. */
  insert: boolean;
}

let current: LinkEdit | null = null;
const listeners = new Set<() => void>();

export const getLinkEdit = () => current;
export function setLinkEdit(e: LinkEdit | null) {
  const prev = current;
  current = e;
  listeners.forEach((l) => l());
  // Repaint the target highlight (a decoration) in the editors involved.
  for (const ed of new Set([prev?.editor, e?.editor])) if (ed && !ed.isDestroyed) ed.view.dispatch(ed.state.tr.setMeta('linkEdit', true));
}
export function subscribeLinkEdit(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}
