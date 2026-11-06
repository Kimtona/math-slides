/** Renderer side of the Sketch-to-Slides AI bridge (Electron preload `window.native.sketch`). */
import type { Asset, ImageElement } from '../model/types';
import { cropOf } from '../model/imageCrop';

export interface SketchImage { base64: string; mime: string; width: number; height: number }
export type SketchProvider = 'ollama' | 'anthropic' | 'fake';
export interface SketchStatus {
  provider: SketchProvider;
  /** The provider can run now (Ollama reachable with the model installed, or a Claude key configured). */
  ready: boolean;
  keySource: 'env' | 'stored' | 'fake' | null;
  canStore: boolean;
  model: string;
  ollama: { host: string; model: string; running: boolean; models: string[] };
  /** Preferred image size: total pixel area (local model) or longest edge. */
  image: { pixels?: number; maxEdge?: number };
  envLocked: { provider: boolean; ollamaModel: boolean; ollamaHost: boolean };
  logging: boolean;
}
export interface SketchSettings { provider?: 'ollama' | 'anthropic'; ollamaModel?: string; ollamaHost?: string }
export interface AIResult<T> { ok: boolean; data?: T; error?: string; code?: string; model?: string; ms?: number; usage?: Record<string, unknown>; layout?: 'document' }

interface SketchNative {
  status(): Promise<SketchStatus>;
  setKey(key: string | null): Promise<{ ok: boolean; error?: string }>;
  setSettings(s: SketchSettings): Promise<{ ok: boolean; error?: string }>;
  recognize(req: { runId: string; image: SketchImage; schema: object; mode?: 'document' | 'layout' }): Promise<AIResult<unknown>>;
  review(req: { runId: string; round: number; original: SketchImage; rendering: SketchImage; ir: object; issues: string[]; schema: object }): Promise<AIResult<unknown>>;
  capture(rect: { x: number; y: number; width: number; height: number }): Promise<SketchImage | null>;
  log(runId: string, name: string, data: unknown): Promise<boolean>;
}

/** Null outside the desktop app (browser dev mode): the feature is then unavailable. */
export const sketchNative = (): SketchNative | null => (window as any).native?.sketch ?? null;

/** Default longest edge sent to a hosted model. Larger photos only cost tokens; coordinates are normalized anyway. */
export const MAX_EDGE = 1600;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not load the image.'));
    img.src = src;
  });
}

/**
 * The visible (cropped) part of an image element as a PNG. size.pixels: scaled (up or down) to that pixel area — the
 * local model's coordinates then refer to the image we sent; size.maxEdge: only downscaled to that longest edge.
 */
export async function imageForModel(el: ImageElement, asset: Asset, size: SketchStatus['image'] = { maxEdge: MAX_EDGE }): Promise<SketchImage & { dataUrl: string }> {
  const img = await loadImage(asset.dataUrl);
  const c = cropOf(el);
  const sw = img.naturalWidth * c.w, sh = img.naturalHeight * c.h;
  const k = size.pixels ? Math.sqrt(size.pixels / (sw * sh)) : Math.min(1, (size.maxEdge ?? MAX_EDGE) / Math.max(sw, sh));
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

/** RGBA pixels of an image (for measurements on the exact image the model saw). */
export async function rasterOf(dataUrl: string): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: d.data, width: d.width, height: d.height };
}

export const newRunId = () => new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19) + '-' + Math.random().toString(36).slice(2, 6);
