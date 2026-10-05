import { get, set, del, keys } from 'idb-keyval';
import type { Asset, Deck } from '../model/types';
import { initialDeck, uid } from '../model/defaults';
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

const FILE_KEY = 'file:v1';

function isValidDeck(d: unknown): d is Deck {
  const x = d as Deck | undefined;
  return !!x && Array.isArray(x.slides) && x.slides.length > 0 && x.slides.every((sl) => !!sl && typeof sl.id === 'string' && Array.isArray(sl.elements));
}

async function loadAssetsFor(deck: Deck): Promise<Record<string, Asset>> {
  const assets: Record<string, Asset> = {};
  await Promise.all([...referencedAssetIds(deck)].map(async (id) => {
    const a = (await get(assetKey(id))) as Asset | undefined;
    if (a) assets[id] = a;
  }));
  return assets;
}

/**
 * App/renderer startup restores the working presentation from the internal autosave slot — same
 * Deck.id, nothing archived, no new Untitled presentation. Only when there is nothing valid to restore
 * does the fresh deck (created with the store) become the working presentation. The explicit .mslides
 * association (a persisted file handle) is restored when it belongs to the same Deck.id.
 * An unreadable autosave record is kept under a separate key, never discarded.
 */
export async function startSession() {
  try {
    const last = await get(DECK_KEY);
    if (isValidDeck(last)) {
      const deck: Deck = last.id ? last : { ...last, id: uid() };
      useStore.getState().loadDeck(deck, await loadAssetsFor(deck));
      const assoc = (await get(FILE_KEY)) as { handle?: any; nativePath?: string; name?: string; deckId?: string } | undefined;
      if (assoc && assoc.deckId === deck.id) {
        if (assoc.handle) useStore.setState({ fileHandle: assoc.handle });
        else if (assoc.nativePath && window.native?.writeFile) useStore.setState({ fileHandle: nativeFileHandle(assoc.nativePath, assoc.name ?? 'presentation.mslides') });
      }
      return;
    }
    if (last !== undefined) await set(`deck:unreadable:${Date.now()}`, last);
    await set(DECK_KEY, useStore.getState().deck);
  } catch (e) {
    console.error('startup restore failed', e);
  }
}

/**
 * A .mslides file that the operating system asked us to open (Finder, "Open With", argv): there is no File System
 * Access handle for it, so this stand-in offers the same createWritable() interface; writing goes through the
 * Electron main process, which only accepts paths that were opened that way.
 */
export function nativeFileHandle(path: string, name: string) {
  return {
    kind: 'native', name, nativePath: path,
    async createWritable() {
      const parts: string[] = [];
      return {
        write: async (data: Blob | string) => { parts.push(typeof data === 'string' ? data : await data.text()); },
        close: async () => {
          const r = await window.native?.writeFile?.(path, parts.join(''));
          if (!r?.ok) throw new Error(r?.error ?? 'native write failed');
        },
      };
    },
  };
}

/** Remember which .mslides file the current presentation belongs to (a File System Access handle, or an OS path). */
async function rememberFile(handle: any, deckId: string | undefined) {
  try {
    if (!handle || !deckId) return void (await del(FILE_KEY));
    if (handle.nativePath) return void (await set(FILE_KEY, { nativePath: handle.nativePath, name: handle.name, deckId }));
    await set(FILE_KEY, { handle, name: handle.name, deckId });
  } catch (e) {
    // Not every handle can be stored (e.g. non-native stand-ins); the in-memory association still works.
    console.warn('file handle not persisted', e);
    await del(FILE_KEY).catch(() => {});
  }
}

/** Immediate internal save of the working deck (crash safety at lifecycle switches). */
const saveWorking = () => set(DECK_KEY, useStore.getState().deck);

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
  // A reload/quit right after an edit must not lose it to the debounce.
  window.addEventListener('pagehide', () => { clearTimeout(timer); void saveWorking(); });
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

