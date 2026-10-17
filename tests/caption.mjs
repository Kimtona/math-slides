/** Unified element captions (text, shape, emoji, line, table, role text): UX, geometry, undo, duplicate, save/restart, PPTX.
 * Real Electron window on a disposable profile. Run: node tests/caption.mjs (needs a graphical session).
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { testElectronEnv } from './electron-env.mjs';
import JSZip from 'jszip';
import { makeTempDir } from './tmp-utils.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = makeTempDir('mathslides-caption-profile-');
const probe = netServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const debugPort = probe.address().port;
await new Promise((r) => probe.close(r));
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: 5199, strictPort: true } });
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
  electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`], { cwd: root, env: testElectronEnv({ ELECTRON_DEV_URL: 'http://127.0.0.1:5199' }), stdio: ['ignore', 'pipe', 'pipe'] });
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

const cur = () => evaluate(`store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId)`);
const byId = async (id) => (await cur()).elements.find((e) => e.id === id);
const capBtn = (title) => `document.querySelector('.propsbar button[title="${title}"]')`;
const capRect = (id) => evaluate(`(() => { const el = document.querySelector('.slide.editable [data-el-id="${id}"]'); const c = el.querySelector('.img-caption, .img-caption-input'); if (!c) return null; const r = c.getBoundingClientRect(), b = el.getBoundingClientRect(); const cs = getComputedStyle(c); return {cx: r.x, cy: r.y, cw: r.width, ch: r.height, bx: b.x, bb: b.bottom, bw: b.width, fs: cs.fontSize, align: cs.textAlign, tag: c.tagName}; })()`);
const add = (el) => evaluate(`store.getState().addElements([${JSON.stringify(el)}]); store.getState().select([${JSON.stringify(el.id)}])`);
const type = async (text) => { await send('Input.insertText', { text }); await pause(150); };
const esc = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' }); await pause(250); };
const strip = (e) => { const { caption, ...rest } = e; return rest; };

async function roundTrip(id, title, text) {
  const e0 = await byId(id);
  await evaluate(`store.getState().select([${JSON.stringify(id)}])`); await pause(250);
  assert.equal(await evaluate(`!!${capBtn(title + '캡션 추가')}`), true, 'Caption button for ' + e0.type);
  assert.equal(await evaluate(`!!${capBtn(title + '캡션 삭제')}`), false);
  assert.ok(!('caption' in e0), 'no caption key by default');
  const past = await evaluate('store.getState().past.length');
  await evaluate(`${capBtn(title + '캡션 추가')}.click()`); await pause(350);
  assert.equal((await byId(id)).caption, '', 'adding creates an empty caption');
  assert.equal(await evaluate('store.getState().past.length'), past + 1, 'adding is one undo step');
  assert.equal(await evaluate('document.activeElement?.className'), 'img-caption-input', 'caption field focused');
  await type(text); await esc();
  const e1 = await byId(id);
  assert.equal(e1.caption, text, 'caption typed');
  assert.deepEqual(strip(e1), strip(e0), 'geometry / style unchanged by the caption: ' + e0.type);
  assert.equal(await evaluate('store.getState().past.length'), past + 2, 'typing is one undo step');
  return e1;
}

try {
  await launch();
  const T = { id: 't1', type: 'text', x: 100, y: 100, w: 400, h: 40, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] }, style: { fontSize: 28, color: '#111111', align: 'center', lineHeight: 1.4, fill: '#FFF3C4' } };
  const S = { id: 's1', type: 'shape', shape: 'ellipse', x: 600, y: 100, w: 200, h: 120, fill: '#DDEEFF', stroke: '#2F6FEB', strokeWidth: 2, radius: 0 };
  const E = { id: 'e1', type: 'emoji', emoji: '🚀', x: 900, y: 100, w: 80, h: 80 };
  await add(T); await add(S); await add(E);
  await evaluate("store.getState().addElements([defaults.newLine(100,400,500,400,true)]); store.getState().addElements([defaults.newLine(700,300,700,500)]); store.getState().addElements([defaults.newLine(900,420,920,430)])");
  const lines = (await cur()).elements.filter((e) => e.type === 'line');
  await settled();

  // --- every non-image element type: add / type / geometry untouched ---
  for (const [id, title, text] of [['t1', '', 'Text caption'], ['s1', '', 'Shape caption'], ['e1', '', 'Emoji caption']]) {
    const e = await roundTrip(id, title, text);
    const r = await capRect(id);
    assert.ok(Math.abs(r.cy - (r.bb + 6 * (r.bw / e.w))) < 1.5, 'caption sits 6px below the element: ' + id);
    assert.ok(Math.abs(r.cx - r.bx) < 1.5 && Math.abs(r.cw - r.bw) < 1.5, 'caption has the element left edge and width: ' + id);
    assert.equal(r.fs, '14px'); assert.equal(r.align, 'left');
  }
  // Static (deselected) text caption: DOM stays the same shape.
  await evaluate('store.getState().select([])'); await pause(250);
  assert.equal((await capRect('t1')).tag, 'DIV'); assert.equal(await evaluate("document.querySelectorAll('.img-caption-input').length"), 0);
  console.log('PASS text / shape / emoji captions: add, edit, placement, geometry untouched');

  // --- lines: horizontal, vertical, very short ---
  for (const [i, text] of [[0, 'Horizontal line'], [1, 'Vertical'], [2, 'Tiny']]) {
    const e = await roundTrip(lines[i].id, '', text);
    const r = await capRect(lines[i].id);
    const k = await evaluate("document.querySelector('.slide.editable').getBoundingClientRect().width / 1280");
    assert.ok(r.cw / k >= 119 && r.ch / k < 40, `line ${i}: caption at least 120px wide and not wrapped per letter (w=${r.cw / k}, h=${r.ch / k})`);
    assert.ok(r.cy > r.bb, `line ${i}: below the line`);
    if (e.w < 120) assert.ok(Math.abs(r.cx + r.cw / 2 - (r.bx + r.bw / 2)) < 2, `line ${i}: centered on the bounding box`);
  }
  console.log('PASS line captions (horizontal / vertical / short)');

  // --- undo / redo / duplicate / delete / remove ---
  // History is global: the last edit was the third line's caption.
  const L = lines[2].id;
  await evaluate('store.getState().undo()'); assert.equal((await byId(L)).caption, '', 'undo typing');
  await evaluate('store.getState().undo()'); assert.ok(!('caption' in await byId(L)), 'undo add');
  await evaluate('store.getState().redo()'); await evaluate('store.getState().redo()'); assert.equal((await byId(L)).caption, 'Tiny', 'redo');
  await evaluate("store.getState().select(['s1'])"); await pause(200);
  // --- role text takes no caption ---
  await evaluate("store.getState().addElements([{...defaults.newText(100, 600, {w: 300}), id: 'role1', role: 'toc'}]); store.getState().select(['role1'])"); await pause(250);
  assert.equal(await evaluate(`!!document.querySelector('.propsbar button[title="캡션 추가"]')`), false, 'no Caption on a managed role box');
  await evaluate("store.getState().deleteSelection()");
  console.log('PASS role text excluded');

  await evaluate("store.getState().select(['s1'])"); await pause(200);
  await evaluate('insert.duplicateSelection()'); await pause(200);
  const dup = (await cur()).elements.filter((e) => e.type === 'shape');
  assert.equal(dup.length, 2); assert.equal(dup[1].caption, 'Shape caption', 'duplicate keeps the caption');
  await evaluate('store.getState().deleteSelection()'); await pause(200);
  assert.equal((await cur()).elements.filter((e) => e.type === 'shape').length, 1, 'delete removes element (and caption with it)');
  await evaluate("store.getState().select(['s1'])"); await pause(200);
  await evaluate(`${capBtn('캡션 삭제')}.click()`); await pause(300);
  assert.ok(!('caption' in await byId('s1')), 'Remove Caption deletes the key');
  await evaluate('store.getState().undo()'); assert.equal((await byId('s1')).caption, 'Shape caption', 'undo restores');
  console.log('PASS undo/redo, duplicate, delete, remove');

  // --- moving carries the caption ---
  const before = await capRect('e1');
  await evaluate("store.getState().updateElements(['e1'], (d) => { d.x += 50; d.y += 30; })"); await pause(250);
  const after = await capRect('e1');
  assert.ok(after.cx > before.cx && after.cy > before.cy, 'caption moved with the element');
  console.log('PASS move');

  // --- table keeps its own flow ---
  await evaluate("insert.insertTable()"); await pause(300);
  const tid = await evaluate("store.getState().selection[0]");
  const tb = await roundTrip(tid, '표 ', 'Table caption');
  assert.equal(tb.caption, 'Table caption');
  console.log('PASS table caption through the shared button');

  // --- PDF/preview path: thumbnails and static render show the captions ---
  assert.ok(await evaluate(`document.querySelectorAll('.thumb-inner .img-caption').length >= 5`), 'captions in thumbnails');

  // --- PPTX ---
  await evaluate("document.querySelector('.export-menu > button').click()"); await pause(200);
  await evaluate("document.querySelector('.pop .menu-item:nth-child(2)').click()");
  const pptx = await until(() => evaluate("Object.keys(testFiles).find((k) => k.endsWith('.pptx'))"), 'PPTX export', 30000);
  await until(() => evaluate(`testFiles[${JSON.stringify(pptx)}]?.length > 1000`), 'PPTX bytes', 30000);
  const zip = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(pptx)}]`)));
  const cid = await evaluate('store.getState().currentSlideId');
  const slideNo = (await evaluate('store.getState().deck.slides')).findIndex((s) => s.id === cid) + 1;
  const xml = await zip.file(`ppt/slides/slide${slideNo || 1}.xml`).async('string');
  for (const t of ['Text caption', 'Shape caption', 'Emoji caption', 'Horizontal line', 'Vertical', 'Tiny', 'Table caption']) assert.ok(xml.includes('>' + t + '<'), 'PPTX has caption: ' + t);
  assert.equal((xml.match(/name="Caption"/g) || []).length, 6, 'one native caption per non-image/table element');
  assert.equal((xml.match(/name="Table Caption"/g) || []).length, 1, 'table caption not duplicated');
  console.log('PASS PPTX export');

  // --- persistence ---
  const snap = JSON.stringify((await cur()).elements.map((e) => [e.id, e.caption ?? null, e.x, e.y, e.w, e.h]));
  await settled(); await pause(700); await quit(); await launch();
  const snap2 = JSON.stringify((await cur()).elements.map((e) => [e.id, e.caption ?? null, e.x, e.y, e.w, e.h]));
  assert.equal(snap2, snap, 'captions survive restart');
  console.log('PASS persistence');
  console.log('ALL PASS');
} finally {
  await quit().catch(() => {});
  await server.close();
}
