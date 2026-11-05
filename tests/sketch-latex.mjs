/** Sketch-to-Slides LaTeX rendering in the real Electron app, replaying the REAL local-model output for the PPO paper
 * capture (tests/fixtures/sketch/ppo-grpo.local.json) through the real conversion (no network).
 * Checks: inline math in the paper sentence renders as MathJax (no `\(`/₩ text), the long display equation stays inside
 * the image area and the slide (measured in the DOM), Apply, save → reopen keeps every LaTeX string, PDF export, and
 * PPTX keeps the LaTeX (as the equation pictures' alt text). Screenshots go to $SKETCH_LATEX_SHOTS if set.
 * Run: node tests/sketch-latex.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
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
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-latex-'));
const pdfDir = path.join(profile, 'pdf');
await mkdir(pdfDir);
const shots = process.env.SKETCH_LATEX_SHOTS ? path.resolve(process.env.SKETCH_LATEX_SHOTS) : null;
if (shots) await mkdir(shots, { recursive: true });
let debugPort; // assigned by launchElectron (Chromium binds a free port itself)
const { server, url: devUrl } = await startViteServer(createServer, { root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), logLevel: 'error' }); // OS-assigned port
const wrapper = path.join(profile, 'main.cjs');
await writeFile(wrapper, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});\n`);

let electron, socket, id = 0;
const pending = new Map();
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));
async function until(fn, message, timeout = 30000) { const t = Date.now(); while (Date.now() - t < timeout) { try { const v = await fn(); if (v) return v; } catch {} await pause(150); } throw new Error(message); }
const send = (method, params = {}) => new Promise((resolve, reject) => { const k = ++id; pending.set(k, { resolve, reject }); socket.send(JSON.stringify({ id: k, method, params })); });
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
const clickButton = (text) => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) throw Error('No enabled button ' + ${JSON.stringify(text)}); b.click(); return true; })()`);
const shot = async (name) => { if (!shots) return; const s = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(shots, name), Buffer.from(s.data, 'base64')); };
const latexOf = (els) => els.flatMap((e) => { const out = []; const walk = (n) => { if (!n) return; if (n.type === 'mathBlock' || n.type === 'mathInline') out.push(n.attrs.latex); n.content?.forEach(walk); }; walk(e.doc); return out; });
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

try {
  ({ child: electron, debugPort } = await launchElectron(require('electron'), [wrapper], {
    cwd: root,
    env: testElectronEnv({ ELECTRON_DEV_URL: devUrl, MATHSLIDES_SKETCH_FAKE: path.join(root, 'tests/fixtures/sketch/ppo-grpo.local.json'), MATHSLIDES_TEST_PDF_DIR: pdfDir, ANTHROPIC_API_KEY: '' }),
  }));
  electron.stderr.on('data', () => {});
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 'debug target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => { const d = JSON.parse(e.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(Error(d.error.message)) : p.resolve(d.result); } });
  await send('Runtime.enable');
  await until(() => evaluate(`!!document.querySelector('.propsbar')`), 'app mount');
  await evaluate(`(async () => {
    window.store = (await import('/src/store/store.ts')).useStore; window.sketch = await import('/src/sketch/session.ts');
    window.insert = await import('/src/canvas/insert.ts'); window.persist = await import('/src/store/persistence.ts');
    window.testFiles = {};
    window.showSaveFilePicker = async ({suggestedName}) => ({name:suggestedName,createWritable:async()=>({write:async(blob)=>{testFiles[suggestedName]=[...new Uint8Array(await blob.arrayBuffer())]},close:async()=>{}})});
  })()`);

  // The paper capture below the content template's title/body, as in real use.
  await evaluate(`store.getState().addSlide()`);
  await evaluate(`(async () => { const b = await (await fetch('/examples/sketches/ppo-grpo.png')).blob(); await insert.insertImageFiles([new File([b], 'ppo-grpo.png', { type: 'image/png' })]); })()`);
  const img = await until(() => evaluate(`store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements.find((e) => e.type === 'image')`), 'image');
  const frame = { x: 100, y: 200, w: 1080, h: 406 }; // 1648×620 at 0.655
  await evaluate(`store.getState().updateElements([${JSON.stringify(img.id)}], (d) => Object.assign(d, ${JSON.stringify(frame)})); store.getState().select([${JSON.stringify(img.id)}])`);
  await pause(200);
  await clickButton('Convert to Editable Slide');
  await until(async () => (await evaluate(`sketch.useSketch.getState().phase`)) === 'preview', 'preview');
  await pause(600);
  await shot('ppo-dialog-after.png');

  // --- inline math: rendered by MathJax, no delimiter/backslash text anywhere in the preview ---
  const pv = await evaluate(`(() => {
    const ids = new Set(sketch.useSketch.getState().conv.elements.map((e) => e.id));
    const els = [...document.querySelectorAll('.sk-preview [data-el-id]')].filter((n) => ids.has(n.dataset.elId));
    return { inlineSvgs: document.querySelectorAll('.sk-preview .math-inline svg').length, blockSvgs: document.querySelectorAll('.sk-preview .math-block svg').length,
      errors: document.querySelectorAll('.sk-preview .math-error').length, text: els.map((n) => n.textContent).join(' ') };
  })()`);
  assert.equal(pv.inlineSvgs, 6, 'six inline equations rendered as SVG');
  assert.equal(pv.blockSvgs, 1, 'display equation rendered');
  assert.equal(pv.errors, 0, 'no MathJax errors');
  assert.ok(!/\\\(|\\\)|\\pi|\$/.test(pv.text), 'no LaTeX source or delimiters shown as text: ' + pv.text.slice(0, 200));
  console.log('PASS inline math renders (6 inline + 1 display, no errors, no raw delimiters)');

  // --- after Apply, measured on the canvas: everything inside the image area and the slide ---
  const convIds = await evaluate(`sketch.useSketch.getState().conv.elements.map((e) => e.id)`);
  const before = await evaluate(`JSON.parse(JSON.stringify(store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements.filter((e) => e.type !== 'image')))`);
  await clickButton('Apply');
  await until(async () => (await evaluate(`sketch.useSketch.getState().phase`)) === 'idle', 'applied');
  await evaluate(`store.getState().select([])`); await pause(800);
  await shot('ppo-applied-after.png');
  const rects = await evaluate(`(() => {
    const slide = document.querySelector('.stage .slide'); const sr = slide.getBoundingClientRect(); const k = sr.width / 1280;
    return ${JSON.stringify(convIds)}.map((id) => { const n = slide.querySelector('[data-el-id="' + id + '"]'); const r = n.getBoundingClientRect();
      const inner = [...n.querySelectorAll('svg, span, p')].reduce((m, c) => Math.max(m, (c.getBoundingClientRect().right - sr.left) / k), 0);
      return { id, x: (r.left - sr.left) / k, y: (r.top - sr.top) / k, w: r.width / k, h: r.height / k, right: Math.max((r.right - sr.left) / k, inner) }; });
  })()`);
  for (const r of rects) {
    assert.ok(r.x >= frame.x - 2 && r.right <= frame.x + frame.w + 2, 'inside the image width (measured): ' + JSON.stringify(r));
    assert.ok(r.x >= 0 && r.right <= 1280 && r.y >= 0 && r.y + r.h <= 720, 'inside the slide (measured): ' + JSON.stringify(r));
  }
  const after = await evaluate(`JSON.parse(JSON.stringify(store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements))`);
  assert.deepEqual(after.filter((e) => before.some((b) => b.id === e.id)), before, 'title/body untouched');
  const applied = after.filter((e) => convIds.includes(e.id));
  const expected = latexOf(applied);
  assert.equal(expected.length, 7);
  console.log('PASS layout measured in the DOM: display equation and paragraphs inside the image area and the slide');

  // --- save → reopen: identical LaTeX strings ---
  await evaluate(`persist.saveProject(true)`);
  const name = await until(() => evaluate(`Object.keys(testFiles).find((k) => k.endsWith('.mslides'))`), 'saved');
  const text = Buffer.from(await evaluate(`testFiles[${JSON.stringify(name)}]`)).toString('utf8');
  const slideIdx = await evaluate(`store.getState().deck.slides.findIndex((s) => s.id === store.getState().currentSlideId)`);
  await evaluate(`store.getState().loadDeck(JSON.parse(JSON.stringify({ version: 1, title: 'blank', slides: [{ id: 'x', background: '#fff', elements: [], notes: '' }] })), {})`);
  await evaluate(`persist.openFromText(${JSON.stringify(text)}, null)`);
  const reopened = await evaluate(`store.getState().deck.slides[${slideIdx}].elements.filter((e) => ${JSON.stringify(convIds)}.includes(e.id))`);
  assert.deepEqual(latexOf(reopened), expected, 'LaTeX identical after save and reopen');
  await evaluate(`store.getState().goToSlide(store.getState().deck.slides[${slideIdx}].id)`); await pause(500);
  assert.equal(await evaluate(`document.querySelectorAll('.stage .slide .math-inline svg').length`), 6, 'reopened slide renders the inline math');
  console.log('PASS save → reopen keeps every LaTeX string');

  // --- PDF and PPTX ---
  await evaluate(`import('/src/export/run.ts').then((m) => m.exportPdf())`);
  const pdfName = await until(async () => (await readdir(pdfDir)).find((f) => f.endsWith('.pdf')), 'PDF', 60000);
  const pdf = await readFile(path.join(pdfDir, pdfName));
  assert.ok(pdf.subarray(0, 4).toString() === '%PDF' && pdf.length > 5000, 'PDF written');
  if (shots) await writeFile(path.join(shots, 'ppo-after.pdf'), pdf);
  await evaluate("import('/src/export/run.ts').then((m) => m.exportPptx())");
  const title = await evaluate('store.getState().deck.title');
  await until(() => evaluate(`testFiles[${JSON.stringify(title + '.pptx')}]?.length > 1000`), 'PPTX', 60000);
  const zip = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(title + '.pptx')}]`)));
  const xml = await zip.file(`ppt/slides/slide${slideIdx + 1}.xml`).async('string');
  const descr = [...xml.matchAll(/descr="([^"]*)"/g)].map((m) => unxml(m[1]));
  for (const tex of expected) assert.ok(descr.includes(tex), 'PPTX keeps the LaTeX of ' + tex.slice(0, 40));
  assert.ok(xml.includes('where') && xml.includes('Proximal Policy Optimization'), 'paragraph text is native PPTX text');
  console.log('PASS PDF export, PPTX keeps all 7 LaTeX strings');
} finally {
  socket?.close();
  await stopElectron(electron);
  await server.close();
}