function projectJson(deckId?: string): string {
  const { assets } = useStore.getState();
  const deck = deckId ? { ...useStore.getState().deck, id: deckId } : useStore.getState().deck;
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

/** Write permission of a (possibly restored) handle; stand-ins without the permission API count as granted. */
async function ensureWritable(handle: any) {
  if (typeof handle.queryPermission !== 'function') return;
  let p = await handle.queryPermission({ mode: 'readwrite' });
  if (p !== 'granted' && typeof handle.requestPermission === 'function') p = await handle.requestPermission({ mode: 'readwrite' });
  if (p !== 'granted') throw new Error('write permission ' + p);
}

/** Give the current presentation a new identity (Save As): live deck, undo snapshots and the working slot. */
function adoptIdentity(newId: string) {
  useStore.setState((s) => ({
    deck: { ...s.deck, id: newId },
    past: s.past.map((d) => ({ ...d, id: newId })),
    future: s.future.map((d) => ({ ...d, id: newId })),
    gestureBase: s.gestureBase ? { ...s.gestureBase, id: newId } : null,
  }));
}

/**
 * Save writes the current .mslides file (picker only when there is none, or it can't be written);
 * Save As always asks for a file and makes the result an independent presentation with a NEW Deck.id
 * (the original file is not touched). Autosave never writes these files.
 */
export async function saveProject(saveAs = false) {
  const st = useStore.getState();
  const w = window as any;
  if (st.fileHandle && !saveAs) {
    try {
      await ensureWritable(st.fileHandle);
      const ws = await st.fileHandle.createWritable();
      await ws.write(new Blob([projectJson()], { type: 'application/json' }));
      await ws.close();
      flash('저장됨 — ' + st.fileHandle.name);
      return;
    } catch (e) {
      console.warn('write to handle failed, asking for a file', e);
    }
  }
  const newId = saveAs ? uid() : undefined;
  const blob = new Blob([projectJson(newId)], { type: 'application/json' });
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({ suggestedName: safeName(st.deck.title) + '.mslides', types: FILE_TYPES });
      const ws = await h.createWritable();
      await ws.write(blob);
      await ws.close();
      if (newId) adoptIdentity(newId);
      useStore.setState({ fileHandle: h });
      await rememberFile(h, useStore.getState().deck.id);
      await saveWorking();
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
    await openFromText(await file.text(), handle);
  } catch (e) {
    alert('파일을 열 수 없습니다: ' + (e as Error).message);
  }
}

/**
 * The one Open path (in-app 열기… and files opened by the OS): validates the file, archives meaningful current work,
 * keeps the file's Deck.id, and makes the file the current one. Throws on an invalid file (nothing is changed then).
 */
export async function openFromText(text: string, handle: any) {
  const data = JSON.parse(text) as ProjectFile;
  if (data?.format !== 'mathslides' || !isValidDeck(data.deck)) throw new Error('not a MathSlides file');
  // Never replace meaningful unsaved work silently: it goes to the archive first (same-id entries are updated).
  await archiveCurrent();
  const deck: Deck = data.deck.id ? data.deck : { ...data.deck, id: uid() }; // keep the file's identity
  Object.values(data.assets ?? {}).forEach(saveAsset);
  useStore.getState().loadDeck(deck, data.assets ?? {});
  useStore.setState({ fileHandle: handle });
  await rememberFile(handle, deck.id);
  await saveWorking();
}

/** A request from the OS (see electron/main.cjs): same lifecycle as 열기…, errors become a toast. Requests are handled one at a time. */
let nativeOpenChain: Promise<void> = Promise.resolve();
export function openNativeFile(file: { path?: string; name?: string; text?: string; error?: string }) {
  nativeOpenChain = nativeOpenChain.then(async () => {
    try {
      if (file.error || typeof file.text !== 'string' || !file.path) throw new Error(file.error ?? 'unreadable file');
      await openFromText(file.text, nativeFileHandle(file.path, file.name ?? 'presentation.mslides'));
    } catch (e) {
      flash(`${file.name ?? '파일'}을(를) 열 수 없습니다: ${(e as Error).message}`);
    }
  });
  return nativeOpenChain;
}

/** Start listening for OS open requests and process those queued before the renderer was ready. */
export async function startNativeOpen() {
  const n = window.native;
  if (!n?.openReady || !n.onOpenFile) return;
  n.onOpenFile((f) => void openNativeFile(f));
  for (const f of await n.openReady()) await openNativeFile(f);
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

/**
 * Comparable form of a deck: everything that is real user state (title, theme, slides, backgrounds,
 * notes, references, citations, sections, element data), without ids, measured text heights and the
 * exact TipTap JSON of text (compared as plain text).
 */
function normalized(d: Deck): string {
  const some = <T extends object | undefined>(v: T) => (v && (Array.isArray(v) ? v.length : Object.keys(v).length) ? v : undefined);
  return JSON.stringify({
    title: d.title, themeColor: d.themeColor, sections: some(d.sections), citations: some(d.citations),
    slides: d.slides.map((s) => ({
      background: s.background, notes: s.notes, reference: s.reference || '', kind: s.kind, citations: some(s.citations),
      elements: s.elements.map((e) => (e.type === 'text' ? { ...e, id: undefined, h: undefined, doc: plainText(e.doc) } : { ...e, id: undefined })),
    })),
  });
}
let freshSignature: string | undefined;

/** A presentation equal to a brand-new default one (untouched) isn't worth archiving. */
export function isPristine(deck: Deck): boolean {
  return normalized(deck) === (freshSignature ??= normalized(initialDeck()));
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
  useStore.getState().loadDeck(initialDeck(), {}); // fresh unique Deck.id, no file association
  useStore.setState({ fileHandle: null });
  await rememberFile(null, undefined);
  await saveWorking();
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
  await rememberFile(null, undefined);
  await saveWorking();
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
