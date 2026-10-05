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
  return { id: uid(), background: '#ffffff', elements: [], notes: '' };
}

export function initialDeck(): Deck {
  const title = newText(96, 250, {
    w: SLIDE_W - 192,
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'MathSlides', marks: [{ type: 'bold' }] }] }] },
    style: { fontSize: 64, align: 'center' },
  });
  const sub = newText(96, 350, {
    w: SLIDE_W - 192,
    doc: textDoc('빈 곳을 클릭해 텍스트를 쓰고, /math 로 수식을 넣어 보세요'),
    style: { fontSize: 26, align: 'center', color: '#57606a' },
  });
  const s1 = newSlide();
  s1.elements.push(title, sub);

  const s2 = newSlide();
  s2.elements.push(
    newText(64, 48, { w: SLIDE_W - 128, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Proximal Policy Optimization', marks: [{ type: 'bold' }] }] }] }, style: { fontSize: 40 } }),
    newText(64, 150, {
      w: SLIDE_W - 128,
      doc: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'The PPO objective is' }] },
          { type: 'mathBlock', attrs: { latex: 'L^{\\text{CLIP}}(\\theta)=\\hat{\\mathbb{E}}_t\\left[\\min\\left(r_t(\\theta)\\hat{A}_t,\\ \\operatorname{clip}(r_t(\\theta),1-\\epsilon,1+\\epsilon)\\hat{A}_t\\right)\\right]' } },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'where ' },
              { type: 'mathInline', attrs: { latex: 'r_t(\\theta)=\\frac{\\pi_\\theta(a_t\\mid s_t)}{\\pi_{\\theta_\\text{old}}(a_t\\mid s_t)}' } },
              { type: 'text', text: ' is the probability ratio.' },
            ],
          },
        ],
      },
    }),
  );
  return { version: 1, title: 'Untitled presentation', slides: [s1, s2] };
}

export { SLIDE_W, SLIDE_H };
