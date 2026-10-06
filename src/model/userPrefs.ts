/**
 * User-scoped preferences (pure model). These belong to the local MathSlides installation, never to a
 * presentation: they are not part of `Deck`, not serialized into `.mslides`, not in the undo history.
 * Persistence and change notification live in `src/store/userPrefs.ts`. Add a future user-level preference
 * (Math Quick Expressions, My Colors, ...) as one more optional field here plus its own resolver; an absent
 * or unusable value always resolves to the v1 default, so missing/corrupt storage can never break the editor.
 */

/** The user-level Quick Emojis: 10 slots shared by every emoji surface (today the Callout toolbar; a future Emoji tool reuses them). Exactly these are the v1 defaults. */
export const DEFAULT_QUICK_EMOJIS: readonly string[] = ['💡', 'ℹ️', '⚠️', '✅', '❌', '📌', '🔥', '💬', '⭐', '🚀'];
export const QUICK_EMOJI_SLOTS = DEFAULT_QUICK_EMOJIS.length;

/**
 * A Math Favorite: the same `pre` + (selection) + `post` shape the Math palette inserts (see editor/mathPaletteItems),
 * so a favorite is inserted by the existing `applyMathItem`. A favorite saved from the equation editor is just
 * `{ pre: <complete LaTeX> }`; the built-in defaults below are the former `자주 사용` palette items, unchanged.
 */
export interface MathFavorite { pre: string; post?: string; show?: string; tip?: string; wrap?: boolean; wrapCaret?: number }

export const DEFAULT_MATH_FAVORITES: readonly MathFavorite[] = [
  { pre: '\\rho', tip: 'rho · \\rho' }, { pre: '\\theta', tip: 'theta · \\theta' }, { pre: '\\lambda', tip: 'lambda · \\lambda' },
  { pre: '\\mathbb{R}', tip: 'R · \\mathbb{R}' }, { pre: '\\mathbb{E}', tip: 'E · \\mathbb{E}' },
  { pre: '\\mathbf{', post: '}', wrap: true, show: '\\mathbf{x}', tip: 'bold · \\mathbf{}' },
  { pre: '\\lVert ', post: '\\rVert', wrap: true, show: '\\lVert x\\rVert', tip: 'norm · \\lVert x\\rVert' },
  { pre: '\\frac{', post: '}{}', wrap: true, wrapCaret: 2, show: '\\frac{a}{b}', tip: 'fraction · \\frac{}{}' },
  { pre: '\\sum_{', post: '}^{}', show: '\\sum_{i}^{n}', tip: 'sum · \\sum_{}^{}' },
  { pre: '\\begin{cases} ', post: ' & \\text{if } \\\\ & \\text{otherwise}\\end{cases}', show: '\\begin{cases}a\\\\b\\end{cases}', tip: 'cases · \\begin{cases}' },
];
const MAX_MATH_FAVORITES = 100;
const MAX_FAVORITE_LENGTH = 2000;

export interface UserPrefs {
  /** Exactly QUICK_EMOJI_SLOTS entries when present; absent = defaults. */
  quickEmojis?: string[];
  /** Math Favorites (the `자주 사용` palette tab); absent = DEFAULT_MATH_FAVORITES, [] = the user removed them all. */
  favoriteMathExpressions?: MathFavorite[];
  /** Fields written by other versions of the app are carried along untouched. */
  [unknown: string]: unknown;
}

const graphemes = (s: string): number =>
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length : [...s].length;

/** A usable quick emoji is one non-blank grapheme cluster (ZWJ sequences, flags and keycaps count as one). */
export function isQuickEmoji(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 32 && v.trim() === v && graphemes(v) === 1;
}

/**
 * Always returns exactly 10 valid entries. Anything that is not an array of exactly 10 falls back to the
 * defaults as a whole; within a correctly sized array an unusable entry falls back to its own slot's default.
 */
export function resolveQuickEmojis(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length !== QUICK_EMOJI_SLOTS) return [...DEFAULT_QUICK_EMOJIS];
  return raw.map((v, i) => (isQuickEmoji(v) ? v : DEFAULT_QUICK_EMOJIS[i]));
}

const str = (v: unknown, max = MAX_FAVORITE_LENGTH) => (typeof v === 'string' && v.length <= max ? v : undefined);

/** One stored favorite → a clean MathFavorite, or null when unusable (`pre` must be a non-blank string). */
function resolveMathFavorite(raw: unknown): MathFavorite | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pre = str(r.pre);
  if (!pre || !pre.trim()) return null;
  const f: MathFavorite = { pre };
  const post = str(r.post), show = str(r.show), tip = str(r.tip);
  if (post) f.post = post;
  if (show) f.show = show;
  if (tip) f.tip = tip;
  if (r.wrap === true) f.wrap = true;
  if (typeof r.wrapCaret === 'number' && Number.isInteger(r.wrapCaret) && r.wrapCaret >= 0 && r.wrapCaret <= MAX_FAVORITE_LENGTH) f.wrapCaret = r.wrapCaret;
  return f;
}

/** Anything that is not an array falls back to the defaults; unusable entries of a real array are dropped ([] stays empty). */
export function resolveMathFavorites(raw: unknown): MathFavorite[] {
  if (!Array.isArray(raw)) return DEFAULT_MATH_FAVORITES.map((f) => ({ ...f }));
  return raw.slice(0, MAX_MATH_FAVORITES).flatMap((r) => { const f = resolveMathFavorite(r); return f ? [f] : []; });
}

/** The complete LaTeX a favorite stands for; a favorite "matches" an expression when this equals it exactly (ends trimmed). */
export const mathFavoriteText = (f: MathFavorite) => f.pre + (f.post ?? '');
export const isMathFavoriteText = (list: readonly MathFavorite[], latex: string) => { const t = latex.trim(); return !!t && list.some((f) => mathFavoriteText(f) === t); };

/** Parse whatever was stored (possibly missing or malformed) into a prefs object; never throws. */
export function normalizeUserPrefs(raw: unknown): UserPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const { quickEmojis, favoriteMathExpressions, ...rest } = raw as Record<string, unknown>;
  const prefs: UserPrefs = { ...rest };
  if (quickEmojis !== undefined) prefs.quickEmojis = resolveQuickEmojis(quickEmojis);
  if (favoriteMathExpressions !== undefined) prefs.favoriteMathExpressions = resolveMathFavorites(favoriteMathExpressions);
  return prefs;
}
