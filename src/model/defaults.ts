import { nanoid } from 'nanoid';
import type { Deck, LineElement, PMNode, ShapeElement, ShapeKind, Slide, TextElement, TextStyle } from './types';
import { SLIDE_H, SLIDE_W } from './types';
import { HIGHLIGHT_COLORS, presetHex } from './colors';
import { TYPOGRAPHY } from './typography';
import { BLOCK_ARROW_DEFAULTS } from './blockArrow';

export const uid = () => nanoid(10);

export const FONT_FAMILY = 'NanumSquare';
export const DEFAULT_TEXT_COLOR = presetHex('Black');
export const ACCENT = '#2f6feb';

export const emptyDoc = (): PMNode => ({ type: 'doc', content: [{ type: 'paragraph' }] });

export const textDoc = (...paragraphs: string[]): PMNode => ({
  type: 'doc',
  content: paragraphs.map((t) => (t ? { type: 'paragraph', content: [{ type: 'text', text: t }] } : { type: 'paragraph' })),
});

export function defaultTextStyle(partial: Partial<TextStyle> = {}): TextStyle {
  return { fontSize: TYPOGRAPHY.body, color: DEFAULT_TEXT_COLOR, align: 'left', lineHeight: 1.35, fill: null, ...partial };
}

export function newText(x: number, y: number, opts: { w?: number; doc?: PMNode; style?: Partial<TextStyle> } = {}): TextElement {
  const style = defaultTextStyle(opts.style);
  return {
    id: uid(),
    type: 'text',
    x,
    y,
    w: opts.w ?? 480,
    h: Math.round(style.fontSize * style.lineHeight),
    doc: opts.doc ?? emptyDoc(),
    style,
  };
}

/** Shape text defaults: centered body text; the shape box never grows with it. */
export const SHAPE_TEXT_PADDING = 12;
export const shapeTextStyle = (el: Pick<ShapeElement, 'textStyle'>): TextStyle =>
  el.textStyle ?? { fontSize: TYPOGRAPHY.body, color: DEFAULT_TEXT_COLOR, align: 'center', lineHeight: 1.35, fill: null };
/** Inset of the text area: padding, plus the inscribed rectangle for ellipses. */
export const shapeTextInset = (el: Pick<ShapeElement, 'shape' | 'w' | 'h'>) =>
  ({ x: SHAPE_TEXT_PADDING + (el.shape === 'ellipse' ? el.w * 0.146 : 0), y: SHAPE_TEXT_PADDING + (el.shape === 'ellipse' ? el.h * 0.146 : 0) });

export function newShape(shape: ShapeKind, x: number, y: number, w = 240, h = 160): ShapeElement {
  const arrow = shape === 'blockArrow' ? { ...BLOCK_ARROW_DEFAULTS } : {};
  return { id: uid(), type: 'shape', shape, x, y, w, h, fill: HIGHLIGHT_COLORS[0].hex, stroke: null, strokeWidth: 2, radius: 16, ...arrow };
}

export function lineBox(l: Pick<LineElement, 'x1' | 'y1' | 'x2' | 'y2'>) {
  return { x: Math.min(l.x1, l.x2), y: Math.min(l.y1, l.y2), w: Math.abs(l.x2 - l.x1), h: Math.abs(l.y2 - l.y1) };
}

export function newLine(x1: number, y1: number, x2: number, y2: number, arrow = false): LineElement {
  return {
    id: uid(), type: 'line', x1, y1, x2, y2, ...lineBox({ x1, y1, x2, y2 }),
    stroke: DEFAULT_TEXT_COLOR, strokeWidth: 3, arrowEnd: arrow, arrowStart: false, dashed: false,
  };
}

export function newSlide(): Slide {
  return { id: uid(), background: '#ffffff', elements: [], notes: '', reference: '' };
}

// ---------- slide templates (initial state only; the boxes are ordinary text elements) ----------

export const DEFAULT_TITLE = 'Untitled presentation';

/** Initial texts of template boxes. Editing a box that still shows one of these selects it all. */
export const TEMPLATE_TEXT = {
  title: DEFAULT_TITLE,
  subtitle: '내용은 빈 곳을 클릭해 텍스트를 쓰고, /math 로 수식을 넣어 보세요',
  contentTitle: '슬라이드 제목',
  contentBody: '내용을 입력하세요',
};
const TEMPLATE_PLACEHOLDERS = new Set(Object.values(TEMPLATE_TEXT));
export const isTemplatePlaceholder = (text: string) => TEMPLATE_PLACEHOLDERS.has(text.trim());

