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
  assert.ok(Math.abs(info.h - t.h) <= 1, `stored height ${t.h} follows the rendered height ${info.h}`);
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
  assert.equal(JSON.stringify(restored), expected, 'table identical after autosave + restart');
  await domMatches({ ...restored, h: restored.h });
  await evaluate('persist.saveProject()'); await pause(800);
  const fileName = await evaluate("Object.keys(testFiles).find(k => k.endsWith('.mslides'))");
  const fileText = Buffer.from(await evaluate(`testFiles[${JSON.stringify(fileName)}]`)).toString('utf8');
  assert.match(fileText, /"type":"table"/, 'the .mslides file contains the table');
  await evaluate('persist.newProject()'); await pause(600);
  assert.equal((await tables()).length, 0, 'a new presentation has no table');
  await evaluate(`persist.openFromText(${JSON.stringify(fileText)}, null)`); await pause(800);
  const reopened = await T(); assert.ok(reopened, 'table reopened from the .mslides file');
  assert.equal(JSON.stringify(reopened.rows), JSON.stringify(restored.rows)); assert.deepEqual(reopened.cols, restored.cols);
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
