// LaTeX -> self-contained SVG using MathJax 3.
// SVG output (fontCache: 'none') contains only <path>s, so the exact same markup is
// used in the editor, in PDF (vector) and in PPTX (native SVG picture).
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';

/** Math em-size relative to the surrounding text (KaTeX uses 1.21, Notion feels ~1.15). */
export const MATH_SCALE = 1.12;
// MathJax sizes its SVG in "ex" of the TeX font (x-height = 0.442em).
const EX_TO_EM = 0.442 * MATH_SCALE;

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({
  packages: AllPackages.filter((p: string) => !['autoload', 'require', 'noerrors', 'noundefined'].includes(p)),
  macros: { R: '\\mathbb{R}', E: '\\mathbb{E}', N: '\\mathbb{N}', Z: '\\mathbb{Z}' },
  formatError: (_jax: unknown, err: Error) => {
    throw err;
  },
});
const svgOut = new SVG({ fontCache: 'none' });
const html = mathjax.document('', { InputJax: tex, OutputJax: svgOut });

export interface MathResult {
  svg: string; // SVG markup sized in em (scales with the font-size of its container)
  widthEm: number;
  heightEm: number;
  baselineEm: number; // distance from bottom of SVG to the text baseline (vertical-align)
  error?: undefined;
}
/**
 * Partial symbol colors (PoC): per-equation metadata, kept apart from the LaTeX source.
 * `i` indexes the equation's "leaf symbols" (MathJax token nodes mi/mn/mo/mtext/ms, in render order);
 * `src` is the LaTeX the indexes were made for — colors are ignored unless it still equals the equation's LaTeX.
 */
export interface MathColors { src: string; items: { i: number; c: string }[] }
const LEAF_TYPES = new Set(['mi', 'mn', 'mo', 'mtext', 'ms']);

export interface MathError {
  error: string;
}

/** DOM version of the leaf set, same order as `leafNodes` (editor-side hit testing / highlighting). */
export const LEAF_SELECTOR = ['mi', 'mn', 'mo', 'mtext', 'ms'].map((t) => `g[data-mml-node="${t}"]`).join(',');

const cache = new Map<string, MathResult | MathError>();

const exToEm = (v: string) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n * EX_TO_EM : 0;
};

/** Leaf symbol <g> nodes of a rendered SVG, in render order (the index space of MathColors). */
function leafNodes(node: any, out: any[] = []): any[] {
  for (const ch of adaptor.childNodes(node) as any[]) {
    if (adaptor.kind(ch) !== 'g') continue;
    if (LEAF_TYPES.has(adaptor.getAttribute(ch, 'data-mml-node') ?? '')) out.push(ch);
    else leafNodes(ch, out);
  }
  return out;
}

/** Only well-formed colors of an equation whose LaTeX still matches; anything else is ignored (never colors another symbol). */
export function activeMathColors(latex: string, colors: MathColors | null | undefined): MathColors['items'] {
  if (!colors || colors.src !== latex || !Array.isArray(colors.items)) return [];
  return colors.items.filter((x) => Number.isInteger(x?.i) && x.i >= 0 && typeof x.c === 'string' && /^#[\da-f]{6}$/i.test(x.c));
}

export function renderTex(latex: string, display: boolean, colors?: MathColors | null): MathResult | MathError {
  const items = activeMathColors(latex, colors);
  const key = (display ? 'D' : 'I') + (items.length ? items.map((x) => x.i + x.c).join(',') + '|' : '') + latex;
  const hit = cache.get(key);
  if (hit) return hit;
  let res: MathResult | MathError;
  try {
    const node = html.convert(latex, { display, em: 16, ex: 8, containerWidth: 1280 });
    const svgNode = adaptor.firstChild(node) as any;
    const w = exToEm(adaptor.getAttribute(svgNode, 'width'));
    const h = exToEm(adaptor.getAttribute(svgNode, 'height'));
    const style = adaptor.getAttribute(svgNode, 'style') || '';
    const va = /vertical-align:\s*(-?[\d.]+)ex/.exec(style);
    const baseline = va ? parseFloat(va[1]) * EX_TO_EM : 0;
    adaptor.setAttribute(svgNode, 'width', `${w.toFixed(4)}em`);
    adaptor.setAttribute(svgNode, 'height', `${h.toFixed(4)}em`);
    adaptor.setAttribute(svgNode, 'style', `vertical-align:${baseline.toFixed(4)}em`);
    adaptor.removeAttribute(svgNode, 'focusable');
    if (items.length) {
      // An explicit fill on the leaf wins over inherited currentColor and over a user-written \textcolor wrapper.
      const leaves = leafNodes(svgNode);
      for (const { i, c } of items) {
        if (!leaves[i]) continue;
        adaptor.setAttribute(leaves[i], 'fill', c);
        adaptor.setAttribute(leaves[i], 'stroke', c);
      }
    }
    res = { svg: adaptor.outerHTML(svgNode), widthEm: w, heightEm: h, baselineEm: baseline };
  } catch (e: any) {
    res = { error: String(e?.message ?? e) };
  }
  if (cache.size > 2000) cache.clear();
  cache.set(key, res);
  return res;
}
