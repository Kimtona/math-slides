/** Curved lines / curved arrows in the real Electron app (disposable profile, real pointer events):
 * shape menu, bend handle drag, endpoint drag, color/width/arrowhead via the props bar, straight ↔ curve toggle,
 * undo/redo, .mslides save → quit → Finder-open in a fresh app, PDF (vector) and PPTX (freeform <a:quadBezTo>) export.
 * Run: node tests/curve-gui.mjs (needs a graphical session). MATHSLIDES_TEST_OUTPUT keeps the files and screenshots.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import JSZip from 'jszip';
import { testElectronEnv } from './electron-env.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.MATHSLIDES_TEST_OUTPUT || await mkdtemp(path.join(tmpdir(), 'mathslides-curve-out-'));
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-curve-profile-'));
const probe = netServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const debugPort = probe.address().port;
await new Promise((r) => probe.close(r));
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: 5193, strictPort: true } });
await server.listen();
const wrapper = path.join(profile, 'main.cjs');
await writeFile(wrapper, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});
if (process.env.TEST_OPEN_AT_START) app.emit('open-file', {preventDefault(){}}, process.env.TEST_OPEN_AT_START);\n`);

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
async function launch(env = {}) {
  electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`], { cwd: root, env: testElectronEnv({ ELECTRON_DEV_URL: 'http://127.0.0.1:5193', MATHSLIDES_TEST_PDF_DIR: output, ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
  electron.stderr.on('data', () => {});
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 'debug target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => { const d = JSON.parse(e.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(Error(d.error.message)) : p.resolve(d.result); } });
  await send('Runtime.enable');
  await until(() => evaluate(`!!document.querySelector('.propsbar')`), 'app mount');
  await evaluate(`(async () => {
    window.store = (await import('/src/store/store.ts')).useStore;
    window.persist = await import('/src/store/persistence.ts');
    window.testFiles = {};
    window.showSaveFilePicker = async ({suggestedName}) => ({name: suggestedName, createWritable: async () => ({
      write: async (blob) => { testFiles[suggestedName] = [...new Uint8Array(await blob.arrayBuffer())]; }, close: async () => {} }) });
  })()`);
}
async function quit() { socket?.close(); if (electron?.exitCode === null) { electron.kill('SIGTERM'); await new Promise((r) => electron.once('exit', r)); } }
const center = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw Error('Missing ' + ${JSON.stringify(sel)}); const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
async function click(sel) {
  const r = await center(sel);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...r });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...r }); await pause(200);
}
async function clickMenu(text) {
  await click('.tb-center button[title="도형"]');
  const i = await evaluate(`[...document.querySelectorAll('.pop .menu-item')].findIndex((e) => e.textContent.trim().endsWith(${JSON.stringify(text)}))`);
  assert.ok(i >= 0, 'menu item ' + text);
  await click(`.pop .menu-item:nth-child(${i + 1})`);
}
let scale = 1;
/** Drags the element at `sel` by (dx, dy) slide px with real mouse events. */
async function drag(sel, dx, dy) {
  const r = await center(sel);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...r });
  for (const f of [0.25, 0.6, 1]) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: r.x + dx * scale * f, y: r.y + dy * scale * f });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: r.x + dx * scale, y: r.y + dy * scale }); await pause(250);
}
const shot = async (name) => { const r = await send('Page.captureScreenshot'); await writeFile(path.join(output, name + '.png'), Buffer.from(r.data, 'base64')); };
const lines = () => evaluate("store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements.filter((e) => e.type === 'line')");
const one = async (lid) => (await lines()).find((l) => l.id === lid);
const past = () => evaluate('store.getState().past.length');
const pathD = (lid, scope = '.slide.editable') => evaluate(`document.querySelector('${scope} [data-el-id="${lid}"] path.curve-path')?.getAttribute('d') ?? null`);
const midOf = (l) => ({ x: 0.25 * l.x1 + 0.5 * l.cx + 0.25 * l.x2, y: 0.25 * l.y1 + 0.5 * l.cy + 0.25 * l.y2 });

