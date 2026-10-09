import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import type { Asset, Deck, ID, Slide, SlideElement, TableElement } from '../model/types';
import { initialDeck, isTemplatePlaceholder, newContentSlide, newTitleSlide, uid } from '../model/defaults';
import { plainText } from '../editor/docUtils';
import type { Guide } from '../model/geometry';
import { isDocEmpty, trimTrailingEmpty } from '../editor/docUtils';
import { isManagedText, plainSlideCopy, reconcileStructure, referencesHaveContent } from '../model/structure';
import { newThanksSlide, newTocSlide } from '../model/defaults';
import { flash } from './persistence';
import type { Citation } from '../model/types';

type Mutator = (d: Draft<Deck>) => void;

export interface MathEditState {
  pos: number; // ProseMirror position of the math node inside the editing text box
}

export interface AppState {
  deck: Deck;
  past: Deck[];
  future: Deck[];
  gestureBase: Deck | null;
  assets: Record<ID, Asset>;

  currentSlideId: ID;
  selection: ID[];
  editingId: ID | null;
  editingIsNew: boolean;
  editCaret: { x: number; y: number } | 'end' | 'all' | 'math' | null;
  mathEdit: MathEditState | null;
  /** While a table is being edited (editingId): the cell with the text caret. */
  editCell: { row: number; col: number } | null;
  /** Image being re-framed in crop edit mode (double-click an image). */
  cropEditId: ID | null;
  focusArea: 'canvas' | 'navigator';
  guides: Guide[];
  exportMode: null | 'print' | 'measure';
  presenting: boolean;
  fileHandle: any | null;
  saveState: 'saved' | 'saving' | 'dirty';

  // history
  commit: (fn: Mutator) => void;
  live: (fn: Mutator) => void;
  beginGesture: () => void;
  endGesture: () => void;
  undo: () => void;
  redo: () => void;
  loadDeck: (deck: Deck, assets: Record<ID, Asset>) => void;

  // selection / editing
  select: (ids: ID[]) => void;
  startEditing: (id: ID, caret?: AppState['editCaret'], isNew?: boolean) => void;
  stopEditing: () => void;
  /** Edit one cell of a table (starts editing the table, or moves between its cells; each cell edit is its own undo step). */
  startCellEditing: (id: ID, row: number, col: number, caret?: AppState['editCaret']) => void;
  /** Structural table change (rows/columns) as its own undo step; while editing, stays in edit mode at `next`. */
  editTable: (id: ID, fn: (t: Draft<TableElement>) => void, next?: { row: number; col: number } | null) => void;
  setMathEdit: (m: MathEditState | null) => void;
  enterCrop: (id: ID) => void;
  exitCrop: () => void;

  // elements
  addElements: (els: SlideElement[], opts?: { edit?: boolean; caret?: AppState['editCaret'] }) => void;
  deleteSelection: () => void;
  updateElements: (ids: ID[], fn: (el: Draft<SlideElement>) => void, live?: boolean) => void;
  reorderSelection: (dir: 'forward' | 'backward' | 'front' | 'back') => void;

  // slides
  goToSlide: (id: ID) => void;
  addSlide: (afterId?: ID, slide?: Slide) => void;
  duplicateSlide: (id: ID) => void;
  deleteSlide: (id: ID) => void;
  moveSlide: (from: number, to: number) => void;
  addTitleSlide: (afterId?: ID) => void;
  addTocSlide: () => void;
  addThanksSlide: () => void;

  // citations (footer of a slide)
  addCitations: (slideId: ID, cites: Citation[]) => void;
  removeCitation: (slideId: ID, citationId: ID) => void;
  /** Store fetched metadata everywhere (incl. undo history) without creating an undo step. */
  applyCitation: (c: Citation) => void;

  addAsset: (a: Asset) => void;
}

const HISTORY_LIMIT = 200;

export function findSlide(deck: Deck, id: ID) {
  return deck.slides.find((s) => s.id === id);
}

