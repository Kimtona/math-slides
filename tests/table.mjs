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
const mouse = (type, p, extra = {}) => send('Input.dispatchMouseEvent', { type, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...p, ...extra });
const clickCell = async (t, r, c) => { const p = await center(td(t, r, c)); await mouse('mousePressed', p); await mouse('mouseReleased', p); await pause(350); };
const drag = async (from, dx, dy) => { await mouse('mousePressed', from); for (const k of [0.25, 0.5, 0.75, 1]) await mouse('mouseMoved', { x: from.x + dx * k, y: from.y + dy * k }); await mouse('mouseReleased', { x: from.x + dx, y: from.y + dy }); await pause(350); };
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
