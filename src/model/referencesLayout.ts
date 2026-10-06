import { SLIDE_H, SLIDE_W } from './types';
import { FOOTER_FONT_SIZE, FOOTER_MARGIN_Y, TYPOGRAPHY } from './typography';

/**
 * Deterministic pagination estimation for the generated References slides.
 *
 * References are plain paragraphs in one managed text box per slide. Which references go on which slide is decided here, from the
 * reference text alone: no DOM, canvas or font measurement, so editor, thumbnails, presenter, PDF and PPTX all agree and there is no
 * measure → reconcile feedback loop. The estimate is deliberately a little pessimistic (a slide may break slightly early, never
 * overflow into the footer). Tune the constants below; nothing else encodes these assumptions.
 */
export const REFERENCES_LAYOUT = {
  /** The list box: same geometry the generated list element is created with. */
  x: 64,
  top: 40 + Math.round(TYPOGRAPHY.h2 * 1.35) + 28, // below the title (h2) + gap
  width: SLIDE_W - 128,
  fontSize: TYPOGRAPHY.body,
  lineHeight: 1.4,
  /** The list may extend down to just above the slide footer (number / reference line). */
  bottom: SLIDE_H - FOOTER_MARGIN_Y - Math.ceil(FOOTER_FONT_SIZE * 1.3) - 16,
  /** Average glyph advance in em: Latin text, and wide (CJK / full-width) characters. */
  latinEm: 0.6,
  wideEm: 1,
  /** Fraction of a line's width that wrapped words actually fill (word breaks leave the rest empty). */
  wrapFill: 0.92,
} as const;

const L = REFERENCES_LAYOUT;
export const REFERENCES_LINE_HEIGHT = L.fontSize * L.lineHeight;
/** Whole text lines that fit under the title. */
export const REFERENCES_MAX_LINES = Math.floor((L.bottom - L.top) / REFERENCES_LINE_HEIGHT);

const isWide = (cp: number) => (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x2e80 && cp <= 0xd7ff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef);

/** Estimated rendered lines of one reference paragraph. */
export function estimateReferenceLines(text: string): number {
  let em = 0;
  for (const ch of text) em += isWide(ch.codePointAt(0)!) ? L.wideEm : L.latinEm;
  return Math.max(1, Math.ceil((em * L.fontSize) / (L.width * L.wrapFill)));
}

/**
 * Split references (in order) into pages: a reference moves to the next page when its estimated lines would exceed the page.
 * A reference taller than a whole page still gets a page of its own; empty pages are never produced.
 */
export function paginateReferences<T extends { text: string }>(items: T[]): T[][] {
  const pages: T[][] = [];
  let used = 0;
  for (const it of items) {
    const lines = estimateReferenceLines(it.text);
    if (!pages.length || used + lines > REFERENCES_MAX_LINES) { pages.push([]); used = 0; }
    pages[pages.length - 1].push(it);
    used += lines;
  }
  return pages;
}
