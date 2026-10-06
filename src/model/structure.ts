import { produce, type Draft } from 'immer';
import type { Deck, PMNode, Section, Slide, TextElement } from './types';
import { newReferencesSlide, newSubtitleSlide, referencesListElement, subtitleElement, subtitleSlideId } from './defaults';
import { plainText } from '../editor/docUtils';
import { displayCitation } from '../citations/format';

// Structural relationships, kept consistent after every edit (runs inside commit/live, so each
// undo snapshot is consistent too):
//   Table of Contents box (source of truth) ──▶ Sub-title slides     (one-way, by section id)
//   citations used in slide footers         ──▶ References slide     (deduplicated by citation id)
// Ordinary slides are never created, moved or deleted here.

const MANAGED_ROLES = new Set(['subtitle-current', 'subtitle-next', 'references-title', 'references-list']);
export const isManagedText = (el: { type: string; role?: string }) => el.type === 'text' && !!el.role && MANAGED_ROLES.has(el.role);

const para = (text: string, marks?: PMNode['marks']): PMNode =>
  text ? { type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] } : { type: 'paragraph' };
const docOf = (...paras: PMNode[]): PMNode => ({ type: 'doc', content: paras });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The TOC box: the 'toc' text element on the first TOC slide. */
export function findToc(deck: Deck): { slide: Slide; el: TextElement } | null {
  for (const s of deck.slides) {
    if (s.kind !== 'toc') continue;
    const el = s.elements.find((e): e is TextElement => e.type === 'text' && e.role === 'toc');
    if (el) return { slide: s, el };
  }
  return null;
}

/** Sections = top-level list items of the TOC box that have an id and a non-empty title. */
export function tocSections(doc: PMNode): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  for (const block of doc.content ?? []) {
    if (block.type !== 'orderedList' && block.type !== 'bulletList') continue;
    for (const item of block.content ?? []) {
      const id = item.attrs?.sectionId as string | undefined;
      const first = item.content?.find((c) => c.type === 'paragraph');
      const title = first ? plainText({ type: 'doc', content: [first] }).replace(/\s+/g, ' ').trim() : '';
      if (id && title && !out.some((s) => s.id === id)) out.push({ id, title });
    }
  }
  return out;
}

function reconcileToc(d: Draft<Deck>) {
  const toc = findToc(d as Deck);
  const wanted = toc ? tocSections(toc.el.doc) : [];
  const wantedIds = new Set(wanted.map((s) => s.id));

  // Sub-title slides: drop those whose section is gone; a second slide for the same section
  // (e.g. a copy) becomes an ordinary slide.
  const seen = new Set<string>();
  const kept = d.slides.filter((s) => s.kind !== 'subtitle' || (s.sectionId && wantedIds.has(s.sectionId)));
  if (kept.length !== d.slides.length) d.slides = kept;
  for (const s of d.slides) {
    if (s.kind !== 'subtitle') continue;
    if (seen.has(s.sectionId!)) { delete s.kind; delete s.sectionId; s.elements.forEach((e) => { if (e.type === 'text') delete e.role; }); }
    else seen.add(s.sectionId!);
  }

  // Create missing Sub-title slides: right before the next section's Sub-title if it exists,
  // otherwise after the previous section's block / the TOC (never between other slides' content).
  const indexOf = (id: string) => d.slides.findIndex((s) => s.id === id);
  wanted.forEach((sec, i) => {
    if (seen.has(sec.id)) return;
    let at = -1;
    for (let j = i + 1; j < wanted.length && at < 0; j++) if (seen.has(wanted[j].id)) at = indexOf(subtitleSlideId(wanted[j].id));
    if (at < 0) {
      // Last section so far: before References / Thank You at the end, else at the end.
      at = d.slides.length;
      while (at > 0 && (d.slides[at - 1].kind === 'references' || d.slides[at - 1].kind === 'thanks')) at--;
      if (toc && at <= indexOf(toc.slide.id)) at = indexOf(toc.slide.id) + 1;
    }
    d.slides.splice(at, 0, newSubtitleSlide(sec.id) as Draft<Slide>);
    seen.add(sec.id);
  });

  // Text of every Sub-title slide: "Part n. title" (h1) and the next section (h3).
  wanted.forEach((sec, i) => {
    const s = d.slides.find((x) => x.kind === 'subtitle' && x.sectionId === sec.id)!;
    const next = wanted[i + 1];
    const setText = (which: 'current' | 'next', text: string | null) => {
      const role = which === 'current' ? 'subtitle-current' : 'subtitle-next';
      const idx = s.elements.findIndex((e) => e.type === 'text' && e.role === role);
      if (text === null) { if (idx >= 0) s.elements.splice(idx, 1); return; }
      if (idx < 0) s.elements.push(subtitleElement(s.id, which) as Draft<TextElement>);
      const el = s.elements[idx >= 0 ? idx : s.elements.length - 1] as Draft<TextElement>;
      const doc = docOf(para(text));
      if (!same(el.doc, doc)) el.doc = doc as Draft<PMNode>;
    };
    setText('current', `Part ${i + 1}. ${sec.title}`);
    setText('next', next ? `Part ${i + 2}. ${next.title}` : null);
  });

  const sections: Section[] = wanted.map((s) => ({ id: s.id, title: s.title, subtitleSlideId: subtitleSlideId(s.id) }));
  if (!same(d.sections ?? [], sections)) d.sections = sections.length ? sections : undefined;
}

