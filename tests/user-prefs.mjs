/** Quick Emojis (user-scoped preference): toolbar, editing, reset, persistence boundary, fallback.
 * Real Electron windows on a disposable profile (never the user's data). Run: node tests/user-prefs.mjs
 * Needs a graphical session (on a shared Linux box: xvfb-run -a node tests/user-prefs.mjs).
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { testElectronEnv } from './electron-env.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-prefs-profile-'));
const probe = netServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const debugPort = probe.address().port;
await new Promise((r) => probe.close(r));
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: 5188, strictPort: true } });
await server.listen();
const wrapper = path.join(profile, 'main.cjs');
await writeFile(wrapper, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});\n`);

const DEFAULTS = ['💡', 'ℹ️', '⚠️', '✅', '❌', '📌', '🔥', '💬', '⭐', '🚀'];
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
  electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`], { cwd: root, env: testElectronEnv({ ELECTRON_DEV_URL: 'http://127.0.0.1:5188' }), stdio: ['ignore', 'pipe', 'pipe'] });
  electron.stderr.on('data', () => {});
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 'debug target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => { const d = JSON.parse(e.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(Error(d.error.message)) : p.resolve(d.result); } });
  await send('Runtime.enable');
  await until(() => evaluate(`!!document.querySelector('.propsbar')`), 'app mount');
  await evaluate(`(async () => { window.store = (await import('/src/store/store.ts')).useStore; window.active = (await import('/src/editor/active.ts')).getActiveEditor; window.defaults = await import('/src/model/defaults.ts'); window.idb = await import('/node_modules/idb-keyval/dist/index.js'); })()`);
}
async function quit() { socket?.close(); if (electron.exitCode === null) { electron.kill('SIGTERM'); await new Promise((r) => electron.once('exit', r)); } }
const down = (sel, i = 0) => evaluate(`document.querySelectorAll(${JSON.stringify(sel)})[${i}].dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}))`);
const quickRow = () => evaluate(`[...document.querySelectorAll('.el.editing .callout-icons button')].map((b) => b.textContent)`);
const quickEmojis = async () => (await quickRow()).slice(0, 10);
/** Put a callout (icon 🔥) in a fresh text box and open its quick row. */
async function openRow() {
  await evaluate(`store.getState().addElements([defaults.newText(64,540,{w:900,doc:{type:'doc',content:[{type:'callout',attrs:{icon:'🔥'},content:[{type:'paragraph',content:[{type:'text',text:'note'}]}]}]}})],{edit:true})`);
  await until(() => evaluate('!!active()'), 'editor'); await pause(300);
  await down('.el.editing .callout-icon'); await pause();
}
async function pickFromPicker(query) {
  await until(() => evaluate(`!!document.querySelector('.emoji-picker .emoji-search')`), 'picker open');
  await evaluate(`document.querySelector('.emoji-picker .emoji-search').focus()`);
  await send('Input.insertText', { text: query });
  await until(() => evaluate(`!!document.querySelector('.emoji-picker .emoji-grid button')`), 'picker results');
  const picked = await evaluate(`(() => { const b = document.querySelector('.emoji-picker .emoji-grid button'); const t = b.textContent; b.click(); return t; })()`);
  await pause(250); return picked;
}
const deckJson = () => evaluate('JSON.stringify(store.getState().deck)');
const stored = () => evaluate(`idb.get('prefs:v1').then((v) => JSON.stringify(v ?? null))`);

