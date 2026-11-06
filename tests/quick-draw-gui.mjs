/** Quick Draw (⌥⇧ + drag) in the real Electron app, on the merged tree: creates one ordinary 2px red outline rectangle with
 * a transparent inside and square corners; Esc cancels; a drag under 6 px creates nothing; ⇧ alone or ⌥ alone does not draw;
 * a drag that starts over an existing element draws and does not move it; one Undo removes the rectangle; the rectangle
 * survives save → reopen, PDF and PPTX; it coexists with curve lines. Run: node tests/quick-draw-gui.mjs
 */
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import JSZip from 'jszip';
import { testElectronEnv } from './electron-env.mjs';
import { launchElectron, startViteServer, stopElectron } from './test-ports.mjs';
import { makeTempDir } from './tmp-utils.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = makeTempDir('mathslides-quickdraw-profile-');
const pdfDir = path.join(profile, 'pdf');
await mkdir(pdfDir);
let debugPort;
const { server, url: devUrl } = await startViteServer(createServer, { root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), logLevel: 'error' });
const wrapper = path.join(profile, 'main.cjs');
await writeFile(wrapper, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});\n`);

let electron, socket, id = 0;
const pending = new Map();
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));
async function until(fn, message, timeout = 30000) { const t = Date.now(); while (Date.now() - t < timeout) { try { const v = await fn(); if (v) return v; } catch {} await pause(150); } throw new Error(message); }
const send = (method, params = {}) => new Promise((resolve, reject) => { const k = ++id; pending.set(k, { resolve, reject }); socket.send(JSON.stringify({ id: k, method, params })); });
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
const ALT = 1, SHIFT = 8;
const elements = () => evaluate(`JSON.parse(JSON.stringify(store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements))`);
const past = () => evaluate('store.getState().past.length');
/** Slide coordinates → client coordinates of the editable slide. */
const toClient = (p) => evaluate(`(() => { const r = document.querySelector('.stage .slide').getBoundingClientRect(); const k = r.width / 1280; return { x: r.left + ${p.x} * k, y: r.top + ${p.y} * k }; })()`);
async function drag(from, to, modifiers, { esc = false } = {}) {
  const a = await toClient(from), b = await toClient(to);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, modifiers, ...a });
  for (let k = 1; k <= 8; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, modifiers, x: a.x + (b.x - a.x) * k / 8, y: a.y + (b.y - a.y) * k / 8 });
  if (esc) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, modifiers, ...b }); await pause(300);
}
const rects = async () => (await elements()).filter((e) => e.type === 'shape' && e.shape === 'rect');

try {
  ({ child: electron, debugPort } = await launchElectron(require('electron'), [wrapper], { cwd: root, env: testElectronEnv({ ELECTRON_DEV_URL: devUrl, MATHSLIDES_TEST_PDF_DIR: pdfDir, ANTHROPIC_API_KEY: '' }) }));
  electron.stderr.on('data', () => {});
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 'debug target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => { const d = JSON.parse(e.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(Error(d.error.message)) : p.resolve(d.result); } });
  await send('Runtime.enable');
  await until(() => evaluate(`!!document.querySelector('.propsbar')`), 'app mount');
  await evaluate(`(async () => {
    window.store = (await import('/src/store/store.ts')).useStore; window.persist = await import('/src/store/persistence.ts'); window.defaults = await import('/src/model/defaults.ts'); window.insert = await import('/src/canvas/insert.ts');
    window.testFiles = {};
    window.showSaveFilePicker = async ({suggestedName}) => ({name:suggestedName,createWritable:async()=>({write:async(blob)=>{testFiles[suggestedName]=[...new Uint8Array(await blob.arrayBuffer())]},close:async()=>{}})});
  })()`);
  await evaluate(`store.getState().addSlide()`); await pause(400);
  assert.equal((await rects()).length, 0, 'empty slide');

  // --- ⌥⇧ + drag creates one outline rectangle ---
  const h0 = await past();
  await drag({ x: 300, y: 300 }, { x: 700, y: 480 }, ALT | SHIFT);
  let [R] = await rects();
  assert.ok(R, 'Quick Draw created a rectangle');
  assert.deepEqual([R.x, R.y, R.w, R.h], [300, 300, 400, 180], 'spans the drag');
  assert.equal(R.stroke, '#FF0000'); assert.equal(R.strokeWidth, 2); assert.equal(R.fill, null, 'transparent inside'); assert.equal(R.radius, 0, 'square corners');
  assert.equal(await past(), h0 + 1, 'one undo step');
  assert.equal((await rects()).length, 1, 'exactly one');
  console.log('PASS ⌥⇧ drag creates a 2px red transparent square-corner rectangle (one undo step)');

  // --- drag in any direction (up-left) normalizes the box ---
  await drag({ x: 1000, y: 600 }, { x: 900, y: 520 }, ALT | SHIFT);
  const second = (await rects()).find((r) => r.id !== R.id);
  assert.deepEqual([second.x, second.y, second.w, second.h], [900, 520, 100, 80], 'up-left drag normalized');
  console.log('PASS drag in the other direction');

  // --- cancel, too-small drag and other modifier combinations draw nothing ---
  const n = (await rects()).length;
  await drag({ x: 100, y: 100 }, { x: 250, y: 200 }, ALT | SHIFT, { esc: true });
  assert.equal((await rects()).length, n, 'Esc cancels');
  await drag({ x: 100, y: 100 }, { x: 103, y: 103 }, ALT | SHIFT);
  assert.equal((await rects()).length, n, 'a drag under 6 px is an accident');
  await drag({ x: 100, y: 100 }, { x: 250, y: 200 }, SHIFT);
  assert.equal((await rects()).length, n, '⇧ alone does not draw');
  await drag({ x: 100, y: 100 }, { x: 250, y: 200 }, ALT);
  assert.equal((await rects()).length, n, '⌥ alone does not draw');
  console.log('PASS Esc cancels; <6 px, ⇧ alone and ⌥ alone create nothing');

  // --- starting over an existing element draws and does not move it ---
  const before = (await rects()).find((r) => r.id === R.id);
  await drag({ x: 400, y: 380 }, { x: 600, y: 440 }, ALT | SHIFT);
  const after = (await rects()).find((r) => r.id === R.id);
  assert.deepEqual([after.x, after.y, after.w, after.h], [before.x, before.y, before.w, before.h], 'the element under the drag start did not move');
  assert.equal((await rects()).length, n + 1, 'a new rectangle was drawn over it');
  console.log('PASS draws over an existing element without moving it');

  // --- undo removes just the last rectangle ---
  await evaluate(`store.getState().undo()`); await pause(200);
  assert.equal((await rects()).length, n, 'undo removes the last Quick Draw rectangle only');
  await evaluate(`store.getState().redo()`); await pause(200);
  assert.equal((await rects()).length, n + 1, 'redo');
  console.log('PASS undo/redo');

  // --- coexists with a curved arrow (other line of work) ---
  await evaluate(`insert.insertCurve(true)`); await pause(300);
  assert.ok((await elements()).some((e) => e.type === 'line' && Number.isFinite(e.cx)), 'curved arrow inserted next to the rectangles');

  // --- save → reopen, PDF, PPTX ---
  const savedRects = await rects();
  await evaluate(`persist.saveProject(true)`);
  const name = await until(() => evaluate(`Object.keys(testFiles).find((k) => k.endsWith('.mslides'))`), 'saved');
  const text = Buffer.from(await evaluate(`testFiles[${JSON.stringify(name)}]`)).toString('utf8');
  const idx = await evaluate(`store.getState().deck.slides.findIndex((s) => s.id === store.getState().currentSlideId)`);
  await evaluate(`store.getState().loadDeck(JSON.parse(JSON.stringify({ version: 1, title: 'blank', slides: [{ id: 'x', background: '#fff', elements: [], notes: '' }] })), {})`);
  await evaluate(`persist.openFromText(${JSON.stringify(text)}, null)`);
  await evaluate(`store.getState().goToSlide(store.getState().deck.slides[${idx}].id)`); await pause(500);
  assert.deepEqual(await rects(), savedRects, 'rectangles identical after save and reopen');
  await evaluate(`import('/src/export/run.ts').then((m) => m.exportPdf())`);
  const pdfName = await until(async () => (await readdir(pdfDir)).find((f) => f.endsWith('.pdf')), 'PDF', 60000);
  assert.equal((await readFile(path.join(pdfDir, pdfName))).subarray(0, 4).toString(), '%PDF');
  await evaluate("import('/src/export/run.ts').then((m) => m.exportPptx())");
  const title = await evaluate('store.getState().deck.title');
  await until(() => evaluate(`testFiles[${JSON.stringify(title + '.pptx')}]?.length > 1000`), 'PPTX', 60000);
  const zip = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(title + '.pptx')}]`)));
  const xml = await zip.file(`ppt/slides/slide${idx + 1}.xml`).async('string');
  assert.ok(/FF0000/i.test(xml) && /<a:ln w="19050"/.test(xml) && /prstGeom prst="rect"/.test(xml), '2px red outline rectangles in the PPTX (w=19050 EMU = 1.5pt)');
  assert.ok(/quadBezTo|cubicBezTo/.test(xml), 'curve in the same PPTX slide');
  console.log('PASS save → reopen, PDF, PPTX (rectangles + curve on one slide)');
  console.log('ALL PASS');
} finally {
  socket?.close();
  await stopElectron(electron);
  await server.close();
}
