import { get, set, del, keys } from 'idb-keyval';
import type { Asset, Deck } from '../model/types';
import { DEFAULT_TITLE, initialDeck, isTemplatePlaceholder } from '../model/defaults';
import { plainText } from '../editor/docUtils';
import { useStore } from './store';

// Autosave: the deck JSON and each image asset are stored separately in IndexedDB,
// so typing doesn't re-serialize megabytes of image data.
const DECK_KEY = 'deck:v1';
const assetKey = (id: string) => `asset:${id}`;

export function saveAsset(a: Asset) {
  set(assetKey(a.id), a).catch((e) => console.error('asset save failed', e));
}

function referencedAssetIds(deck: Deck) {
  const ids = new Set<string>();
  deck.slides.forEach((s) => s.elements.forEach((e) => e.type === 'image' && ids.add(e.assetId)));
  return ids;
}

/**
 * App startup = a new presentation (like PowerPoint/Canva). The presentation from the last session
 * (still in the autosave slot) is moved to "이전 프레젠테이션" first, so nothing is lost;
 * only then is the slot taken over by the fresh deck.
 */
export async function startNewSession() {
  try {
    const last = (await get(DECK_KEY)) as Deck | undefined;
    if (last?.slides?.length) await archiveDeck(last);
    await set(DECK_KEY, useStore.getState().deck);
  } catch (e) {
    console.error('startup archive failed', e);
  }
}

let timer: number | undefined;
export function startAutosave() {
  useStore.subscribe((s, prev) => {
    if (s.deck === prev.deck) return;
    if (s.saveState !== 'dirty') useStore.setState({ saveState: 'dirty' });
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      useStore.setState({ saveState: 'saving' });
      await set(DECK_KEY, useStore.getState().deck);
      useStore.setState({ saveState: 'saved' });
    }, 500);
  });
  // Garbage-collect assets no longer referenced by the deck (or by undo history) once per session.
  setTimeout(async () => {
    const st = useStore.getState();
    const used = referencedAssetIds(st.deck);
    [...st.past, ...st.future].forEach((d) => referencedAssetIds(d).forEach((i) => used.add(i)));
    (await loadArchive()).forEach((a) => referencedAssetIds(a.deck).forEach((i) => used.add(i)));
    for (const k of await keys()) {
      const key = String(k);
      if (key.startsWith('asset:') && !used.has(key.slice(6))) await del(key);
    }
  }, 60_000);
}

// ---------- project files (.mslides) ----------

interface ProjectFile {
  format: 'mathslides';
  version: 1;
  deck: Deck;
  assets: Record<string, Asset>;
}

const FILE_TYPES = [{ description: 'MathSlides presentation', accept: { 'application/json': ['.mslides'] } }];

function projectJson(): string {
  const { deck, assets } = useStore.getState();
  const used = referencedAssetIds(deck);
  const file: ProjectFile = {
    format: 'mathslides', version: 1, deck,
    assets: Object.fromEntries(Object.entries(assets).filter(([id]) => used.has(id))),
  };
  return JSON.stringify(file);
}

/** Default export/save file name from the project title, made valid on macOS and Windows. */
export function safeName(title: string): string {
  const name = title
    .replace(/\s*:\s*/g, ' - ')          // "RLHF: From PPO" → "RLHF - From PPO"
    .replace(/[\\/]+/g, '-')
    .replace(/[*?"<>|\u0000-\u001f]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')      // no leading/trailing dots or spaces
    .slice(0, 180);
  return name || 'presentation';
}

/** Save a Blob: native "Save As" dialog when available, otherwise a download. */
export async function saveBlob(blob: Blob, suggestedName: string, types?: any[]): Promise<boolean> {
  const w = window as any;
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({ suggestedName, types });
      const ws = await h.createWritable();
      await ws.write(blob);
      await ws.close();
      return true;
    } catch (e: any) {
      if (e?.name === 'AbortError') return false;
      console.warn('showSaveFilePicker failed, falling back to download', e);
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return true;
}

export async function saveProject(saveAs = false) {
  const st = useStore.getState();
  const blob = new Blob([projectJson()], { type: 'application/json' });
  const w = window as any;
  if (st.fileHandle && !saveAs) {
    try {
      const ws = await st.fileHandle.createWritable();
      await ws.write(blob);
      await ws.close();
      flash('저장됨 — ' + st.fileHandle.name);
      return;
    } catch (e) {
      console.warn('write to handle failed', e);
    }
  }
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({ suggestedName: safeName(st.deck.title) + '.mslides', types: FILE_TYPES });
      const ws = await h.createWritable();
      await ws.write(blob);
      await ws.close();
      useStore.setState({ fileHandle: h });
      flash('저장됨 — ' + h.name);
      return;
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
    }
  }
  await saveBlob(blob, safeName(st.deck.title) + '.mslides');
}

