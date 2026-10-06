/** Math Favorites: ☆/★ in the equation editor, the personalized 자주 사용 palette tab, management, persistence.
 * Real Electron windows on a disposable profile. Run: node tests/emoji-tool.mjs (needs a graphical session).
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { testElectronEnv } from './electron-env.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-mathfav-profile-'));
const probe = netServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const debugPort = probe.address().port;
await new Promise((r) => probe.close(r));
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: 5190, strictPort: true } });
await server.listen();
const wrapper = path.join(profile, 'main.cjs');
await writeFile(wrapper, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});\n`);


const DEF_TIPS = ['rho · \\rho', 'theta · \\theta', 'lambda · \\lambda', 'R · \\mathbb{R}', 'E · \\mathbb{E}', 'bold · \\mathbf{}', 'norm · \\lVert x\\rVert', 'fraction · \\frac{}{}', 'sum · \\sum_{}^{}', 'cases · \\begin{cases}'];
const EXPR = '\\mathbb{E}_{x \\sim p(x)}[f(x)]';
let electron, socket, id = 0;
const pending = new Map();
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));
async function until(fn, message, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { try { const v = await fn(); if (v) return v; } catch {} await pause(100); }
  throw new Error(message);
}
const send = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function launch() {
  electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`], { cwd: root, env: testElectronEnv({ ELECTRON_DEV_URL: 'http://127.0.0.1:5190' }), stdio: ['ignore', 'pipe', 'pipe'] });
  electron.stderr.on('data', () => {});
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 'debug target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => { const d = JSON.parse(e.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(Error(d.error.message)) : p.resolve(d.result); } });
  await send('Runtime.enable');
  await until(() => evaluate(`!!document.querySelector('.propsbar')`), 'app mount');
  await evaluate(`(async () => { window.store = (await import('/src/store/store.ts')).useStore; window.active = (await import('/src/editor/active.ts')).getActiveEditor;
    window.defaults = await import('/src/model/defaults.ts'); window.insert = await import('/src/canvas/insert.ts'); window.prefs = await import('/src/store/userPrefs.ts'); window.idb = await import('/node_modules/idb-keyval/dist/index.js'); })()`);
}
async function quit() { socket?.close(); if (electron?.exitCode === null) { electron.kill('SIGTERM'); await new Promise((r) => electron.once('exit', r)); } }
const click = async (sel) => {
  const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw Error('Missing ' + ${JSON.stringify(sel)}); const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...r });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...r }); await pause(200);
};
const settled = () => until(() => evaluate("store.getState().saveState === 'saved'"), 'autosave settled');
const setTa = (v, s = v.length, e = s) => evaluate(`(() => { const t = document.querySelector('.math-input'); t.focus(); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(v)}); t.dispatchEvent(new Event('input', {bubbles: true})); t.setSelectionRange(${s}, ${e}); })()`).then(() => pause(150));
const ta = () => evaluate(`(() => { const t = document.querySelector('.math-input'); return { v: t.value, s: t.selectionStart, e: t.selectionEnd }; })()`);
const star = () => evaluate(`(() => { const b = document.querySelector('.math-fav-btn'); return b ? { text: b.textContent, on: b.classList.contains('on'), pressed: b.getAttribute('aria-pressed') } : null; })()`);
const pressStar = () => evaluate(`(() => { const b = document.querySelector('.math-fav-btn'); b.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true})); b.click(); })()`).then(() => pause(200));
const tips = () => evaluate(`[...document.querySelectorAll('.math-pal-grid .math-pal-cell')].map((c) => c.getAttribute('aria-label'))`);
const cell = (label) => evaluate(`(() => { const b = [...document.querySelectorAll('.math-pal-cell')].find((c) => c.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!b) throw Error('no cell ' + ${JSON.stringify(label)}); b.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true})); b.click(); })()`).then(() => pause(200));
const tool = (sel) => evaluate(`(() => { const b = document.querySelector(${JSON.stringify('.math-pal-tools ' + '$S')}); b.click(); })()`.replace('$S', sel)).then(() => pause(200));
const mathNodes = () => evaluate(`JSON.stringify(store.getState().deck).match(/"latex":"(?:[^"\\\\]|\\\\.)*"/g)`);
const stored = () => evaluate(`idb.get('prefs:v1').then((v) => JSON.stringify(v ?? null))`);
async function newMath() { await evaluate('insert.insertMathBox()'); await until(() => evaluate(`!!document.querySelector('.math-popover .math-input')`), 'math popover'); await pause(200); }
async function openPalette() { await click('.math-pal-btn'); await until(() => evaluate(`!!document.querySelector('.math-palette')`), 'palette'); }
const doneMath = () => evaluate(`[...document.querySelectorAll('.math-popover .btn')].find((b) => /Done/.test(b.textContent)).click()`).then(() => pause(250));

try {
  await launch();
  // --- default Favorites = the former 자주 사용 items, rendered as math; ☆ initially ---
  await newMath(); await openPalette();
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.math-pal-tabs button')].map((b) => b.textContent)`), ['자주 사용', '그리스', '연산', '스타일', '구조'], 'no new tab');
  assert.deepEqual(await tips(), DEF_TIPS, 'default favorites = existing defaults, same order');
  assert.equal(await evaluate(`[...document.querySelectorAll('.math-pal-cell')].every((c) => c.querySelector('svg'))`), true, 'rendered as math');
  assert.deepEqual((await star()).text, '☆'); assert.equal((await evaluate(`document.querySelector('.math-fav-btn').disabled`)), true, 'nothing to favorite while empty');
  console.log('PASS default Math Favorites + ☆ on an empty expression');

  // --- favorite a NEW expression: ☆ -> ★, palette updates live, toggle off, no duplicates ---
  await settled();
  await setTa(EXPR); await settled();
  const deckA = await evaluate('JSON.stringify(store.getState().deck)'), past0 = await evaluate('store.getState().past.length');
  assert.equal((await star()).text, '☆');
  await pressStar();
  assert.deepEqual(await star(), { text: '★', on: true, pressed: 'true' }, 'now a favorite');
  assert.equal((await tips())[0], EXPR, 'palette tab shows it immediately, at the front, rendered');
  assert.equal((await tips()).length, 11);
  assert.equal(await evaluate('JSON.stringify(store.getState().deck)'), deckA, 'favoriting does not touch the presentation');
  assert.equal(await evaluate('store.getState().saveState'), 'saved', 'not dirtied'); assert.equal(await evaluate('store.getState().past.length'), past0, 'no undo step');
  assert.ok(!(await evaluate('JSON.stringify(store.getState().deck)')).includes('favoriteMathExpressions'), 'not serialized into the deck');
  await pressStar(); assert.equal((await star()).text, '☆', '★ removes'); assert.equal((await tips()).length, 10);
  await pressStar(); await pressStar(); await pressStar();
  assert.equal((await tips()).length, 11, 'repeated presses never duplicate'); assert.equal((await star()).text, '★');
  console.log('PASS ☆/★ on a new expression (live palette, toggle, no duplicates, no presentation state)');

  // --- star follows the current expression ---
  await setTa(EXPR + ' + 1'); assert.equal((await star()).text, '☆', 'edited into a non-favorite');
  await setTa(EXPR); assert.equal((await star()).text, '★', 'back to the favorite');

  // --- clicking a Favorite inserts at the cursor with existing palette semantics ---
  await setTa('L(\\theta) = '); await cell(EXPR);
  assert.deepEqual(await ta(), { v: 'L(\\theta) = ' + EXPR, s: ('L(\\theta) = ' + EXPR).length, e: ('L(\\theta) = ' + EXPR).length }, 'inserted at the cursor, caret after');
  await setTa('a+b', 1); await cell('rho · \\rho'); assert.equal((await ta()).v, 'a\\rho+b', 'built-in default favorites still insert as before');
  await setTa('x', 0, 1); await cell('bold · \\mathbf{}'); assert.equal((await ta()).v, '\\mathbf{x}', 'wrap default favorite still wraps the selection');
  console.log('PASS Favorite insertion at the cursor (same semantics as palette items)');

  // --- existing Math element: favorite it directly from its own editor ---
  await setTa('\\int_0^1 x^2\\,dx'); await doneMath();
  await evaluate('store.getState().stopEditing()'); await pause(300);
  await settled();
  const elId = await evaluate(`store.getState().deck.slides[store.getState().deck.slides.findIndex((s) => s.id === store.getState().currentSlideId)].elements.at(-1).id`);
  await evaluate(`store.getState().startEditing(${JSON.stringify(elId)})`); await until(() => evaluate('!!active()'), 'editor'); await pause(300);
  await click('.el.editing .math-block'); await until(() => evaluate(`!!document.querySelector('.math-popover .math-input')`), 'existing math popover'); await pause(300);
  assert.equal((await ta()).v, '\\int_0^1 x^2\\,dx'); assert.equal((await star()).text, '☆');
  const deckB = await evaluate('JSON.stringify(store.getState().deck)'), pastB = await evaluate('store.getState().past.length'), saveB = await evaluate('store.getState().saveState');
  await pressStar();
  assert.equal((await star()).text, '★'); assert.equal(await evaluate('JSON.stringify(store.getState().deck)'), deckB, 'the existing element is untouched');
  assert.equal(await evaluate('store.getState().past.length'), pastB); assert.equal(await evaluate('store.getState().saveState'), saveB);
  assert.ok((await stored()).includes('\\\\int_0^1 x^2\\\\,dx'), 'stored as a user preference');
  await doneMath(); await evaluate('store.getState().stopEditing()'); await pause(200);
  console.log('PASS favoriting an EXISTING Math element directly');

  // --- opening an expression that already is a favorite shows ★ ---
  await newMath(); await setTa('\\int_0^1 x^2\\,dx'); assert.equal((await star()).text, '★', 'already-favorite expression opens as ★'); await doneMath(); await evaluate('store.getState().stopEditing()');

  // --- persistence: New Presentation, restart ---
  await evaluate(`document.querySelector('.logo').click()`); await pause(300);
  await evaluate(`[...document.querySelectorAll('.menu-item')].find((e) => e.textContent.includes('새 프레젠테이션')).click()`); await pause(700);
  await newMath(); await openPalette();
  assert.deepEqual((await tips()).slice(0, 2), ['\\int_0^1 x^2\\,dx', EXPR], 'survives New Presentation (newest first)'); await doneMath().catch(() => {});
  await pause(600); await quit(); await launch();
  await newMath(); await openPalette();
  assert.deepEqual((await tips()).slice(0, 2), ['\\int_0^1 x^2\\,dx', EXPR], 'survives a full restart'); assert.equal((await tips()).length, 12);
  console.log('PASS persistence (New Presentation, restart)');

  // --- management: remove, reset; empty state; Quick Emojis unaffected ---
  await evaluate(`prefs.setQuickEmoji(0, '🧠')`);
  await tool('.edit'); assert.equal(await evaluate(`document.querySelectorAll('.math-pal-cell.removing').length`), 12, 'manage mode marks cells');
  const mathBefore = await ta().catch(() => null);
  await cell('\\int_0^1 x^2\\,dx'); assert.equal((await tips()).length, 11, 'removed from manage mode'); assert.equal((await tips())[0], EXPR);
  await tool('.reset'); assert.deepEqual(await tips(), DEF_TIPS, 'Reset to Default restores the original set');
  assert.ok(!(await stored()).includes('favoriteMathExpressions'), 'override removed');
  assert.equal(await evaluate(`prefs.getQuickEmojis()[0]`), '🧠', 'Quick Emojis unaffected by favorites reset'); await evaluate('prefs.resetQuickEmojis()');
  for (let i = 0; i < 10; i++) await cell(DEF_TIPS[i]).catch(() => {});
  assert.equal((await tips()).length, 0, 'all removed'); assert.match(await evaluate(`document.querySelector('.math-pal-empty')?.textContent ?? ''`), /즐겨찾기가 없습니다/);
  await tool('.reset'); await tool('.edit'); assert.equal(await evaluate(`document.querySelectorAll('.math-pal-cell.removing').length`), 0, '완료 leaves manage mode');
  await cell('rho · \\rho'); assert.equal((await ta()).v.includes('\\rho'), true, 'cells insert again outside manage mode');
  console.log('PASS management (remove, Reset, empty state, ✎/완료), Quick Emojis unaffected');
  console.log('ALL PASS');
} finally {
  await quit().catch(() => {});
  await server.close();
}
