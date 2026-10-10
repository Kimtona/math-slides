/** Cross-feature checks for the combined app (Config + Markdown Divider + Native Table): the features share the editor,
 * the slash menu, undo history, persistence and the PPTX export. Real Electron window, disposable profile, dynamic ports.
 * Run: node tests/integration.mjs (needs a graphical session).
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
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-integration-profile-'));
const probe = netServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const debugPort = probe.address().port;
await new Promise((r) => probe.close(r));
const vitePort = await (async () => { const p = netServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const n = p.address().port; await new Promise((r) => p.close(r)); return n; })();
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: vitePort, strictPort: true } });
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
  electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`], { cwd: root, env: testElectronEnv({ ELECTRON_DEV_URL: `http://127.0.0.1:${vitePort}` }), stdio: ['ignore', 'pipe', 'pipe'] });
  electron.stderr.on('data', () => {});
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 'debug target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => { const d = JSON.parse(e.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(Error(d.error.message)) : p.resolve(d.result); } });
  await send('Runtime.enable');
  await until(() => evaluate(`!!document.querySelector('.propsbar')`), 'app mount');
  await evaluate(`(async () => {
    window.store = (await import('/src/store/store.ts')).useStore; window.active = (await import('/src/editor/active.ts')).getActiveEditor;
    window.defaults = await import('/src/model/defaults.ts'); window.insert = await import('/src/canvas/insert.ts'); window.persist = await import('/src/store/persistence.ts'); window.tf = await import('/src/ui/textFormat.ts'); window.tmodel = await import('/src/model/table.ts');
    window.testFiles = {};
    window.showSaveFilePicker = async ({suggestedName}) => ({name:suggestedName,createWritable:async()=>({write:async(blob)=>{testFiles[suggestedName]=[...new Uint8Array(await blob.arrayBuffer())]},close:async()=>{}})});
  })()`);
}
async function quit() { socket?.close(); if (electron?.exitCode === null) { electron.kill('SIGTERM'); await new Promise((r) => electron.once('exit', r)); } }

const els = () => evaluate(`store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements`);
const ofType = async (t) => (await els()).filter((e) => e.type === t);
const dividers = async () => (await ofType('line')).filter((e) => e.role === 'divider');
const tables = async () => ofType('table');
const key = async (k, text) => {
  const vk = { Enter: 13, Backspace: 8, Tab: 9 }[k];
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text, windowsVirtualKeyCode: vk ?? (text && /[a-z0-9 ]/i.test(text) ? text.toUpperCase().charCodeAt(0) : 0) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: vk ?? 0 });
  await pause(40);
};
const type = async (s) => { for (const c of s) await key(c === '\n' ? 'Enter' : c, c === '\n' ? '\r' : c); };
const para = (t) => ({ type: 'paragraph', ...(t ? { content: [{ type: 'text', text: t }] } : {}) });
const D = (...c) => ({ type: 'doc', content: c });
async function openBox(doc, y = 200) {
  await evaluate(`store.getState().addElements([defaults.newText(64, ${y}, {w: 600, doc: ${JSON.stringify(doc)}})], {edit: true})`);
  await until(() => evaluate('!!active()'), 'editor'); await pause(250);
  await evaluate(`active().commands.focus('end')`); await pause(100);
}
const slashNames = () => evaluate(`[...document.querySelectorAll('.slash-item .slash-name')].map((e) => e.textContent)`);

try {
  await launch();
  const baseEls = (await els()).length;

  // ---- both creation commands live in the same slash menu ----
  await openBox(D(para('')), 120);
  await type('/'); await pause(300);
  const names = await slashNames();
  assert.ok(names.includes('Table') && names.includes('Divider'), 'slash menu offers /table and /divider: ' + names.join());
  assert.equal(names.length, 11, 'all eleven commands');
  await key('Escape'); await evaluate('store.getState().stopEditing()'); await pause(300);
  await evaluate('store.getState().undo()'); await pause(200);

  // ---- /table then --- on one slide ----
  await openBox(D(para('/table')), 90);
  await pause(300); await key('Enter', '\r'); await pause(500);
  assert.equal((await tables()).length, 1, '/table inserts a table');
  const tbl = (await tables())[0];
  await openBox(D(para('')), 560);
  await type('--- '); await pause(400);
  assert.equal((await dividers()).length, 1, '--- + Space still creates a divider with a table on the slide');
  assert.deepEqual(await evaluate(`store.getState().deck.slides.flatMap((s) => s.elements).find((e) => e.id === ${JSON.stringify(tbl.id)})`), tbl, 'the table is untouched by the divider');
  console.log('PASS slash menu shows /table and /divider; both create their elements on one slide');

  // ---- a table cell is plain text: no Markdown divider shortcut there ----
  await evaluate(`store.getState().select(['${tbl.id}'])`); await pause(200);
  await evaluate(`store.getState().startCellEditing('${tbl.id}', 1, 1, 'end')`); await until(() => evaluate('!!active()'), 'cell editor'); await pause(250);
  const dBefore = (await dividers()).length;
  await type('--- '); await pause(300);
  assert.equal((await dividers()).length, dBefore, '--- + Space inside a cell does not create a divider');
  assert.equal(await evaluate('active().getText()'), '--- ', 'the cell keeps the typed text');
  assert.equal(await evaluate("store.getState().editingId"), tbl.id, 'still editing the cell');
  await key('Enter', '\r'); await pause(200); assert.equal((await dividers()).length, dBefore, 'Enter in a cell never makes a divider either');
  assert.equal((await tables()).length, 1);
  await evaluate('store.getState().stopEditing()'); await pause(200);
  await evaluate(`store.getState().updateElements(['${tbl.id}'], (d) => { d.caption = 'Table 1: Mixed slide' })`); await pause(200);
  console.log('PASS table cells exclude the divider shortcut');

  // ---- one undo history across the features ----
  const snapshot = JSON.stringify((await els()).map((e) => [e.type, e.id]));
  const hist = await evaluate('store.getState().past.length');
  for (let i = 0; i < 3; i++) await evaluate('store.getState().undo()');
  await pause(300);
  await evaluate('for (let i = 0; i < 3; i++) store.getState().redo()'); await pause(300);
  assert.equal(JSON.stringify((await els()).map((e) => [e.type, e.id])), snapshot, 'undo x3 / redo x3 returns to the same elements');
  assert.equal((await tables()).length, 1); assert.equal((await dividers()).length, 1); assert.equal(await evaluate('store.getState().past.length'), hist);
  // moving the divider and the table are separate, independent steps
  await evaluate(`store.getState().updateElements(['${(await dividers())[0].id}'], (d) => { d.y1 = 600; d.y2 = 600; d.y = 600 })`); await pause(200);
  await evaluate(`store.getState().updateElements(['${tbl.id}'], (d) => { d.x = 100 })`); await pause(200);
  await evaluate('store.getState().undo()'); await pause(200); assert.notEqual((await tables())[0].x, 100, 'undo reverts the table move only'); assert.equal((await dividers())[0].y1, 600, 'and keeps the divider move');
  await evaluate('store.getState().redo()'); await pause(200);
  console.log('PASS shared undo/redo history');

  // ---- deck-wide font clears per-box fonts in text boxes, shapes and tables, and keeps other formatting ----
  await evaluate(`store.getState().addElements([defaults.newText(700, 300, {w: 400, doc: ${JSON.stringify(D(para('configured')))}, style: {fontFamily: 'Pretendard'}})])`); await pause(200);
  await evaluate(`store.getState().updateElements(['${tbl.id}'], (d) => { d.textStyle.fontFamily = 'Pretendard'; d.rows[0][0].doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B', marks: [{ type: 'bold' }, { type: 'textStyle', attrs: { fontFamily: 'Pretendard', color: '#DC2626' } }] }] }] }; })`); await pause(200);
  await evaluate("tf.setDeckFont('Noto Serif KR')"); await pause(300);
  const all = await els(); const txt = all.find((e) => e.type === 'text' && JSON.stringify(e.doc).includes('configured')); const tb2 = all.find((e) => e.type === 'table');
  assert.equal(txt.style.fontFamily, undefined, 'the text box follows the deck font again'); assert.equal(tb2.textStyle.fontFamily, undefined, 'the table follows it too');
  const marks = tb2.rows[0][0].doc.content[0].content[0].marks; assert.ok(marks.some((m) => m.type === 'bold') && marks.some((m) => m.type === 'textStyle' && m.attrs.color === '#DC2626' && !('fontFamily' in m.attrs)), 'cell bold + color kept, per-range font cleared');
  await evaluate("tf.setDeckFont('NanumSquare')"); await pause(200);
  console.log('PASS deck font reaches text boxes, shapes and table cells together');

  // ---- save / reopen: table (+ caption) and divider together ----
  await evaluate('persist.saveProject()'); await pause(800);
  const fileName = await evaluate("Object.keys(testFiles).find((k) => k.endsWith('.mslides'))");
  const fileText = Buffer.from(await evaluate(`testFiles[${JSON.stringify(fileName)}]`)).toString('utf8');
  assert.match(fileText, /"type":"table"/); assert.match(fileText, /"role":"divider"/); assert.match(fileText, /"caption":"Table 1: Mixed slide"/);
  const before = { t: (await tables())[0], d: (await dividers())[0] };
  await evaluate('persist.newProject()'); await pause(600); assert.equal((await tables()).length, 0);
  await evaluate(`persist.openFromText(${JSON.stringify(fileText)}, null)`); await pause(800);
  await evaluate(`store.getState().goToSlide(store.getState().deck.slides.find((s) => s.elements.some((e) => e.type === 'table')).id)`); await pause(300);
  assert.equal(JSON.stringify((await tables())[0]), JSON.stringify(before.t), 'table identical after reopening'); assert.equal(JSON.stringify((await dividers())[0]), JSON.stringify(before.d), 'divider identical after reopening');
  console.log('PASS save / reopen keeps table, caption and divider');

  // ---- PPTX: native table + caption text box + divider line on one slide ----
  await evaluate("document.querySelector('.export-menu > button').click()"); await pause(200);
  await evaluate("document.querySelector('.pop .menu-item:nth-child(2)').click()");
  const pptx = await until(() => evaluate("Object.keys(testFiles).find((k) => k.endsWith('.pptx'))"), 'PPTX export', 30000);
  await until(() => evaluate(`testFiles[${JSON.stringify(pptx)}]?.length > 1000`), 'PPTX bytes', 30000);
  const zip = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(pptx)}]`)));
  const slideNo = (await evaluate('store.getState().deck.slides')).findIndex((s) => s.elements.some((e) => e.type === 'table')) + 1;
  const xml = await zip.file(`ppt/slides/slide${slideNo}.xml`).async('string');
  assert.match(xml, /<a:tbl>/, 'native table'); assert.match(xml, /name="Table Caption"/, 'caption text box'); assert.match(xml, />Table 1: Mixed slide</);
  assert.ok(/<p:cxnSp>|<p:sp>(?:(?!<\/p:sp>)[\s\S])*?prst="line"/.test(xml), 'the divider is a line in the same slide');
  assert.ok(!xml.includes('<p:pic>'), 'nothing rasterized');
  console.log('PASS PPTX export of table + caption + divider on one slide');
  console.log('PASS integration checks');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await quit();
  await server.close();
}
