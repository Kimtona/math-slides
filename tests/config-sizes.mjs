/** Regression: config.txt font sizes use the SAME numbers as the toolbar (bare value = editor px; 60pt = 80), for #, ##, ###, ####, and new text boxes.
 * Real Electron windows on a fresh disposable userData profile. Run: node tests/config-sizes.mjs (needs a graphical session).
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import JSZip from 'jszip';
import { testElectronEnv } from './electron-env.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-config-sizes-profile-'));
const configPath = path.join(profile, 'config.txt'); // app.setPath('userData', profile) below = Electron's userData
const probe = netServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const debugPort = probe.address().port;
await new Promise((r) => probe.close(r));
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: 5198, strictPort: true } });
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
  electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`], { cwd: root, env: testElectronEnv({ ELECTRON_DEV_URL: 'http://127.0.0.1:5198' }), stdio: ['ignore', 'pipe', 'pipe'] });
  electron.stderr.on('data', () => {});
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 'debug target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => { const d = JSON.parse(e.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(Error(d.error.message)) : p.resolve(d.result); } });
  await send('Runtime.enable');
  await until(() => evaluate(`!!document.querySelector('.propsbar')`), 'app mount');
  await evaluate(`(async () => {
    window.store = (await import('/src/store/store.ts')).useStore;
    window.cfg = await import('/src/model/config.ts');
    window.defaults = await import('/src/model/defaults.ts');
    window.insert = await import('/src/canvas/insert.ts');
    window.active = (await import('/src/editor/active.ts')).getActiveEditor;
    window.testFiles = {};
    window.showSaveFilePicker = async ({suggestedName}) => ({name:suggestedName,createWritable:async()=>({
      write:async(blob)=>{testFiles[suggestedName]=[...new Uint8Array(await blob.arrayBuffer())]},close:async()=>{}
    })});
    window.png = (color, name) => new Promise((res) => { const c = document.createElement('canvas'); c.width = 400; c.height = 200; const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 400, 200); c.toBlob((b) => res(new File([b], name + '.png', {type: 'image/png'})), 'image/png'); });
  })()`);
}
async function quit() { socket?.close(); if (electron?.exitCode === null) { electron.kill('SIGTERM'); await new Promise((r) => electron.once('exit', r)); } }
const MOD = process.platform === 'darwin' ? 4 : 2, SHIFT = 8;
/** A real key press through Chromium's input pipeline (reaches the renderer's keydown handler; native menu accelerators cannot be driven from here). */
async function press(key, code, modifiers) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, modifiers, windowsVirtualKeyCode: 188 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: 188 });
}
const openConfigKey = () => press(',', 'Comma', MOD);
const reloadConfigKey = () => press('<', 'Comma', MOD | SHIFT); // Shift+, produces "<" on a US layout: the handler must go by `code`
const cfg = () => evaluate('JSON.stringify(cfg.getConfig())').then(JSON.parse);
const toast = () => evaluate(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|')`);
const deck = () => evaluate('JSON.stringify(store.getState().deck)');
const slideEls = () => evaluate("store.getState().deck.slides[store.getState().deck.slides.findIndex((s) => s.id === store.getState().currentSlideId)].elements");
const fam = (elId) => evaluate(`getComputedStyle(document.querySelector('.slide.editable [data-el-id="${elId}"]')).fontFamily`);
async function typeHeading(prefix, text) {
  await evaluate('store.getState().addSlide()'); await pause(300);
  await evaluate(`store.getState().startEditing(store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements[1].id, 'all')`);
  await until(() => evaluate('!!active()'), 'editor');
  await evaluate('active().commands.selectAll(); active().commands.deleteSelection()');
  await send('Input.insertText', { text: prefix }); await send('Input.insertText', { text: ' ' });
  const size = await evaluate('active().getAttributes("paragraph").fontSize');
  // the size box in the toolbar shows exactly the number a config.txt line uses
  await until(() => evaluate(`document.querySelector('.propsbar input.num[title*="글자 크기"]')?.value === ${JSON.stringify(String(size))}`), `toolbar shows ${size} for ${prefix}`);
  await send('Input.insertText', { text });
  const elId = await evaluate('store.getState().editingId');
  await evaluate('store.getState().stopEditing()'); await pause(200);
  return { elId, size };
}
const settle = () => until(() => evaluate("store.getState().saveState === 'saved'"), 'autosave settled');
const size = (n) => Number(n);
/** Value shown by the toolbar's font-size box (the number the user sees). */
const toolbar = () => evaluate(`document.querySelector('.propsbar input.num[title*="글자 크기"]')?.value`);
async function reload(lines) {
  const prev = await readFile(configPath, 'utf8');
  const text = prev.split('\n').map((l) => { const k = l.split('=')[0].trim(); return Object.hasOwn(lines, k) ? `${k} = ${lines[k]}` : l; }).join('\n');
  await writeFile(configPath, text);
  await pause(450); await reloadConfigKey();
  await until(async () => /Configuration reloaded/.test(await toast()), 'reload toast');
  await pause(450);
}
/** A new `prefix ` line on a fresh slide; returns the stored paragraph size and what the toolbar shows for it. */
async function heading(prefix) {
  await evaluate('store.getState().addSlide()'); await pause(300);
  await evaluate(`store.getState().startEditing(store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements[1].id, 'all')`);
  await until(() => evaluate('!!active()'), 'editor');
  await evaluate('active().commands.selectAll(); active().commands.deleteSelection()');
  await send('Input.insertText', { text: prefix }); await send('Input.insertText', { text: ' ' }); await pause(250);
  const stored = await evaluate('active().getAttributes("paragraph").fontSize');
  const shown = await toolbar();
  const elId = await evaluate('store.getState().editingId');
  await send('Input.insertText', { text: 'x' });
  await evaluate('store.getState().stopEditing()'); await pause(200);
  return { stored, shown, elId };
}
const docSize = (elId) => evaluate(`store.getState().deck.slides.flatMap((s) => s.elements).find((e) => e.id === '${elId}').doc.content[0].attrs.fontSize`);

try {
  // ---- 1-3: fresh profile; Cmd+, creates the template with the toolbar values ----
  await launch();
  assert.equal(existsSync(configPath), false, 'fresh profile: no config.txt');
  await openConfigKey();
  await until(() => existsSync(configPath), 'config.txt created');
  const created = await readFile(configPath, 'utf8');
  for (const l of ['font = NanumSquare', 'heading-1 = 80', 'heading-2 = 50', 'heading-3 = 30', 'body-size = 25']) assert.ok(created.split('\n').includes(l), 'new template has: ' + l);
  assert.equal(/^(heading-\d|body-size)\s*=.*pt/m.test(created), false, 'no pt values in the new template');
  // Opening shows the ACTUAL saved file (what the app reads back is exactly the file on disk)
  assert.equal((await evaluate('window.native.readConfig()')).text, created, 'the app reads the saved file');
  // The defaults really are what the toolbar shows for a fresh install (no config effect yet)
  const base = { '#': await heading('#'), '##': await heading('##'), '###': await heading('###'), '####': await heading('####') };
  assert.deepEqual(Object.values(base).map((h) => [h.stored, h.shown]), [[80, '80'], [50, '50'], [30, '30'], [25, '25']], 'defaults: stored size = toolbar number = template number');
  console.log('PASS fresh profile: template is 80/50/30/25 and equals the toolbar defaults');

  // ---- 4-9: bare / px / pt, for every level ----
  const cases = [
    { v: '100', stored: 100, label: 'bare 100' },
    { v: '100px', stored: 100, label: '100px' },
    { v: '60pt', stored: 80, label: '60pt' },
    { v: '80', stored: 80, label: 'bare 80' },
    { v: '100pt', stored: 133.33, label: '100pt (explicit PowerPoint points: 100 x 4/3)' },
  ];
  for (const c of cases) {
    await reload({ 'heading-1': c.v, 'heading-2': c.v, 'heading-3': c.v, 'body-size': c.v });
    const cur = await cfg();
    assert.deepEqual([cur.heading1, cur.heading2, cur.heading3, cur.bodySize], [c.stored, c.stored, c.stored, c.stored], 'config value for ' + c.label);
    for (const p of ['#', '##', '###', '####']) {
      const h = await heading(p);
      assert.equal(h.stored, c.stored, `${p} stored size for ${c.label}`);
      assert.equal(size(h.shown), c.stored, `${p}: toolbar shows ${c.stored} for ${c.label}, got ${h.shown}`);
    }
    // a new text box uses body-size, and the toolbar shows the same number
    await evaluate('store.getState().addSlide()'); await pause(300);
    await evaluate('insert.insertTextCenter()'); await pause(400);
    assert.equal(size(await toolbar()), c.stored, `new text box: toolbar shows ${c.stored} for ${c.label}`);
    const box = await evaluate("store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements.at(-1).style.fontSize");
    assert.equal(box, c.stored, 'new text box stored size');
    await evaluate('store.getState().stopEditing()'); await pause(200);
    // elements created earlier are untouched by the reload
    for (const p of ['#', '##', '###', '####']) assert.equal(await docSize(base[p].elId), base[p].stored, `existing ${p} heading unchanged`);
    console.log('PASS ' + c.label + ': config, stored size and toolbar agree for #, ##, ###, #### and new text boxes');
  }

  // ---- 10: settings persist across a restart ----
  await reload({ 'heading-1': '100', 'heading-2': '70', 'heading-3': '40', 'body-size': '30' });
  await evaluate("document.activeElement?.blur?.()");
  await until(() => evaluate("store.getState().saveState === 'saved'"), 'settled'); await pause(700);
  const before = await readFile(configPath, 'utf8');
  await quit(); await launch();
  assert.equal(await readFile(configPath, 'utf8'), before, 'restart leaves the file as saved');
  const cur = await cfg();
  assert.deepEqual([cur.heading1, cur.heading2, cur.heading3, cur.bodySize], [100, 70, 40, 30], 'saved settings active after restart without reloading');
  const after = [await heading('#'), await heading('##'), await heading('###'), await heading('####')];
  assert.deepEqual(after.map((h) => [h.stored, size(h.shown)]), [[100, 100], [70, 70], [40, 40], [30, 30]], 'after restart new headings use the saved sizes');
  for (const p of ['#', '##', '###', '####']) assert.equal(await docSize(base[p].elId), base[p].stored, `existing ${p} heading still unchanged after restart`);
  console.log('PASS settings persist across restart; existing headings unchanged');
} finally {
  await quit();
  await server.close();
}
console.log('ALL PASS');
