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
  console.log('PASS user preferences model + store (defaults, fallback, slots, reset, deck untouched)');
} finally { await server.close(); }
