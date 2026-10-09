/** Image corner radius checks in a real Electron window with a disposable profile (never the user's data).
 * Run: node tests/image-radius.mjs. Needs a graphical session (windows are hidden unless MATHSLIDES_TEST_VISIBLE=1). */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
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
const output = process.env.MATHSLIDES_TEST_OUTPUT || await mkdtemp(path.join(tmpdir(), 'mathslides-radius-'));
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-radius-profile-'));
const portProbe = netServer();
await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
const debugPort = portProbe.address().port;
await new Promise(r => portProbe.close(r));
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: 5189, strictPort: true } });
await server.listen();
const wrapper = path.join(profile, 'main.cjs');
await writeFile(wrapper, `const { app } = require('electron');
app.setPath('userData', ${JSON.stringify(profile)});
require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});\n`);

let electron, socket;
const pending = new Map();
let id = 0;
const pause = (ms = 120) => new Promise((r) => setTimeout(r, ms));
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
async function connect() {
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 'Electron debug target unavailable');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data); const p = pending.get(data.id);
    if (p) { pending.delete(data.id); data.error ? p.reject(Error(data.error.message)) : p.resolve(data.result); }
  });
  await send('Runtime.enable');
  await until(() => evaluate(`!!document.querySelector('.propsbar')`), 'App failed to mount');
  await evaluate(`(async () => {
    window.store = (await import('/src/store/store.ts')).useStore;
    window.active = (await import('/src/editor/active.ts')).getActiveEditor;
    window.persist = await import('/src/store/persistence.ts');
    window.testFiles = {};
    window.showSaveFilePicker = async ({suggestedName}) => ({name:suggestedName,createWritable:async()=>({
      write:async(blob)=>{testFiles[suggestedName]=[...new Uint8Array(await blob.arrayBuffer())]},close:async()=>{}
    })});
    window.insert = await import('/src/canvas/insert.ts');
    window.png = (color, name) => new Promise((res) => { const c = document.createElement('canvas'); c.width = 400; c.height = 200; const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 400, 200); g.fillStyle = '#fff'; g.fillRect(190, 90, 20, 20); c.toBlob((b) => res(new File([b], name + '.png', {type: 'image/png'})), 'image/png'); });
  })()`);
}
async function launch() {
  electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`], { cwd: root, env: testElectronEnv({ ELECTRON_DEV_URL: 'http://127.0.0.1:5189' }), stdio: ['ignore', 'pipe', 'pipe'] });
  electron.stderr.on('data', () => {});
  await connect();
}
const restart = async () => { await pause(1200); socket.close(); electron.kill('SIGTERM'); await new Promise((r) => electron.once('exit', r)); await launch(); };


const els = () => evaluate("store.getState().deck.slides[store.getState().deck.slides.findIndex(s => s.id === store.getState().currentSlideId)].elements.filter(e => e.type === 'image')");
const css = (sel, prop) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? getComputedStyle(e)[${JSON.stringify(prop)}] : null; })()`);
const setNumber = async (v) => {
  await evaluate(`(() => { const i = document.querySelector('.propsbar input.num[title^="모서리"]'); i.focus(); i.select(); })()`);
  await send('Input.insertText', { text: String(v) }); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await pause(250);
};
/** Pixel (r,g,b) at viewport CSS px (x, y), read back from a real screenshot. */
const pixel = async (x, y) => {
  const shot = await send('Page.captureScreenshot');
  return evaluate(`(async () => { const img = new Image(); img.src = 'data:image/png;base64,${shot.data}'; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const k = img.width / window.innerWidth; return [...g.getImageData(Math.round(${x} * k), Math.round(${y} * k), 1, 1).data].slice(0, 3); })()`);
};
const isBlueish = (p) => p[2] > 150 && p[0] < 120; // the test image color #2563eb
const isBackground = (p) => p.every((v) => v > 235);

