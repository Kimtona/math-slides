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
  await click('.slide.editable .toc-link'); await pause(350);
  assert.equal(await evaluate('store.getState().currentSlideId'), sections[0].subtitleSlideId);
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
