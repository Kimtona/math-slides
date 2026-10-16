/** Partial symbol colors of an equation (headless, MathJax only). Run: node tests/math-leaf-color.mjs */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configLoader: 'runner', cacheDir: await mkdtemp(path.join(tmpdir(), 'mathslides-vite-')), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { renderTex } = await server.ssrLoadModule('/src/math/mathjax.ts');
  const B = '#2563EB';
  const leafFills = (svg) => [...svg.matchAll(/<g data-mml-node="(?:mi|mn|mo|mtext|ms)"([^>]*)>/g)].map((m) => /fill="(#[0-9A-F]{6})"/i.exec(m[1])?.[1] ?? null);

  // E = mc^2 → leaves E, =, m, c, 2: coloring leaf 2 (m) touches only m.
  const plain = renderTex('E = mc^2', false);
  assert.deepEqual(leafFills(plain.svg), [null, null, null, null, null]);
  const colored = renderTex('E = mc^2', false, { src: 'E = mc^2', items: [{ i: 2, c: B }] });
  assert.deepEqual(leafFills(colored.svg), [null, null, B, null, null], 'only m is colored');
  assert.equal(colored.widthEm, plain.widthEm, 'geometry unchanged');
  assert.equal(plain.svg.includes(B), false, 'uncolored render is untouched (and cached separately)');

  // Stale metadata (LaTeX changed) is ignored, never applied to another symbol.
  assert.deepEqual(leafFills(renderTex('E = mc^3', false, { src: 'E = mc^2', items: [{ i: 2, c: B }] }).svg), [null, null, null, null, null]);
  // Malformed items are ignored.
  const bad = renderTex('a+b', false, { src: 'a+b', items: [{ i: 99, c: B }, { i: -1, c: B }, { i: 0, c: 'red' }, { i: 1.5, c: B }] });
  assert.deepEqual(leafFills(bad.svg), [null, null, null]);

  // Symbols of structured equations are individually addressable.
  const count = (l) => leafFills(renderTex(l, false).svg).length;
  assert.equal(count('\\frac{a+b}{c}'), 4); // a + b c
  assert.equal(count('\\sum_{i=1}^{n}x_i'), 7); // sum n i = 1 x i
  assert.equal(count('\\alpha'), 1);
  const frac = renderTex('\\frac{a+b}{c}', false, { src: '\\frac{a+b}{c}', items: [{ i: 2, c: B }] });
  assert.deepEqual(leafFills(frac.svg), [null, null, B, null]);

  // Priority: a user-written \textcolor is overridden by the explicit symbol color, and its other symbols keep theirs.
  const src = '\\textcolor{red}{ab}';
  const mixed = renderTex(src, false, { src, items: [{ i: 1, c: B }] });
  assert.deepEqual(leafFills(mixed.svg), [null, B]);
  assert.match(mixed.svg, /<g[^>]*fill="red"/, 'user \\textcolor still colors the rest');

  // Display (block) equations use the same path.
  assert.deepEqual(leafFills(renderTex('E = mc^2', true, { src: 'E = mc^2', items: [{ i: 0, c: B }] }).svg), [B, null, null, null, null]);
  console.log('PASS math leaf colors');
} finally { await server.close(); }
