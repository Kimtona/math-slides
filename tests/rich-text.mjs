/** Electron integration checks. Uses a disposable profile; never opens the user's autosave.
 * Run: node tests/rich-text.mjs. Requires installed dependencies and a graphical session.
 * Set MATHSLIDES_TEST_OUTPUT to retain screenshots, PDF, PPTX and .mslides fixtures.
 */
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

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.MATHSLIDES_TEST_OUTPUT || await mkdtemp(path.join(tmpdir(), 'mathslides-rich-text-'));
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-profile-'));
// Choose a fresh debugging port; never connect to an existing user browser/session.
const portProbe = netServer();
await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
const debugPort = portProbe.address().port;
await new Promise(r => portProbe.close(r));
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: 5187, strictPort: true } });
// Deterministic arXiv transport fixture; parsing, resolution, and rendering stay real.
const arxivXml = '<feed><entry><title>Attention Is All You Need</title><published>2017-06-12</published><author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author><author><name>Niki Parmar</name></author></entry></feed>';
await server.listen();
const wrapper = path.join(profile, 'main.cjs');
// Electron's runtime resolves "electron" itself, unlike Node's executable-path package.
await writeFile(wrapper, `const { app, dialog } = require('electron');
app.setPath('userData', ${JSON.stringify(profile)});
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://export.arxiv.org/api/') ? Promise.resolve(new Response(${JSON.stringify(arxivXml)})) : originalFetch(url, ...args);
dialog.showSaveDialog = async (_win, opts) => ({ canceled: false, filePath: ${JSON.stringify(output)} + '/' + require('path').basename(opts.defaultPath) });
require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});
// Test hooks that drive the real OS-open handlers: an open-file event before the window exists, and later requests from a trigger file.
if (process.env.TEST_OPEN_AT_START) app.emit('open-file', {preventDefault(){}}, process.env.TEST_OPEN_AT_START);
const trigger = ${JSON.stringify(path.join(profile, 'trigger.json'))};
require('fs').watchFile(trigger, {interval: 100}, () => { try {
  const t = JSON.parse(require('fs').readFileSync(trigger, 'utf8'));
  if (t.event === 'open-file') app.emit('open-file', {preventDefault(){}}, t.path); else app.emit('second-instance', {}, ['main', t.path], process.cwd());
} catch {} });\n`);
let electron, socket;
const pending = new Map();
let id = 0;
const pause = (ms = 120) => new Promise((r) => setTimeout(r, ms));
async function until(fn, message, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { try { const v = await fn(); if (v) return v; } catch {} await pause(100); }
  throw new Error(message);
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const key = ++id; pending.set(key, { resolve, reject });
    socket.send(JSON.stringify({ id: key, method, params }));
  });
}
async function evaluate(expression) {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(Error('evaluate timed out: ' + expression.slice(0, 120))), 60000)),
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function click(selector) {
  const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw Error('Missing ' + ${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...r });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...r });
  await pause();
}
async function key(key, code = key, modifiers = 0) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : undefined });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
  await pause();
}
async function screenshot(name) {
  const r = await send('Page.captureScreenshot'); await writeFile(path.join(output, name + '.png'), Buffer.from(r.data, 'base64'));
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
  await inject();
}
async function inject() {
  await evaluate(`(async () => {
    window.store = (await import('/src/store/store.ts')).useStore;
    window.active = (await import('/src/editor/active.ts')).getActiveEditor;
    window.persist = await import('/src/store/persistence.ts');
    window.defaults = await import('/src/model/defaults.ts');
    // Native OS file dialogs are supplied at the boundary; app serialization/export is unchanged.
    window.testFiles = {};
    window.showSaveFilePicker = async ({suggestedName}) => ({name:suggestedName,createWritable:async()=>({
      write:async(blob)=>{testFiles[suggestedName]=[...new Uint8Array(await blob.arrayBuffer())]},close:async()=>{}
    })});
    // Real (origin-private) file handles for the document-lifecycle checks: storable in IndexedDB, writable, deletable.
    window.__opfsDir = () => navigator.storage.getDirectory();
    window.__opfsWrite = async (name, text) => { const h = await (await __opfsDir()).getFileHandle(name, {create: true}); const w = await h.createWritable(); await w.write(text); await w.close(); return h; };
    window.__opfsRead = async (name) => (await (await (await __opfsDir()).getFileHandle(name)).getFile()).text();
  })()`);
}
async function launch({ args = [], env = {} } = {}) {
  electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`, ...args], { cwd: root, env: { ...process.env, ELECTRON_DEV_URL: 'http://127.0.0.1:5187', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  electron.stderr.on('data', () => {});
  await connect();
}
async function select(from, to = from) {
  await evaluate(`active().commands.setTextSelection({from:${from},to:${to}}); active().view.focus()`); await pause();
}
const doc = () => evaluate('active().getJSON()');
const textColor = '.propsbar button[title^="글자 색 (Text Color)"]';
const highlight = '.propsbar button[title^="강조 (Highlight)"]';
const code = '.propsbar button[title="인라인 코드 (Inline Code)"]';
const swatch = (label) => `button[aria-label="${label}"]`;
async function choose(button, label) { await click(button); await click(swatch(label)); }
async function historyCheck(before, after, name) {
  assert.notDeepEqual(after, before, name + ' changed document');
  assert.equal(await evaluate('active().commands.undo()'), true, name + ' undo available');
  assert.deepEqual(await doc(), before, name + ' undo restores exact marks');
  assert.equal(await evaluate('active().commands.redo()'), true, name + ' redo available');
  assert.deepEqual(await doc(), after, name + ' redo restores exact marks');
  console.log('PASS', name);
}
async function step(name, action) {
  // Separate commands just as independently initiated toolbar gestures are separated by time.
  await pause(550); const before = await doc(); await action(); await pause();
  const after = await doc(); await historyCheck(before, after, name); return after;
}
function marksAt(d, offset) {
  let at = 0;
  for (const n of d.content[0].content || []) { if (offset < at + (n.text?.length || 0)) return n.marks || []; at += n.text?.length || 0; }
  return [];
}
const attrAt = (d, offset, type, attr) => marksAt(d, offset).find((m) => m.type === type)?.attrs?.[attr];
try {
  await launch();
  if (process.argv.includes('--interactive')) {
    console.log('Isolated Electron profile ready for manual validation. Press Ctrl-C to close.');
    await new Promise(r => process.once('SIGINT', r));
  } else {
  await evaluate(`store.getState().updateElements([store.getState().deck.titleElementId], e => {e.style.fontSize=30; e.style.align='left'; e.y=150}); store.getState().startEditing(store.getState().deck.titleElementId, 'all')`);
  await until(() => evaluate('!!active()'), 'Text editor not active');
  await send('Input.insertText', { text: 'Policy Gradient improves the objective. Use torch.nn.Module here.' });
  await select(1, 7);
  await click(textColor);
  assert.equal(await evaluate("document.querySelectorAll('.theme-column').length"), 10);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.standard-colors button')].map(e=>e.getAttribute('aria-label'))"), ['Red','Orange','Yellow','Light Green','Green','Cyan','Blue','Purple','Pink'].map(x=>'Standard '+x));
  await screenshot('text-color-palette');
  await click(swatch('Theme Blue'));
  assert.equal(attrAt(await doc(), 0, 'textStyle', 'color'), '#3B82F6');
  assert.equal(attrAt(await doc(), 7, 'textStyle', 'color'), undefined);
  await select(1, 7);
  await step('partial standard color', () => choose(textColor, 'Standard Red'));
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(textColor)}).title`), /#DC2626/i);
  await select(1, 16);
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(textColor)}).title`), /Mixed/);
  await select(8, 16);
  await step('custom HEX with focus transfer', async () => {
    await click(textColor); await click('.palette-other'); await click('input[aria-label="HEX color"]');
    await evaluate(`const input = document.querySelector('input[aria-label="HEX color"]'); input.select()`);
    await send('Input.insertText', { text: '#oops' }); await pause();
    assert.equal(await evaluate("document.querySelector('.custom-color button').disabled"), true);
    await evaluate(`document.querySelector('input[aria-label="HEX color"]').select()`);
    await send('Input.insertText', { text: '#3B82F6' }); await pause();
    await click('.custom-color button');
  });
  assert.equal(attrAt(await doc(), 7, 'textStyle', 'color'), '#3B82F6');
  assert.equal(attrAt(await doc(), 0, 'textStyle', 'color'), '#DC2626');
  await select(1, 16);
  await step('yellow highlight', () => choose(highlight, 'Highlight Yellow'));
  await step('bold with color and highlight', () => click('.propsbar button[title="굵게 ⌘B"]'));
  await step('italic with color and highlight', () => click('.propsbar button[title="기울임 ⌘I"]'));
  await step('underline', () => click('.propsbar button[title="밑줄 ⌘U"]'));
  await step('strike', () => click('.propsbar button[title="취소선"]'));
  await select(8, 16);
  await step('change highlight color', () => choose(highlight, 'Highlight Light Green'));
  assert.equal(attrAt(await doc(), 0, 'highlight', 'color'), '#FEF08A');
  assert.equal(attrAt(await doc(), 7, 'highlight', 'color'), '#D9F99D');
  for (const name of ['Light Cyan', 'Light Pink', 'Light Purple', 'Light Gray']) await step('highlight ' + name, () => choose(highlight, 'Highlight ' + name));
  await step('remove highlight', async () => { await click(highlight); await click('.highlight-palette .palette-other'); });
  assert.ok(marksAt(await doc(), 7).some(m => m.type === 'bold'));
  assert.equal(attrAt(await doc(), 7, 'textStyle', 'color'), '#3B82F6');
  await evaluate(`const text = active().state.doc.textContent; const from=text.indexOf('torch.nn.Module')+1; active().commands.setTextSelection({from,to:from+'torch.nn.Module'.length})`); await pause();
  await step('inline code', () => click(code));
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(code)}).classList.contains('active')`), true);
  assert.equal(marksAt(await doc(), 0).some(m=>m.type === 'code'), false);
  await step('remove inline code', () => click(code));
  await step('restore inline code', () => click(code));
  await step('highlight plus inline code', () => choose(highlight, 'Highlight Light Cyan'));
  await step('color plus inline code', () => choose(textColor, 'Standard Purple'));
  await select(46);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(code)}).classList.contains('active')`), true);
  console.log('PASS palette structure, exact selections, mixed indicator and code cursor state');
  await screenshot('rich-text-editing');
  // Whole-element behavior uses deck history and must retain every unrelated mark.
  const mixed = await doc();
  await evaluate('store.getState().stopEditing()'); await pause();
  const originalDeck = await evaluate('store.getState().deck');
  await choose(textColor, 'Theme Teal');
  const coloredDeck = await evaluate('store.getState().deck');
  assert.notDeepEqual(coloredDeck, originalDeck);
  await evaluate('store.getState().undo()'); assert.deepEqual(await evaluate('store.getState().deck'), originalDeck);
  await evaluate('store.getState().redo()'); assert.deepEqual(await evaluate('store.getState().deck'), coloredDeck);
  await evaluate('store.getState().undo()');
  assert.deepEqual(await evaluate('store.getState().deck.slides[0].elements[0].doc'), mixed);
  console.log('PASS whole-element color and deck undo/redo');
  await screenshot('rich-text-static');
  // Re-enter for caret color, native copy/paste serialization, and active indicator checks.
  await evaluate('store.getState().startEditing(store.getState().deck.titleElementId)');
  await until(() => evaluate('!!active()'), 'Editor remount');
  await select(3);
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(textColor)}).title`), /#DC2626/i);
  // Caret only: the box default color changes and run colors are cleared — no per-character color marks.
  const caretColored = await step('whole-box color at caret', () => choose(textColor, 'Standard Green'));
  assert.equal(await evaluate('store.getState().deck.slides[0].elements[0].style.color'), '#16A34A');
  assert.ok(!JSON.stringify(caretColored).includes('"color":"#16A34A"'), 'caret color must not add per-character color marks');
  assert.ok(caretColored.content[0].content.every((n) => !(n.marks || []).some((m) => m.type === 'textStyle')), 'run colors cleared');
  assert.ok(marksAt(caretColored, 0).some((m) => m.type === 'highlight') && marksAt(caretColored, 7).some((m) => m.type === 'bold'), 'other marks kept');
  await evaluate('active().commands.undo()');
  assert.deepEqual(await doc(), mixed);
  // TipTap HTML roundtrip is the clipboard path; retain every supported mark.
  assert.equal(await evaluate(`(async () => {
    const {Editor} = await import('/node_modules/@tiptap/core/dist/index.js');
    const {makeExtensions} = await import('/src/editor/extensions.ts');
    const e = new Editor({extensions:makeExtensions(false),content:active().getHTML()});
    const names = new Set(); e.state.doc.descendants(n=>n.marks.forEach(m=>names.add(m.type.name)));
    const ok = ['bold','italic','underline','strike','textStyle','highlight','code'].every(m=>names.has(m)); e.destroy(); return ok;
  })()`), true);
  await evaluate('store.getState().stopEditing()');
  console.log('PASS caret indicator, caret color history and rich-text HTML roundtrip');
  // Give export fixtures stable names and nonoverlapping body content.
  await evaluate(`store.getState().commit(d=>{d.title='Formatting validation'; d.slides[0].elements[1].doc=defaults.textDoc('Mixed colors, highlights, and editable inline code');})`);
  // Add an unhighlighted code run to exercise its default background separately.
  await evaluate(`const el=defaults.newText(96,440,{w:1050,doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Run '},{type:'text',text:'python train.py',marks:[{type:'code'}]},{type:'text',text:' to train the model.'}]}]}}); store.getState().addElements([el])`);
  // Heading shortcuts are actual typed input in the normal content template.
  await click('.add-slide');
  assert.equal(await evaluate('store.getState().deck.slides[1].elements.length'), 2);
  await evaluate(`store.getState().startEditing(store.getState().deck.slides[1].elements[1].id,'all')`);
  await until(() => evaluate('!!active()'), 'Content text editor');
  for (const [prefix, size] of [['#',80],['##',50],['###',30],['####',25]]) {
    await evaluate('active().commands.selectAll(); active().commands.deleteSelection(); active().commands.updateAttributes("paragraph", {fontSize:null})');
    await send('Input.insertText', {text:prefix}); await send('Input.insertText', {text:' '}); await pause();
    assert.equal(await evaluate('active().getAttributes("paragraph").fontSize'), size);
  }
  await send('Input.insertText', {text:'Heading shortcut preserved'});
  await evaluate('store.getState().stopEditing()');
  await evaluate(`store.getState().addElements([defaults.newText(64,270)],{edit:true})`);
  await until(() => evaluate('!!active()'), 'Math text editor');
  await send('Input.insertText', {text:'/math'}); await pause(); await key('Enter');
  assert.equal(await evaluate('!!store.getState().mathEdit'), true);
  await evaluate(`(async()=>{const m=await import('/src/editor/mathNodes.ts'); const pos=store.getState().mathEdit.pos; m.setMathLatex(active(),pos,'E=mc^2'); m.commitMath(active(),pos);})()`);
  await evaluate('store.getState().stopEditing()');
  assert.equal(await evaluate("!!document.querySelector('.slide.editable .math-block svg')"), true);
  console.log('PASS Title/Content templates, heading shortcuts and /math');
  // Math Palette (Ω in the equation popover): hidden by default, cursor-aware insertion, focus kept in the textarea.
  await evaluate(`store.getState().addElements([defaults.newText(700,600,{w:400})],{edit:true})`);
  await until(() => evaluate('!!active()'), 'Palette text editor');
  const palEl = await evaluate('store.getState().editingId');
  await send('Input.insertText', {text:'/math'}); await pause(); await key('Enter'); await pause();
  assert.equal(await evaluate("!!document.querySelector('.math-popover .math-input')"), true);
  assert.equal(await evaluate("document.querySelectorAll('.math-palette').length"), 0, 'palette hidden by default');
  const taState = () => evaluate("(() => { const t = document.querySelector('.math-input'); return { v: t.value, s: t.selectionStart, e: t.selectionEnd, focus: document.activeElement === t }; })()");
  const setTa = (v, s, e = s) => evaluate(`(() => { const t = document.querySelector('.math-input'); t.focus(); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(v)}); t.dispatchEvent(new Event('input', {bubbles: true})); t.setSelectionRange(${s}, ${e}); })()`);
  const pal = (title) => evaluate(`(() => { const b = [...document.querySelectorAll('.math-pal-cell')].find((c) => c.title === ${JSON.stringify(title)}); if (!b) throw Error('no cell ' + ${JSON.stringify(title)}); b.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true})); b.click(); })()`).then(() => pause());
  const tab = (cat) => evaluate(`document.querySelector('.math-pal-tabs [data-cat=${cat}]').click()`).then(() => pause());
  await click('.math-pal-btn'); await pause();
  assert.equal(await evaluate("document.querySelectorAll('.math-palette').length"), 1, 'Ω opens the palette');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.math-pal-tabs button')].map(b => b.textContent)"), ['자주 사용', '그리스', '연산', '스타일', '구조']);
  assert.equal(await evaluate("[...document.querySelectorAll('.math-pal-cell')].every(c => c.querySelector('svg'))"), true, 'cells show rendered symbols');
  assert.equal(await evaluate("!!store.getState().mathEdit"), true, 'palette does not close the equation');
  await setTa('a+b', 1);
  await pal('rho · \\rho'); // caret insertion, not append
  assert.deepEqual(await taState(), { v: 'a\\rho+b', s: 5, e: 5, focus: true });
  await setTa('ab', 1); await pal('rho · \\rho'); // would fuse with the next letter: separated by a space
  assert.deepEqual(await taState(), { v: 'a\\rho b', s: 6, e: 6, focus: true });
  await setTa('x+y', 0, 1);
  await tab('style'); await pal('bold · \\mathbf{}'); // selection wrapped
  assert.deepEqual(await taState(), { v: '\\mathbf{x}+y', s: 10, e: 10, focus: true });
  await setTa('x', 0, 1); await pal('hat · \\hat{}');
  assert.equal((await taState()).v, '\\hat{x}');
  await setTa('', 0); await pal('text · \\text{}'); // empty template: caret inside the braces
  assert.deepEqual(await taState(), { v: '\\text{}', s: 6, e: 6, focus: true });
  await send('Input.insertText', {text: 'if'}); await pause();
  assert.equal((await taState()).v, '\\text{if}', 'typing continues inside the template');
  await tab('struct'); await setTa('', 0); await pal('fraction · \\frac{}{}');
  assert.deepEqual(await taState(), { v: '\\frac{}{}', s: 6, e: 6, focus: true });
  await setTa('n', 0, 1); await pal('fraction · \\frac{}{}');
  assert.deepEqual(await taState(), { v: '\\frac{n}{}', s: 9, e: 9, focus: true }, 'selection becomes the numerator, caret in the denominator');
  await setTa('x', 0, 1); await pal('norm · \\lVert x\\rVert');
  assert.equal((await taState()).v, '\\lVert x\\rVert');
  await setTa('', 0); await pal('cases · \\begin{cases}');
  assert.deepEqual(await evaluate("(() => { const t = document.querySelector('.math-input'); return [t.value.startsWith('\\\\begin{cases} '), t.selectionStart, t.value.endsWith('\\\\end{cases}')]; })()"), [true, 14, true], 'cases caret in the first cell');
  await setTa('', 0); await pal('matrix · \\begin{pmatrix}');
  assert.equal((await taState()).s, '\\begin{pmatrix} '.length);
  assert.equal(await evaluate("document.querySelector('.math-input').value === store.getState().deck.slides[1].elements.find(e => e.id === " + JSON.stringify(palEl) + ").doc.content[0].attrs.latex"), true, 'node updated live');
  // Escape closes only the palette; a second Escape commits the equation (unchanged behavior).
  await key('Escape'); await pause();
  assert.equal(await evaluate("document.querySelectorAll('.math-palette').length"), 0, 'Escape closes the palette');
  assert.equal(await evaluate("!!store.getState().mathEdit"), true, 'Escape on the palette keeps the equation editor open');
  await click('.math-pal-btn'); await pause(); // reopen, then click elsewhere in the popover
  await click('.math-popover-foot .math-help'); await pause();
  assert.equal(await evaluate("document.querySelectorAll('.math-palette').length"), 0, 'outside click closes the palette');
  assert.equal(await evaluate("!!store.getState().mathEdit"), true, 'outside click inside the popover keeps the equation open');
  await setTa('a', 1); await send('Input.insertText', {text: 'b'});
  await key('Enter'); await pause(); // plain Enter still commits
  assert.equal(await evaluate("!!store.getState().mathEdit"), false, 'Enter commits');
  await evaluate('store.getState().stopEditing()');
  await evaluate(`store.getState().commit(d=>{d.slides[1].elements = d.slides[1].elements.filter(e => e.id !== ${JSON.stringify(palEl)});})`);
  console.log('PASS math palette (hidden by default, caret/selection insertion, templates, focus, Escape/outside click)');
  // Slash menu: bounded height, scrolling list, keyboard-active item kept visible, viewport-contained.
  await evaluate(`store.getState().addElements([defaults.newText(700,640,{w:400})],{edit:true})`);
  await until(() => evaluate('!!active()'), 'Slash menu text editor');
  const slashEl = await evaluate('store.getState().editingId');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 }); // keep the pointer off the menu (hover selects)
  await send('Input.insertText', {text:'/'}); await pause();
  const menuInfo = () => evaluate(`(() => { const m = document.querySelector('.slash-menu'), l = m && m.querySelector('.slash-list'); if (!l) return null;
    const lr = l.getBoundingClientRect(), a = l.querySelector('.slash-item.active'), ar = a.getBoundingClientRect(), mr = m.getBoundingClientRect();
    return { n: l.children.length, scrollable: l.scrollHeight > l.clientHeight, overflowX: getComputedStyle(l).overflowX, scrollTop: l.scrollTop, active: a.querySelector('.slash-name').textContent,
      visible: ar.top >= lr.top - 1 && ar.bottom <= lr.bottom + 1, inViewport: mr.top >= 0 && mr.bottom <= innerHeight, menuH: mr.height, pageScroll: [document.scrollingElement.scrollTop, document.querySelector('.stage, .canvas-area, main')?.scrollTop ?? 0] }; })()`);
  await until(menuInfo, 'slash menu open');
  let mi = await menuInfo();
  assert.equal(mi.n, 9, 'all commands listed');
  assert.ok(mi.menuH <= 340 + 1, 'menu height bounded');
  assert.ok(mi.scrollable, 'list scrolls when it exceeds the maximum height'); assert.equal(mi.overflowX, 'hidden'); assert.ok(mi.inViewport, 'menu inside the viewport');
  assert.equal(mi.active, 'Block equation');
  const names = [];
  for (let i = 0; i < 8; i++) { await key('ArrowDown'); await pause(60); mi = await menuInfo(); names.push(mi.active); assert.ok(mi.visible, 'active item visible going down: ' + mi.active); }
  assert.equal(names.at(-1), 'Numbered list'); assert.ok(mi.scrollTop > 0, 'list scrolled down');
  assert.deepEqual(mi.pageScroll, [0, 0], 'keyboard navigation does not scroll the page');
  for (let i = 0; i < 8; i++) { await key('ArrowUp'); await pause(60); mi = await menuInfo(); assert.ok(mi.visible, 'active item visible going up: ' + mi.active); }
  assert.equal(mi.active, 'Block equation'); assert.equal(mi.scrollTop, 0, 'scrolled back to the top');
  await key('ArrowUp'); await pause(60); mi = await menuInfo(); // wraps to the last command
  assert.equal(mi.active, 'Numbered list'); assert.ok(mi.visible, 'wrap-around keeps the last item visible');
  // Wheel over the list scrolls the list and keeps the menu open.
  await key('ArrowUp'); await key('ArrowUp'); await key('ArrowUp'); await key('ArrowUp'); await key('ArrowUp'); await key('ArrowUp'); await key('ArrowUp'); await key('ArrowUp'); await pause(60);
  const lr = await evaluate(`(() => { const r = document.querySelector('.slash-list').getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...lr, deltaX: 0, deltaY: 120 }); await pause(200);
  mi = await menuInfo();
  assert.ok(mi && mi.scrollTop > 0, 'wheel scrolls the list and does not close the menu');
  // Mouse selection of a command that needed scrolling to reach.
  await evaluate(`[...document.querySelectorAll('.slash-item')].find((e) => e.querySelector('.slash-name').textContent === 'Bulleted list').click()`); await pause();
  assert.equal(await evaluate("document.querySelectorAll('.slash-menu').length"), 0, 'click selects and closes');
  assert.deepEqual((await doc()).content.map((n) => n.type), ['bulletList'], 'click ran the command');
  // Enter runs the active command; Escape closes without running anything.
  await evaluate('active().commands.clearContent()'); await pause();
  await send('Input.insertText', {text:'/'}); await pause(); await until(menuInfo, 'slash menu reopened');
  for (let i = 0; i < 8; i++) await key('ArrowDown');
  await pause(60); await key('Enter'); await pause();
  assert.deepEqual((await doc()).content.map((n) => n.type), ['orderedList'], 'Enter runs the active (scrolled-to) command');
  await evaluate('active().commands.clearContent()'); await pause();
  await send('Input.insertText', {text:'/'}); await pause(); await until(menuInfo, 'slash menu reopened again');
  await key('Escape'); await pause();
  assert.equal(await evaluate("document.querySelectorAll('.slash-menu').length"), 0, 'Escape closes the menu');
  assert.ok((await doc()).content.every((n) => n.type === 'paragraph'), 'Escape inserts nothing');
  await evaluate('store.getState().stopEditing()');
  await evaluate(`store.getState().commit(d=>{d.slides[1].elements = d.slides[1].elements.filter(e => e.id !== ${JSON.stringify(slashEl)});})`);
  console.log('PASS slash menu (bounded height, scrollable list, keyboard auto-scroll up/down/wrap, wheel, click, Enter, Escape, viewport)');
  // Code Block (/code at line start) and Quote ("| " at line start), typed in a fresh box on the content slide.
  await evaluate(`store.getState().addElements([defaults.newText(64,330,{w:900})],{edit:true})`);
  await until(() => evaluate('!!active()'), 'Block text editor');
  const blockTypes = async () => (await doc()).content.map((n) => n.type);
  await send('Input.insertText', {text:'P(A | B) stays text'}); await pause();
  assert.deepEqual(await blockTypes(), ['paragraph'], 'mid-line "|" must not create a quote');
  await key('Enter');
  await send('Input.insertText', {text:'/code'}); await pause();
  assert.equal(await evaluate("[...document.querySelectorAll('.slash-item .slash-name')].map(e=>e.textContent).join()"), 'Code block');
  await key('Enter'); await pause();
  assert.deepEqual(await blockTypes(), ['paragraph', 'codeBlock']);
  assert.ok(!JSON.stringify(await doc()).includes('/code'), '/code trigger removed');
  const codeCreated = await doc();
  await evaluate('active().commands.undo()'); await pause();
  assert.deepEqual((await doc()).content[1], {type:'paragraph', attrs:{fontSize:null}, content:[{type:'text', text:'/code'}]}, 'undo restores the typed /code line');
  await evaluate('active().commands.redo()'); await pause();
  assert.deepEqual(await doc(), codeCreated, 'redo restores the code block');
  await send('Input.insertText', {text:'def policy(state):'}); await key('Enter');
  await send('Input.insertText', {text:'    return actor(state)'}); await pause();
  const codeNode = (await doc()).content[1];
  assert.equal(codeNode.content.map((t) => t.text).join(''), 'def policy(state):\n    return actor(state)', 'multiline + indentation kept');
  assert.ok(codeNode.content.every((t) => !t.marks), 'code block holds plain text (separate from the inline code mark)');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.el.editing pre code')).fontFamily.startsWith('Menlo')"), true);
  // --- Code Block polish: size, languages, highlighting, Tab / Shift+Tab, undo/redo ---
  const codeText = async (i = 0) => (await doc()).content.filter((n) => n.type === 'codeBlock')[i].content.map((t) => t.text).join('');
  const codeAttrs = async (i = 0) => (await doc()).content.filter((n) => n.type === 'codeBlock')[i].attrs;
  const setLang = async (i, v) => { await pause(600); await evaluate(`(() => { const s = document.querySelectorAll('.el.editing pre .code-lang select')[${i}]; s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', {bubbles: true})); })()`); await pause(); };
  const tokens = (i, cls) => evaluate(`[...document.querySelectorAll('.el.editing pre')[${i}].querySelectorAll('.${cls}')].map(e => e.textContent)`);
  assert.deepEqual(await codeAttrs(), {language: null, fontSize: 16}, 'A: new Code Block is 16pt, Plain Text');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.el.editing pre code')).fontSize"), '16px', 'A: rendered at 16');
  assert.equal((await doc()).content[0].attrs.fontSize, null, 'A: ordinary paragraphs keep their size');
  assert.equal(await evaluate("document.querySelectorAll('.el.editing pre [class*=hljs]').length"), 0, 'B: Plain Text has no highlighting');
  assert.equal(await evaluate("document.querySelector('.propsbar input[title=\"코드 블록 글자 크기 (px)\"]')?.value"), '16', 'A: toolbar shows the Code Block size');
  await setLang(0, 'python');
  assert.equal((await codeAttrs()).language, 'python', 'C: language stored on the block');
  assert.ok((await tokens(0, 'hljs-keyword')).includes('def') && (await tokens(0, 'hljs-keyword')).includes('return'), 'B: Python keywords');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.el.editing pre .hljs-keyword')).color"), 'rgb(207, 34, 46)');
  assert.equal(await codeText(), 'def policy(state):\n    return actor(state)', 'highlighting does not change the code text');
  assert.ok(!JSON.stringify(await doc()).includes('hljs') && !JSON.stringify(await doc()).includes('textStyle'), 'B: no stored highlight/color marks');
  await evaluate('active().commands.undo()'); await pause();
  assert.equal((await codeAttrs()).language, null, 'undo language change'); assert.equal(await evaluate("document.querySelectorAll('.el.editing pre [class*=hljs]').length"), 0);
  await evaluate('active().commands.redo()'); await pause();
  assert.equal((await codeAttrs()).language, 'python', 'redo language change');
  await setLang(0, ''); assert.equal((await codeAttrs()).language, null, 'back to Plain Text'); assert.equal(await evaluate("document.querySelectorAll('.el.editing pre [class*=hljs]').length"), 0);
  await setLang(0, 'python');
  // D: Tab / Shift+Tab
  const original = await codeText();
  await evaluate("active().commands.focus('end')"); await pause(); await key('Tab'); await pause(600);
  assert.equal(await codeText(), 'def policy(state):\n        return actor(state)', 'D: Tab indents the caret line by 4 spaces (no literal tab)');
  assert.ok(await evaluate("document.activeElement.closest('.ProseMirror') !== null"), 'D: Tab keeps focus in the editor');
  await key('Tab', 'Tab', 8); await pause(600);
  assert.equal(await codeText(), original, 'D: Shift+Tab removes one indent level');
  await evaluate('active().commands.undo()'); await pause(); assert.equal(await codeText(), 'def policy(state):\n        return actor(state)', 'D: undo Shift+Tab');
  await evaluate('active().commands.undo()'); await pause(); assert.equal(await codeText(), original, 'D: undo Tab');
  await evaluate("(() => { let at = 0; active().state.doc.descendants((n, p) => { if (n.type.name === 'codeBlock') at = p; }); active().commands.setTextSelection(at + 3); })()"); await pause();
  await key('Tab', 'Tab', 8); await pause();
  assert.equal(await codeText(), original, 'D: Shift+Tab never goes below column 0');
  await evaluate("(() => { let at = 0, size = 0; active().state.doc.descendants((n, p) => { if (n.type.name === 'codeBlock') { at = p; size = n.content.size; } }); active().commands.setTextSelection({from: at + 1, to: at + 1 + size}); })()"); await pause();
  await key('Tab'); await pause();
  assert.equal(await codeText(), '    def policy(state):\n        return actor(state)', 'D: multi-line indent');
  await key('Tab', 'Tab', 8); await pause();
  assert.equal(await codeText(), original, 'D: multi-line outdent');
  await key('Tab', 'Tab', 8); await pause();
  assert.equal(await codeText(), 'def policy(state):\nreturn actor(state)', 'D: outdent stops at column 0 per line');
  await pause(600); await key('Tab'); await pause(600);
  assert.equal(await codeText(), '    def policy(state):\n    return actor(state)'.replace(/\n    r/, '\n    r'), 'D: Tab after outdent');
  await evaluate('active().commands.undo()'); await pause();
  assert.equal(await codeText(), 'def policy(state):\nreturn actor(state)', 'D: undo multi-line indent');
  await evaluate('active().commands.undo()'); await pause();
  assert.equal(await codeText(), original, 'D: undo multi-line outdent steps');
  // A: user-adjusted size through the existing toolbar field
  await pause(600); await click('.propsbar button[title="글자 크게"]'); await pause();
  assert.equal((await codeAttrs()).fontSize, 18, 'A: toolbar edits the Code Block size');
  assert.equal(await evaluate('store.getState().deck.slides[1].elements.at(-1).style.fontSize'), 25, 'A: text box size untouched');
  await evaluate('active().commands.undo()'); await pause();
  assert.equal((await codeAttrs()).fontSize, 16, 'A: undo size change'); assert.equal(await codeText(), original, 'A: undo of the size change keeps the text');
  await evaluate("active().commands.focus('end')"); await pause();
  await key('Enter'); await key('Enter'); await key('Enter'); // triple Enter leaves the code block
  // C: independent languages — C and Bash blocks in the same box
  await send('Input.insertText', {text:'/code'}); await pause(); await key('Enter'); await pause();
  await setLang(1, 'c');
  await send('Input.insertText', {text:'int main(void) {'}); await key('Enter'); await send('Input.insertText', {text:'    return 0; // done'}); await pause();
  assert.ok((await tokens(1, 'hljs-keyword')).includes('return') && (await tokens(1, 'hljs-number')).includes('0') && (await tokens(1, 'hljs-comment')).join().includes('// done'), 'B: C keyword, number, comment');
  await key('Enter'); await key('Enter'); await key('Enter');
  await send('Input.insertText', {text:'/code'}); await pause(); await key('Enter'); await pause();
  await setLang(2, 'bash');
  await send('Input.insertText', {text:'echo "hi" # note'}); await pause();
  assert.ok((await tokens(2, 'hljs-string')).includes('"hi"') && (await tokens(2, 'hljs-comment')).join().includes('# note'), 'B: Bash string, comment');
  assert.deepEqual([(await codeAttrs(0)).language, (await codeAttrs(1)).language, (await codeAttrs(2)).language], ['python', 'c', 'bash'], 'C: independent languages');
  assert.deepEqual([(await codeAttrs(1)).fontSize, (await codeAttrs(2)).fontSize], [16, 16], 'A: typed blocks default to 16');
  await key('Enter'); await key('Enter'); await key('Enter');
  await send('Input.insertText', {text:'|'}); await send('Input.insertText', {text:' '}); await pause();
  assert.equal((await doc()).content.at(-1).type, 'blockquote', '"| " at line start creates a quote');
  assert.ok(!JSON.stringify((await doc()).content.at(-1)).includes('|'), 'quote trigger removed');
  const quoteCreated = await doc();
  await evaluate('active().commands.undo()'); await pause();
  assert.notEqual((await doc()).content.at(-1).type, 'blockquote', 'undo removes the quote');
  await evaluate('active().commands.redo()'); await pause();
  assert.deepEqual(await doc(), quoteCreated, 'redo restores the quote');
  await send('Input.insertText', {text:'Clipping keeps updates small.'}); await key('Enter');
  await send('Input.insertText', {text:'Schulman et al.'}); await pause();
  const quoteNode = (await doc()).content.at(-1);
  assert.deepEqual(quoteNode.content.map((p) => p.content?.[0]?.text), ['Clipping keeps updates small.', 'Schulman et al.'], 'Enter continues the quote');
  // Formatting inside a quote: bold + highlight on "Clipping"
  await evaluate(`(() => { let at = 0; active().state.doc.descendants((n, p) => { if (n.isText && n.text.startsWith('Clipping')) at = p; }); active().commands.setTextSelection({from: at, to: at + 8}); })()`); await pause();
  await click('.propsbar button[title="굵게 ⌘B"]'); await choose(highlight, 'Highlight Yellow');
  assert.deepEqual(marksAt({content:[(await doc()).content.at(-1).content[0]]}, 0).map((m) => m.type).sort(), ['bold', 'highlight']);
  await evaluate('store.getState().stopEditing()'); await pause();
  assert.equal(await evaluate("!!document.querySelector('.slide.editable pre code') && !!document.querySelector('.slide.editable blockquote')"), true, 'static render');
  assert.equal(await evaluate("!!document.querySelector('.thumb pre') && !!document.querySelector('.thumb blockquote')"), true, 'thumbnail render');
  for (const where of ['.slide.editable', '.thumb']) {
    assert.ok(await evaluate(`!!document.querySelector('${where} pre .hljs-keyword')`), 'E: highlighted in ' + where);
    assert.equal(await evaluate(`document.querySelectorAll('${where} .code-lang, ${where} select').length`), 0, 'E: no language selector in ' + where);
  }
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.slide.editable pre code')).fontSize"), '16px', 'E: static size');
  console.log('PASS code block (/code, multiline, indentation, undo/redo) and quote ("| ", P(A | B), continuation, formatting)');
  // Callout (/callout at line start): semantic node with an icon attribute; rich content; icon switching; undo/redo.
  await evaluate(`store.getState().addElements([defaults.newText(64,540,{w:900})],{edit:true})`);
  await until(() => evaluate('!!active()'), 'Callout text editor');
  const callouts = async () => (await doc()).content.filter((n) => n.type === 'callout');
  // The picker listens to mousedown; dispatching it directly keeps the check independent of window size.
  const pickIcon = async (i, n) => {
    await evaluate(`document.querySelectorAll('.el.editing .callout-icon')[${i}].dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}))`); await pause();
    await evaluate(`document.querySelectorAll('.el.editing .callout-icons button')[${n}].dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}))`); await pause();
  };
  await send('Input.insertText', {text:'plain /callout mid-line'}); await pause();
  assert.equal(await evaluate("document.querySelectorAll('.slash-menu').length"), 0, 'no slash menu mid-line');
  await key('Enter');
  await send('Input.insertText', {text:'/callout'}); await pause();
  assert.equal(await evaluate("[...document.querySelectorAll('.slash-item .slash-name')].map(e=>e.textContent).join()"), 'Callout');
  await key('Enter'); await pause();
  assert.deepEqual((await doc()).content.map((n) => n.type), ['paragraph', 'callout'], 'semantic callout node');
  assert.ok(!JSON.stringify(await doc()).includes('/callout') || JSON.stringify((await doc()).content[1]).includes('/callout') === false, '/callout trigger removed');
  assert.equal((await callouts())[0].attrs.icon, '💡', 'default icon');
  assert.equal(await evaluate("document.querySelector('.el.editing .callout .callout-icon').textContent"), '💡');
  const calloutCreated = await doc();
  await evaluate('active().commands.undo()'); await pause();
  assert.equal((await doc()).content[1].type, 'paragraph', 'undo callout conversion');
  assert.equal((await doc()).content[1].content[0].text, '/callout');
  await evaluate('active().commands.redo()'); await pause();
  assert.deepEqual(await doc(), calloutCreated, 'redo callout conversion');
  await send('Input.insertText', {text:'Key idea'}); await key('Enter'); await send('Input.insertText', {text:'second line'}); await pause();
  assert.deepEqual((await callouts())[0].content.map((p) => p.content[0].text), ['Key idea', 'second line'], 'multi-line content stays inside the callout');
  assert.ok(!JSON.stringify((await callouts())[0].content).includes('💡'), 'icon is not text content');
  await evaluate(`(() => { let at = 0; active().state.doc.descendants((n, p) => { if (n.isText && n.text.startsWith('Key')) at = p; }); active().commands.setTextSelection({from: at, to: at + 3}); })()`); await pause();
  await click('.propsbar button[title="굵게 ⌘B"]'); await choose(highlight, 'Highlight Yellow'); await choose(textColor, 'Standard Purple');
  assert.deepEqual(marksAt({content:[(await callouts())[0].content[0]]}, 0).map((m) => m.type).sort(), ['bold', 'highlight', 'textStyle'], 'rich marks inside a callout');
  await pause(600); await pickIcon(0, 2);
  assert.equal((await callouts())[0].attrs.icon, '⚠️', 'icon changed');
  assert.equal(await evaluate("document.querySelector('.el.editing .callout .callout-icon').textContent"), '⚠️', 'icon updates immediately');
  await evaluate('active().commands.undo()'); await pause();
  assert.equal((await callouts())[0].attrs.icon, '💡', 'undo icon change');
  await evaluate('active().commands.redo()'); await pause();
  assert.equal((await callouts())[0].attrs.icon, '⚠️', 'redo icon change');
  await evaluate("active().commands.focus('end')"); await pause();
  await key('Enter'); await key('Enter'); await pause(); // Enter on an empty last line leaves the callout
  assert.equal((await doc()).content.at(-1).type, 'paragraph', 'Enter on an empty last line exits the callout');
  assert.equal((await callouts())[0].content.length, 2, 'exit leaves no stray empty line inside');
  await send('Input.insertText', {text:'/callout'}); await pause(); await key('Enter'); await pause();
  await send('Input.insertText', {text:'Done'}); await pause();
  await pause(600); await pickIcon(1, 3);
  assert.deepEqual((await callouts()).map((c) => c.attrs.icon), ['⚠️', '✅'], 'callouts keep their own icons');
  assert.equal(await evaluate("document.querySelectorAll('.el.editing .slash-menu, .slash-menu').length"), 0, 'no slash menu inside callouts');
  await evaluate('store.getState().stopEditing()'); await pause();
  for (const where of ['.slide.editable', '.thumb']) {
    assert.equal(await evaluate(`[...document.querySelectorAll('${where} .callout .callout-icon')].map(e => e.textContent).join()`), '⚠️,✅', 'icons rendered in ' + where);
    assert.equal(await evaluate(`document.querySelectorAll('${where} .callout-icons, ${where} .callout button').length`), 0, 'no icon picker in ' + where);
  }
  console.log('PASS callout (/callout, default icon, rich marks, multi-line, exit, icon switching, undo/redo, static/thumbnail)');
  // Academic Block (/block): one node with type + optional title attributes; semantic color families.
  await evaluate(`store.getState().addElements([defaults.newText(700,200,{w:520})],{edit:true})`);
  await until(() => evaluate('!!active()'), 'Academic Block text editor');
  const blocks = async () => (await doc()).content.filter((n) => n.type === 'academicBlock');
  const head = (i) => evaluate(`(() => { const h = document.querySelectorAll('.el.editing .ablock')[${i}]; const b = h.querySelector('.ablock-head'); return { family: h.dataset.family, label: h.querySelector('.ablock-type').textContent, bg: getComputedStyle(b).backgroundColor, body: getComputedStyle(h).backgroundColor }; })()`);
  const pickType = async (i, label) => {
    await until(() => evaluate(`!!document.querySelectorAll('.el.editing .ablock-type')[${i}]`), 'academic block header');
    await evaluate(`document.querySelectorAll('.el.editing .ablock-type')[${i}].dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}))`); await pause();
    await evaluate(`[...document.querySelectorAll('.el.editing .ablock-types button')].find((b) => b.textContent === ${JSON.stringify(label)}).dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}))`); await pause();
  };
  const setTitle = async (i, v) => { await pause(600); await evaluate(`(() => { const e = document.querySelectorAll('.el.editing .ablock-title-input')[${i}]; e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', {bubbles: true})); })()`); await pause(); };
  await send('Input.insertText', {text:'/block'}); await pause();
  assert.equal(await evaluate("document.querySelector('.slash-item .slash-name').textContent"), 'Block', '/block lists the Academic Block first');
  await key('Enter'); await pause();
  assert.deepEqual((await doc()).content.map((n) => n.type), ['academicBlock'], 'semantic academic block');
  assert.deepEqual((await blocks())[0].attrs, {type: 'block', title: ''}, 'default type Block, empty title');
  assert.ok(!JSON.stringify(await doc()).includes('/block'), '/block trigger removed');
  assert.deepEqual(await evaluate("(() => { const h = document.querySelector('.el.editing .ablock'); return [h.dataset.family, h.querySelector('.ablock-type').textContent]; })()"), ['gray', 'Block']);
  const blockCreated = await doc();
  await evaluate('active().commands.undo()'); await pause();
  assert.equal((await doc()).content[0].type, 'paragraph', 'undo /block conversion'); assert.equal((await doc()).content[0].content[0].text, '/block');
  await evaluate('active().commands.redo()'); await pause();
  assert.deepEqual(await doc(), blockCreated, 'redo /block conversion');
  await send('Input.insertText', {text:'Statement'}); await key('Enter'); await send('Input.insertText', {text:'holds for '}); await pause();
  await evaluate("active().commands.insertContent({type: 'mathInline', attrs: {latex: 'x^2'}})"); await pause();
  assert.equal((await blocks())[0].content.length, 2, 'multiple paragraphs');
  assert.ok(JSON.stringify((await blocks())[0]).includes('"mathInline"'), 'math in the body');
  await evaluate(`(() => { let at = 0; active().state.doc.descendants((n, p) => { if (n.isText && n.text.startsWith('Statement')) at = p; }); active().commands.setTextSelection({from: at, to: at + 9}); })()`); await pause();
  await click('.propsbar button[title="굵게 ⌘B"]'); await choose(highlight, 'Highlight Yellow');
  assert.deepEqual(marksAt({content:[(await blocks())[0].content[0]]}, 0).map((m) => m.type).sort(), ['bold', 'highlight'], 'rich marks in the body');
  const colors = {};
  for (const [label, id] of [['Theorem', 'theorem'], ['Definition', 'definition'], ['Example', 'example'], ['Remark', 'remark'], ['Lemma', 'lemma'], ['Proposition', 'proposition'], ['Block', 'block']]) {
    await pause(600); await pickType(0, label);
    assert.equal((await blocks())[0].attrs.type, id); colors[id] = await head(0);
    assert.equal(colors[id].label, label, 'label updates immediately');
  }
  const family = Object.fromEntries(Object.entries(colors).map(([k, v]) => [k, v.family]));
  assert.deepEqual(family, {theorem: 'blue', definition: 'teal', example: 'green', remark: 'amber', lemma: 'blue', proposition: 'blue', block: 'gray'}, 'type → color family');
  assert.equal(new Set(Object.values(colors).map((c) => c.bg)).size, 5, 'five distinct family colors');
  assert.deepEqual([colors.lemma.bg, colors.lemma.body], [colors.theorem.bg, colors.theorem.body], 'Lemma shares Theorem colors');
  assert.deepEqual([colors.proposition.bg, colors.proposition.body], [colors.theorem.bg, colors.theorem.body], 'Proposition shares Theorem colors');
  assert.equal((await blocks())[0].content.length, 2, 'body survives type changes');
  await pause(600); await pickType(0, 'Theorem');
  await evaluate('active().commands.undo()'); await pause();
  assert.equal((await blocks())[0].attrs.type, 'block', 'undo type change');
  await evaluate('active().commands.redo()'); await pause();
  assert.equal((await blocks())[0].attrs.type, 'theorem', 'redo type change');
  await setTitle(0, 'Policy Gradient Theorem');
  assert.equal((await blocks())[0].attrs.title, 'Policy Gradient Theorem'); assert.equal((await blocks())[0].attrs.type, 'theorem', 'type and title are separate attributes');
  await pause(600); await pickType(0, 'Lemma'); await pickType(0, 'Theorem');
  assert.equal((await blocks())[0].attrs.title, 'Policy Gradient Theorem', 'title survives type changes');
  await setTitle(0, '');
  assert.equal(await evaluate("document.querySelector('.el.editing .ablock-sep').hidden"), true, 'empty title: label only');
  await evaluate('active().commands.undo()'); await pause();
  assert.equal((await blocks())[0].attrs.title, 'Policy Gradient Theorem', 'undo title edit');
  await evaluate('active().commands.redo()'); await pause();
  await evaluate('active().commands.undo()'); await pause();
  assert.equal(await evaluate("document.querySelector('.el.editing .ablock-title-input').value"), 'Policy Gradient Theorem', 'title input follows undo');
  await evaluate("active().commands.focus('end')"); await pause();
  await key('Enter'); await key('Enter'); await pause();
  assert.equal((await doc()).content.at(-1).type, 'paragraph', 'Enter on an empty last line exits the block');
  await send('Input.insertText', {text:'/block'}); await pause(); await key('Enter'); await pause();
  await send('Input.insertText', {text:'Markov property'}); await pause();
  await pause(600); await pickType(1, 'Definition');
  assert.deepEqual((await blocks()).map((b) => [b.attrs.type, b.attrs.title]), [['theorem', 'Policy Gradient Theorem'], ['definition', '']]);
  await evaluate('store.getState().stopEditing()'); await pause();
  for (const where of ['.slide.editable', '.thumb']) {
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${where} .ablock .ablock-head')].map(e => e.textContent)`), ['Theorem — Policy Gradient Theorem', 'Definition'], 'header text in ' + where);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${where} .ablock')].map(e => e.dataset.family)`), ['blue', 'teal']);
    assert.equal(await evaluate(`document.querySelectorAll('${where} .ablock input, ${where} .ablock-caret, ${where} .ablock-types').length`), 0, 'no editor controls in ' + where);
  }
  console.log('PASS academic block (/block, types and color families, title, rich body, math, exit, undo/redo, static/thumbnail)');
  // /image + image captions, on a slide of their own.
  await evaluate('store.getState().addSlide()'); await pause();
  await evaluate(`window.__fileInputs = []; HTMLInputElement.prototype.click = function () { if (this.type === 'file') window.__fileInputs.push(this); };
    window.__supply = async (i, name) => { const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#4a90d9"/></svg>'; const dt = new DataTransfer(); dt.items.add(new File([svg], name + '.svg', {type: 'image/svg+xml'})); Object.defineProperty(window.__fileInputs[i], 'files', {value: dt.files}); await window.__fileInputs[i].onchange(); };`);
  const slideId = await evaluate('store.getState().currentSlideId');
  const images = () => evaluate("store.getState().deck.slides.find(s => s.id === store.getState().currentSlideId).elements.filter(e => e.type === 'image')");
  const imageGeometry = (e) => ({x: e.x, y: e.y, w: e.w, h: e.h});
  // Existing toolbar workflow.
  await click('button[title^="이미지 (I)"]');
  assert.equal(await evaluate('window.__fileInputs.length'), 1, 'toolbar Image opens the file picker');
  const pickerAccept = await evaluate('window.__fileInputs[0].accept');
  assert.ok(pickerAccept.includes('image/png') && await evaluate('window.__fileInputs[0].multiple'));
  await evaluate('window.__supply(0, "one")'); await until(async () => (await images()).length === 1, 'toolbar image inserted');
  assert.equal((await images())[0].caption, undefined, 'new image has no caption');
  assert.equal(await evaluate("document.querySelectorAll('.el-image .img-caption, .img-caption-input').length"), 0, 'no caption UI by default');
  const id1 = (await images())[0].id;
  await evaluate(`store.getState().updateElements(['${id1}'], e => { e.x = 100; e.y = 120; e.w = 400; e.h = 200; })`);
  // /image: same picker, trigger removed, cancel inserts nothing.
  const slashImage = async () => {
    await evaluate(`store.getState().addElements([defaults.newText(64, 420, {w: 500})], {edit: true})`);
    await until(() => evaluate('!!active()'), 'Image slash editor');
    await send('Input.insertText', {text: '/image'}); await pause();
    assert.equal(await evaluate("[...document.querySelectorAll('.slash-item .slash-name')].map(e => e.textContent).join()"), 'Image');
    await key('Enter'); await pause();
    assert.ok(!JSON.stringify(await doc()).includes('/image'), '/image trigger removed');
  };
  await slashImage();
  assert.equal(await evaluate('window.__fileInputs.length'), 2, '/image opens the file picker');
  assert.equal(await evaluate('window.__fileInputs[1].accept'), pickerAccept, '/image uses the same picker as the toolbar');
  await evaluate('store.getState().stopEditing()'); await pause();
  assert.equal((await images()).length, 1, 'cancelled picker inserts nothing');
  assert.ok(!(await evaluate('JSON.stringify(store.getState().deck.slides.find(s => s.id === store.getState().currentSlideId).elements)')).includes('/image'), 'cancel does not restore /image');
  await slashImage();
  await evaluate('window.__supply(2, "two")'); await until(async () => (await images()).length === 2, '/image inserted');
  await evaluate('store.getState().stopEditing()'); await pause();
  const id2 = (await images())[1].id;
  await evaluate(`store.getState().updateElements(['${id2}'], e => { e.x = 700; e.y = 120; e.w = 360; e.h = 180 })`);
  // Caption action (existing image toolbar).
  const geomBefore = imageGeometry((await images())[1]);
  await evaluate(`store.getState().select(['${id2}'])`); await pause();
  assert.equal(await evaluate("!!document.querySelector('.propsbar button[title=\"이미지 캡션 추가\"]')"), true, 'Caption action on a selected image');
  assert.equal(await evaluate("document.querySelectorAll('.img-caption-input').length"), 0);
  await click('.propsbar button[title="이미지 캡션 추가"]'); await pause();
  assert.equal(await evaluate("document.activeElement?.className"), 'img-caption-input', 'editable caption area, focused');
  assert.equal(await evaluate("document.querySelector('.img-caption-input').placeholder"), 'Add a caption...');
  assert.ok(!(await evaluate('JSON.stringify(store.getState().deck)')).includes('Add a caption'), 'placeholder is not content');
  await pause(300);
  await send('Input.insertText', {text: 'Architecture of the proposed model'}); await pause();
  assert.equal((await images())[1].caption, 'Architecture of the proposed model', 'caption typed');
  assert.deepEqual(imageGeometry((await images())[1]), geomBefore, 'caption does not change image geometry');
  const layout = () => evaluate(`(() => { const el = document.querySelector('[data-el-id="${id2}"]'); const c = el.querySelector('.img-caption-input, .img-caption'); const cs = getComputedStyle(c); const er = el.getBoundingClientRect(), cr = c.getBoundingClientRect(); return {fs: cs.fontSize, align: cs.textAlign, weight: cs.fontWeight, dx: cr.left - er.left, dw: cr.width - er.width, gap: (cr.top - er.bottom) / (er.width / el.offsetWidth), h: c.offsetHeight, scale: er.width / el.offsetWidth}; })()`);
  let L = await layout();
  assert.deepEqual([L.fs, L.align, L.weight, Math.round(L.dx), Math.round(L.dw)], ['14px', 'left', '400', 0, 0], 'caption: 14pt, left-aligned, image left edge and width');
  assert.ok(Math.abs(L.gap - 6) < 1, 'small gap below the image');
  const oneLine = L.h;
  await evaluate("document.activeElement.blur()"); await pause();
  assert.equal(await evaluate('store.getState().gestureBase === null'), true, 'editing session closed');
  await evaluate(`store.getState().updateElements(['${id2}'], e => { e.w = 180; e.h = 90 })`); await pause();
  L = await layout();
  assert.ok(L.h > oneLine * 1.5 && Math.round(L.dw) === 0 && Math.round(L.dx) === 0, 'narrower image: caption wraps within the image width');
  await evaluate(`store.getState().updateElements(['${id2}'], e => { e.x = 600; e.y = 200 })`); await pause();
  L = await layout();
  assert.ok(Math.round(L.dx) === 0 && Math.abs(L.gap - 6) < 1, 'moved image keeps its caption attached');
  // Undo/redo of caption operations (each is its own step).
  await evaluate('store.getState().undo(); store.getState().undo(); store.getState().undo()'); await pause(); // move, resize, text
  assert.equal((await images())[1].caption, '', 'undo caption text → empty editable caption');
  await evaluate('store.getState().undo()'); await pause();
  assert.equal((await images())[1].caption, undefined, 'undo adding the caption');
  await evaluate('store.getState().redo(); store.getState().redo()'); await pause();
  assert.equal((await images())[1].caption, 'Architecture of the proposed model', 'redo caption');
  // Remove Caption.
  await evaluate(`store.getState().select(['${id2}'])`); await pause();
  await click('.propsbar button[title="이미지 캡션 삭제"]'); await pause();
  assert.equal((await images())[1].caption, undefined, 'caption removed');
  assert.equal(await evaluate("document.querySelectorAll('.img-caption, .img-caption-input').length"), 0);
  await evaluate('store.getState().undo()'); await pause();
  assert.equal((await images())[1].caption, 'Architecture of the proposed model', 'undo remove caption');
  await evaluate('store.getState().redo()'); await pause();
  assert.equal((await images())[1].caption, undefined, 'redo remove caption');
  // Re-add; a different caption on the first image.
  const addCaption = async (id, text) => {
    await evaluate(`store.getState().select(['${id}'])`); await pause();
    await click('.propsbar button[title="이미지 캡션 추가"]'); await pause(400);
    await send('Input.insertText', {text}); await pause();
    await evaluate('document.activeElement.blur()'); await pause();
  };
  await addCaption(id2, 'Architecture of the proposed model');
  await addCaption(id1, 'Figure 1. Baseline');
  // Delete the captioned image: caption goes with it; undo restores both.
  await evaluate(`store.getState().select(['${id2}']); store.getState().deleteSelection()`); await pause();
  assert.equal((await images()).length, 1);
  assert.ok(!(await evaluate('JSON.stringify(store.getState().deck.slides.find(s => s.id === store.getState().currentSlideId).elements)')).includes('Architecture'), 'no orphan caption after deleting the image');
  assert.equal(await evaluate("[...document.querySelectorAll('.slide.editable .img-caption, .img-caption-input')].map(e => e.value ?? e.textContent).join()"), 'Figure 1. Baseline');
  await evaluate('store.getState().undo()'); await pause();
  assert.deepEqual((await images()).map((e) => e.caption), ['Figure 1. Baseline', 'Architecture of the proposed model'], 'undo restores image and caption together');
  // An empty caption behaves as no caption outside the editor.
  await evaluate(`store.getState().addElements([{id: 'img-empty', type: 'image', assetId: store.getState().deck.slides.find(s => s.id === '${slideId}').elements.find(e => e.type === 'image').assetId, x: 100, y: 400, w: 200, h: 100, caption: ''}])`);
  await evaluate('store.getState().select([])'); await pause();
  for (const where of ['.slide.editable', '.thumb']) {
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${where} .img-caption')].map(e => e.textContent)`), where === '.thumb' ? ['Figure 1. Baseline', 'Architecture of the proposed model'] : ['Figure 1. Baseline', 'Architecture of the proposed model'], 'captions rendered in ' + where + ' (empty one skipped)');
    assert.equal(await evaluate(`document.querySelectorAll('${where} .img-caption-input, ${where} textarea').length`), 0, 'no caption editor in ' + where);
  }
  console.log('PASS /image slash command (shared picker, cancel) and image captions (add/edit/remove, layout, undo/redo, delete, static/thumbnail)');
  // Hold Shift → alignment guide preview (editor-only), on the current (image) slide.
  const shift = (type) => send('Input.dispatchKeyEvent', {type, key: 'Shift', code: 'ShiftLeft', modifiers: type === 'keyDown' ? 8 : 0, windowsVirtualKeyCode: 16});
  const guidePositions = () => evaluate("[...document.querySelectorAll('.slide.editable .overlay .guide')].map(g => g.style.height === '720px' ? 'x' + g.style.left : 'y' + g.style.top)");
  const slideRect = () => evaluate("(() => { const r = document.querySelector('.slide.editable').getBoundingClientRect(); return {x: r.x, y: r.y, k: r.width / 1280}; })()");
  await evaluate('store.getState().select([]); document.activeElement?.blur?.()'); await pause();
  assert.deepEqual(await guidePositions(), [], 'no preview guides by default');
  await shift('keyDown'); await pause();
  const preview = await guidePositions();
  assert.ok(preview.length > 3, 'Shift shows alignment guides');
  assert.equal(new Set(preview).size, preview.length, 'no duplicated guide positions');
  const slideEls = await evaluate("store.getState().deck.slides.find(s => s.id === store.getState().currentSlideId).elements.map(e => ({x: e.x, y: e.y, w: e.w, h: e.h}))");
  const el0 = slideEls.find((e) => e.w === 400 && e.h === 200);
  assert.ok(preview.includes('x' + el0.x + 'px') && preview.includes('x' + (el0.x + el0.w) + 'px') && preview.includes('x' + (el0.x + el0.w / 2) + 'px') && preview.includes('y' + el0.y + 'px'), 'guides come from existing element edges and centers');
  assert.equal(await evaluate("document.querySelectorAll('.thumb .guide, .print-root .guide').length"), 0, 'guides exist only in the editor canvas');
  assert.ok(!(await evaluate('JSON.stringify(store.getState().deck)')).includes('guide'), 'guides are not stored');
  await shift('keyUp'); await pause();
  assert.deepEqual(await guidePositions(), [], 'releasing Shift hides the guides');
  // Shift while editing text: no guides, typing untouched.
  const body = await evaluate("store.getState().deck.slides.find(s => s.id === store.getState().currentSlideId).elements.find(e => e.type === 'text').id");
  await evaluate(`store.getState().startEditing('${body}', 'end')`); await until(() => evaluate('!!active()'), 'Shift text editor');
  await shift('keyDown'); await pause();
  assert.deepEqual(await guidePositions(), [], 'no guides while editing text');
  await send('Input.insertText', {text: 'X'}); await shift('keyUp'); await pause();
  assert.ok(JSON.stringify(await doc()).includes('X'), 'typing with Shift still works');
  await evaluate('store.getState().stopEditing(); store.getState().select([])'); await pause();
  // Shift-click on empty canvas still places text (nothing selected).
  const sr = await slideRect();
  const textCount = () => evaluate("store.getState().deck.slides.find(s => s.id === store.getState().currentSlideId).elements.filter(e => e.type === 'text').length");
  const before = await textCount();
  await shift('keyDown'); await pause();
  const at = {x: sr.x + 1000 * sr.k, y: sr.y + 600 * sr.k};
  await send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, modifiers: 8, ...at});
  await send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, modifiers: 8, ...at});
  await shift('keyUp'); await pause();
  assert.equal(await textCount(), before + 1, 'click placement of text works while Shift is held');
  assert.deepEqual(await guidePositions(), [], 'guides hide after the click / Shift release');
  await evaluate('store.getState().stopEditing(); store.getState().select([])'); await pause();
  // Existing drag-time guides still appear.
  const imgs = await images();
  const [i1, i2] = [imgs[0], imgs[1]];
  const rectOf = (id) => evaluate(`(() => { const r = document.querySelector('.slide.editable [data-el-id="${id}"]').getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
  const from = await rectOf(i2.id);
  await send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...from});
  const target = {x: from.x + (i1.x - i2.x - 2) * sr.k, y: from.y + 20};
  await send('Input.dispatchMouseEvent', {type: 'mouseMoved', button: 'left', buttons: 1, ...from, x: from.x + 30});
  await send('Input.dispatchMouseEvent', {type: 'mouseMoved', button: 'left', buttons: 1, ...target});
  await pause();
  assert.ok((await guidePositions()).length > 0, 'drag-time alignment guides still appear');
  await send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...target}); await pause();
  assert.deepEqual(await guidePositions(), [], 'drag guides clear on release');
  await evaluate('store.getState().undo()'); await pause();
  console.log('PASS Shift alignment-guide preview (show/hide, element-derived, de-duplicated, editor-only, text editing safe, Shift-click placement, drag guides)');
  // Shape text: double-click a shape to edit text that belongs to the shape.
  await evaluate('store.getState().addSlide()'); await pause();
  await evaluate(`const A = defaults.newShape('rect', 100, 250, 320, 160); const B = defaults.newShape('ellipse', 600, 250, 240, 160); window.__shapeIds = [A.id, B.id]; store.getState().addElements([A, B]); store.getState().select([])`);
  const [sA, sB] = await evaluate('window.__shapeIds');
  const shapeNow = (id) => evaluate(`store.getState().deck.slides.find(s => s.id === store.getState().currentSlideId).elements.find(e => e.id === '${id}')`);
  const center = (id) => evaluate(`(() => { const r = document.querySelector('.slide.editable [data-el-id="${id}"]').getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
  const mouse = async (p, clickCount) => { await send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount, ...p}); await send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount, ...p}); };
  const texts = () => evaluate("store.getState().deck.slides.find(s => s.id === store.getState().currentSlideId).elements.filter(e => e.type === 'text').length");
  const textsBefore = await texts();
  const pA = await center(sA);
  await mouse(pA, 1); await pause();
  assert.deepEqual(await evaluate('[store.getState().selection, store.getState().editingId]'), [[sA], null], 'single click selects the shape only');
  await mouse(pA, 1); await mouse(pA, 2); await until(() => evaluate('!!active()'), 'Shape text editor');
  assert.equal(await evaluate('store.getState().editingId'), sA, 'double-click enters shape text editing');
  assert.equal(await texts(), textsBefore, 'no separate text element is created');
  await send('Input.insertText', {text: 'Policy Gradient'}); await key('Enter'); await send('Input.insertText', {text: 'second line'}); await pause();
  assert.deepEqual((await doc()).content.map((p) => p.content[0].text), ['Policy Gradient', 'second line'], 'multiline shape text');
  assert.deepEqual((await shapeNow(sA)).doc.content.map((p) => p.content[0].text), ['Policy Gradient', 'second line'], 'text is stored on the shape');
  await evaluate(`(() => { let at = 0; active().state.doc.descendants((n, p) => { if (n.isText && n.text.startsWith('Policy')) at = p; }); active().commands.setTextSelection({from: at, to: at + 6}); })()`); await pause();
  await click('.propsbar button[title="굵게 ⌘B"]'); await pause();
  assert.deepEqual((await shapeNow(sA)).doc.content[0].content[0].marks.map((m) => m.type), ['bold'], 'bold inside the shape text');
  await evaluate("active().commands.focus('end')"); await send('Input.insertText', {text: '!'}); await pause();
  await evaluate('active().commands.undo()'); await pause();
  assert.ok(!JSON.stringify((await shapeNow(sA)).doc).includes('!'), 'undo inside the editor');
  await key('Escape'); await pause();
  assert.deepEqual(await evaluate('[store.getState().editingId, store.getState().selection]'), [null, [sA]], 'Escape leaves text editing, shape stays selected');
  const rel = (id) => evaluate(`(() => { const el = document.querySelector('.slide.editable [data-el-id="${id}"]'); const t = el.querySelector('.shape-text p'); const er = el.getBoundingClientRect(), tr = t.getBoundingClientRect(); const k = er.width / el.offsetWidth; return {dx: (tr.left + tr.width / 2 - er.left - er.width / 2) / k, dy: (tr.top + tr.height / 2 - er.top - er.height / 2) / k, h: t.offsetHeight, align: getComputedStyle(t.closest('.shape-text')).textAlign}; })()`);
  let r = await rel(sA);
  assert.ok(Math.abs(r.dx) < 3 && r.align === 'center', 'text centered horizontally'); assert.ok(Math.abs(r.dy) < 20, 'text vertically centered');
  const shapeLine = r.h;
  // History: the whole edit is one step; geometry changes are separate.
  await evaluate('store.getState().undo()'); await pause();
  assert.equal((await shapeNow(sA)).doc, undefined, 'undo removes the entered text');
  await evaluate('store.getState().redo()'); await pause();
  assert.deepEqual((await shapeNow(sA)).doc.content.map((p) => p.content.map((t) => t.text).join('')), ['Policy Gradient', 'second line'], 'redo restores the text');
  await pause(600);
  await evaluate(`store.getState().updateElements(['${sA}'], e => { e.x += 60; e.y += 20 })`); await pause(600);
  r = await rel(sA); assert.ok(Math.abs(r.dx) < 3 && Math.abs(r.dy) < 20, 'text moves with the shape');
  await evaluate(`store.getState().updateElements(['${sA}'], e => { e.w = 120 })`); await pause();
  r = await rel(sA);
  assert.ok(r.h > shapeLine * 1.4, 'text wraps within the narrower shape'); assert.ok(Math.abs(r.dx) < 3);
  assert.equal((await shapeNow(sA)).h, 160, 'the shape does not grow with its text');
  await evaluate('store.getState().undo(); store.getState().undo()'); await pause();
  assert.ok((await shapeNow(sA)).doc, 'text survives geometry undo'); assert.equal((await shapeNow(sA)).w, 320);
  // Reopen editing; click outside exits; an untouched empty shape stays text-free.
  const pA2 = await center(sA);
  await mouse(pA2, 1); await mouse(pA2, 2); await until(() => evaluate('!!active()'), 'Shape text editor (again)');
  await mouse({x: pA2.x, y: pA2.y + 300 * (await slideRect()).k}, 1); await pause();
  assert.equal(await evaluate('store.getState().editingId'), null, 'click outside leaves text editing');
  const pB = await center(sB);
  await mouse(pB, 1); await mouse(pB, 2); await until(() => evaluate('!!active()'), 'Empty shape editor');
  await key('Escape'); await pause();
  assert.equal('doc' in (await shapeNow(sB)), false, 'an empty shape stays a plain shape');
  await evaluate('store.getState().select([])'); await pause();
  for (const where of ['.slide.editable', '.thumb']) {
    assert.equal(await evaluate(`[...document.querySelectorAll('${where} .shape-text')].map(e => e.textContent).join('|')`), 'Policy Gradientsecond line', 'shape text rendered in ' + where + ' (empty shape has none)');
    assert.equal(await evaluate(`document.querySelectorAll('${where} .shape-text .ProseMirror, ${where} .shape-text textarea').length`), 0, 'no editor UI in ' + where);
  }
  console.log('PASS shape text (double-click editing, multiline, bold, centered, wrap, move/resize, Escape/outside, empty shape, undo/redo, static/thumbnail)');
  // Shape Fill reuses the Highlight palette; new shapes default to its light yellow.
  const HL = ['#FEF08A', '#D9F99D', '#BAE6FD', '#FBCFE8', '#DDD6FE', '#E2E8F0'];
  assert.equal((await shapeNow(sB)).fill, HL[0], 'new shapes default to the Highlight light yellow');
  assert.equal((await shapeNow(sA)).fill, HL[0]);
  await evaluate(`store.getState().addElements([{id: 'legacy-shape', type: 'shape', shape: 'roundRect', x: 900, y: 250, w: 200, h: 120, fill: '#BFBFBF', stroke: null, strokeWidth: 2, radius: 16}]); store.getState().select(['${sB}'])`); await pause();
  const fillButton = '.propsbar button[title^="채우기 (Fill)"]';
  const swatchColors = (sel) => evaluate(`[...document.querySelectorAll('${sel}')].map(b => b.style.backgroundColor)`);
  const rgb = (h) => `rgb(${[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ')})`;
  const textBefore = JSON.stringify(await evaluate("store.getState().deck.slides.map(s => s.elements.filter(e => e.type === 'text').map(e => e.doc))"));
  await click(fillButton); await pause();
  assert.deepEqual(await swatchColors('.highlight-palette .highlight-colors button'), HL.map(rgb), 'Fill offers exactly the Highlight palette');
  const fillLabels = await evaluate("[...document.querySelectorAll('.highlight-palette .highlight-colors button')].map(b => b.getAttribute('aria-label')).join()");
  assert.equal(fillLabels, 'Fill Yellow,Fill Light Green,Fill Light Cyan,Fill Light Pink,Fill Light Purple,Fill Light Gray');
  await click('button[aria-label="Fill Light Green"]'); await pause();
  assert.equal((await shapeNow(sB)).fill, HL[1], 'palette color applied to the shape');
  for (const [name, i] of [['Light Cyan', 2], ['Light Pink', 3], ['Light Purple', 4], ['Light Gray', 5], ['Yellow', 0], ['Light Pink', 3]]) {
    await pause(150); await click(fillButton); await click(`button[aria-label="Fill ${name}"]`); await pause();
    assert.equal((await shapeNow(sB)).fill, HL[i], 'fill ' + name);
  }
  await click(fillButton); await click('.highlight-palette .palette-other'); await pause();
  assert.equal((await shapeNow(sB)).fill, null, 'None / Remove Fill → no fill'); assert.equal((await shapeNow(sB)).stroke, null, 'border untouched');
  await evaluate('store.getState().undo()'); await pause();
  assert.equal((await shapeNow(sB)).fill, HL[3], 'undo no-fill'); await evaluate('store.getState().redo()'); await pause();
  assert.equal((await shapeNow(sB)).fill, null, 'redo no-fill');
  await evaluate('store.getState().undo()'); await pause();
  assert.equal(JSON.stringify(await evaluate("store.getState().deck.slides.map(s => s.elements.filter(e => e.type === 'text').map(e => e.doc))")), textBefore, 'changing a shape fill never touches text highlights');
  assert.equal((await shapeNow('legacy-shape')).fill, '#BFBFBF', 'existing shapes keep their saved fill');
  await evaluate('store.getState().select([])'); await pause();
  const fills = await evaluate(`[...document.querySelectorAll('.slide.editable .shape-svg')].map(s => s.querySelector('rect, ellipse').getAttribute('fill'))`);
  assert.deepEqual(fills, [HL[0], HL[3], '#BFBFBF'], 'editor/static render of the fills');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.thumb.current .shape-svg')].map(s => s.querySelector('rect, ellipse').getAttribute('fill'))`), [HL[0], HL[3], '#BFBFBF'], 'thumbnail fills');
  console.log('PASS shape fill (Highlight palette, light-yellow default, no fill, undo/redo, legacy fill kept, static/thumbnail)');
  // TOC entered in the real editor; generated sections retain their IDs through formatting.
  await evaluate('store.getState().addTocSlide()');
  await evaluate(`store.getState().startEditing(store.getState().deck.slides.find(s=>s.kind==='toc').elements.find(e=>e.role==='toc').id)`);
  await until(() => evaluate('!!active()'), 'TOC editor');
  await send('Input.insertText', {text:'Introduction'}); await key('Enter'); await send('Input.insertText', {text:'Methods'});
  await pause();
  assert.equal(await evaluate('store.getState().deck.sections.length'), 2);
  const sections = await evaluate('store.getState().deck.sections');
  await select(3, 8); await choose(highlight, 'Highlight Light Purple');
  assert.deepEqual(await evaluate('store.getState().deck.sections'), sections);
  await evaluate('store.getState().stopEditing()'); await pause();
  await click('.slide.editable .toc-link');
  // Links follow after a short delay (so a double-click can edit instead); wait for it rather than a fixed pause.
  await until(async () => (await evaluate('store.getState().currentSlideId')) === sections[0].subtitleSlideId, 'TOC link did not navigate', 3000);
  await evaluate(`store.getState().goToSlide(store.getState().deck.slides.find(s=>s.kind==='toc').id); store.setState({presenting:true})`); await pause();
  await click('.presenter .toc-link');
  assert.equal(await evaluate("document.querySelector('.presenter [data-slide-id]').getAttribute('data-slide-id')"), sections[0].subtitleSlideId);
  await key('Escape');
  await evaluate('store.getState().addThanksSlide(); store.getState().goToSlide(store.getState().deck.slides[0].id)'); await pause();
  await click('.footer-ref-text');
  await send('Input.insertText', {text:'https://arxiv.org/pdf/1706.03762v7.pdf; Manual reference'}); await key('Enter');
  await until(() => evaluate("store.getState().deck.citations?.['arxiv:1706.03762']?.status === 'ok'"), 'Citation did not resolve');
  assert.equal(await evaluate("store.getState().deck.slides.filter(s=>s.kind==='references').length"), 1);
  assert.equal(await evaluate('store.getState().deck.slides.at(-1).kind'), 'thanks');
  assert.equal(await evaluate('store.getState().deck.slides.at(-2).kind'), 'references');
  assert.equal(await evaluate('store.getState().deck.slides[0].reference'), 'Manual reference');
  await evaluate(`(async()=>{const r=await import('/src/citations/resolve.ts'); r.extractCitations(store.getState().deck.slides[1].id,'https://arxiv.org/abs/1706.03762');})()`);
  assert.equal(await evaluate('Object.keys(store.getState().deck.citations).length'), 1);
  console.log('PASS TOC/Sub-title editor and presenter navigation, citations, References deduplication, Thank You and manual reference');
  // Presentation Theme Color: presentation-level, derived decorations, readable foregrounds.
  await evaluate('store.getState().stopEditing(); store.getState().select([])'); await pause();
  const slideIds = await evaluate("({title: store.getState().deck.slides[0].id, content: store.getState().deck.slides[1].id, sub: store.getState().deck.slides.find(s => s.kind === 'subtitle').id})");
  const goto = async (id) => { await evaluate(`store.getState().goToSlide('${id}')`); await pause(250); };
  const themeParts = () => evaluate("[...document.querySelectorAll('.slide.editable [data-theme-part]')].map(e => e.dataset.themePart)");
  const colorOf = (sel) => evaluate(`getComputedStyle(document.querySelector('.slide.editable ${sel}')).color`);
  const elementsJson = () => evaluate("JSON.stringify(store.getState().deck.slides.map(s => s.elements))");
  const pickTheme = async (label) => { await click('.propsbar button[title^="Theme:"]'); await click(`button[aria-label="${label}"]`); await pause(300); };
  assert.equal(await evaluate('store.getState().deck.themeColor'), undefined, 'new presentations have no theme color metadata');
  await goto(slideIds.content);
  assert.deepEqual(await themeParts(), [], 'White theme: no decorations');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.propsbar .color-btn .small-label')].map(e => e.textContent).slice(0, 2)"), ['Theme', '배경색'], 'Theme control sits immediately left of Background Color');
  assert.equal(await evaluate("!!document.querySelector('.propsbar button[title^=\"Theme:\"]')"), true);
  const beforeElements = await elementsJson();
  const blockHeadBg = () => evaluate("getComputedStyle(document.querySelector('.slide.editable .ablock-head')).backgroundColor");
  const academicBg = await blockHeadBg();
  const bodySel = '[data-el-id="' + await evaluate("store.getState().deck.slides[1].elements[1].id") + '"]';
  const titleSel = '[data-el-id="' + await evaluate("store.getState().deck.slides[1].elements[0].id") + '"]';
  await pickTheme('Rose shade 5'); // #881337, dark red
  assert.equal(await evaluate('store.getState().deck.themeColor'), '#881337', 'stored on the presentation');
  assert.equal(await evaluate('store.getState().deck.slides[1].background'), '#ffffff', 'Background Color is independent');
  assert.deepEqual(await themeParts(), ['Theme Header Band', 'Theme Footer Accent'], 'content slide: header band + footer accent');
  assert.equal(await colorOf(titleSel), 'rgb(255, 255, 255)', 'dark theme → white title text');
  assert.equal(await colorOf(bodySel), 'rgb(0, 0, 0)', 'body text is untouched');
  assert.equal(await elementsJson(), beforeElements, 'theme never rewrites element data');
  assert.equal(await blockHeadBg(), academicBg, 'Academic Block colors are untouched');
  await goto(slideIds.title);
  assert.deepEqual(await themeParts(), ['Theme Title Band', 'Theme Footer Accent'], 'title slide: title band');
  const titleId = await evaluate('store.getState().deck.titleElementId');
  assert.equal(await colorOf('[data-el-id="' + titleId + '"]'), 'rgb(22, 163, 74)', 'a user-chosen title color is kept');
  await goto(slideIds.sub);
  assert.deepEqual(await themeParts(), ['Theme Section Background'], 'section divider: full theme background');
  assert.equal(await evaluate("(() => { const r = document.querySelector('.slide.editable [data-theme-part]'); return [r.style.width, r.style.height].join(); })()"), '1280px,720px');
  assert.equal(await colorOf('[data-el-id="' + slideIds.sub.replace(/^sub-/, 'sub-') + '-current"]'), 'rgb(255, 255, 255)', 'white text on the dark section background');
  assert.ok(await evaluate("document.querySelectorAll('.thumb [data-theme-part]').length") >= 4, 'thumbnails render the theme');
  // A light theme flips the foreground to black.
  await goto(slideIds.content);
  await pause(600); await pickTheme('Orange shade 1'); // #FFEDD5
  assert.equal(await colorOf(titleSel), 'rgb(0, 0, 0)', 'light theme → black title text');
  assert.equal(await elementsJson(), beforeElements);
  await evaluate('store.getState().undo()'); await pause();
  assert.equal(await evaluate('store.getState().deck.themeColor'), '#881337', 'undo theme change');
  await evaluate('store.getState().redo()'); await pause();
  assert.equal(await evaluate('store.getState().deck.themeColor'), '#FFEDD5', 'redo theme change');
  await pause(600); await pickTheme('Rose shade 5');
  assert.equal(await colorOf(titleSel), 'rgb(255, 255, 255)');
  console.log('PASS theme color (presentation-wide, title/header/section/footer decorations, readable foregrounds, user content untouched, undo/redo, thumbnails)');
  // Presentation font: the top selector rewrites every text; the selected-text font is a per-range mark that the top selector overwrites.
  await evaluate('store.getState().stopEditing(); store.getState().select([])'); await pause();
  const fontSnapshot = await evaluate('JSON.stringify({deck: store.getState().deck, assets: store.getState().assets, current: store.getState().currentSlideId})');
  const familyOf = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw Error('Missing ' + ${JSON.stringify(sel)}); return getComputedStyle(e).fontFamily.split(',')[0].replace(/['"]/g, '').trim(); })()`);
  const thumbFamilies = () => evaluate("[...document.querySelectorAll('.thumb .tb-content')].map((e) => getComputedStyle(e).fontFamily.split(',')[0].replace(/['\"]/g, '').trim())");
  const fontButtonText = (title) => evaluate(`document.querySelector('.propsbar button[title^="${title}"]').textContent`);
  const pickFont = async (title, name) => {
    await click(`.propsbar button[title^="${title}"]`);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.pop .menu-item')].map((e) => e.textContent)"), ['NanumSquare', 'Pretendard', 'Noto Serif KR'], 'exactly three fonts');
    await evaluate(`[...document.querySelectorAll('.pop .menu-item')].find((e) => e.textContent === ${JSON.stringify(name)}).click()`); await pause(400);
  };
  const GLOBAL = '프레젠테이션 전체 글꼴', SELECTED = '선택한 텍스트 글꼴';
  assert.equal(await evaluate('store.getState().deck.fontFamily'), undefined, 'new presentations have no font metadata (= NanumSquare)');
  await evaluate('store.getState().addSlide()'); await pause();
  const fontSlideId = await evaluate('store.getState().currentSlideId');
  await evaluate(`store.getState().addElements([defaults.newText(64, 300, {w: 760, doc: defaults.textDoc('Alpha beta gamma')})], {edit: true})`);
  await until(() => evaluate('!!active()'), 'Font editor');
  const fontElId = await evaluate('store.getState().editingId');
  await evaluate('store.getState().stopEditing(); store.getState().select([])'); await pause(300);
  assert.equal(await evaluate("(() => { const f = document.querySelector('.propsbar .font-btn'), t = document.querySelector('.propsbar button[title^=\"Theme:\"]'); return !!(f.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING); })()"), true, 'font selector sits left of Theme');
  assert.equal(await fontButtonText(GLOBAL), 'NanumSquare ▾', 'NanumSquare is the default');
  assert.equal(await familyOf('.slide.editable .tb-content'), 'NanumSquare');
  // Three genuinely different bundled fonts (loaded from the app's own files, not a fallback).
  const widths = await evaluate(`(async () => { const r = {}; for (const f of ['NanumSquare', 'Pretendard', 'Noto Serif KR']) { await document.fonts.load('400 40px "' + f + '"', 'Alpha 가나다'); await document.fonts.load('700 40px "' + f + '"', 'Alpha 가나다'); const c = document.createElement('canvas').getContext('2d'); c.font = '400 40px "' + f + '", monospace'; r[f] = Math.round(c.measureText('Alpha beta 가나다라마').width); } return r; })()`);
  assert.equal(new Set(Object.values(widths)).size, 3, 'fonts render differently: ' + JSON.stringify(widths));
  assert.deepEqual(await evaluate("['Pretendard', 'Noto Serif KR'].map((f) => [...document.fonts].filter((x) => x.family.replace(/['\"]/g, '') === f && x.status === 'loaded').length)"), [2, 2], 'regular + bold of each new font loaded from the bundled files');
  // Top selector → every slide, existing text immediately.
  await pickFont(GLOBAL, 'Pretendard');
  assert.equal(await evaluate('store.getState().deck.fontFamily'), 'Pretendard');
  assert.equal(await fontButtonText(GLOBAL), 'Pretendard ▾');
  const pretendardThumbs = await thumbFamilies();
  assert.ok(pretendardThumbs.length >= 6 && pretendardThumbs.every((f) => f === 'Pretendard'), 'every slide thumbnail uses Pretendard: ' + pretendardThumbs.join());
  assert.equal(await familyOf('.slide.editable .tb-content'), 'Pretendard');
  assert.equal(await familyOf('.slide.editable .footer-num'), 'Pretendard', 'footer text follows the deck font');
  // New text uses the presentation font.
  await evaluate(`store.getState().addElements([defaults.newText(64, 450, {w: 760, doc: defaults.textDoc('New text')})])`); await pause(300);
  assert.equal(await evaluate("[...document.querySelectorAll('.slide.editable .tb-content')].map((e) => getComputedStyle(e).fontFamily.split(',')[0].replace(/['\"]/g, '').trim()).every((f) => f === 'Pretendard')"), true, 'new text is created in the presentation font');
  // Selected text → only that range.
  await evaluate(`store.getState().startEditing('${fontElId}')`); await until(() => evaluate('!!active()'), 'Font editor');
  await select(7, 11); // "beta"
  assert.equal(await fontButtonText(SELECTED), 'Pretendard ▾', 'selected-text control shows the effective font');
  await pickFont(SELECTED, 'Noto Serif KR');
  const runs = (d) => d.content[0].content.map((n) => [n.text, (n.marks ?? []).filter((m) => m.type === 'textStyle').map((m) => m.attrs.fontFamily)[0] ?? null]);
  assert.deepEqual(runs(await doc()), [['Alpha ', null], ['beta', 'Noto Serif KR'], [' gamma', null]], 'only the selected range carries the font');
  assert.equal(await evaluate('store.getState().deck.fontFamily'), 'Pretendard', 'the presentation font is unchanged');
  assert.equal(await familyOf('.el.editing p span'), 'Noto Serif KR');
  assert.equal(await familyOf('.el.editing p'), 'Pretendard');
  assert.equal(await fontButtonText(SELECTED), 'Noto Serif KR ▾');
  // Clearing run colors with a caret keeps the font (same textStyle mark).
  await select(9);
  await evaluate(`import('/src/ui/textFormat.ts').then((m) => m.setTextColor('#2F6FEB'))`); await pause(300);
  assert.deepEqual(runs(await doc()).map((r) => r[1]), [null, 'Noto Serif KR', null], 'caret color change keeps the run font');
  await evaluate('store.getState().stopEditing(); store.getState().select([])'); await pause(400);
  assert.equal(await evaluate("[...document.querySelectorAll('.thumb .tb-content span')].filter((e) => e.textContent === 'beta' && e.style.fontFamily).map((e) => getComputedStyle(e).fontFamily.split(',')[0].replace(/['\"]/g, '').trim()).join()"), 'Noto Serif KR', 'thumbnail shows the range font');
  // Presentation mode and the PDF/print DOM share the same renderer.
  await evaluate('store.setState({presenting: true})'); await pause(400);
  assert.equal(await familyOf('.presenter .tb-content'), 'Pretendard');
  assert.equal(await evaluate("[...document.querySelectorAll('.presenter .tb-content span')].filter((e) => e.textContent === 'beta' && e.style.fontFamily).map((e) => getComputedStyle(e).fontFamily.split(',')[0].replace(/['\"]/g, '').trim()).join()"), 'Noto Serif KR');
  await key('Escape');
  await evaluate("store.setState({exportMode: 'print'})"); await pause(500);
  assert.equal(await evaluate("[...document.querySelectorAll('#print-root .tb-content')].every((e) => /^['\"]?Pretendard/.test(getComputedStyle(e).fontFamily))"), true, 'print/PDF DOM uses the presentation font');
  assert.equal(await evaluate("[...document.querySelectorAll('#print-root .tb-content span')].filter((e) => e.textContent === 'beta' && e.style.fontFamily).map((e) => getComputedStyle(e).fontFamily).join()").then((f) => f.includes('Noto Serif KR')), true, 'print/PDF DOM keeps the range font');
  await evaluate("store.setState({exportMode: null})"); await pause(300);
  // Editable PPTX: the presentation font on the runs, the range font on its run.
  const fontDeckName = await evaluate('persist.safeName(store.getState().deck.title)');
  await evaluate("import('/src/export/run.ts').then((m) => m.exportPptx())");
  await until(() => evaluate(`testFiles[${JSON.stringify(fontDeckName + '.pptx')}]?.length > 1000`), 'PPTX export (fonts)', 30000);
  const fontZip = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(fontDeckName + '.pptx')}]`)));
  const fontSlideNo = (await evaluate('store.getState().deck.slides.findIndex((s) => s.id === ' + JSON.stringify(fontSlideId) + ')')) + 1;
  const fontXml = await fontZip.file('ppt/slides/slide' + fontSlideNo + '.xml').async('string');
  const runFace = (text) => new RegExp('<a:r>(?:(?!</a:r>)[\\s\\S])*?typeface="([^"]+)"(?:(?!</a:r>)[\\s\\S])*?<a:t>' + text + '</a:t>').exec(fontXml)?.[1];
  assert.equal(runFace('Alpha '), 'Pretendard'); assert.equal(runFace('beta'), 'Noto Serif KR'); assert.equal(runFace(' gamma'), 'Pretendard');
  // .mslides content: presentation font + the range mark; older files (no font metadata) open as NanumSquare.
  const fontFile = await evaluate('JSON.stringify(store.getState().deck)');
  assert.equal(JSON.parse(fontFile).fontFamily, 'Pretendard');
  assert.equal((fontFile.match(/"fontFamily":"Noto Serif KR"/g) ?? []).length, 1, 'one range font mark is saved');
  await evaluate(`(() => { const s = store.getState(); store.getState().loadDeck(JSON.parse(${JSON.stringify(fontFile)}), s.assets); store.getState().goToSlide(${JSON.stringify(fontSlideId)}); })()`); await pause(400);
  assert.equal(await evaluate('store.getState().deck.fontFamily'), 'Pretendard', 'reopened: presentation font kept');
  assert.equal(await evaluate("[...document.querySelectorAll('.slide.editable .tb-content span')].filter((e) => e.textContent === 'beta' && e.style.fontFamily).map((e) => getComputedStyle(e).fontFamily).join()").then((f) => f.includes('Noto Serif KR')), true, 'reopened: range font kept');
  const legacy = JSON.parse(fontFile); delete legacy.fontFamily;
  await evaluate(`store.getState().loadDeck(${JSON.stringify(legacy)}, store.getState().assets); store.getState().goToSlide(${JSON.stringify(fontSlideId)})`); await pause(400);
  assert.equal(await familyOf('.slide.editable .tb-content'), 'NanumSquare', 'files without font metadata open in NanumSquare');
  await evaluate(`store.getState().loadDeck(JSON.parse(${JSON.stringify(fontFile)}), store.getState().assets); store.getState().goToSlide(${JSON.stringify(fontSlideId)})`); await pause(400);
  // Top selector again → overwrites the range font everywhere; undo restores it in one step.
  await pickFont(GLOBAL, 'NanumSquare');
  assert.equal(await evaluate('store.getState().deck.fontFamily'), undefined, 'default font is stored as no metadata');
  assert.equal(await evaluate("JSON.stringify(store.getState().deck.slides).includes('fontFamily')"), false, 'every per-range font was overwritten');
  assert.ok((await thumbFamilies()).every((f) => f === 'NanumSquare'));
  await evaluate('store.getState().undo()'); await pause(300);
  assert.equal(await evaluate('store.getState().deck.fontFamily'), 'Pretendard'); assert.equal(await evaluate("JSON.stringify(store.getState().deck.slides).includes('Noto Serif KR')"), true, 'undo restores the range font');
  await evaluate('store.getState().redo()'); await pause(300);
  assert.equal(await evaluate("JSON.stringify(store.getState().deck.slides).includes('fontFamily')"), false);
  // Back to the state the following checks expect.
  await evaluate(`(() => { const s = JSON.parse(${JSON.stringify(fontSnapshot)}); store.getState().loadDeck(s.deck, s.assets); store.getState().goToSlide(s.current); })()`); await pause(400);
  console.log('PASS presentation font (3 bundled fonts, NanumSquare default, top selector overwrites all text and range fonts, selected-text font, new text, thumbnails/presenter/print/PPTX, .mslides persistence, legacy files, undo/redo)');
  // Block Arrow (두꺼운 화살표): filled shape with two compact geometry-adjustment handles (shaft thickness / head length).
  await evaluate('store.getState().stopEditing(); store.getState().select([])'); await pause();
  const arrowSnapshot = await evaluate('JSON.stringify({deck: store.getState().deck, assets: store.getState().assets, current: store.getState().currentSlideId})');
  await evaluate('store.getState().addSlide()'); await pause();
  const arrowSlideId = await evaluate('store.getState().currentSlideId');
  await click('.tb-center button[title="도형"]');
  const shapeMenu = await evaluate("[...document.querySelectorAll('.pop .menu-item')].map((e) => e.textContent)");
  assert.equal(shapeMenu.length, 6, 'one new item'); assert.ok(shapeMenu[4].includes('화살표') && !shapeMenu[4].includes('두꺼운') && shapeMenu[5].includes('두꺼운 화살표'), 'directly below 화살표: ' + shapeMenu.join('|'));
  assert.deepEqual(shapeMenu.slice(0, 4).map((t) => t.replace(/[^가-힣]/g, '')), ['사각형', '둥근사각형', '타원', '선'], 'existing items unchanged');
  await evaluate("[...document.querySelectorAll('.pop .menu-item')].find((e) => e.textContent.includes('두꺼운 화살표')).click()"); await pause(400);
  const arrowEls = () => evaluate("store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements.filter((e) => e.shape === 'blockArrow')");
  let [A] = await arrowEls();
  assert.ok(A, 'inserted'); assert.deepEqual([A.shaft, A.head, A.w, A.h], [0.5, 0.4, 280, 160], 'defaults');
  assert.equal(A.fill, await evaluate("defaults.newShape('rect', 0, 0).fill"), 'same default fill as other shapes'); assert.equal(A.stroke, null);
  assert.equal(await evaluate("document.querySelectorAll('.slide.editable .handle.adjust').length"), 2, 'two adjustment handles while selected');
  assert.equal(await evaluate("document.querySelectorAll('.slide.editable .handle:not(.adjust)').length"), 8, 'normal resize handles stay');
  const arrowPts = (root) => evaluate(`[...document.querySelectorAll(${JSON.stringify(root + ' [data-el-id="' + A.id + '"] polygon')})].map((p) => p.getAttribute('points'))`);
  assert.equal((await arrowPts('.slide.editable')).length, 1, 'filled polygon');
  assert.equal(await evaluate("document.querySelectorAll('.slide.editable [data-el-id=\"" + A.id + "\"] polygon[fill=\"none\"]').length"), 0);
  // Direct manipulation with real pointer events.
  const scale = await evaluate("document.querySelector('.slide.editable').getBoundingClientRect().width / 1280");
  const dragHandle = async (sel, dx, dy) => {
    const r = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
    await send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...r});
    for (const f of [0.3, 1]) await send('Input.dispatchMouseEvent', {type: 'mouseMoved', button: 'left', buttons: 1, x: r.x + dx * scale * f, y: r.y + dy * scale * f});
    await send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, x: r.x + dx * scale, y: r.y + dy * scale}); await pause(200);
  };
  const cur = async () => (await arrowEls())[0];
  const geomOf = (a) => [a.x, a.y, a.w, a.h].join();
  const frame0 = geomOf(A);
  const histBefore = await evaluate('store.getState().past.length');
  await dragHandle('.handle.adjust-shaft', 0, -40); // shaft top 40 → 0... clamped via ratio
  let a = await cur();
  assert.ok(Math.abs(a.shaft - 1) < 0.2 && a.shaft <= 0.95 && a.shaft > 0.7, 'dragging up thickens the shaft (clamped at 0.95): ' + a.shaft);
  assert.equal(a.head, 0.4); assert.equal(geomOf(a), frame0, 'adjustment never resizes the element');
  assert.equal(await evaluate('store.getState().past.length'), histBefore + 1, 'one undo step per drag');
  await evaluate('store.getState().undo()'); await pause(200);
  assert.equal((await cur()).shaft, 0.5, 'undo restores the shaft');
  await evaluate('store.getState().redo()'); await pause(200);
  assert.ok((await cur()).shaft > 0.7, 'redo');
  await dragHandle('.handle.adjust-shaft', 0, 400); // far past the axis → minimum thickness
  assert.equal((await cur()).shaft, 0.1, 'shaft clamps to its minimum');
  await dragHandle('.handle.adjust-head', -60, 0);
  a = await cur();
  assert.ok(a.head > 0.4 && a.head < 0.9 && a.shaft === 0.1, 'dragging left lengthens the head: ' + a.head); assert.equal(geomOf(a), frame0);
  await dragHandle('.handle.adjust-head', -2000, 0);
  assert.equal((await cur()).head, 0.9, 'head clamps to its maximum');
  await dragHandle('.handle.adjust-head', 2000, 0);
  assert.equal((await cur()).head, 0.1, 'head clamps to its minimum (still a visible head)');
  // Set a known adjusted shape for the remaining checks.
  await evaluate(`store.getState().updateElements(['${A.id}'], (e) => { e.shaft = 0.3; e.head = 0.55; })`); await pause(200);
  // Normal resize keeps the proportions.
  const preResize = await cur();
  await dragHandle('.handle.h-e', 60, 0);
  await dragHandle('.handle.h-s', 0, 40);
  a = await cur();
  assert.equal(a.w, preResize.w + 60); assert.equal(a.h, preResize.h + 40); assert.deepEqual([a.shaft, a.head], [0.3, 0.55], 'resize keeps the adjusted proportions');
  const hand = await evaluate(`(() => { const r = document.querySelector('.handle.adjust-head').getBoundingClientRect(), s = document.querySelector('.slide.editable').getBoundingClientRect(); return (r.x + r.width / 2 - s.x) / ${scale} - ${a.x}; })()`);
  assert.ok(Math.abs(hand - a.w * 0.45) < 2, 'head handle sits where the head begins');
  // Styling like other filled shapes.
  await evaluate(`store.getState().updateElements(['${A.id}'], (e) => { e.stroke = '#7C3AED'; e.strokeWidth = 6; e.fill = '#BAE6FD'; })`); await pause(200);
  const ptsEditor = (await arrowPts('.slide.editable'))[0];
  const bb = await evaluate(`(() => { const p = document.querySelector('.slide.editable [data-el-id="${A.id}"] polygon'); const b = p.getBBox(); return [b.x, b.y, b.x + b.width, b.y + b.height]; })()`);
  assert.ok(bb[0] >= 2.9 && bb[1] >= 2.9 && bb[2] <= a.w - 2.9 && bb[3] <= a.h - 2.9, 'outline (with its stroke) stays inside the element box: ' + bb);
  assert.equal(await evaluate("document.querySelector('.slide.editable [data-el-id=\"" + A.id + "\"] polygon').getAttribute('stroke')"), '#7C3AED');
  await screenshot('block-arrow');
  // Move, duplicate, copy/paste, delete.
  await evaluate(`store.getState().updateElements(['${A.id}'], (e) => { e.x += 30; e.y += 10; })`);
  await evaluate("import('/src/canvas/insert.ts').then((m) => m.duplicateSelection())"); await pause(300);
  let arrows = await arrowEls();
  assert.equal(arrows.length, 2); assert.deepEqual([arrows[1].shaft, arrows[1].head, arrows[1].stroke], [0.3, 0.55, '#7C3AED'], 'duplicate keeps geometry');
  const copied = await evaluate("import('/src/canvas/insert.ts').then((m) => m.copySelection())");
  await evaluate(`import('/src/canvas/insert.ts').then((m) => m.pasteElements(${JSON.stringify(copied)}))`); await pause(300);
  arrows = await arrowEls();
  assert.equal(arrows.length, 3); assert.deepEqual([arrows[2].shaft, arrows[2].head], [0.3, 0.55], 'paste keeps geometry');
  await evaluate('store.getState().deleteSelection()'); await pause(200);
  assert.equal((await arrowEls()).length, 2, 'delete');
  await evaluate(`store.getState().updateElements(['${arrows[1].id}'], (e) => { e.x = 700; e.y = 400; })`);
  await evaluate(`store.getState().select([])`); await pause(200);
  assert.equal(await evaluate("document.querySelectorAll('.slide.editable .handle.adjust').length"), 0, 'no adjustment UI when not selected');
  await evaluate(`store.getState().select(['${A.id}'])`); await pause(200);
  // Same geometry in thumbnail, presenter and print DOM.
  assert.equal((await arrowPts('.thumb.current'))[0], ptsEditor, 'thumbnail');
  await evaluate('store.setState({presenting: true})'); await pause(400);
  assert.equal((await arrowPts('.presenter'))[0], ptsEditor, 'presenter'); await key('Escape');
  await evaluate("store.setState({exportMode: 'print'})"); await pause(500);
  assert.equal((await arrowPts('#print-root'))[0], ptsEditor, 'print/PDF');
  await evaluate("store.setState({exportMode: null})"); await pause(300);
  // Persistence: schema is just shaft/head on the shape; older shapes have neither.
  const arrowFile = JSON.parse(await evaluate('JSON.stringify(store.getState().deck)'));
  const savedA = arrowFile.slides.find((s) => s.id === arrowSlideId).elements.find((e) => e.id === A.id);
  assert.deepEqual([savedA.shape, savedA.shaft, savedA.head, savedA.fill, savedA.stroke, savedA.w], ['blockArrow', 0.3, 0.55, '#BAE6FD', '#7C3AED', a.w]);
  await evaluate(`store.getState().loadDeck(JSON.parse(${JSON.stringify(JSON.stringify(arrowFile))}), store.getState().assets); store.getState().goToSlide(${JSON.stringify(arrowSlideId)})`); await pause(400);
  assert.equal((await arrowPts('.slide.editable'))[0], ptsEditor, 'reopened: identical geometry');
  // PPTX: exact outline as a freeform.
  const arrowPptx = await evaluate('persist.safeName(store.getState().deck.title)');
  await evaluate("import('/src/export/run.ts').then((m) => m.exportPptx())");
  await until(() => evaluate(`testFiles[${JSON.stringify(arrowPptx + '.pptx')}]?.length > 1000`), 'PPTX export (arrow)', 30000);
  const arrowZip = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(arrowPptx + '.pptx')}]`)));
  const arrowNo = arrowFile.slides.findIndex((s) => s.id === arrowSlideId) + 1;
  const arrowXml = await arrowZip.file('ppt/slides/slide' + arrowNo + '.xml').async('string');
  const cg = [...arrowXml.matchAll(/<a:custGeom>[\s\S]*?<\/a:custGeom>/g)].map((m) => m[0]);
  assert.equal(cg.length, 2, 'both arrows are freeform shapes');
  assert.equal((cg[0].match(/<a:lnTo>/g) ?? []).length, 6); assert.match(cg[0], /<a:moveTo>/); assert.match(cg[0], /<a:close/);
  assert.match(arrowXml, /val="BAE6FD"/); assert.match(arrowXml, /val="7C3AED"/);
  // The outline in the file matches the on-screen polygon (EMU = px * 9525, offset by half the stroke).
  const emu = (v) => Math.round(v * 9525);
  const sw = 6, pw = a.w - sw, ph = a.h - sw, neck = pw * (1 - 0.55), top = (ph * (1 - 0.3)) / 2;
  const firstPts = [...cg[0].matchAll(/<a:pt x="(\d+)" y="(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const expected = [[0, top], [neck, top], [neck, 0], [pw, ph / 2], [neck, ph], [neck, ph - top]].map(([x, y]) => [emu(x), emu(y)]);
  firstPts.slice(0, 6).forEach((p, i) => { assert.ok(Math.abs(p[0] - expected[i][0]) <= 2 && Math.abs(p[1] - expected[i][1]) <= 2, `PPTX vertex ${i}: ${p} vs ${expected[i]}`); });
  // Existing shapes are unaffected by the new fields.
  assert.equal(await evaluate("(() => { const r = defaults.newShape('rect', 0, 0); return 'shaft' in r || 'head' in r; })()"), false);
  await evaluate(`(() => { const s = JSON.parse(${JSON.stringify(arrowSnapshot)}); store.getState().loadDeck(s.deck, s.assets); store.getState().goToSlide(s.current); })()`); await pause(400);
  console.log('PASS block arrow (menu item, defaults, two adjustment handles, clamping, one undo step per drag, resize keeps proportions, fill/stroke, duplicate/paste/delete, thumbnail/presenter/print geometry, persistence, PPTX freeform)');
  // Instance Background palette + Instance Border (text boxes incl. equations/code, images).
  await evaluate('store.getState().stopEditing(); store.getState().select([])'); await pause();
  const borderSnapshot = await evaluate('JSON.stringify({deck: store.getState().deck, assets: store.getState().assets, current: store.getState().currentSlideId})');
  await evaluate('store.getState().addSlide()'); await pause();
  const bSlideId = await evaluate('store.getState().currentSlideId');
  const bAsset = await evaluate('Object.keys(store.getState().assets)[0]');
  await evaluate(`(() => {
    const T = defaults.newText(64, 60, {w: 480, doc: defaults.textDoc('Hello border box, long enough to wrap onto a second line of text')});
    const E = defaults.newText(64, 260, {w: 480, doc: {type: 'doc', content: [{type: 'mathBlock', attrs: {latex: 'E=mc^2'}}]}});
    const C = defaults.newText(64, 400, {w: 480, doc: {type: 'doc', content: [{type: 'codeBlock', attrs: {language: 'python', fontSize: 16}, content: [{type: 'text', text: 'print(1)'}]}]}});
    const I = {id: 'b-img', type: 'image', assetId: ${JSON.stringify(bAsset)}, x: 700, y: 80, w: 300, h: 150};
    const R = defaults.newShape('rect', 700, 300); const K = defaults.newShape('blockArrow', 700, 480);
    window.__b = {T: T.id, E: E.id, C: C.id, I: I.id, R: R.id, K: K.id};
    store.getState().addElements([T, E, C, I, R, K]); store.getState().select([]);
  })()`); await pause(500);
  const B = await evaluate('window.__b');
  const bEl = (id) => evaluate(`store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements.find((e) => e.id === '${id}')`);
  const outline = (root, id) => evaluate(`(() => { const e = document.querySelector('${root} [data-el-id="${id}"]'); const c = getComputedStyle(e); return c.outlineStyle === 'none' ? 'none' : [c.outlineWidth, c.outlineStyle, c.outlineColor, c.outlineOffset].join(' '); })()`);
  const bSelect = async (id) => { await evaluate(`store.getState().select(['${id}'])`); await pause(250); };
  const chooseSwatch = async (btnTitle, label) => {
    await click(`.propsbar button[title^="${btnTitle}"]`);
    await evaluate(`document.querySelector('.text-palette button[aria-label="${label}"]').click()`); await pause(250);
  };
  const chooseNone = async (btnTitle) => {
    await click(`.propsbar button[title^="${btnTitle}"]`);
    await evaluate("[...document.querySelectorAll('.text-palette .palette-other')].find((b) => b.textContent === '없음').click()"); await pause(250);
  };
  // Toolbar: 테두리 directly right of 배경, both on the shared palette.
  await bSelect(B.T);
  assert.equal(await evaluate(`(() => { const a = document.querySelector('.propsbar button[title^="상자 배경"]'), b = document.querySelector('.propsbar button[title^="상자 테두리"]'); return a.parentElement.nextElementSibling === b.parentElement && [...a.querySelectorAll('.small-label')].concat([...b.querySelectorAll('.small-label')]).map((e) => e.textContent).join(); })()`), '배경,테두리', '테두리 directly right of 배경');
  assert.deepEqual(await evaluate("(() => { const a = document.querySelector('.propsbar button[title^=\"상자 배경\"]').closest('.pop-wrap'); return [a.querySelector('.small-label').textContent, a.nextElementSibling.querySelector('.small-label').textContent]; })()"), ['배경', '테두리']);
  await click('.propsbar button[title^="상자 배경"]');
  assert.deepEqual(await evaluate("[document.querySelectorAll('.text-palette .theme-column').length, document.querySelectorAll('.text-palette .standard-colors .text-swatch').length, [...document.querySelectorAll('.text-palette .palette-other')].map((b) => b.textContent).join()]"), [10, 9, '없음,Other Colors...'], 'Background uses the standard palette (Theme / Standard / none / Other)');
  assert.equal(await evaluate("document.querySelectorAll('.pop .pal').length"), 0, 'old 7-color picker is gone');
  await click('.propsbar button[title^="상자 배경"]'); // close
  await chooseSwatch('상자 배경', 'Standard Yellow');
  assert.equal((await bEl(B.T)).style.fill, '#FACC15');
  await chooseNone('상자 배경');
  assert.equal((await bEl(B.T)).style.fill, null, '없음 clears the background');
  await evaluate(`store.getState().updateElements(['${B.T}'], (e) => { e.style.fill = '#BFBFBF'; })`); await pause(200);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.slide.editable [data-el-id="${B.T}"]')).backgroundColor`), 'rgb(191, 191, 191)', 'stored (old-palette) background colors render unchanged');
  await evaluate(`store.getState().updateElements(['${B.T}'], (e) => { e.style.fill = null; })`);
  // Border: color = on, another color = changed, 없음 = off. Geometry untouched.
  assert.equal('borderColor' in await bEl(B.T), false, 'no border by default'); assert.equal(await outline('.slide.editable', B.T), 'none');
  const dims = () => evaluate(`(() => { const e = document.querySelector('.slide.editable [data-el-id="${B.T}"]'); return [e.offsetWidth, e.offsetHeight, e.querySelector('.tb-content').getBoundingClientRect().height].join(); })()`);
  const dims0 = await dims();
  await chooseSwatch('상자 테두리', 'Standard Red');
  assert.equal((await bEl(B.T)).borderColor, '#DC2626');
  assert.equal(await outline('.slide.editable', B.T), '2px solid rgb(220, 38, 38) -1px');
  assert.equal(await dims(), dims0, 'border does not change size or wrapping');
  await chooseSwatch('상자 테두리', 'Standard Blue');
  assert.equal((await bEl(B.T)).borderColor, '#2563EB');
  // Independence.
  await chooseSwatch('상자 배경', 'Standard Yellow');
  assert.deepEqual([(await bEl(B.T)).style.fill, (await bEl(B.T)).borderColor], ['#FACC15', '#2563EB'], 'background + border');
  await chooseNone('상자 배경');
  assert.deepEqual([(await bEl(B.T)).style.fill, (await bEl(B.T)).borderColor], [null, '#2563EB'], 'no background + border');
  await chooseSwatch('상자 배경', 'Standard Yellow'); await chooseNone('상자 테두리');
  assert.deepEqual([(await bEl(B.T)).style.fill, 'borderColor' in await bEl(B.T)], ['#FACC15', false], 'background + no border'); assert.equal(await outline('.slide.editable', B.T), 'none');
  await chooseNone('상자 배경');
  // Undo / redo.
  await chooseSwatch('상자 테두리', 'Standard Red'); await chooseSwatch('상자 테두리', 'Standard Green');
  await evaluate('store.getState().undo()'); await pause(200);
  assert.equal((await bEl(B.T)).borderColor, '#DC2626', 'undo restores the previous border');
  await evaluate('store.getState().undo()'); await pause(200);
  assert.equal('borderColor' in await bEl(B.T), false, 'undo to no border');
  await evaluate('store.getState().redo(); store.getState().redo()'); await pause(200);
  assert.equal((await bEl(B.T)).borderColor, '#16A34A');
  await chooseNone('상자 테두리'); await evaluate('store.getState().undo()'); await pause(200);
  assert.equal((await bEl(B.T)).borderColor, '#16A34A', '없음 is undoable');
  // Selection frame and handles coexist with the border; deselect keeps the border.
  assert.deepEqual(await evaluate("[document.querySelectorAll('.sel-frame').length, document.querySelectorAll('.handle').length]"), [1, 6]);
  assert.equal(await outline('.slide.editable', B.T), '2px solid rgb(22, 163, 74) -1px');
  const bScale = await evaluate("document.querySelector('.slide.editable').getBoundingClientRect().width / 1280");
  const dragH = async (sel, dx) => {
    const r = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
    await send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...r});
    for (const f of [0.3, 1]) await send('Input.dispatchMouseEvent', {type: 'mouseMoved', button: 'left', buttons: 1, x: r.x + dx * bScale * f, y: r.y});
    await send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, x: r.x + dx * bScale, y: r.y}); await pause(300);
  };
  const w0 = (await bEl(B.T)).w;
  await dragH('.handle.h-e', 60);
  assert.equal((await bEl(B.T)).w, w0 + 60, 'resize works with a border'); assert.equal((await bEl(B.T)).borderColor, '#16A34A');
  await evaluate("store.getState().select([])"); await pause(250);
  assert.equal(await evaluate("document.querySelectorAll('.sel-frame').length"), 0);
  assert.equal(await outline('.slide.editable', B.T), '2px solid rgb(22, 163, 74) -1px', 'border stays when deselected');
  // Equation, code block, image.
  for (const [k, id] of [['E', B.E], ['C', B.C], ['I', B.I]]) {
    await bSelect(id);
    await chooseSwatch('상자 테두리', 'Standard Purple');
    assert.equal((await bEl(id)).borderColor, '#9333EA', k + ' supports a border');
    assert.equal(await outline('.slide.editable', id), '2px solid rgb(147, 51, 234) -1px');
  }
  // Shapes keep their own stroke model: no instance Border control.
  for (const id of [B.R, B.K]) {
    await bSelect(id);
    assert.equal(await evaluate("!!document.querySelector('.propsbar button[title^=\"상자 테두리\"]')"), false, 'no duplicate Border on shapes');
    assert.equal(await evaluate("!!document.querySelector('.propsbar button[title^=\"테두리 (Border)\"]')"), true, 'shape stroke control unchanged');
  }
  // Duplicate / copy-paste / thumbnails / presenter / print.
  await bSelect(B.T);
  await evaluate("import('/src/canvas/insert.ts').then((m) => m.duplicateSelection())"); await pause(300);
  const dupe = await evaluate("(() => { const s = store.getState(); const els = s.deck.slides.find((x) => x.id === s.currentSlideId).elements.filter((e) => e.borderColor === '#16A34A'); return els.length; })()");
  assert.equal(dupe, 2, 'duplicate keeps the border');
  const copiedB = await evaluate("import('/src/canvas/insert.ts').then((m) => m.copySelection())");
  await evaluate(`import('/src/canvas/insert.ts').then((m) => m.pasteElements(${JSON.stringify(copiedB)}))`); await pause(300);
  assert.equal(await evaluate("(() => { const s = store.getState(); return s.deck.slides.find((x) => x.id === s.currentSlideId).elements.filter((e) => e.borderColor === '#16A34A').length; })()"), 3, 'paste keeps the border');
  await evaluate(`(() => { const s = store.getState(); s.select(s.deck.slides.find((x) => x.id === s.currentSlideId).elements.filter((e) => e.borderColor === '#16A34A' && e.id !== '${B.T}').map((e) => e.id)); s.deleteSelection(); })()`); await pause(200);
  await evaluate('store.getState().select([])'); await pause(300);
  await screenshot('instance-border');
  assert.equal(await outline('.thumb.current', B.T), '2px solid rgb(22, 163, 74) -1px', 'thumbnail');
  assert.equal(await outline('.thumb.current', B.I), '2px solid rgb(147, 51, 234) -1px', 'thumbnail image');
  await evaluate('store.setState({presenting: true})'); await pause(400);
  assert.equal(await outline('.presenter', B.T), '2px solid rgb(22, 163, 74) -1px', 'presenter'); await key('Escape');
  await evaluate("store.setState({exportMode: 'print'})"); await pause(500);
  assert.equal(await outline('#print-root', B.T), '2px solid rgb(22, 163, 74) -1px', 'print/PDF');
  assert.equal(await outline('#print-root', B.I), '2px solid rgb(147, 51, 234) -1px', 'print/PDF image');
  await evaluate("store.setState({exportMode: null})"); await pause(300);
  // Persistence and older elements.
  const borderFile = await evaluate('JSON.stringify(store.getState().deck)');
  const savedB = JSON.parse(borderFile).slides.find((s) => s.id === bSlideId).elements;
  assert.deepEqual([savedB.find((e) => e.id === B.T).borderColor, savedB.find((e) => e.id === B.I).borderColor, 'borderColor' in savedB.find((e) => e.id === B.R)], ['#16A34A', '#9333EA', false]);
  await evaluate(`store.getState().loadDeck(JSON.parse(${JSON.stringify(borderFile)}), store.getState().assets); store.getState().goToSlide(${JSON.stringify(bSlideId)})`); await pause(400);
  assert.equal(await outline('.slide.editable', B.T), '2px solid rgb(22, 163, 74) -1px', 'reopened keeps the border');
  assert.equal(await outline('.slide.editable', B.R), 'none', 'elements without border metadata render as before');
  // PPTX: native outline rectangles (text box + image).
  const borderPptx = await evaluate('persist.safeName(store.getState().deck.title)');
  await evaluate("import('/src/export/run.ts').then((m) => m.exportPptx())");
  await until(() => evaluate(`testFiles[${JSON.stringify(borderPptx + '.pptx')}]?.length > 1000`), 'PPTX export (border)', 30000);
  const borderZip = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(borderPptx + '.pptx')}]`)));
  const borderNo = JSON.parse(borderFile).slides.findIndex((s) => s.id === bSlideId) + 1;
  const borderXml = await borderZip.file('ppt/slides/slide' + borderNo + '.xml').async('string');
  const bShapes = [...borderXml.matchAll(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*?name="Instance Border"[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
  assert.equal(bShapes.length, 4, 'text, equation, code and image borders are native shapes: ' + bShapes.length);
  assert.ok(bShapes.every((x) => x.includes('<a:ln w="19050"')) && bShapes.some((x) => x.includes('val="16A34A"')) && bShapes.some((x) => x.includes('val="9333EA"')), '1.5pt lines in the chosen colors');
  assert.ok(bShapes.every((x) => x.includes('<a:noFill/>') || x.includes('FACC15') === false), 'no background fill unless chosen');
  await evaluate(`(() => { const s = JSON.parse(${JSON.stringify(borderSnapshot)}); store.getState().loadDeck(s.deck, s.assets); store.getState().goToSlide(s.current); })()`); await pause(400);
  console.log('PASS instance background palette + border (shared palette, 없음, independence, text/equation/code/image, shapes untouched, undo/redo, selection coexistence, resize, duplicate/paste, thumbnail/presenter/print, persistence, PPTX)');
  // Full emoji picker for Callouts: quick row + ⋯ → searchable picker; same icon attribute and history path as the quick icons.
  await evaluate('store.getState().stopEditing(); store.getState().select([])'); await pause();
  const emojiSnapshot = await evaluate('JSON.stringify({deck: store.getState().deck, assets: store.getState().assets, current: store.getState().currentSlideId})');
  await evaluate('store.getState().addSlide()'); await pause();
  const emSlideId = await evaluate('store.getState().currentSlideId');
  const callout = (t) => ({type: 'callout', attrs: {icon: '💡'}, content: [{type: 'paragraph', content: [{type: 'text', text: t}]}]});
  const emDoc = {type: 'doc', content: ['one', 'two', 'three', 'four'].map(callout)};
  await evaluate(`(() => { const t = defaults.newText(64, 150, {w: 700, doc: ${JSON.stringify(emDoc)}}); window.__em = t.id; store.getState().addElements([t]); })()`); await pause(400);
  const emId = await evaluate('window.__em');
  await evaluate(`store.getState().startEditing('${emId}')`); await until(() => evaluate('!!active()'), 'Emoji editor'); await pause(500);
  const emIcons = async () => (await doc()).content.filter((n) => n.type === 'callout').map((c) => c.attrs.icon);
  const openQuick = (i) => evaluate(`document.querySelectorAll('.el.editing .callout-icon')[${i}].dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}))`).then(() => pause(200));
  const openFull = async (i) => { await openQuick(i); await evaluate("document.querySelector('.el.editing .callout-icons button.more').dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}))"); await until(() => evaluate("!!document.querySelector('.emoji-picker .emoji-grid button')"), 'emoji data loaded'); await pause(150); };
  const gridTexts = () => evaluate("[...document.querySelectorAll('.emoji-picker .emoji-grid button')].map((b) => b.textContent)");
  const typeQuery = async (q) => { await evaluate("(() => { const i = document.querySelector('.emoji-search'); i.focus(); })()"); await send('Input.insertText', {text: q}); await pause(250); };
  const clickEmoji = (e) => evaluate(`[...document.querySelectorAll('.emoji-picker .emoji-grid button')].find((b) => b.textContent === ${JSON.stringify(e)}).click()`).then(() => pause(250));
  // Quick row unchanged + ⋯ at its end.
  await openQuick(0);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.el.editing .callout-icons button')].map((b) => b.textContent)"), ['💡', 'ℹ️', '⚠️', '✅', '❌', '📌', '🔥', '💬', '⭐', '🚀', '⋯'], 'quick emojis kept, ⋯ at the end');
  await evaluate("document.querySelectorAll('.el.editing .callout-icons button')[6].dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}))"); await pause(250);
  assert.equal((await emIcons())[0], '🔥', 'quick pick still works');
  // Open the full picker.
  await openFull(1);
  assert.equal(await evaluate("document.querySelectorAll('.el.editing .callout-icons').length"), 0, 'quick row closes');
  assert.equal(await evaluate("document.activeElement?.classList.contains('emoji-search')"), true, 'search is focused');
  assert.equal(await evaluate("document.querySelectorAll('.emoji-cats button').length"), 9, 'compact category navigation (standard groups)');
  assert.equal(await evaluate("document.querySelectorAll('.emoji-picker section[data-group]').length"), 9);
  assert.ok((await gridTexts()).length > 1500, 'full set: ' + (await gridTexts()).length);
  assert.equal(await evaluate("document.querySelectorAll('.emoji-picker').length"), 1);
  await screenshot('emoji-picker');
  // Search (dataset labels/tags), selection, one history step per selection.
  await typeQuery('brain');
  let res = await gridTexts(); assert.ok(res.includes('🧠') && res.length < 12, 'brain → 🧠: ' + res.join(''));
  await evaluate("document.querySelector('.emoji-cats button').disabled").then((d) => assert.equal(d, true, 'categories pause while searching'));
  await clickEmoji('🧠');
  assert.equal(await evaluate("document.querySelectorAll('.emoji-picker').length"), 0, 'picker closes after selecting');
  assert.deepEqual(await emIcons(), ['🔥', '🧠', '💡', '💡']);
  assert.equal(await evaluate("document.querySelectorAll('.el.editing .callout-icon')[1].textContent"), '🧠', 'shown immediately');
  assert.equal(await evaluate('store.getState().editingId'), emId, 'still editing the same box');
  await evaluate('active().commands.undo()'); await pause();
  assert.deepEqual(await emIcons(), ['🔥', '💡', '💡', '💡'], 'undo restores the previous icon in one step');
  await evaluate('active().commands.redo()'); await pause();
  assert.equal((await emIcons())[1], '🧠', 'redo');
  await openFull(2); await typeQuery('robot'); res = await gridTexts(); assert.ok(res.includes('🤖')); await clickEmoji('🤖');
  await openFull(3); await typeQuery('bar chart'); res = await gridTexts(); assert.ok(res.includes('📊'), 'chart → 📊: ' + res.join('')); await clickEmoji('📊');
  assert.deepEqual(await emIcons(), ['🔥', '🧠', '🤖', '📊']);
  // Multi-codepoint emoji stays one emoji.
  await openFull(0); await typeQuery('technologist'); res = await gridTexts();
  assert.ok(res.includes('👨‍💻'), 'ZWJ sequence found: ' + res.join('')); await clickEmoji('👨‍💻');
  assert.equal((await emIcons())[0], '👨‍💻'); assert.equal(Array.from((await emIcons())[0]).length, 3, 'one ZWJ sequence (man + ZWJ + laptop), not split');
  // Keyboard/focus: typing + Backspace in search never reaches canvas shortcuts; Escape / outside click close; still editing.
  const elCount = () => evaluate("store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements.length");
  const nEl = await elCount();
  await openFull(1);
  await typeQuery('trm');
  for (let n = 0; n < 4; n++) { // real Backspace presses (virtual key code 8 so the input edits)
    await send('Input.dispatchKeyEvent', {type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8});
    await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8}); await pause(80);
  }
  assert.equal(await evaluate("document.querySelector('.emoji-search').value"), '', 'search edits normally');
  assert.equal(await elCount(), nEl, 'no canvas shortcut fired (no element added/deleted)'); assert.equal(await evaluate('store.getState().editingId'), emId);
  await key('Escape');
  assert.equal(await evaluate("document.querySelectorAll('.emoji-picker').length"), 0, 'Escape closes');
  assert.equal(await evaluate('store.getState().editingId'), emId, 'Escape closed only the picker'); assert.equal(await elCount(), nEl);
  await openFull(1);
  await evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}))"); await pause(200);
  assert.equal(await evaluate("document.querySelectorAll('.emoji-picker').length"), 0, 'outside click closes'); assert.equal((await emIcons())[1], '🧠', 'nothing changed');
  // Near the window edges the picker flips/clamps and stays fully visible.
  for (const [x, y] of [[-1, -1], [1e5, 1e5], [1e5, 30], [30, 1e5]]) {
    const r = await evaluate(`import('/src/editor/EmojiPicker.tsx').then(async (m) => { m.openEmojiPicker({anchor: new DOMRect(Math.min(${x}, innerWidth - 20), Math.min(${y}, innerHeight - 20), 20, 20), current: '', onPick() {}}); await new Promise((r) => setTimeout(r, 150)); const b = document.querySelector('.emoji-picker').getBoundingClientRect(); m.closeEmojiPicker(); return [b.left >= 0, b.top >= 0, b.right <= innerWidth, b.bottom <= innerHeight]; })`);
    assert.deepEqual(r, [true, true, true, true], `picker inside the window for anchor ${x},${y}`);
  }
  // No result message.
  await openFull(1); await typeQuery('zzzzqq'); assert.equal(await evaluate("document.querySelector('.emoji-empty')?.textContent"), '검색 결과 없음'); await key('Escape');
  // Rendering, duplicate, copy/paste, persistence — the same stored string everywhere.
  await evaluate('store.getState().stopEditing(); store.getState().select([])'); await pause(400);
  const want = '👨‍💻,🧠,🤖,📊';
  const iconsIn = (where) => evaluate(`[...document.querySelectorAll('${where} .callout .callout-icon')].map((e) => e.textContent).join()`);
  assert.equal(await iconsIn('.slide.editable'), want); assert.equal(await iconsIn('.thumb.current'), want, 'thumbnail');
  assert.equal(await evaluate("document.querySelectorAll('.slide.editable .callout-icons, .slide.editable .emoji-picker, .thumb .callout button').length"), 0, 'no picker UI in static rendering');
  await evaluate('store.setState({presenting: true})'); await pause(400); assert.equal(await iconsIn('.presenter'), want, 'presenter'); await key('Escape');
  await evaluate("store.setState({exportMode: 'print'})"); await pause(500); assert.equal(await iconsIn('#print-root #slide-' + emSlideId), want, 'print/PDF'); await evaluate("store.setState({exportMode: null})"); await pause(300);
  await evaluate(`store.getState().select(['${emId}'])`); await pause(200);
  await evaluate("import('/src/canvas/insert.ts').then((m) => m.duplicateSelection())"); await pause(300);
  const emDocs = () => evaluate(`store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements.filter((e) => e.type === 'text' && JSON.stringify(e.doc).includes('callout')).map((e) => e.doc.content.map((c) => c.attrs.icon).join())`);
  assert.deepEqual(await emDocs(), [want, want], 'duplicate keeps the emoji');
  const emCopied = await evaluate("import('/src/canvas/insert.ts').then((m) => m.copySelection())");
  await evaluate(`import('/src/canvas/insert.ts').then((m) => m.pasteElements(${JSON.stringify(emCopied)}))`); await pause(300);
  assert.deepEqual(await emDocs(), [want, want, want], 'copy/paste keeps the emoji');
  const emFile = await evaluate('JSON.stringify(store.getState().deck)');
  assert.ok(emFile.includes('"icon":"👨‍💻"') && emFile.includes('"icon":"🧠"'), 'plain Unicode strings in .mslides');
  assert.ok(!/hexcode|emojibase|"group"/.test(emFile), 'no picker metadata persisted');
  await evaluate(`store.getState().loadDeck(JSON.parse(${JSON.stringify(emFile)}), store.getState().assets); store.getState().goToSlide(${JSON.stringify(emSlideId)})`); await pause(400);
  assert.equal(await iconsIn('.slide.editable'), want + ',' + want + ',' + want, 'reopened');
  // PPTX: the existing Callout export path writes the chosen emoji.
  const emPptx = await evaluate('persist.safeName(store.getState().deck.title)');
  await evaluate("import('/src/export/run.ts').then((m) => m.exportPptx())");
  await until(() => evaluate(`testFiles[${JSON.stringify(emPptx + '.pptx')}]?.length > 1000`), 'PPTX export (emoji)', 30000);
  const emZip = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(emPptx + '.pptx')}]`)));
  const emXml = await emZip.file('ppt/slides/slide' + (JSON.parse(emFile).slides.findIndex((s) => s.id === emSlideId) + 1) + '.xml').async('string');
  for (const e of ['👨‍💻', '🧠', '🤖', '📊']) assert.ok(emXml.includes('<a:t>' + e + '</a:t>'), 'PPTX icon ' + e);
  await evaluate(`(() => { const s = JSON.parse(${JSON.stringify(emojiSnapshot)}); store.getState().loadDeck(s.deck, s.assets); store.getState().goToSlide(s.current); })()`); await pause(400);
  console.log('PASS callout emoji picker (quick row + ⋯, full searchable picker, categories, multi-codepoint emoji, undo/redo, keyboard/focus, rendering, duplicate/paste, persistence, PPTX)');
  // Todo block (/todo): semantic node with a checked attribute; node-UI checkbox; presentation-only checked look.
  await evaluate('store.getState().addSlide()'); await pause();
  await evaluate(`store.getState().addElements([defaults.newText(64, 300, {w: 760})], {edit: true})`);
  await until(() => evaluate('!!active()'), 'Todo editor');
  const todos = async () => (await doc()).content.filter((n) => n.type === 'todoItem');
  const toggleBox = async (i) => { await pause(600); await evaluate(`document.querySelectorAll('.el.editing .todo-box')[${i}].dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}))`); await pause(); };
  const look = (i) => evaluate(`(() => { const t = document.querySelectorAll('.el.editing .todo-text')[${i}]; const cs = getComputedStyle(t); return [cs.color, cs.textDecorationLine, getComputedStyle(t.previousElementSibling).backgroundColor]; })()`);
  await send('Input.insertText', {text: '/todo'}); await pause();
  assert.equal(await evaluate("[...document.querySelectorAll('.slash-item .slash-name')].map(e => e.textContent).join()"), 'Todo');
  await key('Enter'); await pause();
  assert.deepEqual((await doc()).content.map((n) => n.type), ['todoItem'], 'semantic todo node');
  assert.deepEqual((await doc()).content[0].attrs, {checked: false}, 'unchecked by default');
  assert.ok(!JSON.stringify(await doc()).includes('/todo') && !/[☐☑]/.test(JSON.stringify(await doc())), 'trigger removed; checkbox is not text');
  const todoCreated = await doc();
  await evaluate('active().commands.undo()'); await pause();
  assert.equal((await doc()).content[0].type, 'paragraph', 'undo /todo conversion'); assert.equal((await doc()).content[0].content[0].text, '/todo');
  await evaluate('active().commands.redo()'); await pause();
  assert.deepEqual(await doc(), todoCreated, 'redo /todo conversion');
  await send('Input.insertText', {text: 'Read the paper'}); await pause();
  await evaluate(`(() => { let at = 0; active().state.doc.descendants((n, p) => { if (n.isText && n.text.startsWith('Read')) at = p; }); active().commands.setTextSelection({from: at, to: at + 4}); })()`); await pause();
  await click('.propsbar button[title="굵게 ⌘B"]'); await pause();
  await evaluate("active().commands.focus('end')"); await key('Enter'); await send('Input.insertText', {text: 'Prepare slides'}); await pause();
  assert.deepEqual((await doc()).content.map((n) => [n.type, n.attrs.checked]), [['todoItem', false], ['todoItem', false]], 'Enter creates the next unchecked todo');
  assert.deepEqual((await todos()).map((t) => t.content.map((x) => x.text).join('')), ['Read the paper', 'Prepare slides']);
  const caret = await evaluate('active().state.selection.from');
  await toggleBox(0);
  assert.deepEqual((await todos()).map((t) => t.attrs.checked), [true, false], 'checkbox toggles one todo');
  assert.equal(await evaluate('active().state.selection.from'), caret, 'toggling does not move the caret');
  let l0 = await look(0), l1 = await look(1);
  assert.deepEqual([l0[0], l0[1]], ['rgb(156, 163, 175)', 'line-through'], 'checked: muted gray + strikethrough');
  assert.equal(l0[2], 'rgb(136, 19, 55)', 'checked box uses the Theme Color');
  assert.deepEqual([l1[0], l1[1], l1[2]], ['rgb(0, 0, 0)', 'none', 'rgba(0, 0, 0, 0)'], 'unchecked todo keeps its normal look');
  assert.deepEqual((await todos())[0].content[0].marks.map((m) => m.type), ['bold'], 'stored marks are untouched by the checked look');
  await evaluate('active().commands.undo()'); await pause();
  assert.deepEqual((await todos()).map((t) => t.attrs.checked), [false, false], 'undo toggle');
  await evaluate('active().commands.redo()'); await pause();
  await toggleBox(0); assert.equal((await todos())[0].attrs.checked, false, 'uncheck');
  assert.deepEqual((await look(0)).slice(0, 2), ['rgb(0, 0, 0)', 'none'], 'unchecking restores the normal look');
  await toggleBox(0); await toggleBox(1); await toggleBox(1);
  assert.deepEqual((await todos()).map((t) => t.attrs.checked), [true, false], 'independent states');
  await evaluate("active().commands.focus('end')"); await key('Enter'); await pause();
  assert.equal((await doc()).content.length, 3);
  await pause(600); await key('Enter'); await pause();
  assert.deepEqual((await doc()).content.map((n) => n.type), ['todoItem', 'todoItem', 'paragraph'], 'Enter on an empty todo exits to a paragraph');
  await evaluate('active().commands.undo()'); await pause();
  assert.equal((await doc()).content[2].type, 'todoItem', 'undo exiting the todo');
  await evaluate('active().commands.redo()'); await pause();
  await send('Input.insertText', {text: 'tail'}); await pause();
  await evaluate('store.getState().stopEditing()'); await pause();
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.slide.editable .todo')].map(e => e.dataset.checked)"), ['true', 'false'], 'static render keeps the checked state');
  assert.ok(await evaluate("document.querySelectorAll('.thumb.current .todo').length") === 2, 'thumbnail renders todos');
  assert.equal(await evaluate("document.querySelectorAll('.slide.editable .todo [contenteditable]').length"), 0);
  // Without a usable Theme Color the checked box falls back to the editor accent.
  await evaluate("store.getState().commit((d) => { d.themeColor = '#FFFFFF'; })"); await pause();
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.slide.editable .todo[data-checked=true] .todo-box')).backgroundColor"), 'rgb(47, 111, 235)', 'White theme: visible fallback accent');
  await evaluate("store.getState().commit((d) => { d.themeColor = '#881337'; })"); await pause();
  console.log('PASS todo block (/todo, checkbox, checked look, Theme Color accent, Enter/exit, undo/redo, static/thumbnail)');
  // Shared PowerPoint-style palette for Background / Border; Fill and Highlight keep their Quick Colors.
  await evaluate('store.getState().select([])'); await pause();
  const bgBefore = await evaluate('store.getState().deck.slides.find(s => s.id === store.getState().currentSlideId).background');
  const themeBefore = await evaluate('store.getState().deck.themeColor');
  const fullPalette = () => evaluate("({full: !!document.querySelector('.text-palette'), sections: [...document.querySelectorAll('.text-palette .palette-heading')].map(e => e.textContent).join(), quick: !!document.querySelector('.highlight-palette')})");
  await click('.propsbar button[title^="Theme:"]');
  assert.equal((await fullPalette()).sections, 'Theme Colors,Standard Colors', 'Theme uses the full palette'); await key('Escape'); await pause();
  await click('.propsbar button[title^="슬라이드 배경"]');
  assert.deepEqual(await fullPalette(), {full: true, sections: 'Theme Colors,Standard Colors', quick: false}, 'Slide Background uses the full palette');
  await click('button[aria-label="Blue shade 4"]'); await pause();
  assert.equal(await evaluate('store.getState().deck.slides.find(s => s.id === store.getState().currentSlideId).background'), '#2563EB', 'background color applied');
  assert.equal(await evaluate('store.getState().deck.themeColor'), themeBefore, 'Theme is independent of the background');
  await evaluate('store.getState().undo()'); await pause();
  assert.equal(await evaluate('store.getState().deck.slides.find(s => s.id === store.getState().currentSlideId).background'), bgBefore, 'undo background');
  await evaluate('store.getState().redo(); store.getState().undo()'); await pause();
  const shapeSlideId = await evaluate("store.getState().deck.slides.find(s => s.elements.some(e => e.id === 'legacy-shape')).id");
  await evaluate(`store.getState().goToSlide('${shapeSlideId}'); store.getState().select(['${sB}'])`); await pause(300);
  const strokeBefore = (await shapeNow(sB)).stroke, fillBefore = (await shapeNow(sB)).fill;
  await click('.propsbar button[title^="테두리 (Border)"]');
  assert.deepEqual(await fullPalette(), {full: true, sections: 'Theme Colors,Standard Colors', quick: false}, 'Shape Border uses the full palette');
  await click('button[aria-label="Purple shade 4"]'); await pause();
  assert.equal((await shapeNow(sB)).stroke, '#7C3AED', 'border color applied');
  assert.equal((await shapeNow(sB)).fill, fillBefore, 'fill is independent of the border');
  await pause(300); await click('.propsbar button[title^="테두리 (Border)"]');
  await evaluate("[...document.querySelectorAll('.text-palette .palette-other')].find(b => b.textContent === '테두리 없음').click()"); await pause();
  assert.equal((await shapeNow(sB)).stroke, null, 'no border state'); assert.equal((await shapeNow(sB)).fill, fillBefore);
  await evaluate('store.getState().undo()'); await pause();
  assert.equal((await shapeNow(sB)).stroke, '#7C3AED', 'undo no border');
  await evaluate('store.getState().undo()'); await pause();
  assert.equal((await shapeNow(sB)).stroke, strokeBefore, 'undo border color');
  await click('.propsbar button[title^="채우기 (Fill)"]');
  assert.deepEqual(await fullPalette(), {full: false, sections: '', quick: true}, 'Shape Fill keeps its Quick Colors'); await key('Escape'); await pause();
  console.log('PASS shared palette (Theme/Background/Border use the full palette; Fill keeps Quick Colors; independence, no border, undo)');
  // Test .mslides download and the real openProject path with its file-picker boundary supplied.
  await evaluate('store.getState().stopEditing(); persist.saveProject()');
  const projectPath = path.join(output,'Formatting validation.mslides');
  await writeFile(projectPath, Buffer.from(await evaluate("testFiles['Formatting validation.mslides']")));
  const saved = JSON.parse(await readFile(projectPath,'utf8'));
  assert.deepEqual(saved.deck.slides[0].elements[0].doc, mixed);
  const savedSlide2 = JSON.stringify(saved.deck.slides[1]);
  assert.ok(savedSlide2.includes('"callout"') && savedSlide2.includes('"icon":"⚠️"') && savedSlide2.includes('"icon":"✅"'), '.mslides keeps callouts and their icons');
  assert.ok(savedSlide2.includes('"academicBlock"') && savedSlide2.includes('"type":"theorem"') && savedSlide2.includes('"title":"Policy Gradient Theorem"') && savedSlide2.includes('"type":"definition"'), '.mslides keeps academic block type and title');
  const shapeSlide = saved.deck.slides.find((x) => x.elements.some((e) => e.type === 'shape' && e.doc));
  const shapeSaved = shapeSlide.elements.filter((e) => e.type === 'shape');
  assert.deepEqual(shapeSaved.map((e) => !!e.doc), [true, false, false], '.mslides keeps shape text (empty shapes have none)');
  assert.deepEqual(shapeSaved.map((e) => e.fill), ['#FEF08A', '#FBCFE8', '#BFBFBF'], '.mslides keeps shape fills (default yellow, chosen pink, legacy gray)');
  assert.ok(JSON.stringify(shapeSaved[0].doc).includes('Policy') && JSON.stringify(shapeSaved[0].doc).includes(' Gradient') && JSON.stringify(shapeSaved[0].doc).includes('"bold"'));
  const todoSlide = saved.deck.slides.find((x) => JSON.stringify(x.elements).includes('todoItem'));
  assert.ok(JSON.stringify(todoSlide.elements).includes('"checked":true') && JSON.stringify(todoSlide.elements).includes('"checked":false'), '.mslides keeps todo checked states');
  const imageSlide = saved.deck.slides.find((x) => x.elements.some((e) => e.type === 'image'));
  assert.deepEqual(imageSlide.elements.filter((e) => e.type === 'image').map((e) => e.caption), ['Figure 1. Baseline', 'Architecture of the proposed model', ''], '.mslides keeps captions');
  assert.ok(!JSON.stringify(saved).includes('Add a caption'), 'placeholder never persisted');
  assert.ok(savedSlide2.includes('"codeBlock"') && savedSlide2.includes('"blockquote"'), '.mslides keeps code/quote blocks');
  for (const l of ['python', 'c', 'bash']) assert.ok(savedSlide2.includes(`"language":"${l}"`), '.mslides keeps language ' + l);
  await evaluate(`persist.newProject()`); await pause();
  assert.equal(await evaluate('store.getState().deck.title'), 'Untitled presentation');
  assert.equal(await evaluate('store.getState().deck.themeColor'), undefined, 'a new presentation starts without a theme (White)');
  assert.equal(await evaluate('persist.loadRecovery().then(r => r[0].deck.title)'), 'Formatting validation', 'New kept the displaced work in the recovery slot');
  await evaluate('persist.restoreRecovered()');
  assert.deepEqual(await evaluate('store.getState().deck'), saved.deck);
  assert.equal(saved.deck.themeColor, '#881337', 'theme color is saved in the deck');
  await evaluate(`persist.newProject()`);
  await evaluate(`window.showOpenFilePicker=async()=>[{getFile:async()=>new File([${JSON.stringify(JSON.stringify(saved))}],'fixture.mslides',{type:'application/json'})}]; persist.openProject()`);
  assert.deepEqual(await evaluate('store.getState().deck'), saved.deck);
  await evaluate('delete window.showOpenFilePicker; store.setState({fileHandle:null})');
  await until(()=>evaluate("store.getState().saveState === 'saved'"), 'Autosave pending');
  // Close and start the actual desktop process with the same disposable profile.
  const archiveBeforeRestart = await evaluate("persist.loadRecovery().then(a => a.map(x => x.savedAt + ':' + x.deck.id).join())");
  socket.close(); electron.kill('SIGTERM'); await new Promise(r=>electron.once('exit',r));
  await launch();
  assert.deepEqual(await evaluate('store.getState().deck'), saved.deck, 'restart restores the working presentation (same Deck.id and content)');
  assert.equal(await evaluate("persist.loadRecovery().then(a => a.map(x => x.savedAt + ':' + x.deck.id).join())"), archiveBeforeRestart, 'restart does not displace anything');
  console.log('PASS autosave, desktop restart, recovery swap, .mslides save/open');
  // Exercise both existing export actions from the fixed toolbar.
  await click('.export-menu > button');
  await click('.pop .menu-item:first-child');
  await until(async()=>{try{return (await readFile(path.join(output,'Formatting validation.pdf'))).length > 1000}catch{return false}}, 'PDF export');
  await until(()=>evaluate('store.getState().exportMode === null'), 'PDF export completion');
  await click('.export-menu > button'); await click('.pop .menu-item:nth-child(2)');
  const pptxPath = path.join(output,'Formatting validation.pptx');
  await until(()=>evaluate("testFiles['Formatting validation.pptx']?.length > 1000"), 'PPTX export', 30000);
  await writeFile(pptxPath, Buffer.from(await evaluate("testFiles['Formatting validation.pptx']")));
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  for (const color of ['DC2626','3B82F6','9333EA']) assert.ok(xml.includes('val="'+color+'"'), 'editable per-run color '+color);
  for (const color of ['FEF08A','BAE6FD','F1F1EF']) assert.ok(xml.includes('<a:highlight><a:srgbClr val="'+color+'"'), 'native highlight '+color);
  assert.match(xml, /typeface="Menlo"/);
  assert.match(xml, /<a:t>torch.nn.Module<\/a:t>/);
  assert.ok(!xml.includes('<p:pic>'), 'Formatted text was not rasterized');
  assert.match(await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string'), /https:\/\/arxiv.org\/abs\/1706.03762/);
  const xml2 = await zip.file('ppt/slides/slide2.xml').async('string');
  assert.match(xml2, /<a:t>    <\/a:t>[\s\S]{0,900}<a:t>return<\/a:t>/, 'code indentation is kept as editable text');
  assert.match(xml2, /name="Code Block"[\s\S]*?prst="roundRect"/, 'code background is a native rounded rectangle');
  assert.match(xml2, /name="Code"[\s\S]*?typeface="Menlo"/, 'code text uses the monospace font');
  assert.match(xml2, /sz="1200"[\s\S]{0,700}<a:t>def<\/a:t>/, 'F: 16px code = 12pt');
  assert.match(xml2, /val="CF222E"[\s\S]{0,700}<a:t>def<\/a:t>/, 'F: Python keyword is its own colored run');
  assert.match(xml2, /val="0550AE"[\s\S]{0,700}<a:t>0<\/a:t>/, 'F: C number run');
  assert.match(xml2, /val="6A737D"[\s\S]{0,700}<a:t>\/\/ done<\/a:t>/, 'F: C comment run');
  assert.ok(!/<a:t>(Plain Text|Python|Bash)<\/a:t>/.test(xml2), 'F: language selector is not exported');
  assert.match(xml2, /name="Quote Line"[\s\S]*?prst="line"/, 'quote line is a native line');
  assert.match(xml2, /<a:t>Clipping<\/a:t>/, 'quote text is editable');
  assert.equal((xml2.match(/<p:pic>/g) || []).length, 2, 'only the two equations (E=mc^2, x^2 in the block) are pictures; code/quote/callout/block are not rasterized');
  assert.equal((xml2.match(/name="Callout"[\s\S]{0,400}?prst="roundRect"/g) || []).length, 2, 'callout backgrounds are native rounded rectangles');
  assert.match(xml2, /name="Callout Icon"[\s\S]{0,1200}<a:t>⚠️<\/a:t>/, 'callout icon is editable text');
  assert.match(xml2, /<a:t>✅<\/a:t>/);
  assert.match(xml2, /b="1"[\s\S]{0,900}<a:t>Key<\/a:t>/, 'callout text keeps bold as an editable run');
  assert.match(xml2, /<a:t>second line<\/a:t>/, 'multi-line callout content is editable text');
  assert.ok(!/callout-icons|Apple Color Emoji.*picker/.test(xml2) && !xml2.includes('아이콘 변경'), 'icon picker is not exported');
  assert.equal((xml2.match(/name="Block Body"[\s\S]{0,400}?prst="roundRect"/g) || []).length, 2, 'block bodies are native shapes');
  assert.equal((xml2.match(/name="Block Header"[\s\S]{0,400}?prst="roundRect"/g) || []).length, 2, 'block headers are native shapes');
  assert.ok(xml2.includes('val="3465A4"') && xml2.includes('val="1F7A7A"') && xml2.includes('val="EEF3FA"') && xml2.includes('val="ECF6F5"'), 'family colors in PPTX');
  assert.match(xml2, /b="1"[\s\S]{0,700}<a:t>Theorem<\/a:t>/, 'type label is bold editable text');
  assert.match(xml2, /<a:t> — <\/a:t>[\s\S]{0,700}<a:t>Policy Gradient Theorem<\/a:t>/, 'title is separate editable text');
  assert.match(xml2, /<a:t>Definition<\/a:t>/); assert.match(xml2, /<a:t>Markov property<\/a:t>/); assert.match(xml2, /<a:t>Statement<\/a:t>/);
  assert.ok(!xml2.includes('제목 (선택)') && !xml2.includes('▾'), 'selector / title input are not exported');
  const shapeXml = await zip.file('ppt/slides/slide' + (saved.deck.slides.indexOf(shapeSlide) + 1) + '.xml').async('string');
  const spChunks = shapeXml.split('<p:sp>');
  const textShape = spChunks.find((c) => c.includes('name="Shape Text"'));
  assert.ok(textShape, 'shape with text is ONE native shape');
  assert.ok(textShape.includes('prst="rect"') && textShape.includes('val="FEF08A"'), 'native shape geometry and the default yellow fill');
  assert.ok(spChunks.find((c) => c.includes('prst="ellipse"')).includes('val="FBCFE8"') && spChunks.find((c) => c.includes('prst="roundRect"') && c.includes('BFBFBF')), 'palette fill and legacy gray fill are native shape fills');
  assert.match(textShape, /anchor="ctr"/); assert.match(textShape, /algn="ctr"/);
  assert.match(textShape, /b="1"[\s\S]{0,700}<a:t>Policy<\/a:t>/); assert.match(textShape, /<a:t>second line<\/a:t>/);
  assert.equal(spChunks.filter((c) => c.includes('<a:t>Policy</a:t>') || c.includes('second line')).length, 1, 'the text lives only in the shape, no separate text box over it');
  assert.ok(!spChunks.find((c) => c.includes('prst="ellipse"'))?.includes('<a:t>'), 'empty shape exports no text');
  assert.ok(!/ProseMirror|caret/.test(shapeXml), 'no editor UI exported');
  const themeSlideXml = async (pred) => zip.file('ppt/slides/slide' + (saved.deck.slides.findIndex(pred) + 1) + '.xml').async('string');
  const titleXml = await themeSlideXml((x) => x.id === saved.deck.slides[0].id);
  assert.match(titleXml, /name="Theme Title Band"[\s\S]{0,500}prst="rect"[\s\S]{0,200}val="881337"/, 'title band is a native rectangle');
  assert.ok(titleXml.indexOf('name="Theme Title Band"') < titleXml.indexOf('<a:t>'), 'theme shapes sit under the content');
  assert.match(titleXml, /name="Theme Footer Accent"/);
  assert.match(xml2, /name="Theme Header Band"[\s\S]{0,500}val="881337"/, 'header band is native');
  assert.match(xml2, /val="FFFFFF"[\s\S]{0,500}<a:t>슬라이드 제목<\/a:t>/, 'white editable title text over the dark header');
  const subXml = await themeSlideXml((x) => x.kind === 'subtitle');
  assert.match(subXml, /name="Theme Section Background"[\s\S]{0,500}val="881337"/, 'section background is native');
  assert.match(subXml, /val="FFFFFF"[\s\S]{0,500}<a:t>/, 'white editable section text');
  assert.ok(!/theme-decor|Theme:/.test(subXml + xml2), 'theme UI is not exported');
  const todoXml = await zip.file('ppt/slides/slide' + (saved.deck.slides.indexOf(todoSlide) + 1) + '.xml').async('string');
  const boxes = [...todoXml.matchAll(/name="Todo Checkbox"[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
  assert.equal(boxes.length, 2, 'native checkbox shapes');
  assert.ok(boxes[0].includes('✓') && boxes[0].includes('val="881337"') && boxes[0].includes('roundRect'), 'checked box: filled shape with an editable check');
  assert.ok(!boxes[1].includes('✓') && boxes[1].includes('roundRect'), 'unchecked box: outline only');
  assert.match(todoXml, /strike="sngStrike"[\s\S]{0,900}<a:t>Read<\/a:t>/, 'checked text is struck through');
  assert.match(todoXml, /val="9CA3AF"[\s\S]{0,300}<a:t>Read<\/a:t>/, 'checked text is muted gray');
  assert.ok(!/strike="sngStrike"[^>]*>(?:(?!<\/a:r>)[\s\S])*<a:t>Prepare slides<\/a:t>/.test(todoXml), 'unchecked text is not struck');
  assert.ok(!/☐|☑/.test(todoXml), 'no literal checkbox characters');
  const imgIndex = saved.deck.slides.indexOf(imageSlide) + 1;
  const xmlImg = await zip.file('ppt/slides/slide' + imgIndex + '.xml').async('string');
  const geom = /<a:off x="(\d+)" y="(\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/;
  const caps = [...xmlImg.matchAll(/name="Image Caption"[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
  const pics = [...xmlImg.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)].map((m) => m[0]);
  assert.equal(caps.length, 2, 'only non-empty captions are exported'); assert.equal(pics.length, 3, 'images stay native pictures');
  for (const [i, c] of caps.entries()) {
    const [, cx, cy, cw] = geom.exec(c).map(Number), [, px, py, pw, ph] = geom.exec(pics[i]).map(Number);
    assert.deepEqual([cx, cw], [px, pw], 'caption left edge and width = image'); assert.ok(cy >= py + ph, 'caption below the image');
    assert.match(c, /sz="1050"/); /* 14 slide px = 10.5pt on the 13.33in slide, same scale as the 16px code block = 12pt */ assert.match(c, /algn="l"/); assert.ok(!/ b="1"/.test(c), 'caption is not bold');
  }
  assert.match(xmlImg, /<a:t>Figure 1\. Baseline<\/a:t>/); assert.match(xmlImg, /<a:t>Architecture of the proposed model<\/a:t>/);
  assert.ok(!/Add a caption|Remove Caption|>Caption</.test(xmlImg), 'editor-only caption UI is not exported');
  const tocIndex = saved.deck.slides.findIndex(s=>s.kind==='toc')+1;
  const tocRels = await zip.file('ppt/slides/_rels/slide'+tocIndex+'.xml.rels').async('string');
  assert.match(tocRels, /relationships\/slide/);
  await evaluate('store.getState().goToSlide(store.getState().deck.slides[0].id); store.setState({presenting:true})'); await pause();
  await screenshot('rich-text-presenter'); await key('Escape');
  console.log('PASS PDF export, editable PPTX colors/highlights/monospace runs and hyperlinks');
  // ---- Presentation lifecycle: restore on startup, New, Open, Save, Save As, file association ----
  const deckId = () => evaluate('store.getState().deck.id');
  const archiveIds = () => evaluate('persist.loadRecovery().then(a => a.map(x => x.deck.id))');
  const idb = (key) => evaluate(`new Promise((res) => { const o = indexedDB.open('keyval-store'); o.onsuccess = () => { const g = o.result.transaction('keyval').objectStore('keyval').get(${JSON.stringify(key)}); g.onsuccess = () => res(g.result === undefined ? null : g.result); }; })`);
  const idbPut = (key, value) => evaluate(`new Promise((res) => { const o = indexedDB.open('keyval-store'); o.onsuccess = () => { const t = o.result.transaction('keyval', 'readwrite'); t.objectStore('keyval').put(${JSON.stringify(value)}, ${JSON.stringify(key)}); t.oncomplete = () => res(1); }; })`);
  const archiveSig = () => evaluate("persist.loadRecovery().then(a => a.map(x => x.savedAt + ':' + x.deck.id).join())");
  const setTitle2 = async (t) => { await evaluate(`store.getState().commit(d => { d.title = ${JSON.stringify(t)}; })`); await pause(); };
  const settled = () => until(() => evaluate("store.getState().saveState === 'saved'"), 'autosave settled');
  const restart = async (opts) => { await settled(); await pause(300); socket.close(); electron.kill('SIGTERM'); await new Promise((r) => electron.once('exit', r)); await launch(opts); };
  const assoc = () => evaluate(`new Promise((res) => { const o = indexedDB.open('keyval-store'); o.onsuccess = () => { const g = o.result.transaction('keyval').objectStore('keyval').get('file:v1'); g.onsuccess = () => res(g.result ? {name: g.result.name, deckId: g.result.deckId, hasHandle: !!g.result.handle} : null); }; })`);
  const stubSavePicker = (name) => evaluate(`window.__picks = 0; window.showSaveFilePicker = async () => { __picks++; return await (await __opfsDir()).getFileHandle(${JSON.stringify(name)}, {create: true}); };`);
  const fileDeck = async (name) => JSON.parse(await evaluate(`__opfsRead(${JSON.stringify(name)})`)).deck;
  // A legacy archive:v1 (the former unbounded "previous presentations") is no longer shown, written or deleted.
  const legacyDeck = await evaluate("(() => { const d = defaults.initialDeck(); d.id = 'LEGACY-1'; d.title = 'Legacy work'; return d; })()");
  await idbPut('archive:v1', [{ id: 'legacy-entry', savedAt: 1, deck: legacyDeck }]);
  const legacyBefore = JSON.stringify(await idb('archive:v1'));

  // Pristine detection: the real persisted state, not UI checks.
  await evaluate('persist.newProject()'); await pause();
  assert.equal(await evaluate('persist.isPristine(store.getState().deck)'), true, 'untouched default deck is pristine');
  const changes = {
    'Theme Color': "d.themeColor = '#881337'", 'slide background': "d.slides[0].background = '#eeeeee'", 'notes': "d.slides[0].notes = 'n'",
    'a moved element': 'd.slides[0].elements[0].x += 10', 'a new slide': 'd.slides.push(JSON.parse(JSON.stringify(d.slides[0])))', 'title': "d.title = 'x'",
    'edited text': "d.slides[0].elements[0].doc = {type: 'doc', content: [{type: 'paragraph', content: [{type: 'text', text: 'hello'}]}]}",
  };
  for (const [name, code] of Object.entries(changes)) {
    assert.equal(await evaluate(`(() => { const d = structuredClone(store.getState().deck); (d => { ${code} })(d); return persist.isPristine(d); })()`), false, name + ' is meaningful, not pristine');
  }
  // Re-rendering an untouched deck (measured text heights etc.) keeps it pristine.
  await pause(500);
  assert.equal(await evaluate('persist.isPristine(store.getState().deck)'), true, 'still pristine after layout measurements');

  // New Presentation: new identity every time; only meaningful decks are archived.
  const a0 = await archiveIds(); const id0 = await deckId();
  await evaluate('persist.newProject()'); await pause(); await evaluate('persist.newProject()'); await pause();
  assert.deepEqual(await archiveIds(), a0, 'untouched blank presentations never flood the archive');
  assert.notEqual(await deckId(), id0, 'New Presentation gets a fresh Deck.id even when the previous one was blank');
  const idA = await deckId();
  await setTitle2('Lifecycle A'); await evaluate("store.getState().commit(d => { d.themeColor = '#881337'; })");
  await settled();
  await evaluate('persist.newProject()'); await pause();
  const idB = await deckId();
  assert.notEqual(idB, idA, 'B is a new logical presentation');
  assert.deepEqual((await archiveIds()).slice(0, 1), [idA], 'meaningful A was kept once, newest first');
  assert.equal((await archiveIds()).filter((i) => i === idA).length, 1);
  assert.equal(await evaluate("persist.loadRecovery().then(a => a[0].deck.themeColor)"), '#881337', 'a Theme-only/presentation-level change is kept');

  // Restart and renderer reload restore the working presentation; nothing is archived.
  await setTitle2('Lifecycle B'); await settled();
  const archiveBefore = await archiveSig();
  await restart();
  assert.equal(await deckId(), idB, 'restart restores B with the same Deck.id');
  assert.equal(await evaluate('store.getState().deck.title'), 'Lifecycle B');
  assert.equal(await archiveSig(), archiveBefore, 'restart does not touch the archive');
  await send('Page.reload'); await pause(800); await until(() => evaluate("!!document.querySelector('.propsbar')"), 'reload'); await inject();
  assert.equal(await deckId(), idB, 'a renderer reload / window recreation keeps the same presentation');
  assert.equal(await archiveSig(), archiveBefore, 'reload does not archive');

  // Autosave is internal: it updates the working state and never writes a .mslides file.
  await __ensureNone();
  async function __ensureNone() {}
  await stubSavePicker('Lifecycle-C.mslides');
  const cDeck = await evaluate("(() => { const d = defaults.initialDeck(); d.id = 'C-DECK-ID'; d.title = 'File C'; return d; })()");
  await evaluate(`__opfsWrite('C.mslides', ${JSON.stringify(JSON.stringify({format: 'mathslides', version: 1, deck: cDeck, assets: {}}))})`);
  await evaluate("window.showOpenFilePicker = async () => [await (await __opfsDir()).getFileHandle('C.mslides')]");
  // Open: B (meaningful, unsaved) is preserved first; C keeps its id and becomes the current file.
  await evaluate('persist.openProject()'); await until(async () => (await deckId()) === 'C-DECK-ID', 'C opened');
  assert.ok((await archiveIds()).includes(idB), 'B was archived before C replaced it');
  assert.deepEqual(await assoc(), {name: 'C.mslides', deckId: 'C-DECK-ID', hasHandle: true}, 'the opened file is the persisted current file association');
  assert.equal(await evaluate('store.getState().fileHandle.name'), 'C.mslides');
  // Opening it repeatedly never duplicates entries of one logical presentation.
  await evaluate('persist.openProject()'); await pause(600); await evaluate('persist.openProject()'); await pause(600);
  assert.equal((await archiveIds()).filter((i) => i === 'C-DECK-ID').length <= 1, true, 'one archive entry per Deck.id');
  assert.equal((await archiveIds()).filter((i) => i === idB).length, 1);
  // Autosave does not write the file; explicit Save does, to the same file, without a picker.
  const cBefore = await evaluate("__opfsRead('C.mslides')");
  await setTitle2('File C v2'); await settled();
  assert.equal(await evaluate("__opfsRead('C.mslides')"), cBefore, 'autosave never overwrites the .mslides file');
  await evaluate('persist.saveProject()'); await pause(500);
  assert.equal((await fileDeck('C.mslides')).title, 'File C v2', 'Save writes the associated file');
  assert.equal((await fileDeck('C.mslides')).id, 'C-DECK-ID', 'Save keeps the Deck.id');
  assert.equal(await evaluate('__picks'), 0, 'Save does not show the picker when a file is associated');

  // Save As: an independent presentation with a new Deck.id; the original file is untouched.
  const cText = await evaluate("__opfsRead('C.mslides')");
  await stubSavePicker('D.mslides');
  await evaluate('persist.saveProject(true)'); await pause(600);
  const dId = await deckId();
  assert.notEqual(dId, 'C-DECK-ID', 'Save As gives the current presentation a new Deck.id');
  assert.equal((await fileDeck('D.mslides')).id, dId, 'the new id is written into D.mslides');
  assert.equal(await evaluate("__opfsRead('C.mslides')"), cText, 'the original C.mslides is not modified');
  assert.equal(await evaluate('store.getState().fileHandle.name'), 'D.mslides', 'D is now the current file');
  assert.equal(await evaluate('store.getState().past.every(d => d.id === store.getState().deck.id)'), true, 'undo snapshots follow the new identity');
  await setTitle2('File D v2'); await settled();
  await stubSavePicker('unused.mslides');
  await evaluate('persist.saveProject()'); await pause(500);
  assert.equal((await fileDeck('D.mslides')).title, 'File D v2', 'subsequent Save targets D');
  assert.equal((await fileDeck('C.mslides')).title, 'File C v2', 'C stays as it was');
  assert.equal(await evaluate('__picks'), 0);

  // The file association survives a restart; Save keeps writing D without asking.
  await restart();
  assert.equal(await deckId(), dId, 'D restores as the working presentation');
  assert.equal(await evaluate('store.getState().fileHandle?.name'), 'D.mslides', 'file association restored after restart');
  await stubSavePicker('unused.mslides');
  await setTitle2('File D v3'); await settled();
  await evaluate('persist.saveProject()'); await pause(500);
  assert.equal((await fileDeck('D.mslides')).title, 'File D v3', 'Save after restart writes the restored file');
  assert.equal(await evaluate('__picks'), 0, 'no picker after restart');
  // An unavailable/invalid handle falls back to the picker and loses nothing.
  await evaluate("store.setState({fileHandle: {name: 'D.mslides', queryPermission: async () => 'granted', createWritable: async () => { throw new DOMException('file is gone', 'NotFoundError'); }}})");
  await stubSavePicker('D-recovered.mslides');
  await setTitle2('File D v4'); await settled();
  await evaluate('persist.saveProject()'); await pause(600);
  assert.equal(await evaluate('__picks'), 1, 'stale handle → Save picker');
  assert.equal((await fileDeck('D-recovered.mslides')).title, 'File D v4', 'data is saved through the fallback');
  assert.equal(await evaluate('store.getState().fileHandle.name'), 'D-recovered.mslides');
  // First Save of a never-saved presentation asks for a file once, then reuses it.
  await evaluate('persist.newProject()'); await pause(); await setTitle2('Never saved'); await stubSavePicker('N.mslides');
  await evaluate('persist.saveProject()'); await pause(500); await evaluate('persist.saveProject()'); await pause(500);
  assert.equal(await evaluate('__picks'), 1, 'picker only for the first Save');
  // Restart / reload never flood the archive with Untitled entries.
  const finalArchive = await archiveSig();
  await restart(); await send('Page.reload'); await pause(800); await until(() => evaluate("!!document.querySelector('.propsbar')"), 'reload'); await inject();
  assert.equal(await archiveSig(), finalArchive, 'restart + reload leave the archive untouched');
  assert.equal(JSON.stringify(await idb('archive:v1')), legacyBefore, 'the legacy archive is left untouched (not grown, not deleted)');
  assert.ok((await archiveIds()).length <= 3, 'recovery storage stays bounded');
  // Internal autosave exists and is separate from the explicit file; the ∑ menu has no presentation list.
  assert.equal((await idb('deck:v1')).id, await deckId(), 'deck:v1 holds the working presentation');
  await click('.logo'); await pause(300);
  const menuText = await evaluate("document.querySelector('.menu').textContent");
  assert.ok(!menuText.includes('이전 프레젠테이션') && !menuText.includes('Legacy work') && !menuText.includes('Untitled presentation ·'), 'no previous-presentation entries in the ∑ menu');
  assert.ok(menuText.includes('직전 작업 복구'), 'the single recovery item appears while displaced work exists');
  await key('Escape'); await pause(200);
  // Bounded: many displacements keep at most 3 entries, newest first, one per Deck.id.
  for (let i = 0; i < 6; i++) { await evaluate('persist.newProject()'); await pause(150); await setTitle2('Churn ' + i); }
  await evaluate('persist.newProject()'); await pause(300);
  const churn = await evaluate('persist.loadRecovery().then(a => a.map(x => x.deck.title))');
  assert.deepEqual(churn, ['Churn 5', 'Churn 4', 'Churn 3'], 'recovery keeps only the 3 newest displaced presentations');
  // Restore swaps with the current work; malformed recovery data fails safely.
  await setTitle2('Current before swap'); await evaluate('persist.restoreRecovered()'); await pause(500);
  assert.equal(await evaluate('store.getState().deck.title'), 'Churn 5');
  assert.equal((await archiveIds()).length, 3, 'swap stays bounded and drops no other displaced work');
  assert.ok((await evaluate('persist.loadRecovery().then(a => a.map(x => x.deck.title))')).includes('Current before swap'), 'current work took its place in the stack');
  await idbPut('recovery:v1', [{ savedAt: 'x', deck: 5 }, null, { savedAt: 1, deck: { slides: [] } }]);
  assert.deepEqual(await archiveIds(), [], 'malformed recovery entries are ignored');
  await evaluate('persist.newProject()'); await pause(300); await evaluate('persist.restoreRecovered()'); await pause(300);
  assert.ok(await deckId(), 'restoring with nothing valid is a no-op');
  await idbPut('recovery:v1', 'garbage'); assert.deepEqual(await archiveIds(), [], 'non-array recovery data is ignored');
  // ---- Slide context menu: "제목 슬라이드 추가" inserts a canonical Title Slide ----
  await evaluate('persist.newProject()'); await pause(400);
  const slidesInfo = () => evaluate("store.getState().deck.slides.map(s => ({id: s.id, kind: s.kind ?? null, texts: s.elements.map(e => e.type === 'text' ? e.doc.content?.[0]?.content?.[0]?.text : null)}))");
  const openMenu = async (index) => { await evaluate(`document.querySelectorAll('.thumb-num')[${index}].parentElement.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 120, clientY: 160}))`); await pause(250); };
  const menuItems = () => evaluate("[...document.querySelectorAll('.menu.context .menu-item')].map(e => e.firstChild.textContent.trim())");
  const clickMenu = (label) => evaluate(`[...document.querySelectorAll('.menu.context .menu-item')].find(e => e.textContent.includes(${JSON.stringify(label)})).click()`).then(() => pause(500));
  await openMenu(0);
  assert.deepEqual(await menuItems(), ['새 슬라이드', '슬라이드 복제', '제목 슬라이드 추가', '목차 슬라이드 추가', '감사 슬라이드 추가 (맨 끝)', '슬라이드 삭제'], 'context menu order');
  assert.equal(await evaluate("document.querySelector('.menu.context .menu-item:last-child').classList.contains('danger')"), true, 'delete keeps its danger styling');
  const firstId = (await slidesInfo())[0].id;
  await clickMenu('제목 슬라이드 추가');
  let info = await slidesInfo();
  assert.equal(info.length, 2, 'one slide inserted'); assert.equal(info[1].kind, 'title', 'a genuine Title Slide (kind "title")'); assert.equal(info[0].kind, 'title', 'the initial slide uses the same canonical template');
  assert.equal(await evaluate('store.getState().currentSlideId'), info[1].id, 'the new Title Slide is selected');
  // Same canonical template: identical structure (ids aside) to the initial slide.
  const shape = (slide) => JSON.stringify({kind: slide.kind, background: slide.background, els: slide.elements.map((e) => ({...e, id: undefined, h: undefined, doc: e.doc.content.map((p) => p.content?.[0]?.text)}))});
  assert.equal(await evaluate(`(${shape.toString()})(store.getState().deck.slides[1])`), await evaluate(`(${shape.toString()})(store.getState().deck.slides[0])`), 'inserted Title Slide == initial Title Slide template');
  // Insertion follows the clicked slide, even when it is not the last one.
  await evaluate("store.getState().addSlide()"); await pause(300);
  await openMenu(0); await clickMenu('제목 슬라이드 추가'); info = await slidesInfo();
  assert.deepEqual(info.map((x) => x.kind), ['title', 'title', 'title', null], 'inserted immediately after the selected (first) slide');
  assert.equal(await evaluate('store.getState().currentSlideId'), info[1].id);
  // Theme behaves the same as on the initial Title Slide.
  await evaluate("store.getState().commit((d) => { d.themeColor = '#881337'; })"); await pause(300);
  const partsOn = async (i) => { await evaluate(`store.getState().goToSlide(store.getState().deck.slides[${i}].id)`); await pause(250); return evaluate("[...document.querySelectorAll('.slide.editable [data-theme-part]')].map(e => e.dataset.themePart)"); };
  assert.deepEqual(await partsOn(1), await partsOn(0), 'theme band on the inserted Title Slide = initial one');
  assert.deepEqual(await partsOn(1), ['Theme Title Band', 'Theme Footer Accent']);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.slide.editable .el-text')).color"), 'rgb(255, 255, 255)', 'readable title text on the band');
  // Undo / redo.
  await evaluate('store.getState().undo(); store.getState().undo()'); await pause(300);
  assert.equal((await slidesInfo()).length, 3, 'undo removed the inserted Title Slide (after the theme change)');
  await evaluate('store.getState().redo(); store.getState().redo()'); await pause(300);
  assert.deepEqual((await slidesInfo()).map((x) => x.kind), ['title', 'title', 'title', null], 'redo restores it');
  // Other actions keep their behavior.
  await evaluate("store.getState().goToSlide(store.getState().deck.slides[0].id)"); await pause(200);
  await openMenu(0); await clickMenu('새 슬라이드'); info = await slidesInfo();
  assert.equal(info.length, 5); assert.equal(info[1].kind, null, 'New Slide: an ordinary slide right after the clicked one');
  await openMenu(0); await clickMenu('슬라이드 복제'); info = await slidesInfo();
  assert.equal(info.length, 6); assert.equal(info[1].kind, null, 'Duplicate of a Title Slide stays an ordinary copy (existing behavior)');
  await openMenu(0); await clickMenu('목차 슬라이드 추가'); info = await slidesInfo();
  assert.ok(info.some((x) => x.kind === 'toc'), 'TOC slide added');
  await openMenu(0); await clickMenu('감사 슬라이드 추가 (맨 끝)'); info = await slidesInfo();
  assert.equal(info.at(-1).kind, 'thanks', 'Thank You still goes to the end');
  const countBeforeDelete = info.length;
  await openMenu(0); await clickMenu('슬라이드 삭제'); info = await slidesInfo();
  assert.equal(info.length, countBeforeDelete - 1, 'Delete removes the slide');
  // Persistence: the inserted Title Slide survives a restart.
  const titleCount = (await slidesInfo()).filter((x) => x.kind === 'title').length;
  await restart();
  assert.equal((await slidesInfo()).filter((x) => x.kind === 'title').length, titleCount, 'inserted Title Slides persist across restart');
  assert.equal(await evaluate('store.getState().deck.slides.filter(s => s.kind === "title").length > 0'), true);
  console.log('PASS title slide insertion (menu order, canonical template, selection, theme, undo/redo, other actions, persistence)');
  // ---- Files opened by the OS (.mslides association): cold launch, running app, invalid files, write-back ----
  const nativeDir = path.join(output, 'native'); await mkdir(nativeDir, { recursive: true });
  const triggerFile = path.join(profile, 'trigger.json'); let triggerN = 0;
  const trigger = async (event, file) => { await writeFile(triggerFile, JSON.stringify({ event, path: file, n: ++triggerN })); await pause(700); };
  const mkFile = async (name, id, title, raw) => {
    const d = JSON.parse(await evaluate('JSON.stringify(defaults.initialDeck())')); d.id = id; d.title = title;
    const file = path.join(nativeDir, name);
    await writeFile(file, raw ?? JSON.stringify({ format: 'mathslides', version: 1, deck: d, assets: {} }));
    return file;
  };
  const onDisk = async (name) => JSON.parse(await readFile(path.join(nativeDir, name), 'utf8')).deck;
  await evaluate('persist.newProject()'); await pause(400); await setTitle2('Before native'); await settled();
  const beforeNativeId = await deckId();
  const fC = await mkFile('C.mslides', 'NATIVE-C', 'File C native');
  // Cold launch: the path is queued by the main process until the renderer is ready; the restored deck is archived first.
  await restart({ args: [fC] });
  await until(async () => (await deckId()) === 'NATIVE-C', 'cold-launch file opened');
  assert.ok((await archiveIds()).includes(beforeNativeId), 'the working presentation was preserved before the file replaced it');
  assert.equal(await evaluate('store.getState().deck.title'), 'File C native');
  assert.equal(await evaluate('store.getState().fileHandle.name'), 'C.mslides'); assert.equal(await evaluate('store.getState().fileHandle.nativePath'), fC);
  assert.equal(await evaluate("new Promise((res) => { const o = indexedDB.open('keyval-store'); o.onsuccess = () => { const g = o.result.transaction('keyval').objectStore('keyval').get('file:v1'); g.onsuccess = () => res(g.result?.nativePath ?? null); }; })"), fC, 'the OS-opened file is the persisted current file');
  // Autosave stays internal; Save writes the same file without a picker.
  await stubSavePicker('must-not-be-used.mslides');
  await setTitle2('C v2'); await settled();
  assert.equal((await onDisk('C.mslides')).title, 'File C native', 'autosave does not write the .mslides file');
  await evaluate('persist.saveProject()'); await pause(600);
  assert.equal((await onDisk('C.mslides')).title, 'C v2', 'Save writes the OS-opened file'); assert.equal((await onDisk('C.mslides')).id, 'NATIVE-C');
  assert.equal(await evaluate('__picks'), 0, 'no picker for an OS-opened file');
  // Already running: open-file (macOS) and second-instance (Windows/Linux argv) requests.
  const fD = await mkFile('D.mslides', 'NATIVE-D', 'File D');
  await trigger('open-file', fD); await until(async () => (await deckId()) === 'NATIVE-D', 'running app opened D');
  assert.ok((await archiveIds()).includes('NATIVE-C'), 'C (current) was preserved before D replaced it');
  await setTitle2('D v2'); await evaluate('persist.saveProject()'); await pause(600);
  assert.equal((await onDisk('D.mslides')).title, 'D v2', 'Save targets D'); assert.equal((await onDisk('C.mslides')).title, 'C v2', 'C is untouched');
  const fE = await mkFile('E.mslides', 'NATIVE-E', 'File E');
  await trigger('second-instance', fE); await until(async () => (await deckId()) === 'NATIVE-E', 'second instance forwarded E');
  // Invalid requests fail safely: nothing changes, no crash.
  const archiveNow = await archiveSig();
  await trigger('open-file', path.join(nativeDir, 'notes.txt'));
  assert.equal(await deckId(), 'NATIVE-E', 'non-.mslides paths are ignored');
  for (const [name, raw] of [['broken.mslides', '{ not json'], ['other.mslides', JSON.stringify({ format: 'something-else', deck: {} })], ['empty.mslides', JSON.stringify({ format: 'mathslides', version: 1, deck: { slides: [] } })]]) {
    await mkFile(name, 'x', 'x', raw); await trigger('open-file', path.join(nativeDir, name));
    assert.equal(await deckId(), 'NATIVE-E', name + ' does not replace the current presentation');
    assert.ok(await evaluate("[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('열 수 없습니다'))"), name + ' shows an error toast');
  }
  await trigger('open-file', path.join(nativeDir, 'missing.mslides'));
  assert.equal(await deckId(), 'NATIVE-E', 'a missing file is reported, not opened');
  assert.equal(await archiveSig(), archiveNow, 'failed opens do not touch the archive');
  // The renderer cannot write anywhere except to documents that were opened through the OS.
  const evil = await mkFile('evil.mslides', 'EVIL', 'ORIGINAL');
  assert.equal(await evaluate(`window.native.writeFile(${JSON.stringify(evil)}, 'HACKED').then(r => r.ok)`), false, 'unopened path is refused');
  assert.equal((await onDisk('evil.mslides')).title, 'ORIGINAL', 'the refused write changed nothing');
  assert.equal(await evaluate(`window.native.writeFile(${JSON.stringify(path.join(nativeDir, 'plain.txt'))}, 'x').then(r => r.ok)`), false, 'non-.mslides target is refused');
  // The association survives a restart; Save keeps writing the file.
  await restart();
  assert.equal(await deckId(), 'NATIVE-E'); assert.equal(await evaluate('store.getState().fileHandle?.name'), 'E.mslides', 'native association restored');
  await stubSavePicker('must-not-be-used.mslides'); await setTitle2('E v2'); await evaluate('persist.saveProject()'); await pause(600);
  assert.equal((await onDisk('E.mslides')).title, 'E v2', 'Save after restart writes the OS-opened file'); assert.equal(await evaluate('__picks'), 0);
  // An open-file event delivered before the window exists is queued, not lost.
  const fF = await mkFile('F.mslides', 'NATIVE-F', 'File F');
  await restart({ env: { TEST_OPEN_AT_START: fF } });
  await until(async () => (await deckId()) === 'NATIVE-F', 'early open-file request opened after startup');
  // New Presentation shows no success toast.
  await pause(2500);
  assert.equal(await evaluate("document.querySelectorAll('.toast').length"), 0, 'no stray toasts before the check');
  await click('.logo'); await pause(300); await evaluate("[...document.querySelectorAll('.menu-item')].find(e => e.textContent.includes('새 프레젠테이션')).click()"); await pause(600);
  assert.equal(await evaluate("document.querySelectorAll('.toast').length"), 0, 'New Presentation shows no success toast');
  assert.notEqual(await deckId(), 'NATIVE-F');
  console.log('PASS .mslides opened by the OS (cold launch, queued early request, running app, invalid files, write-back, association, New without toast)');
  console.log('PASS presentation lifecycle (restore, New, Open, Save, Save As, file association, pristine detection, recovery slot)');
  console.log('OUTPUT', output);
  }
} catch (error) {
  console.error(error); console.log('OUTPUT', output);
  if (socket?.readyState === WebSocket.OPEN) {
    console.log(await evaluate('JSON.stringify({deck:store.getState().deck,body:document.body.innerText.slice(-1500)})').catch(()=>''));
    await screenshot('failure').catch(()=>{});
  }
  throw error;
} finally {
  socket?.close();
  if (electron && electron.exitCode === null) { electron.kill('SIGTERM'); await new Promise(r=>electron.once('exit', r)); }
  await server.close();
}
