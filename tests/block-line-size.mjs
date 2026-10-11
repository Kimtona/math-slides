/** Callout / Quote per-line font size: selection sizing, JSON round trip (old docs unchanged), static render.
 * Headless through Vite's SSR loader (no Electron). Run: node tests/block-line-size.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configLoader: 'runner', cacheDir: await mkdtemp(path.join(tmpdir(), 'mathslides-vite-')), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { getSchema } = await import('@tiptap/core');
  const { EditorState, TextSelection } = await import('@tiptap/pm/state');
  const ext = await server.ssrLoadModule('/src/editor/extensions.ts');
  const schema = getSchema(ext.makeExtensions(false));
  const p = (text, fontSize = null) => ({ type: 'paragraph', attrs: { fontSize }, content: [{ type: 'text', text }] });
  const doc = {
    type: 'doc',
    content: [
      { type: 'callout', attrs: { icon: '💡' }, content: [p('a'), p('b'), p('c')] },
      { type: 'blockquote', content: [p('q1'), p('q2')] },
    ],
  };
  const state0 = EditorState.create({ schema, doc: schema.nodeFromJSON(doc) });
  const pos = (needle) => { let at = -1; state0.doc.descendants((n, i) => { if (n.isText && n.text === needle) at = i; }); return at; };
  const sel = (from, to) => state0.apply(state0.tr.setSelection(TextSelection.create(state0.doc, from, to)));

  // selection across b..c in the callout sizes only those lines
  const s1 = sel(pos('b') + 1, pos('c') + 1);
  assert.equal(ext.lineSizeAt(s1), null);
  const out = s1.apply(ext.lineSizeTransaction(s1, 40)).doc.toJSON();
  assert.deepEqual(out.content[0].content.map((n) => n.attrs.fontSize), [null, 40, 40], 'only selected lines');
  assert.deepEqual(out.content[1].content.map((n) => n.attrs.fontSize), [null, null], 'quote untouched');

  // caret in a quote line
  const s2 = sel(pos('q2') + 1, pos('q2') + 1);
  const out2 = s2.apply(ext.lineSizeTransaction(s2, 30)).doc.toJSON();
  assert.deepEqual(out2.content[1].content.map((n) => n.attrs.fontSize), [null, 30], 'caret sizes its own line');
  assert.equal(ext.lineSizeAt(s2.apply(ext.lineSizeTransaction(s2, 30))), 30);

  // reset to box size, and old docs (no fontSize attr) load unchanged
  const scaled = ext.scaleParagraphSizes(out2, 2);
  assert.deepEqual(scaled.content[1].content.map((n) => n.attrs.fontSize), [null, 60], 'box scaling doubles sized quote lines');
  const legacy = { type: 'doc', content: [{ type: 'callout', attrs: { icon: '💡' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'old' }] }] }] };
  const ls = EditorState.create({ schema, doc: schema.nodeFromJSON(legacy) });
  assert.equal(ext.lineSizeAt(EditorState.create({ schema, doc: ls.doc, selection: TextSelection.create(ls.doc, 3) })), null, 'legacy callout follows the box size');
  assert.deepEqual(schema.nodeFromJSON(out2).toJSON(), out2, 'sizes survive the JSON round trip');
  console.log('PASS callout/quote per-line sizes');

  // Plain text box: word-level (textStyle mark) and line-level sizes
  const plain = { type: 'doc', content: [p('hello world'), p('second')] };
  const ps = EditorState.create({ schema, doc: schema.nodeFromJSON(plain) });
  const at = (st, needle) => { let r = -1; st.doc.descendants((n, i) => { if (n.isText && n.text.includes(needle)) r = i; }); return r; };
  const psel = (a, b) => ps.apply(ps.tr.setSelection(TextSelection.create(ps.doc, a, b)));
  const w0 = at(ps, 'hello');
  assert.equal(ext.inLineSelection(psel(w0 + 1, w0 + 6)), true, 'part of a line = characters');
  assert.equal(ext.inLineSelection(psel(w0, w0 + 11)), false, 'a whole line = line');
  assert.equal(ext.inLineSelection(psel(w0 + 3, w0 + 3)), false, 'caret = line');
  assert.equal(ext.inLineSelection(psel(w0 + 3, at(ps, 'second') + 2)), false, 'several lines = lines');
  // word size: mark on the word only, paragraph untouched, other marks kept
  const marked = schema.text('hello', [schema.marks.textStyle.create({ color: '#f00' })]);
  const withColor = EditorState.create({ schema, doc: schema.node('doc', null, [schema.node('paragraph', null, [marked, schema.text(' world')])]) });
  const cs = withColor.apply(withColor.tr.setSelection(TextSelection.create(withColor.doc, 1, 6)));
  const sized = cs.apply(cs.tr.addMark(1, 6, schema.marks.textStyle.create({ color: '#f00', fontSize: 48 })));
  const pj = sized.doc.toJSON().content[0];
  assert.equal(pj.attrs.fontSize, null, 'paragraph keeps the box size');
  assert.deepEqual({ ...pj.content[0].marks[0].attrs }, { color: '#f00', fontFamily: null, fontSize: 48 }, 'size next to color');
  assert.equal(pj.content[1].marks, undefined, 'rest of the line untouched');
  assert.equal(ext.charSizeAt(sized.apply(sized.tr.setSelection(TextSelection.create(sized.doc, 2, 4)))), 48);
  // JSON round trip, corner scaling, legacy docs
  assert.deepEqual(schema.nodeFromJSON(sized.doc.toJSON()).toJSON(), sized.doc.toJSON(), 'char sizes survive the JSON round trip');
  assert.equal(ext.scaleParagraphSizes(sized.doc.toJSON(), 0.5).content[0].content[0].marks[0].attrs.fontSize, 24, 'box scaling scales char sizes');
  assert.equal(ext.charSizeAt(ps.apply(ps.tr.setSelection(TextSelection.create(ps.doc, 2, 5)))), null, 'legacy text follows its line');
  // line sizing in a plain box
  const lt = psel(w0 + 3, w0 + 3);
  assert.deepEqual(lt.apply(ext.lineSizeTransaction(lt, 36)).doc.toJSON().content.map((n) => n.attrs.fontSize), [36, null], 'caret sizes its own line');
  // static render
  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = (await import('react')).default;
  const st = await server.ssrLoadModule('/src/render/StaticText.tsx');
  const html = renderToStaticMarkup(React.createElement(st.StaticText ?? Object.values(st)[0], { doc: sized.doc.toJSON() }));
  assert.match(html, /font-size:48px/, 'static render sizes the word');
  console.log('PASS plain text box line/char sizes');
} finally {
  await server.close();
}
