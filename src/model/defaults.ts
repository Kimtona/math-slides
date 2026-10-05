import { nanoid } from 'nanoid';
import type { Deck, LineElement, PMNode, ShapeElement, ShapeKind, Slide, TextElement, TextStyle } from './types';
import { SLIDE_H, SLIDE_W } from './types';
import { presetHex } from './colors';
import { TYPOGRAPHY } from './typography';

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

export function newShape(shape: ShapeKind, x: number, y: number, w = 240, h = 160): ShapeElement {
  return { id: uid(), type: 'shape', shape, x, y, w, h, fill: presetHex('Light Gray'), stroke: null, strokeWidth: 2, radius: 16 };
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

/** A new presentation: one Title Slide. */
export function initialDeck(): Deck {
  const { slide, titleId } = newTitleSlide();
  return { version: 1, id: uid(), title: DEFAULT_TITLE, slides: [slide], titleElementId: titleId };
}

export { SLIDE_W, SLIDE_H };
