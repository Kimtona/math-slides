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
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const key = ++id; pending.set(key, { resolve, reject });
    socket.send(JSON.stringify({ id: key, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
  })()`);
}
async function launch() {
  electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`], { cwd: root, env: { ...process.env, ELECTRON_DEV_URL: 'http://127.0.0.1:5187' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  assert.deepEqual(shapeSaved.map((e) => !!e.doc), [true, false], '.mslides keeps shape text (empty shape has none)');
  assert.ok(JSON.stringify(shapeSaved[0].doc).includes('Policy') && JSON.stringify(shapeSaved[0].doc).includes(' Gradient') && JSON.stringify(shapeSaved[0].doc).includes('"bold"'));
  const imageSlide = saved.deck.slides.find((x) => x.elements.some((e) => e.type === 'image'));
  assert.deepEqual(imageSlide.elements.filter((e) => e.type === 'image').map((e) => e.caption), ['Figure 1. Baseline', 'Architecture of the proposed model', ''], '.mslides keeps captions');
  assert.ok(!JSON.stringify(saved).includes('Add a caption'), 'placeholder never persisted');
  assert.ok(savedSlide2.includes('"codeBlock"') && savedSlide2.includes('"blockquote"'), '.mslides keeps code/quote blocks');
  for (const l of ['python', 'c', 'bash']) assert.ok(savedSlide2.includes(`"language":"${l}"`), '.mslides keeps language ' + l);
  await evaluate(`persist.newProject()`); await pause();
  assert.equal(await evaluate('store.getState().deck.title'), 'Untitled presentation');
  await evaluate(`(async()=>{const archive=await persist.loadArchive(); await persist.restoreArchived(archive.find(a=>a.deck.title==='Formatting validation').id)})()`);
  assert.deepEqual(await evaluate('store.getState().deck'), saved.deck);
  await evaluate(`persist.newProject()`);
  await evaluate(`window.showOpenFilePicker=async()=>[{getFile:async()=>new File([${JSON.stringify(JSON.stringify(saved))}],'fixture.mslides',{type:'application/json'})}]; persist.openProject()`);
  assert.deepEqual(await evaluate('store.getState().deck'), saved.deck);
  await evaluate('delete window.showOpenFilePicker; store.setState({fileHandle:null})');
  await until(()=>evaluate("store.getState().saveState === 'saved'"), 'Autosave pending');
  // Close and start the actual desktop process with the same disposable profile.
  socket.close(); electron.kill('SIGTERM'); await new Promise(r=>electron.once('exit',r));
  await launch();
  assert.equal(await evaluate('store.getState().deck.title'), 'Untitled presentation');
  await evaluate(`(async()=>{const archive=await persist.loadArchive(); await persist.restoreArchived(archive.find(a=>a.deck.title==='Formatting validation').id)})()`);
  assert.deepEqual(await evaluate('store.getState().deck'), saved.deck);
  console.log('PASS autosave, desktop restart, archive reopen, .mslides save/open');
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
  assert.ok(textShape.includes('prst="rect"') && textShape.includes('val="BFBFBF"'), 'native shape geometry and fill');
  assert.match(textShape, /anchor="ctr"/); assert.match(textShape, /algn="ctr"/);
  assert.match(textShape, /b="1"[\s\S]{0,700}<a:t>Policy<\/a:t>/); assert.match(textShape, /<a:t>second line<\/a:t>/);
  assert.equal(spChunks.filter((c) => c.includes('<a:t>Policy</a:t>') || c.includes('second line')).length, 1, 'the text lives only in the shape, no separate text box over it');
  assert.ok(!spChunks.find((c) => c.includes('prst="ellipse"'))?.includes('<a:t>'), 'empty shape exports no text');
  assert.ok(!/ProseMirror|caret/.test(shapeXml), 'no editor UI exported');
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
