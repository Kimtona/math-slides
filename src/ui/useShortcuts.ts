import { useEffect } from 'react';
import type { Slide, TextElement } from '../model/types';
import { uid } from '../model/defaults';
import { currentSlide, useStore } from '../store/store';
import {
  CLIP_MIME, copySelection, duplicateSelection, insertImageFiles, insertLine, insertMathBox, insertPlainText,
  insertShape, insertTextCenter, isImageFile, pasteElements, pickImages,
} from '../canvas/insert';
import { nudgeSelection } from '../canvas/arrange';
import { openProject, saveProject } from '../store/persistence';
import { exportPdf, exportPptx } from '../export/run';
import { plainText } from '../editor/docUtils';
import { toggleMark } from './textFormat';
import { plainSlideCopy } from '../model/structure';
import { configShortcut, runConfigCommand } from '../store/configFile';

let slideClip: Slide | null = null;

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (st.presenting || st.exportMode) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      const typing = isTyping(e.target);
      const go = (fn: () => void) => { e.preventDefault(); fn(); };

      // Global (also while typing)
      const config = configShortcut(e);
      if (config) return go(() => runConfigCommand(config)); // Cmd+, / Cmd+Shift+, (fallback for the menu accelerators)
      if (mod && k === 's') return go(() => saveProject(e.shiftKey));
      if (mod && k === 'o') return go(openProject);
      if (mod && k === 'p') return go(exportPdf);
      if (mod && !e.shiftKey && k === 'e') return go(exportPptx);
      if ((mod && k === 'enter') || e.key === 'F5') return go(() => { st.stopEditing(); useStore.setState({ presenting: true }); });
      if (typing) return;

      if (mod && k === 'z') return go(() => (e.shiftKey ? st.redo() : st.undo()));
      if (mod && k === 'y') return go(st.redo);

      const slides = st.deck.slides;
      const idx = slides.findIndex((s) => s.id === st.currentSlideId);

      if (st.focusArea === 'navigator') {
        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') return go(() => idx > 0 && st.goToSlide(slides[idx - 1].id));
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') return go(() => idx < slides.length - 1 && st.goToSlide(slides[idx + 1].id));
        if (e.key === 'Enter') return go(() => st.addSlide());
        if (e.key === 'Backspace' || e.key === 'Delete') return go(() => st.deleteSlide(st.currentSlideId));
        if (mod && k === 'd') return go(() => st.duplicateSlide(st.currentSlideId));
        if (e.key === 'Escape') return go(() => useStore.setState({ focusArea: 'canvas' }));
        // Anything else (T, M, R, ⌘A …) acts on the current slide's canvas.
        useStore.setState({ focusArea: 'canvas' });
      }

      if (e.key === 'PageDown') return go(() => idx < slides.length - 1 && st.goToSlide(slides[idx + 1].id));
      if (e.key === 'PageUp') return go(() => idx > 0 && st.goToSlide(slides[idx - 1].id));

      const sel = st.selection;
      if (e.key === 'Backspace' || e.key === 'Delete') return go(st.deleteSelection);
      if (mod && k === 'd') return go(duplicateSelection);
      if (mod && k === 'a') return go(() => st.select(currentSlide().elements.map((x) => x.id)));
      if (mod && (k === 'b' || k === 'i' || k === 'u') && sel.length) return go(() => toggleMark(k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline'));
      if (st.cropEditId && (e.key === 'Escape' || e.key === 'Enter')) return go(st.exitCrop);
      if (e.key === 'Escape' && st.activeCell && sel.length === 1 && sel[0] === st.activeCell.id) return go(() => useStore.setState({ activeCell: null })); // table: back to "whole table" before deselecting
      if (e.key === 'Escape') return go(() => st.select([]));
      if (e.key === 'Enter' && sel.length === 1) {
        const el = currentSlide().elements.find((x) => x.id === sel[0]);
        if (el?.type === 'text') return go(() => st.startEditing(el.id, 'end'));
        if (el?.type === 'table') return go(() => st.startCellEditing(el.id, 0, 0, 'end'));
        if (el?.type === 'image') return go(() => st.enterCrop(el.id));
      }
      if (e.code === 'BracketRight' && mod) return go(() => st.reorderSelection(e.shiftKey ? 'front' : 'forward'));
      if (e.code === 'BracketLeft' && mod) return go(() => st.reorderSelection(e.shiftKey ? 'back' : 'backward'));
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (arrows[e.key]) {
        if (sel.length) {
          const step = e.shiftKey ? 10 : 1;
          return go(() => nudgeSelection(arrows[e.key][0] * step, arrows[e.key][1] * step));
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') return go(() => idx < slides.length - 1 && st.goToSlide(slides[idx + 1].id));
        return go(() => idx > 0 && st.goToSlide(slides[idx - 1].id));
      }
      if (mod || e.altKey) return;
      const inserts: Record<string, () => void> = {
        t: insertTextCenter, m: insertMathBox, i: pickImages, r: () => insertShape('rect'),
        o: () => insertShape('ellipse'), l: () => insertLine(false), a: () => insertLine(true),
      };
      if (inserts[k]) return go(inserts[k]);
    };

    const onCopy = (e: ClipboardEvent, cut = false) => {
      const st = useStore.getState();
      if (isTyping(e.target) || st.editingId) return;
      if (st.focusArea === 'navigator') {
        slideClip = structuredClone(currentSlide());
        e.preventDefault();
        if (cut) st.deleteSlide(st.currentSlideId);
        return;
      }
      const json = copySelection();
      if (!json) return;
      e.preventDefault();
      e.clipboardData?.setData(CLIP_MIME, json);
      const texts = currentSlide().elements.filter((x): x is TextElement => x.type === 'text' && st.selection.includes(x.id));
      e.clipboardData?.setData('text/plain', texts.map((t) => plainText(t.doc)).join('\n\n') || ' ');
      if (cut) st.deleteSelection();
    };

    const onPaste = (e: ClipboardEvent) => {
      const st = useStore.getState();
      if (isTyping(e.target)) return; // the text editor handles its own paste
      const dt = e.clipboardData;
      if (!dt) return;
      if (st.editingId) {
        if (!Array.from(dt.files).some(isImageFile)) return;
        st.stopEditing();
      }
      if (st.focusArea === 'navigator' && slideClip) {
        e.preventDefault();
        const s = structuredClone(plainSlideCopy(slideClip));
        s.id = uid();
        s.elements = s.elements.map((x) => ({ ...x, id: uid() }));
        st.addSlide(st.currentSlideId, s);
        return;
      }
      const custom = dt.getData(CLIP_MIME);
      if (custom) { e.preventDefault(); pasteElements(custom); return; }
      const files = Array.from(dt.files).filter(isImageFile);
      if (files.length) { e.preventDefault(); insertImageFiles(files); return; }
      const text = dt.getData('text/plain');
      if (text.trim()) { e.preventDefault(); insertPlainText(text); return; }
      if (pasteElements(null)) e.preventDefault();
    };

    const onCut = (e: ClipboardEvent) => onCopy(e, true);
    window.addEventListener('keydown', onKey);
    document.addEventListener('copy', onCopy as any);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('copy', onCopy as any);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, []);
}
