/** Renderer side of the Sketch-to-Slides AI bridge (Electron preload `window.native.sketch`). */
import type { Asset, ImageElement } from '../model/types';
import { cropOf } from '../model/imageCrop';

export interface SketchImage { base64: string; mime: string; width: number; height: number }
export interface SketchStatus { keySource: 'env' | 'stored' | 'fake' | null; canStore: boolean; model: string; logging: boolean }
export interface AIResult<T> { ok: boolean; data?: T; error?: string; code?: string; model?: string; ms?: number; usage?: Record<string, unknown> }

interface SketchNative {
  status(): Promise<SketchStatus>;
  setKey(key: string | null): Promise<{ ok: boolean; error?: string }>;
  recognize(req: { runId: string; image: SketchImage; schema: object }): Promise<AIResult<unknown>>;
  review(req: { runId: string; round: number; original: SketchImage; rendering: SketchImage; ir: object; issues: string[]; schema: object }): Promise<AIResult<unknown>>;
  capture(rect: { x: number; y: number; width: number; height: number }): Promise<SketchImage | null>;
  log(runId: string, name: string, data: unknown): Promise<boolean>;
}

/** Null outside the desktop app (browser dev mode): the feature is then unavailable. */
export const sketchNative = (): SketchNative | null => (window as any).native?.sketch ?? null;

/** Longest edge sent to the model. Larger photos only cost tokens; coordinates are normalized anyway. */
export const MAX_EDGE = 1600;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not load the image.'));
    img.src = src;
  });
}

/** The visible (cropped) part of an image element as a PNG, downscaled to MAX_EDGE. */
export async function imageForModel(el: ImageElement, asset: Asset): Promise<SketchImage & { dataUrl: string }> {
  const img = await loadImage(asset.dataUrl);
  const c = cropOf(el);
  const sw = img.naturalWidth * c.w, sh = img.naturalHeight * c.h;
  const k = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; // transparent PNG areas (GoodNotes exports) read as paper, not black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, img.naturalWidth * c.x, img.naturalHeight * c.y, sw, sh, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/png');
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mime: 'image/png', width: w, height: h, dataUrl };
}

export const newRunId = () => new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19) + '-' + Math.random().toString(36).slice(2, 6);