export async function openProject() {
  const w = window as any;
  let file: File | null = null;
  let handle: any = null;
  if (w.showOpenFilePicker) {
    try {
      [handle] = await w.showOpenFilePicker({ types: FILE_TYPES });
      file = await handle.getFile();
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
    }
  }
  if (!file) {
    file = await new Promise<File | null>((res) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.mslides,application/json';
      input.onchange = () => res(input.files?.[0] ?? null);
      input.click();
    });
  }
  if (!file) return;
  try {
    const data = JSON.parse(await file.text()) as ProjectFile;
    if (data.format !== 'mathslides' || !data.deck?.slides?.length) throw new Error('not a MathSlides file');
    Object.values(data.assets ?? {}).forEach(saveAsset);
    useStore.getState().loadDeck(data.deck, data.assets ?? {});
    useStore.setState({ fileHandle: handle });
  } catch (e) {
    alert('파일을 열 수 없습니다: ' + (e as Error).message);
  }
}

// ---------- new presentation vs. restoring an existing one ----------
// Startup and "새 프레젠테이션" both start a fresh deck. The presentation being replaced is moved
// to the archive of previous presentations (IndexedDB, images included), reopened from the ∑ menu.

const ARCHIVE_KEY = 'archive:v1';

export interface ArchivedPresentation {
  id: string;
  savedAt: number;
  deck: Deck;
}

export async function loadArchive(): Promise<ArchivedPresentation[]> {
  return ((await get(ARCHIVE_KEY)) as ArchivedPresentation[] | undefined) ?? [];
}

/** An untouched new presentation (only template text, no references) isn't worth archiving. */
function isPristine(deck: Deck): boolean {
  return deck.slides.length === 1 && deck.title === DEFAULT_TITLE && !deck.slides[0].reference?.trim()
    && !deck.slides[0].notes.trim()
    && deck.slides[0].elements.every((e) => e.type === 'text' && isTemplatePlaceholder(plainText(e.doc)));
}

/**
 * Put a presentation into the archive. Its entry is replaced if it is already there (same deck id),
 * so relaunching or re-archiving never creates duplicates. Untouched template decks are skipped.
 * Entries are never dropped automatically.
 */
async function archiveDeck(deck: Deck) {
  if (isPristine(deck)) return;
  const d: Deck = deck.id ? deck : { ...deck, id: crypto.randomUUID() };
  const rest = (await loadArchive()).filter((a) => a.deck.id !== d.id);
  await set(ARCHIVE_KEY, [{ id: crypto.randomUUID(), savedAt: Date.now(), deck: d }, ...rest]);
}

async function archiveCurrent() {
  const st = useStore.getState();
  st.stopEditing();
  st.exitCrop();
  // Make sure the archived deck's images are persisted (they normally already are).
  referencedAssetIds(st.deck).forEach((id) => st.assets[id] && saveAsset(st.assets[id]));
  await archiveDeck(useStore.getState().deck);
}

/** Create a genuinely fresh presentation: one Title Slide, default title, empty history. */
export async function newProject() {
  await archiveCurrent();
  useStore.getState().loadDeck(initialDeck(), {});
  useStore.setState({ fileHandle: null });
  flash('새 프레젠테이션 — 이전 프레젠테이션은 ∑ 메뉴에서 다시 열 수 있습니다');
}

/** Reopen an archived presentation; the current one is archived in its place (nothing is lost). */
export async function restoreArchived(id: string) {
  const entry = (await loadArchive()).find((a) => a.id === id);
  if (!entry) return;
  await archiveCurrent();
  await set(ARCHIVE_KEY, (await loadArchive()).filter((a) => a.id !== id));
  const assets: Record<string, Asset> = {};
  await Promise.all([...referencedAssetIds(entry.deck)].map(async (aid) => {
    const a = (await get(assetKey(aid))) as Asset | undefined;
    if (a) assets[aid] = a;
  }));
  useStore.getState().loadDeck(entry.deck, assets);
  useStore.setState({ fileHandle: null });
}

// ---------- tiny toast ----------
export function flash(msg: string) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 1600);
  setTimeout(() => el.remove(), 2100);
}
