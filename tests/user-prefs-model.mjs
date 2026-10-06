/** Pure logic of the user-preference model (headless, no Electron). Run: node tests/user-prefs-model.mjs */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configLoader: 'runner', cacheDir: await mkdtemp(path.join(tmpdir(), 'mathslides-vite-')), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const m = await server.ssrLoadModule('/src/model/userPrefs.ts');
  const D = ['💡', 'ℹ️', '⚠️', '✅', '❌', '📌', '🔥', '💬', '⭐', '🚀'];
  assert.deepEqual(m.DEFAULT_QUICK_EMOJIS, D, 'v1 defaults unchanged');
  assert.deepEqual(m.resolveQuickEmojis(undefined), D);
  for (const bad of [null, 'x', 5, {}, [], D.slice(1), [...D, '🧠']]) assert.deepEqual(m.resolveQuickEmojis(bad), D, 'bad shape -> defaults');
  const custom = ['🧠', '💡', '🔥', '🚨', '👀', '✨', '🤖', '📌', '✅', '❓'];
  assert.deepEqual(m.resolveQuickEmojis(custom), custom, 'custom 10 kept in order');
  assert.deepEqual(m.resolveQuickEmojis(['👨‍👩‍👧‍👦', '1️⃣', '🇰🇷', ...D.slice(3)]).slice(0, 3), ['👨‍👩‍👧‍👦', '1️⃣', '🇰🇷'], 'ZWJ/keycap/flag are single emoji');
  const mixed = m.resolveQuickEmojis(['', 5, null, ' ', 'ab', '🧠🧠', ...D.slice(6)]);
  assert.deepEqual(mixed, [...D.slice(0, 6), ...D.slice(6)], 'unusable entries fall back per slot');
  assert.equal(mixed.length, 10);
  assert.deepEqual(m.normalizeUserPrefs('x'), {}); assert.deepEqual(m.normalizeUserPrefs(null), {}); assert.deepEqual(m.normalizeUserPrefs([1]), {});
  assert.deepEqual(m.normalizeUserPrefs({ version: 1, future: { a: 1 } }), { version: 1, future: { a: 1 } }, 'unknown fields preserved');
  assert.deepEqual(m.normalizeUserPrefs({ quickEmojis: 'bad' }).quickEmojis, D);

  // The preference store never touches deck state or its dirty flag; the deck type has no prefs field.
  const { useStore } = await server.ssrLoadModule('/src/store/store.ts');
  const p = await server.ssrLoadModule('/src/store/userPrefs.ts');
  const before = JSON.stringify(useStore.getState().deck), save = useStore.getState().saveState;
  let notified = 0; const off = p.subscribeUserPrefs(() => notified++);
  assert.deepEqual(p.getQuickEmojis(), D);
  p.setQuickEmoji(2, '🧠'); p.setQuickEmoji(99, 'x'); p.setQuickEmoji(1, 'not-an-emoji');
  assert.deepEqual(p.getQuickEmojis(), ['💡', 'ℹ️', '🧠', ...D.slice(3)], 'slot replaced; invalid slot/emoji ignored or defaulted');
  assert.ok(notified >= 1, 'subscribers notified');
  p.resetQuickEmojis(); assert.deepEqual(p.getQuickEmojis(), D, 'reset');
  off();
  assert.equal(JSON.stringify(useStore.getState().deck), before, 'deck unchanged by preference changes');
  assert.equal(useStore.getState().saveState, save, 'not dirtied');
  assert.ok(!before.includes('🧠') && !before.includes('quickEmojis'));
  // ---- Math Favorites ----
  const DEF_TIPS = ['rho · \\rho', 'theta · \\theta', 'lambda · \\lambda', 'R · \\mathbb{R}', 'E · \\mathbb{E}', 'bold · \\mathbf{}', 'norm · \\lVert x\\rVert', 'fraction · \\frac{}{}', 'sum · \\sum_{}^{}', 'cases · \\begin{cases}'];
  assert.deepEqual(m.DEFAULT_MATH_FAVORITES.map((f) => f.tip), DEF_TIPS, 'defaults = the former 자주 사용 items, in order');
  const pal = await server.ssrLoadModule('/src/editor/mathPaletteItems.ts');
  assert.deepEqual(pal.MATH_CATEGORIES[0].items.map((i) => i.tip), DEF_TIPS, 'palette default tab unchanged');
  for (const bad of [undefined, null, 'x', 5, {}]) assert.deepEqual(m.resolveMathFavorites(bad), m.DEFAULT_MATH_FAVORITES.map((f) => ({ ...f })), 'non-array -> defaults');
  assert.deepEqual(m.resolveMathFavorites([]), [], 'an empty list is respected (user removed all)');
  assert.deepEqual(m.resolveMathFavorites([{ pre: 'x^2' }, null, 5, { pre: '' }, { pre: '  ' }, { post: 'y' }, { pre: '\\frac{', post: '}{}', wrap: true, wrapCaret: 2, junk: 1 }]),
    [{ pre: 'x^2' }, { pre: '\\frac{', post: '}{}', wrap: true, wrapCaret: 2 }], 'unusable entries dropped, unknown fields stripped');
  assert.equal(m.resolveMathFavorites(Array.from({ length: 500 }, (_, i) => ({ pre: 'a' + i }))).length, 100, 'bounded');
  assert.deepEqual(m.normalizeUserPrefs({ version: 1, quickEmojis: custom }).favoriteMathExpressions, undefined, 'older record without favorites stays unset (-> defaults)');
  assert.deepEqual(m.normalizeUserPrefs({ favoriteMathExpressions: 'bad', quickEmojis: custom }).quickEmojis, custom, 'bad favorites never touch quickEmojis');
  assert.equal(m.isMathFavoriteText([{ pre: 'a+b' }, { pre: '\\mathbf{', post: '}' }], ' a+b '), true);
  assert.equal(m.isMathFavoriteText([{ pre: 'a+b' }], 'a + b'), false, 'exact comparison, no LaTeX normalization');
  assert.equal(m.isMathFavoriteText([{ pre: 'a' }], '  '), false);
  const before2 = JSON.stringify(useStore.getState().deck), save2 = useStore.getState().saveState, past2 = useStore.getState().past.length;
  let n2 = 0; const off2 = p.subscribeUserPrefs(() => n2++);
  assert.deepEqual(p.getMathFavorites().map((f) => f.tip), DEF_TIPS, 'store starts at defaults');
  assert.equal(p.getMathFavorites(), p.getMathFavorites(), 'snapshot is referentially stable (React subscription)');
  p.toggleMathFavorite('L(\\theta) =  ');
  assert.deepEqual(p.getMathFavorites()[0], { pre: 'L(\\theta) =' }, 'added at the front, trimmed'); assert.equal(p.getMathFavorites().length, 11);
  p.toggleMathFavorite('L(\\theta) ='); assert.equal(p.getMathFavorites().length, 10, 'second toggle removes, no duplicate');
  p.toggleMathFavorite('   '); assert.equal(p.getMathFavorites().length, 10, 'blank is ignored');
  p.toggleMathFavorite('\\rho'); assert.equal(p.getMathFavorites().length, 9, 'an expression equal to a default item toggles that item off');
  p.removeMathFavoriteAt(0); assert.equal(p.getMathFavorites().length, 8);
  p.setQuickEmoji(0, '🧠'); assert.equal(p.getMathFavorites().length, 8, 'quick emoji change leaves favorites alone');
  p.resetMathFavorites(); assert.deepEqual(p.getMathFavorites().map((f) => f.tip), DEF_TIPS, 'reset restores defaults');
  assert.equal(p.getQuickEmojis()[0], '🧠', 'reset of favorites leaves quick emojis alone'); p.resetQuickEmojis();
  assert.ok(n2 >= 5, 'subscribers notified');
  off2();
  assert.equal(JSON.stringify(useStore.getState().deck), before2); assert.equal(useStore.getState().saveState, save2); assert.equal(useStore.getState().past.length, past2, 'favorites never touch presentation state');
  assert.ok(!before2.includes('favoriteMathExpressions'));
  // ---- My Colors (saved colors) ----
  assert.deepEqual(m.resolveSavedColors(undefined), [], 'default is empty'); for (const bad of [null, 'x', 5, {}]) assert.deepEqual(m.resolveSavedColors(bad), [], 'non-array -> []');
  assert.deepEqual(m.resolveSavedColors(['#7c3aed', '7C3AED', '#0f0', 'nope', 5, null, '#12345', '#F97316']), ['#7C3AED', '#00FF00', '#F97316'], 'normalized, deduplicated, invalid dropped');
  assert.equal(m.resolveSavedColors(Array.from({ length: 80 }, (_, i) => '#' + (i * 1000 + 4096).toString(16).padStart(6, '0'))).length, 30, 'bounded');
  assert.equal(m.normalizeUserPrefs({ quickEmojis: custom }).savedColors, undefined, 'older record without savedColors is fine');
  assert.deepEqual(m.normalizeUserPrefs({ savedColors: 'bad', quickEmojis: custom }), { savedColors: [], quickEmojis: custom }, 'malformed -> [], other fields kept');
  const dk = JSON.stringify(useStore.getState().deck), ds = useStore.getState().saveState, dp = useStore.getState().past.length;
  p.setQuickEmoji(1, '🧠'); p.toggleMathFavorite('zz+1');
  assert.deepEqual(p.getSavedColors(), [], 'store starts empty');
  assert.equal(p.getSavedColors(), p.getSavedColors(), 'snapshot is referentially stable');
  p.saveColor('#7c3aed'); p.saveColor('#F97316'); p.saveColor('7C3AED'); p.saveColor('nope'); p.saveColor('#0f0');
  assert.deepEqual(p.getSavedColors(), ['#00FF00', '#F97316', '#7C3AED'], 'newest first, normalized, no duplicate, invalid ignored');
  p.removeSavedColor('#f97316'); assert.deepEqual(p.getSavedColors(), ['#00FF00', '#7C3AED'], 'removal (any case)');
  for (let i = 0; i < 40; i++) p.saveColor('#' + (0x100000 + i * 37).toString(16)); assert.equal(p.getSavedColors().length, 30, 'cap enforced by the store');
  assert.equal(p.getQuickEmojis()[1], '🧠', 'quick emojis untouched by saved colors'); assert.equal(p.getMathFavorites()[0].pre, 'zz+1', 'math favorites untouched');
  p.resetQuickEmojis(); p.resetMathFavorites();
  assert.equal(JSON.stringify(useStore.getState().deck), dk); assert.equal(useStore.getState().saveState, ds); assert.equal(useStore.getState().past.length, dp, 'saved colors never touch presentation state');
  console.log('PASS user preferences model + store (defaults, fallback, slots, reset, deck untouched)');
} finally { await server.close(); }