/** Citation ids in use, in slide order, deduplicated; only resolved citations count. */
export function usedCitations(deck: Deck): string[] {
  const out: string[] = [];
  for (const s of deck.slides) for (const id of s.citations ?? []) {
    if (deck.citations?.[id]?.status === 'ok' && !out.includes(id)) out.push(id);
  }
  return out;
}

function firstAuthorKey(deck: Deck, id: string) {
  const a = deck.citations?.[id]?.authors?.[0] ?? '';
  return (a.split(/\s+/).pop() ?? '').toLowerCase() + ' ' + (deck.citations?.[id]?.year ?? '');
}

function reconcileReferences(d: Draft<Deck>) {
  const used = usedCitations(d as Deck);
  let idx = d.slides.findIndex((s) => s.kind === 'references');
  if (!used.length) {
    // Remove the References slide unless the user added their own content to it.
    if (idx >= 0 && d.slides[idx].elements.every((e) => isManagedText(e))) d.slides.splice(idx, 1);
    else if (idx >= 0) {
      const list = d.slides[idx].elements.find((e) => e.type === 'text' && e.role === 'references-list') as Draft<TextElement> | undefined;
      if (list && !same(list.doc, docOf(para('')))) list.doc = docOf(para('')) as Draft<PMNode>;
    }
    return;
  }
  if (idx < 0) {
    // New References slide: last, but before a trailing Thank You slide.
    let at = d.slides.length;
    while (at > 0 && d.slides[at - 1].kind === 'thanks') at--;
    d.slides.splice(at, 0, newReferencesSlide() as Draft<Slide>);
    idx = at;
  }
  const slide = d.slides[idx];
  let list = slide.elements.find((e) => e.type === 'text' && e.role === 'references-list') as Draft<TextElement> | undefined;
  if (!list) { slide.elements.push(referencesListElement() as Draft<TextElement>); list = slide.elements[slide.elements.length - 1] as Draft<TextElement>; }
  const sorted = [...used].sort((a, b) => firstAuthorKey(d as Deck, a).localeCompare(firstAuthorKey(d as Deck, b)));
  const doc = docOf(...sorted.map((id) => {
    const c = d.citations![id];
    return para(displayCitation(c), [{ type: 'link', attrs: { href: c.url } }]);
  }));
  if (!same(list.doc, doc)) list.doc = doc as Draft<PMNode>;
}

/** Bring Sub-title and References slides in line with the TOC and citation usage. */
export function reconcileStructure(prev: Deck | null, next: Deck): Deck {
  if (prev && prev.slides === next.slides && prev.citations === next.citations) return next;
  return produce(next, (d) => {
    reconcileToc(d);
    reconcileReferences(d);
  });
}

/** A copy of a structural slide is an ordinary slide (no second TOC / Sub-title / References). */
export function plainSlideCopy(s: Slide): Slide {
  return produce(s, (d) => {
    delete d.kind;
    delete d.sectionId;
    d.elements.forEach((e) => { if (e.type === 'text') delete e.role; });
  });
}
