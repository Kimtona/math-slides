/** Hyperlink checks in a real Electron window with a disposable profile (never the user's data).
 * Run: node tests/hyperlinks.mjs. Needs a graphical session (windows are hidden unless MATHSLIDES_TEST_VISIBLE=1). */
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
const output = process.env.MATHSLIDES_TEST_OUTPUT || await mkdtemp(path.join(tmpdir(), 'mathslides-links-'));
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-links-profile-'));
const portProbe = netServer();
await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
const debugPort = portProbe.address().port;
await new Promise(r => portProbe.close(r));
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), server: { host: '127.0.0.1', port: 5188, strictPort: true } });
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
    window.__opened = [];
    window.open = (u) => { __opened.push(u); return null; };
  })()`);
}
async function launch() {
  electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`], { cwd: root, env: testElectronEnv({ ELECTRON_DEV_URL: 'http://127.0.0.1:5188' }), stdio: ['ignore', 'pipe', 'pipe'] });
  electron.stderr.on('data', () => {});
  await connect();
}
const restart = async () => { await pause(1200); socket.close(); electron.kill('SIGTERM'); await new Promise((r) => electron.once('exit', r)); await launch(); };

const MOD = process.platform === 'darwin' ? 4 : 2; // Meta on macOS, Ctrl elsewhere (ProseMirror "Mod")
const doc = () => evaluate('active().getJSON()');
const text = (s) => send('Input.insertText', { text: s }).then(() => pause());
const space = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space' }); await pause(); };
const enter = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await pause(); };
const cmdK = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: MOD, windowsVirtualKeyCode: 75 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: MOD }); await pause(250); };
const clickAt = async (selector, modifiers = 0) => {
  const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw Error('Missing ' + ${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, modifiers, ...r });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, modifiers, ...r });
  await pause(400);
};
const paste = (s, html) => evaluate(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(s)}); ${html ? `dt.setData('text/html', ${JSON.stringify(html)});` : ''} const e = new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}); active().view.dom.dispatchEvent(e); return e.defaultPrevented; })()`).then((v) => pause().then(() => v));
/** [{text, href}] of user links in a doc, merging adjacent runs with the same href. */
const links = (d) => {
  const out = [];
  const walk = (n) => {
    if (n.type === 'text') {
      const m = n.marks?.find((x) => x.type === 'userLink');
      if (m) { const l = out[out.length - 1]; if (l && l.href === m.attrs.href && l.open) l.text += n.text; else out.push({ text: n.text, href: m.attrs.href, open: true }); }
      else out.forEach((l) => (l.open = false));
    } else if (n.type !== 'doc' && n.type !== 'paragraph') out.forEach((l) => (l.open = false));
    n.content?.forEach(walk);
    if (n.type === 'paragraph') out.forEach((l) => (l.open = false));
  };
  walk(d);
  return out.map(({ text, href }) => ({ text, href }));
};
const plain = (d) => d.content.map((p) => (p.content ?? []).map((n) => n.text ?? '').join('')).join('\n');
const reset = (content = '') => evaluate(`active().commands.setContent(${JSON.stringify(content ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: content }] }] } : { type: 'doc', content: [{ type: 'paragraph' }] })}); active().commands.focus('end')`).then(() => pause(560)); // > history newGroupDelay: later edits are never merged with the reset
const select = (from, to) => evaluate(`active().commands.setTextSelection({from:${from},to:${to}}); active().view.focus()`).then(() => pause());

try {
  await launch();
  await evaluate(`store.getState().updateElements([store.getState().deck.titleElementId], e => { e.style.fontSize = 30; e.style.align = 'left'; e.y = 150 }); store.getState().startEditing(store.getState().deck.titleElementId, 'all')`);
  await until(() => evaluate('!!active()'), 'Text editor not active');
  const titleId = await evaluate('store.getState().deck.titleElementId');
  const URL1 = 'https://github.com/Kimtona';

  // ---- Feature 1: typed URL + Space ----
  await reset(); await text('go ' + URL1); await space();
  let d = await doc();
  assert.deepEqual(links(d), [{ text: URL1, href: URL1 }], 'typed https URL + Space becomes a link');
  assert.equal(plain(d), 'go ' + URL1 + ' ', 'text unchanged, the space is not part of the link');
  await text('next'); d = await doc();
  assert.deepEqual(links(d), [{ text: URL1, href: URL1 }], 'typing after the link does not extend it');
  // First Cmd+Z removes only the link
  await reset(); await text('go ' + URL1); await space();
  assert.equal(await evaluate('active().commands.undo()'), true);
  d = await doc();
  assert.deepEqual(links(d), [], 'first undo removes the link');
  assert.equal(plain(d), 'go ' + URL1 + ' ', 'first undo keeps the typed URL and the space');
  await evaluate('active().commands.redo()'); assert.deepEqual(links(await doc()), [{ text: URL1, href: URL1 }], 'redo restores the link');
  console.log('PASS typed URL + Space (+ undo/redo)');

  await reset(); await text('see www.example.com/a/b,'); await space();
  assert.deepEqual(links(await doc()), [{ text: 'www.example.com/a/b', href: 'https://www.example.com/a/b' }], 'www. URL, trailing comma excluded');
  await reset(); await text('see http://example.org/x?y=1.'); await space();
  assert.deepEqual(links(await doc()), [{ text: 'http://example.org/x?y=1', href: 'http://example.org/x?y=1' }], 'http URL, trailing period excluded');
  await reset(); await text('hello world example.com'); await space();
  assert.deepEqual(links(await doc()), [], 'plain words and scheme-less domains are not linked');
  console.log('PASS URL formats and trailing punctuation');

  // ---- Enter ----
  await reset(); await text(URL1); await enter();
  d = await doc();
  assert.deepEqual(links(d), [{ text: URL1, href: URL1 }], 'typed URL + Enter becomes a link');
  assert.equal(d.content.length, 2, 'Enter still splits the paragraph');
  assert.equal(await evaluate('active().commands.undo()'), true);
  d = await doc();
  assert.deepEqual(links(d), [], 'undo after Enter removes the link');
  assert.equal(plain(d), URL1 + '\n', 'and keeps the URL text and the new paragraph');
  console.log('PASS typed URL + Enter');

  // ---- no duplicate / nested links ----
  await reset(); await text(URL1); await space(); // linked
  await select(8, 8); await space(); // caret inside the link text
  d = await doc();
  assert.equal(links(d).length, 1, 'a space inside an existing link does not create another link');
  assert.ok(links(d)[0].text.startsWith('https:/'), 'still one link');
  await reset('x');
  await evaluate(`active().chain().focus('end').toggleMark('code').insertContent('${URL1}').run()`); await space();
  assert.deepEqual(links(await doc()), [], 'URLs in inline code are not linked');
  console.log('PASS no duplicate/nested links, no links in code');

  // ---- formatting is preserved ----
  await reset(); await evaluate(`active().chain().focus().toggleBold().run()`); await text(URL1); await space();
  d = await doc();
  const run = d.content[0].content[0];
  assert.deepEqual(run.marks.map((m) => m.type).sort(), ['bold', 'userLink'], 'bold + link coexist');
  console.log('PASS formatting kept on auto-linked text');

  // ---- Paste ----
  await reset('before ');
  assert.equal(await paste(URL1), true, 'pasted URL handled');
  d = await doc();
  assert.deepEqual(links(d), [{ text: URL1, href: URL1 }], 'pasted URL becomes a link');
  assert.equal(plain(d), 'before ' + URL1);
  assert.equal(await evaluate('active().commands.undo()'), true);
  assert.equal(plain(await doc()), 'before ', 'one undo removes the whole paste');
  await reset(); await evaluate(`active().chain().focus().toggleItalic().run()`); await paste('www.example.com');
  d = await doc();
  assert.deepEqual(links(d), [{ text: 'www.example.com', href: 'https://www.example.com' }]);
  assert.ok(d.content[0].content[0].marks.some((m) => m.type === 'italic'), 'italic kept on pasted URL');
  // paste inside an existing link -> no second link
  await reset(); await text(URL1); await space(); await select(8, 8);
  await paste('https://other.com');
  assert.equal(links(await doc()).length, 1, 'no nested/duplicate link after paste inside a link');
  // paste over a selection links the selected text, keeping it
  await reset('정연이의 깃허브'); await select(1, 9);
  await paste(URL1);
  d = await doc();
  assert.deepEqual(links(d), [{ text: '정연이의 깃허브', href: URL1 }], 'paste over a selection links that text');
  // non-URL text is not intercepted
  await reset(); await paste('just some text'); assert.deepEqual(links(await doc()), [], 'plain text paste creates no link'); assert.equal(plain(await doc()), 'just some text');
  console.log('PASS pasted URLs');

  // ---- Feature 2: Cmd+K ----
  await reset('앞 정연이의 깃허브 뒤'); await evaluate(`active().chain().setTextSelection({from:3,to:11}).toggleBold().run()`); await select(3, 11);
  await cmdK();
  assert.equal(await evaluate("!!document.querySelector('.link-popover')"), true, 'Cmd+K opens the link field');
  await text(URL1); await enter();
  d = await doc();
  assert.deepEqual(links(d), [{ text: '정연이의 깃허브', href: URL1 }], 'Cmd+K links the selected text');
  assert.equal(plain(d), '앞 정연이의 깃허브 뒤', 'display text unchanged');
  assert.equal(d.content[0].content.find((n) => n.marks?.some((m) => m.type === 'userLink')).marks.some((m) => m.type === 'bold'), true, 'bold kept under the link');
  assert.equal(await evaluate("!!document.querySelector('.link-popover')"), false, 'popover closes after Enter');
  assert.equal(await evaluate('active().isFocused'), true, 'focus returns to the editor');
  // part of the text box only
  assert.ok(!d.content[0].content[0].marks?.some((m) => m.type === 'userLink'), 'text before the link is not linked');
  assert.ok(!d.content[0].content.at(-1).marks?.some((m) => m.type === 'userLink'), 'text after the link is not linked');
  // typing right after the link does not extend it
  await evaluate("active().commands.focus(11)"); await text('!');
  assert.equal(links(await doc())[0].text, '정연이의 깃허브');
  // edit: caret inside the link
  await evaluate('active().commands.undo()');
  await select(6, 6); await cmdK();
  assert.equal(await evaluate("document.querySelector('.link-input').value"), URL1, 'popover is prefilled with the current URL');
  assert.equal(await evaluate("!!document.querySelector('.link-target')"), true, 'target text stays highlighted');
  await evaluate("document.querySelector('.link-input').select()"); await text('example.com/new'); await enter();
  assert.deepEqual(links(await doc()), [{ text: '정연이의 깃허브', href: 'https://example.com/new' }], 'edit replaces the URL for the whole link');
  // invalid input is rejected
  await select(6, 6); await cmdK();
  await evaluate("document.querySelector('.link-input').select()"); await text('javascript:alert(1)'); await enter();
  assert.equal(await evaluate("!!document.querySelector('.link-input.bad')"), true, 'unsafe URL rejected');
  assert.equal(links(await doc())[0].href, 'https://example.com/new', 'document untouched by a rejected URL');
  // Escape cancels
  await evaluate("document.querySelector('.link-input').focus()"); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await pause();
  assert.equal(await evaluate("!!document.querySelector('.link-popover')"), false, 'Escape closes the popover');
  assert.equal(links(await doc())[0].href, 'https://example.com/new');
  // remove
  await select(6, 6); await cmdK();
  await evaluate("[...document.querySelectorAll('.link-popover button')].find(b => b.textContent === '제거').click()"); await pause();
  d = await doc();
  assert.deepEqual(links(d), [], 'Remove deletes the link');
  assert.equal(plain(d), '앞 정연이의 깃허브 뒤', 'Remove keeps the text');
  // empty caret, no link: insert URL as linked text
  await reset('x '); await cmdK(); await text('github.com/a'); await enter();
  assert.deepEqual(links(await doc()), [{ text: 'github.com/a', href: 'https://github.com/a' }], 'Cmd+K at a bare caret inserts a linked URL');
  // toolbar button
  await reset('abc'); await select(1, 3);
  await evaluate("document.querySelector('.propsbar button[title^=\"링크\"]').click()"); await pause(250);
  assert.equal(await evaluate("!!document.querySelector('.link-popover')"), true, 'toolbar link button opens the field');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await pause();
  console.log('PASS Cmd+K insert / edit / remove / validation / partial text');

  // ---- Appearance and interaction ----
  await reset('앞 '); await text(URL1); await space();
  await evaluate(`active().chain().setTextSelection({from:4,to:8}).setColor('#DC2626').run()`); await pause();
  const look = await evaluate(`(() => { const a = document.querySelector('.ProseMirror a.user-link'); const cs = getComputedStyle(a); const span = a.querySelector('span'); return { color: cs.color, deco: cs.textDecorationLine, spanColor: span && getComputedStyle(span).color }; })()`);
  assert.equal(look.color, 'rgb(26, 98, 214)', 'blue by default'); assert.match(look.deco, /underline/);
  assert.equal(look.spanColor, 'rgb(220, 38, 38)', 'explicit text color wins on the colored part');
  // generated links (References / TOC) are unchanged
  const generated = await evaluate(`(() => { const host = document.querySelector('.slide-content .el') ; const a = document.createElement('a'); a.className = 'doc-link'; a.textContent = 'x'; host.appendChild(a); const cs = getComputedStyle(a); const r = { same: cs.color === getComputedStyle(host).color, deco: cs.textDecorationLine }; a.remove(); return r; })()`);
  assert.equal(generated.same, true, 'generated .doc-link keeps inherited color'); assert.equal(generated.deco, 'none', 'generated .doc-link not underlined');
  // editing: plain click never opens; Cmd/Ctrl+click opens
  await evaluate('window.__opened.length = 0');
  await clickAt('.ProseMirror a.user-link');
  assert.deepEqual(await evaluate('__opened'), [], 'plain click while editing does not open the link');
  await clickAt('.ProseMirror a.user-link', MOD);
  assert.deepEqual(await evaluate('__opened'), [URL1], 'Cmd/Ctrl+click opens the link');
  assert.equal(await evaluate('!!active()'), true, 'still editing');
  // not editing: a click follows the link
  await evaluate('store.getState().stopEditing(); store.getState().select([])'); await pause(300);
  await evaluate('window.__opened.length = 0');
  await clickAt('.slide.editable a.user-link'); await pause(500);
  assert.deepEqual(await evaluate('__opened'), [URL1], 'click on a link in a non-editing box opens it');
  console.log('PASS link appearance, explicit colors, click behavior');

  // ---- IME (simulated composition; real macOS Korean IME needs a manual check) ----
  await evaluate(`store.getState().startEditing('${titleId}', 'end')`); await until(() => evaluate('!!active()'), 'editor');
  await reset(); await text(URL1);
  await send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 }); await pause();
  await space(); await enter();           // keys during an active composition must not link or throw
  await send('Input.insertText', { text: '한' }); await pause();
  await space();
  assert.deepEqual(links(await doc()), [], 'Hangul glued to a URL is never auto-linked');
  await reset(); await send('Input.imeSetComposition', { text: '정연', selectionStart: 2, selectionEnd: 2 }); await pause();
  await send('Input.insertText', { text: '정연' }); await pause(); await space(); await text(URL1); await space();
  assert.deepEqual(links(await doc()), [{ text: URL1, href: URL1 }], 'URL after Korean text, in the same paragraph, is linked');
  assert.equal(plain(await doc()), '정연 ' + URL1 + ' ');
  console.log('PASS Korean composition does not interfere with detection (simulated)');

  // ---- Persistence ----
  await reset('앞 정연이의 깃허브 뒤'); await select(3, 11); await cmdK(); await text(URL1); await enter();
  await evaluate('store.getState().stopEditing()'); await pause(300);
  const stored = () => evaluate(`JSON.stringify(store.getState().deck.slides[0].elements.find(e => e.id === '${titleId}').doc)`);
  assert.match(await stored(), /"type":"userLink","attrs":\{"href":"https:\/\/github.com\/Kimtona"\}/);
  await restart();
  assert.deepEqual(links(JSON.parse(await stored())), [{ text: '정연이의 깃허브', href: URL1 }], 'link survives autosave + application restart');
  assert.equal(await evaluate("document.querySelector('.slide a.user-link')?.getAttribute('href')"), URL1, 'rendered after restart');
  assert.equal(await evaluate("document.querySelector('.slide a.user-link')?.textContent"), '정연이의 깃허브');
  // .mslides file
  await evaluate('persist.saveProject()'); await pause(800);
  const fileName = await evaluate("Object.keys(testFiles).find(k => k.endsWith('.mslides'))");
  assert.ok(fileName, '.mslides saved');
  assert.match(Buffer.from(await evaluate(`testFiles[${JSON.stringify(fileName)}]`)).toString('utf8'), /"userLink"/, 'link is in the saved .mslides');
  console.log('PASS persistence (autosave, restart, .mslides)');

  // ---- PPTX ----
  await evaluate("document.querySelector('.export-menu > button').click()"); await pause(200);
  await evaluate("document.querySelector('.pop .menu-item:nth-child(2)').click()");
  const pptx = await until(() => evaluate("Object.keys(testFiles).find(k => k.endsWith('.pptx'))"), 'PPTX export', 30000);
  await until(() => evaluate(`testFiles[${JSON.stringify(pptx)}]?.length > 1000`), 'PPTX bytes', 30000);
  await writeFile(path.join(output, 'links.pptx'), Buffer.from(await evaluate(`testFiles[${JSON.stringify(pptx)}]`)));
  const zip = await JSZip.loadAsync(await readFile(path.join(output, 'links.pptx')));
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string');
  const linkRun = xml.match(/<a:r>(?:(?!<\/a:r>)[\s\S])*<a:hlinkClick[\s\S]*?<\/a:r>/)?.[0];
  assert.ok(linkRun, 'a hyperlink run exists');
  assert.match(linkRun, /<a:t>정연이의 깃허브<\/a:t>/, 'the link run carries exactly the linked text');
  assert.match(linkRun, /u="sng"/, 'link run is underlined');
  const rid = linkRun.match(/<a:hlinkClick r:id="(rId\d+)"/)[1];
  assert.match(rels, new RegExp(`Id="${rid}"[^>]*Target="https://github.com/Kimtona"[^>]*TargetMode="External"|Target="https://github.com/Kimtona"[^>]*Id="${rid}"[^>]*TargetMode="External"|Id="${rid}"[^>]*TargetMode="External"[^>]*Target="https://github.com/Kimtona"`), 'external relationship targets the URL');
  assert.ok(!/<a:r>(?:(?!<\/a:r>)[\s\S])*<a:t>앞 <\/a:t>(?:(?!<\/a:r>)[\s\S])*<\/a:r>/.exec(xml)?.[0].includes('hlinkClick'), 'text outside the link has no hyperlink');
  console.log('PASS PPTX export keeps a functional hyperlink');
  console.log('OUTPUT', output);
} catch (error) {
  console.error(error); console.log('OUTPUT', output);
  if (socket?.readyState === WebSocket.OPEN) console.log(await evaluate('document.body.innerText.slice(-800)').catch(() => ''));
  process.exitCode = 1;
} finally {
  socket?.close();
  if (electron && electron.exitCode === null) { electron.kill('SIGTERM'); await new Promise((r) => electron.once('exit', r)); }
  await server.close();
}
