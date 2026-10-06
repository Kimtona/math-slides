/**
 * Compact Math Palette data + pure insertion logic. An item is `pre` + (selection) + `post`:
 * - `wrap` items wrap a non-empty selection (`\mathbf{` + x + `}`), otherwise leave the caret at `pre.length`;
 *   after wrapping the caret sits `wrapCaret` characters into `post` (default: after it).
 * - other items replace the selection with `pre + post` and put the caret at `pre.length`.
 * `show` is the TeX rendered in the palette cell (default `pre + post`); `tip` is the hover hint.
 */
export interface MathItem { pre: string; post?: string; show?: string; tip: string; wrap?: boolean; wrapCaret?: number }
export interface MathCategory { key: string; label: string; items: MathItem[] }

const sym = (tex: string, name = tex.slice(1)): MathItem => ({ pre: tex, tip: `${name} · ${tex}` });
const greek = (n: string): MathItem => sym('\\' + n, n);

const FREQ: MathItem[] = [
  greek('rho'), greek('theta'), greek('lambda'),
  { pre: '\\mathbb{R}', tip: 'R · \\mathbb{R}' }, { pre: '\\mathbb{E}', tip: 'E · \\mathbb{E}' },
  { pre: '\\mathbf{', post: '}', wrap: true, show: '\\mathbf{x}', tip: 'bold · \\mathbf{}' },
  { pre: '\\lVert ', post: '\\rVert', wrap: true, show: '\\lVert x\\rVert', tip: 'norm · \\lVert x\\rVert' },
  { pre: '\\frac{', post: '}{}', wrap: true, wrapCaret: 2, show: '\\frac{a}{b}', tip: 'fraction · \\frac{}{}' },
  { pre: '\\sum_{', post: '}^{}', show: '\\sum_{i}^{n}', tip: 'sum · \\sum_{}^{}' },
  { pre: '\\begin{cases} ', post: ' & \\text{if } \\\\ & \\text{otherwise}\\end{cases}', show: '\\begin{cases}a\\\\b\\end{cases}', tip: 'cases · \\begin{cases}' },
];
const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau',
  'phi', 'varphi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Sigma', 'Phi', 'Psi', 'Omega'].map(greek);
const OPS: MathItem[] = [
  ['\\cdot', 'dot'], ['\\times', 'times'], ['\\pm', 'plus-minus'], ['=', 'equals'], ['\\neq', 'not equal'], ['\\approx', 'approx'], ['<', 'less'], ['>', 'greater'],
  ['\\le', 'less or equal'], ['\\ge', 'greater or equal'], ['\\to', 'to'], ['\\leftarrow', 'left arrow'], ['\\Rightarrow', 'implies'], ['\\Leftrightarrow', 'iff'],
  ['\\in', 'in'], ['\\notin', 'not in'], ['\\subset', 'subset'], ['\\subseteq', 'subset or equal'], ['\\cup', 'union'], ['\\cap', 'intersection'],
  ['\\emptyset', 'empty set'], ['\\forall', 'for all'], ['\\exists', 'exists'], ['\\infty', 'infinity'], ['\\partial', 'partial'], ['\\nabla', 'nabla'],
].map(([t, n]) => sym(t, n));
const STYLE: MathItem[] = [
  { pre: '\\mathbf{', post: '}', wrap: true, show: '\\mathbf{x}', tip: 'bold · \\mathbf{}' },
  { pre: '\\mathbb{', post: '}', wrap: true, show: '\\mathbb{R}', tip: 'blackboard · \\mathbb{}' },
  { pre: '\\mathbb{E}', tip: 'expectation · \\mathbb{E}' },
  { pre: '\\mathcal{', post: '}', wrap: true, show: '\\mathcal{L}', tip: 'calligraphic · \\mathcal{}' },
  { pre: '\\hat{', post: '}', wrap: true, show: '\\hat{x}', tip: 'hat · \\hat{}' },
  { pre: '\\bar{', post: '}', wrap: true, show: '\\bar{x}', tip: 'bar · \\bar{}' },
  { pre: '\\text{', post: '}', wrap: true, show: '\\text{ab}', tip: 'text · \\text{}' },
  { pre: '\\boxed{', post: '}', wrap: true, show: '\\boxed{x}', tip: 'boxed · \\boxed{}' },
];
const STRUCT: MathItem[] = [
  { pre: '\\frac{', post: '}{}', wrap: true, wrapCaret: 2, show: '\\frac{a}{b}', tip: 'fraction · \\frac{}{}' },
  { pre: '\\sqrt{', post: '}', wrap: true, show: '\\sqrt{x}', tip: 'square root · \\sqrt{}' },
  { pre: '\\sum_{', post: '}^{}', show: '\\sum_{i}^{n}', tip: 'sum · \\sum_{}^{}' },
  { pre: '\\int_{', post: '}^{}', show: '\\int_{a}^{b}', tip: 'integral · \\int_{}^{}' },
  { pre: '\\lVert ', post: '\\rVert', wrap: true, show: '\\lVert x\\rVert', tip: 'norm · \\lVert x\\rVert' },
  { pre: '\\begin{cases} ', post: ' & \\text{if } \\\\ & \\text{otherwise}\\end{cases}', show: '\\begin{cases}a\\\\b\\end{cases}', tip: 'cases · \\begin{cases}' },
  { pre: '\\begin{pmatrix} ', post: ' & \\\\ & \\end{pmatrix}', show: '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}', tip: 'matrix · \\begin{pmatrix}' },
];

export const MATH_CATEGORIES: MathCategory[] = [
  { key: 'freq', label: '자주 사용', items: FREQ },
  { key: 'greek', label: '그리스', items: GREEK },
  { key: 'ops', label: '연산', items: OPS },
  { key: 'style', label: '스타일', items: STYLE },
  { key: 'struct', label: '구조', items: STRUCT },
];

/** Apply `item` to `value` over the selection [start, end); returns the new value and caret. */
export function applyMathItem(value: string, start: number, end: number, item: MathItem): { value: string; caret: number } {
  const sel = value.slice(start, end);
  const post = item.post ?? '';
  let text: string, caret: number;
  if (item.wrap && sel) { text = item.pre + sel + post; caret = item.pre.length + sel.length + (item.wrapCaret ?? post.length); }
  else { text = item.pre + post; caret = item.pre.length; }
  // A bare control word ("\rho") must not fuse with a following letter: separate it with a space.
  if (!post && /\\[A-Za-z]+$/.test(text) && /^[A-Za-z]?$/.test(value.charAt(end))) { text += ' '; caret = text.length; }
  return { value: value.slice(0, start) + text + value.slice(end), caret: start + caret };
}
