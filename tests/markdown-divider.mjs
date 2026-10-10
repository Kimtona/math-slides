/** Markdown divider (`---` / `/divider`): shortcut rules, line model, undo/redo, duplicate, persistence, PPTX.
 * Real Electron windows on a disposable profile. Run: node tests/emoji-tool.mjs (needs a graphical session).
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
import JSZip from 'jszip';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-divider-profile-'));
const probe = netServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const debugPort = probe.address().port;
await new Promise((r) => probe.close(r));
const vitePort = await (async () => { const p = netServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const n = p.address().port; await new Promise((r) => p.close(r)); return n; })();
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: vitePort, strictPort: true } });
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
  electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`], { cwd: root, env: testElectronEnv({ ELECTRON_DEV_URL: `http://127.0.0.1:${vitePort}` }), stdio: ['ignore', 'pipe', 'pipe'] });
  electron.stderr.on('data', () => {});
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 'debug target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => { const d = JSON.parse(e.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(Error(d.error.message)) : p.resolve(d.result); } });
  await send('Runtime.enable');
  await until(() => evaluate(`!!document.querySelector('.propsbar')`), 'app mount');
  await evaluate(`(async () => {
    window.store = (await import('/src/store/store.ts')).useStore; window.active = (await import('/src/editor/active.ts')).getActiveEditor;
    window.defaults = await import('/src/model/defaults.ts'); window.insert = await import('/src/canvas/insert.ts');
    window.testFiles = {};
    window.showSaveFilePicker = async ({suggestedName}) => ({name:suggestedName,createWritable:async()=>({write:async(blob)=>{testFiles[suggestedName]=[...new Uint8Array(await blob.arrayBuffer())]},close:async()=>{}})});
  })()`);
}
async function quit() { socket?.close(); if (electron?.exitCode === null) { electron.kill('SIGTERM'); await new Promise((r) => electron.once('exit', r)); } }

const els = () => evaluate(`store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements`);
const lines = async () => (await els()).filter((e) => e.type === 'line');
const settled = () => until(() => evaluate("store.getState().saveState === 'saved'"), 'autosave settled');
const key = async (k, text) => {
  const vk = { Enter: 13, Backspace: 8 }[k];
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text, windowsVirtualKeyCode: vk ?? (text && /[a-z0-9 ]/i.test(text) ? text.toUpperCase().charCodeAt(0) : 0) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: vk ?? 0 });
  await pause(40);
};
const type = async (s) => { for (const c of s) await key(c === '\n' ? 'Enter' : c, c === '\n' ? '\r' : c); };
const docText = () => evaluate(`active().getText()`);
/** Open a new text box on the slide with the given doc; caret at the end. */
async function openBox(doc, y = 200) {
  await evaluate(`store.getState().addElements([defaults.newText(64, ${y}, {w: 600, doc: ${JSON.stringify(doc)}})], {edit: true})`);
  await until(() => evaluate('!!active()'), 'editor'); await pause(250);
  await evaluate(`active().commands.focus('end')`); await pause(100);
}
const para = (t, extra = {}) => ({ type: 'paragraph', ...(t ? { content: [{ type: 'text', text: t, ...extra }] } : {}) });
const D = (...c) => ({ type: 'doc', content: c });
async function finish() { await evaluate('store.getState().stopEditing()'); await pause(150); }

