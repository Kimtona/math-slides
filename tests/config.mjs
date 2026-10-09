/** config.txt (Cmd+, / Cmd+Shift+,): file creation, startup load, reload, validation, creation-only effect, persistence.
 * Real Electron windows on a disposable userData profile. Run: node tests/config.mjs (needs a graphical session).
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
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-config-profile-'));
const configPath = path.join(profile, 'config.txt'); // app.setPath('userData', profile) below = Electron's userData
const probe = netServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const debugPort = probe.address().port;
await new Promise((r) => probe.close(r));
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: 5197, strictPort: true } });
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
  electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`], { cwd: root, env: testElectronEnv({ ELECTRON_DEV_URL: 'http://127.0.0.1:5197' }), stdio: ['ignore', 'pipe', 'pipe'] });
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
const GOOD = `# my settings\nfont = Pretendard\nheading-1 = 50pt\nheading-2 = 30pt\nheading-3 = 24pt\nbody-size = 20px\nshape-fill = #FFFFFF\nshape-stroke = #FF0000\nshape-stroke-width = 2px\nimage-radius-preset = 30px\n`;

try {
  // ======== launch 1: no config.txt ========
  await launch();
  assert.equal(existsSync(configPath), false, 'startup never creates config.txt');
  assert.deepEqual(await cfg(), { font: 'NanumSquare', heading1: 80, heading2: 50, heading3: 30, bodySize: 25, shapeFill: null, shapeStroke: '#000000', shapeStrokeWidth: 1, imageRadiusPreset: 50 }, 'no file: built-in defaults');
  const old = await typeHeading('#', 'Old heading');
  assert.equal(old.size, 80, 'default # heading is 80');
  await evaluate("store.getState().addElements([defaults.newShape('rect', 100, 400)])");
  const oldShape = (await slideEls()).find((e) => e.type === 'shape');
  assert.deepEqual([oldShape.fill, oldShape.stroke, oldShape.strokeWidth, 'textStyle' in oldShape], [null, '#000000', 1, false]);
  await settle();

  // ---- Cmd+, creates the template once, never overwrites ----
  await openConfigKey();
  await until(() => existsSync(configPath), 'config.txt created by Cmd+,');
  const template = await evaluate('cfg.configTemplate()');
  assert.equal(await readFile(configPath, 'utf8'), template, 'created from the commented template');
  assert.match(template, /^# MathSlides Configuration/); assert.match(template, /^heading-1 = 80$/m); assert.match(template, /^body-size = 25$/m); assert.match(template, /Cmd\+Shift\+,/);
  await until(async () => /Created config\.txt/.test(await toast()), 'creation toast');
  await writeFile(configPath, GOOD);
  await pause(500); await openConfigKey(); await pause(700);
  assert.equal(await readFile(configPath, 'utf8'), GOOD, 'an existing config.txt is never overwritten');
  console.log('PASS Cmd+, creates config.txt from the template and never overwrites it');

  // ---- Cmd+Shift+, reloads; nothing about the document changes ----
  const deckBefore = await deck(), pastBefore = await evaluate('store.getState().past.length'), headIdBefore = await evaluate('store.getState().deck.id');
  await reloadConfigKey();
  await until(async () => (await cfg()).heading1 === 66.67, 'reload applied');
  assert.deepEqual(await cfg(), { font: 'Pretendard', heading1: 66.67, heading2: 40, heading3: 32, bodySize: 20, shapeFill: '#FFFFFF', shapeStroke: '#FF0000', shapeStrokeWidth: 2, imageRadiusPreset: 30 });
  assert.match(await toast(), /Configuration reloaded/);
  await pause(800);
  assert.equal(await deck(), deckBefore, 'reload does not touch the deck');
  assert.equal(await evaluate('store.getState().past.length'), pastBefore, 'no undo entry'); assert.equal(await evaluate("store.getState().saveState"), 'saved', 'not dirty, no autosave');
  assert.equal(await evaluate('store.getState().deck.id'), headIdBefore);
  console.log('PASS Cmd+Shift+, reloads without touching the presentation');

  // ---- new content follows the config, old content is unchanged ----
  const fresh = await typeHeading('#', 'New heading');
  assert.equal(fresh.size, 66.67, 'new # heading uses the reloaded size');
  const oldDoc = (await evaluate('store.getState().deck.slides')).flatMap((s) => s.elements).find((e) => e.id === old.elId);
  assert.equal(oldDoc.doc.content[0].attrs.fontSize, 80, 'the existing heading keeps 80');
  assert.equal((await typeHeading('##', 'x')).size, 40); assert.equal((await typeHeading('###', 'x')).size, 32); assert.equal((await typeHeading('####', 'x')).size, 20);
  await evaluate('store.getState().addSlide()'); await pause(300);
  await evaluate("insert.insertTextCenter()"); await pause(300);
  const newText = (await slideEls()).filter((e) => e.type === 'text').at(-1); // the box just inserted (after the content template's two)
  assert.ok(newText, 'a new text box exists'); assert.deepEqual([newText.style.fontSize, newText.style.fontFamily], [20, 'Pretendard']);
  assert.match(await fam(newText.id), /^Pretendard/, 'rendered in the configured font');
  assert.equal(oldDoc.style.fontFamily, undefined, 'the existing heading box has no stored font (legacy fallback)');
  const oldSlide = await evaluate(`store.getState().deck.slides.find((s) => s.elements.some((e) => e.id === '${old.elId}')).id`);
  const here = await evaluate('store.getState().currentSlideId');
  await evaluate(`store.getState().goToSlide('${oldSlide}')`); await pause(300);
  assert.match(await fam(old.elId), /^NanumSquare/, 'old text keeps rendering in the legacy font');
  await evaluate(`store.getState().goToSlide('${here}')`); await pause(300);
  await evaluate("insert.insertShape('rect')"); await pause(300);
  const newShape = (await slideEls()).find((e) => e.type === 'shape');
  assert.deepEqual([newShape.fill, newShape.stroke, newShape.strokeWidth], ['#FFFFFF', '#FF0000', 2]);
  assert.deepEqual([newShape.textStyle.fontSize, newShape.textStyle.fontFamily], [20, 'Pretendard']);
  const allShapes = (await evaluate('store.getState().deck.slides')).flatMap((s) => s.elements).filter((e) => e.type === 'shape');
  assert.deepEqual(allShapes.find((e) => e.id === oldShape.id), oldShape, 'the existing shape is byte-for-byte unchanged');
  console.log('PASS new elements follow the config, existing ones keep their formatting');

  // ---- image radius preset ----
  await evaluate('store.getState().addSlide()'); await pause(300);
  for (const [color, name] of [['#2563eb', 'a'], ['#16a34a', 'b']]) { await evaluate(`png(${JSON.stringify(color)}, ${JSON.stringify(name)}).then((f) => insert.insertImageFiles([f]))`); await pause(400); }
  const [imgA, imgB] = (await slideEls()).filter((e) => e.type === 'image');
  await evaluate(`store.getState().updateElements(['${imgA.id}'], (e) => { e.radius = 12; })`);
  await evaluate(`store.getState().select(['${imgB.id}'])`); await pause(300);
  assert.equal(await evaluate("document.querySelector('.propsbar .radius-preset').textContent"), '30', 'preset button shows the configured value');
  assert.equal((await slideEls()).find((e) => e.id === imgB.id).radius, undefined, 'nothing applied until the button is used');
  await evaluate("document.querySelector('.propsbar .radius-preset').click()"); await pause(300);
  const imgs = (await slideEls()).filter((e) => e.type === 'image');
  assert.deepEqual(imgs.map((e) => e.radius ?? null), [12, 30], 'preset applies to the selected image only; the other keeps 12');
  console.log('PASS image radius preset');

  // ---- save / reopen / export keep explicit formatting ----
  await settle();
  await evaluate("document.querySelector('.export-menu > button').click()"); await pause(200);
  await evaluate("document.querySelector('.pop .menu-item:nth-child(2)').click()");
  const pptxName = await until(() => evaluate("Object.keys(testFiles).find((k) => k.endsWith('.pptx'))"), 'PPTX export', 40000);
  await until(() => evaluate(`testFiles[${JSON.stringify(pptxName)}]?.length > 1000`), 'PPTX bytes', 40000);
  const zip = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(pptxName)}]`)));
  const slides = await Promise.all(Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort().map((n) => zip.file(n).async('string')));
  const typefaces = new Set(slides.join('').match(/typeface="[^"]+"/g));
  assert.ok(typefaces.has('typeface="Pretendard"') && typefaces.has('typeface="NanumSquare"'), 'PPTX keeps both the configured font on new text and the legacy font on old text: ' + [...typefaces]);
  console.log('PASS PPTX export keeps per-box fonts');

  // ---- failed reload keeps the last valid config; deleted file restores defaults ----
  await writeFile(configPath, GOOD.replace('heading-2 = 30pt', 'heading-2 = abc') + 'bogus = 1\n');
  const afterGood = await cfg();
  await pause(500); await reloadConfigKey();
  await until(async () => /Config error on line \d+/.test(await toast()), 'error toast');
  assert.match(await toast(), /Config error on line 4: invalid heading-2.*\(\+1 more\)/, 'line number and key are reported');
  assert.deepEqual(await cfg(), afterGood, 'invalid file: the last valid configuration stays active (no partial application)');
  await writeFile(configPath, GOOD.replace('heading-1 = 50pt', 'heading-1 = 40pt'));
  await pause(500); await reloadConfigKey();
  await until(async () => (await cfg()).heading1 === 53.33, 'second valid reload');
  await writeFile(configPath, GOOD); // persisted for the restart check; heading-1 = 50pt
  await pause(500); await reloadConfigKey(); await until(async () => (await cfg()).heading1 === 66.67, 'back to GOOD');
  await rm(configPath);
  await pause(500); await reloadConfigKey();
  await until(async () => (await cfg()).heading1 === 80, 'deleted file restores defaults');
  assert.match(await toast(), /built-in defaults restored/);
  assert.equal(existsSync(configPath), false, 'reload never recreates the file');
  const slidesAfter = await evaluate('store.getState().deck.slides');
  assert.equal(slidesAfter.flatMap((s) => s.elements).find((e) => e.id === fresh.elId).style.fontFamily, 'Pretendard', 'existing elements are unaffected by the defaults being restored');
  console.log('PASS invalid reload keeps the last config; deleted file restores defaults');

  // ======== launch 2: valid file persists across a restart ========
  await writeFile(configPath, GOOD);
  await settle(); await pause(700); await quit();
  await launch();
  assert.equal((await cfg()).heading1, 66.67, 'a saved valid config is active after restart without reloading');
  assert.equal(await toast(), '', 'no warning for a valid file');
  assert.equal((await typeHeading('#', 'After restart')).size, 66.67);
  assert.equal((await slideEls()).length > 0, true);
  console.log('PASS config persists across restart');

  // ======== launch 3: invalid file at startup ========
  const BROKEN = 'heading-1 = nope\n';
  await writeFile(configPath, BROKEN);
  await settle(); await pause(700); await quit();
  await launch();
  assert.equal((await cfg()).heading1, 80, 'invalid startup file: built-in defaults');
  assert.match(await toast(), /Config error on line 1: invalid heading-1.*built-in defaults/, 'startup warning');
  assert.equal(await readFile(configPath, 'utf8'), BROKEN, 'the invalid file is left untouched');
  assert.equal((await typeHeading('#', 'x')).size, 80);
  console.log('PASS invalid config at startup falls back to defaults without touching the file');

  // ======== first launch on a fresh profile: the first deck uses config ========
  await settle(); await pause(700); await quit();
  await rm(path.join(profile, 'IndexedDB'), { recursive: true, force: true }); await rm(path.join(profile, 'Local Storage'), { recursive: true, force: true });
  await writeFile(configPath, GOOD);
  await launch();
  const first = await evaluate('store.getState().deck.slides[0].elements.map((e) => [e.style.fontSize, e.style.fontFamily])');
  assert.deepEqual(first, [[66.67, 'Pretendard'], [32, 'Pretendard']], 'a brand-new deck starts with the configured title/subtitle sizes and font');
  console.log('PASS first deck on a fresh profile follows the config');
} finally {
  await quit();
  await server.close();
}
console.log('ALL PASS');