/** Title Slide: large centered title (h1) and a secondary line (h3) below it. */
export function newTitleSlide(title = DEFAULT_TITLE): { slide: Slide; titleId: string } {
  const s = newSlide();
  s.kind = 'title'; // canonical Title Slide: the initial slide and every inserted one
  const main = newText(96, 210, { w: SLIDE_W - 192, doc: textDoc(title), style: { fontSize: TYPOGRAPHY.h1, align: 'center' } });
  const sub = newText(96, 350, {
    w: SLIDE_W - 192, doc: textDoc(TEMPLATE_TEXT.subtitle),
    style: { fontSize: TYPOGRAPHY.h3, align: 'center', color: presetHex('Dark Gray') },
  });
  s.elements.push(main, sub);
  return { slide: s, titleId: main.id };
}

/** Content Slide: title (h2) at the upper-left and a body box (h3) right below it. */
export function newContentSlide(): Slide {
  const s = newSlide();
  const x = 64, y = 40, w = SLIDE_W - 128;
  const titleH = Math.round(TYPOGRAPHY.h2 * 1.35);
  s.elements.push(
    newText(x, y, { w, doc: textDoc(TEMPLATE_TEXT.contentTitle), style: { fontSize: TYPOGRAPHY.h2 } }),
    newText(x, y + titleH + 24, { w, doc: textDoc(TEMPLATE_TEXT.contentBody), style: { fontSize: TYPOGRAPHY.h3 } }),
  );
  return s;
}

// ---------- structural slides ----------

/** Table of Contents: title + a numbered list; each list item is a section (source of truth). */
export function newTocSlide(): Slide {
  const s = newSlide();
  s.kind = 'toc';
  const x = 64, y = 40, w = SLIDE_W - 128;
  const titleH = Math.round(TYPOGRAPHY.h2 * 1.35);
  const list = newText(x, y + titleH + 32, {
    w,
    doc: { type: 'doc', content: [{ type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', attrs: { sectionId: uid() }, content: [{ type: 'paragraph' }] }] }] },
    style: { fontSize: TYPOGRAPHY.h3, lineHeight: 1.6 },
  });
  list.role = 'toc';
  s.elements.push(newText(x, y, { w, doc: textDoc('목차'), style: { fontSize: TYPOGRAPHY.h2 } }), list);
  return s;
}

export const subtitleSlideId = (sectionId: string) => `sub-${sectionId}`;

/** Sub-title slide for one section. Ids derive from the section id so undo/redo stays consistent. */
export function newSubtitleSlide(sectionId: string): Slide {
  const id = subtitleSlideId(sectionId);
  const s: Slide = { ...newSlide(), id, kind: 'subtitle', sectionId };
  s.elements.push(subtitleElement(id, 'current'));
  return s;
}

export function subtitleElement(slideId: string, which: 'current' | 'next'): TextElement {
  const current = which === 'current';
  const el = newText(120, current ? 250 : 250 + Math.round(TYPOGRAPHY.h1 * 1.35) + 24, {
    w: SLIDE_W - 240,
    style: current ? { fontSize: TYPOGRAPHY.h1 } : { fontSize: TYPOGRAPHY.h3, color: presetHex('Dark Gray') },
  });
  el.id = `${slideId}-${which}`;
  el.role = current ? 'subtitle-current' : 'subtitle-next';
  return el;
}

export const REFERENCES_SLIDE_ID = 'references';

/** References slide (system-managed): title (h2) + list of full citations (body). */
export function newReferencesSlide(): Slide {
  const s: Slide = { ...newSlide(), id: REFERENCES_SLIDE_ID, kind: 'references' };
  const x = 64, y = 40, w = SLIDE_W - 128;
  const title = newText(x, y, { w, doc: textDoc('References'), style: { fontSize: TYPOGRAPHY.h2 } });
  title.id = `${REFERENCES_SLIDE_ID}-title`;
  title.role = 'references-title';
  s.elements.push(title, referencesListElement());
  return s;
}

export function referencesListElement(): TextElement {
  const el = newText(64, 40 + Math.round(TYPOGRAPHY.h2 * 1.35) + 28, { w: SLIDE_W - 128, style: { fontSize: TYPOGRAPHY.body, lineHeight: 1.4 } });
  el.id = `${REFERENCES_SLIDE_ID}-list`;
  el.role = 'references-list';
  return el;
}

/** Thank You slide: an ordinary, editable closing slide that stays after References. */
export function newThanksSlide(): Slide {
  const s = newSlide();
  s.kind = 'thanks';
  s.elements.push(newText(96, 290, { w: SLIDE_W - 192, doc: textDoc('Thank you'), style: { fontSize: TYPOGRAPHY.h1, align: 'center' } }));
  return s;
}

/** A new presentation: one Title Slide. */
export function initialDeck(): Deck {
  const { slide, titleId } = newTitleSlide();
  return { version: 1, id: uid(), title: DEFAULT_TITLE, slides: [slide], titleElementId: titleId };
}

export { SLIDE_W, SLIDE_H };
