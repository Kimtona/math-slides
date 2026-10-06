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

export interface UserPrefs {
  /** Exactly QUICK_EMOJI_SLOTS entries when present; absent = defaults. */
  quickEmojis?: string[];
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

/** Parse whatever was stored (possibly missing or malformed) into a prefs object; never throws. */
export function normalizeUserPrefs(raw: unknown): UserPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const { quickEmojis, ...rest } = raw as Record<string, unknown>;
  const prefs: UserPrefs = { ...rest };
  if (quickEmojis !== undefined) prefs.quickEmojis = resolveQuickEmojis(quickEmojis);
  return prefs;
}