try {
  await launch();
  const base = (await els()).length, baseLines = (await lines()).length;

  // --- `---` + Space in a box that holds only the shortcut: box becomes the divider ---
  await openBox(D(para('')));
  const past0 = await evaluate('store.getState().past.length');
  await type('--- ');
  await pause(300);
  let ls = await lines();
  assert.equal(ls.length, baseLines + 1, 'exactly one divider created by ---+Space');
  const d = ls[ls.length - 1];
  assert.equal(d.stroke, '#D1D5DB'); assert.equal(d.strokeWidth, 1); assert.equal(d.arrowEnd, false); assert.equal(d.arrowStart, false); assert.equal(d.dashed, false);
  assert.equal(d.y1, d.y2, 'horizontal'); assert.equal(d.h, 0); assert.ok(d.x1 >= 0 && d.x2 <= 1280 && d.y1 >= 0 && d.y1 <= 720, 'inside slide: ' + JSON.stringify(d));
    assert.equal(d.x1, 64, '5% left margin'); assert.equal(d.x2, 1216, '5% right margin'); assert.equal(d.x2 - d.x1, 1152, '90% of the 1280px slide'); assert.equal(d.role, 'divider', 'divider identity');
  assert.ok(Math.abs(d.y1 - 200) < 60, 'near where it was typed: ' + d.y1);
  assert.equal((await els()).length, base + 1, 'no empty text box left behind (box replaced by the divider)');
  assert.equal(await evaluate('!!active()'), false, 'editing ended');
  assert.deepEqual(await evaluate('store.getState().selection'), [d.id], 'divider selected');
  assert.equal(await evaluate('store.getState().past.length'), past0 + 1, 'creation is one undo step');
  console.log('PASS --- + Space creates one divider (model + geometry), no leftover box');

  // --- undo / redo: one logical step ---
  await evaluate('store.getState().undo()'); await pause(200);
  assert.equal((await lines()).length, baseLines, 'undo removes divider');
  assert.equal((await els()).length, base, 'undo leaves no orphan/empty box');
  await evaluate('store.getState().redo()'); await pause(200);
  assert.equal((await lines()).length, baseLines + 1, 'redo restores divider');
  assert.equal((await els()).length, base + 1);
  assert.deepEqual((await lines()).pop(), d, 'redo restores identical element');
  console.log('PASS undo/redo is one step');

  // --- editing: select / move / horizontal resize / duplicate / delete ---
  await evaluate(`store.getState().select([${JSON.stringify(d.id)}])`); await pause(200);
  await evaluate(`store.getState().updateElements([${JSON.stringify(d.id)}], (e) => { e.x1 += 10; e.x2 += 10; e.y1 += 5; e.y2 += 5; e.x += 10; e.y += 5; })`);
  const m = (await lines()).pop(); assert.equal(m.x1, d.x1 + 10); assert.equal(m.y1, d.y1 + 5);
  await evaluate('insert.duplicateSelection()'); await pause(200);
  ls = await lines(); assert.equal(ls.length, baseLines + 2, 'duplicate'); assert.equal(ls[ls.length - 1].stroke, '#D1D5DB'); assert.equal(ls[ls.length - 1].strokeWidth, 1);
  await evaluate('store.getState().deleteSelection()'); await pause(150);
  assert.equal((await lines()).length, baseLines + 1, 'delete');
  console.log('PASS move / duplicate / delete');

  // --- `---` + Enter, in a box with other text: editing continues below, text kept ---
  await openBox(D(para('Title'), para('')), 300);
  await evaluate(`active().commands.focus('end')`);
  const n1 = (await lines()).length;
  await type('---\n'); await pause(300);
  assert.equal((await lines()).length, n1 + 1, 'exactly one divider from ---+Enter');
  { const e = (await lines()).at(-1); assert.deepEqual([e.x1, e.x2, e.role, e.stroke, e.strokeWidth], [64, 1216, 'divider', '#D1D5DB', 1], 'Enter creates the same divider'); }
  assert.equal(await evaluate('!!active()'), true, 'still editing');
  const t = await evaluate(`active().getJSON().content.map((p) => (p.content ?? []).map((c) => c.text).join(''))`);
  assert.deepEqual(t.slice(0, 1), ['Title']); assert.ok(!t.join('').includes('-'), 'no hyphens left in text: ' + JSON.stringify(t));
  await type('after'); await pause(100);
  assert.equal(await evaluate(`active().getJSON().content.at(-1).content[0].text`), 'after', 'caret continues on the line below');
  await finish();
  assert.equal((await lines()).length, n1 + 1, 'still one divider after finishing');
  console.log('PASS --- + Enter (one divider, text kept, flow continues)');

  // --- non-matching contexts ---
  const none = async (label, doc, typed, expectText) => {
    await openBox(doc, 420);
    const n = (await lines()).length;
    await type(typed); await pause(200);
    assert.equal((await lines()).length, n, label + ': no divider');
    if (expectText !== undefined) assert.equal(await docText(), expectText, label + ': text unchanged');
    await finish();
  };
  await none('inside sentence', D(para('a')), '--- ', undefined);
  await none('extra text', D(para('x')), '--- ', undefined);
  await none('four hyphens', D(para('')), '---- ', '---- ');
  await none('four hyphens + enter', D(para('')), '----\n', undefined);
  await none('two hyphens', D(para('')), '-- ', '-- ');
  await none('text after', D(para('')), 'ab---\n', undefined);
  await none('code block', D({ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }), '\n--- ', undefined);
  await none('code block enter', D({ type: 'codeBlock' }), '---\n', undefined);
  await none('inline code', D(para('')), '', undefined);
  // inline code mark
  await openBox(D({ type: 'paragraph', content: [{ type: 'text', text: '---', marks: [{ type: 'code' }] }] }), 420);
  { const n = (await lines()).length; await type('\n'); await pause(150); assert.equal((await lines()).length, n, 'code span: no divider'); await finish(); }
  // nested contexts (callout, list)
  await none('callout', D({ type: 'callout', attrs: { icon: '💡' }, content: [para('')] }), '---\n', undefined);
  await none('bullet list', D({ type: 'bulletList', content: [{ type: 'listItem', content: [para('')] }] }), '---\n', undefined);
  console.log('PASS non-matching text / code / nested contexts leave text alone');

  // --- IME composition does not trigger ---
  await openBox(D(para('--')), 420);
  { const n = (await lines()).length;
    await send('Input.imeSetComposition', { text: '-', selectionStart: 1, selectionEnd: 1 }); await pause(80);
    await send('Input.insertText', { text: '- ' }); await pause(200);
    assert.equal((await lines()).length, n, 'IME-committed text is not a shortcut trigger');
    await finish(); }
  console.log('PASS IME composition does not trigger');

  // --- existing shortcuts: heading + slash ---
  await openBox(D(para('')), 420);
  await type('## '); await pause(150);
  assert.ok(await evaluate(`active().getJSON().content[0].attrs.fontSize > 0`), '## still sizes the line: ' + await evaluate('JSON.stringify(active().getJSON())'));
  await finish();
  await openBox(D(para('')), 450);
  await type('/code'); await pause(200);
  assert.ok(await evaluate(`!!document.querySelector('.slash-menu')`), 'slash menu still opens');
  await finish();
  console.log('PASS heading shortcut + slash menu unaffected');

  // --- /divider shares the same creation path ---
  await openBox(D(para('')), 500);
  const n2 = (await lines()).length;
  await type('/divider'); await pause(250);
  assert.equal(await evaluate(`document.querySelector('.slash-item.active .slash-name')?.textContent`), 'Divider');
  await key('Enter', '\r'); await pause(300);
  ls = await lines(); assert.equal(ls.length, n2 + 1, '/divider creates one line');
  const sd = ls[ls.length - 1]; assert.equal(sd.x1, 64); assert.equal(sd.x2, 1216); assert.equal(sd.role, 'divider'); assert.equal(sd.stroke, d.stroke); assert.equal(sd.strokeWidth, 1); assert.equal(sd.y1, sd.y2);
  assert.equal((await els()).filter((e) => e.type === 'text' && !e.doc.content.some((c) => c.content?.length)).length, 0, 'no empty text box');
  console.log('PASS /divider -> identical element');

  // --- /divider unsupported contexts: hidden, never swallows text ---
  const slashNames = () => evaluate(`[...document.querySelectorAll('.slash-menu .slash-name')].map((e) => e.textContent)`);
  for (const [label, doc, typed] of [
    ['bullet list', D({ type: 'bulletList', content: [{ type: 'listItem', content: [para('')] }] }), '/divid'],
    ['callout', D({ type: 'callout', attrs: { icon: '💡' }, content: [para('')] }), '/divid'],
    ['text after command', D(para('x')), '/divid'],
  ]) {
    await openBox(doc, 460);
    const n = (await lines()).length;
    await type(typed); await pause(200);
    assert.ok(!(await slashNames()).includes('Divider'), label + ': Divider hidden');
    await key('Escape'); await finish();
    assert.equal((await lines()).length, n);
  }
  // Execution re-validates: forcing the command in a nested paragraph keeps the typed text.
  await openBox(D({ type: 'bulletList', content: [{ type: 'listItem', content: [para('/divider')] }] }), 460);
  { const n = (await lines()).length;
    await evaluate(`(async () => { const m = await import('/src/editor/SlashMenu.tsx'); const ed = active(); const r = { from: ed.state.selection.$from.start(), to: ed.state.selection.$from.end() }; m.__runItem('Divider', ed, r); })()`);
    await pause(150);
    assert.equal((await lines()).length, n); assert.equal((await docText()).trim(), '/divider', 'command text not destroyed'); await finish(); }
  console.log('PASS /divider hidden in nested contexts, text preserved');

  // --- endpoint dragging ---
  const handleXY = (h) => evaluate(`(() => { const r = document.querySelectorAll('.slide.editable .handle.round')[${h}].getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
  const slideScale = await evaluate(`document.querySelector('.slide.editable').getBoundingClientRect().width / 1280`);
  const mouse = (type, p, mods = 0, buttons = 1) => send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : buttons, modifiers: mods, ...p });
  const ALT = 1, SHIFT = 8;
  const mk = async (el) => { await evaluate(`store.getState().addElements([${JSON.stringify(el)}])`); await pause(200); return (await lines()).at(-1); };
  const slideOrigin = await evaluate(`(() => { const r = document.querySelector('.slide.editable').getBoundingClientRect(); return {x: r.x, y: r.y}; })()`);
  const at = (x, y) => ({ x: slideOrigin.x + x * slideScale, y: slideOrigin.y + y * slideScale });
  const getL = async (id) => (await lines()).find((l) => l.id === id);
  const keyMod = async (type, k, mods) => send('Input.dispatchKeyEvent', { type, key: k, modifiers: mods, windowsVirtualKeyCode: k === 'Alt' ? 18 : 16 });
  // Divider
  const dv = await evaluate(`defaults.newDivider(400)`);
  await mk(dv);
  const pastD = await evaluate('store.getState().past.length');
  await evaluate(`store.getState().select([${JSON.stringify(dv.id)}])`); await pause(200);
  let h1 = await handleXY(1);
  await mouse('mousePressed', h1);
  await mouse('mouseMoved', at(1000, 460), 0); await mouse('mouseMoved', at(900, 470), 0);
  let l = await getL(dv.id);
  assert.equal(l.y2, 400, 'Y stays equal to the fixed endpoint'); assert.equal(l.y1, 400); assert.equal(l.x1, dv.x1, 'opposite endpoint fixed'); assert.ok(Math.abs(l.x2 - 900) <= 6, 'x follows pointer ' + l.x2);
  await mouse('mouseMoved', at(800, 520), ALT);
  l = await getL(dv.id); assert.ok(Math.abs(l.x2 - 800) <= 1 && Math.abs(l.y2 - 520) <= 1, 'Option: free angle ' + JSON.stringify(l)); assert.equal(l.x1, dv.x1); assert.equal(l.y1, 400);
  await keyMod('keyUp', 'Alt', 0); await pause(80);
  l = await getL(dv.id); assert.equal(l.y2, 400, 'releasing Option re-straightens immediately'); assert.ok(Math.abs(l.x2 - 800) <= 1);
  await keyMod('keyDown', 'Alt', ALT); await pause(80);
  l = await getL(dv.id); assert.ok(Math.abs(l.y2 - 520) <= 1, 'pressing Option again goes back to the pointer'); 
  await mouse('mouseMoved', at(700, 300), ALT); await mouse('mouseMoved', at(700, 300), 0);
  l = await getL(dv.id); assert.equal(l.y2, 400); await mouse('mouseMoved', at(750, 380), ALT);
  await mouse('mouseReleased', at(750, 380), ALT);
  const diag = await getL(dv.id); assert.ok(diag.y2 !== diag.y1, 'ended diagonal'); assert.equal(diag.role, 'divider');
  assert.equal(await evaluate('store.getState().past.length'), pastD + 1, 'whole endpoint drag is one undo step');
  // left endpoint, no Option: horizontal
  await evaluate(`store.getState().updateElements([${JSON.stringify(dv.id)}], (e) => { e.y2 = e.y1; e.y = e.y1; e.h = 0; e.x2 = 1000; e.w = 1000 - e.x1; })`);
  await pause(150);
  let h0 = await handleXY(0);
  await mouse('mousePressed', h0); await mouse('mouseMoved', at(300, 600)); await mouse('mouseMoved', at(250, 650)); await mouse('mouseReleased', at(250, 650));
  l = await getL(dv.id); assert.equal(l.y1, l.y2, 'left endpoint stays horizontal'); assert.equal(l.x2, 1000, 'right endpoint fixed'); assert.ok(Math.abs(l.x1 - 250) <= 6);
  // undo / redo restore geometry
  const afterLeft = l;
  await evaluate('store.getState().undo()'); await pause(150);
  assert.equal((await getL(dv.id)).x1, 64, 'undo restores x1'); 
  await evaluate('store.getState().redo()'); await pause(150);
  assert.deepEqual(await getL(dv.id), afterLeft, 'redo restores');
  // duplicate keeps identity; move keeps role
  await evaluate('insert.duplicateSelection()'); await pause(200);
  assert.equal((await lines()).at(-1).role, 'divider', 'duplicate keeps identity');
  await evaluate('store.getState().deleteSelection()'); await pause(100);
  console.log('PASS divider endpoint drag: horizontal, Option free, toggling, fixed opposite, undo/redo, duplicate');

  // legacy / saved diagonal divider is not straightened
  const dg = { ...(await evaluate(`defaults.newDivider(500)`)), y2: 560, h: 60 };
  await mk(dg);
  assert.equal((await getL(dg.id)).y2, 560, 'diagonal divider stays diagonal when loaded/added');

  // ordinary line: free by default, Shift snaps 45deg, release restores
  const ln = await mk(await evaluate(`defaults.newLine(300, 300, 500, 300)`));
  await evaluate(`store.getState().select([${JSON.stringify(ln.id)}])`); await pause(200);
  assert.equal(ln.role, undefined);
  let p2 = await handleXY(1);
  await mouse('mousePressed', p2);
  await mouse('mouseMoved', at(560, 340)); await mouse('mouseMoved', at(600, 380));
  l = await getL(ln.id); assert.ok(Math.abs(l.x2 - 600) <= 1 && Math.abs(l.y2 - 380) <= 1, 'ordinary line is free: ' + JSON.stringify(l));
  await mouse('mouseMoved', at(600, 340), SHIFT);
  l = await getL(ln.id); assert.equal(l.x1, 300); assert.equal(l.y1, 300);
  assert.ok(Math.abs((l.y2 - 300) / (l.x2 - 300) - 0.0) < 0.01 || Math.abs(Math.abs(l.y2 - 300) - Math.abs(l.x2 - 300)) <= 1 || l.x2 === 300, 'Shift: multiple of 45deg ' + JSON.stringify(l));
  await mouse('mouseMoved', at(600, 380), 0);
  l = await getL(ln.id); assert.ok(Math.abs(l.y2 - 380) <= 1, 'Shift released: free again');
  await mouse('mouseReleased', at(600, 380));
  // all quadrants / both endpoints through the same snap math: drag p1 around fixed p2 with Shift
  const angles = [];
  for (const [px, py] of [[800, 410], [700, 305], [610, 200], [500, 305], [400, 390], [500, 495], [590, 600], [700, 505]]) {
    const q = await mk(await evaluate(`defaults.newLine(500, 400, 600, 400)`));
    await evaluate(`store.getState().select([${JSON.stringify(q.id)}])`); await pause(150);
    const hp = await handleXY(0);
    await mouse('mousePressed', hp); await mouse('mouseMoved', at(px, py), SHIFT); await mouse('mouseMoved', at(px + 1, py + 1), SHIFT); await mouse('mouseReleased', at(px + 1, py + 1), SHIFT);
    const r = await getL(q.id); const dx = r.x1 - r.x2, dy = r.y1 - r.y2;
    assert.equal(r.x2, 600); assert.equal(r.y2, 400, 'fixed endpoint');
    assert.ok(dx === 0 || dy === 0 || Math.abs(Math.abs(dx) - Math.abs(dy)) <= 1, `p1 Shift snap (${px},${py}) -> ${dx},${dy}`);
    angles.push([Math.sign(dx), Math.sign(dy)].join());
    await evaluate('store.getState().deleteSelection()'); await pause(80);
  }
  assert.ok(new Set(angles).size === 8, 'covers all directions: ' + angles);
  console.log('PASS ordinary line: free by default, Shift snaps to 45deg, release frees, both endpoints/quadrants');

  // --- PPTX + persistence ---
  await settled();
  await evaluate("import('/src/export/run.ts').then((m) => m.exportPptx())");
  const name = await evaluate('store.getState().deck.title');
  await until(() => evaluate(`testFiles[${JSON.stringify(name + '.pptx')}]?.length > 1000`), 'PPTX export', 30000);
  const zip = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(name + '.pptx')}]`)));
  const slideNo = await evaluate('store.getState().deck.slides.findIndex((s) => s.id === store.getState().currentSlideId) + 1');
  const xml = await zip.file(`ppt/slides/slide${slideNo}.xml`).async('string');
  const cxns = [...xml.matchAll(/<p:cxnSp>[\s\S]*?<\/p:cxnSp>|<p:sp>(?:(?!<\/p:sp>)[\s\S])*?prst="line"[\s\S]*?<\/p:sp>/g)].map((x) => x[0]);
  const hit = cxns.find((x) => x.includes('D1D5DB'));
  assert.ok(hit, 'PPTX has a line with the divider color');
  assert.ok(/<a:ln w="9525"/.test(hit), '1px stroke = 9525 EMU; got: ' + hit.match(/<a:ln [^>]*>/));
  const w = Number(/<a:ext cx="(\d+)"/.exec(hit)[1]), cy = Number(/<a:ext cx="\d+" cy="(\d+)"/.exec(hit)[1]), off = /<a:off x="(\d+)" y="(\d+)"/.exec(hit);
  const cur = (await lines()).filter((e) => e.stroke === '#D1D5DB');
  assert.ok(cur.some((e) => Math.abs(w - (e.x2 - e.x1) * 9525) < 2000 && cy === 0 && Math.abs(Number(off[1]) - e.x1 * 9525) < 2000), 'PPTX geometry matches model');
  console.log('PASS PPTX export (position, length, color, width)');

  const before = (await lines()).filter((e) => e.stroke === '#D1D5DB');
  assert.ok(before.some((e) => e.role === 'divider' && e.y1 !== e.y2), 'diagonal divider present before restart');
  await settled(); await pause(600); await quit(); await launch();
  const after = (await lines()).filter((e) => e.stroke === '#D1D5DB');
  assert.deepEqual(after, before, 'dividers (incl. role and saved diagonal) survive save/reopen unchanged');
  console.log('PASS persistence');
  console.log('ALL PASS');
} finally {
  await quit().catch(() => {});
  await server.close();
}
