import type { Editor } from '@tiptap/core';

/** The TipTap editor of the text box currently being edited (only one at a time). */
let active: Editor | null = null;
const listeners = new Set<() => void>();

export const getActiveEditor = () => active;
export function setActiveEditor(e: Editor | null) {
  active = e;
  listeners.forEach((l) => l());
}
export function onActiveEditorChange(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}
