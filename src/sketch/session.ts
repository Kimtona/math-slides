/**
 * Sketch-to-Slides conversion session: recognize → IR → convert → validate → (AI review → patch)×≤2 → preview → apply.
 * Holds the dialog state; the dialog (src/ui/SketchDialog.tsx) renders it and supplies the preview screenshot.
 */
import { create } from 'zustand';
import type { ImageElement, SlideElement } from '../model/types';
import { findSlide, useStore } from '../store/store';
import { newSlide } from '../model/defaults';
import { applyPatches, MODEL_IR_SCHEMA, parseIR, REVIEW_SCHEMA, type IRElement, type IRIssue, type ReviewResult, type SketchIR } from './ir';
import { irToElements, type ConversionResult, type Frame } from './convert';
import { buildDocumentElements, reflowDocument } from './document';
import { validateSketch, type ValidationReport } from './validate';
import { applyInkMeasurements } from './ink';
import { imageForModel, newRunId, rasterOf, sketchNative, type SketchImage, type SketchSettings, type SketchStatus } from './bridge';

export const MAX_REVIEW_ROUNDS = 2;

export interface ReviewRound {
  round: number;
  ok: boolean;
  summary: string;
  patches: ReviewResult['patches'];
  /** Validation counts before and after this round's patches. */
  before: ValidationReport['counts'];
  after?: ValidationReport['counts'];
  ms: number;
  error?: string;
  /** Not run (local model and nothing for it to fix). */
  skipped?: boolean;
}

/** Document Mode (Markdown transcription, placed top to bottom; default) or Layout Mode (coordinates, keeps the drawn positions). */
export type SketchMode = 'document' | 'layout';
export type Phase = 'idle' | 'settings' | 'recognizing' | 'reviewing' | 'preview' | 'error';

interface SketchState {
  phase: Phase;
  /** performance.now() when the current run started (for the elapsed-time display). */
  startedAt: number;
  status: SketchStatus | null;
  sourceId: string | null;
  runId: string;
  image: (SketchImage & { dataUrl: string }) | null;
  ir: SketchIR | null;
  parseIssues: IRIssue[];
  conv: ConversionResult | null;
  report: ValidationReport | null;
  rounds: ReviewRound[];
  timings: Record<string, number>;
  model: string;
  error: string | null;
  aiReview: boolean;
  mode: SketchMode;
  /** The source image's frame on the slide and the slide's other elements, captured when the run starts. */
  frame: Frame | null;
  others: SlideElement[];
  /** Set by the dialog: renders the current conversion, waits for layout, returns text heights + a screenshot. */
  measure: (() => Promise<{ heights: Record<string, number>; shot: SketchImage | null }>) | null;
}

export const useSketch = create<SketchState>()(() => ({
  phase: 'idle', startedAt: 0, status: null, sourceId: null, runId: '', image: null, ir: null, parseIssues: [], conv: null, report: null,
  rounds: [], timings: {}, model: '', error: null, aiReview: true, mode: 'document', measure: null, frame: null, others: [],
}));
const set = useSketch.setState;
const get = useSketch.getState;

export const sketchAvailable = () => sketchNative() !== null;

const issueLines = (r: ValidationReport) => r.issues.filter((i) => i.severity !== 'info').map((i) => `${i.id ?? '-'}: [${i.code}] ${i.message}`);

/** Converts and validates `ir`, using heights measured in the rendered preview when available. */
async function rebuild(ir: SketchIR) {
  const { frame, others } = get();
  const doc = ir.layout === 'document';
  // Document Mode: all blocks are rendered once to measure their real heights, then flowed top to bottom (further slides if needed).
  const raw = doc ? buildDocumentElements(ir, frame ?? undefined) : null;
  let conv = raw ? reflowDocument(raw, undefined, frame ?? undefined) : irToElements(ir, frame ?? undefined);
  // Document Mode flows in its own column (and over further slides): the image-frame check does not apply to it.
  const ctx = { frame: doc ? undefined : frame ?? undefined, others };
  const m = get().measure;
  if (raw && m) set({ ir, conv: { ...raw, elements: raw.elements }, report: null });
  else set({ ir, conv, report: validateSketch(ir, conv, undefined, ctx) });
  if (!m) return { conv, report: get().report!, shot: null as SketchImage | null };
  const { heights, shot } = await m();
  if (raw) { conv = reflowDocument(raw, heights, frame ?? undefined); set({ conv }); }
  const report = validateSketch(ir, conv, heights, ctx);
  set({ report });
  return { conv, report, shot };
}

