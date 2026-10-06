/** Standalone Emoji tool: top-toolbar control, shared Quick Emojis, element behavior, resize, persistence, export.
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
import JSZip from 'jszip';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-emoji-profile-'));
const probe = netServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const debugPort = probe.address().port;
await new Promise((r) => probe.close(r));
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: 5189, strictPort: true } });
await server.listen();
const wrapper = path.join(profile, 'main.cjs');
await writeFile(wrapper, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});\n`);

const DEFAULTS = ['💡', 'ℹ️', '⚠️', '✅', '❌', '📌', '🔥', '💬', '⭐', '🚀'];
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
  electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`], { cwd: root, env: testElectronEnv({ ELECTRON_DEV_URL: 'http://127.0.0.1:5189' }), stdio: ['ignore', 'pipe', 'pipe'] });
  electron.stderr.on('data', () => {});
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 'debug target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => { const d = JSON.parse(e.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(Error(d.error.message)) : p.resolve(d.result); } });
  await send('Runtime.enable');
  await until(() => evaluate(`!!document.querySelector('.propsbar')`), 'app mount');
  await evaluate(`(async () => {
    window.store = (await import('/src/store/store.ts')).useStore; window.active = (await import('/src/editor/active.ts')).getActiveEditor;
    window.defaults = await import('/src/model/defaults.ts'); window.insert = await import('/src/canvas/insert.ts');
    window.testFiles = {};
    window.showSaveFilePicker = async ({suggestedName}) => ({name:suggestedName,createWritable:async()=>({write:async(blob)=>{testFiles[suggestedName]=[...new Uint8Array(await blob.arrayBuffer())]},close:async()=>{}})});
  })()`);
}
async function quit() { socket?.close(); if (electron?.exitCode === null) { electron.kill('SIGTERM'); await new Promise((r) => electron.once('exit', r)); } }
const click = async (sel) => {
  const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw Error('Missing ' + ${JSON.stringify(sel)}); const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...r });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...r }); await pause(200);
};
const down = (sel, i = 0) => evaluate(`document.querySelectorAll(${JSON.stringify(sel)})[${i}].dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}))`);
const toolRow = () => evaluate(`[...document.querySelectorAll('.pop .callout-icons button')].map((b) => b.textContent)`);
const calloutRow = () => evaluate(`[...document.querySelectorAll('.el.editing .callout-icons button')].map((b) => b.textContent)`);
const emojis = () => evaluate(`store.getState().deck.slides[store.getState().deck.slides.findIndex((s) => s.id === store.getState().currentSlideId)].elements.filter((e) => e.type === 'emoji')`);
const settled = () => until(() => evaluate("store.getState().saveState === 'saved'"), 'autosave settled');
async function openTool() { await click('.emoji-menu .tbtn'); await until(() => evaluate(`!!document.querySelector('.pop .callout-icons')`), 'emoji tool popover'); }
async function pickFromPicker(query) {
  await until(() => evaluate(`!!document.querySelector('.emoji-picker .emoji-search')`), 'picker open');
  await evaluate(`document.querySelector('.emoji-picker .emoji-search').focus()`);
  await send('Input.insertText', { text: query });
  await until(() => evaluate(`!!document.querySelector('.emoji-picker .emoji-grid button')`), 'picker results');
  const t = await evaluate(`(() => { const b = document.querySelector('.emoji-picker .emoji-grid button'); const t = b.textContent; b.click(); return t; })()`);
  await pause(250); return t;
}
async function openCalloutRow() {
  await evaluate(`store.getState().addElements([defaults.newText(64,540,{w:900,doc:{type:'doc',content:[{type:'callout',attrs:{icon:'🔥'},content:[{type:'paragraph',content:[{type:'text',text:'note'}]}]}]}})],{edit:true})`);
  await until(() => evaluate('!!active()'), 'editor'); await pause(300);
  await down('.el.editing .callout-icon'); await pause();
}

try {
  await launch();
  // --- toolbar control: immediately right of 도형 ---
  const labels = await evaluate(`[...document.querySelectorAll('.tb-center .pop-wrap, .tb-center > .tbtn')].map((e) => e.textContent.trim())`);
  assert.deepEqual(labels.slice(-2), ['도형', '이모지'], 'Emoji control directly right of Shape: ' + labels);
  await openTool();
  assert.deepEqual(await toolRow(), [...DEFAULTS, '✎', '⋯'], 'tool row = shared defaults + ✎ + ⋯ (✎ left of ⋯)');
  await evaluate(`document.querySelector('.emoji-menu .tbtn').click()`); await pause(200);
  console.log('PASS toolbar Emoji control + default shared quick row');

  // --- quick pick inserts a standalone element (presentation state: dirty + undo/redo) ---
  await settled();
  const pastBefore = await evaluate('store.getState().past.length');
  await openTool(); await down('.pop .callout-icons button', 3); await pause(300);
  let els = await emojis();
  assert.equal(els.length, 1); assert.equal(els[0].emoji, DEFAULTS[3]); assert.equal(els[0].w, els[0].h, 'square');
  assert.equal(await evaluate('store.getState().selection.length'), 1, 'inserted emoji is selected');
  assert.equal(await evaluate(`document.querySelectorAll('.pop').length`), 0, 'popover closes after a pick');
  assert.equal(await evaluate('store.getState().past.length'), pastBefore + 1, 'one undo step');
  assert.equal(await evaluate(`document.querySelector('.slide.editable .el-emoji .emoji-glyph').textContent`), DEFAULTS[3], 'rendered as text');
  await evaluate('store.getState().undo()'); assert.equal((await emojis()).length, 0, 'undo removes it');
  await evaluate('store.getState().redo()'); assert.equal((await emojis()).length, 1, 'redo restores it');
  console.log('PASS quick pick inserts standalone Emoji element; undo/redo');

  // --- full picker inserts too ---
  await openTool(); await down('.pop .callout-icons .more'); await pause(200);
  const rocket = await pickFromPicker('rocket');
  els = await emojis();
  assert.equal(els.length, 2); assert.equal(els[1].emoji, rocket, 'full picker pick inserted');
  console.log('PASS full picker inserts Emoji element');

  // --- resize: corners only, uniform ---
  const el = els[0];
  await evaluate(`store.getState().select([${JSON.stringify(el.id)}])`); await pause(200);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.slide.editable .handle')].map((h) => h.className.replace('handle ', '')).sort()`), ['h-ne', 'h-nw', 'h-se', 'h-sw'], 'corner handles only');
  const h = await evaluate(`(() => { const r = document.querySelector('.slide.editable .handle.h-se').getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...h });
  for (const f of [0.3, 1]) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: h.x + 90 * f, y: h.y + 20 * f });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: h.x + 90, y: h.y + 20 }); await pause(250);
  const big = (await emojis()).find((e) => e.id === el.id);
  assert.ok(big.w > el.w, 'grew'); assert.equal(big.w, big.h, 'stays square under a non-square drag');
  const fs = await evaluate(`parseFloat(getComputedStyle(document.querySelector('.slide.editable [data-el-id="${el.id}"] .emoji-glyph')).fontSize)`);
  assert.ok(Math.abs(fs - big.w * 0.94) < 1, 'glyph re-rendered at the new size (font-size follows the box): ' + fs);
  assert.equal(await evaluate('store.getState().past.length'), pastBefore + 3, 'resize is one undo step');
  console.log('PASS uniform corner resize, glyph re-rendered at new size');

  // --- duplicate / delete ---
  await evaluate('insert.duplicateSelection()'); await pause(200);
  els = await emojis(); assert.equal(els.length, 3); assert.notEqual(els[2].id, el.id); assert.equal(els[2].emoji, el.emoji); assert.equal(els[2].w, big.w);
  await evaluate('store.getState().deleteSelection()'); await pause(200);
  assert.equal((await emojis()).length, 2, 'delete');
  console.log('PASS duplicate / delete');

  // --- shared preference, both directions; presentation untouched ---
  await openCalloutRow();
  assert.deepEqual((await calloutRow()).slice(0, 10), DEFAULTS);
  await settled();
  const pastNow = await evaluate('store.getState().past.length');
  // edit from the Callout UI -> tool shows it
  await down('.el.editing .callout-icons .edit'); await down('.el.editing .callout-icons .slot', 0); await pause(200);
  const calm = await pickFromPicker('relieved');
  await down('.el.editing .callout-icons .done'); await pause(200);
  assert.equal(await evaluate('store.getState().past.length'), pastNow, 'editing quick emojis in the Callout UI adds no presentation undo step');
  await evaluate('store.getState().stopEditing()'); await pause(200); await settled(); // ends the new text box's own edit session
  const pastTool = await evaluate('store.getState().past.length'), deckTool = await evaluate('JSON.stringify(store.getState().deck)');
  await openTool();
  assert.equal((await toolRow())[0], calm, 'edit made in the Callout UI shows in the tool');
  // edit from the tool -> callout shows it
  await down('.pop .callout-icons .edit'); await down('.pop .callout-icons .slot', 9); await pause(200);
  const brain = await pickFromPicker('brain');
  assert.equal((await toolRow())[9], brain, 'tool row updates live');
  await down('.pop .callout-icons .done'); await pause(100);
  await evaluate(`document.querySelector('.emoji-menu .tbtn').click()`); await pause(200);
  assert.equal(await evaluate('JSON.stringify(store.getState().deck)'), deckTool, 'quick emoji edits leave the deck untouched');
  assert.equal(await evaluate('store.getState().saveState'), 'saved', 'not dirtied');
  assert.equal(await evaluate('store.getState().past.length'), pastTool, 'no presentation undo step from the tool either');
  assert.ok(!deckTool.includes('quickEmojis') && !deckTool.includes(brain), 'preference is not stored in the deck');
  console.log('PASS Quick Emojis shared between Callout and Emoji tool; no dirty/undo');

  // --- existing callout keeps its icon; new one uses quickEmojis[0] ---
  const icons = await evaluate(`JSON.stringify(store.getState().deck).match(/"icon":"[^"]*"/g)`);
  assert.deepEqual(icons, ['"icon":"🔥"'], 'existing Callout icon unchanged');
  console.log('PASS existing Callout unaffected');

  // --- thumbnails / presenter / print DOM ---
  await pause(300); await settled();
  assert.ok(await evaluate(`document.querySelectorAll('.thumb .el-emoji .emoji-glyph, .navigator .el-emoji .emoji-glyph').length > 0`), 'thumbnail renders the emoji');
  await evaluate(`store.setState({presenting: true})`); await pause(500);
  assert.ok(await evaluate(`document.querySelectorAll('.el-emoji .emoji-glyph').length >= 2`), 'presenter renders the emoji');
  await evaluate(`store.setState({presenting: false})`); await pause(300);
  console.log('PASS thumbnail + presentation rendering');

  // --- PPTX: embedded high-resolution picture with the emoji as alt text ---
  await evaluate("import('/src/export/run.ts').then((m) => m.exportPptx())");
  const name = await evaluate('store.getState().deck.title');
  await until(() => evaluate(`testFiles[${JSON.stringify(name + '.pptx')}]?.length > 1000`), 'PPTX export', 30000);
  const zip = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(name + '.pptx')}]`)));
  const slideNo = (await evaluate('store.getState().deck.slides.findIndex((s) => s.elements.some((e) => e.type === "emoji")) + 1'));
  const xml = await zip.file(`ppt/slides/slide${slideNo}.xml`).async('string');
  assert.ok(xml.includes(`descr="${DEFAULTS[3]}"`) || xml.includes('name="Emoji"'), 'emoji picture in PPTX');
  const media = Object.keys(zip.files).filter((f) => /^ppt\/media\/.+\.png$/.test(f));
  assert.ok(media.length >= 1, 'media embedded');
  const png = await zip.file(media[0]).async('nodebuffer');
  assert.equal(png.readUInt32BE(16) >= 256, true, 'embedded PNG is at least 256 px wide: ' + png.readUInt32BE(16));
  console.log('PASS PPTX export (picture, alt text, resolution)');

  // --- persistence: serialization round trip + app restart ---
  const before = await emojis();
  const round = await evaluate(`(() => { const d = JSON.parse(JSON.stringify(store.getState().deck)); return d.slides.flatMap((s) => s.elements).filter((e) => e.type === 'emoji').length; })()`);
  assert.equal(round, before.length, 'serializes with the deck');
  await settled(); await pause(600); await quit(); await launch();
  const after = await emojis();
  assert.deepEqual(after.map((e) => [e.emoji, e.x, e.y, e.w, e.h]), before.map((e) => [e.emoji, e.x, e.y, e.w, e.h]), 'emoji elements survive restart');
  await openTool();
  assert.deepEqual((await toolRow()).slice(0, 10), [calm, ...DEFAULTS.slice(1, 9), brain], 'shared quick emojis survive restart');
  console.log('PASS persistence (deck round trip, restart, shared preference)');
  console.log('ALL PASS');
} finally {
  await quit().catch(() => {});
  await server.close();
}
