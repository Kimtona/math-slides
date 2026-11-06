/** Real-flow regression for dragging symbols of a rendered equation (partial math color):
 * type an equation (the LaTeX popover stays open) -> drag one symbol with real mouse events -> top Text Color palette.
 * Also: multi-symbol drag, \frac / \sum symbols, click vs drag, plain text selection, undo/redo, 기본 색상,
 * save -> reopen, PPTX and PDF output. Real Electron window on a disposable profile (needs a graphical session; hidden by default).
 * Run: node tests/math-leaf-drag.mjs   (PDF raster check needs poppler's pdftoppm; skipped with a notice without it)
 */
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import JSZip from 'jszip';
import { testElectronEnv } from './electron-env.mjs';
import { makeTempDir } from './tmp-utils.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = makeTempDir('mathslides-leafdrag-profile-');
const freePort = async () => { const p = netServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const n = p.address().port; await new Promise((r) => p.close(r)); return n; };
const debugPort = await freePort();
const vitePort = await freePort();
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: vitePort, strictPort: true } });
await server.listen();
const wrapper = path.join(profile, 'main.cjs');
const pdfPort = await freePort();
// Test-only wrapper: same printToPDF options as the app's 'print-to-pdf' IPC (electron/main.cjs), served on a local port instead of a save dialog.
await writeFile(wrapper, `const { app, BrowserWindow } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});
require('http').createServer(async (_q, res) => { try { const d = await BrowserWindow.getAllWindows()[0].webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { marginType: 'none' }, pageRanges: '1' }); res.end(d); } catch (e) { res.statusCode = 500; res.end(String(e)); } }).listen(${pdfPort}, '127.0.0.1');\n`);

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
    window.defaults = await import('/src/model/defaults.ts'); window.persist = await import('/src/store/persistence.ts'); window.mathNodes = await import('/src/editor/mathNodes.ts');
    window.testFiles = {};
    window.showSaveFilePicker = async ({suggestedName}) => ({name:suggestedName,createWritable:async()=>({write:async(blob)=>{testFiles[suggestedName]=[...new Uint8Array(await blob.arrayBuffer())]},close:async()=>{}})});
  })()`);
}
async function quit() { socket?.close(); if (electron?.exitCode === null) { electron.kill('SIGTERM'); await new Promise((r) => electron.once('exit', r)); } }

// ---- real mouse input (Chromium input pipeline, same path as a physical mouse) ----
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', ...extra });
async function click(x, y) { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, { clickCount: 1, buttons: 1 }); await mouse('mouseReleased', x, y, { clickCount: 1, buttons: 0 }); await pause(200); }
async function drag(from, to, steps = 8) {
  await mouse('mouseMoved', from.x, from.y);
  await mouse('mousePressed', from.x, from.y, { clickCount: 1, buttons: 1 });
  for (let k = 1; k <= steps; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: from.x + (to.x - from.x) * k / steps, y: from.y + (to.y - from.y) * k / steps });
  await mouse('mouseReleased', to.x, to.y, { clickCount: 1, buttons: 0 }); await pause(250);
}
const center = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw Error('Missing ' + ${JSON.stringify(sel)}); const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
const clickSel = async (sel) => { const c = await center(sel); await click(c.x, c.y); };

const LEAF = ['mi', 'mn', 'mo', 'mtext', 'ms'].map((t) => `g[data-mml-node="${t}"]`).join(',');
const scoped = (scope) => JSON.stringify(LEAF.split(',').map((s) => scope + ' ' + s).join(','));
const leafInfo = (scope, i) => evaluate(`(() => { const g = document.querySelectorAll(${scoped(scope)})[${i}]; const r = g.getBoundingClientRect(); return {l: r.left, r: r.right, t: r.top, b: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2}; })()`);
const leafCount = (scope) => evaluate(`document.querySelectorAll(${scoped(scope)}).length`);
/** Index (in leaf order) of the symbol whose glyph has this unicode data-c. */
const leafOf = (scope, dataC) => evaluate(`[...document.querySelectorAll(${scoped(scope)})].findIndex((g) => g.querySelector('path[data-c="${dataC}"]'))`);
const fills = (scope) => evaluate(`[...document.querySelectorAll(${scoped(scope)})].map((g) => g.getAttribute('fill'))`);
const mathAttrs = (kind) => evaluate(`(() => { let a; active().state.doc.descendants((n) => { if (n.type.name === ${JSON.stringify(kind)}) a = n.attrs; }); return JSON.stringify(a); })()`).then(JSON.parse);
const leafSel = () => evaluate('JSON.stringify(store.getState().mathLeafSel)').then(JSON.parse);
const TEXT = '.propsbar button[title^="글자 색 (Text Color)"]';
const B = '#2563EB', R = '#DC2626';
const M = '1D45A', C_ = '1D450', A = '1D44E', X = '1D465';

/** The user's path: new text box -> insert an equation (LaTeX popover opens) -> type its LaTeX. The popover is left OPEN. */
async function typeEquation(latex, kind = 'mathInline') {
  await evaluate(`store.getState().addElements([defaults.newText(100,200,{w:600})],{edit:true})`);
  await until(() => evaluate('!!active()'), 'editor');
  await evaluate(`mathNodes.insertMath(active(), ${kind === 'mathBlock'})`);
  await until(() => evaluate(`!!document.querySelector('.math-popover .math-input')`), 'LaTeX popover');
  await evaluate(`document.querySelector('.math-popover .math-input').focus()`); await pause(150);
  await send('Input.insertText', { text: latex }); await pause(300);
  const scope = `.el.editing .${kind === 'mathBlock' ? 'math-block' : 'math-inline'}`;
  await until(() => evaluate(`!!document.querySelector('${scope} svg')`), 'equation rendered'); await pause(200);
  assert.equal(await evaluate('!!store.getState().mathEdit'), true, 'the LaTeX popover is open (as right after typing)');
  return scope;
}
const pickColor = async (n) => { await clickSel(TEXT); await until(() => evaluate(`!!document.querySelector('.text-palette')`), 'palette'); await clickSel(`.text-palette .standard-colors .text-swatch:nth-child(${n})`); await pause(300); };
const countHl = (scope) => evaluate(`document.querySelectorAll('${scope} .math-leaf-hl').length`);

try {
  await launch();

  // ===== 1. E = mc^2: type it, then drag just "m" =====
  const S = await typeEquation('E = mc^2');
  const latex0 = (await mathAttrs('mathInline')).latex;
  assert.equal(latex0, 'E = mc^2'); assert.equal(await leafCount(S), 5);
  const mIdx = await leafOf(S, M), cIdx = await leafOf(S, C_);
  assert.deepEqual([mIdx, cIdx], [2, 3]);
  const past0 = await evaluate('store.getState().past.length');
  let m = await leafInfo(S, mIdx);
  await drag({ x: m.cx - 3, y: m.cy }, { x: m.cx + 3, y: m.cy });          // a short drag inside the single glyph
  assert.deepEqual((await leafSel())?.leaves, [2], 'dragging within "m" selects only m');
  assert.equal(await evaluate('!!store.getState().mathEdit'), false, 'the drag closed the LaTeX popover');
  assert.equal(await countHl(S), 1, 'one highlight box');
  const hl = await evaluate(`(() => { const r = document.querySelector('${S} .math-leaf-hl').getBoundingClientRect(); return {l: r.left, r: r.right, t: r.top, b: r.bottom}; })()`);
  m = await leafInfo(S, mIdx);
  assert.ok(Math.abs(hl.l - m.l) < 4 && Math.abs(hl.r - m.r) < 4 && Math.abs(hl.t - m.t) < 4 && Math.abs(hl.b - m.b) < 4, 'the highlight sits exactly on m');
  assert.equal(await evaluate('store.getState().past.length'), past0, 'selecting is not an undo step');
  assert.deepEqual(await mathAttrs('mathInline'), { latex: latex0, colors: null }, 'selecting changes nothing in the data');

  // top toolbar: clicking it (real mouse) must not drop the selection, then Blue from the existing palette
  await clickSel(TEXT); await until(() => evaluate(`!!document.querySelector('.text-palette')`), 'palette');
  assert.deepEqual((await leafSel())?.leaves, [2], 'opening the toolbar palette keeps the symbol selection');
  assert.equal(await countHl(S), 1);
  await clickSel('.text-palette .standard-colors .text-swatch:nth-child(7)'); await pause(300);
  let a = await mathAttrs('mathInline');
  assert.equal(a.latex, latex0, 'LaTeX untouched (no \\textcolor)'); assert.deepEqual(a.colors, { src: latex0, items: [{ i: 2, c: B }] });
  assert.deepEqual(await fills(S), [null, null, B, null, null], 'only m is blue');
  assert.equal(await evaluate('store.getState().past.length') - past0, 0 + (await evaluate('store.getState().gestureBase') ? 0 : 1) , 'one history step (or inside the open editing gesture)');

  // re-color the same symbol, then add c with a multi-symbol drag
  await pickColor(1);
  assert.deepEqual((await mathAttrs('mathInline')).colors.items, [{ i: 2, c: R }], 'a second color replaces the first');
  m = await leafInfo(S, mIdx); const c = await leafInfo(S, cIdx);
  await drag({ x: m.l + 1, y: m.cy }, { x: c.cx, y: c.cy });
  assert.deepEqual((await leafSel())?.leaves, [2, 3], 'dragging from m to c selects m and c'); assert.equal(await countHl(S), 2);
  await pickColor(7);
  assert.deepEqual(await fills(S), [null, null, B, B, null]);
  // 기본 색상 resets just the picked symbols
  await drag({ x: c.cx - 3, y: c.cy }, { x: c.cx + 3, y: c.cy });
  assert.deepEqual((await leafSel())?.leaves, [3]);
  await clickSel(TEXT); await until(() => evaluate(`!!document.querySelector('.text-palette')`), 'palette');
  await evaluate(`[...document.querySelectorAll('.text-palette .palette-other')].find((b) => b.textContent.includes('기본 색상')).click()`); await pause(300);
  assert.deepEqual(await fills(S), [null, null, B, null, null], '기본 색상 restores only the picked symbol');
  assert.deepEqual((await mathAttrs('mathInline')).colors, { src: latex0, items: [{ i: 2, c: B }] });
  // undo / redo
  await evaluate('active().commands.undo()'); await pause(250);
  assert.deepEqual(await fills(S), [null, null, B, B, null], 'undo');
  await evaluate('active().commands.redo()'); await pause(250);
  assert.deepEqual(await fills(S), [null, null, B, null, null], 'redo');
  console.log('PASS E = mc^2: typed -> drag m -> toolbar blue; multi-symbol, 기본 색상, undo/redo');

  // ===== 2. click vs drag =====
  m = await leafInfo(S, mIdx);
  await click(m.cx, m.cy);
  await until(() => evaluate('!!store.getState().mathEdit'), 'a plain click opens the LaTeX popover');
  assert.equal(await evaluate(`document.querySelector('.math-popover .math-input').value`), latex0, 'popover shows the plain LaTeX only');
  assert.equal(await leafSel(), null, 'a click selects no symbols');
  await evaluate(`mathNodes.commitMath(active(), store.getState().mathEdit.pos)`); await pause(200);
  m = await leafInfo(S, mIdx);
  await mouse('mouseMoved', m.cx, m.cy); await mouse('mousePressed', m.cx, m.cy, { clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: m.cx + 1, y: m.cy });
  await mouse('mouseReleased', m.cx + 1, m.cy, { clickCount: 1, buttons: 0 }); await pause(250);
  assert.equal(await evaluate('!!store.getState().mathEdit'), true, '1px of hand jitter still counts as a click');
  assert.equal(await leafSel(), null);
  await evaluate(`mathNodes.commitMath(active(), store.getState().mathEdit.pos)`); await pause(200);
  // plain text drag selection is untouched
  await evaluate(`active().chain().focus('start').insertContent('hello world ').run()`); await pause(250);
  const tr = await evaluate(`(() => { const p = document.querySelector('.el.editing .tb-content p'); const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); const n = w.nextNode(); const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 5); const b = r.getBoundingClientRect(); return {l: b.left, r: b.right, y: (b.top + b.bottom) / 2}; })()`);
  await drag({ x: tr.l + 10, y: tr.y }, { x: tr.r - 2, y: tr.y }); // from inside the text, clear of the box-border move handle
  assert.equal(await leafSel(), null, 'dragging over ordinary text selects text, not symbols');
  assert.ok(await evaluate('!active().state.selection.empty'), 'a normal text selection exists');
  console.log('PASS click opens the editor, jitter is a click, text drag selection unchanged');

  // ===== 3. save -> reopen, PPTX, PDF keep the partial color =====
  await evaluate('store.getState().stopEditing()'); await pause(400);
  assert.deepEqual(await fills('.slide.editable .math-inline'), [null, null, B, null, null], 'static (non-editing) rendering');
  await evaluate('persist.saveProject()'); await pause(800);
  const fileName = await evaluate("Object.keys(testFiles).find((k) => k.endsWith('.mslides'))");
  const fileText = Buffer.from(await evaluate(`testFiles[${JSON.stringify(fileName)}]`)).toString('utf8');
  assert.ok(fileText.includes('"colors":{"src":"E = mc^2","items":[{"i":2,"c":"' + B + '"}]}'), 'colors are stored as node metadata in the file');
  assert.ok(!/textcolor/.test(fileText), 'no \\textcolor was ever inserted');
  await evaluate('persist.newProject()'); await pause(600);
  assert.equal(await evaluate(`document.querySelectorAll('.slide.editable .math-inline').length`), 0);
  await evaluate(`persist.openFromText(${JSON.stringify(fileText)}, null)`); await pause(900);
  assert.deepEqual(await fills('.slide.editable .math-inline'), [null, null, B, null, null], 'after save + reopen');
  console.log('PASS save / reopen');

  await evaluate("document.querySelector('.export-menu > button').click()"); await pause(200);
  await evaluate("document.querySelector('.pop .menu-item:nth-child(2)').click()");
  const pptx = await until(() => evaluate("Object.keys(testFiles).find((k) => k.endsWith('.pptx'))"), 'PPTX export', 40000);
  await until(() => evaluate(`testFiles[${JSON.stringify(pptx)}]?.length > 1000`), 'PPTX bytes', 40000);
  const zip = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(pptx)}]`)));
  const svgs = await Promise.all(Object.keys(zip.files).filter((f) => /^ppt\/media\/.*\.svg$/.test(f)).map((f) => zip.file(f).async('string')));
  const eq = svgs.find((s) => /data-latex|data-mml-node="math"/.test(s) || s.includes('data-c="1D45A"'));
  assert.ok(eq, 'the equation is in the PPTX as an SVG picture');
  assert.equal([...eq.matchAll(/fill="#2563EB"/gi)].length, 1, 'PPTX: exactly the one symbol m carries the blue fill');
  assert.ok(/fill="#[0-9a-f]{6}"/i.test(eq.replace(/fill="#2563EB"/gi, '')), 'PPTX: the other symbols keep the equation color (currentColor resolved)');
  console.log('PASS PPTX export keeps the partial color');

  // PDF: Chromium printToPDF of the 1:1 print DOM (what exportPdf prints), rasterized and checked for blue ink only around m
  await evaluate(`(async () => { store.getState().goToSlide(store.getState().deck.slides[0].id); store.setState({ exportMode: 'print', selection: [] }); await new Promise((r) => setTimeout(r, 600)); })()`);
  const geo = await evaluate(`(() => { const page = document.querySelector('#print-root .print-page'); const pr = page.getBoundingClientRect(); const g = [...page.querySelectorAll('${LEAF}')]; const out = g.map((e) => { const r = e.getBoundingClientRect(); return {l: r.left - pr.left, r: r.right - pr.left, t: r.top - pr.top, b: r.bottom - pr.top, fill: e.getAttribute('fill')}; }); return out; })()`);
  const mBox = geo.find((g) => g.fill === B); assert.ok(mBox, 'print DOM: m is blue');
  const pdf = Buffer.from(await (await fetch(`http://127.0.0.1:${pdfPort}/`)).arrayBuffer());
  await evaluate(`store.setState({ exportMode: null })`);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', 'a real PDF came back');
  const pdfFile = path.join(profile, 'out.pdf'); await writeFile(pdfFile, pdf);
  const ras = spawnSync('pdftoppm', ['-r', '96', '-f', '1', '-l', '1', pdfFile, path.join(profile, 'page')]);
  if (ras.error) console.log('SKIP PDF raster check (pdftoppm not installed); PDF produced:', pdfFile);
  else {
    const buf = await readFile(path.join(profile, readdirSync(profile).find((f) => /^page-\d+\.ppm$/.test(f))));
    // P6 header: "P6\n<w> <h>\n255\n"
    const m6 = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(buf.subarray(0, 40).toString('latin1')); assert.ok(m6, 'PPM header');
    const w = +m6[1], h = +m6[2], off = m6[0].length; assert.ok(Math.abs(w - 1280) <= 2 && Math.abs(h - 720) <= 2, `PDF page is 1280x720 px at 96dpi (got ${w}x${h})`);
    let n = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = off + (y * w + x) * 3; const r = buf[i], g = buf[i + 1], b = buf[i + 2]; if (b > 170 && r < 90 && g > 60 && g < 150) { n++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); } }
    assert.ok(n > 15, `PDF has blue ink (${n}px)`);
    assert.ok(minX >= mBox.l - 3 && maxX <= mBox.r + 3 && minY >= mBox.t - 3 && maxY <= mBox.b + 3, `PDF: all blue ink lies on m (${minX}-${maxX} x ${minY}-${maxY} vs ${Math.round(mBox.l)}-${Math.round(mBox.r)} x ${Math.round(mBox.t)}-${Math.round(mBox.b)})`);
    console.log(`PASS PDF export keeps the partial color (${n} blue px, only on m)`);
  }

  // ===== 4. \frac and \sum with the same typed-then-drag flow, as a display equation too =====
  await evaluate('persist.newProject()'); await pause(600);
  for (const [kind, latex, ch, want] of [['mathInline', '\\frac{a+b}{c}', A, 'a'], ['mathBlock', '\\sum_{i=1}^{n}x_i', X, 'x']]) {
    const sc = await typeEquation(latex, kind);
    const idx = await leafOf(sc, ch); assert.ok(idx >= 0, `leaf for ${want}`);
    const g = await leafInfo(sc, idx);
    await drag({ x: g.cx - 2, y: g.cy }, { x: g.cx + 2, y: g.cy });
    assert.deepEqual((await leafSel())?.leaves, [idx], `${latex}: only ${want} is selected`);
    await pickColor(7);
    const f = await fills(sc);
    assert.deepEqual(f.map((v, i) => (v === B ? i : -1)).filter((i) => i >= 0), [idx], `${latex}: only ${want} turned blue`);
    assert.equal((await mathAttrs(kind)).latex, latex);
    await evaluate('store.getState().stopEditing()'); await pause(300);
    await evaluate('store.getState().deselect?.() ?? store.setState({selection: []})');
  }
  console.log('PASS \\frac / \\sum (inline and display) typed -> drag -> color');
  // ===== 5. after the popover is closed: edit mode / selected-only / returning from another element =====
  await evaluate('persist.newProject()'); await pause(600);
  const boxes = () => evaluate(`JSON.stringify(store.getState().deck.slides[0].elements.map((e) => [e.id, Math.round(e.x), Math.round(e.y)]))`).then(JSON.parse);
  const S5 = await typeEquation('E = mc^2');
  const id5 = await evaluate('store.getState().editingId');
  await evaluate(`mathNodes.commitMath(active(), store.getState().mathEdit.pos)`); await pause(250);
  await evaluate(`active().chain().focus('start').insertContent('hi ').run()`); await pause(250);
  const posOf = async () => (await boxes()).find((b) => b[0] === id5);
  const mIdx5 = await leafOf(S5, M);

  // state 1: popover closed, box still in edit mode
  let g = await leafInfo(S5, mIdx5);
  assert.equal(await evaluate('!!store.getState().mathEdit'), false); assert.equal(await evaluate('store.getState().editingId'), id5);
  await drag({ x: g.cx - 3, y: g.cy }, { x: g.cx + 3, y: g.cy });
  assert.deepEqual((await leafSel())?.leaves, [mIdx5], 'state 1 (editing, popover closed): drag picks m');
  await pickColor(7);
  assert.equal((await fills(S5))[mIdx5], B);

  // state 2: box selected, NOT in edit mode -> press on a symbol picks (enters edit mode), anything else still moves the box
  await evaluate('store.getState().stopEditing()'); await pause(400);
  assert.equal(await evaluate('store.getState().editingId'), null); assert.deepEqual(await evaluate('store.getState().selection'), [id5]);
  const NS = `.slide.editable .el[data-el-id="${id5}"] .math-inline`;
  const p2 = await posOf();
  let sg = await leafInfo(NS, mIdx5);
  await drag({ x: sg.cx - 3, y: sg.cy }, { x: sg.cx + 3, y: sg.cy });
  assert.equal(await evaluate('store.getState().editingId'), id5, 'state 2: pressing a symbol of the selected box enters edit mode');
  assert.deepEqual((await leafSel())?.leaves, [mIdx5], 'state 2: and the drag picks m');
  assert.deepEqual(await posOf(), p2, 'state 2: the box did not move');
  assert.equal(await countHl(S5), 1);
  await pickColor(1);
  assert.equal((await fills(S5))[mIdx5], R, 'state 2: an existing blue is changed to red');
  // multi-symbol from the static box too
  await evaluate('store.getState().stopEditing()'); await pause(400);
  sg = await leafInfo(NS, mIdx5); const sc = await leafInfo(NS, mIdx5 + 1);
  await drag({ x: sg.l + 1, y: sg.cy }, { x: sc.cx, y: sc.cy });
  assert.deepEqual((await leafSel())?.leaves, [mIdx5, mIdx5 + 1], 'state 2: m..c picked from the static box');
  // a very fast flick (button already up before the editor mounted) still picks
  await evaluate('store.getState().stopEditing()'); await pause(400);
  sg = await leafInfo(NS, mIdx5);
  await drag({ x: sg.cx - 3, y: sg.cy }, { x: sg.cx + 3, y: sg.cy }, 1);
  assert.deepEqual((await leafSel())?.leaves, [mIdx5], 'state 2: a one-step flick picks too');
  // a plain click on the selected box's symbol opens the LaTeX popover (as before)
  await evaluate('store.getState().stopEditing()'); await pause(400);
  sg = await leafInfo(NS, mIdx5);
  await click(sg.cx, sg.cy);
  await until(() => evaluate('!!store.getState().mathEdit'), 'state 2: click opens the popover');
  assert.equal(await evaluate(`document.querySelector('.math-popover .math-input').value`), 'E = mc^2');
  await evaluate('store.getState().stopEditing()'); await pause(400);
  // dragging the text part of the selected box still moves it
  const tx = await evaluate(`(() => { const p = document.querySelector('.slide.editable .el[data-el-id="${id5}"] p'); const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); const n = w.nextNode(); const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 2); const b = r.getBoundingClientRect(); return {x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2}; })()`);
  const p3 = await posOf();
  await drag({ x: tx.x, y: tx.y }, { x: tx.x + 60, y: tx.y + 40 });
  const p4 = await posOf();
  assert.ok(p4[1] > p3[1] + 30 && p4[2] > p3[2] + 20, 'state 2: dragging the box away from the symbols still moves it');
  assert.equal(await evaluate('store.getState().editingId'), null);

  const clickTopLeft = async (elId) => { const r = await evaluate(`(() => { const r = document.querySelector('.slide.editable .el[data-el-id="${elId}"]').getBoundingClientRect(); return {x: r.x + 12, y: r.y + 8}; })()`); await click(r.x, r.y); };
  // state 3: select another element, come back, drag the symbol again (an unselected box: the first press still selects/moves as before)
  const other = (await boxes()).find((b) => b[0] !== id5);
  await clickTopLeft(other[0]);
  assert.deepEqual(await evaluate('store.getState().selection'), [other[0]], 'state 3: another element is selected');
  sg = await leafInfo(NS, mIdx5);
  const p5 = await posOf();
  await click(sg.cx, sg.cy);                                        // first click on the unselected box only selects it
  assert.deepEqual(await evaluate('store.getState().selection'), [id5]); assert.equal(await evaluate('store.getState().editingId'), null, 'state 3: one click selects, it does not open the editor');
  assert.deepEqual(await posOf(), p5);
  sg = await leafInfo(NS, mIdx5);
  await drag({ x: sg.cx - 3, y: sg.cy }, { x: sg.cx + 3, y: sg.cy });
  assert.deepEqual((await leafSel())?.leaves, [mIdx5], 'state 3: after re-selecting, dragging the symbol picks it');
  await pickColor(7);
  assert.equal((await fills(S5))[mIdx5], B, 'state 3: recolored');
  await clickSel(TEXT); await until(() => evaluate(`!!document.querySelector('.text-palette')`), 'palette');
  await evaluate(`[...document.querySelectorAll('.text-palette .palette-other')].find((b) => b.textContent.includes('기본 색상')).click()`); await pause(300);
  assert.equal((await fills(S5))[mIdx5], null, 'state 3: 기본 색상 restores it');
  // an unselected box dragged by a symbol is still just moved
  await evaluate('store.getState().stopEditing()'); await pause(300);
  await clickTopLeft(other[0]);
  sg = await leafInfo(NS, mIdx5); const p6 = await posOf();
  await drag({ x: sg.cx, y: sg.cy }, { x: sg.cx + 50, y: sg.cy + 30 });
  const p7 = await posOf();
  assert.ok(p7[1] > p6[1] + 30, 'an unselected box is moved by dragging its equation (existing UX kept)');
  assert.equal(await evaluate('store.getState().editingId'), null);
  console.log('PASS states: editing / selected-only / back from another element');
  // ===== 6. Shift+←/→ adjusts the picked range (real key events); Esc drops it; text / popover keys untouched =====
  await evaluate('persist.newProject()'); await pause(600);
  const VK = { ArrowLeft: 37, ArrowRight: 39, Escape: 27 };
  const NATIVE = { ArrowLeft: 'moveBackwardAndModifySelection', ArrowRight: 'moveForwardAndModifySelection' };
  const press = async (k, shift = false) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: VK[k], modifiers: shift ? 8 : 0, ...(shift && NATIVE[k] ? { commands: [NATIVE[k]] } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: VK[k], modifiers: shift ? 8 : 0 }); await pause(120);
  };
  const lv = async () => (await leafSel())?.leaves ?? null;
  const dragLeaf = async (scope, idx) => { const q = await leafInfo(scope, idx); await drag({ x: q.cx - 2, y: q.cy }, { x: q.cx + 2, y: q.cy }); };

  const S6 = await typeEquation('E = mc^2');                     // popover still open, as after typing
  const m6 = await leafOf(S6, M);
  await dragLeaf(S6, m6);
  assert.deepEqual(await lv(), [2]);
  await press('ArrowRight', true); assert.deepEqual(await lv(), [2, 3], 'Shift+→ : m -> mc'); assert.equal(await countHl(S6), 2, 'highlight follows the key immediately');
  await press('ArrowLeft', true);  assert.deepEqual(await lv(), [2], 'Shift+← shrinks back to m (anchor stays)'); assert.equal(await countHl(S6), 1);
  await press('ArrowLeft', true);  assert.deepEqual(await lv(), [1, 2], 'Shift+← again extends to the left past the anchor');
  await press('ArrowRight', true); assert.deepEqual(await lv(), [2], 'Shift+→ shrinks it again');
  assert.deepEqual({ a: (await leafSel()).anchor, f: (await leafSel()).focus }, { a: 2, f: 2 });
  // both ends of the equation, and clamping
  for (let i = 0; i < 4; i++) await press('ArrowLeft', true);
  assert.deepEqual(await lv(), [0, 1, 2], 'first symbol reached, and the range stops there'); assert.equal(await countHl(S6), 3);
  for (let i = 0; i < 8; i++) await press('ArrowRight', true);
  assert.deepEqual(await lv(), [2, 3, 4], 'last symbol reached (focus ran past the anchor), clamped at the end');
  await dragLeaf(S6, 0); assert.deepEqual(await lv(), [0], 'a drag on the very first symbol selects just it');
  await press('ArrowRight', true); assert.deepEqual(await lv(), [0, 1]);
  await dragLeaf(S6, 4); assert.deepEqual(await lv(), [4], 'and on the very last symbol');
  await press('ArrowLeft', true); assert.deepEqual(await lv(), [3, 4]);
  // the existing palette applies to the keyboard-adjusted range, and the keys keep working afterwards (focus is on the toolbar)
  await dragLeaf(S6, m6); await press('ArrowRight', true);
  await pickColor(7);
  assert.deepEqual(await fills(S6), [null, null, B, B, null], 'palette colors the m..c range chosen with the keys');
  await press('ArrowRight', true); assert.deepEqual(await lv(), [2, 3, 4], 'Shift+→ still works after using the palette');
  await pickColor(1);
  assert.deepEqual(await fills(S6), [null, null, R, R, R]);
  // Esc drops the symbol selection only (box stays in edit mode); a second Esc leaves editing as before
  await press('Escape');
  assert.equal(await leafSel(), null, 'Esc clears the symbol selection'); assert.equal(await countHl(S6), 0);
  assert.ok(await evaluate('!!store.getState().editingId'), 'first Esc keeps the box in edit mode');
  assert.deepEqual(await fills(S6), [null, null, R, R, R], 'colors stay');
  await press('Escape'); assert.equal(await evaluate('store.getState().editingId'), null, 'second Esc leaves edit mode as before');
  console.log('PASS Shift+←/→ range adjust, anchor/focus, ends, palette, Esc');

  // fraction / sum with sub- and superscripts
  for (const [kind, latex, start, steps] of [['mathInline', '\\frac{a+b}{c}', A, [['R', [0, 1]], ['R', [0, 1, 2]], ['R', [0, 1, 2, 3]], ['R', [0, 1, 2, 3]], ['L', [0, 1, 2]]]],
                                             ['mathBlock', '\\sum_{i=1}^{n}x_i', X, [['L', [4, 5]], ['L', [3, 4, 5]], ['R', [4, 5]], ['R', [5]], ['R', [5, 6]]]]]) {
    const sc = await typeEquation(latex, kind);
    const idx = await leafOf(sc, start); await dragLeaf(sc, idx);
    assert.deepEqual(await lv(), [idx]);
    for (const [dir, want] of steps) { await press(dir === 'R' ? 'ArrowRight' : 'ArrowLeft', true); assert.deepEqual(await lv(), want, `${latex}: ${dir}`); }
    assert.equal(await countHl(sc), (await lv()).length);
    await pickColor(7);
    assert.deepEqual((await fills(sc)).map((v, i) => (v === B ? i : -1)).filter((i) => i >= 0), await lv(), `${latex}: palette colors exactly the selected range`);
    assert.equal((await mathAttrs(kind)).latex, latex);
    await evaluate('store.getState().stopEditing()'); await pause(300);
    await evaluate('store.setState({selection: []})');
  }
  console.log('PASS \\frac / \\sum range adjust + palette');

  // regression: without a symbol selection Shift+arrows are ordinary text selection; the LaTeX popover keeps its own caret keys
  await evaluate(`store.getState().addElements([defaults.newText(100,200,{w:600})],{edit:true})`);
  await until(() => evaluate('!!active()'), 'editor');
  await send('Input.insertText', { text: 'hello' }); await pause(200);
  assert.equal(await leafSel(), null);
  await press('ArrowLeft', true); await press('ArrowLeft', true);
  assert.equal(await evaluate('active().state.selection.to - active().state.selection.from'), 2, 'Shift+← still selects text in the editor');
  await press('Escape'); assert.equal(await evaluate('store.getState().editingId'), null, 'Esc without a symbol selection still ends editing');
  await evaluate(`store.getState().addElements([defaults.newText(100,500,{w:600})],{edit:true})`);
  await until(() => evaluate('!!active()'), 'editor 2');
  await evaluate(`mathNodes.insertMath(active(), false)`);
  await until(() => evaluate(`!!document.querySelector('.math-popover .math-input')`), 'popover');
  await evaluate(`document.querySelector('.math-popover .math-input').focus()`); await pause(150);
  await send('Input.insertText', { text: 'abcd' }); await pause(200);
  await press('ArrowLeft', true); await press('ArrowLeft', true); await press('ArrowLeft', true);
  assert.equal(await evaluate(`(() => { const t = document.querySelector('.math-popover .math-input'); return t.selectionEnd - t.selectionStart; })()`), 3, 'Shift+← selects text inside the LaTeX popover');
  assert.equal(await evaluate('!!store.getState().mathEdit'), true); assert.equal(await leafSel(), null);
  await press('ArrowRight'); assert.equal(await evaluate(`document.querySelector('.math-popover .math-input').selectionStart`), 4, 'plain arrows move the popover caret');
  await press('Escape'); // closes the popover as before
  console.log('PASS regression: editor text selection, Esc, LaTeX popover keys');
  // ===== 7. edge symbols: the pick zone just outside the first / last symbol, right-to-left drags, Shift+← from the last symbol =====
  await evaluate('persist.newProject()'); await pause(600);
  const S7 = await typeEquation('E = mcY2');
  await evaluate(`mathNodes.commitMath(active(), store.getState().mathEdit.pos)`); await pause(250);
  await evaluate(`active().chain().focus('start').insertContent('hi ').run()`); await pause(150);
  await evaluate(`active().chain().focus('end').insertContent(' tail').run()`); await pause(250);
  const ZONE = 8, IN = 5, OUT = ZONE + 4;        // pick zone width in styles.css (.math-inline::after); a press IN px into it / OUT px away from the symbols
  const g7 = async () => { const out = []; for (let i = 0; i < 6; i++) out.push(await leafInfo(S7, i)); return out; };
  const hitMath = (x, y) => evaluate(`!!document.elementFromPoint(${x}, ${y})?.closest('.math-inline')`);
  let L7 = await g7(); assert.equal(L7.length, 6);
  const last7 = L7[5], first7 = L7[0], y7 = last7.cy;
  // geometry: the zone is outside the glyphs, within 4px, and does not exist further out
  assert.equal(await hitMath(last7.r + ZONE - 1, y7), true, 'just inside the zone edge hits the equation');
  assert.equal(await hitMath(first7.l - ZONE + 1, y7), true);
  assert.equal(await hitMath(last7.r + ZONE + 1, y7), false, 'just outside the zone edge is text');
  assert.equal(await hitMath(last7.r + IN, y7), true, 'a press ' + IN + 'px right of the last symbol hits the equation');
  assert.equal(await hitMath(first7.l - IN, y7), true, 'a press ' + IN + 'px left of the first symbol hits the equation');
  assert.equal(await hitMath(last7.r + OUT, y7), false, OUT + 'px away is ordinary text again');
  assert.equal(await hitMath(first7.l - OUT, y7), false);
  const sel7 = async () => { const s = await leafSel(); return s && { l: s.leaves, a: s.anchor, f: s.focus }; };
  // A. first selection by dragging right -> left, starting in the zone / on the symbol / at its very edge
  for (const dx of [ZONE - 1, IN, 0, -1]) {
    await evaluate('store.getState().setMathLeafSel(null)'); L7 = await g7();
    await drag({ x: L7[5].r + dx, y: y7 }, { x: L7[3].cx, y: y7 });
    assert.deepEqual(await sel7(), { l: [3, 4, 5], a: 5, f: 3 }, `A: right-to-left from ${dx}px right of the last symbol selects c..2 (anchor 2, focus c)`);
    assert.equal(await countHl(S7), 3);
  }
  await evaluate('store.getState().setMathLeafSel(null)'); L7 = await g7();
  await drag({ x: L7[0].l - IN, y: y7 }, { x: L7[2].cx, y: y7 });
  assert.deepEqual(await sel7(), { l: [0, 1, 2], a: 0, f: 2 }, 'A: left-to-right from the zone left of the first symbol selects E..m');
  // a short drag from the zone picks exactly the nearest edge symbol and never its neighbour
  await evaluate('store.getState().setMathLeafSel(null)'); L7 = await g7();
  await drag({ x: L7[5].r + IN, y: y7 }, { x: L7[5].r - 2, y: y7 });
  assert.deepEqual(await sel7(), { l: [5], a: 5, f: 5 }, 'A: a short drag from the right zone selects only the last symbol');
  await evaluate('store.getState().setMathLeafSel(null)'); L7 = await g7();
  await drag({ x: L7[0].l - IN, y: y7 }, { x: L7[0].l + 3, y: y7 });
  assert.deepEqual(await sel7(), { l: [0], a: 0, f: 0 }, 'A: and only the first symbol on the left');
  // B. last symbol selected -> Shift+← one symbol at a time, Shift+→ back
  await evaluate('store.getState().setMathLeafSel(null)'); L7 = await g7();
  await drag({ x: L7[5].r + IN, y: y7 }, { x: L7[5].cx, y: y7 });
  assert.deepEqual(await sel7(), { l: [5], a: 5, f: 5 });
  for (const [want, f] of [[[4, 5], 4], [[3, 4, 5], 3], [[2, 3, 4, 5], 2], [[1, 2, 3, 4, 5], 1], [[0, 1, 2, 3, 4, 5], 0], [[0, 1, 2, 3, 4, 5], 0]]) {
    await press('ArrowLeft', true); assert.deepEqual(await sel7(), { l: want, a: 5, f }, `B: Shift+← -> ${want}`);
  }
  await press('ArrowRight', true); await press('ArrowRight', true); await press('ArrowRight', true); await press('ArrowRight', true); await press('ArrowRight', true);
  assert.deepEqual(await sel7(), { l: [5], a: 5, f: 5 }, 'B: Shift+→ shrinks back to the last symbol');
  // no symbol selection: Shift+← is the ordinary text selection
  await press('Escape'); assert.equal(await leafSel(), null);
  await evaluate(`active().chain().focus('end').run()`); await pause(150);
  await press('ArrowLeft', true); await press('ArrowLeft', true);
  assert.equal(await evaluate('active().state.selection.to - active().state.selection.from'), 2, 'without a symbol selection Shift+← selects text');
  // a plain click in the zone still opens the LaTeX popover; the same press ' + OUT + 'px out is just text
  L7 = await g7();
  await click(L7[5].r + IN, y7);
  await until(() => evaluate('!!store.getState().mathEdit'), 'click in the zone opens the popover');
  assert.equal(await evaluate(`document.querySelector('.math-popover .math-input').value`), 'E = mcY2');
  await evaluate(`mathNodes.commitMath(active(), store.getState().mathEdit.pos)`); await pause(250);
  L7 = await g7();
  await click(L7[5].r + OUT, y7);
  assert.equal(await evaluate('!!store.getState().mathEdit'), false, 'outside the zone a click does not open the popover');
  // the same zone on the static (selected, not editing) box, via the hand-over to edit mode
  await evaluate('store.getState().stopEditing()'); await pause(400);
  const id7 = await evaluate('store.getState().selection[0]');
  const NS7 = `.slide.editable .el[data-el-id="${id7}"] .math-inline`;
  const ls = async (i) => leafInfo(NS7, i);
  const l5 = await ls(5), l3 = await ls(3);
  await drag({ x: l5.r + IN, y: l5.cy }, { x: l3.cx, y: l5.cy });
  assert.equal(await evaluate('store.getState().editingId'), id7); assert.deepEqual(await sel7(), { l: [3, 4, 5], a: 5, f: 3 }, 'static box: right-to-left from the zone picks c..2');
  console.log('PASS edge symbols: pick zone, right-to-left, Shift+← from the last symbol');
  // caret placement around the equation: text beyond the zone still takes the caret, the zone itself opens the equation
  await evaluate('store.getState().startEditing(' + JSON.stringify(id7) + ')'); await pause(500);
  const around = await evaluate(`(() => { const p = document.querySelector('.el.editing .tb-content p'); const eq = p.querySelector('.math-inline'); const er = eq.querySelector('svg').getBoundingClientRect(); const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); const ns = []; let n; while ((n = w.nextNode())) ns.push(n); const rects = ns.map((t) => { const r = document.createRange(); r.selectNodeContents(t); const b = r.getBoundingClientRect(); return [b.left, b.right, (b.top + b.bottom) / 2, t.textContent]; }); return JSON.stringify({ eq: [er.left, er.right], rects }); })()`).then(JSON.parse);
  console.log('INFO text around the equation (px): before ends', Math.round(around.eq[0] - around.rects[0][1]) + ' left of it, after starts ' + Math.round(around.rects[1][0] - around.eq[1]) + ' right of it (zone ' + ZONE + 'px each side)');
  const caretAt = async (x, y) => { await click(x, y); return evaluate('JSON.stringify([!!store.getState().mathEdit, active().state.selection.from])').then(JSON.parse); };
  const [t0, t1] = around.rects;
  const farRight = await caretAt(Math.min(t1[1] - 2, t1[0] + 40), t1[2]);   // on the trailing text, well past the zone
  assert.deepEqual(farRight[0], false, 'a click on the text after the equation (past the zone) places the caret, no popover');
  // (the first 5px of the box belong to its resize handle — start clear of it and clear of the zone)
  const leftX = (t0[0] + 8 + (t0[1] - ZONE - 1)) / 2;
  assert.ok(leftX > t0[0] + 8 && leftX < t0[1] - ZONE, 'text before the equation is wide enough to click outside both the handle and the zone');
  const farLeft = await caretAt(leftX, t0[2]);
  assert.deepEqual(farLeft[0], false, 'a click on the text before the equation places the caret, no popover');
  assert.equal(await evaluate('!!store.getState().mathEdit'), false);
  // box move / resize handles keep priority over the pick zone (equation flush with the box edge)
  await evaluate('store.getState().stopEditing()'); await evaluate('store.setState({selection: []})'); await pause(200);
  await evaluate('persist.newProject()'); await pause(600);
  const S8 = await typeEquation('E = mcY2');
  await evaluate(`mathNodes.commitMath(active(), store.getState().mathEdit.pos)`); await pause(250);
  const id8 = await evaluate('store.getState().editingId');
  const w0 = await evaluate(`store.getState().deck.slides[0].elements.find((e) => e.id === ${JSON.stringify(id8)}).w`);
  const hw = await evaluate(`(() => { const h = document.querySelector('.handle.h-e, .handle.h-w'); const r = h.getBoundingClientRect(); return {x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, top: !!document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)?.closest('.handle')}; })()`);
  assert.equal(hw.top, true, 'the box handle is still the topmost element where it overlaps the equation zone');
  await drag({ x: hw.x, y: hw.y }, { x: hw.x + 40, y: hw.y }); await pause(200);
  assert.notEqual(await evaluate(`store.getState().deck.slides[0].elements.find((e) => e.id === ${JSON.stringify(id8)}).w`), w0, 'dragging the handle still resizes the box');
  assert.equal(await leafSel(), null, 'and does not pick symbols');
  console.log('PASS pick zone ' + ZONE + 'px: caret placement and resize handles unaffected');
  // ===== 8. caret next to an equation + Shift+←/→ steps into it =====
  await evaluate('persist.newProject()'); await pause(600);
  const S8b = await typeEquation('E=mc^2');
  await evaluate(`mathNodes.commitMath(active(), store.getState().mathEdit.pos)`); await pause(300);   // caret right after the equation
  const edSel = () => evaluate(`(() => { const s = active().state.selection; return JSON.stringify({ t: s.constructor.name, from: s.from, to: s.to }); })()`).then(JSON.parse);
  const sel8 = async () => { const s = await leafSel(); return s && { l: s.leaves, a: s.anchor, f: s.focus }; };
  assert.deepEqual(await edSel(), { t: 'TextSelection', from: 2, to: 2 }, 'caret sits right after the equation');
  await press('ArrowLeft', true);
  assert.deepEqual(await sel8(), { l: [4], a: 4, f: 4 }, 'Shift+← with the caret after the equation picks the LAST symbol first');
  assert.equal(await countHl(S8b), 1, 'and highlights it');
  assert.equal((await edSel()).t, 'NodeSelection');
  for (const want of [[3, 4], [2, 3, 4], [1, 2, 3, 4], [0, 1, 2, 3, 4], [0, 1, 2, 3, 4]]) { await press('ArrowLeft', true); assert.deepEqual((await sel8()).l, want, `Shift+← repeats: ${want}`); }
  await press('ArrowRight', true); assert.deepEqual(await sel8(), { l: [1, 2, 3, 4], a: 4, f: 1 }, 'existing behaviour: Shift+→ shrinks again');
  await pickColor(7);
  assert.deepEqual((await fills(S8b)).map((v, i) => (v === B ? i : -1)).filter((i) => i >= 0), [1, 2, 3, 4], 'the palette colors the keyboard-entered range');
  await press('Escape'); assert.equal(await leafSel(), null);
  // caret BEFORE the equation + Shift+→ picks the FIRST symbol
  await evaluate(`active().commands.setTextSelection(1); active().view.focus()`); await pause(200);
  assert.deepEqual(await edSel(), { t: 'TextSelection', from: 1, to: 1 }, 'caret right before the equation');
  await press('ArrowRight', true);
  assert.deepEqual(await sel8(), { l: [0], a: 0, f: 0 }, 'Shift+→ with the caret before the equation picks the FIRST symbol');
  await press('ArrowRight', true); await press('ArrowRight', true);
  assert.deepEqual(await sel8(), { l: [0, 1, 2], a: 0, f: 2 });
  await press('ArrowLeft', true); assert.deepEqual((await sel8()).l, [0, 1]);
  // the opposite key does NOT enter (caret after: Shift+→ / caret before: Shift+←) and plain text editing is untouched
  await evaluate('store.getState().setMathLeafSel(null)');
  await evaluate(`active().commands.setTextSelection(1); active().view.focus()`); await pause(150);
  await press('ArrowLeft', true); assert.equal(await leafSel(), null, 'caret before the equation: Shift+← is left to ProseMirror');
  // text around: no equation next to the caret -> ordinary text selection
  await evaluate(`active().chain().focus('start').insertContent('hi ').run()`); await pause(150);
  await evaluate(`active().chain().focus('end').insertContent(' tail').run()`); await pause(200);
  await press('ArrowLeft', true); await press('ArrowLeft', true);
  assert.equal(await leafSel(), null, 'caret at the end of the trailing text: Shift+← selects text');
  assert.equal(await evaluate('active().state.selection.to - active().state.selection.from'), 2);
  // a text range reaching the equation extends over it as a whole, as before (not hijacked)
  for (let i = 0; i < 4; i++) await press('ArrowLeft', true);
  assert.equal(await leafSel(), null, 'a growing text selection that crosses the equation stays plain text selection');
  assert.ok(await evaluate('active().state.selection.to - active().state.selection.from') >= 6);
  // typing / deleting around the equation still works
  await evaluate(`active().commands.setTextSelection(active().state.doc.content.size - 1); active().view.focus()`); await pause(150);
  await send('Input.insertText', { text: '!' }); await pause(150);
  assert.ok((await evaluate('active().getText()')).endsWith('tail!'), 'typing after the equation text works');
  // mouse: dragging from the text INTO the equation is still a plain text selection (no symbol pick)
  const dm = await evaluate(`(() => { const p = document.querySelector('.el.editing .tb-content p'); const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let n, last; while ((n = w.nextNode())) last = n; const r = document.createRange(); r.setStart(last, 3); r.setEnd(last, 4); const b = r.getBoundingClientRect(); return {x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2}; })()`);   // a letter of the trailing text, clear of the box edge handle
  const mg = await leafInfo(S8b, 2);
  await evaluate('store.getState().setMathLeafSel(null)');
  await drag({ x: dm.x, y: dm.y }, { x: mg.cx, y: mg.cy }, 10);
  assert.equal(await leafSel(), null, 'mouse trailing text -> into the equation: unchanged (ProseMirror text selection over the whole equation)');
  assert.ok(await evaluate('!active().state.selection.empty'));
  console.log('PASS caret + Shift+←/→ enters the equation (last / first symbol), then extends; text selection and editing unaffected');
  // ===== 9. the hand-over from a selected (not editing) box on a slow machine =====
  // While the editor mounts, the pointer keeps moving and the button may come up; CI runners are slow enough to hit every ordering.
  // Reproduces the flaky "one-step flick" failure: every attempt must pick, no retries.
  await evaluate('persist.newProject()'); await pause(600);
  await typeEquation('E = mc^2');
  await evaluate(`mathNodes.commitMath(active(), store.getState().mathEdit.pos)`); await pause(250);
  await evaluate(`active().chain().focus('start').insertContent('hi ').run()`); await pause(250);
  const id9 = await evaluate('store.getState().editingId');
  const NS9 = `.slide.editable .el[data-el-id="${id9}"] .math-inline`;
  const toStatic = async () => { await evaluate('store.getState().stopEditing()'); await pause(400); assert.equal(await evaluate('store.getState().editingId'), null); };
  const picked = async (want, why) => { await until(() => leafSel(), why, 10000); assert.deepEqual((await leafSel()).leaves, want, why); };
  await send('Emulation.setCPUThrottlingRate', { rate: 6 });
  try {
    for (const steps of [1, 1, 1, 2, 3, 8]) {
      await toStatic();
      const g = await leafInfo(NS9, 2);
      await drag({ x: g.cx - 3, y: g.cy }, { x: g.cx + 3, y: g.cy }, steps);
      await picked([2], `slow machine: a ${steps}-step flick on m picks it`);
      assert.equal(await evaluate('!!store.getState().mathEdit'), false, 'a flick is not a click');
    }
    await toStatic();
    const a = await leafInfo(NS9, 2), b = await leafInfo(NS9, 3);
    await drag({ x: a.l + 1, y: a.cy }, { x: b.cx, y: b.cy }, 2);
    await picked([2, 3], 'slow machine: a quick m..c drag picks both');
    await toStatic();
    const c = await leafInfo(NS9, 2);
    await click(c.cx, c.cy);                                                  // no movement at all: still a click
    await until(() => evaluate('!!store.getState().mathEdit'), 'slow machine: a plain click opens the LaTeX popover', 10000);
    assert.equal(await leafSel(), null);
  } finally { await send('Emulation.setCPUThrottlingRate', { rate: 1 }); }
  console.log('PASS hand-over from a selected box stays reliable on a slow machine (1-8 step flicks, quick multi-symbol drag, click)');
  console.log('ALL PASS');
} finally {
  await quit().catch(() => {});
  await server.close();
}
