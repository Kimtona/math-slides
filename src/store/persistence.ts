import { get, set, del, keys } from 'idb-keyval';
import type { Asset, Deck } from '../model/types';
import { initialDeck } from '../model/defaults';
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

export async function loadAutosave() {
  try {
    const deck = (await get(DECK_KEY)) as Deck | undefined;
    if (!deck?.slides?.length) return;
    const assets: Record<string, Asset> = {};
    await Promise.all([...referencedAssetIds(deck)].map(async (id) => {
      const a = (await get(assetKey(id))) as Asset | undefined;
      if (a) assets[id] = a;
    }));
    useStore.getState().loadDeck(deck, assets);
  } catch (e) {
    console.error('autosave load failed', e);
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

export const safeName = (t: string) => (t.trim() || 'presentation').replace(/[\\/:*?"<>|]+/g, '_');

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

export function newProject() {
  if (!confirm('새 프레젠테이션을 만들까요? 현재 내용은 자동 저장본에서 사라집니다 (먼저 ⌘S로 파일 저장 권장).')) return;
  const deck = initialDeck();
  useStore.getState().loadDeck(deck, {});
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