try {
  await launch();
  scale = await evaluate("document.querySelector('.slide.editable').getBoundingClientRect().width / 1280");
  await evaluate("store.getState().deck.slides.length > 1 || true"); // fresh profile: one empty slide

  // ---- menu ----
  await click('.tb-center button[title="도형"]');
  const menu = await evaluate("[...document.querySelectorAll('.pop .menu-item')].map((e) => e.textContent.trim())");
  assert.equal(menu.length, 9, menu.join('|')); // 5 shapes/lines + 아래쪽 화살표 + 두꺼운 화살표 + 곡선 + 곡선 화살표
  assert.ok(menu[7].endsWith('곡선') && menu[8].endsWith('곡선 화살표'), 'curve items at the end: ' + menu.join('|'));
  await click('.tb-center button[title="도형"]'); // close

  // ---- insert a curved arrow ----
  const h0 = await past();
  await clickMenu('곡선 화살표');
  let [A] = await lines();
  assert.ok(A && Number.isFinite(A.cx) && Number.isFinite(A.cy), 'inserted with a control point: ' + JSON.stringify(A));
  assert.ok(A.arrowEnd && !A.arrowStart && !A.dashed);
  assert.ok(A.cy < A.y1, 'default bend is upward');
  assert.equal(await past(), h0 + 1, 'insert = one undo step');
  assert.match(await pathD(A.id), /^M[\d.]+ [\d.]+ Q/, 'drawn as a quadratic path');
  assert.equal(await evaluate(`document.querySelectorAll('.slide.editable [data-el-id="${A.id}"] polygon').length`), 1, 'one arrowhead');
  assert.equal(await evaluate("document.querySelectorAll('.slide.editable .handle.round').length"), 2, 'endpoint handles');
  assert.equal(await evaluate("document.querySelectorAll('.slide.editable .handle.adjust-bend').length"), 1, 'bend handle shown when selected');
  const hb = await center('.handle.adjust-bend'), sr = await evaluate("(() => { const r = document.querySelector('.slide.editable').getBoundingClientRect(); return {x: r.x, y: r.y}; })()");
  const m0 = midOf(A);
  assert.ok(Math.abs((hb.x - sr.x) / scale - m0.x) < 1.5 && Math.abs((hb.y - sr.y) / scale - m0.y) < 1.5, 'bend handle sits on the curve middle');
  // The arrowhead points along the curve's end tangent (down-right for an upward arc), not along the chord.
  const tipDir = await evaluate(`(() => { const p = document.querySelector('.slide.editable [data-el-id="${A.id}"] polygon').getAttribute('points').split(' ').map((s) => s.split(',').map(Number)); return [p[0][0] - (p[1][0] + p[2][0]) / 2, p[0][1] - (p[1][1] + p[2][1]) / 2]; })()`);
  assert.ok(tipDir[0] > 0 && tipDir[1] > 0, 'arrowhead follows the tangent: ' + tipDir);
  await shot('curve-1-inserted');

  // ---- bend handle drag: deeper and flipped ----
  const h1 = await past();
  await drag('.handle.adjust-bend', 0, -50);
  let a = await one(A.id);
  const m1 = midOf(a);
  assert.ok(Math.abs(m1.y - (m0.y - 50)) <= 1.5 && Math.abs(m1.x - m0.x) <= 1.5, 'curve middle follows the pointer: ' + JSON.stringify([m0, m1]));
  assert.deepEqual([a.x1, a.y1, a.x2, a.y2], [A.x1, A.y1, A.x2, A.y2], 'endpoints untouched');
  assert.ok(a.y <= m1.y + 0.5 && a.y + a.h >= A.y1, 'bbox covers the deeper curve');
  assert.equal(await past(), h1 + 1, 'one undo step per drag');
  await drag('.handle.adjust-bend', 0, 220); // through the chord → bends downward
  a = await one(A.id);
  assert.ok(a.cy > a.y1, 'bend direction flipped downward');
  // Undo/redo through the toolbar.
  await click('.tb-right button[title^="실행 취소"]');
  a = await one(A.id);
  assert.ok(a.cy < a.y1 && Math.abs(midOf(a).y - m1.y) <= 1.5, 'undo restores the upward bend');
  await click('.tb-right button[title^="다시 실행"]');
  assert.ok((await one(A.id)).cy > A.y1, 'redo re-applies the downward bend');
  await click('.tb-right button[title^="실행 취소"]'); // back to the deep upward bend
  a = await one(A.id);

  // ---- endpoint drag keeps the bend relative to the chord ----
  const sideOf = (l) => Math.sign((l.x2 - l.x1) * (l.cy - l.y1) - (l.y2 - l.y1) * (l.cx - l.x1));
  const before = a;
  await drag('.handle.round:nth-of-type(2)', 0, 120); // p2 down
  a = await one(A.id);
  assert.ok(a.y2 - before.y2 > 100, 'tip moved: ' + [before.y2, a.y2]);
  assert.equal(sideOf(a), sideOf(before), 'bend stays on the same side of the chord');
  const depth = (l) => Math.abs((l.x2 - l.x1) * (l.cy - l.y1) - (l.y2 - l.y1) * (l.cx - l.x1)) / Math.hypot(l.x2 - l.x1, l.y2 - l.y1) ** 2;
  assert.ok(Math.abs(depth(a) - depth(before)) < 0.02, 'relative depth kept: ' + [depth(before), depth(a)]);

  // ---- style through the props bar: color, width, start arrowhead, dashed ----
  await click('.propsbar button[title^="선 색"]');
  await click('.text-palette .standard-colors .text-swatch:nth-child(1)'); // Red of the shared palette (#DC2626)
  await click('.propsbar button[title="선 두께"]');
  await click('.pop [data-width="6"]');
  await click('.propsbar button[title="시작 화살표"]');
  a = await one(A.id);
  assert.deepEqual([a.stroke, a.strokeWidth, a.arrowStart, a.arrowEnd], ['#DC2626', 6, true, true]);
  assert.equal(await evaluate(`document.querySelector('.slide.editable [data-el-id="${A.id}"] path.curve-path').getAttribute('stroke')`), '#DC2626');
  assert.equal(await evaluate(`[...document.querySelectorAll('.slide.editable [data-el-id="${A.id}"] polygon')].filter((p) => p.getAttribute('fill') === '#DC2626').length`), 2, 'both heads in the line color');
  await click('.propsbar button[title="시작 화살표"]'); // back to one head
  await shot('curve-2-styled');

  // ---- plain curve + straight ↔ curve toggle; straight lines unaffected ----
  await clickMenu('곡선');
  const all = await lines();
  const B = all.find((l) => l.id !== A.id);
  assert.ok(Number.isFinite(B.cx) && !B.arrowEnd && !B.arrowStart, 'plain curve: no arrowheads');
  await evaluate(`store.getState().updateElements(['${B.id}'], (e) => { e.x1 += 0; })`);
  await click('.tb-center button[title="도형"]');
  await click('.pop .menu-item:nth-child(5)'); // → 화살표 (straight)
  const S = (await lines()).find((l) => l.id !== A.id && l.id !== B.id);
  assert.ok(!('cx' in S) && S.arrowEnd, 'straight arrow has no control point');
  assert.equal(await evaluate("document.querySelectorAll('.slide.editable .handle.adjust-bend').length"), 0, 'no bend handle on a straight line');
  assert.ok(await evaluate(`!!document.querySelector('.slide.editable [data-el-id="${S.id}"] line:not(.line-hit)')`), 'straight line still drawn as <line>');
  await click('.propsbar button[title^="직선 → 곡선"]');
  let s2 = await one(S.id);
  assert.ok(Number.isFinite(s2.cx), 'toggle makes it curved');
  await click('.propsbar button[title="곡선 → 직선"]');
  s2 = await one(S.id);
  assert.ok(!('cx' in s2) && !('cy' in s2), 'toggle back removes the control point');
  assert.deepEqual([s2.x, s2.y, s2.w, s2.h], [S.x, S.y, S.w, S.h], 'straight box restored');
  // Move the curve with the keyboard-free nudge path (whole element translate keeps the shape).
  await evaluate(`store.getState().select(['${B.id}'])`); await pause(150);
  const b0 = await one(B.id);
  await evaluate("import('/src/canvas/arrange.ts').then((m) => m.nudgeSelection(0, 120))"); await pause(150);
  const b1 = await one(B.id);
  assert.deepEqual([b1.cx - b0.cx, b1.cy - b0.cy, b1.y1 - b0.y1], [0, 120, 120], 'moving moves the control point too');
  // Duplicate keeps the curve.
  await evaluate("import('/src/canvas/insert.ts').then((m) => m.duplicateSelection())"); await pause(250);
  const dup = (await lines()).at(-1);
  assert.deepEqual([dup.cx - dup.x1, dup.cy - dup.y1], [b1.cx - b1.x1, b1.cy - b1.y1], 'duplicate keeps the bend');
  await evaluate('store.getState().deleteSelection()'); await pause(150);
  await evaluate(`store.getState().select(['${A.id}'])`); await pause(200);

  // ---- same geometry in thumbnail, presenter and print DOM ----
  const dEditor = await pathD(A.id);
  assert.equal(await pathD(A.id, '.thumb.current'), dEditor, 'thumbnail');
  await evaluate('store.setState({presenting: true})'); await pause(400);
  assert.equal(await pathD(A.id, '.presenter'), dEditor, 'presenter');
  await evaluate('store.setState({presenting: false})'); await pause(300);

  // ---- save .mslides, quit, reopen through the Finder open-file path in a fresh app ----
  const deckBefore = JSON.parse(await evaluate('JSON.stringify(store.getState().deck)'));
  await evaluate("store.setState((s) => ({deck: {...s.deck, title: 'Curve check'}}))");
  await evaluate('persist.saveProject()');
  await until(() => evaluate("testFiles['Curve check.mslides']?.length > 100"), 'saved .mslides');
  const file = path.join(output, 'Curve check.mslides');
  await writeFile(file, Buffer.from(await evaluate("testFiles['Curve check.mslides']")));
  const saved = JSON.parse(await readFile(file, 'utf8'));
  const savedLines = saved.deck.slides.flatMap((s) => s.elements).filter((e) => e.type === 'line');
  assert.deepEqual(savedLines.map((l) => [l.id, l.cx, l.cy]), deckBefore.slides.flatMap((s) => s.elements).filter((e) => e.type === 'line').map((l) => [l.id, l.cx, l.cy]), 'control points saved');
  await evaluate("store.getState().newProject?.()").catch(() => {});
  await quit(); await pause(500);
  await launch({ TEST_OPEN_AT_START: file });
  await until(() => evaluate("store.getState().deck.title === 'Curve check'"), 'reopened file');
  const reopened = JSON.parse(await evaluate('JSON.stringify(store.getState().deck)'));
  const ra = reopened.slides.flatMap((s) => s.elements).find((e) => e.id === A.id);
  assert.deepEqual(ra, savedLines.find((l) => l.id === A.id), 'reopened curve identical');
  await evaluate(`store.getState().goToSlide(${JSON.stringify(reopened.slides.find((s) => s.elements.some((e) => e.id === A.id)).id)}); store.getState().select(['${A.id}'])`); await pause(300);
  assert.equal(await pathD(A.id), dEditor, 'reopened: same rendered path');
  await shot('curve-3-reopened');

  // ---- PDF (vector): print DOM path + curve operators in the PDF content stream ----
  await evaluate("store.setState({exportMode: 'print'})"); await pause(500);
  assert.equal(await pathD(A.id, '#print-root'), dEditor, 'print DOM');
  await evaluate("store.setState({exportMode: null})"); await pause(300);
  await evaluate("import('/src/export/run.ts').then((m) => m.exportPdf())");
  const pdfPath = path.join(output, 'Curve check.pdf');
  await until(async () => (await readdir(output)).includes('Curve check.pdf') && (await readFile(pdfPath)).length > 1000, 'PDF export', 30000);
  const pdf = await readFile(pdfPath);
  const streams = [];
  for (let i = pdf.indexOf('stream'); i >= 0; i = pdf.indexOf('stream', i + 6)) {
    const start = pdf[i + 6] === 0x0d ? i + 8 : i + 7, end = pdf.indexOf('endstream', start);
    if (end < 0) break;
    try { streams.push(zlib.inflateSync(pdf.subarray(start, end)).toString('latin1')); } catch {}
  }
  // Chromium writes the curve as cubic Bézier segments ("x y x y x y c") stroked in the line's red (#DC2626 = 0.863 0.149 0.149).
  assert.ok(streams.some((s) => /[\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+ c\b/.test(s)), 'PDF has a vector curve');
  assert.ok(streams.some((s) => /0?\.86\d* 0?\.14\d* 0?\.14\d* (RG|SC|SCN)/.test(s)), 'PDF stroke color is the line color');

  // ---- PPTX: open freeform with a quadratic Bézier and native arrowhead ----
  await evaluate("import('/src/export/run.ts').then((m) => m.exportPptx())");
  await until(() => evaluate("testFiles['Curve check.pptx']?.length > 1000"), 'PPTX export', 30000);
  const pptxBuf = Buffer.from(await evaluate("testFiles['Curve check.pptx']"));
  await writeFile(path.join(output, 'Curve check.pptx'), pptxBuf);
  const zip = await JSZip.loadAsync(pptxBuf);
  const slideNo = reopened.slides.findIndex((s) => s.elements.some((e) => e.id === A.id)) + 1;
  const xml = await zip.file(`ppt/slides/slide${slideNo}.xml`).async('string');
  const sps = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
  const curved = sps.filter((s) => s.includes('<a:quadBezTo>'));
  assert.equal(curved.length, 2, 'curved arrow and curve are freeforms');
  const arrowSp = curved.find((s) => s.includes('name="Curved Arrow"'));
  assert.ok(arrowSp, 'named Curved Arrow');
  assert.match(arrowSp, /<a:tailEnd type="triangle"\/>/); assert.doesNotMatch(arrowSp, /<a:headEnd/);
  assert.match(arrowSp, /<a:noFill\/>/); assert.match(arrowSp, /val="DC2626"/); assert.match(arrowSp, /<a:ln w="57150">/, '6px = 4.5pt');
  assert.doesNotMatch(arrowSp, /<a:close/, 'open path');
  // The path in the file is the on-screen curve: moveTo = start, quadBezTo = (control, end), relative to the curve's box.
  const emu = (v) => Math.round((v / 96) * 914400);
  const [off] = [...arrowSp.matchAll(/<a:off x="(\d+)" y="(\d+)"\/>/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const pts = [...arrowSp.matchAll(/<a:pt x="(-?\d+)" y="(-?\d+)"/g)].map((m) => [Number(m[1]) + off[0], Number(m[2]) + off[1]]);
  const want = [[ra.x1, ra.y1], [ra.cx, ra.cy], [ra.x2, ra.y2]].map(([x, y]) => [emu(x), emu(y)]);
  pts.forEach((p, i) => assert.ok(Math.abs(p[0] - want[i][0]) < 2000 && Math.abs(p[1] - want[i][1]) < 2000, `PPTX point ${i}: ${p} vs ${want[i]}`));
  assert.ok(sps.some((s) => s.includes('prst="line"')), 'the straight arrow is still a native line');
  console.log('PASS curve GUI (menu, insert, bend handle, endpoint drag, color/width/heads, toggle, move/duplicate, undo/redo, thumbnail/presenter/print, save→quit→reopen, PDF vector curve, PPTX quadBezTo)');
  console.log('output: ' + output);
} finally {
  await quit();
  await server.close();
}