export async function openSketch(el: ImageElement) {
  const native = sketchNative();
  if (!native) return;
  const status = await native.status();
  // AI review default: on for Claude; off for the local model (it did not find real errors and cost ~2-3 min in the
  // GUI test, docs/SKETCH_DEVLOG.md). The checkbox still turns it on.
  set({ aiReview: status.provider !== 'ollama' }); // the mode keeps the user's last choice; the initial default is Document Mode
  set({ phase: status.ready ? 'idle' : 'settings', status, sourceId: el.id, error: null, rounds: [], ir: null, conv: null, report: null, image: null, timings: {}, parseIssues: [] });
  if (status.ready) await runSketch();
}

export async function refreshStatus() {
  const status = await sketchNative()!.status();
  set({ status });
  return status;
}

export async function saveSettings(next: SketchSettings) {
  const r = await sketchNative()!.setSettings(next);
  if (!r.ok) { set({ error: r.error ?? 'Could not save the settings.' }); return null; }
  set({ error: null });
  return refreshStatus();
}

/** Switches between Document Mode and Layout Mode and converts the image again with the other one. */
export async function setSketchMode(mode: SketchMode) {
  if (get().mode === mode || get().phase === 'recognizing' || get().phase === 'reviewing') return;
  set({ mode });
  if (get().sourceId) await runSketch();
}

export function closeSketch() {
  set({ phase: 'idle', sourceId: null, image: null, ir: null, conv: null, report: null, rounds: [], error: null });
}

export async function saveKey(key: string | null) {
  const native = sketchNative()!;
  const r = await native.setKey(key);
  if (!r.ok) { set({ error: r.error ?? 'Could not save the key.' }); return false; }
  set({ status: await native.status(), error: null });
  return true;
}

function sourceImage(): { el: ImageElement; asset: import('../model/types').Asset } | null {
  const st = useStore.getState();
  const slide = findSlide(st.deck, st.currentSlideId);
  const el = slide?.elements.find((e) => e.id === get().sourceId);
  if (!el || el.type !== 'image') return null;
  const asset = st.assets[el.assetId];
  return asset ? { el, asset } : null;
}

export async function runSketch() {
  const native = sketchNative()!;
  const src = sourceImage();
  if (!src) { set({ phase: 'error', error: 'The image is no longer on this slide.' }); return; }
  const runId = newRunId();
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  // The elements are rebuilt inside the image's frame; everything else on the slide stays as it is.
  const st = useStore.getState();
  const others = findSlide(st.deck, st.currentSlideId)!.elements.filter((e) => e.id !== src.el.id);
  set({ frame: { x: src.el.x, y: src.el.y, w: src.el.w, h: src.el.h }, others: structuredClone(others) as SlideElement[] });
  set({ phase: 'recognizing', startedAt: performance.now(), runId, error: null, rounds: [], ir: null, conv: null, report: null, timings });
  try {
    const status = get().status ?? await refreshStatus();
    const local = status.provider === 'ollama';
    // Wall-clock time of every step (`recognize` alone is the model call as measured in the main process).
    const step = async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
      const s0 = performance.now();
      try { return await fn(); } finally { timings[name] = Math.round((timings[name] ?? 0) + performance.now() - s0); }
    };
    const image = await step('prepare', () => imageForModel(src.el, src.asset, status.image));
    set({ image });
    const { dataUrl: _d, ...img } = image;
    const res = await step('recognizeWall', () => native.recognize({ runId, image: img, schema: MODEL_IR_SCHEMA, mode: status.provider !== 'anthropic' ? get().mode : 'layout' }));
    timings.recognize = res.ms ?? 0;
    if (!res.ok) throw new Error(res.error);
    set({ model: res.model ?? '' });
    const parsed = parseIR(res.layout === 'document' ? { ...(res.data as object), layout: 'document' } : res.data, { width: image.width, height: image.height });
    if (!parsed.ir.elements.length) throw new Error('Nothing was recognized in this image.');
    // Pixel measurements on the image the model saw: real ink colors/thickness, bends of strokes the model called straight.
    const measured = await step('ink', async () => applyInkMeasurements(parsed.ir, await rasterOf(image.dataUrl)));
    const ir = measured.ir, issues = [...parsed.issues, ...measured.issues];
    set({ parseIssues: [...issues, ...((ir.notes ?? []).map((n) => ({ severity: 'info' as const, code: 'model-note', message: n })))], phase: get().aiReview ? 'reviewing' : 'preview' });
    let cur = await step('render', () => rebuild(ir));
    native.log(runId, '02-ir.json', { ir, parseIssues: issues, validation: cur.report });

    // AI review: compare original vs rendering; apply its patches; at most MAX_REVIEW_ROUNDS rounds.
    // A local model call takes ~1-2 minutes, so with Ollama the review only runs when the deterministic checks
    // found a problem (errors or warnings); a clean result goes straight to the user's review list.
    for (let round = 1; get().aiReview && round <= MAX_REVIEW_ROUNDS; round++) {
      if (get().sourceId === null) return; // dialog closed
      if (!cur.shot) break;
      if (local && cur.report.counts.error + cur.report.counts.warning === 0) {
        set({ rounds: [...get().rounds, { round, ok: true, summary: 'Skipped: the automatic checks found no problems (saves a local model call).', patches: [], before: cur.report.counts, ms: 0, skipped: true }] });
        break;
      }
      const rr = await step(`reviewWall${round}`, () => native.review({
        runId, round, original: img, rendering: cur.shot!, ir: get().ir!, issues: issueLines(cur.report), schema: REVIEW_SCHEMA,
      }));
      timings[`review${round}`] = rr.ms ?? 0;
      const before = cur.report.counts;
      if (!rr.ok) {
        set({ rounds: [...get().rounds, { round, ok: false, summary: '', patches: [], before, ms: rr.ms ?? 0, error: rr.error }] });
        break;
      }
      const data = rr.data as ReviewResult;
      const entry: ReviewRound = { round, ok: data.ok, summary: data.summary, patches: data.patches ?? [], before, ms: rr.ms ?? 0 };
      if (data.ok || !entry.patches.length) {
        set({ rounds: [...get().rounds, entry] });
        break;
      }
      const patched = applyPatches(get().ir!, entry.patches);
      set({ parseIssues: [...get().parseIssues, ...patched.issues] });
      cur = await step(`render${round}`, () => rebuild(patched.ir));
      entry.after = cur.report.counts;
      set({ rounds: [...get().rounds, entry] });
      native.log(runId, `1${round}-patched-ir.json`, { ir: patched.ir, patchIssues: patched.issues, validation: cur.report });
    }
    timings.total = Math.round(performance.now() - t0);
    // Anything not covered by a measured step (should stay near zero).
    timings.other = timings.total - Object.entries(timings).filter(([k]) => k !== 'total' && k !== 'recognize' && !/^review\d$/.test(k)).reduce((a, [, v]) => a + v, 0);
    set({ phase: 'preview', timings: { ...timings } });
    native.log(runId, '20-summary.json', { model: get().model, timings, rounds: get().rounds, validation: get().report, parseIssues: get().parseIssues });
  } catch (e) {
    set({ phase: 'error', error: String((e as Error)?.message || e) });
    native.log(runId, '99-error.json', { error: String((e as Error)?.message || e) });
  }
}

