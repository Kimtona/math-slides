import type { PMNode } from './types';

/**
 * Presentation fonts (bundled locally, see the @font-face rules in styles.css). A font is identified by its CSS
 * family name, which is also what is stored: `Deck.fontFamily` (absent = NanumSquare, so older files are unchanged)
 * and the `fontFamily` attribute of a `textStyle` mark for a font applied to a selected range.
 */
export const DEFAULT_FONT = 'NanumSquare';

export const SLIDE_FONTS = [
  { id: 'NanumSquare', stack: "'NanumSquare', 'Apple SD Gothic Neo', sans-serif" },
  { id: 'Pretendard', stack: "'Pretendard', 'Apple SD Gothic Neo', sans-serif" },
  { id: 'Noto Serif KR', stack: "'Noto Serif KR', 'Apple SD Myungjo', serif" },
] as const;

export type SlideFont = (typeof SLIDE_FONTS)[number]['id'];

export const isSlideFont = (v: unknown): v is SlideFont => SLIDE_FONTS.some((f) => f.id === v);

/** The deck's font; unknown/absent values fall back to the default. */
export const deckFont = (fontFamily: string | undefined): SlideFont => (isSlideFont(fontFamily) ? fontFamily : DEFAULT_FONT);

/** CSS font-family value for a font id (default for unknown ids). */
export const fontStack = (id: string | null | undefined): string => SLIDE_FONTS.find((f) => f.id === id)?.stack ?? SLIDE_FONTS[0].stack;

/** The font id a computed/inline `font-family` list starts with, if it is one of ours. */
export function fontFromCss(family: string | null | undefined): SlideFont | undefined {
  const first = family?.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  return SLIDE_FONTS.find((f) => f.id === first)?.id;
}

/** Inline style that makes a slide (and everything inside it) use the deck font. */
export const slideFontVars = (fontFamily: string | undefined) => ({ ['--slide-font' as string]: fontStack(deckFont(fontFamily)) });

/** Remove per-range font marks from a document (mutates; used on immer drafts). Other textStyle attributes (color) stay. */
export function clearRunFonts(node: PMNode) {
  if (node.marks) {
    for (const m of node.marks) if (m.type === 'textStyle' && m.attrs) delete m.attrs.fontFamily;
    node.marks = node.marks.filter((m) => m.type !== 'textStyle' || Object.values(m.attrs ?? {}).some((v) => v != null));
    if (!node.marks.length) delete node.marks;
  }
  node.content?.forEach(clearRunFonts);
}
