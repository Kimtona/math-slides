/** Sketch-to-Slides structure in the real Electron app (model replaced by fixtures, no network):
 *  A) the AI-model table screenshot: a REAL (looping, then salvaged) qwen2.5-vl answer → ONE native table, 6×2, exact cell
 *     texts, header row bold, independent cell editing + undo, save → reopen, PDF, PPTX (<a:tbl>, 6 rows, header bold).
 *  B) formatted notes (hand-written fixture): heading, bold/italic/strike marks, bullet + ordered list, blockquote and a
 *     table with a bold word → native nodes/DOM, save → reopen, PDF, PPTX runs/bullets.
 * Run: node tests/sketch-structured-gui.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import JSZip from 'jszip';
import { testElectronEnv } from './electron-env.mjs';
import { launchElectron, startViteServer, stopElectron } from './test-ports.mjs';
import { makeTempDir } from './tmp-utils.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = makeTempDir('mathslides-structured-profile-');
const pdfDir = path.join(profile, 'pdf');
await mkdir(pdfDir);
const shots = process.env.STRUCTURED_SHOTS ? path.resolve(process.env.STRUCTURED_SHOTS) : null;
if (shots) await mkdir(shots, { recursive: true });
const fixtureJson = async (n) => JSON.parse(await readFile(path.join(root, 'tests/fixtures/sketch', n), 'utf8'));
const OL = require(path.join(root, 'electron/sketch-ollama.cjs'));
// The model answer the main process replays: written to one file, replaced between the two scenarios.
const fakeFile = path.join(profile, 'fake-model.json');
const looped = await fixtureJson('ai-table.looped-raw.json');
const keptCells = OL.salvageElements(looped.rawText);
const formatted = await fixtureJson('formatted-notes.local.json');
const asFake = (localOutput, sentImage) => writeFile(fakeFile, JSON.stringify({ localOutput, sentImage }));
await asFake({ elements: keptCells, _salvaged: { kept: keptCells.length, reason: 'the model started repeating itself' } }, looped.sentImage);

let debugPort;
const { server, url: devUrl } = await startViteServer(createServer, { root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), logLevel: 'error' });
const wrapper = path.join(profile, 'main.cjs');
await writeFile(wrapper, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});\n`);

let electron, socket, id = 0;
const pending = new Map();
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));
async function until(fn, message, timeout = 30000) { const t = Date.now(); while (Date.now() - t < timeout) { try { const v = await fn(); if (v) return v; } catch {} await pause(150); } throw new Error(message); }
const send = (method, params = {}) => new Promise((resolve, reject) => { const k = ++id; pending.set(k, { resolve, reject }); socket.send(JSON.stringify({ id: k, method, params })); });
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
const clickButton = (text) => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) throw Error('No enabled button ' + ${JSON.stringify(text)}); b.click(); return true; })()`);
const shot = async (name) => { if (!shots) return; const s = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(shots, name), Buffer.from(s.data, 'base64')); };
const type = (t) => send('Input.insertText', { text: t }).then(() => pause(250));
const slideEls = () => evaluate(`JSON.parse(JSON.stringify(store.getState().deck.slides.find((s) => s.id === store.getState().currentSlideId).elements))`);
const flat = (doc) => { const out = []; const walk = (n) => { if (n.text) out.push(n.text); n.content?.forEach(walk); }; walk(doc); return out.join(''); };
const cellTexts = (t) => t.rows.map((r) => r.map((c) => flat(c.doc)));
const CELLS = [['항목', '제출 내용'], ['AI 모델', 'Ollama + Qwen2.5-VL 7B'], ['Coding Agent', 'Claude Code'], ['Skills', '실제 사용한 skill 파일이 있다면 포함'], ['MCP', '실제 사용한 MCP 서버와 설정이 있다면 명시'], ['Prompts', 'Claude Code 작업 지시 및 주요 반복 개선 기록']];

/** Inserts the image on a fresh slide, converts it through the dialog and applies it. Returns the applied elements. */
async function convertAndApply(imageUrl, frame, name) {
  await evaluate(`store.getState().addSlide()`);
  await evaluate(`(async () => { const b = await (await fetch(${JSON.stringify(imageUrl)})).blob(); await insert.insertImageFiles([new File([b], 'x.png', { type: 'image/png' })]); })()`);
  const img = await until(async () => (await slideEls()).find((e) => e.type === 'image'), 'image inserted');
  await evaluate(`store.getState().updateElements([${JSON.stringify(img.id)}], (d) => Object.assign(d, ${JSON.stringify(frame)})); store.getState().select([${JSON.stringify(img.id)}])`);
  await pause(250);
  const before = (await slideEls()).filter((e) => e.id !== img.id);
  await clickButton('Convert to Editable Slide');
  await until(() => evaluate(`[...document.querySelectorAll('.sk-footer button')].some((b) => b.textContent.trim() === 'Apply' && !b.disabled)`), 'preview ready');
  await pause(500);
  await shot(name + '-dialog.png');
  const preview = await evaluate(`(() => { const s = window.sketch.useSketch.getState(); return { types: s.conv.elements.map((e) => e.type), counts: s.report.counts, notes: s.parseIssues.map((i) => i.message) }; })()`);
  await clickButton('Apply');
  await until(() => evaluate(`!document.querySelector('.sk-dialog')`), 'applied');
  await evaluate(`store.getState().select([])`); await pause(600);
  await shot(name + '-applied.png');
  const after = await slideEls();
  assert.ok(!after.some((e) => e.id === img.id), 'the image was replaced');
  assert.deepEqual(after.filter((e) => before.some((b) => b.id === e.id)), before, 'other slide elements untouched');
  return { els: after.filter((e) => !before.some((b) => b.id === e.id)), preview, img };
}