/** User edit in the preview (text/LaTeX or choosing the inferred reading). Re-converts and re-validates. */
export async function editElement(id: string, patch: Partial<IRElement>) {
  const ir = get().ir;
  if (!ir) return;
  // Editing the plain text of a formatted note replaces its structure (the user's text wins over the old marks/lists).
  const had = ir.elements.find((e) => e.id === id)?.blocks;
  const element = patch.text !== undefined && had ? { ...patch, blocks: undefined } : patch;
  const next = applyPatches(ir, [{ op: 'update', id, element, reason: 'user edit' }]);
  await rebuild(next.ir);
}

/**
 * Puts the converted elements on the current slide in ONE commit (one undo step).
 * replace = the source image is removed in the same step, so a single Undo restores it.
 */
export function applySketch(replace: boolean) {
  const { conv, report, runId } = get();
  const st = useStore.getState();
  const srcId = get().sourceId;
  if (!conv || !srcId) return;
  if (st.editingId) st.stopEditing();
  if (st.cropEditId) st.exitCrop();
  const els: SlideElement[] = structuredClone(conv.elements);
  const morePages: SlideElement[][] = structuredClone(conv.pages ?? []);
  const slideId = st.currentSlideId;
  st.commit((d) => {
    const slide = findSlide(d, slideId)!;
    // Same layer as the image: the other elements keep their stacking order.
    const idx = slide.elements.findIndex((e) => e.id === srcId);
    if (idx < 0) slide.elements.push(...(els as any));
    else slide.elements.splice(replace ? idx : idx + 1, replace ? 1 : 0, ...(els as any));
    // Document Mode overflow: the rest continues on new slides right after this one (same commit = one Undo step).
    if (morePages.length) {
      const at = d.slides.findIndex((x) => x.id === slideId) + 1;
      d.slides.splice(at, 0, ...(morePages.map((p) => ({ ...newSlide(), background: slide.background, elements: p })) as any));
    }
  });
  useStore.setState({ selection: els.map((e) => e.id), focusArea: 'canvas' });
  sketchNative()?.log(runId, '30-applied.json', { replace, elements: els, validation: report });
  closeSketch();
}