try {
  await launch();
  // Slide 1 is a title slide: use a new empty slide.
  await evaluate('store.getState().addSlide()'); await pause(300);
  for (const [color, name] of [['#2563eb', 'one'], ['#16a34a', 'two'], ['#dc2626', 'three']]) {
    await evaluate(`png(${JSON.stringify(color)}, ${JSON.stringify(name)}).then((f) => insert.insertImageFiles([f]))`);
    await pause(300);
  }
  await until(async () => (await els()).length === 3, 'three images');
  let [a, b, c] = await els();
  // Lay them out apart from each other and the footer.
  await evaluate(`store.getState().updateElements(['${a.id}'], e => { e.x = 60; e.y = 60; e.w = 400; e.h = 200 });
                  store.getState().updateElements(['${b.id}'], e => { e.x = 500; e.y = 60; e.w = 400; e.h = 200 });
                  store.getState().updateElements(['${c.id}'], e => { e.x = 60; e.y = 330; e.w = 400; e.h = 200 })`);
  await pause(300);
  const sel = (el) => `.slide.editable [data-el-id="${el.id}"]`;

  // ---- defaults: existing/new images are square ----
  for (const e of [a, b, c]) {
    assert.equal(e.radius, undefined, 'no radius stored by default');
    assert.equal(await css(sel(e) + ' .el-img', 'borderTopLeftRadius'), '0px', 'square by default');
  }
  await evaluate(`store.getState().select(['${a.id}'])`); await pause(200);
  assert.equal(await evaluate("document.querySelector('.radius-slider').value"), '0', 'slider starts at 0');
  assert.equal(await evaluate("document.querySelector('.propsbar input.num[title^=\"모서리\"]').value"), '0', 'number starts at 0');
  console.log('PASS default 0 px, existing look unchanged');

  // ---- numeric input: live preview, per-image ----
  await setNumber(24);
  [a] = (await els()).filter((e) => e.id === a.id);
  assert.equal(a.radius, 24);
  assert.equal(await css(sel(a) + ' .el-img', 'borderTopLeftRadius'), '24px', 'preview updates immediately');
  assert.equal(await css(sel(a), 'borderTopLeftRadius'), '24px', 'element box (and its border) follow');
  assert.equal(await evaluate("document.querySelector('.radius-slider').value"), '24', 'slider follows the number');
  await evaluate(`store.getState().select(['${b.id}'])`); await pause(200);
  await setNumber(60);
  const all = await els();
  assert.deepEqual(all.map((e) => e.radius), [24, 60, undefined], 'each image has its own radius');
  assert.equal(await css(sel(c) + ' .el-img', 'borderTopLeftRadius'), '0px', 'untouched image stays square');
  // 0 removes the property again
  await evaluate(`store.getState().select(['${c.id}'])`); await pause(200);
  await setNumber(10); await setNumber(0);
  assert.equal((await els())[2].radius, undefined, 'radius 0 is stored as absent');
  console.log('PASS numeric input, per-image radius');

  // ---- slider: one undo step per drag ----
  await evaluate(`store.getState().select(['${a.id}'])`); await pause(200);
  await evaluate(`(() => {
    const s = document.querySelector('.radius-slider'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    s.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
    for (const v of [30, 40, 50]) { set.call(s, String(v)); s.dispatchEvent(new Event('input', {bubbles: true})); }
    s.dispatchEvent(new PointerEvent('pointerup', {bubbles: true}));
  })()`); await pause(300);
  assert.equal((await els())[0].radius, 50, 'slider sets the radius');
  assert.equal(await css(sel(a) + ' .el-img', 'borderTopLeftRadius'), '50px');
  await evaluate('store.getState().undo()'); await pause(200);
  assert.equal((await els())[0].radius, 24, 'one undo reverts the whole drag');
  await evaluate('store.getState().redo()'); await pause(200);
  assert.equal((await els())[0].radius, 50);
  await evaluate('store.getState().undo()'); await pause(200);
  console.log('PASS slider drag = one undo step');

  // ---- slider is continuous; preset button; numeric input exact ----
  const drag = (vals) => evaluate(`(() => {
    const s = document.querySelector('.radius-slider'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    s.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
    for (const v of ${JSON.stringify(vals)}) { set.call(s, String(v)); s.dispatchEvent(new Event('input', {bubbles: true})); }
    s.dispatchEvent(new PointerEvent('pointerup', {bubbles: true}));
  })()`).then(() => pause(250));
  const presetBtn = "document.querySelector('.propsbar .radius-preset')";
  await evaluate(`store.getState().select(['${a.id}'])`); await pause(200);
  for (const v of [47, 48, 49, 50, 51, 52, 53]) { await drag([v]); assert.equal((await els())[0].radius, v, `slider reaches ${v} exactly (no magnetism)`); }
  await setNumber(49); assert.equal((await els())[0].radius, 49, 'numeric input is exact');
  assert.equal(await evaluate(`${presetBtn}.textContent`), '50', 'preset button shows 50');
  assert.equal(await evaluate(`${presetBtn}.disabled`), false);
  assert.equal(await evaluate(`${presetBtn}.classList.contains('active')`), false, 'not active at 49');
  assert.equal(await evaluate(`${presetBtn}.previousElementSibling.matches('input.num')`), true, 'button sits right after the numeric input');
  const hist = await evaluate('store.getState().past.length');
  await evaluate(`${presetBtn}.click()`); await pause(250);
  assert.equal((await els())[0].radius, 50, 'click sets the preset');
  assert.equal(await css(sel(a) + ' .el-img', 'borderTopLeftRadius'), '50px', 'preview updates');
  assert.equal(await evaluate(`${presetBtn}.classList.contains('active')`), true, 'active when the radius equals the preset');
  assert.equal(await evaluate('store.getState().past.length'), hist + 1, 'exactly one undo step');
  await evaluate('store.getState().undo()'); await pause(200);
  assert.equal((await els())[0].radius, 49, 'undo restores the previous radius');
  await evaluate('store.getState().redo()'); await pause(200);
  assert.equal((await els())[0].radius, 50, 'redo re-applies it');
  await setNumber(51); assert.equal((await els())[0].radius, 51, 'number field still precise next to the preset');
  // preset above the image's maximum: disabled, not clamped
  await evaluate(`store.getState().updateElements(['${c.id}'], e => { e.w = 90; e.h = 90 }); store.getState().select(['${c.id}'])`); await pause(300);
  assert.equal(await evaluate("document.querySelector('.radius-slider').max"), '45');
  assert.equal(await evaluate(`${presetBtn}.disabled`), true, 'preset disabled when 50 exceeds the maximum');
  await evaluate(`${presetBtn}.click()`); await pause(200);
  assert.equal((await els())[2].radius, undefined, 'a disabled preset changes nothing (and is not clamped)');
  await drag([44, 45]); assert.equal((await els())[2].radius, 45, 'slider still free up to the maximum');
  await evaluate(`store.getState().updateElements(['${c.id}'], e => { e.w = 400; e.h = 200; delete e.radius })`);
  await evaluate(`store.getState().updateElements(['${a.id}'], e => { e.radius = 24 })`); await pause(200);
  console.log('PASS free slider, precise number, single preset button (undo, max constraint)');

  // ---- clamping on resize ----
  await evaluate(`store.getState().select(['${a.id}'])`); await pause(200);
  await evaluate(`store.getState().updateElements(['${a.id}'], e => { e.w = 40; e.h = 40 })`); await pause(250);
  assert.equal((await els())[0].radius, 24, 'stored radius untouched by a resize');
  assert.equal(await css(sel(a) + ' .el-img', 'borderTopLeftRadius'), '20px', 'rendered radius is clamped to half the shorter side');
  assert.equal(await evaluate("document.querySelector('.radius-slider').max"), '20', 'slider range follows the size');
  assert.equal(await evaluate("document.querySelector('.propsbar input.num[title^=\"모서리\"]').value"), '20');
  await evaluate(`store.getState().updateElements(['${a.id}'], e => { e.w = 400; e.h = 200 })`); await pause(250);
  assert.equal(await css(sel(a) + ' .el-img', 'borderTopLeftRadius'), '24px', 'grows back to the stored radius');
  console.log('PASS clamping when resized');

  // ---- border follows the corners ----
  await evaluate(`store.getState().updateElements(['${a.id}'], e => { e.borderColor = '#ff8800' })`); await pause(250);
  assert.match(await css(sel(a), 'outlineStyle'), /solid/, 'border kept');
  assert.equal(await css(sel(a), 'borderTopLeftRadius'), '24px', 'border box is rounded');
  await evaluate(`store.getState().updateElements(['${a.id}'], e => { delete e.borderColor })`);

  // ---- crop ----
  await evaluate(`store.getState().updateElements(['${b.id}'], e => { e.crop = {x: .1, y: .1, w: .6, h: .6} })`); await pause(250);
  assert.equal(await css(sel(b) + ' .el-img-crop', 'borderTopLeftRadius'), '60px', 'cropped image is rounded too');
  await evaluate(`store.getState().enterCrop('${b.id}')`); await pause(300);
  assert.equal(await css('.crop-window', 'borderTopLeftRadius'), '0px', 'crop editing overlay stays rectangular');
  await evaluate('store.getState().exitCrop()'); await pause(300);
  assert.equal(await css(sel(b) + ' .el-img-crop', 'borderTopLeftRadius'), '60px');
  console.log('PASS border follows corners; crop overlay rectangular, cropped image rounded');

  // ---- resizing / selection handles still work ----
  await evaluate(`store.getState().select(['${a.id}'])`); await pause(250);
  assert.ok(await evaluate("document.querySelectorAll('.handle').length >= 4"), 'selection handles present');
  const hs = await evaluate(`(() => { const h = [...document.querySelectorAll('.handle')].find(e => getComputedStyle(e).cursor.startsWith('se')) || document.querySelectorAll('.handle')[3]; const r = h.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
  const before = (await els())[0];
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...hs });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', x: hs.x - 40, y: hs.y - 20 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: hs.x - 40, y: hs.y - 20 }); await pause(300);
  const after = (await els())[0];
  assert.ok(after.w < before.w, 'handle drag still resizes'); assert.equal(after.radius, 24, 'radius kept through a resize');
  await evaluate('store.getState().undo()'); await pause(200);

  // ---- pixels: CSS corner is a circular arc of the given radius ----
  await evaluate('store.getState().select([])'); await pause(300);
  const geo = async (e) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel(e) + ' .el-img-crop, ' + sel(e) + ' .el-img')}).getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, k: r.width / ${e.w}}; })()`);
  const gb = await geo(b); const rpx = 60 * gb.k; const d = rpx * (1 - Math.SQRT1_2);
  assert.ok(isBackground(await pixel(gb.x + 1, gb.y + 1)), 'the extreme corner is cut away');
  assert.ok(isBackground(await pixel(gb.x + d - 4, gb.y + d - 4)), 'just outside the arc is background');
  assert.ok(isBlueish(await pixel(gb.x + d + 4, gb.y + d + 4)) || (await pixel(gb.x + d + 4, gb.y + d + 4))[1] > 120, 'just inside the arc is the picture');
  const ga = await geo(c);
  assert.ok(!isBackground(await pixel(ga.x + 1, ga.y + 1)), 'an unrounded image keeps its square corner');
  console.log('PASS rendered corner is a circular arc of the stored radius');

  // ---- thumbnails and presenter ----
  assert.equal(await evaluate(`[...document.querySelectorAll('.thumb-inner .el-img, .thumb-inner .el-img-crop')].map((e) => getComputedStyle(e).borderTopLeftRadius).sort().join()`), '0px,24px,60px', 'thumbnails show the radii');
  await evaluate('store.setState({presenting: true})'); await pause(500);
  assert.equal(await evaluate(`[...document.querySelectorAll('.presenter .el-img, .presenter .el-img-crop')].map((e) => getComputedStyle(e).borderTopLeftRadius).sort().join()`), '0px,24px,60px', 'presenter shows the radii');
  await evaluate('store.setState({presenting: false})'); await pause(300);
  console.log('PASS thumbnails and presenter');

  // ---- persistence ----
  const radii = () => evaluate(`JSON.stringify(store.getState().deck.slides.flatMap((s) => s.elements).filter((e) => e.type === 'image').map((e) => e.radius ?? null))`);
  assert.equal(await radii(), '[24,60,null]');
  await restart();
  assert.equal(await radii(), '[24,60,null]', 'radius survives autosave + restart');
  await until(() => evaluate('store.getState().deck.slides.length > 1'), 'deck restored');
  await evaluate('persist.saveProject()'); await pause(800);
  const fileName = await evaluate("Object.keys(testFiles).find(k => k.endsWith('.mslides'))");
  const saved = JSON.parse(Buffer.from(await evaluate(`testFiles[${JSON.stringify(fileName)}]`)).toString('utf8'));
  assert.deepEqual(saved.deck.slides.flatMap((s) => s.elements).filter((e) => e.type === 'image').map((e) => e.radius ?? null), [24, 60, null], 'radius is in the .mslides file');
  console.log('PASS persistence (autosave, restart, .mslides)');

  // ---- PPTX ----
  await evaluate("document.querySelector('.export-menu > button').click()"); await pause(200);
  await evaluate("document.querySelector('.pop .menu-item:nth-child(2)').click()");
  const pptx = await until(() => evaluate("Object.keys(testFiles).find(k => k.endsWith('.pptx'))"), 'PPTX export', 30000);
  await until(() => evaluate(`testFiles[${JSON.stringify(pptx)}]?.length > 1000`), 'PPTX bytes', 30000);
  await writeFile(path.join(output, 'radius.pptx'), Buffer.from(await evaluate(`testFiles[${JSON.stringify(pptx)}]`)));
  const zip = await JSZip.loadAsync(await readFile(path.join(output, 'radius.pptx')));
  const slideNo = saved.deck.slides.findIndex((s) => s.elements.some((e) => e.type === 'image')) + 1;
  const xml = await zip.file(`ppt/slides/slide${slideNo}.xml`).async('string');
  const pics = [...xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)].map((m) => m[0]);
  assert.equal(pics.length, 3, 'three pictures, nothing rasterized or duplicated');
  const geom = (p) => /<a:prstGeom prst="(\w+)">(?:<a:avLst>(?:<a:gd name="adj" fmla="val (\d+)"\/>)?<\/a:avLst>)?/.exec(p);
  const [ia, ib, ic] = saved.deck.slides.flatMap((s) => s.elements).filter((e) => e.type === 'image');
  const byName = (n) => pics.find((p) => p.includes(`name="${n}"`));
  const pa = byName('Rounded Image 1'), pb = byName('Rounded Image 2');
  assert.ok(pa && pb, 'rounded pictures are named');
  assert.deepEqual([geom(pa)[1], Number(geom(pa)[2])], ['roundRect', Math.round(24 / Math.min(ia.w, ia.h) * 100000)], 'uncropped picture: roundRect + adj');
  assert.deepEqual([geom(pb)[1], Number(geom(pb)[2])], ['roundRect', Math.round(60 / Math.min(ib.w, ib.h) * 100000)], 'cropped picture: roundRect + adj');
  assert.match(pb, /<a:srcRect/, 'native crop is kept on the rounded picture');
  const pc = pics.find((p) => !p.includes('Rounded Image'));
  assert.equal(geom(pc)[1], 'rect', 'the unrounded picture is untouched');
  assert.ok(!/roundRect/.test(pc));
  // the formula: preset radius = min(w,h) * adj / 100000 == the CSS radius
  for (const [p, e, r] of [[pa, ia, 24], [pb, ib, 60]]) {
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(p); const emu = Math.min(Number(ext[1]), Number(ext[2]));
    const radiusEmu = emu * Number(geom(p)[2]) / 100000;
    const frameEmu = emu, framePx = Math.min(e.w, e.h);
    assert.ok(Math.abs(radiusEmu / frameEmu * framePx - r) < 0.05, `OOXML radius ${radiusEmu / frameEmu * framePx}px == CSS ${r}px`);
  }
  // original image bytes embedded unchanged
  const assetB64 = await evaluate(`Object.values(store.getState().assets).map((a) => a.dataUrl.split(',')[1])`);
  const media = await Promise.all(Object.keys(zip.files).filter((f) => f.startsWith('ppt/media/') && !zip.files[f].dir).map((f) => zip.file(f).async('base64')));
  for (const b64 of assetB64) assert.ok(media.includes(b64), 'original PNG bytes embedded unchanged');
  // border becomes a rounded outline shape (separately checked below)
  console.log('PASS PPTX: roundRect on exactly the rounded pictures, adj formula, crop and bytes kept');

  // border in PPTX follows the corners
  await evaluate(`store.getState().goToSlide(${JSON.stringify(saved.deck.slides[slideNo - 1].id)}); store.getState().updateElements(['${ia.id}'], e => { e.borderColor = '#ff8800' }); store.getState().updateElements(['${ic.id}'], e => { e.borderColor = '#0088ff' })`); await pause(300);
  await evaluate("delete testFiles[Object.keys(testFiles).find(k => k.endsWith('.pptx'))]");
  await evaluate("document.querySelector('.export-menu > button').click()"); await pause(200);
  await evaluate("document.querySelector('.pop .menu-item:nth-child(2)').click()");
  const pptx2 = await until(() => evaluate("Object.keys(testFiles).find(k => k.endsWith('.pptx'))"), 'PPTX export 2', 30000);
  await until(() => evaluate(`testFiles[${JSON.stringify(pptx2)}]?.length > 1000`), 'PPTX bytes 2', 30000);
  const zip2 = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(pptx2)}]`)));
  const xml2 = await zip2.file(`ppt/slides/slide${slideNo}.xml`).async('string');
  const borders = [...xml2.matchAll(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*name="Instance Border"[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
  assert.equal(borders.length, 2, 'two borders');
  assert.deepEqual(borders.map((s) => /prst="(\w+)"/.exec(s)[1]).sort(), ['rect', 'roundRect'], 'rounded image border is a roundRect, the square one stays rect');
  const rr = borders.find((s) => s.includes('roundRect'));
  assert.match(rr, /<a:gd name="adj" fmla="val \d+"\/>/, 'border carries the adj');
  console.log('PASS PPTX instance border follows the corners');
  console.log('OUTPUT', output);
} catch (error) {
  console.error(error); console.log('OUTPUT', output);
  process.exitCode = 1;
} finally {
  socket?.close();
  if (electron && electron.exitCode === null) { electron.kill('SIGTERM'); await new Promise((r) => electron.once('exit', r)); }
  await server.close();
}
