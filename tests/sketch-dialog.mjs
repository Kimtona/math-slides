/** Sketch-to-Slides dialog end-to-end in a real Electron window on a disposable profile, with the model replaced by a
 * test fixture (MATHSLIDES_SKETCH_FAKE: no network, no API key). Covers: button → recognition → preview → review round →
 * Apply (one undo step restores the image) → Apply-keep → run log files → PPTX export.
 * Run: node tests/sketch-dialog.mjs (needs a graphical session).
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { testElectronEnv } from './electron-env.mjs';
import JSZip from 'jszip';
import { launchElectron, startViteServer, stopElectron } from './test-ports.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-sketch-profile-'));
const logDir = path.join(profile, 'sketch-log');
const fixture = path.join(root, 'tests/fixtures/sketch/policy-gradient.ir.json');
let debugPort; // assigned by launchElectron (Chromium binds a free port itself)
const { server, url: devUrl } = await startViteServer(createServer, { root, configLoader: 'runner', cacheDir: path.join(profile, 'vite') }); // OS-assigned port
const wrapper = path.join(profile, 'main.cjs');
await writeFile(wrapper, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});\n`);

let electron, socket, id = 0;
const pending = new Map();
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));
async function until(fn, message, timeout = 20000) {
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
  ({ child: electron, debugPort } = await launchElectron(require('electron'), [wrapper], {
    cwd: root,
    env: testElectronEnv({ ELECTRON_DEV_URL: devUrl, MATHSLIDES_SKETCH_FAKE: fixture, MATHSLIDES_SKETCH_LOG: logDir, ANTHROPIC_API_KEY: '' }),
  }));
  electron.stderr.on('data', () => {});
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 'debug target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => { const d = JSON.parse(e.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(Error(d.error.message)) : p.resolve(d.result); } });
  await send('Runtime.enable');
  await until(() => evaluate(`!!document.querySelector('.propsbar')`), 'app mount');
  await evaluate(`(async () => {
    window.store = (await import('/src/store/store.ts')).useStore;
    window.sketch = await import('/src/sketch/session.ts');
    window.insert = await import('/src/canvas/insert.ts');
    window.testFiles = {};
    window.showSaveFilePicker = async ({suggestedName}) => ({name:suggestedName,createWritable:async()=>({write:async(blob)=>{testFiles[suggestedName]=[...new Uint8Array(await blob.arrayBuffer())]},close:async()=>{}})});
  })()`);
}
async function quit() { socket?.close(); await stopElectron(electron); }
const clickButton = (text) => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw Error('Missing button ' + ${JSON.stringify(text)}); if (b.disabled) throw Error('Disabled button ' + ${JSON.stringify(text)}); b.click(); return true; })()`);
const slideEls = () => evaluate(`store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements.map((e) => ({ id: e.id, type: e.type }))`);
const phase = () => evaluate(`sketch.useSketch.getState().phase`);

async function insertSketch() {
  await evaluate(`(async () => {
    const blob = await (await fetch('/examples/sketches/policy-gradient.png')).blob();
    await insert.insertImageFiles([new File([blob], 'policy-gradient.png', { type: 'image/png' })]);
  })()`);
  const img = await until(async () => (await slideEls()).find((e) => e.type === 'image' && !seenImages.has(e.id)), 'image inserted');
  seenImages.add(img.id);
  // Below the template's title and body placeholders (1500×582 image at 0.72 scale).
  await evaluate(`store.getState().updateElements([${JSON.stringify(img.id)}], (d) => { d.x = 100; d.y = 200; d.w = 1080; d.h = 419; })`);
  await evaluate(`store.getState().select([${JSON.stringify(img.id)}])`);
  await pause(200);
  return img;
}
const seenImages = new Set();
const fullEls = () => evaluate(`JSON.parse(JSON.stringify(store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements))`);
const inFrame = (el, f, tol = 2) => el.x >= f.x - tol && el.y >= f.y - tol && el.x + el.w <= f.x + f.w + tol && el.y + el.h <= f.y + f.h + tol;

try {
  await launch();
  await evaluate(`store.getState().addSlide()`);
  const img = await insertSketch();
  const before = await slideEls();

  // --- button in the image props bar opens the dialog and runs the pipeline ---
  await clickButton('Convert to Editable Slide');
  await until(async () => (await phase()) === 'preview', 'dialog reaches preview', 30000);
  const st = await evaluate(`(() => { const s = sketch.useSketch.getState(); return { n: s.conv.elements.length, others: s.others.length, counts: s.report.counts, rounds: s.rounds, model: s.model, previewEls: document.querySelectorAll('.sk-preview .el').length }; })()`);
  assert.equal(st.n, 7, 'seven converted elements');
  assert.equal(st.others, 2, 'the template title/body are the other elements');
  assert.equal(st.previewEls, 7 + st.others, 'preview renders them in place, with the rest of the slide');
  assert.equal(st.counts.error, 0, 'no validation errors');
  assert.equal(st.rounds.length, 1, 'one review round (fixture review reports no problems)');
  assert.ok(st.model.startsWith('fake'), 'fake model is labeled as such');
  assert.ok(await evaluate(`document.querySelector('.sk-dialog').textContent.includes('fake (test fixture)')`), 'dialog shows the fake label');
  // Equations are editable LaTeX, not images.
  assert.ok(await evaluate(`!!document.querySelector('.sk-preview .math-block svg') && !document.querySelector('.sk-preview .el-image')`), 'equation rendered by MathJax, no image');
  console.log('PASS recognition → preview → review round');

  // --- placement: inside the image's frame, nothing else on the slide touched or covered ---
  const frame = { x: 100, y: 200, w: 1080, h: 419 };
  const placed = await evaluate(`(() => { const s = sketch.useSketch.getState(); return { frame: s.frame, els: s.conv.elements.map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h, type: e.type })), codes: s.report.issues.map((i) => i.code) }; })()`);
  assert.deepEqual(placed.frame, frame, 'session uses the image frame');
  assert.ok(placed.els.every((e) => inFrame(e, frame)), 'converted elements inside the image frame: ' + JSON.stringify(placed.els.filter((e) => !inFrame(e, frame))));
  assert.ok(!placed.codes.includes('overlap-existing') && !placed.codes.includes('frame'), 'no overlap with the template, nothing outside: ' + placed.codes);
  assert.ok(await evaluate(`!!document.querySelector('.sk-preview .sk-frame')`), 'preview marks the image area');
  console.log('PASS placement inside the image frame');

  // --- user edit in the review list re-converts ---
  await evaluate(`sketch.editElement('eq', { latex: '\\\\nabla_\\\\theta J(\\\\theta) = 1' })`);
  assert.ok(await evaluate(`sketch.useSketch.getState().conv.elements.some((e) => e.type === 'text' && e.doc.content[0].type === 'mathBlock' && e.doc.content[0].attrs.latex.endsWith('= 1'))`), 'edit applied');
  await evaluate(`sketch.editElement('eq', { latex: sketch.useSketch.getState().ir.elements.find((e) => e.id === 'eq').latex.replace(' = 1', '') })`);
  console.log('PASS user edit re-converts');

  // --- Apply replaces the image in ONE undo step ---
  const othersBefore = (await fullEls()).filter((e) => e.id !== img.id);
  await clickButton('Apply');
  await until(async () => (await phase()) === 'idle', 'dialog closed');
  const afterApply = await slideEls();
  assert.ok(!afterApply.some((e) => e.id === img.id), 'image removed');
  assert.equal(afterApply.length, before.length - 1 + 7, 'seven elements added');
  assert.equal(await evaluate(`store.getState().selection.length`), 7, 'converted elements selected');
  const othersAfter = (await fullEls()).filter((e) => othersBefore.some((o) => o.id === e.id));
  assert.deepEqual(othersAfter, othersBefore, 'template title/body untouched');
  const imgIndex = before.findIndex((e) => e.id === img.id);
  const selected = await evaluate(`store.getState().selection`);
  assert.deepEqual(afterApply.slice(imgIndex, imgIndex + 7).map((e) => e.id).sort(), [...selected].sort(), 'inserted at the image layer');
  await evaluate(`store.getState().undo()`);
  assert.deepEqual(await slideEls(), before, 'one undo restores the image exactly');
  await evaluate(`store.getState().redo()`);
  assert.deepEqual((await slideEls()).map((e) => e.id), afterApply.map((e) => e.id), 'redo re-applies');
  console.log('PASS apply (replace) + single-step undo/redo');

  // --- Apply, keep image ---
  const img2 = await insertSketch();
  await clickButton('Convert to Editable Slide');
  await until(async () => (await phase()) === 'preview', 'second run preview', 30000);
  await clickButton('Apply, keep image');
  await until(async () => (await phase()) === 'idle', 'dialog closed');
  assert.ok((await slideEls()).some((e) => e.id === img2.id), 'image kept');
  console.log('PASS apply (keep image)');

  // --- cropped image: the model gets only the visible part, elements map onto the cropped frame ---
  const img3 = await insertSketch();
  await evaluate(`store.getState().updateElements([${JSON.stringify(img3.id)}], (d) => { d.crop = { x: 0, y: 0, w: 0.5, h: 1 }; d.x = 300; d.y = 220; d.w = 540; d.h = 419; })`);
  await evaluate(`store.getState().select([${JSON.stringify(img3.id)}])`); await pause(150);
  await clickButton('Convert to Editable Slide');
  await until(async () => (await phase()) === 'preview', 'cropped run preview', 30000);
  const cropRun = await evaluate(`(() => { const s = sketch.useSketch.getState(); return { image: { w: s.image.width, h: s.image.height }, frame: s.frame, els: s.conv.elements.map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h })) }; })()`);
  assert.ok(Math.abs(cropRun.image.w / cropRun.image.h - 750 / 582) < 0.01, 'only the visible half is sent: ' + JSON.stringify(cropRun.image));
  const cf = { x: 300, y: 220, w: 540, h: 419 };
  assert.deepEqual(cropRun.frame, cf);
  // The fixture describes the full image, so this only checks the mapping: shapes/lines start inside the cropped frame.
  assert.ok(cropRun.els.every((e) => e.x >= cf.x - 2 && e.y >= cf.y - 2), 'mapped onto the cropped frame');
  await clickButton('Cancel');
  await evaluate(`store.getState().select([${JSON.stringify(img3.id)}]); store.getState().deleteSelection()`);
  console.log('PASS cropped image');

  // --- Cancel leaves the slide untouched ---
  const beforeCancel = await slideEls();
  await evaluate(`store.getState().select([${JSON.stringify(img2.id)}])`); await pause(150);
  await clickButton('Convert to Editable Slide');
  await until(async () => (await phase()) === 'preview', 'third run preview', 30000);
  await clickButton('Cancel');
  assert.deepEqual(await slideEls(), beforeCancel, 'cancel changes nothing');
  console.log('PASS cancel');

  // --- run log (MATHSLIDES_SKETCH_LOG) ---
  const runs = await readdir(logDir);
  assert.ok(runs.length >= 3, 'one log folder per run');
  const files = await readdir(path.join(logDir, runs.sort()[0]));
  for (const f of ['00-input.png', '01-recognize.json', '02-ir.json', '11-rendering.png', '20-summary.json', '30-applied.json']) assert.ok(files.includes(f), 'log has ' + f + ' (got ' + files + ')');
  const shot = await readFile(path.join(logDir, runs.sort()[0], '11-rendering.png'));
  assert.ok(shot.readUInt32BE(16) >= 600, 'review screenshot has the preview width: ' + shot.readUInt32BE(16));
  console.log('PASS run log');

  // --- export: converted elements are ordinary elements → PPTX with native shapes/text ---
  await evaluate("import('/src/export/run.ts').then((m) => m.exportPptx())");
  const name = await evaluate('store.getState().deck.title');
  await until(() => evaluate(`testFiles[${JSON.stringify(name + '.pptx')}]?.length > 1000`), 'PPTX export', 30000);
  const zip = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(name + '.pptx')}]`)));
  const slideNo = await evaluate(`store.getState().deck.slides.findIndex((s) => s.id === store.getState().currentSlideId) + 1`);
  const xml = await zip.file(`ppt/slides/slide${slideNo}.xml`).async('string');
  assert.ok(xml.includes('policy gradient') && xml.includes('action'), 'converted text is native PPTX text');
  console.log('PASS PPTX export');

  // --- the command-line tool's .mslides output opens in the app (offline: --ir with the fixture) ---
  const cliOut = path.join(profile, 'cli');
  execFileSync(process.execPath, [path.join(root, 'scripts/sketch2slides.mjs'), path.join(root, 'examples/sketches/diagram-abc.png'), '--ir', path.join(root, 'tests/fixtures/sketch/diagram-abc.ir.json'), '--out', cliOut], { stdio: 'ignore' });
  const text = await readFile(path.join(cliOut, 'diagram-abc.mslides'), 'utf8');
  await evaluate(`import('/src/store/persistence.ts').then((m) => m.openFromText(${JSON.stringify(text)}, null))`);
  const opened = await evaluate(`store.getState().deck.slides[0].elements.map((e) => e.type + (e.shape ? ':' + e.shape : ''))`);
  assert.deepEqual(opened.sort(), ['line', 'line', 'line', 'shape:ellipse', 'shape:ellipse', 'shape:ellipse', 'text'], 'CLI deck opens with its elements');
  await until(() => evaluate(`document.querySelectorAll('.canvas .el-shape, .stage .el-shape').length >= 3`), 'CLI deck renders on the canvas');
  console.log('PASS CLI output opens in the app');
} finally {
  await quit();
  await server.close();
}
