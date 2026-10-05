import type { Asset, ImageElement, ShapeKind, SlideElement, TextElement } from '../model/types';
import { SLIDE_H, SLIDE_W } from '../model/types';
import { newLine, newShape, newText, uid } from '../model/defaults';
import { currentSlide, useStore } from '../store/store';
import { saveAsset } from '../store/persistence';
import { textToDoc } from '../editor/docUtils';

const IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif|svg\+xml|bmp|avif)$/;

function readDataUrl(file: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res({ width: img.naturalWidth || 800, height: img.naturalHeight || 600 });
    img.onerror = () => res({ width: 800, height: 600 });
    img.src = src;
  });
}

export async function fileToAsset(file: File): Promise<Asset> {
  const dataUrl = await readDataUrl(file);
  const { width, height } = await imageSize(dataUrl);
  const asset: Asset = { id: uid(), mime: file.type, dataUrl, width, height };
  useStore.getState().addAsset(asset);
  saveAsset(asset);
  return asset;
}

export const isImageFile = (f: File) => IMAGE_TYPES.test(f.type);

/** Insert image files. Each image is fit into 70% of the slide (never upscaled past its pixel size / 1). */
export async function insertImageFiles(files: File[], at?: { x: number; y: number }) {
  const imgs = files.filter(isImageFile);
  if (!imgs.length) return;
  const els: ImageElement[] = [];
  let k = 0;
  for (const f of imgs) {
    const a = await fileToAsset(f);
    const maxW = SLIDE_W * 0.7, maxH = SLIDE_H * 0.7;
    const s = Math.min(1, maxW / a.width, maxH / a.height);
    const w = Math.round(a.width * s), h = Math.round(a.height * s);
    const cx = (at?.x ?? SLIDE_W / 2) + k * 24, cy = (at?.y ?? SLIDE_H / 2) + k * 24;
    els.push({ id: uid(), type: 'image', assetId: a.id, w, h, x: Math.round(cx - w / 2), y: Math.round(cy - h / 2) });
    k++;
  }
  useStore.getState().addElements(els);
}

export function pickImages() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';
  input.multiple = true;
  input.onchange = () => insertImageFiles(Array.from(input.files ?? []));
  input.click();
}

/** New text box; the click point is where the first line's text begins. */
export function insertTextAt(x: number, y: number) {
  const el = newText(0, 0);
  el.x = Math.round(Math.min(Math.max(0, x - 2), SLIDE_W - 120));
  el.y = Math.round(Math.max(0, y - (el.style.fontSize * el.style.lineHeight) / 2));
  el.w = Math.min(el.w, SLIDE_W - el.x - 24);
  useStore.getState().addElements([el], { edit: true });
}

export function insertTextCenter() {
  const el = newText(SLIDE_W / 2 - 240, SLIDE_H / 2 - 20);
  useStore.getState().addElements([el], { edit: true });
}

/** A text box containing only a block equation, with the LaTeX popover open. */
export function insertMathBox() {
  const el: TextElement = newText(SLIDE_W / 2 - 300, SLIDE_H / 2 - 30, {
    w: 600,
    doc: { type: 'doc', content: [{ type: 'mathBlock', attrs: { latex: '' } }] },
    style: { align: 'center' },
  });
  useStore.getState().addElements([el], { edit: true, caret: 'math' });
}

export function insertShape(kind: ShapeKind) {
  const el = newShape(kind, SLIDE_W / 2 - 120, SLIDE_H / 2 - 80);
  if (kind === 'ellipse') { el.w = 180; el.h = 180; el.x = SLIDE_W / 2 - 90; el.y = SLIDE_H / 2 - 90; }
  useStore.getState().addElements([el]);
}

export function insertLine(arrow: boolean) {
  useStore.getState().addElements([newLine(SLIDE_W / 2 - 120, SLIDE_H / 2, SLIDE_W / 2 + 120, SLIDE_H / 2, arrow)]);
}

export function insertPlainText(text: string) {
  const el = newText(SLIDE_W / 2 - 300, SLIDE_H / 2 - 40, { w: 600, doc: textToDoc(text) });
  useStore.getState().addElements([el]);
}

// ---------- element clipboard ----------

export const CLIP_MIME = 'application/x-mathslides';
let internalClip: Clip | null = null;

type Clip = { elements: SlideElement[]; assets: Asset[] };

function selectionClip(): Clip | null {
  const st = useStore.getState();
  const ids = new Set(st.selection);
  const elements = currentSlide().elements.filter((e) => ids.has(e.id));
  if (!elements.length) return null;
  const assets = elements.flatMap((e) => (e.type === 'image' && st.assets[e.assetId] ? [st.assets[e.assetId]] : []));
  return { elements, assets };
}

/** Copies the selection to the internal clipboard and returns it serialized (for the system clipboard). */
export function copySelection(): string | null {
  const c = selectionClip();
  if (!c) return null;
  internalClip = c;
  return JSON.stringify(c);
}

function pasteClip(clip: Clip) {
  const st = useStore.getState();
  for (const a of clip.assets ?? []) { if (!st.assets[a.id]) st.addAsset(a); saveAsset(a); }
  const existing = currentSlide().elements;
  let off = 0;
  while (clip.elements.some((c) => existing.some((e) => e.type === c.type && e.x === c.x + off && e.y === c.y + off))) off += 20;
  const els = clip.elements.map((e) => {
    const c = structuredClone(e) as SlideElement;
    c.id = uid();
    c.x += off; c.y += off;
    if (c.type === 'line') { c.x1 += off; c.y1 += off; c.x2 += off; c.y2 += off; }
    return c;
  });
  st.addElements(els);
}

/** Paste elements from serialized clipboard data, or from the internal clipboard. */
export function pasteElements(json?: string | null): boolean {
  let clip = internalClip;
  if (json) {
    try { clip = JSON.parse(json); } catch { /* fall back to internal */ }
  }
  if (!clip?.elements?.length) return false;
  pasteClip(clip);
  return true;
}

export function duplicateSelection() {
  const c = selectionClip();
  if (c) pasteClip(c);
}
