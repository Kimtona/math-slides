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
} finally {
  await server.close();
}
