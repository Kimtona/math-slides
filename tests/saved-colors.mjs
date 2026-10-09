/** My Colors: saved custom colors shared by the color palettes, HEX/eyedropper custom flow, persistence.
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
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-colors-profile-'));
const probe = netServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const debugPort = probe.address().port;
await new Promise((r) => probe.close(r));
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: 5191, strictPort: true } });
await server.listen();
const wrapper = path.join(profile, 'main.cjs');
await writeFile(wrapper, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});\n`);



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
  electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`], { cwd: root, env: testElectronEnv({ ELECTRON_DEV_URL: 'http://127.0.0.1:5191' }), stdio: ['ignore', 'pipe', 'pipe'] });
  electron.stderr.on('data', () => {});
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 'debug target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => { const d = JSON.parse(e.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(Error(d.error.message)) : p.resolve(d.result); } });
  await send('Runtime.enable');
  await until(() => evaluate(`!!document.querySelector('.propsbar')`), 'app mount');
  await evaluate(`(async () => { window.store = (await import('/src/store/store.ts')).useStore; window.defaults = await import('/src/model/defaults.ts'); window.prefs = await import('/src/store/userPrefs.ts'); window.idb = await import('/node_modules/idb-keyval/dist/index.js'); })()`);
}
async function quit() { socket?.close(); if (electron?.exitCode === null) { electron.kill('SIGTERM'); await new Promise((r) => electron.once('exit', r)); } }
const click = async (sel) => {
  const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw Error('Missing ' + ${JSON.stringify(sel)}); const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...r });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...r }); await pause(200);
};
const settled = () => until(() => evaluate("store.getState().saveState === 'saved'"), 'autosave settled');
const deck = () => evaluate('JSON.stringify(store.getState().deck)');
const past = () => evaluate('store.getState().past.length');
const stored = () => evaluate(`idb.get('prefs:v1').then((v) => JSON.stringify(v ?? null))`);
const mine = (scope = '.pop') => evaluate(`[...document.querySelectorAll(${JSON.stringify(scope + ' .my-colors .text-swatch:not(.add)')})].map((b) => b.style.backgroundColor)`);
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };
const setHex = (v) => evaluate(`(() => { const t = document.querySelector('.custom-color input[aria-label="HEX color"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(t, ${JSON.stringify(v)}); t.dispatchEvent(new Event('input', {bubbles: true})); })()`).then(() => pause(120));
const TEXT = '.propsbar button[title^="글자 색 (Text Color)"]', HILITE = '.propsbar button[title^="강조 (Highlight)"]', FILL = '.propsbar button[title^="채우기 (Fill)"]', BORDER = '.propsbar button[title^="테두리 (Border)"]';
async function openPal(btn, sel) { await click(btn); await until(() => evaluate(`!!document.querySelector(${JSON.stringify(sel)})`), 'palette ' + btn); }
async function closePal() { await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`); await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: 5, y: 700 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: 5, y: 700 }); await pause(200); }
async function selectNew(kind) {
  await evaluate(`store.getState().addElements([${kind === 'text' ? "defaults.newText(100,200,{w:400})" : "defaults.newShape('rect',100,300)"}])`); await pause(300); await settled();
}

try {
  await launch();
  // --- empty by default; text element palette ---
  await selectNew('text');
  await openPal(TEXT, '.text-palette');
  assert.deepEqual(await mine(), [], 'My Colors starts empty'); assert.equal(await evaluate(`document.querySelectorAll('.text-palette .my-colors .text-swatch.add').length`), 1, '+ is present');
  assert.equal(await stored(), 'null', 'nothing stored yet');
  console.log('PASS My Colors starts empty with a + control');

  // --- HEX -> preview -> Save (explicit), not applied ---
  const d0 = await deck(), p0 = await past();
  await click('.text-palette .my-colors .add'); await until(() => evaluate(`!!document.querySelector('.custom-color')`), 'custom form');
  await setHex('#7c3aed');
  assert.equal(await evaluate(`document.querySelector('.custom-preview').style.backgroundColor`), rgb('#7C3AED'), 'preview follows the HEX');
  await click('.custom-color .save-color'); await pause(200);
  assert.deepEqual(await mine(), [rgb('#7C3AED')], 'saved, normalized');
  assert.equal(await deck(), d0, 'saving does not apply the color'); assert.equal(await past(), p0, 'no undo step'); assert.equal(await evaluate('store.getState().saveState'), 'saved', 'not dirtied');
  assert.equal(await evaluate(`document.querySelector('.custom-color .save-color').disabled`), true, 'already saved: no duplicate');
  await setHex('#0f0'); await click('.custom-color .save-color'); await setHex('#f97316'); await click('.custom-color .save-color'); await setHex('zzz');
  assert.equal(await evaluate(`document.querySelector('.custom-color .save-color').disabled`), true, 'invalid HEX cannot be saved');
  assert.deepEqual(await mine(), [rgb('#F97316'), rgb('#00FF00'), rgb('#7C3AED')], 'newest first, shorthand expanded');
  assert.ok((await stored()).includes('"savedColors":["#F97316","#00FF00","#7C3AED"]'), 'persisted normalized');
  assert.ok(!(await deck()).includes('savedColors') && !(await deck()).includes('#7C3AED'), 'not serialized into the presentation');
  console.log('PASS HEX → preview → explicit Save (normalized, no duplicates, newest first, no presentation state)');

  // --- eyedropper wiring (stubbed API; real screen sampling is not automated) ---
  assert.equal(await evaluate(`typeof window.EyeDropper`), 'function', 'EyeDropper exists in this Electron');
  assert.equal(await evaluate(`document.querySelectorAll('.custom-color .eyedropper').length`), 1, 'eyedropper button shown');
  await closePal();
  await evaluate(`window.EyeDropper = class { open() { return Promise.resolve({ sRGBHex: '#abcdef' }); } }`);
  await openPal(TEXT, '.text-palette'); await click('.text-palette .palette-other:last-of-type'); await until(() => evaluate(`!!document.querySelector('.custom-color')`), 'form');
  await click('.custom-color .eyedropper'); await pause(200);
  assert.equal(await evaluate(`document.querySelector('.custom-color input[aria-label="HEX color"]').value`), '#ABCDEF', 'sampled color fills the HEX field');
  assert.equal(await evaluate(`document.querySelector('.custom-preview').style.backgroundColor`), rgb('#ABCDEF'), 'and the preview');
  assert.deepEqual(await mine(), [rgb('#F97316'), rgb('#00FF00'), rgb('#7C3AED')], 'sampling alone saves nothing');
  console.log('PASS eyedropper → HEX + preview, nothing auto-saved');

  // --- Apply without saving is normal presentation editing ---
  await setHex('#112233'); await click('.custom-color button'); await pause(300); // first button = Apply, as in the older suites
  assert.notEqual(await deck(), d0, 'applying changes the presentation'); assert.ok((await deck()).includes('#112233')); assert.equal(await past(), p0 + 1, 'one undo step');
  await openPal(TEXT, '.text-palette');
  assert.deepEqual(await mine(), [rgb('#F97316'), rgb('#00FF00'), rgb('#7C3AED')], 'applied-but-unsaved color is not in My Colors');
  // applying a My Colors swatch = ordinary swatch path
  const pB = await past();
  await click('.text-palette .my-colors .text-swatch:not(.add)'); await pause(300);
  assert.ok((await deck()).includes('#F97316'), 'swatch applied through the normal path'); assert.equal(await past(), pB + 1, 'one undo step');
  await evaluate('store.getState().undo()'); assert.ok(!(await deck()).includes('#F97316'), 'undoable');
  console.log('PASS Apply (unsaved) and My Colors swatch are ordinary presentation edits');

  // --- shared across surfaces: Fill, Border, Highlight ---
  await selectNew('shape');
  const saved3 = [rgb('#F97316'), rgb('#00FF00'), rgb('#7C3AED')];
  await openPal(FILL, '.text-palette'); assert.deepEqual(await mine('.text-palette'), saved3, 'Shape Fill shows My Colors');
  await click('.text-palette .my-colors .text-swatch:nth-last-child(2)'); await pause(300);
  assert.equal(await evaluate(`store.getState().deck.slides[store.getState().deck.slides.findIndex((s) => s.id === store.getState().currentSlideId)].elements.at(-1).fill`), '#7C3AED', 'saved color applied as the fill');
  await openPal(BORDER, '.text-palette'); assert.deepEqual(await mine('.text-palette'), saved3, 'Shape Border shows the same list'); await closePal();
  await evaluate(`store.getState().addElements([defaults.newText(100,500,{w:300})],{edit:true})`); await pause(400);
  await openPal(HILITE, '.text-palette'); assert.deepEqual(await mine('.text-palette'), saved3, 'Highlight shows the same list'); await closePal();
  await evaluate('store.getState().stopEditing()'); await pause(200);
  console.log('PASS one shared list across Text / Fill / Border / Highlight');

  // --- remove (manage mode) ---
  await selectNew('text'); await settled();
  const dR = await deck(), pR = await past();
  await openPal(TEXT, '.text-palette'); await click('.text-palette .palette-tool');
  assert.equal(await evaluate(`document.querySelectorAll('.text-palette .text-swatch.removing').length`), 3);
  await click('.text-palette .text-swatch.removing'); await pause(200);
  assert.deepEqual(await mine(), [rgb('#00FF00'), rgb('#7C3AED')], 'removed the clicked color');
  assert.equal(await deck(), dR); assert.equal(await past(), pR); assert.equal(await evaluate('store.getState().saveState'), 'saved', 'removal is not presentation editing');
  await click('.text-palette .palette-tool'); assert.equal(await evaluate(`document.querySelectorAll('.text-palette .text-swatch.removing').length`), 0, '완료 leaves manage mode');
  console.log('PASS removal (manage mode), no presentation state');

  // --- other preferences intact; persistence across New Presentation and restart ---
  await evaluate(`prefs.setQuickEmoji(0, '🧠'); prefs.toggleMathFavorite('q+1')`); await pause(300);
  await closePal();
  await evaluate(`document.querySelector('.logo').click()`); await pause(300);
  await evaluate(`[...document.querySelectorAll('.menu-item')].find((e) => e.textContent.includes('새 프레젠테이션')).click()`); await pause(700);
  await selectNew('shape'); await openPal(FILL, '.text-palette');
  assert.deepEqual(await mine('.text-palette'), [rgb('#00FF00'), rgb('#7C3AED')], 'survives New Presentation'); await closePal();
  await pause(600); await quit(); await launch();
  await selectNew('text'); await openPal(TEXT, '.text-palette');
  assert.deepEqual(await mine(), [rgb('#00FF00'), rgb('#7C3AED')], 'survives a full restart');
  assert.equal(await evaluate(`prefs.getQuickEmojis()[0]`), '🧠', 'Quick Emojis intact'); assert.equal(await evaluate(`prefs.getMathFavorites()[0].pre`), 'q+1', 'Math Favorites intact');
  const rec = JSON.parse(await stored()); assert.ok(rec.quickEmojis && rec.favoriteMathExpressions && rec.savedColors, 'one record keeps all three preferences');
  console.log('PASS persistence (New Presentation, restart); Quick Emojis + Math Favorites intact');
  console.log('ALL PASS');
} finally {
  await quit().catch(() => {});
  await server.close();
}
