/**
 * Deterministic validation of a converted sketch (no AI involved).
 * Works on the slide elements produced by irToElements, optionally with heights measured in the DOM.
 *
 * Overlaps are only reported when they are not intentional: text inside a shape (merged into the shape),
 * an annotation and the thing it annotates, and connectors touching what they connect are all allowed.
 */
import type { PMNode, SlideElement } from '../model/types';
import { SLIDE_H, SLIDE_W } from '../model/types';
import { renderTex } from '../math/mathjax';
import { tableProblems } from '../model/table';
import type { IRIssue, SketchIR } from './ir';
import type { ConversionResult, Frame } from './convert';

/** Where the conversion goes: the source image's frame and the slide's other elements (never modified). */
export interface PlacementContext { frame?: Frame; others?: SlideElement[] }

export interface ValidationReport {
  issues: IRIssue[];
  counts: { error: number; warning: number; info: number };
  /** IR ids the model itself flagged for human review. */
  review: string[];
}

function mathIn(doc: PMNode | undefined, out: string[] = []): string[] {
  if (!doc) return out;
  if ((doc.type === 'mathBlock' || doc.type === 'mathInline') && typeof doc.attrs?.latex === 'string') out.push(doc.attrs.latex);
  doc.content?.forEach((c) => mathIn(c, out));
  return out;
}

const area = (b: { w: number; h: number }) => Math.max(0, b.w) * Math.max(0, b.h);
function overlapRatio(a: SlideElement, b: SlideElement) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1, Math.min(area(a), area(b)));
}

/** Pairs of IR ids that are related (either direction), so overlapping them is intended. */
function relatedPairs(ir: SketchIR): Set<string> {
  const set = new Set<string>();
  const add = (a: string, b: string) => { set.add(a + '|' + b); set.add(b + '|' + a); };
  for (const e of ir.elements) {
    e.relations?.forEach((r) => add(e.id, r.target));
    if (e.fromId) add(e.id, e.fromId);
    if (e.toId) add(e.id, e.toId);
  }
  return set;
}

/** Overlap fraction (of the smaller box) above which two unrelated elements are reported. */
export const OVERLAP_TEXT = 0.12;
export const OVERLAP_SHAPE = 0.35;

export function validateSketch(ir: SketchIR, conv: ConversionResult, heights?: Record<string, number>, ctx: PlacementContext = {}): ValidationReport {
  const issues: IRIssue[] = [...conv.issues];
  const irOf = new Map<string, string>(); // slide element id → IR id (first owner)
  for (const [irId, ids] of Object.entries(conv.map)) for (const id of ids) if (!irOf.has(id)) irOf.set(id, irId);
  const els = conv.elements.map((el) => (heights?.[el.id] ? { ...el, h: heights[el.id] } : el));

  // Bounds: everything must stay on the slide.
  for (const el of els) {
    const id = irOf.get(el.id);
    if (el.x < -0.5 || el.y < -0.5 || el.x + el.w > SLIDE_W + 0.5 || el.y + el.h > SLIDE_H + 0.5)
      issues.push({ severity: 'error', code: 'bounds', id, message: `Extends beyond the slide (${Math.round(el.x)},${Math.round(el.y)} ${Math.round(el.w)}×${Math.round(el.h)}).` });
  }

  // Image area: converted elements should stay where the image was (typeset text can need more room).
  if (ctx.frame) {
    const f = ctx.frame, tol = 4;
    for (const el of els) {
      if (el.x < f.x - tol || el.y < f.y - tol || el.x + el.w > f.x + f.w + tol || el.y + el.h > f.y + f.h + tol)
        issues.push({ severity: 'warning', code: 'frame', id: irOf.get(el.id), message: 'Extends beyond the image area (may cover other content).' });
    }
  }
  // Existing slide content: report what the converted elements would cover (nothing is moved or changed).
  for (const o of ctx.others ?? []) {
    for (const el of els) {
      const r = overlapRatio(el, o);
      const limit = el.type === 'text' || o.type === 'text' ? OVERLAP_TEXT : OVERLAP_SHAPE;
      if (r > limit && el.type !== 'line') {
        issues.push({ severity: 'warning', code: 'overlap-existing', id: irOf.get(el.id), message: `Overlaps an existing ${o.type} on the slide (${Math.round(r * 100)}%).` });
      }
    }
  }

  // Tables must be rectangular, merge-free grids the table editor can open.
  for (const el of els) if (el.type === 'table') for (const msg of tableProblems(el)) issues.push({ severity: 'error', code: 'table', id: irOf.get(el.id), message: msg });

  // LaTeX: every equation (block or inline, in text boxes and shapes) must render.
  for (const el of els) {
    if (el.type !== 'text' && el.type !== 'shape') continue;
    for (const latex of mathIn(el.doc)) {
      const r = renderTex(latex, true);
      if ('error' in r && r.error && !issues.some((i) => i.code === 'latex' && i.id === irOf.get(el.id)))
        issues.push({ severity: 'error', code: 'latex', id: irOf.get(el.id), message: `LaTeX does not render: ${r.error}` });
    }
  }

  // Unintended overlaps between text-like boxes, and between text and unrelated shapes.
  const related = relatedPairs(ir);
  const textLike = (el: SlideElement) => el.type === 'text';
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i], b = els[j];
      if (a.type === 'line' || b.type === 'line') continue; // connectors are meant to touch things
      if (!textLike(a) && !textLike(b)) continue; // shape/shape overlaps are drawn that way
      const ia = irOf.get(a.id), ib = irOf.get(b.id);
      if (ia && ib && related.has(ia + '|' + ib)) continue;
      // A highlighter is drawn around/over words by definition: its overlap with text is intended (even when the model
      // did not say which word it marks).
      const highlighter = (id?: string) => !!id && ir.elements.find((x) => x.id === id)?.pen === 'highlighter';
      if (highlighter(ia) || highlighter(ib)) continue;
      const limit = textLike(a) && textLike(b) ? OVERLAP_TEXT : OVERLAP_SHAPE;
      const r = overlapRatio(a, b);
      if (r > limit) issues.push({ severity: 'warning', code: 'overlap', id: ia, message: `Overlaps "${ib}" (${Math.round(r * 100)}% of the smaller box).` });
    }
  }

  const review = ir.elements.filter((e) => e.review?.needed).map((e) => e.id);
  for (const id of review) {
    const e = ir.elements.find((x) => x.id === id)!;
    issues.push({ severity: 'info', code: 'review', id, message: e.review?.reason || 'Flagged by the model for human review.' });
  }
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  return { issues, counts, review };
}