function findElement(deck: Deck, id: ID) {
  for (const s of deck.slides) for (const e of s.elements) if (e.id === id) return e;
  return undefined;
}

/**
 * First-slide title → project title. Runs after every change; only reacts when the
 * designated title element's text actually changed (so renaming the project in the
 * toolbar sticks until the slide title is edited again).
 */
function syncTitle(prev: Deck, next: Deck): Deck {
  const id = next.titleElementId;
  if (!id || prev === next) return next;
  const a = findElement(prev, id), b = findElement(next, id);
  if (!b || b.type !== 'text' || (a?.type === 'text' && a.doc === b.doc)) return next;
  const text = plainText(b.doc).replace(/\s+/g, ' ').trim();
  if (!text || text === next.title) return next;
  return produce(next, (d) => { d.title = text; });
}

export const useStore = create<AppState>()((set, get) => {
  const deck0 = initialDeck();

  /** Current slide id that exists in `deck`: unchanged if it survived, else the slide now at its old position (clamped). */
  const validCurrent = (deck: Deck, cur: ID): ID => {
    if (deck.slides.some((x) => x.id === cur)) return cur;
    const oldIdx = get().deck.slides.findIndex((x) => x.id === cur);
    return deck.slides[Math.max(0, Math.min(oldIdx, deck.slides.length - 1))].id;
  };

  /** Keeps current slide / selection valid after the deck changes underneath (undo, delete...). */
  const fixup = (deck: Deck, s: Partial<AppState> = {}): Partial<AppState> => {
    const st = { ...get(), ...s };
    const cur = validCurrent(deck, st.currentSlideId);
    const slide = findSlide(deck, cur)!;
    const ids = new Set(slide.elements.map((e) => e.id));
    return { ...s, deck, currentSlideId: cur, selection: st.selection.filter((i) => ids.has(i)) };
  };

  /** After commit/live: only if reconciliation or the mutation removed the current slide, move to the fallback. */
  const keepCurrentValid = (deck: Deck): Partial<AppState> => {
    const cur = get().currentSlideId;
    const valid = validCurrent(deck, cur);
    return valid === cur ? {} : { currentSlideId: valid, selection: [] };
  };

  return {
    deck: deck0,
    past: [],
    future: [],
    gestureBase: null,
    assets: {},
    currentSlideId: deck0.slides[0].id,
    selection: [],
    editingId: null,
    editingIsNew: false,
    editCaret: null,
    mathEdit: null,
    editCell: null,
    cropEditId: null,
    focusArea: 'canvas',
    guides: [],
    exportMode: null,
    presenting: false,
    fileHandle: null,
    saveState: 'saved',

    commit: (fn) => {
      const { deck, past, gestureBase } = get();
      const next = reconcileStructure(deck, syncTitle(deck, produce(deck, fn)));
      if (next === deck) return;
      const cur = keepCurrentValid(next);
      if (gestureBase) set({ deck: next, ...cur });
      else set({ deck: next, past: [...past, deck].slice(-HISTORY_LIMIT), future: [], ...cur });
    },
    live: (fn) => {
      const { deck } = get();
      const next = reconcileStructure(deck, syncTitle(deck, produce(deck, fn)));
      if (next !== deck) set({ deck: next, ...keepCurrentValid(next) });
    },
    beginGesture: () => {
      if (!get().gestureBase) set({ gestureBase: get().deck });
    },
    endGesture: () => {
      const { gestureBase, deck, past } = get();
      if (!gestureBase) return;
      if (gestureBase === deck) set({ gestureBase: null });
      else set({ gestureBase: null, past: [...past, gestureBase].slice(-HISTORY_LIMIT), future: [] });
    },
    undo: () => {
      if (get().editingId) get().stopEditing();
      if (get().cropEditId) get().exitCrop();
      const { past, future, deck } = get();
      if (!past.length) return;
      const prev = past[past.length - 1];
      set(fixup(prev, { past: past.slice(0, -1), future: [deck, ...future] }));
    },
    redo: () => {
      if (get().editingId) get().stopEditing();
      if (get().cropEditId) get().exitCrop();
      const { past, future, deck } = get();
      if (!future.length) return;
      set(fixup(future[0], { past: [...past, deck], future: future.slice(1) }));
    },
    loadDeck: (deck, assets) => {
      set({
        deck, assets, past: [], future: [], gestureBase: null, selection: [], editingId: null, editCell: null, mathEdit: null, cropEditId: null,
        editingIsNew: false, editCaret: null, guides: [], focusArea: 'canvas', presenting: false,
        currentSlideId: deck.slides[0].id,
      });
    },

    select: (ids) => {
      const { cropEditId } = get();
      if (cropEditId && !(ids.length === 1 && ids[0] === cropEditId)) get().exitCrop();
      set({ selection: ids, focusArea: 'canvas' });
    },

    startEditing: (id, caret = 'end', isNew = false) => {
      if (get().cropEditId) get().exitCrop();
      const st = get();
      if (st.editingId === id) return;
      const target = findSlide(st.deck, st.currentSlideId)?.elements.find((e) => e.id === id);
      if (target && isManagedText(target)) {
        flash((target as { role?: string }).role!.startsWith('subtitle') ? '부제 슬라이드 글자는 목차에서 고치면 자동으로 바뀝니다' : 'References는 인용에서 자동으로 만들어집니다');
        return;
      }
      if (st.editingId) st.stopEditing();
      // A template box still showing its initial text: select it all so typing replaces it.
      const el = findSlide(get().deck, get().currentSlideId)?.elements.find((e) => e.id === id);
      if (el?.type === 'text' && caret !== 'math' && isTemplatePlaceholder(plainText(el.doc))) caret = 'all';
      get().beginGesture();
      set({ editingId: id, editingIsNew: isNew, editCaret: caret, selection: [id], mathEdit: null, focusArea: 'canvas' });
    },
    startCellEditing: (id, row, col, caret = 'end') => {
      if (get().cropEditId) get().exitCrop();
      const st = get();
      if (st.editingId === id) {
        // Moving between cells of the table being edited: close the previous cell's undo step, open a new one.
        if (st.editCell?.row === row && st.editCell?.col === col) return;
        get().endGesture();
        get().beginGesture();
        set({ editCell: { row, col }, editCaret: caret });
        return;
      }
      if (st.editingId) st.stopEditing();
      get().beginGesture();
      set({ editingId: id, editingIsNew: false, editCaret: caret, editCell: { row, col }, selection: [id], mathEdit: null, focusArea: 'canvas' });
    },
    editTable: (id, fn, next) => {
      const editing = get().editingId === id;
      if (editing) get().endGesture(); // the structural change must be its own history step
      get().updateElements([id], (d) => fn(d as Draft<TableElement>));
      if (!editing) return;
      if (next) { get().beginGesture(); set({ editCell: next, editCaret: 'end' }); }
      else get().stopEditing();
    },
    stopEditing: () => {
      const { editingId, currentSlideId, editingIsNew, gestureBase } = get();
      if (!editingId) return;
      const slide = findSlide(get().deck, currentSlideId);
      const el = slide?.elements.find((e) => e.id === editingId);
      set({ editingId: null, editCell: null, mathEdit: null, editCaret: null });
      if (el && el.type === 'text' && !isDocEmpty(el.doc)) {
        const trimmed = trimTrailingEmpty(el.doc);
        if (trimmed !== el.doc) get().updateElements([el.id], (e) => { (e as any).doc = trimmed; }, true);
      }
      if (el && el.type === 'text' && isDocEmpty(el.doc) && el.role !== 'toc') {
        if (editingIsNew && gestureBase) {
          // A box that was created and left empty: leave no trace in history.
          set({ deck: gestureBase, gestureBase: null, selection: [] });
          return;
        }
        get().live((d) => {
          const s = findSlide(d as Deck, currentSlideId)!;
          s.elements = s.elements.filter((e) => e.id !== editingId);
        });
        set({ selection: [] });
      }
      if (el && el.type === 'shape' && el.doc && isDocEmpty(el.doc)) {
        // A shape left without text is exactly a shape without text again.
        get().updateElements([el.id], (e) => { delete (e as { doc?: unknown }).doc; }, true);
      }
      get().endGesture();
    },
    setMathEdit: (m) => set({ mathEdit: m }),
    enterCrop: (id) => {
      const st = get();
      if (st.cropEditId === id) return;
      if (st.editingId) st.stopEditing();
      if (st.cropEditId) st.exitCrop();
      get().beginGesture(); // the whole crop session is one undo step
      set({ cropEditId: id, selection: [id], focusArea: 'canvas' });
    },
    exitCrop: () => {
      if (!get().cropEditId) return;
      set({ cropEditId: null });
      get().endGesture();
    },

    addElements: (els, opts = {}) => {
      const { currentSlideId } = get();
      if (get().editingId) get().stopEditing();
      if (get().cropEditId) get().exitCrop();
      if (opts.edit) get().beginGesture();
      get().commit((d) => {
        findSlide(d as Deck, currentSlideId)!.elements.push(...(els as any));
      });
      set({ selection: els.map((e) => e.id), focusArea: 'canvas' });
      if (opts.edit && els[0]?.type === 'text') {
        set({ editingId: els[0].id, editingIsNew: true, editCaret: opts.caret ?? 'end', mathEdit: null });
      }
    },
    deleteSelection: () => {
      if (get().cropEditId) get().exitCrop();
      const { selection, currentSlideId } = get();
      if (!selection.length) return;
      const ids = new Set(selection);
      get().commit((d) => {
        const s = findSlide(d as Deck, currentSlideId)!;
        s.elements = s.elements.filter((e) => !ids.has(e.id));
      });
      set({ selection: [] });
    },
    updateElements: (ids, fn, isLive = false) => {
      const { currentSlideId } = get();
      const set_ = new Set(ids);
      (isLive ? get().live : get().commit)((d) => {
        const s = findSlide(d as Deck, currentSlideId);
        s?.elements.forEach((e) => set_.has(e.id) && fn(e));
      });
    },
    reorderSelection: (dir) => {
      const { selection, currentSlideId } = get();
      const ids = new Set(selection);
      if (!ids.size) return;
      get().commit((d) => {
        const s = findSlide(d as Deck, currentSlideId)!;
        const els = s.elements;
        const sel = els.filter((e) => ids.has(e.id));
        const rest = els.filter((e) => !ids.has(e.id));
        if (dir === 'front') s.elements = [...rest, ...sel];
        else if (dir === 'back') s.elements = [...sel, ...rest];
        else if (dir === 'forward') {
          for (let i = els.length - 2; i >= 0; i--)
            if (ids.has(els[i].id) && !ids.has(els[i + 1].id)) [els[i], els[i + 1]] = [els[i + 1], els[i]];
        } else {
          for (let i = 1; i < els.length; i++)
            if (ids.has(els[i].id) && !ids.has(els[i - 1].id)) [els[i], els[i - 1]] = [els[i - 1], els[i]];
        }
      });
    },

    goToSlide: (id) => {
      if (get().editingId) get().stopEditing();
      if (get().cropEditId) get().exitCrop();
      set({ currentSlideId: id, selection: [] });
    },
    addSlide: (afterId, slide) => {
      const s = slide ?? newContentSlide(); // every slide added after the first starts as a Content Slide
      const after = afterId ?? get().currentSlideId;
      if (get().editingId) get().stopEditing();
      if (get().cropEditId) get().exitCrop();
      get().commit((d) => {
        let i = d.slides.findIndex((x) => x.id === after) + 1;
        // New slides go before an automatic References slide / Thank You slide at the end.
        while (i > 0 && (d.slides[i - 1].kind === 'references' || d.slides[i - 1].kind === 'thanks')) i--;
        d.slides.splice(i, 0, s as any);
      });
      set({ currentSlideId: s.id, selection: [] });
    },
    duplicateSlide: (id) => {
      const src = findSlide(get().deck, id);
      if (!src) return;
      const copy: Slide = { ...structuredClone(plainSlideCopy(src)), id: uid() };
      copy.elements = copy.elements.map((e) => ({ ...e, id: uid() }));
      get().addSlide(id, copy);
    },
    deleteSlide: (id) => {
      const { deck } = get();
      if (get().editingId) get().stopEditing();
      const victim = findSlide(deck, id);
      if (victim?.kind === 'subtitle') { flash('부제 슬라이드는 목차에서 항목을 지우면 함께 지워집니다'); return; }
      if (victim?.kind === 'references' && referencesHaveContent(victim) && deck.slides.some((x) => x.id !== id && x.citations?.length)) {
        flash('References 슬라이드는 슬라이드의 인용을 모두 지우면 사라집니다'); return;
      }
      if (deck.slides.length <= 1) {
        // Never leave the deck empty: replace the last slide with a blank one.
        const { slide: s, titleId } = newTitleSlide(deck.title); // the deck's (new) first slide is a Title Slide
        get().commit((d) => { d.slides = [s as any]; d.titleElementId = titleId; });
        set({ currentSlideId: s.id, selection: [] });
        return;
      }
      const idx = deck.slides.findIndex((s) => s.id === id);
      get().commit((d) => { d.slides.splice(idx, 1); });
      const slides = get().deck.slides;
      set({ currentSlideId: slides[Math.min(idx, slides.length - 1)].id, selection: [] });
    },
    moveSlide: (from, to) => {
      if (from === to) return;
      get().commit((d) => {
        const [s] = d.slides.splice(from, 1);
        d.slides.splice(to, 0, s);
      });
    },

    // An additional Title Slide: the canonical template (newTitleSlide), inserted right after `afterId` / the current slide.
    addTitleSlide: (afterId) => get().addSlide(afterId, newTitleSlide().slide),
    addTocSlide: () => {
      const existing = get().deck.slides.find((x) => x.kind === 'toc');
      if (existing) { get().goToSlide(existing.id); return; }
      get().addSlide(undefined, newTocSlide());
    },
    addThanksSlide: () => {
      if (get().editingId) get().stopEditing();
      const s = newThanksSlide();
      get().commit((d) => { d.slides.push(s as any); });
      set({ currentSlideId: s.id, selection: [] });
    },

    addCitations: (slideId, cites) => {
      if (!cites.length) return;
      get().commit((d) => {
        const s = findSlide(d as Deck, slideId);
        if (!s) return;
        d.citations = d.citations ?? {};
        for (const c of cites) {
          const have = d.citations[c.id];
          if (!have || have.status === 'error') d.citations[c.id] = c as any;
          s.citations = s.citations ?? [];
          if (!s.citations.includes(c.id)) s.citations.push(c.id);
        }
      });
    },
    removeCitation: (slideId, citationId) => {
      get().commit((d) => {
        const s = findSlide(d as Deck, slideId);
        if (s?.citations) s.citations = s.citations.filter((x) => x !== citationId);
      });
    },
    applyCitation: (c) => {
      const patch = (deck: Deck): Deck => {
        if (!deck.citations?.[c.id]) return deck;
        return reconcileStructure(null, produce(deck, (d) => { d.citations![c.id] = c as any; }));
      };
      const st = get();
      set({
        deck: patch(st.deck),
        past: st.past.map(patch),
        future: st.future.map(patch),
        gestureBase: st.gestureBase ? patch(st.gestureBase) : null,
      });
    },

    addAsset: (a) => set({ assets: { ...get().assets, [a.id]: a } }),
  };
});

export const currentSlide = (st: AppState = useStore.getState()) => findSlide(st.deck, st.currentSlideId)!;
