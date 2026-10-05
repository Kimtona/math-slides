import type { SlideElement } from '../model/types';
import { SLIDE_H, SLIDE_W } from '../model/types';
import { boxOf, translate, unionBox } from '../model/geometry';
import { currentSlide, useStore } from '../store/store';

export type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/** Align to each other (2+ selected) or to the slide (1 selected). */
export function alignSelection(kind: AlignKind) {
  const st = useStore.getState();
  const els = currentSlide().elements.filter((e) => st.selection.includes(e.id));
  if (!els.length) return;
  const ref = els.length === 1 ? { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H } : unionBox(els.map(boxOf))!;
  const orig = new Map(els.map((e) => [e.id, e]));
  st.updateElements(els.map((e) => e.id), (d) => {
    const o = orig.get(d.id)!;
    let dx = 0, dy = 0;
    if (kind === 'left') dx = ref.x - o.x;
    if (kind === 'hcenter') dx = ref.x + ref.w / 2 - (o.x + o.w / 2);
    if (kind === 'right') dx = ref.x + ref.w - (o.x + o.w);
    if (kind === 'top') dy = ref.y - o.y;
    if (kind === 'vcenter') dy = ref.y + ref.h / 2 - (o.y + o.h / 2);
    if (kind === 'bottom') dy = ref.y + ref.h - (o.y + o.h);
    translate(d as SlideElement, o, Math.round(dx), Math.round(dy));
  });
}

/** Equal gaps between 3+ selected elements. */
export function distributeSelection(axis: 'h' | 'v') {
  const st = useStore.getState();
  const els = currentSlide().elements.filter((e) => st.selection.includes(e.id));
  if (els.length < 3) return;
  const pos = (e: SlideElement) => (axis === 'h' ? e.x : e.y);
  const size = (e: SlideElement) => (axis === 'h' ? e.w : e.h);
  const sorted = [...els].sort((a, b) => pos(a) - pos(b));
  const first = sorted[0], last = sorted[sorted.length - 1];
  const span = pos(last) + size(last) - pos(first);
  const gap = (span - sorted.reduce((s, e) => s + size(e), 0)) / (sorted.length - 1);
  const target = new Map<string, number>();
  let cur = pos(first);
  for (const e of sorted) { target.set(e.id, cur); cur += size(e) + gap; }
  const orig = new Map(els.map((e) => [e.id, e]));
  st.updateElements(els.map((e) => e.id), (d) => {
    const o = orig.get(d.id)!;
    const delta = Math.round(target.get(d.id)! - pos(o));
    translate(d as SlideElement, o, axis === 'h' ? delta : 0, axis === 'v' ? delta : 0);
  });
}

export function nudgeSelection(dx: number, dy: number) {
  const st = useStore.getState();
  const els = currentSlide().elements.filter((e) => st.selection.includes(e.id));
  const orig = new Map(els.map((e) => [e.id, e]));
  st.updateElements(els.map((e) => e.id), (d) => translate(d as SlideElement, orig.get(d.id)!, dx, dy));
}
