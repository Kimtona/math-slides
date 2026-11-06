/** Sketch-to-Slides with the REAL local model (Ollama) in the real Electron app, on a disposable profile.
 * Not part of `npm test` (needs a running Ollama with the model, and takes minutes).
 *
 *   node tests/sketch-ollama-e2e.mjs <out-dir> <image> [<image> ...]
 *
 * For each image: insert on a new slide → Convert to Editable Slide → wait for the preview → screenshot the dialog →
 * Apply → check the elements are separate and editable → Undo restores the image → Redo. Then: save .mslides,
 * PDF (same Chromium printToPDF the app uses, on the print DOM) and PPTX. Everything lands in <out-dir>, plus the
 * app's run log (MATHSLIDES_SKETCH_LOG) and a summary.json with the measured times.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import JSZip from 'jszip';
import { testElectronEnv } from './electron-env.mjs';
import { launchElectron, startViteServer, stopElectron } from './test-ports.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [outArg, ...images] = process.argv.slice(2);
if (!outArg || !images.length) { console.error('usage: node tests/sketch-ollama-e2e.mjs <out-dir> <image> [...]'); process.exit(2); }
const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-ollama-e2e-'));
let debugPort; // assigned by launchElectron (Chromium binds a free port itself)
const { server, url: devUrl } = await startViteServer(createServer, { root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), logLevel: 'error' }); // OS-assigned port
const wrapper = path.join(profile, 'main.cjs');
await writeFile(wrapper, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});\n`);

let electron, socket, id = 0;
const pending = new Map();
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));
async function until(fn, message, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { try { const v = await fn(); if (v) return v; } catch {} await pause(250); }
  throw new Error(message);
}
const send = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params })); });
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const slideEls = () => evaluate(`store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements.map((e) => ({ id: e.id, type: e.type, shape: e.shape, x: e.x, y: e.y }))`);
const clickButton = (text) => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) throw Error('No enabled button ' + ${JSON.stringify(text)}); b.click(); return true; })()`);
const shot = async (file) => { const s = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(file, Buffer.from(s.data, 'base64')); };

const summary = { started: new Date().toISOString(), runs: [] };
try {
  ({ child: electron, debugPort } = await launchElectron(require('electron'), [wrapper], {
    cwd: root,
    env: testElectronEnv({ ELECTRON_DEV_URL: devUrl, MATHSLIDES_SKETCH_LOG: path.join(out, 'run-log'), ANTHROPIC_API_KEY: '', MATHSLIDES_SKETCH_FAKE: '', MATHSLIDES_TEST_PDF_DIR: out }),
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
    window.showSaveFilePicker = async ({suggestedName}) => ({name:suggestedName,createWritable:async()=>({write:async(blob)=>{testFiles[suggestedName]=[...new Uint8Array(typeof blob === 'string' ? new TextEncoder().encode(blob) : await blob.arrayBuffer())]},close:async()=>{}})});
  })()`);
  if (process.env.SKETCH_MODE === 'layout') await evaluate(`sketch.useSketch.setState({ mode: 'layout' })`);
  const status = await evaluate(`window.native.sketch.status()`);
  summary.status = { provider: status.provider, model: status.model, ready: status.ready };
  assert.equal(status.provider, 'ollama', 'default provider is Ollama');
  assert.ok(status.ready, 'Ollama running with the model installed: ' + JSON.stringify(status.ollama));
  console.log('Provider:', status.model);

  for (const file of images) {
    const name = path.basename(file).replace(/\.[^.]+$/, '');
    const buf = await readFile(file);
    const mime = /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png';
    await evaluate(`store.getState().addSlide()`);
    await evaluate(`(async () => {
      const bin = atob(${JSON.stringify(buf.toString('base64'))}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      await insert.insertImageFiles([new File([u], ${JSON.stringify(path.basename(file))}, { type: ${JSON.stringify(mime)} })]);
    })()`);
    const img = await until(async () => (await slideEls()).find((e) => e.type === 'image'), 'image inserted');
    // Real use: the sketch sits below the slide's title/body placeholders (aspect kept, at most 1080×470).
    const ar = await evaluate(`(() => { const a = store.getState().assets[store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements.find((e) => e.type === 'image').assetId]; return a.width / a.height; })()`);
    const fw = Math.round(Math.min(1080, 470 * ar)), fh = Math.round(fw / ar);
    const frame = { x: Math.round((1280 - fw) / 2), y: 200, w: fw, h: fh };
    await evaluate(`store.getState().updateElements([${JSON.stringify(img.id)}], (d) => { Object.assign(d, ${JSON.stringify(frame)}); })`);
    await evaluate(`store.getState().select([${JSON.stringify(img.id)}])`); await pause(300);
    const before = await slideEls();
    const othersBefore = await evaluate(`JSON.parse(JSON.stringify(store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements.filter((e) => e.type !== 'image')))`);

    const t0 = Date.now();
    await clickButton('Convert to Editable Slide');
    const phase = await until(async () => { const p = await evaluate(`sketch.useSketch.getState().phase`); return p === 'preview' || p === 'error' ? p : null; }, 'conversion finished', 15 * 60 * 1000);
    const wallMs = Date.now() - t0;
    await pause(500);
    await shot(path.join(out, `${name}-dialog.png`));
    const st = await evaluate(`(() => { const s = sketch.useSketch.getState(); return { phase: s.phase, error: s.error, model: s.model, timings: s.timings, rounds: s.rounds.map((r) => ({ round: r.round, ok: r.ok, skipped: !!r.skipped, patches: r.patches.length, summary: r.summary, error: r.error, ms: r.ms })), counts: s.report?.counts, issues: [...s.parseIssues, ...(s.report?.issues ?? [])], ir: s.ir, elementTypes: s.conv?.elements.map((e) => e.type + (e.shape ? ':' + e.shape : '')) }; })()`);
    const run = { image: path.basename(file), wallMs, frame, ...st };
    summary.runs.push(run);
    console.log(`${name}: ${phase} in ${(wallMs / 1000).toFixed(1)} s · ${st.elementTypes?.length ?? 0} elements · counts ${JSON.stringify(st.counts)} · review ${JSON.stringify(st.rounds)}`);
    if (phase !== 'preview') { await clickButton('Cancel'); continue; }

    // Apply: the image is replaced by separate, ordinary elements in one undo step.
    await clickButton('Apply');
    await until(async () => (await evaluate(`sketch.useSketch.getState().phase`)) === 'idle', 'dialog closed');
    const after = await slideEls();
    run.applied = after.map((e) => e.type + (e.shape ? ':' + e.shape : ''));
    // Placement: converted elements inside the image's frame; the title/body placeholders unchanged and not covered.
    const fresh = await evaluate(`JSON.parse(JSON.stringify(store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements))`);
    const added = fresh.filter((e) => !othersBefore.some((o) => o.id === e.id));
    const tol = 2, inF = (e) => e.x >= frame.x - tol && e.y >= frame.y - tol && e.x + e.w <= frame.x + frame.w + tol && e.y + e.h <= frame.y + frame.h + tol;
    run.outsideFrame = added.filter((e) => !inF(e)).map((e) => ({ type: e.type, x: e.x, y: e.y, w: e.w, h: e.h }));
    assert.deepEqual(fresh.filter((e) => othersBefore.some((o) => o.id === e.id)), othersBefore, 'other slide elements untouched');
    const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    run.coversExisting = added.filter((e) => othersBefore.some((o) => hit(e, o))).map((e) => e.type);
    assert.deepEqual(run.coversExisting, [], 'converted elements do not cover the existing title/body');
    assert.ok(!after.some((e) => e.id === img.id), 'image replaced');
    assert.equal(new Set(after.map((e) => e.id)).size, after.length, 'separate elements');
    // Individually editable: move one element, the others stay; open a text element in the editor.
    const first = after[0];
    await evaluate(`store.getState().updateElements([${JSON.stringify(first.id)}], (d) => { d.x += 10; })`);
    const moved = await slideEls();
    assert.ok(moved.every((e) => e.id === first.id ? e.x === first.x + 10 : after.find((a) => a.id === e.id).x === e.x), 'one element moves alone');
    await evaluate(`store.getState().undo()`);
    const textId = after.find((e) => e.type === 'text')?.id;
    if (textId) {
      await evaluate(`store.getState().startEditing(${JSON.stringify(textId)})`);
      run.textEditable = await until(() => evaluate(`!!document.querySelector('.el.editing .ProseMirror')`), 'text editor opens');
      await evaluate(`store.getState().stopEditing()`); await pause(200);
    }
    await shot(path.join(out, `${name}-applied.png`));
    // Undo restores the image exactly; redo re-applies.
    await evaluate(`store.getState().undo()`);
    assert.deepEqual(await slideEls(), before, 'undo restores the image');
    await evaluate(`store.getState().redo()`);
    assert.deepEqual((await slideEls()).map((e) => e.id), after.map((e) => e.id), 'redo re-applies');
    run.undoRedo = 'ok';
  }

  // --- save, PDF, PPTX of the deck with the converted slides ---
  await evaluate(`import('/src/store/persistence.ts').then((m) => m.saveProject(true))`);
  const title = await evaluate('store.getState().deck.title');
  const saved = await until(() => evaluate(`Object.keys(testFiles).find((k) => k.endsWith('.mslides'))`), 'saved .mslides');
  const mslides = Buffer.from(await evaluate(`testFiles[${JSON.stringify(saved)}]`));
  await writeFile(path.join(out, 'converted.mslides'), mslides);
  const parsed = JSON.parse(mslides.toString('utf8'));
  summary.saved = { slides: parsed.deck.slides.length, elements: parsed.deck.slides.reduce((n, s) => n + s.elements.length, 0) };

  // PDF through the app's own export (printToPDF in the main process; MATHSLIDES_TEST_PDF_DIR skips the save dialog).
  await evaluate(`(async () => { await (await import('/src/export/run.ts')).exportPdf(); return true; })()`);
  const { readdir } = await import('node:fs/promises');
  const pdfName = await until(async () => (await readdir(out)).find((f) => f.endsWith('.pdf')), 'PDF written', 60000);
  const pdfFile = path.join(out, pdfName);
  const pdfBuf = await readFile(pdfFile);
  summary.pdf = { file: path.basename(pdfFile), bytes: pdfBuf.length, pages: (pdfBuf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length };

  await evaluate("import('/src/export/run.ts').then((m) => m.exportPptx())");
  await until(() => evaluate(`testFiles[${JSON.stringify(title + '.pptx')}]?.length > 1000`), 'PPTX export', 60000);
  const pptx = Buffer.from(await evaluate(`testFiles[${JSON.stringify(title + '.pptx')}]`));
  await writeFile(path.join(out, 'converted.pptx'), pptx);
  const zip = await JSZip.loadAsync(pptx);
  summary.pptx = { bytes: pptx.length, slides: Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length };
  console.log('Saved/exported:', JSON.stringify({ saved: summary.saved, pdf: summary.pdf, pptx: summary.pptx }));
} finally {
  summary.finished = new Date().toISOString();
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  socket?.close();
  await stopElectron(electron);
  await server.close();
}
