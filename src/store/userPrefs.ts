import { get, set } from 'idb-keyval';
import { QUICK_EMOJI_SLOTS, isMathFavoriteText, mathFavoriteText, normalizeUserPrefs, resolveMathFavorites, resolveQuickEmojis, type MathFavorite, type UserPrefs } from '../model/userPrefs';

/**
 * User-scoped preference store: one versioned IndexedDB record (`prefs:v1`, same storage family as the deck
 * autosave but an independent key) mirrored in a synchronous in-memory copy so UI code (e.g. the Callout node
 * view) can read it without awaiting. It is deliberately separate from the deck store: it never touches deck
 * autosave, recovery, `.mslides` files or undo history, and changing a preference does not dirty a presentation.
 */
const KEY = 'prefs:v1';
let prefs: UserPrefs = {};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const subscribeUserPrefs = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Startup: read the stored record; missing, unreadable or malformed data silently means defaults. */
export async function loadUserPrefs() {
  try { prefs = normalizeUserPrefs(await get(KEY)); } catch (e) { console.error('user preferences load failed', e); prefs = {}; }
  emit();
}

/** A failed write (e.g. storage unavailable) leaves the in-memory preference working for this session. */
async function persist(value: UserPrefs) {
  try { await set(KEY, value); } catch (e) { console.error('user preferences save failed', e); }
}

function update(patch: Partial<UserPrefs>) {
  prefs = { ...prefs, ...patch };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete prefs[k];
  emit();
  void persist({ version: 1, ...prefs });
}

export const getQuickEmojis = (): string[] => resolveQuickEmojis(prefs.quickEmojis);

/** Replace one slot (0-9); the result is always exactly 10 entries. */
export function setQuickEmoji(slot: number, emoji: string) {
  if (!(slot >= 0 && slot < QUICK_EMOJI_SLOTS)) return;
  const next = getQuickEmojis();
  next[slot] = emoji;
  update({ quickEmojis: resolveQuickEmojis(next) });
}

/** Back to the v1 defaults (the stored override is removed). */
export const resetQuickEmojis = () => update({ quickEmojis: undefined });

// ---------- Math Favorites (the `자주 사용` tab of the Math palette) ----------

let favCache: { raw: unknown; value: readonly MathFavorite[] } | null = null;
/** Stable between changes (same array until the stored preference changes), so React can subscribe to it. */
export function getMathFavorites(): readonly MathFavorite[] {
  const raw = prefs.favoriteMathExpressions;
  if (!favCache || favCache.raw !== raw) favCache = { raw, value: resolveMathFavorites(raw) };
  return favCache.value;
}
const setMathFavorites = (list: MathFavorite[]) => update({ favoriteMathExpressions: list });

/** Star toggle for the complete current expression: adds it (at the front, no duplicates) or removes the exact match. */
export function toggleMathFavorite(latex: string) {
  const t = latex.trim();
  if (!t) return;
  const list = getMathFavorites();
  if (isMathFavoriteText(list, t)) setMathFavorites(list.filter((f) => mathFavoriteText(f) !== t));
  else setMathFavorites([{ pre: t }, ...list]);
}
export const removeMathFavoriteAt = (index: number) => setMathFavorites(getMathFavorites().filter((_, i) => i !== index));
/** Back to the original `자주 사용` items (the stored override is removed). */
export const resetMathFavorites = () => update({ favoriteMathExpressions: undefined });