try {
  await launch();
  // --- defaults: untouched install shows exactly the v1 row; ✎ sits directly left of ⋯ ---
  await openRow();
  assert.deepEqual(await quickRow(), [...DEFAULTS, '✎', '⋯'], 'default 10 + edit + more, edit left of more');
  assert.equal(await stored(), 'null', 'nothing is stored until the user customizes');
  console.log('PASS default quick row = v1 10 emojis; ✎ immediately left of ⋯');

  // --- edit two slots through the existing full picker ---
  await until(() => evaluate("store.getState().saveState === 'saved'"), 'autosave settled'); // baseline after the setup edit has been autosaved
  const deckBefore = await deckJson(), saveBefore = await evaluate('store.getState().saveState');
  const histBefore = await evaluate('active().can().undo()');
  await down('.callout-icons .edit'); await pause();
  assert.equal(await evaluate(`document.querySelectorAll('.callout-icons .slot').length`), 10, 'edit mode: 10 slots');
  assert.equal(await evaluate(`document.querySelector('.callout-icons .slot.on') && [...document.querySelectorAll('.callout-icons .slot')].indexOf(document.querySelector('.callout-icons .slot.on'))`), 0, 'slot 1 marked while editing');
  await down('.callout-icons .slot', 2); await pause();
  assert.equal(await evaluate(`[...document.querySelectorAll('.callout-icons .slot')].indexOf(document.querySelector('.callout-icons .slot.on'))`), 2, 'edited slot is highlighted');
  const brain = await pickFromPicker('brain');
  await down('.callout-icons .slot', 9); await pause();
  const robot = await pickFromPicker('robot');
  const custom = [...DEFAULTS]; custom[2] = brain; custom[9] = robot;
  assert.deepEqual(await quickEmojis(), custom, 'slots replaced in place, live in the open toolbar');
  assert.equal(await evaluate(`document.querySelector('.callout .callout-icon').textContent`), '🔥', 'existing callout keeps its icon');
  assert.equal(await deckJson(), deckBefore, 'deck untouched by preference edits');
  assert.equal(await evaluate('store.getState().saveState'), saveBefore, 'presentation not dirtied');
  assert.equal(await evaluate('active().can().undo()'), histBefore, 'no document undo step created');
  assert.ok(!(await deckJson()).includes(brain) && !(await deckJson()).includes(robot), 'custom emojis are not in the deck');
  console.log('PASS slot editing via full picker; live update; callout/deck/dirty/undo unaffected');

  // ⋯ still opens the full picker and selecting there changes only the callout icon
  await down('.callout-icons .done'); await pause();
  assert.deepEqual(await quickEmojis(), custom, 'row after Done shows custom set');
  await down('.callout-icons .more'); await pause();
  const other = await pickFromPicker('rocket');
  assert.equal(await evaluate(`document.querySelector('.callout .callout-icon').textContent`), other, 'full picker still sets the icon');
  assert.deepEqual((await stored()).includes(brain), true, 'stored in prefs:v1');
  console.log('PASS ⋯ full picker unchanged');

  // --- new presentation keeps preference ---
  await evaluate(`document.querySelector('.logo').click()`); await pause(300);
  await evaluate(`[...document.querySelectorAll('.menu-item')].find((e) => e.textContent.includes('새 프레젠테이션')).click()`); await pause(700);
  await openRow();
  assert.deepEqual(await quickEmojis(), custom, 'preference survives New Presentation');
  console.log('PASS survives New Presentation');

  // --- restart keeps preference ---
  await pause(600); await quit(); await launch();
  await openRow();
  assert.deepEqual(await quickEmojis(), custom, 'preference survives restart');
  console.log('PASS survives restart');

  // --- reset to default ---
  await down('.callout-icons .edit'); await pause();
  await down('.callout-icons .reset'); await pause();
  assert.deepEqual(await quickEmojis(), DEFAULTS, 'reset restores v1 defaults in the open toolbar');
  assert.equal(await evaluate(`document.querySelector('.callout .callout-icon').textContent`), '🔥');
  assert.ok(!(await stored()).includes('quickEmojis'), 'stored override removed');
  console.log('PASS reset to default');

  // --- malformed stored data falls back to defaults without breaking startup ---
  for (const bad of ['"nope"', '[1,2,3]', '{"quickEmojis":"x"}', '{"quickEmojis":["a"]}', '{"quickEmojis":[1,2,3,4,5,6,7,8,9,10]}']) {
    await pause(300);
    await evaluate(`idb.set('prefs:v1', JSON.parse(${JSON.stringify(bad)}))`);
    await quit(); await launch(); await openRow();
    assert.deepEqual(await quickEmojis(), DEFAULTS, 'fallback for ' + bad);
  }
  // A partially unusable entry only falls back for that slot.
  await evaluate(`idb.set('prefs:v1', {quickEmojis: ['🧠', 5, ...${JSON.stringify(DEFAULTS.slice(2))}]})`);
  await quit(); await launch(); await openRow();
  assert.deepEqual(await quickEmojis(), ['🧠', DEFAULTS[1], ...DEFAULTS.slice(2)], 'per-slot fallback');
  console.log('PASS malformed preference data falls back safely');
  console.log('ALL PASS');
} finally {
  await quit().catch(() => {});
  await server.close();
}
