/** Partial symbol colors: drag over a rendered equation, color via the Text Color palette, reset, undo/redo, click still opens the editor.
 * Real Electron window on a disposable profile. Run: node tests/math-leaf-color-ui.mjs (needs a graphical session).
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
import { makeTempDir } from './tmp-utils.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = makeTempDir('mathslides-leafcolor-profile-');
const probe = netServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const debugPort = probe.address().port;
await new Promise((r) => probe.close(r));
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: 5193, strictPort: true } });
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
  electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`], { cwd: root, env: testElectronEnv({ ELECTRON_DEV_URL: 'http://127.0.0.1:5193' }), stdio: ['ignore', 'pipe', 'pipe'] });
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

const key = async (k) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: k === 'Enter' ? 13 : 0 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k }); await pause(200); };
const TEXT = '.propsbar button[title^="글자 색 (Text Color)"]';
const leafRect = (sel, i) => evaluate(`(() => { const g = document.querySelectorAll(${JSON.stringify(sel + ' g[data-mml-node="mi"], ' + sel + ' g[data-mml-node="mn"], ' + sel + ' g[data-mml-node="mo"]')})[${i}]; const r = g.getBoundingClientRect(); return {l: r.left, r: r.right, t: r.top, b: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2}; })()`);
async function drag(from, to) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: from.x, y: from.y });
  for (let k = 1; k <= 6; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', x: from.x + (to.x - from.x) * k / 6, y: from.y + (to.y - from.y) * k / 6 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: to.x, y: to.y }); await pause(250);
}
const attrs = (kind) => evaluate(`(() => { let a; active().state.doc.descendants((n) => { if (n.type.name === ${JSON.stringify(kind)}) a = n.attrs; }); return JSON.stringify(a); })()`);
const fills = (sel) => evaluate(`[...document.querySelectorAll(${JSON.stringify(sel + ' g[data-mml-node="mi"], ' + sel + ' g[data-mml-node="mn"], ' + sel + ' g[data-mml-node="mo"]')})].map((g) => g.getAttribute('fill'))`);
const B = '#2563EB';

async function scenario(kind, sel) {
  const mathBlock = kind === 'mathBlock';
  await evaluate(`store.getState().addElements([defaults.newText(100,200,{w:600})],{edit:true})`);
  await until(() => evaluate('!!active()'), 'editor');
  if (mathBlock) {
    await send('Input.insertText', { text: '/math' }); await pause(); await key('Enter');
    await evaluate(`(async()=>{const m=await import('/src/editor/mathNodes.ts'); const pos=store.getState().mathEdit.pos; m.setMathLatex(active(),pos,'E=mc^2'); m.commitMath(active(),pos);})()`);
  } else {
    await evaluate(`active().commands.insertContent([{type:'mathInline',attrs:{latex:'E=mc^2'}}])`);
  }
  const id = await evaluate('store.getState().editingId');
  await evaluate('store.getState().stopEditing()'); await pause(200);
  await evaluate(`store.getState().startEditing(${JSON.stringify(id)})`); await until(() => evaluate(`!!document.querySelector('.el.editing ${sel} svg')`), 'math rendered while editing'); await pause(300);
  const ES = `.el.editing ${sel}`;
  const latex0 = JSON.parse(await attrs(kind)).latex;

  // drag over "m" then "c" (leaves 2..3)
  const m = await leafRect(ES, 2), c = await leafRect(ES, 3);
  const p0 = await evaluate('store.getState().past.length');
  await drag({ x: m.l + 1, y: m.cy }, { x: c.cx, y: c.cy });
  assert.deepEqual(await evaluate('store.getState().mathLeafSel?.leaves'), [2, 3], kind + ': dragging picks m and c');
  assert.equal(await evaluate(`document.querySelectorAll('${ES} .math-leaf-hl').length`), 2, kind + ': highlight boxes');
  assert.equal(await evaluate('!!store.getState().mathEdit'), false, kind + ': a drag does not open the LaTeX editor');
  assert.equal(await attrs(kind), JSON.stringify({ latex: latex0, colors: null }));

  // Text Color palette -> Blue (Standard Colors, 7th)
  await click(TEXT); await until(() => evaluate(`!!document.querySelector('.text-palette')`), 'palette');
  assert.ok(await evaluate(`[...document.querySelectorAll('.text-palette .palette-other')].some((b) => b.textContent.includes('기본 색상'))`), kind + ': 기본 색상 offered for picked symbols');
  await click('.text-palette .standard-colors .text-swatch:nth-child(7)'); await pause(300);
  let a = JSON.parse(await attrs(kind));
  assert.equal(a.latex, latex0, kind + ': LaTeX untouched'); assert.deepEqual(a.colors, { src: latex0, items: [{ i: 2, c: B }, { i: 3, c: B }] });
  assert.deepEqual(await fills(ES), [null, null, B, B, null], kind + ': only m and c are blue');
  assert.equal(await evaluate('store.getState().mathLeafSel?.leaves.length'), 2, kind + ': selection stays for another color');

  // recolor replaces; reset restores
  await click(TEXT); await until(() => evaluate(`!!document.querySelector('.text-palette')`), 'palette');
  await click('.text-palette .standard-colors .text-swatch:nth-child(1)'); await pause(300);
  assert.deepEqual((JSON.parse(await attrs(kind))).colors.items.map((x) => x.c), ['#DC2626', '#DC2626'], kind + ': replaced');
  await click(TEXT); await until(() => evaluate(`!!document.querySelector('.text-palette')`), 'palette');
  await evaluate(`[...document.querySelectorAll('.text-palette .palette-other')].find((b) => b.textContent.includes('기본 색상')).click()`); await pause(300);
  assert.equal(JSON.parse(await attrs(kind)).colors, null, kind + ': 기본 색상 removes partial colors');
  assert.deepEqual(await fills(ES), [null, null, null, null, null]);

  // undo / redo (editor history)
  await evaluate('active().commands.undo()'); await pause(200);
  assert.equal(JSON.parse(await attrs(kind)).colors.items[0].c, '#DC2626', kind + ': undo restores the red');
  await evaluate('active().commands.redo()'); await pause(200);
  assert.equal(JSON.parse(await attrs(kind)).colors, null, kind + ': redo');
  await evaluate('active().commands.undo()'); await pause(200);

  // editing the LaTeX resets (never recolors another symbol); plain click still opens the editor
  await click(`${ES} svg`); await until(() => evaluate('!!store.getState().mathEdit'), kind + ': click opens editor');
  assert.equal(await evaluate(`document.querySelector('.math-popover .math-input').value`), latex0, kind + ': editor shows plain LaTeX only');
  assert.equal(await evaluate('store.getState().mathLeafSel'), null);
  await evaluate(`(async()=>{const m=await import('/src/editor/mathNodes.ts'); const pos=store.getState().mathEdit.pos; m.setMathLatex(active(),pos,'E=mc^3'); m.commitMath(active(),pos);})()`); await pause(200);
  assert.equal(JSON.parse(await attrs(kind)).colors, null, kind + ': LaTeX change resets partial colors');
  await evaluate('active().commands.undo()'); await evaluate('active().commands.undo()'); await pause(200);

  // static (PDF/PPTX source) rendering and the saved deck keep the colors
  await evaluate(`(async()=>{const m=await import('/src/editor/mathNodes.ts'); let pos; active().state.doc.descendants((n,p)=>{ if (n.type.name===${JSON.stringify(kind)}) pos=p; }); active().commands.setNodeSelection(pos); store.getState().setMathLeafSel({pos, leaves:[0,1,2,3,4]}); m.applyMathLeafColor(active(), null); store.getState().setMathLeafSel({pos, leaves:[2]}); m.applyMathLeafColor(active(), ${JSON.stringify(B)});})()`); await pause(200);
  await evaluate('store.getState().stopEditing()'); await pause(400);
  const live = '.slide.editable ' + sel;
  assert.deepEqual(await fills(live), [null, null, B, null, null], kind + ': static render (PDF/PPTX source) keeps the color');
  assert.ok((await evaluate('JSON.stringify(store.getState().deck)')).includes('"colors":{"src":"E=mc^2","items":[{"i":2,"c":"' + B + '"}]}'), kind + ': stored in the deck as node metadata');
  console.log('PASS ' + kind + ' drag select, highlight, recolor, 기본 색상, undo/redo, click-to-edit, LaTeX-change reset');
  return id;
}

try {
  await launch();
  await evaluate(`(async () => { window.active = (await import('/src/editor/active.ts')).getActiveEditor; })()`);
  await scenario('mathBlock', '.math-block');
  await scenario('mathInline', '.math-inline');
  console.log('ALL PASS');
} finally {
  await quit().catch(() => {});
  await server.close();
}