try {
  ({ child: electron, debugPort } = await launchElectron(require('electron'), [wrapper], {
    cwd: root, env: testElectronEnv({ ELECTRON_DEV_URL: devUrl, MATHSLIDES_SKETCH_FAKE: fakeFile, MATHSLIDES_TEST_PDF_DIR: pdfDir, ANTHROPIC_API_KEY: '' }),
  }));
  electron.stderr.on('data', () => {});
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 'debug target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => { const d = JSON.parse(e.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(Error(d.error.message)) : p.resolve(d.result); } });
  await send('Runtime.enable');
  await until(() => evaluate(`!!document.querySelector('.propsbar')`), 'app mount');
  await evaluate(`(async () => {
    window.store = (await import('/src/store/store.ts')).useStore; window.sketch = await import('/src/sketch/session.ts');
    window.insert = await import('/src/canvas/insert.ts'); window.persist = await import('/src/store/persistence.ts');
    window.testFiles = {};
    window.showSaveFilePicker = async ({suggestedName}) => ({name:suggestedName,createWritable:async()=>({write:async(blob)=>{testFiles[suggestedName]=[...new Uint8Array(await blob.arrayBuffer())]},close:async()=>{}})});
  })()`);

  // ================= A) the table screenshot =================
  const A = await convertAndApply('/examples/sketches/ai-table.png', { x: 190, y: 200, w: 900, h: 443 }, 'table');
  assert.deepEqual(A.preview.types, ['table'], 'the preview shows ONE table (no loose text boxes)');
  assert.ok(A.preview.notes.some((n) => /cut off/.test(n)), 'the salvaged answer is reported to the user');
  assert.equal(A.els.length, 1); const T = A.els[0];
  assert.equal(T.type, 'table'); assert.equal(T.rows.length, 6); assert.equal(T.cols.length, 2); assert.equal(T.headerRow, true);
  assert.deepEqual(cellTexts(T), CELLS, 'every cell text exact');
  assert.ok(T.x >= 190 - 2 && T.x + T.w <= 190 + 900 + 2, 'inside the image area');
  console.log('PASS A1 table screenshot → one native 6×2 table with exact cell texts (from a real, salvaged model answer)');

  const dom = await evaluate(`(() => { const t = document.querySelector('.stage .slide table.ms-table'); const head = t.querySelector('tr.ms-head'); const body = t.querySelectorAll('tr')[2].querySelector('td, th');
    return { rows: t.querySelectorAll('tr').length, cells: t.querySelectorAll('td, th').length, headWeight: Number(getComputedStyle(head.querySelector('td, th')).fontWeight), bodyWeight: Number(getComputedStyle(body).fontWeight) }; })()`);
  assert.equal(dom.rows, 6); assert.equal(dom.cells, 12); assert.ok(dom.headWeight >= 600 && dom.bodyWeight < 600, 'header row is bold, body is not: ' + JSON.stringify(dom));
  console.log('PASS A2 rendered as a table: 6 rows, 12 cells, header bold (' + dom.headWeight + ') vs body (' + dom.bodyWeight + ')');

  // independent cell editing: change one cell, nothing else changes; undo restores it
  await evaluate(`store.getState().startCellEditing(${JSON.stringify(T.id)}, 2, 1, 'end')`); await pause(350);
  await type(' (edited)'); await evaluate('store.getState().stopEditing()'); await pause(300);
  let [T2] = await slideEls().then((e) => e.filter((x) => x.type === 'table'));
  const edited = cellTexts(T2);
  assert.equal(edited[2][1], 'Claude Code (edited)');
  assert.deepEqual(edited.map((r, i) => r.map((c, j) => (i === 2 && j === 1 ? '' : c))), CELLS.map((r, i) => r.map((c, j) => (i === 2 && j === 1 ? '' : c))), 'only that cell changed');
  await evaluate('store.getState().undo()'); await pause(300);
  [T2] = await slideEls().then((e) => e.filter((x) => x.type === 'table'));
  assert.deepEqual(cellTexts(T2), CELLS, 'undo restores the cell');
  console.log('PASS A3 independent cell edit, undo');

  // save → reopen, PDF, PPTX
  let slideIdx = await evaluate(`store.getState().deck.slides.findIndex((s) => s.id === store.getState().currentSlideId)`);
  const reopenCheck = async (check) => {
    await evaluate(`persist.saveProject(true)`);
    const name = await until(() => evaluate(`Object.keys(testFiles).filter((k) => k.endsWith('.mslides')).pop()`), 'saved');
    const text = Buffer.from(await evaluate(`testFiles[${JSON.stringify(name)}]`)).toString('utf8');
    await evaluate(`store.getState().loadDeck(JSON.parse(JSON.stringify({ version: 1, title: 'blank', slides: [{ id: 'x', background: '#fff', elements: [], notes: '' }] })), {})`);
    await evaluate(`persist.openFromText(${JSON.stringify(text)}, null)`);
    await evaluate(`store.getState().goToSlide(store.getState().deck.slides[${slideIdx}].id)`); await pause(600);
    await check(await slideEls());
  };
  await reopenCheck(async (els) => { const t = els.find((e) => e.type === 'table'); assert.deepEqual(cellTexts(t), CELLS); assert.equal(t.headerRow, true); assert.equal(await evaluate(`document.querySelectorAll('.stage .slide table.ms-table tr').length`), 6); });
  console.log('PASS A4 save → reopen keeps the table');
  const exportBoth = async () => {
    for (const f of await readdir(pdfDir)) await (await import('node:fs/promises')).rm(path.join(pdfDir, f));
    await evaluate(`import('/src/export/run.ts').then((m) => m.exportPdf())`);
    const pdfName = await until(async () => (await readdir(pdfDir)).find((f) => f.endsWith('.pdf')), 'PDF', 60000);
    const pdf = await readFile(path.join(pdfDir, pdfName)); assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    await evaluate("import('/src/export/run.ts').then((m) => m.exportPptx())");
    const title = await evaluate('store.getState().deck.title');
    await until(() => evaluate(`testFiles[${JSON.stringify(title + '.pptx')}]?.length > 1000`), 'PPTX', 60000);
    const zip = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(title + '.pptx')}]`)));
    return { pdf, xml: await zip.file(`ppt/slides/slide${slideIdx + 1}.xml`).async('string') };
  };
  let ex = await exportBoth();
  assert.ok(ex.pdf.length > 3000, 'PDF written');
  assert.equal((ex.xml.match(/<a:tr[ >]/g) ?? []).length, 6, 'PPTX table has 6 rows'); assert.equal((ex.xml.match(/<a:tc[ >]/g) ?? []).length, 12, '12 cells');
  assert.ok(CELLS.flat().every((c) => ex.xml.includes(c.replace(/&/g, '&amp;'))), 'every cell text is in the PPTX table');
  const firstRow = ex.xml.slice(ex.xml.indexOf('<a:tr'), ex.xml.indexOf('</a:tr>'));
  assert.ok(/ b="1"/.test(firstRow), 'PPTX header row is bold');
  console.log('PASS A5 PDF + PPTX (native <a:tbl>, 6 rows × 2 cols, header bold)');

  // ================= B) formatted notes =================
  await asFake(formatted.elements ? { elements: formatted.elements } : formatted, { width: 1504, height: 814 });
  const B = await convertAndApply('/examples/sketches/formatted-notes.png', { x: 120, y: 200, w: 880, h: 476 }, 'formatted');
  const texts = B.els.filter((e) => e.type === 'text'), tables = B.els.filter((e) => e.type === 'table');
  assert.equal(tables.length, 1, 'the table of the fixture is a native table');
  const top = texts.flatMap((e) => e.doc.content.map((n) => n.type));
  for (const t of ['bulletList', 'orderedList', 'blockquote']) assert.ok(top.includes(t), 'native ' + t + ' node: ' + top);
  assert.ok(texts.some((e) => e.doc.content.some((n) => n.type === 'paragraph' && n.attrs?.fontSize > e.style.fontSize)), 'heading = larger paragraph');
  const markNames = new Set(); const walk = (n) => { n.marks?.forEach((m) => markNames.add(m.type)); n.content?.forEach(walk); };
  B.els.forEach((e) => { if (e.type === 'text') walk(e.doc); else e.rows.flat().forEach((c) => walk(c.doc)); });
  for (const m of ['bold', 'italic', 'strike']) assert.ok(markNames.has(m), 'real ' + m + ' mark');
  const allDocs = JSON.stringify(B.els.map((e) => e.doc ?? e.rows));
  assert.ok(!/\*\*|~~|\\n- |"text":"[-•] /.test(allDocs), 'no Markdown characters remain as text');
  assert.ok(JSON.stringify(tables[0].rows[1][1].doc).includes('"bold"'), 'a bold word inside a table cell is a real bold mark');
  const dom2 = await evaluate(`(() => { const s = document.querySelector('.stage .slide'); const has = (sel, txt) => [...s.querySelectorAll(sel)].some((n) => n.textContent.includes(txt));
    return { strong: has('strong, b', 'final model'), em: has('em, i', 'Qwen2.5-VL'), s: has('s, del, strike', 'old baseline'), ul: s.querySelectorAll('ul li').length, ol: s.querySelectorAll('ol li').length, bq: s.querySelectorAll('blockquote').length, tbl: s.querySelectorAll('table.ms-table tr').length }; })()`);
  assert.deepEqual(dom2, { strong: true, em: true, s: true, ul: 3, ol: 3, bq: 1, tbl: 3 }, 'rendered with native formatting: ' + JSON.stringify(dom2));
  console.log('PASS B1 formatted notes → heading, bold/italic/strike marks, bullet + ordered list, blockquote and a table (native, rendered)');

  const slideIdxB = await evaluate(`store.getState().deck.slides.findIndex((s) => s.id === store.getState().currentSlideId)`);
  const snapshot = (els) => JSON.stringify(els.map((e) => e.doc ?? e.rows));
  const beforeSave = snapshot((await slideEls()).filter((e) => B.els.some((b) => b.id === e.id)));
  await evaluate(`persist.saveProject(true)`);
  const nameB = await until(() => evaluate(`Object.keys(testFiles).filter((k) => k.endsWith('.mslides')).pop()`), 'saved');
  const textB = Buffer.from(await evaluate(`testFiles[${JSON.stringify(nameB)}]`)).toString('utf8');
  await evaluate(`store.getState().loadDeck(JSON.parse(JSON.stringify({ version: 1, title: 'blank', slides: [{ id: 'x', background: '#fff', elements: [], notes: '' }] })), {})`);
  await evaluate(`persist.openFromText(${JSON.stringify(textB)}, null)`);
  await evaluate(`store.getState().goToSlide(store.getState().deck.slides[${slideIdxB}].id)`); await pause(600);
  const reopened = (await slideEls()).filter((e) => B.els.some((b) => b.id === e.id));
  assert.equal(snapshot(reopened), beforeSave, 'rich text, lists, quote and table identical after save and reopen');
  console.log('PASS B2 save → reopen keeps all structure');

  ex = await exportBoth();
  const xmlB = (await (async () => { const title = await evaluate('store.getState().deck.title'); const zip = await JSZip.loadAsync(Buffer.from(await evaluate(`testFiles[${JSON.stringify(title + '.pptx')}]`))); return zip.file(`ppt/slides/slide${slideIdxB + 1}.xml`).async('string'); })());
  assert.ok(/ b="1"/.test(xmlB) && / i="1"/.test(xmlB) && /strike="sngStrike"/.test(xmlB), 'PPTX runs: bold, italic, strikethrough');
  assert.ok(/<a:buAutoNum/.test(xmlB) && /<a:buChar/.test(xmlB), 'PPTX: numbered and bullet lists');
  assert.ok(xmlB.includes('Think on paper'), 'PPTX: the quote text'); assert.ok(/<a:tbl>/.test(xmlB), 'PPTX: native table');
  assert.ok(ex.pdf.length > 3000);
  console.log('PASS B3 PDF + PPTX (bold/italic/strike runs, numbered + bullet lists, quote, native table)');

  // ================= C) the user's REAL composite screenshot (real model output replayed, unedited) =================
  const comp = await fixtureJson('test-composite.real.json');
  await asFake(comp.localOutput, comp.sentImage);
  const C = await convertAndApply('/examples/composite/test_composite.png', { x: 360, y: 20, w: 340, h: Math.round(340 * 1229 / 653) }, 'composite');
  const cTables = C.els.filter((e) => e.type === 'table'), cTexts = C.els.filter((e) => e.type === 'text');
  assert.equal(cTables.length, 1, 'composite: ONE native table');
  const COMP_CELLS = [['Component', 'Value'], ['Model', 'Qwen2.5-VL 7B'], ['Framework', 'Ollama'], ['Learning Rate', '0.001'], ['Batch Size', '32']];
  assert.equal(cTables[0].rows.length, 5); assert.equal(cTables[0].cols.length, 2); assert.equal(cTables[0].headerRow, true);
  assert.deepEqual(cellTexts(cTables[0]), COMP_CELLS, 'composite: 10 cell texts exact');
  const liItems = (type) => cTexts.flatMap((e) => e.doc.content.filter((n) => n.type === type).map((n) => n.content.map((li) => flat(li))));
  assert.deepEqual(liItems('bulletList'), [['Extract text and equations', 'Reconstruct native tables', 'Preserve editable elements']], 'native bulletList > listItem ×3');
  assert.deepEqual(liItems('orderedList'), [['Upload screenshot', 'Run vision model', 'Edit generated slide']], 'native orderedList > listItem ×3');
  assert.ok(!cTexts.filter((e) => e.doc.content.every((n) => n.type === 'paragraph')).some((e) => /^(Component|Value|Model|Framework|Learning|Batch|Extract|Reconstruct|Preserve|Upload|Run vision|Edit generated)/.test(flat(e.doc))), 'no loose text box for a cell / item');
  const mathNodes = []; const wm = (n) => { if (/^math/.test(n.type)) mathNodes.push([n.type, n.attrs.latex]); n.content?.forEach(wm); };
  cTexts.forEach((e) => wm(e.doc));
  assert.deepEqual(mathNodes, [['mathInline', 'E = mc^2'], ['mathBlock', 'L = \\frac{1}{N} \\sum_{i=1}^{N} (y_i - \\hat{y}_i)^2']], 'inline + display equation: ' + JSON.stringify(mathNodes));
  const tb = cTables[0], tTop = tb.y, tBot = tb.y + tb.h;
  assert.ok(!cTexts.some((e) => e.y < tBot - 1 && e.y + e.h > tTop + 1 && e.x < tb.x + tb.w && e.x + e.w > tb.x), 'nothing overlaps the table');
  console.log('PASS C1 real composite output → native 5×2 table, bullet list ×3, ordered list ×3, inline + display equation, no overlap');
  const domC = await evaluate(`(() => { const s = document.querySelector('.stage .slide'); return { rows: s.querySelectorAll('table.ms-table tr').length, cells: s.querySelectorAll('table.ms-table td, table.ms-table th').length, ul: s.querySelectorAll('ul li').length, ol: s.querySelectorAll('ol li').length }; })()`);
  assert.deepEqual(domC, { rows: 5, cells: 10, ul: 3, ol: 3 }, 'rendered: ' + JSON.stringify(domC));
  await evaluate(`store.getState().startCellEditing(${JSON.stringify(tb.id)}, 4, 1, 'end')`); await pause(350);
  await type(' (edited)'); await evaluate('store.getState().stopEditing()'); await pause(300);
  let [Tc] = await slideEls().then((e) => e.filter((x) => x.type === 'table'));
  assert.equal(cellTexts(Tc)[4][1], '32 (edited)'); assert.deepEqual(cellTexts(Tc).flat().filter((c, i) => i !== 9), COMP_CELLS.flat().filter((c, i) => i !== 9), 'only that cell changed');
  await evaluate('store.getState().undo()'); await pause(300);
  [Tc] = await slideEls().then((e) => e.filter((x) => x.type === 'table'));
  assert.deepEqual(cellTexts(Tc), COMP_CELLS, 'undo restores the cell');
  // one Undo of the whole Apply brings the image back
  console.log('PASS C2 rendered natively; per-cell edit and undo');
  slideIdx = await evaluate(`store.getState().deck.slides.findIndex((s) => s.id === store.getState().currentSlideId)`);
  const snapC = (els) => JSON.stringify(els.map((e) => e.doc ?? e.rows));
  const beforeC = snapC((await slideEls()).filter((e) => C.els.some((b) => b.id === e.id)));
  await reopenCheck(async (els) => { assert.equal(snapC(els.filter((e) => C.els.some((b) => b.id === e.id))), beforeC, 'composite identical after save + reopen'); });
  ex = await exportBoth();
  assert.equal((ex.xml.match(/<a:tr[ >]/g) ?? []).length, 5, 'PPTX table: 5 rows'); assert.equal((ex.xml.match(/<a:tc[ >]/g) ?? []).length, 10, '10 cells');
  assert.ok(/<a:buChar/.test(ex.xml) && /<a:buAutoNum/.test(ex.xml), 'PPTX: bullet + numbered lists');
  assert.ok(ex.pdf.length > 3000, 'PDF written');
  console.log('PASS C3 save → reopen, PDF, PPTX (5 rows × 10 cells, bullet + numbered lists)');
  console.log('ALL PASS');
} finally {
  socket?.close();
  await stopElectron(electron);
  await server.close();
}
