import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import type { Asset, Deck, ID, Slide, SlideElement } from '../model/types';
import { initialDeck, newSlide, uid } from '../model/defaults';
import type { Guide } from '../model/geometry';
import { isDocEmpty, trimTrailingEmpty } from '../editor/docUtils';

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
  setMathEdit: (m: MathEditState | null) => void;

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

  addAsset: (a: Asset) => void;
}

const HISTORY_LIMIT = 200;

export function findSlide(deck: Deck, id: ID) {
  return deck.slides.find((s) => s.id === id);
}

export const useStore = create<AppState>()((set, get) => {
  const deck0 = initialDeck();

  /** Keeps current slide / selection valid after the deck changes underneath (undo, delete...). */
  const fixup = (deck: Deck, s: Partial<AppState> = {}): Partial<AppState> => {
    const st = { ...get(), ...s };
    let cur = st.currentSlideId;
    if (!deck.slides.some((x) => x.id === cur)) {
      const oldIdx = get().deck.slides.findIndex((x) => x.id === cur);
      cur = deck.slides[Math.max(0, Math.min(oldIdx, deck.slides.length - 1))].id;
    }
    const slide = findSlide(deck, cur)!;
    const ids = new Set(slide.elements.map((e) => e.id));
    return { ...s, deck, currentSlideId: cur, selection: st.selection.filter((i) => ids.has(i)) };
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
    focusArea: 'canvas',
    guides: [],
    exportMode: null,
    presenting: false,
    fileHandle: null,
    saveState: 'saved',

    commit: (fn) => {
      const { deck, past, gestureBase } = get();
      const next = produce(deck, fn);
      if (next === deck) return;
      if (gestureBase) set({ deck: next });
      else set({ deck: next, past: [...past, deck].slice(-HISTORY_LIMIT), future: [] });
    },
    live: (fn) => {
      const { deck } = get();
      const next = produce(deck, fn);
      if (next !== deck) set({ deck: next });
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
      const { past, future, deck } = get();
      if (!past.length) return;
      const prev = past[past.length - 1];
      set(fixup(prev, { past: past.slice(0, -1), future: [deck, ...future] }));
    },
    redo: () => {
      if (get().editingId) get().stopEditing();
      const { past, future, deck } = get();
      if (!future.length) return;
      set(fixup(future[0], { past: [...past, deck], future: future.slice(1) }));
    },
    loadDeck: (deck, assets) => {
      set({
        deck, assets, past: [], future: [], gestureBase: null, selection: [], editingId: null, mathEdit: null,
        currentSlideId: deck.slides[0].id,
      });
    },

    select: (ids) => set({ selection: ids, focusArea: 'canvas' }),

    startEditing: (id, caret = 'end', isNew = false) => {
      const st = get();
      if (st.editingId === id) return;
      if (st.editingId) st.stopEditing();
      get().beginGesture();
      set({ editingId: id, editingIsNew: isNew, editCaret: caret, selection: [id], mathEdit: null, focusArea: 'canvas' });
    },
    stopEditing: () => {
      const { editingId, currentSlideId, editingIsNew, gestureBase } = get();
      if (!editingId) return;
      const slide = findSlide(get().deck, currentSlideId);
      const el = slide?.elements.find((e) => e.id === editingId);
      set({ editingId: null, mathEdit: null, editCaret: null });
      if (el && el.type === 'text' && !isDocEmpty(el.doc)) {
        const trimmed = trimTrailingEmpty(el.doc);
        if (trimmed !== el.doc) get().updateElements([el.id], (e) => { (e as any).doc = trimmed; }, true);
      }
      if (el && el.type === 'text' && isDocEmpty(el.doc)) {
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
      get().endGesture();
    },
    setMathEdit: (m) => set({ mathEdit: m }),

    addElements: (els, opts = {}) => {
      const { currentSlideId } = get();
      if (get().editingId) get().stopEditing();
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
      set({ currentSlideId: id, selection: [] });
    },
    addSlide: (afterId, slide) => {
      const s = slide ?? newSlide();
      const after = afterId ?? get().currentSlideId;
      if (get().editingId) get().stopEditing();
      get().commit((d) => {
        const i = d.slides.findIndex((x) => x.id === after);
        d.slides.splice(i + 1, 0, s as any);
      });
      set({ currentSlideId: s.id, selection: [] });
    },
    duplicateSlide: (id) => {
      const src = findSlide(get().deck, id);
      if (!src) return;
      const copy: Slide = { ...structuredClone(src), id: uid() };
      copy.elements = copy.elements.map((e) => ({ ...e, id: uid() }));
      get().addSlide(id, copy);
    },
    deleteSlide: (id) => {
      const { deck } = get();
      if (get().editingId) get().stopEditing();
      if (deck.slides.length <= 1) {
        // Never leave the deck empty: replace the last slide with a blank one.
        const s = newSlide();
        get().commit((d) => { d.slides = [s as any]; });
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

    addAsset: (a) => set({ assets: { ...get().assets, [a.id]: a } }),
  };
});

export const currentSlide = (st: AppState = useStore.getState()) => findSlide(st.deck, st.currentSlideId)!;
