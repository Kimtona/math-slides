/** Native table checks in a real Electron window with a disposable profile (never the user's data).
 * Run: node tests/table.mjs. Needs a graphical session (windows are hidden unless MATHSLIDES_TEST_VISIBLE=1). */
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
const output = process.env.MATHSLIDES_TEST_OUTPUT || await mkdtemp(path.join(tmpdir(), 'mathslides-table-'));
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-table-profile-'));
const portProbe = netServer();
await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
const debugPort = portProbe.address().port;
await new Promise(r => portProbe.close(r));
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: 5190, strictPort: true } });
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
    window.tmodel = await import('/src/model/table.ts');
    window.tf = await import('/src/ui/textFormat.ts');
  })()`);
}
async function launch() {
  electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`], { cwd: root, env: testElectronEnv({ ELECTRON_DEV_URL: 'http://127.0.0.1:5190' }), stdio: ['ignore', 'pipe', 'pipe'] });
  electron.stderr.on('data', () => {});
  await connect();
}
const restart = async () => { await pause(1200); socket.close(); electron.kill('SIGTERM'); await new Promise((r) => electron.once('exit', r)); await launch(); };



const tables = () => evaluate("store.getState().deck.slides.flatMap((s) => s.elements).filter((e) => e.type === 'table')");
const cur = () => evaluate("store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements");
const T = async (i = 0) => (await tables())[i];
const cellText = (t, r, c) => t.rows[r][c].doc.content.map((p) => (p.content ?? []).map((n) => n.text ?? '').join('')).join('\n');
const sel = (t) => `.slide.editable [data-el-id="${t.id}"]`;
const td = (t, r, c) => `${sel(t)} td[data-r="${r}"][data-c="${c}"]`;
const history = () => evaluate('store.getState().past.length');
const tab = async (shift = false) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 }); await pause(250); };
const esc = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await pause(250); };
const type = (s) => send('Input.insertText', { text: s }).then(() => pause(200));
const center = (selector) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw Error('Missing ' + ${JSON.stringify(selector)}); const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
const hover = (p) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
const mouse = (type, p, extra = {}) => send('Input.dispatchMouseEvent', { type, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...p, ...extra });
const clickCell = async (t, r, c) => { const p = await center(td(t, r, c)); await mouse('mousePressed', p); await mouse('mouseReleased', p); await pause(350); };
const drag = async (from, dx, dy = 0) => { await mouse('mousePressed', from); for (const k of [0.25, 0.5, 0.75, 1]) await mouse('mouseMoved', { x: from.x + dx * k, y: from.y + dy * k }); await mouse('mouseReleased', { x: from.x + dx, y: from.y + dy }); await pause(350); };
const opButton = (label) => `(() => [...document.querySelectorAll('.propsbar button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}))()`;
const clickOp = async (label) => { await evaluate(`${opButton(label)}.click()`); await pause(350); };
const problems = (t) => evaluate(`tmodel.tableProblems(${JSON.stringify(t)})`);
const others = async () => (await cur()).filter((e) => e.type !== 'table');
/** DOM agrees with the model: column widths, stored height. */
const domMatches = async (t) => {
  const info = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel(t))}); const cols = [...el.querySelectorAll('col')].map((c) => parseFloat(c.style.width)); return { cols, h: el.offsetHeight, w: el.offsetWidth, rows: el.querySelectorAll('tr').length, cells: el.querySelectorAll('td').length }; })()`);
  assert.deepEqual(info.cols, t.cols, 'rendered column widths = model'); assert.equal(info.w, t.w, 'rendered width = model');
  assert.equal(info.rows, t.rows.length); assert.equal(info.cells, t.rows.length * t.cols.length);
  // The stored height is measured asynchronously (ResizeObserver): it must settle on the rendered height, but may lag a frame or two under load.
  const settled = await until(async () => {
    const live = (await tables()).find((x) => x.id === t.id);
    const rendered = await evaluate(`document.querySelector(${JSON.stringify(sel(t))}).offsetHeight`);
    return live && Math.abs(live.h - rendered) <= 1 ? { stored: live.h, rendered } : false;
  }, `stored height ${t.h} never settled on the rendered height ${info.h}`, 5000);
  assert.ok(Math.abs(settled.stored - settled.rendered) <= 1, `stored height ${settled.stored} follows the rendered height ${settled.rendered}`);
};

try {
  await launch();
  await evaluate('store.getState().addSlide()'); await pause(300);
  // A plain text box and a shape that must stay untouched by everything below.
  await evaluate('insert.insertShape("rect")'); await pause(200);
  const baseline = await others();
  const baseHistory = await history();

  // ---- insertion: toolbar ----
  await evaluate("[...document.querySelectorAll('.tb-center button')].find((b) => b.textContent.includes('표')).click()"); await pause(400);
  let t = await T();
  assert.equal((await tables()).length, 1, 'one table inserted');
  assert.equal(t.rows.length, 3); assert.equal(t.cols.length, 3); assert.ok(t.rows.every((r) => r.length === 3), '3×3');
  assert.equal(t.w, Math.round(1280 * 0.6), '~60% of the slide'); assert.equal(t.style, 'minimal'); assert.equal(t.headerRow, true);
  assert.deepEqual(await problems(t), []);
  assert.equal(Math.round(t.x + t.w / 2), 640, 'centered'); 
  assert.deepEqual(await evaluate('store.getState().selection'), [t.id], 'new table is selected');
  assert.equal(await evaluate('store.getState().editingId'), null, 'not in text edit mode');
  await domMatches(t);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('${td(t, 1, 0)}')).borderBottomWidth`), '1px', 'subtle horizontal divider');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('${td(t, 1, 0)}')).borderLeftWidth`), '0px', 'no vertical gridlines');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('${td(t, 0, 0)}')).fontWeight`), '700', 'header row emphasized');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('${td(t, 1, 0)}')).fontWeight`), '400');
  assert.equal(await history(), baseHistory + 1, 'one undo step');
  await evaluate('store.getState().undo()'); await pause(250);
  assert.equal((await tables()).length, 0, 'undo removes the table'); 
  await evaluate('store.getState().redo()'); await pause(250);
  assert.equal((await tables()).length, 1, 'redo restores it'); t = await T();
  console.log('PASS insertion (toolbar): default 3x3, minimal, header, undo/redo');

  // ---- insertion: /table ----
  await evaluate('insert.insertTextCenter()'); await until(() => evaluate('!!active()'), 'text editor');
  await type('/table'); await pause(300);
  assert.equal(await evaluate("!!document.querySelector('.slash-menu')"), true, 'slash menu shows');
  assert.match(await evaluate("document.querySelector('.slash-item.active .slash-name').textContent"), /Table/);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await pause(500);
  assert.equal((await tables()).length, 2, '/table inserts a table');
  assert.ok(!JSON.stringify(await cur()).includes('/table'), 'the /table text is gone');
  assert.deepEqual(await others(), baseline, 'no stray text box is left behind');
  let t2 = (await tables())[1]; assert.equal(t2.rows.length, 3);
  await evaluate('store.getState().undo()'); await pause(250);
  assert.equal((await tables()).length, 1, 'undo removes the /table table');
  console.log('PASS insertion (/table)');

  // ---- select, move, then edit ----
  await evaluate('store.getState().select([])'); await pause(200);
  const before = { x: t.x, y: t.y };
  const h0 = await history();
  await clickCell(t, 1, 1);
  assert.deepEqual(await evaluate('store.getState().selection'), [t.id], 'first click selects the table');
  assert.equal(await evaluate('store.getState().editingId'), null, 'first click does not edit');
  await drag(await center(td(t, 1, 1)), 90, 40);
  t = await T();
  assert.ok(t.x > before.x + 40 && t.y > before.y + 15, 'dragging a selected table moves it as one element');
  assert.equal(await evaluate('store.getState().editingId'), null, 'a drag does not start editing');
  assert.equal(await history(), h0 + 1, 'move = one undo step');
  assert.deepEqual(t.cols, [256, 256, 256]); assert.equal(t.rows.length, 3);
  await evaluate('store.getState().undo()'); await pause(250);
  t = await T(); assert.deepEqual({ x: t.x, y: t.y }, before, 'undo restores the position');
  await clickCell(t, 2, 1);
  assert.equal(await evaluate('store.getState().editingId'), t.id, 'clicking a cell of the selected table starts editing');
  assert.deepEqual(await evaluate('store.getState().editCell'), { row: 2, col: 1 }, 'in the clicked cell');
  assert.equal(await evaluate(`!!document.querySelector('${td(t, 2, 1)} .ProseMirror')`), true, 'cell editor mounted in that cell');
  // dragging inside a cell being edited selects text; it never moves the table
  const pos = { x: t.x, y: t.y };
  await type('hello world');
  const from = await center(td(t, 2, 1)); await drag(from, 60, 0);
  t = await T(); assert.deepEqual({ x: t.x, y: t.y }, pos, 'drag inside a cell being edited does not move the table');
  console.log('PASS select / move / click-to-edit, no accidental drag');

  // ---- cell editing, Tab navigation ----
  await esc(); assert.equal(await evaluate('store.getState().editingId'), null, 'Esc leaves the cell'); assert.deepEqual(await evaluate('store.getState().selection'), [t.id], 'table stays selected');
  t = await T(); assert.equal(cellText(t, 2, 1), 'hello world', 'cell text stored');
  await clickCell(t, 0, 0);                  // already selected -> edit
  await type('Name'); await tab();
  assert.deepEqual(await evaluate('store.getState().editCell'), { row: 0, col: 1 }, 'Tab -> next cell');
  await type('Age'); await tab(); await type('City');
  await tab(); assert.deepEqual(await evaluate('store.getState().editCell'), { row: 1, col: 0 }, 'Tab wraps to the next row');
  await tab(true); assert.deepEqual(await evaluate('store.getState().editCell'), { row: 0, col: 2 }, 'Shift+Tab -> previous cell');
  await tab(true); assert.deepEqual(await evaluate('store.getState().editCell'), { row: 0, col: 1 });
  await tab(true); await tab(true);
  assert.deepEqual(await evaluate('store.getState().editCell'), { row: 0, col: 0 }, 'Shift+Tab on the first cell stays');
  t = await T(); assert.deepEqual([cellText(t, 0, 0), cellText(t, 0, 1), cellText(t, 0, 2)], ['Name', 'Age', 'City']);
  // Enter = new paragraph inside the cell (Tab selected the cell's text, like a spreadsheet; move the caret to the end first)
  await evaluate("active().commands.focus('end')");
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await pause(250);
  await type('second line');
  t = await T(); assert.equal(cellText(t, 0, 0), 'Name\nsecond line', 'Enter inserts a paragraph in the cell');
  assert.deepEqual(await evaluate('store.getState().editCell'), { row: 0, col: 0 }, 'Enter does not leave the cell');
  await domMatches(t);
  // Tab on the last cell appends a row
  await evaluate(`store.getState().startCellEditing('${t.id}', 2, 2, 'end')`); await pause(250);
  await tab();
  t = await T(); assert.equal(t.rows.length, 4, 'Tab on the last cell appends a row');
  assert.deepEqual(await evaluate('store.getState().editCell'), { row: 3, col: 0 }, 'and moves into it');
  assert.deepEqual(await problems(t), []); await domMatches(t);
  await esc();
  console.log('PASS cell editing, Tab / Shift+Tab / Enter, Tab on last cell appends a row');

  // ---- rich text in a cell ----
  await clickCell(t, 1, 1); await evaluate('active().commands.selectAll()');
  await type('rich'); await evaluate('active().chain().focus().selectAll().toggleBold().run()'); await pause(200);
  t = await T(); assert.ok(JSON.stringify(t.rows[1][1].doc).includes('"bold"'), 'bold works in a cell');
  await evaluate('active().chain().focus().selectAll().run()');
  assert.equal(await evaluate("typeof active().commands.toggleBulletList"), 'undefined', 'no lists in cells'); 
  assert.equal(await evaluate("typeof active().commands.insertMath"), 'undefined', 'no inline math in cells');
  await esc();

  // ---- undo / redo of cell edits ----
  await clickCell(t, 2, 0);
  const hEdit = await history();
  await type('undo me'); await esc();
  assert.equal(await history(), hEdit + 1, 'a cell edit session is one undo step');
  await evaluate('store.getState().undo()'); await pause(250);
  t = await T(); assert.equal(cellText(t, 2, 0), '', 'undo reverts the cell edit');
  await evaluate('store.getState().redo()'); await pause(250);
  t = await T(); assert.equal(cellText(t, 2, 0), 'undo me', 'redo restores it');
  await evaluate('store.getState().select([])'); await pause(300);
  await writeFile(path.join(output, 'table.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64')); // for a manual look
  console.log('PASS rich text limits and cell-edit undo/redo');

  // ---- row / column operations (selected, not editing) ----
  await evaluate('store.getState().select([])'); await evaluate(`store.getState().select(['${t.id}'])`); await pause(250);
  const snap = async () => JSON.stringify(await T());
  const s0 = await snap(); const o0 = JSON.stringify(await others());
  await clickOp('+ 행'); t = await T(); assert.equal(t.rows.length, 5, 'row appended at the end'); await domMatches(t);
  await evaluate('store.getState().undo()'); await pause(250); assert.equal(await snap(), s0, 'undo restores the exact table');
  await evaluate('store.getState().redo()'); await pause(250); assert.equal((await T()).rows.length, 5);
  await clickOp('− 행'); t = await T(); assert.equal(t.rows.length, 4); await domMatches(t);
  await clickOp('+ 열'); t = await T(); assert.equal(t.cols.length, 4); assert.equal(t.w, 768 + 256, 'a column adds its width'); assert.ok(t.rows.every((r) => r.length === 4)); assert.deepEqual(await problems(t), []); await domMatches(t);
  assert.ok(t.x + t.w <= 1280, 'the table stays on the slide');
  await evaluate('store.getState().undo()'); await pause(250); t = await T(); assert.equal(t.cols.length, 3); assert.equal(t.w, 768);
  await evaluate('store.getState().redo()'); await pause(250);
  await clickOp('− 열'); t = await T(); assert.equal(t.cols.length, 3); assert.deepEqual(await problems(t), []); await domMatches(t);
  assert.equal(JSON.stringify(await others()), o0, 'row/column operations never touch other elements');
  // cannot delete the last row / column
  await evaluate(`store.getState().editTable('${t.id}', (d) => { d.rows = [d.rows[0]]; d.cols = [d.cols[0]]; d.rows[0] = [d.rows[0][0]]; d.w = d.cols[0]; })`); await pause(300);
  t = await T(); assert.equal(await evaluate(`${opButton('− 행')}.disabled`), true); assert.equal(await evaluate(`${opButton('− 열')}.disabled`), true);
  await evaluate('store.getState().undo()'); await pause(250);
  // while editing: the new row is inserted below the current cell, editing continues there, and it is its own undo step
  t = await T(); await clickCell(t, 1, 1);
  const rowsBefore = t.rows.length; await type('X');
  await clickOp('+ 행'); t = await T();
  assert.equal(t.rows.length, rowsBefore + 1); assert.deepEqual(await evaluate('store.getState().editCell'), { row: 2, col: 1 }, 'editing continues in the new row');
  assert.equal(await evaluate('store.getState().editingId'), t.id);
  await type('Y'); await esc(); t = await T(); assert.equal(cellText(t, 2, 1), 'Y'); assert.equal(cellText(t, 1, 1), 'richX');
  await evaluate('store.getState().undo()'); await pause(250); t = await T(); assert.equal(cellText(t, 2, 1), '', 'first undo reverts the typing in the new row'); assert.equal(t.rows.length, rowsBefore + 1);
  await evaluate('store.getState().undo()'); await pause(250); t = await T(); assert.equal(t.rows.length, rowsBefore, 'second undo removes the row');
  assert.equal(cellText(t, 1, 1), 'richX');
  console.log('PASS row / column operations (selected and while editing), undo/redo, other elements untouched');

  // ======== Phase 2A ========
  // The page-to-slide scale: how many CSS px one slide px occupies.
  const scaleOf = async (t) => (await evaluate(`document.querySelector(${JSON.stringify(sel(t))}).getBoundingClientRect().width`)) / t.w;
  const dragFrom = async (selector, dx, dy = 0) => { const p = await center(selector); await drag(p, dx, dy); };
  const ratios = (c) => c.map((x) => x / c.reduce((a, b) => a + b, 0));
  await evaluate('store.getState().stopEditing(); store.getState().select([])'); await pause(250);
  t = await T(); await evaluate(`store.getState().updateElements(['${t.id}'], (d) => { d.y = 90 }, true)`); await pause(250); // high on the slide so grown tables stay on screen
  t = await T(); await evaluate(`store.getState().select(['${t.id}'])`); await pause(300);
  const othersBefore = JSON.stringify(await others());

  // ---- whole-table resize (edge handles, proportional columns) ----
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.overlay .handle')].map((h) => h.className.replace('handle ', '')).sort()"), ['h-e', 'h-w'], 'table has width handles only (no vertical resizing)');
  await clickOp('+ 열'); await evaluate(`store.getState().editTable('${t.id}', (d) => { d.cols = [150, 300, 100, 218]; d.w = 768; })`); await pause(300); // uneven columns, to see the ratios
  t = await T(); assert.equal(t.w, t.cols.reduce((a, b) => a + b, 0)); await evaluate(`store.getState().select(['${t.id}'])`); await pause(250);
  let k = await scaleOf(t);
  const widthSnap = JSON.stringify(t), h1 = await history();
  await dragFrom(`.overlay .handle.h-e`, 120 * k);
  let t3 = await T();
  assert.ok(t3.w > t.w + 100 && t3.w < t.w + 140, `east handle widens the table (${t.w} -> ${t3.w})`);
  assert.equal(t3.x, t.x, 'east handle keeps the left edge'); assert.equal(t3.y, t.y);
  assert.deepEqual(await problems(t3), [], 'widths still sum to the width');
  ratios(t.cols).forEach((r, i) => assert.ok(Math.abs(r - ratios(t3.cols)[i]) < 0.01, 'column ratio kept'));
  await domMatches(t3);
  assert.equal(await history(), h1 + 1, 'one undo step per resize gesture');
  assert.equal(JSON.stringify(await others()), othersBefore, 'other elements untouched');
  await evaluate('store.getState().undo()'); await pause(250); assert.equal(JSON.stringify(await T()), widthSnap, 'undo restores the exact table');
  await evaluate('store.getState().redo()'); await pause(250); assert.equal((await T()).w, t3.w, 'redo');
  await evaluate('store.getState().undo()'); await pause(250);
  t = await T(); k = await scaleOf(t);
  const rightEdge = t.x + t.w;
  await dragFrom(`.overlay .handle.h-w`, 80 * k);
  t3 = await T();
  assert.ok(t3.x > t.x + 60 && t3.w < t.w - 60, 'west handle moves the left edge'); assert.ok(Math.abs(t3.x + t3.w - rightEdge) <= 1, 'and keeps the right edge');
  assert.deepEqual(await problems(t3), []); await domMatches(t3);
  await evaluate('store.getState().undo()'); await pause(250); t = await T(); assert.equal(JSON.stringify(t), widthSnap);
  // minimum width: every column keeps >= 40
  k = await scaleOf(t); await dragFrom(`.overlay .handle.h-e`, -3000 * k);
  t3 = await T(); assert.equal(t3.w, t.cols.length * 40, 'minimum table width = columns x 40'); assert.ok(t3.cols.every((c) => c === 40)); assert.deepEqual(await problems(t3), []); await domMatches(t3);
  await evaluate('store.getState().undo()'); await pause(250);
  // wrapping changes the height: narrow tables get taller (content-driven rows)
  await evaluate(`store.getState().startCellEditing('${t.id}', 0, 0, 'end')`); await pause(250); await type(' a fairly long header that must wrap when narrow'); await esc();
  t = await T(); const tallBefore = t.h; k = await scaleOf(t);
  await dragFrom(`.overlay .handle.h-e`, -330 * k); t3 = await T();
  assert.ok(t3.h > tallBefore, `height follows wrapping (${tallBefore} -> ${t3.h})`); await domMatches(t3);
  await evaluate('store.getState().undo()'); await pause(250);
  console.log('PASS whole-table resize: handles, proportional columns, minimum, wrapping height, one undo step');

  // ---- column boundary drag ----
  t = await T(); await evaluate(`store.getState().select(['${t.id}'])`); await pause(300);
  const grips = await evaluate("document.querySelectorAll('.col-resizer:not(.edge-right)').length"); assert.equal(grips, t.cols.length - 1, 'one grip per inner boundary (the outer edge has its own strips)');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.col-resizer')).cursor"), 'col-resize', 'resize cursor');
  k = await scaleOf(t); const c0 = t.cols.slice(), h2 = await history(), snapBefore = JSON.stringify(t);
  await dragFrom(`.col-resizer[data-col="0"]`, 40 * k);
  t3 = await T();
  assert.ok(t3.cols[0] > c0[0] + 25 && t3.cols[0] < c0[0] + 55, 'left column grows'); assert.equal(t3.cols[0] + t3.cols[1], c0[0] + c0[1], 'its neighbour shrinks by the same amount');
  assert.deepEqual(t3.cols.slice(2), c0.slice(2), 'other columns untouched'); assert.equal(t3.w, t.w, 'total width constant'); assert.deepEqual(await problems(t3), []); await domMatches(t3);
  assert.equal(await history(), h2 + 1, 'one undo step'); assert.equal(await evaluate('store.getState().editingId'), null);
  await evaluate('store.getState().undo()'); await pause(250); assert.equal(JSON.stringify(await T()), snapBefore, 'undo'); await evaluate('store.getState().redo()'); await pause(250); assert.deepEqual((await T()).cols, t3.cols, 'redo');
  await evaluate('store.getState().undo()'); await pause(250);
  await dragFrom(`.col-resizer[data-col="1"]`, 4000 * k); t3 = await T();
  assert.equal(t3.cols[2], 40, 'right neighbour stops at the 40px minimum'); assert.equal(t3.w, t.w); assert.deepEqual(t3.cols.slice(3), c0.slice(3));
  await evaluate('store.getState().undo()'); await pause(250);
  await dragFrom(`.col-resizer[data-col="1"]`, -4000 * k); t3 = await T(); assert.equal(t3.cols[1], 40, 'left column stops at the minimum'); assert.equal(t3.w, t.w);
  await evaluate('store.getState().undo()'); await pause(250);
  // a drag that starts on a grip while editing leaves edit mode and never selects text
  await clickCell(t, 1, 0); assert.equal(await evaluate('store.getState().editingId'), t.id);
  await dragFrom(`.col-resizer[data-col="0"]`, 30 * k); t3 = await T();
  assert.notDeepEqual(t3.cols, c0, 'grip works while a cell is being edited'); assert.deepEqual(await problems(t3), []);
  await evaluate('store.getState().undo()'); await pause(250); await evaluate('store.getState().stopEditing()');
  assert.equal(JSON.stringify(await T()), snapBefore, 'restored');
  console.log('PASS column boundary drag: adjacent columns only, constant width, 40px minimum, cursor, undo/redo');

  // ======== outer right edge, blue column guides ========
  t = await T(); await evaluate(`store.getState().stopEditing(); store.getState().select(['${t.id}'])`); await pause(300);
  k = await scaleOf(t); const nCols = t.cols.length;
  const guides = () => evaluate(`[...document.querySelectorAll('.col-guide')].map((g) => { const cs = getComputedStyle(g); const r = g.getBoundingClientRect(); return {col: +g.dataset.col, cls: g.className, style: cs.borderLeftStyle, color: cs.borderLeftColor, vis: cs.visibility, w: parseFloat(cs.borderLeftWidth), pe: cs.pointerEvents, x: r.x + r.width / 2, y: r.y, h: r.height}; })`);
  const tableRect = () => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel(t))}); const r = e.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height, tds: [...e.querySelectorAll('td')].map((d) => { const q = d.getBoundingClientRect(); return [q.x, q.y, q.width, q.height].map(Math.round).join(); }).join('|')}; })()`);
  const layoutSelected = await tableRect();

  // guides while selected: thin, dashed, blue, pointer-less, one per inner boundary, spanning the table height
  let g = await guides();
  assert.equal(g.length, nCols, 'one guide per boundary (the outer one is hidden until hovered)');
  const inner = g.filter((x) => !x.cls.includes('edge'));
  assert.equal(inner.length, nCols - 1);
  inner.forEach((x, i) => {
    assert.equal(x.style, 'dashed', 'lightly dashed'); assert.match(x.color, /^rgba\(47, 111, 235, 0\.\d+\)$/, 'selection blue, subtle'); assert.ok(x.w < 2, 'thin'); assert.equal(x.vis, 'visible'); assert.equal(x.pe, 'none', 'never blocks cell editing or selection');
    const at = layoutSelected.x + t.cols.slice(0, i + 1).reduce((a, b) => a + b, 0) * k; assert.ok(Math.abs(x.x - at) <= 2, `guide ${i} sits on the column boundary`);
    assert.ok(Math.abs(x.y - layoutSelected.y) <= 2 && Math.abs(x.h - layoutSelected.h) <= 2, 'spans the table height');
  });
  assert.equal(g.find((x) => x.cls.includes('edge')).vis, 'hidden', 'outer edge guide only shows on hover / drag');
  await writeFile(path.join(output, 'table-guides.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64')); // for a manual look
  // guides never change the layout
  await evaluate('store.getState().select([])'); await pause(300);
  assert.equal(await evaluate("document.querySelectorAll('.col-guide, .col-resizer, .table-add').length"), 0, 'no guides, grips or controls when the table is not selected');
  assert.equal(JSON.stringify(await tableRect()), JSON.stringify(layoutSelected), 'selecting / deselecting does not move or resize anything');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('${td(t, 1, 1)}')).borderLeftWidth`), '0px', 'no vertical borders in the table itself, selected or not');
  assert.deepEqual(Object.keys(await T()).sort(), ['cols', 'h', 'headerRow', 'id', 'rows', 'style', 'textStyle', 'type', 'w', 'x', 'y'], 'guides are not stored in the model');
  await evaluate(`store.getState().select(['${t.id}'])`); await pause(300);

  // hover: only the hovered boundary is highlighted
  const gripC = await center('.col-resizer[data-col="1"]');
  await hover({ x: gripC.x, y: gripC.y }); await pause(250);
  g = await guides(); assert.deepEqual(g.filter((x) => x.cls.includes('hot')).map((x) => x.col), [1], 'only the hovered boundary is hot');
  await writeFile(path.join(output, 'table-guides-hover.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  const hot = g.find((x) => x.col === 1); assert.equal(hot.style, 'solid', 'stronger solid line'); assert.ok(hot.w > inner[1].w, 'and thicker'); assert.match(hot.color, /^rgba\(47, 111, 235, 0\.[6-9]/);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.col-resizer[data-col=\"1\"]')).cursor"), 'col-resize');
  await hover({ x: gripC.x + 200 * k, y: gripC.y - 120 * k }); await pause(250);
  assert.equal((await guides()).filter((x) => x.cls.includes('hot')).length, 0, 'hover highlight goes away');

  // dragging an inner boundary: solid, strongest blue, and no other guide is highlighted
  const hD = await history(); const colsBefore = (await T()).cols;
  await mouse('mousePressed', gripC); for (const f of [0.3, 0.6]) await mouse('mouseMoved', { x: gripC.x + 30 * k * f, y: gripC.y });
  g = await guides(); const act = g.filter((x) => x.cls.includes('active'));
  assert.deepEqual(act.map((x) => x.col), [1], 'the dragged boundary is active'); assert.equal(act[0].style, 'solid'); assert.equal(act[0].color, 'rgb(47, 111, 235)', 'full blue while dragging'); assert.ok(act[0].w >= hot.w);
  assert.equal(g.filter((x) => x.cls.includes('hot')).length, 0, 'only one boundary highlighted at a time');
  await mouse('mouseReleased', { x: gripC.x + 18 * k, y: gripC.y }); await pause(300);
  assert.equal((await guides()).filter((x) => x.cls.includes('active') || x.cls.includes('hot')).length <= 1, true); assert.equal((await guides()).filter((x) => x.cls.includes('active')).length, 0, 'active state ends with the drag');
  assert.equal(await history(), hD + 1, 'one undo step'); await evaluate('store.getState().undo()'); await pause(250); assert.deepEqual((await T()).cols, colsBefore);

  // ---- outer right edge vs the blue whole-table handle ----
  t = await T(); k = await scaleOf(t);
  const handleC = await center('.overlay .handle.h-e');
  const topAt = (x, y) => evaluate(`(() => { const e = document.elementFromPoint(${x}, ${y}); return e ? { cls: e.className, col: e.dataset.col } : null; })()`);
  assert.match((await topAt(handleC.x, handleC.y)).cls, /handle/, 'the blue handle owns its own square');
  const aboveY = handleC.y - 18, belowY = handleC.y + 18;
  for (const y of [aboveY, belowY]) { const hit = await topAt(handleC.x, y); assert.match(hit.cls, /col-resizer/); assert.match(hit.cls, /edge-right/); assert.equal(Number(hit.col), nCols - 1, 'the edge strip above / below the handle resizes the last column'); }
  const bandHit = await topAt(handleC.x, handleC.y - 7); assert.doesNotMatch(bandHit.cls, /col-resizer/, 'the band right next to the handle is not a column grip (no overlap)');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.col-resizer.edge-right')).cursor"), 'col-resize');
  assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.overlay .handle.h-e')).cursor"), 'col-resize', 'the whole-table handle keeps its own cursor');
  assert.equal(await evaluate("document.querySelectorAll('.col-resizer.edge-right').length"), 2, 'two edge strips, split around the handle');
  assert.equal(await evaluate("document.querySelectorAll('.col-resizer:not(.edge-right)').length"), nCols - 1, 'inner grips unchanged');
  // the "+" column control does not overlap the edge strips
  const plusR = await evaluate("(() => { const r = document.querySelector('.table-add[aria-label=\"Add column\"]').getBoundingClientRect(); const e = document.querySelector('.col-resizer.edge-right').getBoundingClientRect(); return [r.left, e.right]; })()"); assert.ok(plusR[0] >= plusR[1] - 0.5, '+ control sits outside the edge strip');

  // hover / drag feedback on the outer edge
  await hover({ x: handleC.x, y: aboveY }); await pause(250);
  g = await guides(); const edgeG = g.find((x) => x.cls.includes('edge')); assert.ok(edgeG.cls.includes('hot')); assert.equal(edgeG.vis, 'visible'); assert.equal(edgeG.style, 'solid'); assert.deepEqual(g.filter((x) => x.cls.includes('hot')).map((x) => x.col), [nCols - 1]);
  const tr0 = await T(); const h4 = await history(); const widthsOld = tr0.cols.slice();
  await mouse('mousePressed', { x: handleC.x, y: aboveY }); await mouse('mouseMoved', { x: handleC.x + 20 * k, y: aboveY }); await mouse('mouseMoved', { x: handleC.x + 50 * k, y: aboveY });
  g = await guides(); assert.ok(g.find((x) => x.cls.includes('edge')).cls.includes('active'), 'the outer edge shows the active drag state'); assert.equal(g.find((x) => x.cls.includes('edge')).color, 'rgb(47, 111, 235)');
  await mouse('mouseReleased', { x: handleC.x + 50 * k, y: aboveY }); await pause(350);
  let t5 = await T();
  assert.deepEqual(t5.cols.slice(0, -1), widthsOld.slice(0, -1), 'other column widths unchanged');
  assert.ok(t5.cols[nCols - 1] > widthsOld[nCols - 1] + 35 && t5.cols[nCols - 1] < widthsOld[nCols - 1] + 65, 'only the last column grew');
  assert.equal(t5.w, tr0.w + (t5.cols[nCols - 1] - widthsOld[nCols - 1]), 'table width follows'); assert.equal(t5.w, t5.cols.reduce((a, b) => a + b, 0), 'sum(cols) === w'); assert.equal(t5.x, tr0.x, 'left edge fixed'); assert.equal(t5.y, tr0.y);
  assert.deepEqual(await problems(t5), []); await domMatches(t5); assert.equal(JSON.stringify(await others()), othersBefore, 'other elements untouched');
  assert.equal(await history(), h4 + 1, 'exactly one undo step');
  await evaluate('store.getState().undo()'); await pause(250); assert.equal(JSON.stringify(await T()), JSON.stringify(tr0), 'undo restores the widths exactly');
  await evaluate('store.getState().redo()'); await pause(250); assert.deepEqual((await T()).cols, t5.cols, 'redo re-applies them');
  await evaluate('store.getState().undo()'); await pause(250);
  // minimum width and the slide's right boundary
  t = await T(); k = await scaleOf(t); let hc = await center('.overlay .handle.h-e'); const edgeY = hc.y - 18;
  await drag({ x: hc.x, y: edgeY }, -3000 * k); t5 = await T();
  assert.equal(t5.cols[nCols - 1], 40, 'last column stops at 40px'); assert.deepEqual(t5.cols.slice(0, -1), t.cols.slice(0, -1)); assert.equal(t5.w, t5.cols.reduce((a, b) => a + b, 0)); assert.equal(t5.x, t.x); await domMatches(t5);
  await evaluate('store.getState().undo()'); await pause(250);
  await evaluate(`store.getState().updateElements(['${t.id}'], (d) => { d.x = 1280 - d.w - 24 }, true)`); await pause(300);
  t = await T(); k = await scaleOf(t); hc = await center('.overlay .handle.h-e');
  await drag({ x: hc.x, y: hc.y - 18 }, 400 * k); t5 = await T();
  assert.equal(t5.x + t5.w, 1280, 'the right edge stops at the slide boundary'); assert.equal(t5.cols[nCols - 1], t.cols[nCols - 1] + 24); assert.deepEqual(t5.cols.slice(0, -1), t.cols.slice(0, -1)); assert.deepEqual(await problems(t5), []);
  await evaluate('store.getState().undo()'); await pause(250);
  t = await T(); await evaluate(`store.getState().updateElements(['${t.id}'], (d) => { d.x = 256 }, true)`); await pause(300);
  // the blue handle still scales ALL columns proportionally
  t = await T(); k = await scaleOf(t); hc = await center('.overlay .handle.h-e'); const ratioBefore = ratios(t.cols), h5 = await history();
  await drag(hc, 100 * k); t5 = await T();
  assert.ok(t5.w > t.w + 80, 'whole-table handle widens the table'); ratios(t5.cols).forEach((r, i) => assert.ok(Math.abs(r - ratioBefore[i]) < 0.01, 'every column scaled in proportion')); assert.equal(t5.x, t.x); assert.equal(await history(), h5 + 1);
  await evaluate('store.getState().undo()'); await pause(250); assert.equal(JSON.stringify(await T()), JSON.stringify(t));
  // moving and editing near the edge still work
  const mv = await center(td(t, 1, 0)); await drag(mv, 40 * k, 20 * k); const moved = await T(); assert.ok(moved.x > t.x + 20, 'a table can still be moved'); await evaluate('store.getState().undo()'); await pause(250);
  await clickCell(await T(), 1, nCols - 1); assert.equal(await evaluate('store.getState().editingId'), t.id, 'cells next to the edge can still be edited'); await evaluate('store.getState().stopEditing()');

  // ---- editor-only: static renderers never show guides, grips or controls ----
  assert.equal(await evaluate("document.querySelectorAll('.thumb-inner .col-guide, .thumb-inner .col-resizer, .thumb-inner .table-add').length"), 0, 'thumbnails');
  assert.ok(await evaluate("document.querySelectorAll('.thumb-inner .ms-table').length >= 1"), 'the thumbnail does render the table');
  await evaluate('store.setState({presenting: true})'); await pause(500);
  assert.equal(await evaluate("document.querySelectorAll('.presenter .col-guide, .presenter .col-resizer, .presenter .table-add, .presenter .overlay').length"), 0, 'presenter');
  assert.ok(await evaluate("document.querySelectorAll('.presenter .ms-table').length >= 1")); await evaluate('store.setState({presenting: false})'); await pause(300);
  await evaluate(`store.getState().select(['${t.id}'])`); await pause(200);
  await evaluate("store.setState({exportMode: 'print'})"); await pause(400);
  assert.ok(await evaluate("document.querySelectorAll('#print-root .ms-table').length >= 1"), 'the print / PDF root renders the table');
  assert.equal(await evaluate("document.querySelectorAll('#print-root .col-guide, #print-root .col-resizer, #print-root .table-add, #print-root .overlay').length"), 0, 'PDF / print');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#print-root .ms-table td')).borderLeftWidth"), '0px');
  await evaluate("store.setState({exportMode: null})"); await pause(300);
  console.log('PASS outer-edge column resize, blue guides (selected / hover / drag), handle vs grip hit targets, editor-only overlays');

  // ---- "+" controls at the right and bottom edge ----
  t = await T(); await evaluate(`store.getState().stopEditing(); store.getState().select(['${t.id}'])`); await pause(300);
  assert.equal(await evaluate("document.querySelectorAll('.table-add').length"), 2, 'two edge controls while the table is selected');
  await writeFile(path.join(output, 'table-selected.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64')); // for a manual look
  const pos0 = { x: t.x, y: t.y }, h3 = await history();
  await evaluate("document.querySelector('.table-add[aria-label=\"Add row\"]').click()"); await pause(350);
  t3 = await T(); assert.equal(t3.rows.length, t.rows.length + 1, '+ below the table adds a row'); assert.deepEqual({ x: t3.x, y: t3.y }, pos0, 'the table did not move'); assert.equal(await history(), h3 + 1);
  await evaluate("document.querySelector('.table-add[aria-label=\"Add column\"]').click()"); await pause(350);
  const t4 = await T(); assert.equal(t4.cols.length, t.cols.length + 1, '+ at the right edge adds a column'); assert.deepEqual(await problems(t4), []); await domMatches(t4);
  assert.deepEqual({ x: t4.x, y: t4.y }, pos0); assert.equal(await history(), h3 + 2);
  assert.equal(JSON.stringify(await others()), othersBefore, 'other elements untouched');
  await evaluate('store.getState().undo()'); await evaluate('store.getState().undo()'); await pause(300); assert.equal(JSON.stringify(await T()), snapBefore, 'undo x2 restores the table');
  await evaluate('store.getState().redo()'); await evaluate('store.getState().redo()'); await pause(300); assert.equal((await T()).cols.length, t.cols.length + 1, 'redo x2');
  await evaluate('store.getState().undo()'); await evaluate('store.getState().undo()'); await pause(300);
  // pressing a "+" must not start a move
  const bp = await center('.table-add[aria-label="Add row"]'); const hm = await history();
  await mouse('mousePressed', bp); await mouse('mouseMoved', { x: bp.x + 60, y: bp.y + 30 }); await mouse('mouseReleased', { x: bp.x + 60, y: bp.y + 30 }); await pause(300);
  assert.deepEqual({ x: (await T()).x, y: (await T()).y }, pos0, 'dragging from a + control does not move the table'); assert.equal(await history(), hm);
  // while editing: the + controls append at the end and keep the caret in the same cell
  await clickCell(t, 0, 1); const cellBefore = await evaluate('store.getState().editCell');
  await evaluate("document.querySelector('.table-add[aria-label=\"Add row\"]').click()"); await pause(350);
  assert.equal((await T()).rows.length, t.rows.length + 1); assert.equal(await evaluate('store.getState().editingId'), t.id, 'still editing'); assert.deepEqual(await evaluate('store.getState().editCell'), cellBefore, 'in the same cell');
  const hEnd = await history(); await evaluate('store.getState().stopEditing()'); assert.equal(await history(), hEnd, 'leaving edit mode without typing adds no undo step'); await evaluate('store.getState().undo()'); await pause(300); assert.equal(JSON.stringify(await T()), snapBefore, 'one undo removes the added row');
  console.log('PASS edge "+" controls: add row / column, no movement, undo/redo, works while editing; Properties Bar buttons kept');

  // ---- spreadsheet paste ----
  const pasteIntoCell = (text) => evaluate(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)}); const e = new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}); active().view.dom.dispatchEvent(e); return e.defaultPrevented; })()`).then((v) => pause(400).then(() => v));
  const text2 = (tt, r, c) => cellText(tt, r, c);
  t = await T(); const restoreSnap = JSON.stringify(t);
  await evaluate(`store.getState().select(['${t.id}'])`); await pause(300); await clickCell(t, 1, 1);
  const hp = await history();
  assert.equal(await pasteIntoCell('a\tb\tc\r\n1\t2\t3\r\n'), true, 'grid paste handled');
  t3 = await T();
  assert.equal(await history(), hp + 1, 'a multi-cell paste is ONE undo step');
  assert.deepEqual([text2(t3, 1, 1), text2(t3, 1, 2), text2(t3, 1, 3), text2(t3, 2, 1), text2(t3, 2, 2), text2(t3, 2, 3)], ['a', 'b', 'c', '1', '2', '3'], 'values land from the edited cell');
  assert.equal(t3.cols.length, Math.max(t.cols.length, 4), 'columns expanded when needed'); assert.ok(t3.rows.length >= 3);
  assert.deepEqual(await problems(t3), [], 'rectangular, widths consistent'); await domMatches(t3);
  assert.equal(text2(t3, 0, 0), text2(t, 0, 0), 'cells outside the pasted block keep their text');
  assert.equal(await evaluate('store.getState().editingId'), null, 'editing ends after a grid paste'); assert.deepEqual(await evaluate('store.getState().selection'), [t.id]);
  await evaluate('store.getState().undo()'); await pause(300); assert.equal(JSON.stringify(await T()), restoreSnap, 'one undo restores the table exactly');
  await evaluate('store.getState().redo()'); await pause(300); assert.equal(text2(await T(), 2, 3), '3', 'redo');
  await evaluate('store.getState().undo()'); await pause(300);
  // expansion of rows from the last row
  await clickCell(t, t.rows.length - 1, 0);
  await pasteIntoCell('r1\nr2\nr3\nr4\n'); t3 = await T();
  assert.equal(t3.rows.length, t.rows.length + 3, 'rows appended as needed'); assert.equal(text2(t3, t.rows.length + 2, 0), 'r4'); assert.deepEqual(await problems(t3), []); await domMatches(t3);
  await evaluate('store.getState().undo()'); await pause(300);
  // quoted cells with tabs, newlines and quotes
  t = await T(); await clickCell(t, 1, 0);
  await pasteIntoCell('"x\ty"\t"line1\nline2"\t"he said ""hi"""\n'); t3 = await T();
  assert.equal(text2(t3, 1, 0), 'x\ty'); assert.equal(text2(t3, 1, 1), 'line1\nline2'); assert.equal(t3.rows[1][1].doc.content.length, 2, 'embedded newline = two paragraphs'); assert.equal(text2(t3, 1, 2), 'he said "hi"');
  await evaluate('store.getState().undo()'); await pause(300);
  // single-cell paste behaves like ordinary text editing
  t = await T(); await clickCell(t, 2, 0); await evaluate("active().commands.focus('end')");
  const hs = await history(); await pasteIntoCell('plain words'); await pasteIntoCell('tail\r\n');
  t3 = await T(); assert.equal(await evaluate('store.getState().editingId'), t.id, 'still editing after a single-cell paste'); assert.equal(t3.rows.length, t.rows.length); assert.equal(t3.cols.length, t.cols.length, 'table shape unchanged');
  assert.ok(text2(t3, 2, 0).endsWith('plain wordstail') && !text2(t3, 2, 0).endsWith('\n'), 'inserted as text; a spreadsheet trailing newline adds no paragraph');
  assert.equal(t3.rows[2][0].doc.content.length, t.rows[2][0].doc.content.length, 'no new paragraph');
  await esc(); await evaluate('store.getState().undo()'); await pause(300); assert.equal(JSON.stringify(await T()), restoreSnap);
  console.log('PASS spreadsheet paste: grid from the edited cell, auto-expansion, quoted cells, one undo step, single-cell paste unchanged');

  // ---- canvas / text box paste is unchanged ----
  await evaluate('store.getState().stopEditing(); store.getState().select([])'); await pause(250);
  const tbBefore = (await cur()).filter((e) => e.type === 'text').length, tblSnap = JSON.stringify(await T());
  await evaluate(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify('p\tq\nr\ts')}); document.body.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})); })()`); await pause(400);
  const texts = (await cur()).filter((e) => e.type === 'text'); assert.equal(texts.length, tbBefore + 1, 'tabbed text pasted on the canvas still becomes a plain text box');
  assert.equal(JSON.stringify(await T()), tblSnap, 'and does not touch the table');
  await evaluate('store.getState().undo()'); await pause(300);
  await evaluate('insert.insertTextCenter()'); await until(() => evaluate('!!active()'), 'text editor');
  await pasteIntoCell('a\tb\nc\td'); assert.equal((await tables()).length, 1, 'tabs pasted inside a text box do not create a table');
  await esc(); await evaluate('store.getState().select([])'); await evaluate('store.getState().undo()'); await pause(300);
  console.log('PASS canvas and text-box paste behaviour unchanged');

  // ======== Phase 2B: styles, header toggle, fills, border color, deck font ========
  await evaluate('store.getState().stopEditing(); store.getState().select([])'); await pause(250);
  t = await T(); await evaluate(`store.getState().select(['${t.id}'])`); await pause(300);
  const css2 = (selector, prop) => evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(prop)}]`);
  const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };
  const clear = 'rgba(0, 0, 0, 0)';
  const barBtn = (re) => `[...document.querySelectorAll('.propsbar button')].find((b) => ${re}.test(b.textContent.trim()))`;
  const chooseStyle = async (name) => { await evaluate(`${barBtn('/^(Minimal|Grid|Header) ▾$/')}.click()`); await pause(250); await evaluate(`[...document.querySelectorAll('.pop .menu-item')].find((e) => e.textContent.replace('✓ ', '').trim() === ${JSON.stringify(name)}).click()`); await pause(350); };
  const toggleHeader = async () => { await evaluate(`${barBtn('/^헤더$/')}.click()`); await pause(350); };
  const swatchHex = (label) => evaluate(`document.querySelector('button[aria-label="${label}"]').title.match(/#[0-9A-Fa-f]{6}/)[0]`).then((h) => h.toUpperCase());
  const pickColor = async (buttonTitle, label) => { await evaluate(`document.querySelector('.propsbar button[title^="${buttonTitle}"]').click()`); await pause(300); const hex = await swatchHex(label); await evaluate(`document.querySelector('button[aria-label="${label}"]').click()`); await pause(400); return hex; };
  const pickDefault = async (buttonTitle) => { await evaluate(`document.querySelector('.propsbar button[title^="${buttonTitle}"]').click()`); await pause(300); await evaluate("[...document.querySelectorAll('.text-palette button')].find((b) => b.textContent.includes('기본')).click()"); await pause(400); };
  const fills = (tt) => tt.rows.map((r) => r.map((c) => c.fill ?? null));
  const hasNoFillKeys = (tt) => tt.rows.flat().every((c) => !('fill' in c));

  // -- defaults: Minimal is unchanged, old-style tables carry no new fields --
  assert.equal(t.style, 'minimal'); assert.ok(!('borderColor' in t), 'no borderColor by default'); assert.ok(hasNoFillKeys(t), 'no cell fill keys by default');
  assert.equal(await css2(td(t, 1, 0), 'borderBottomWidth'), '1px'); assert.equal(await css2(td(t, 1, 0), 'borderBottomColor'), rgb('#E5E7EB')); assert.equal(await css2(td(t, 1, 0), 'borderLeftWidth'), '0px');
  assert.equal(await css2(td(t, 0, 0), 'borderBottomWidth'), '1.5px'); assert.equal(await css2(td(t, 0, 0), 'borderBottomColor'), rgb('#9CA3AF')); assert.equal(await css2(td(t, 0, 0), 'backgroundColor'), clear, 'no header fill in Minimal'); assert.equal(await css2(td(t, 0, 0), 'fontWeight'), '700');
  assert.equal(await evaluate(`${barBtn('/^Minimal ▾$/')} ? 1 : 0`), 1, 'style control shows the current style');

  // -- style switching: one undo step, nothing else changes --
  const snap0 = JSON.stringify(t), hs0 = await history();
  await chooseStyle('Grid'); let tg = await T();
  assert.equal(tg.style, 'grid'); assert.equal(await history(), hs0 + 1, 'one undo step per style change'); assert.equal(JSON.stringify({ ...tg, style: 'minimal', h: t.h }), JSON.stringify({ ...t, h: t.h }), 'only the style field changed');
  for (const [r, c] of [[0, 0], [1, 1], [2, 2]]) for (const side of ['Left', 'Right', 'Top', 'Bottom']) { assert.equal(await css2(td(t, r, c), `border${side}Width`), '1px', `Grid: ${side} border`); assert.equal(await css2(td(t, r, c), `border${side}Color`), rgb('#D1D5DB')); }
  await evaluate('store.getState().undo()'); await pause(300); assert.equal(JSON.stringify(await T()), snap0, 'undo restores Minimal exactly'); assert.equal(await css2(td(t, 1, 1), 'borderLeftWidth'), '0px');
  await evaluate('store.getState().redo()'); await pause(300); assert.equal((await T()).style, 'grid', 'redo');
  await chooseStyle('Header'); tg = await T(); assert.equal(tg.style, 'header');
  assert.equal(await css2(td(t, 0, 1), 'backgroundColor'), rgb('#F3F4F6'), 'Header style: neutral light-gray header fill'); assert.equal(await css2(td(t, 0, 1), 'fontWeight'), '700'); assert.equal(await css2(td(t, 1, 1), 'backgroundColor'), clear, 'body cells stay unfilled'); assert.equal(await css2(td(t, 1, 1), 'borderLeftWidth'), '0px', 'Header style has no vertical lines');
  // -- header-row toggle --
  const hh = await history(); await toggleHeader(); tg = await T();
  assert.equal(tg.headerRow, false); assert.equal(await history(), hh + 1, 'one undo step'); assert.equal(await evaluate(`document.querySelectorAll('${sel(t)} tr.ms-head').length`), 0);
  assert.equal(await css2(td(t, 0, 1), 'backgroundColor'), clear, 'header off: no header fill'); assert.equal(await css2(td(t, 0, 1), 'fontWeight'), '400', 'header off: not bold'); assert.equal(await css2(td(t, 0, 1), 'borderBottomWidth'), '1px', 'an ordinary divider');
  await evaluate('store.getState().undo()'); await pause(300); assert.equal((await T()).headerRow, true); assert.equal(await css2(td(t, 0, 1), 'backgroundColor'), rgb('#F3F4F6'), 'undo restores the header');
  await evaluate('store.getState().redo()'); await pause(300); await toggleHeader(); assert.equal((await T()).headerRow, true);
  await chooseStyle('Minimal'); assert.equal(JSON.stringify(await T()), snap0.replace(/"h":\d+/, `"h":${(await T()).h}`), 'back to the exact starting table');

  // -- fills: whole table when only the table is selected (no editing, no cell) --
  await evaluate('store.getState().stopEditing()'); await evaluate(`store.getState().select([]); store.getState().select(['${t.id}'])`); await pause(300);
  assert.equal(await evaluate("document.querySelectorAll('.ms-active').length"), 0, 'no active cell');
  assert.ok(await evaluate("!!document.querySelector('.propsbar button[title^=\"표 전체 채우기\"]')"), 'control says it fills the whole table');
  const hf0 = await history(); const red = await pickColor('표 전체 채우기', 'Standard Red'); let tf = await T();
  assert.ok(tf.rows.flat().every((c) => c.fill?.toUpperCase() === red), 'every cell filled'); assert.equal(await history(), hf0 + 1, 'one undo step'); assert.equal(await evaluate('store.getState().editingId'), null, 'no editing needed');
  assert.equal(await css2(td(t, 1, 1), 'backgroundColor'), rgb(red)); assert.equal(await css2(td(t, 0, 0), 'backgroundColor'), rgb(red));
  await evaluate('store.getState().undo()'); await pause(300); assert.ok(hasNoFillKeys(await T()), 'undo removes the fills');
  await evaluate('store.getState().redo()'); await pause(300);
  await pickDefault('표 전체 채우기'); assert.ok(hasNoFillKeys(await T()), 'clearing removes the custom fills (keys gone)');
  // custom fill wins over the Header style default
  await chooseStyle('Header'); await pickColor('표 전체 채우기', 'Standard Red'); assert.equal(await css2(td(t, 0, 1), 'backgroundColor'), rgb(red), 'custom fill wins over the Header style fill');
  await pickDefault('표 전체 채우기'); assert.equal(await css2(td(t, 0, 1), 'backgroundColor'), rgb('#F3F4F6'), 'removing it brings the style default back'); await chooseStyle('Minimal');

  // -- fills: the active cell (after editing, without text editing) --
  await clickCell(t, 1, 2); assert.equal(await evaluate('store.getState().editingId'), t.id);
  assert.ok(await evaluate("!!document.querySelector('.propsbar button[title^=\"셀 채우기\"]')"), 'while editing the control targets the cell');
  await esc(); assert.equal(await evaluate('store.getState().editingId'), null, 'editing ended'); assert.equal(await evaluate("document.querySelector('.ms-active')?.dataset.r + ',' + document.querySelector('.ms-active')?.dataset.c"), '1,2', 'the cell stays marked');
  assert.ok(await evaluate("!!document.querySelector('.propsbar button[title^=\"셀 채우기\"]')"), 'cell scope remains without editing');
  const hc2 = await history(); const blue = await pickColor('셀 채우기', 'Standard Blue'); tf = await T();
  assert.deepEqual(fills(tf).flat().filter(Boolean).map((x) => x.toUpperCase()), [blue], 'only that one cell is filled'); assert.equal(tf.rows[1][2].fill.toUpperCase(), blue); assert.equal(await history(), hc2 + 1);
  assert.equal(await css2(td(t, 1, 2), 'backgroundColor'), rgb(blue)); assert.equal(await css2(td(t, 1, 1), 'backgroundColor'), clear);
  assert.equal(await evaluate('store.getState().editingId'), null, 'still not editing: no text editing needed to set a cell background');
  // while editing the same applies, editing continues and the change is its own step
  await clickCell(t, 2, 1); const he = await history(); await type('typed'); const red2 = await pickColor('셀 채우기', 'Standard Red'); tf = await T();
  assert.equal(tf.rows[2][1].fill.toUpperCase(), red2); assert.equal(await evaluate('store.getState().editingId'), t.id, 'editing continues'); assert.deepEqual(await evaluate('store.getState().editCell'), { row: 2, col: 1 });
  await type('!'); assert.ok(cellText(await T(), 2, 1).endsWith('typed!'), 'typing still works after setting the fill');
  await esc(); assert.equal(await history(), he + 3, 'typing, fill and later typing are separate steps');
  await evaluate('store.getState().undo()'); await evaluate('store.getState().undo()'); await pause(300); tf = await T(); assert.equal(tf.rows[2][1].fill, undefined, 'undo reverts the fill on its own'); assert.ok(cellText(tf, 2, 1).endsWith('typed'), 'the first typing step is still there');
  await evaluate('store.getState().redo()'); await evaluate('store.getState().redo()'); await pause(300);
  // Esc clears the cell scope first, then deselects
  await evaluate("document.activeElement && document.activeElement.blur()");
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await pause(300);
  assert.equal(await evaluate("document.querySelectorAll('.ms-active').length"), 0, 'Esc clears the active cell'); assert.deepEqual(await evaluate('store.getState().selection'), [t.id], 'but keeps the table selected');
  assert.ok(await evaluate("!!document.querySelector('.propsbar button[title^=\"표 전체 채우기\"]')"), 'back to whole-table scope');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await pause(300);
  assert.deepEqual(await evaluate('store.getState().selection'), [], 'a further Esc deselects as before');
  await clickCell(t, 0, 0); // (selects the table first, then edits)
  await evaluate(`store.getState().stopEditing(); store.getState().select([])`); await pause(200); await evaluate(`store.getState().select(['${t.id}'])`); await pause(250);
  assert.equal(await evaluate("document.querySelectorAll('.ms-active').length"), 0, 'deselecting forgets the active cell');
  await evaluate("[...document.querySelectorAll('.propsbar button')].length"); 
  await pickDefault('표 전체 채우기'); assert.ok(hasNoFillKeys(await T()));

  // -- border color (fixed 1px width) --
  const hb = await history(); const bcol = await pickColor('표 선 색', 'Standard Red'); tf = await T();
  assert.equal(tf.borderColor.toUpperCase(), bcol); assert.equal(await history(), hb + 1, 'one undo step');
  assert.equal(await css2(td(t, 1, 0), 'borderBottomColor'), rgb(bcol)); assert.equal(await css2(td(t, 1, 0), 'borderBottomWidth'), '1px', 'width stays 1px'); assert.equal(await css2(td(t, 0, 0), 'borderBottomColor'), rgb(bcol)); assert.equal(await css2(td(t, 0, 0), 'borderBottomWidth'), '1.5px', 'header rule keeps its width'); assert.equal(await css2(td(t, 2, 0), 'borderBottomColor'), rgb(bcol));
  assert.equal(await css2(td(t, 1, 1), 'borderLeftWidth'), '0px', 'Minimal still has no vertical lines');
  await chooseStyle('Grid'); tg = await T(); assert.equal(tg.borderColor.toUpperCase(), bcol, 'switching style keeps the border color'); assert.equal(await css2(td(t, 1, 1), 'borderLeftColor'), rgb(bcol)); assert.equal(await css2(td(t, 1, 1), 'borderLeftWidth'), '1px');
  await evaluate('store.getState().undo()'); await pause(250); await evaluate('store.getState().undo()'); await pause(300); assert.ok(!('borderColor' in await T()), 'undo steps back through style and color'); await evaluate('store.getState().redo()'); await evaluate('store.getState().redo()'); await pause(300);
  await chooseStyle('Minimal'); await pickDefault('표 선 색'); assert.ok(!('borderColor' in await T()), 'default removes the custom color'); assert.equal(await css2(td(t, 1, 0), 'borderBottomColor'), rgb('#E5E7EB'));

  // -- style switching keeps every customization; the header toggle keeps custom fills --
  await pickColor('표 선 색', 'Standard Red'); await clickCell(t, 0, 1); await esc();
  const orange = await pickColor('셀 채우기', 'Standard Blue');
  const custom = JSON.stringify({ b: (await T()).borderColor, f: fills(await T()) });
  for (const name of ['Grid', 'Header', 'Minimal', 'Header']) { await chooseStyle(name); assert.equal(JSON.stringify({ b: (await T()).borderColor, f: fills(await T()) }), custom, `switching to ${name} keeps the border color and every fill`); }
  assert.equal(await css2(td(t, 0, 1), 'backgroundColor'), rgb(orange), 'the custom header-cell fill beats the Header style default'); assert.equal(await css2(td(t, 0, 0), 'backgroundColor'), rgb('#F3F4F6'), 'other header cells show the default');
  await toggleHeader(); assert.equal((await T()).headerRow, false); assert.equal(await css2(td(t, 0, 1), 'backgroundColor'), rgb(orange), 'header off keeps the custom fill'); assert.equal(await css2(td(t, 0, 0), 'backgroundColor'), clear, 'but drops the default header fill');
  assert.equal(JSON.stringify({ b: (await T()).borderColor, f: fills(await T()) }), custom); await toggleHeader(); assert.equal(await css2(td(t, 0, 0), 'backgroundColor'), rgb('#F3F4F6'));

  // -- blue guides stay separate from the real borders (Grid) and editor marks stay out of static output --
  await chooseStyle('Grid'); await evaluate(`store.getState().select(['${t.id}'])`); await pause(300);
  assert.equal(await css2(td(t, 1, 1), 'borderLeftWidth'), '1px'); assert.ok(await evaluate("document.querySelectorAll('.col-guide').length > 0"), 'guides are drawn by the overlay');
  assert.equal(await evaluate(`document.querySelectorAll('${sel(t)} .col-guide, ${sel(t)} .col-resizer').length`), 0, 'and are not part of the table markup');
  await clickCell(t, 2, 2); await esc(); assert.ok(await evaluate("document.querySelectorAll('.ms-active').length === 1"));
  assert.equal(await evaluate("document.querySelectorAll('.thumb-inner .ms-active, .thumb-inner .col-guide').length"), 0, 'no editor marks in thumbnails');
  await evaluate('store.setState({presenting: true})'); await pause(500); assert.equal(await evaluate("document.querySelectorAll('.presenter .ms-active, .presenter .col-guide').length"), 0, 'presenter'); assert.equal(await evaluate("document.querySelector('.presenter .ms-table').dataset.tableStyle"), 'grid'); assert.equal(await evaluate("getComputedStyle(document.querySelector('.presenter .ms-table td')).borderLeftWidth"), '1px', 'the presenter shows the real grid borders'); await evaluate('store.setState({presenting: false})'); await pause(300);
  await evaluate("store.setState({exportMode: 'print'})"); await pause(400); assert.equal(await evaluate("document.querySelectorAll('#print-root .ms-active, #print-root .col-guide').length"), 0, 'print'); assert.equal(await evaluate("getComputedStyle(document.querySelector('#print-root .ms-table td')).borderLeftWidth"), '1px'); assert.equal(await evaluate("getComputedStyle(document.querySelector('#print-root .ms-table td')).borderLeftColor"), rgb((await T()).borderColor)); await evaluate("store.setState({exportMode: null})"); await pause(300);
  await pickDefault('표 선 색'); await esc(); await pickDefault('표 전체 채우기'); await evaluate(`store.getState().select(['${t.id}'])`); await pause(200); // (Esc: back to whole-table scope)

  // -- deck-wide font reaches the cells without erasing other formatting --
  await evaluate(`store.getState().updateElements(['${t.id}'], (d) => { d.rows[1][0].doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'fmt', marks: [{ type: 'bold' }, { type: 'textStyle', attrs: { fontFamily: 'Pretendard', color: '#DC2626' } }] }] }] }; })`); await pause(300);
  const cellFont = (r, c) => evaluate(`getComputedStyle(document.querySelector('${td(t, r, c)} .tb-content p')).fontFamily`);
  assert.match(await cellFont(2, 2), /NanumSquare/, 'cells follow the deck font'); const hdf = await history();
  await evaluate("tf.setDeckFont('Noto Serif KR')"); await pause(400);
  assert.equal(await history(), hdf + 1, 'one undo step'); tf = await T();
  assert.match(await cellFont(2, 2), /Noto Serif KR/, 'plain cells follow the new deck font'); const mk0 = tf.rows[1][0].doc.content[0].content[0].marks;
  assert.ok(mk0.some((x) => x.type === 'bold'), 'bold kept'); assert.ok(mk0.some((x) => x.type === 'textStyle' && x.attrs.color === '#DC2626' && !('fontFamily' in x.attrs)), 'color kept, per-range font removed');
  assert.match(await cellFont(1, 0), /Noto Serif KR/, 'the formerly per-range font cell follows the deck font too');
  await evaluate('store.getState().undo()'); await pause(400); assert.ok(JSON.stringify(await T()).includes('"fontFamily":"Pretendard"'), 'undo restores the per-range font'); assert.match(await cellFont(2, 2), /NanumSquare/);
  await evaluate(`store.getState().updateElements(['${t.id}'], (d) => { d.rows[1][0].doc = { type: 'doc', content: [{ type: 'paragraph' }] }; })`); await pause(200);

  // -- PPTX reflects style, header, fills and border color --
  const pptxTable = async () => {
    await evaluate("for (const k of Object.keys(testFiles)) if (k.endsWith('.pptx')) delete testFiles[k]");
    await evaluate("document.querySelector('.export-menu > button').click()"); await pause(200);
    await evaluate("document.querySelector('.pop .menu-item:nth-child(2)').click()");
    const name = await until(() => evaluate("Object.keys(testFiles).find((k) => k.endsWith('.pptx'))"), 'PPTX export', 30000);
    await until(() => evaluate(`testFiles[${JSON.stringify(name)}]?.length > 1000`), 'PPTX bytes', 30000);
    const z = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(name)}]`)));
    const slides = await evaluate('store.getState().deck.slides'); const no = slides.findIndex((s) => s.elements.some((e) => e.type === 'table')) + 1;
    const x = await z.file(`ppt/slides/slide${no}.xml`).async('string'); const tb = /<a:tbl>[\s\S]*<\/a:tbl>/.exec(x)[0];
    await evaluate(`store.getState().select(['${t.id}'])`); await pause(300);
    return tb.match(/<a:tr [\s\S]*?<\/a:tr>/g).map((tr) => tr.match(/<a:tc[ >][\s\S]*?<\/a:tc>/g));
  };
  const line = (tc, side) => { const m2 = new RegExp(`<a:ln${side}[^>]*?(?: w="(\\d+)")?[^>]*>\\s*(<a:noFill/>|<a:solidFill><a:srgbClr val="(\\w+)")`).exec(tc); return m2 ? (m2[2] === '<a:noFill/>' ? null : { color: m2[3], w: Number(/ w="(\d+)"/.exec(m2[0])[1]) }) : undefined; };
  const cellBg = (tc) => (/<\/a:lnB>\s*<a:solidFill><a:srgbClr val="(\w+)"/.exec(tc) ?? [])[1] ?? null;
  const EMU = (px) => Math.round(px * 0.75 * 12700);
  await chooseStyle('Minimal'); await toggleHeader().catch(() => {}); if (!(await T()).headerRow) await toggleHeader();
  let g1 = await pptxTable();
  assert.deepEqual(line(g1[0][0], 'B'), { color: '9CA3AF', w: EMU(1.5) }, 'Minimal header rule'); assert.deepEqual(line(g1[1][0], 'B'), { color: 'E5E7EB', w: EMU(1) }, 'row divider');
  for (const side of ['L', 'R', 'T']) assert.equal(line(g1[1][1], side), null, `no ${side} line in Minimal`); assert.ok(g1.flat().every((c) => cellBg(c) === null), 'no fills in Minimal'); assert.match(g1[0][0], /b="1"/, 'bold header');
  await chooseStyle('Grid'); g1 = await pptxTable();
  for (const side of ['L', 'R', 'T', 'B']) assert.deepEqual(line(g1[1][1], side), { color: 'D1D5DB', w: EMU(1) }, `Grid ${side}`);
  await chooseStyle('Header'); g1 = await pptxTable();
  assert.equal(cellBg(g1[0][0]), 'F3F4F6', 'Header style fill in the file'); assert.equal(cellBg(g1[0][2]), 'F3F4F6'); assert.equal(cellBg(g1[1][0]), null); assert.match(g1[0][0], /b="1"/);
  await toggleHeader(); g1 = await pptxTable(); assert.equal(cellBg(g1[0][0]), null, 'header off: no fill'); assert.doesNotMatch(g1[0][0], /<a:rPr[^>]* b="1"/, 'header off: not bold'); assert.deepEqual(line(g1[0][0], 'B'), { color: 'E5E7EB', w: EMU(1) }); await toggleHeader();
  await clickCell(t, 1, 1); await esc(); const cf = await pickColor('셀 채우기', 'Standard Red'); const bc = await pickColor('표 선 색', 'Standard Blue');
  g1 = await pptxTable();
  assert.equal(cellBg(g1[1][1]), cf.slice(1), 'custom cell fill in the file'); assert.equal(g1.flat().filter((c) => cellBg(c) === cf.slice(1)).length, 1, 'only that cell'); assert.equal(cellBg(g1[0][0]), 'F3F4F6', 'header default still there for the others');
  g1.forEach((row, r) => row.forEach((c, i) => { const b = line(c, 'B'); assert.equal(b.color, bc.slice(1), `border color r${r}c${i}`); assert.equal(b.w, EMU(r === 0 ? 1.5 : 1), 'width unchanged'); }));
  await chooseStyle('Grid'); g1 = await pptxTable(); for (const side of ['L', 'R', 'T', 'B']) assert.equal(line(g1[1][2], side).color, bc.slice(1)); assert.equal(cellBg(g1[1][1]), cf.slice(1), 'fill kept when switching style');
  await chooseStyle('Header'); // leave a customised table for the persistence / export checks that follow
  await evaluate(`store.getState().select(['${t.id}'])`); await pause(300); await writeFile(path.join(output, 'table-2b.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64')); // for a manual look
  console.log('PASS Phase 2B: styles, header toggle, fills (cell / table), border color, deck font, PPTX mapping, editor marks stay editor-only');

  // ======== Table Caption ========
  await evaluate('store.getState().stopEditing(); store.getState().select([])'); await pause(250);
  t = await T(); await evaluate(`store.getState().select(['${t.id}'])`); await pause(300);
  const capBtn = (title) => `document.querySelector('.propsbar button[title="${title}"]')`;
  const capRects = () => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel(t))}); const tb = el.querySelector('table').getBoundingClientRect(); const c = el.querySelector('.img-caption, .img-caption-input'); if (!c) return null; const r = c.getBoundingClientRect(); const cs = getComputedStyle(c); return {tx: tb.x, ty: tb.y, tw: tb.width, tb: tb.bottom, cx: r.x, cy: r.y, cw: r.width, ch: r.height, bottom: r.bottom, fs: cs.fontSize, color: cs.color, align: cs.textAlign, weight: cs.fontWeight, tag: c.tagName}; })()`);
  const CAP = 'Table 1: Results of the experiment';
  const addCap = async (text) => { await evaluate(`${capBtn('표 캡션 추가')}.click()`); await pause(350); await type(text); await esc(); };

  // -- compatibility: tables without a caption look and serialize as before --
  assert.ok(!('caption' in t), 'no caption key by default'); assert.equal(await evaluate("document.querySelectorAll('.img-caption, .img-caption-input').length"), 0, 'no caption UI by default');
  assert.equal(await evaluate(`!!${capBtn('표 캡션 추가')}`), true, 'Caption action on a selected table'); assert.equal(await evaluate(`!!${capBtn('표 캡션 삭제')}`), false);

  // -- add: an empty, focused field; geometry unchanged --
  const geom0 = JSON.stringify({ x: t.x, y: t.y, w: t.w, cols: t.cols, rows: t.rows }), hc0 = await history();
  await evaluate(`${capBtn('표 캡션 추가')}.click()`); await pause(400);
  assert.equal((await T()).caption, '', 'adding creates an empty caption'); assert.equal(await history(), hc0 + 1, 'adding is one undo step');
  assert.equal(await evaluate("document.activeElement?.className"), 'img-caption-input', 'the caption field is focused'); assert.equal(await evaluate("document.querySelector('.img-caption-input').placeholder"), 'Add a caption...');
  assert.ok(!(await evaluate('JSON.stringify(store.getState().deck)')).includes('Add a caption'), 'the placeholder is not content');
  assert.equal(JSON.stringify({ x: (await T()).x, y: (await T()).y, w: (await T()).w, cols: (await T()).cols, rows: (await T()).rows }), geom0, 'the table itself is unchanged');
  assert.equal(await evaluate(`!!${capBtn('표 캡션 삭제')}`), true, 'the action becomes Remove Caption');
  // -- type: one undo step per editing session; layout = image caption layout --
  await type(CAP); await esc(); t = await T(); assert.equal(t.caption, CAP); assert.equal(await history(), hc0 + 2, 'typing session = one undo step');
  assert.notEqual(await evaluate('document.activeElement?.tagName'), 'TEXTAREA', 'Esc leaves the field');
  let CR = await capRects(); k = await scaleOf(t);
  assert.deepEqual([CR.fs, CR.align, CR.weight, CR.color], ['14px', 'left', '400', 'rgb(107, 114, 128)'], 'caption: 14px gray, left-aligned, regular');
  assert.ok(Math.abs(CR.cx - CR.tx) < 1 && Math.abs(CR.cw - CR.tw) < 1, 'caption has the table’s left edge and width'); assert.ok(Math.abs(CR.cy - CR.tb - 6 * k) < 1.5, 'caption sits 6px below the table');
  assert.equal(await evaluate(`document.querySelector('${sel(t)} .img-caption-input') ? 1 : 0`), 1, 'editable field shows while the table is selected');
  await writeFile(path.join(output, 'table-caption.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64')); // for a manual look
  // the row "+" steps aside instead of covering the caption
  const plusTop = await evaluate("document.querySelector('.table-add[aria-label=\"Add row\"]').getBoundingClientRect().top"); assert.ok(plusTop >= CR.bottom - 0.5, 'row + control sits below the caption');
  // -- stays attached: move, resize, add row/column, column drag --
  await drag(await center(td(t, 1, 0)), 60 * k, 25 * k); const t6 = await T(); let CR2 = await capRects(); k = await scaleOf(t6);
  assert.ok(t6.x > t.x + 30 && t6.y > t.y + 10, 'table moved'); assert.ok(Math.abs(CR2.cx - CR2.tx) < 1 && Math.abs(CR2.cy - CR2.tb - 6 * k) < 1.5, 'a moved table keeps its caption attached');
  const hMove = await history(); assert.equal(t6.caption, CAP); await evaluate('store.getState().undo()'); await pause(300); assert.equal((await T()).caption, CAP, 'undoing the move keeps the caption');
  t = await T(); k = await scaleOf(t); await dragFrom('.overlay .handle.h-e', 90 * k); t = await T(); CR2 = await capRects(); assert.ok(Math.abs(CR2.cw - CR2.tw) < 1, 'resizing the table width resizes the caption width'); assert.equal(t.caption, CAP);
  await evaluate('store.getState().undo()'); await pause(300);
  t = await T(); await clickOp('+ 행'); CR2 = await capRects(); k = await scaleOf(await T()); assert.ok(Math.abs(CR2.cy - CR2.tb - 6 * k) < 1.5, 'after adding a row the caption is still right under the table'); await evaluate('store.getState().undo()'); await pause(300);
  t = await T(); k = await scaleOf(t); await dragFrom('.col-resizer[data-col="0"]', 30 * k); assert.equal((await T()).caption, CAP, 'column drag keeps the caption'); await evaluate('store.getState().undo()'); await pause(300);
  // -- undo / redo, each its own step --
  await evaluate('store.getState().undo()'); await pause(300); assert.equal((await T()).caption, '', 'undo typing → empty caption'); await evaluate('store.getState().undo()'); await pause(300); assert.ok(!('caption' in await T()), 'undo add → no caption');
  assert.equal(await evaluate("document.querySelectorAll('.img-caption, .img-caption-input').length"), 0);
  await evaluate('store.getState().redo()'); await evaluate('store.getState().redo()'); await pause(300); assert.equal((await T()).caption, CAP, 'redo restores the caption');
  // -- remove --
  await evaluate(`store.getState().select(['${t.id}'])`); await pause(250); const hr = await history();
  await evaluate(`${capBtn('표 캡션 삭제')}.click()`); await pause(350); assert.ok(!('caption' in await T()), 'Remove Caption deletes it'); assert.equal(await history(), hr + 1); assert.equal(await evaluate("document.querySelectorAll('.img-caption, .img-caption-input').length"), 0);
  await evaluate('store.getState().undo()'); await pause(300); assert.equal((await T()).caption, CAP, 'undo remove'); await evaluate('store.getState().redo()'); await pause(300); assert.ok(!('caption' in await T()), 'redo remove'); await evaluate('store.getState().undo()'); await pause(300);
  // -- emptied caption goes back to "no caption" (like images) --
  await evaluate(`store.getState().select(['${t.id}'])`); await pause(250);
  await evaluate("document.querySelector('.img-caption-input').focus(); document.querySelector('.img-caption-input').select()"); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); await pause(250); await esc();
  assert.ok(!('caption' in await T()), 'clearing all text removes the caption'); await evaluate('store.getState().undo()'); await pause(300); assert.equal((await T()).caption, CAP, 'one undo restores the text');
  // -- cell editing and the caption field never merge --
  await evaluate(`store.getState().select(['${t.id}'])`); await pause(250); t = await T(); await clickCell(t, 2, 0); await type('q'); const hq = await history();
  const cc = await center('.img-caption-input'); await mouse('mousePressed', cc); await mouse('mouseReleased', cc); await pause(350);
  assert.equal(await evaluate('store.getState().editingId'), null, 'focusing the caption ends cell editing'); assert.equal(await history(), hq + 1, 'the cell edit became its own step'); assert.equal(await evaluate('document.activeElement.className'), 'img-caption-input');
  await esc(); await evaluate('store.getState().undo()'); await pause(300);
  // -- duplicate keeps the caption --
  await evaluate(`store.getState().select(['${t.id}'])`); await pause(250); const nT = (await tables()).length;
  await evaluate('insert.duplicateSelection()'); await pause(400); const all2 = await tables(); assert.equal(all2.length, nT + 1, 'duplicated'); const dup = all2.find((x) => x.id !== t.id);
  assert.equal(dup.caption, CAP, 'the duplicate carries the caption'); assert.notEqual(dup.id, t.id);
  await evaluate(`store.getState().updateElements(['${dup.id}'], (d) => { d.caption = 'Copy' })`); await pause(200); assert.equal((await T()).caption, CAP, 'the original caption is independent');
  await evaluate('store.getState().undo()'); await evaluate('store.getState().undo()'); await pause(300); assert.equal((await tables()).length, nT);
  // -- a brand-new table has no caption --
  await evaluate('insert.insertTable()'); await pause(400); const fresh = (await tables()).find((x) => x.id !== t.id); assert.ok(!('caption' in fresh)); assert.equal(await evaluate("document.querySelectorAll('.slide.editable .img-caption, .slide.editable .img-caption-input').length"), 1, 'only the first table shows a caption'); await evaluate('store.getState().undo()'); await pause(300);

  // -- static outputs: deselected / thumbnails / presenter / print show the text, never the field --
  await evaluate(`store.getState().select(['${t.id}'])`); await pause(250);
  const FINAL = 'Table 1: Final caption'; await evaluate(`store.getState().updateElements(['${t.id}'], (d) => { d.caption = ${JSON.stringify(FINAL)} })`); await pause(300);
  await evaluate('store.getState().select([])'); await pause(300);
  assert.equal(await evaluate(`document.querySelector('${sel(t)} .img-caption').textContent`), FINAL, 'deselected: static caption'); assert.equal(await evaluate('document.querySelectorAll(".img-caption-input").length'), 0, 'no field when not selected');
  assert.equal(await evaluate(`[...document.querySelectorAll('.thumb-inner .img-caption')].map((e) => e.textContent).join()`), FINAL, 'thumbnail'); assert.equal(await evaluate("document.querySelectorAll('.thumb-inner .img-caption-input').length"), 0);
  await evaluate('store.setState({presenting: true})'); await pause(500); assert.equal(await evaluate(`[...document.querySelectorAll('.presenter .img-caption')].map((e) => e.textContent).join()`), FINAL, 'presenter'); assert.equal(await evaluate("document.querySelectorAll('.presenter .img-caption-input').length"), 0); await evaluate('store.setState({presenting: false})'); await pause(300);
  await evaluate("store.setState({exportMode: 'print'})"); await pause(400); assert.equal(await evaluate(`[...document.querySelectorAll('#print-root .img-caption')].map((e) => e.textContent).join()`), FINAL, 'print / PDF'); assert.equal(await evaluate("document.querySelectorAll('#print-root .img-caption-input').length"), 0); await evaluate("store.setState({exportMode: null})"); await pause(300);

  // -- PPTX: a native text box under the table --
  await evaluate("for (const k2 of Object.keys(testFiles)) if (k2.endsWith('.pptx')) delete testFiles[k2]");
  await evaluate("document.querySelector('.export-menu > button').click()"); await pause(200); await evaluate("document.querySelector('.pop .menu-item:nth-child(2)').click()");
  const capPptx = await until(() => evaluate("Object.keys(testFiles).find((k2) => k2.endsWith('.pptx'))"), 'PPTX export', 30000); await until(() => evaluate(`testFiles[${JSON.stringify(capPptx)}]?.length > 1000`), 'PPTX bytes', 30000);
  const capZip = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(capPptx)}]`))); const capNo = (await evaluate('store.getState().deck.slides')).findIndex((s) => s.elements.some((e) => e.type === 'table')) + 1;
  const capXml = await capZip.file(`ppt/slides/slide${capNo}.xml`).async('string'); t = await T();
  const box = /<p:sp>(?:(?!<\/p:sp>)[\s\S])*name="Table Caption"[\s\S]*?<\/p:sp>/.exec(capXml)?.[0]; assert.ok(box, 'a "Table Caption" text box exists');
  assert.match(box, new RegExp(`<a:t>${FINAL}</a:t>`), 'with the caption text'); assert.ok(!/<a:tbl>[\s\S]*Final caption[\s\S]*<\/a:tbl>/.test(capXml), 'the caption is not inside the table');
  const off = /<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"/.exec(box); const E = 9525;
  assert.ok(Math.abs(Number(off[1]) - t.x * E) <= 3 * E, 'same left edge as the table'); assert.ok(Math.abs(Number(off[3]) - t.w * E) <= 3 * E, 'same width as the table'); assert.ok(Number(off[2]) >= (t.y + t.h) * E - 3 * E, 'below the table');
  assert.match(box, /sz="1050"/, 'caption font size 10.5pt (14px)'); assert.match(capXml, /<a:tbl>/, 'the table is still a native table');
  await evaluate(`store.getState().select(['${t.id}'])`); await pause(300);
  console.log('PASS Table Caption: add / type / remove / undo-redo, attached to move / resize / rows / columns, duplicate, static outputs, PPTX text box');

  // ======== UI polish: Add Column centered on the right edge; Table toolbar icon ========
  // -- toolbar icon: same icon system and size as Image / Shape; button size and alignment unchanged --
  const tbIcons = await evaluate(`(() => { const find = (txt) => [...document.querySelectorAll('.tb-center button')].find((b) => b.textContent.includes(txt)); const info = (b) => { const s = b.querySelector('svg'); const r = s.getBoundingClientRect(), br = b.getBoundingClientRect(); const lab = [...b.querySelectorAll('span')].find((x) => x.textContent.trim() && !x.querySelector('svg')); const cs = getComputedStyle(s); return { w: r.width, h: r.height, vb: s.getAttribute('viewBox'), stroke: cs.strokeWidth, cy: r.top + r.height / 2, btnH: br.height, btnTop: br.top, label: lab && getComputedStyle(lab).fontSize, glyph: !!b.querySelector('svg') }; }; return { table: info(find('표')), image: info(find('이미지')), shape: info(find('도형')), text: info(find('텍스트')) }; })()`);
  for (const k2 of ['image', 'shape', 'text']) { assert.equal(tbIcons.table.w, tbIcons[k2].w, `Table icon is as wide as ${k2}`); assert.equal(tbIcons.table.h, tbIcons[k2].h, `and as tall as ${k2}`); assert.equal(tbIcons.table.vb, tbIcons[k2].vb, 'same viewBox'); assert.equal(tbIcons.table.stroke, tbIcons[k2].stroke, 'same stroke width'); assert.ok(Math.abs(tbIcons.table.cy - tbIcons[k2].cy) < 0.6, `icon vertically aligned with ${k2}`); assert.equal(tbIcons.table.btnH, tbIcons[k2].btnH, `button height unchanged vs ${k2}`); assert.equal(tbIcons.table.btnTop, tbIcons[k2].btnTop, 'same top'); }
  assert.deepEqual([tbIcons.table.w, tbIcons.table.h], [18, 18]); assert.equal(tbIcons.table.btnH, 32); assert.equal(tbIcons.table.label, tbIcons.image.label, 'label font size unchanged');
  assert.equal(await evaluate("[...document.querySelectorAll('.tb-center button')].find((b) => b.textContent.includes('표')).textContent.includes('▦')"), false, 'the small text glyph is gone');
  const nTables = (await tables()).length; await evaluate("[...document.querySelectorAll('.tb-center button')].find((b) => b.textContent.includes('표')).click()"); await pause(400); assert.equal((await tables()).length, nTables + 1, 'the Table toolbar button still inserts a table'); await evaluate('store.getState().undo()'); await pause(300); assert.equal((await tables()).length, nTables);

  // -- "+" controls: column + centered on the table grid's right edge, row + centered under the table / caption --
  await evaluate('store.getState().stopEditing(); store.getState().select([])'); await pause(250);
  t = await T(); await evaluate(`store.getState().select(['${t.id}'])`); await pause(350);
  const plusGeom = () => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel(t))}); const tb = el.querySelector('table').getBoundingClientRect(); const c = document.querySelector('.table-add[aria-label="Add column"]').getBoundingClientRect(); const r = document.querySelector('.table-add[aria-label="Add row"]').getBoundingClientRect(); const cap = el.querySelector('.img-caption, .img-caption-input'); const cr = cap ? cap.getBoundingClientRect() : null; const h = document.querySelector('.overlay .handle.h-e').getBoundingClientRect(); const strips = [...document.querySelectorAll('.col-resizer.edge-right')].map((e) => e.getBoundingClientRect()); const hit = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top); return { colDy: (c.top + c.height / 2) - (tb.top + tb.height / 2), colGap: c.left - tb.right, rowDx: (r.left + r.width / 2) - (tb.left + tb.width / 2), rowBelowCaption: cr ? r.top - cr.bottom : null, rowBelowTable: r.top - tb.bottom, hasCaption: !!cr, overlapHandle: hit(c, h), overlapStrips: strips.some((s) => hit(c, s)), overlapCaption: cr ? hit(c, cr) || hit(r, cr) : false, colSize: [Math.round(c.width), Math.round(c.height)], rowSize: [Math.round(r.width), Math.round(r.height)] }; })()`);
  const ok2 = (g) => Math.abs(g.colDy) <= 1 && Math.abs(g.rowDx) <= 1 && !g.overlapHandle && !g.overlapStrips && !g.overlapCaption;
  // The "+" position follows the measured (asynchronously stored) table height: wait for it to settle, then require exact centering.
  const settledPlus = async (why) => { const g = await until(async () => { const x = await plusGeom(); return ok2(x) ? x : false; }, `Add Column / Add Row not centered ${why}: ${JSON.stringify(await plusGeom())}`, 5000); assert.ok(Math.abs(g.colDy) <= 1, `Add Column is vertically centered on the grid ${why}`); assert.ok(Math.abs(g.rowDx) <= 1, `Add Row is horizontally centered ${why}`); assert.ok(!g.overlapHandle && !g.overlapStrips && !g.overlapCaption, `no overlap with the handle, edge strips or caption ${why}`); return g; };
  await writeFile(path.join(output, 'table-polish.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64')); // for a manual look
  const pg0 = await settledPlus('with a caption'); assert.equal(pg0.hasCaption, true); assert.ok(pg0.rowBelowCaption >= -0.5, 'Add Row stays below the caption'); assert.ok(pg0.colGap > 8 * await scaleOf(t) - 1, 'Add Column stays outside the right edge');
  const capFree = pg0.rowBelowTable;
  // the caption does not influence the vertical centre: remove it and compare
  const dy0 = pg0.colDy; await evaluate(`store.getState().updateElements(['${t.id}'], (d) => { delete d.caption }, true)`); await pause(350);
  const pg1 = await settledPlus('without a caption'); assert.equal(pg1.hasCaption, false); assert.ok(Math.abs(pg1.colDy - dy0) <= 1, 'the caption makes no difference to the Add Column position'); assert.ok(pg1.rowBelowTable < capFree, 'Add Row moves up to the table when there is no caption'); assert.deepEqual(pg1.colSize, pg0.colSize, 'button size unchanged'); assert.deepEqual(pg1.rowSize, pg0.rowSize);
  // adding / removing rows and changing row heights
  await clickOp('+ 행'); await settledPlus('after adding a row'); await clickOp('+ 행'); await settledPlus('after adding another row'); await clickOp('− 행'); await settledPlus('after removing a row');
  t = await T(); await evaluate(`store.getState().startCellEditing('${t.id}', 1, 1, 'end')`); await pause(250); await type(' a long text that wraps onto several lines in this narrow cell to change the row height'); await esc(); await evaluate(`store.getState().select(['${t.id}'])`); await pause(350);
  const tall = await settledPlus('after a row grows taller'); t = await T(); await domMatches(t);
  // columns added / removed, table moved and resized
  await clickOp('+ 열'); await settledPlus('after adding a column'); await clickOp('− 열'); await settledPlus('after removing a column');
  t = await T(); k = await scaleOf(t); await drag(await center(td(t, 1, 0)), 50 * k, 20 * k); await settledPlus('after moving the table');
  t = await T(); k = await scaleOf(t); await dragFrom('.overlay .handle.h-e', -150 * k); await settledPlus('after resizing the width (rows re-wrap)');
  t = await T(); k = await scaleOf(t); await dragFrom('.overlay .handle.h-w', 60 * k); await settledPlus('after resizing from the left');
  await dragFrom('.col-resizer[data-col="0"]', 25 * k); await settledPlus('after a column drag');
  for (let i = 0; i < 6; i++) await evaluate('store.getState().undo()'); await pause(400); await settledPlus('after undoing'); for (let i = 0; i < 6; i++) await evaluate('store.getState().redo()'); await pause(400); await settledPlus('after redoing');
  for (let i = 0; i < 6; i++) await evaluate('store.getState().undo()'); await pause(300);
  // behaviour is unchanged: the controls still add at the end, one undo step each
  t = await T(); const hp2 = await history(); const colsN = t.cols.length; await evaluate("document.querySelector('.table-add[aria-label=\"Add column\"]').click()"); await pause(350); assert.equal((await T()).cols.length, colsN + 1, 'the + column control still adds a column'); assert.equal(await history(), hp2 + 1); await settledPlus('after clicking it'); await evaluate('store.getState().undo()'); await pause(300);
  // restore the caption that the persistence / export checks below expect
  await evaluate(`store.getState().updateElements(['${t.id}'], (d) => { d.caption = 'Table 1: Final caption' })`); await pause(300); await settledPlus('with the caption back'); assert.ok((await plusGeom()).rowBelowCaption >= -0.5);
  console.log('PASS UI polish: Add Column centered on the grid (with / without caption, rows, columns, move, resize, undo), Table toolbar icon matches Image / Shape');

  // leave the table resized and pasted so the persistence / export checks below cover it
  t = await T(); await evaluate(`store.getState().select(['${t.id}'])`); await pause(300);
  k = await scaleOf(t); await dragFrom(`.col-resizer[data-col="0"]`, 45 * k); await dragFrom(`.overlay .handle.h-e`, 60 * k);
  await clickCell(t, 1, 1); await pasteIntoCell('p1\tp2\np3\tp4\n');
  t = await T(); assert.deepEqual(await problems(t), []);

  // ---- regression: other elements ----
  const bl = await others();
  assert.deepEqual(bl.map((e) => [e.type, e.x, e.y, e.w]), baseline.map((e) => [e.type, e.x, e.y, e.w]), 'other elements keep their geometry');
  await evaluate('store.getState().select([])');
  await evaluate('insert.insertTextCenter()'); await until(() => evaluate('!!active()'), 'text editor'); await type('plain text still works'); await esc();
  assert.ok(JSON.stringify(await cur()).includes('plain text still works'), 'text boxes still edit');
  await evaluate('store.getState().select([])');

  // ---- persistence: autosave + restart, .mslides ----
  t = await T(); const expected = JSON.stringify(t);
  await evaluate('store.getState().stopEditing()');
  await restart();
  await until(async () => (await tables()).length === 1, 'table restored after restart');
  const restored = await T();
  const gotoTable = () => evaluate(`store.getState().goToSlide(store.getState().deck.slides.find((s) => s.elements.some((e) => e.type === 'table')).id)`).then(() => pause(400));
  await gotoTable();
  assert.equal(restored.caption, 'Table 1: Final caption', 'the caption survives restart');
  assert.equal(await evaluate(`document.querySelector('[data-el-id="${restored.id}"] .img-caption')?.textContent`), 'Table 1: Final caption', 'and renders under the table');
  assert.equal(restored.style, 'header', 'style survives restart'); assert.ok(/^#[0-9A-Fa-f]{6}$/.test(restored.borderColor), 'border color survives restart');
  const fillCells = restored.rows.flatMap((r, i) => r.map((c, j) => (c.fill ? [i, j, c.fill] : null))).filter(Boolean); assert.equal(fillCells.length, 1, 'the custom cell fill survives restart');
  const rgb2 = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('${td(restored, fillCells[0][0], fillCells[0][1])}')).backgroundColor`), rgb2(fillCells[0][2]), 'the custom fill renders after restart');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('${td(restored, 1, 0)}')).borderBottomColor`), rgb2(restored.borderColor), 'and so does the border color');
  assert.equal(JSON.stringify(restored), expected, 'table identical after autosave + restart');
  await domMatches({ ...restored, h: restored.h });
  await evaluate('persist.saveProject()'); await pause(800);
  const fileName = await evaluate("Object.keys(testFiles).find(k => k.endsWith('.mslides'))");
  const fileText = Buffer.from(await evaluate(`testFiles[${JSON.stringify(fileName)}]`)).toString('utf8');
  assert.match(fileText, /"type":"table"/, 'the .mslides file contains the table');
  assert.match(fileText, /"caption":"Table 1: Final caption"/, 'and its caption');
  await evaluate('persist.newProject()'); await pause(600);
  assert.equal((await tables()).length, 0, 'a new presentation has no table');
  await evaluate(`persist.openFromText(${JSON.stringify(fileText)}, null)`); await pause(800);
  const reopened = await T(); assert.ok(reopened, 'table reopened from the .mslides file');
  assert.equal(JSON.stringify(reopened.rows), JSON.stringify(restored.rows)); assert.deepEqual(reopened.cols, restored.cols);
  assert.equal(reopened.caption, 'Table 1: Final caption', 'the caption survives reopening the .mslides file');
  console.log('PASS persistence (autosave, restart, .mslides save/open)');

  // ---- PPTX: native editable table (feasibility spike) ----
  await evaluate("document.querySelector('.export-menu > button').click()"); await pause(200);
  await evaluate("document.querySelector('.pop .menu-item:nth-child(2)').click()");
  const pptx = await until(() => evaluate("Object.keys(testFiles).find(k => k.endsWith('.pptx'))"), 'PPTX export', 30000);
  await until(() => evaluate(`testFiles[${JSON.stringify(pptx)}]?.length > 1000`), 'PPTX bytes', 30000);
  await writeFile(path.join(output, 'table.pptx'), Buffer.from(await evaluate(`testFiles[${JSON.stringify(pptx)}]`)));
  const zip = await JSZip.loadAsync(await readFile(path.join(output, 'table.pptx')));
  const deckSlides = await evaluate('store.getState().deck.slides');
  const no = deckSlides.findIndex((s) => s.elements.some((e) => e.type === 'table')) + 1;
  const xml = await zip.file(`ppt/slides/slide${no}.xml`).async('string');
  const tbl = /<a:tbl>[\s\S]*<\/a:tbl>/.exec(xml)?.[0];
  assert.ok(tbl, 'the slide contains a native <a:tbl>');
  assert.match(xml, /<p:graphicFrame>[\s\S]*name="Table"/, 'as a graphic frame (editable table), not a text box');
  const R = await T();
  assert.deepEqual([...tbl.matchAll(/<a:gridCol w="(\d+)"/g)].map((m) => Number(m[1])), R.cols.map((c) => Math.round(c / 96 * 914400)), 'column widths are the model widths');
  const trs = [...tbl.matchAll(/<a:tr h="(\d+)">/g)].map((m) => Number(m[1]));
  assert.equal(trs.length, R.rows.length, 'one <a:tr> per row'); assert.ok(trs.every((h) => h > 0), 'row heights present');
  assert.equal([...tbl.matchAll(/<a:tc>/g)].length, R.rows.length * R.cols.length, 'one <a:tc> per cell');
  const cell = (r, c) => [...tbl.matchAll(/<a:tr [\s\S]*?<\/a:tr>/g)][r][0].match(/<a:tc[ >][\s\S]*?<\/a:tc>/g)[c];
  assert.match(cell(0, 0), /<a:t>Name<\/a:t>/); assert.match(cell(0, 0), /b="1"/, 'header text is bold'); assert.match(cell(2, 0), /<a:t>undo me<\/a:t>/); assert.doesNotMatch(cell(2, 0), /<a:rPr[^>]* b="1"/, 'body rows are not bold');
  assert.match(cell(0, 0), /<a:lnB[^>]*>\s*<a:solidFill>/, 'bottom border is a solid line'); assert.match(cell(0, 0), /<a:lnL[^>]*>\s*<a:noFill\/>/, 'no vertical line (left)'); assert.match(cell(0, 0), /<a:lnR[^>]*>\s*<a:noFill\/>/, 'no vertical line (right)');
  assert.ok(!xml.includes('<p:pic>'), 'not rasterized');
  assert.doesNotMatch(tbl, /prstDash val="(dash|sysDash|dashDot|lgDash|sysDot)"/, 'no dashed guide lines in the exported table'); assert.ok(!/2F6FEB/i.test(tbl), 'no editor-blue in the exported table');
  const outside = xml.replace(tbl, '');
  assert.ok(!outside.includes('>Name<'), 'cell text is not duplicated as a free text box');
  console.log('PASS PPTX spike: native <a:tbl>, widths, row heights, minimal borders, bold header, not a text box');
  console.log('OUTPUT', output);
} catch (error) {
  console.error(error); console.log('OUTPUT', output);
  process.exitCode = 1;
} finally {
  socket?.close();
  if (electron && electron.exitCode === null) { electron.kill('SIGTERM'); await new Promise((r) => electron.once('exit', r)); }
  await server.close();
}
