/** Pure Quick Draw helpers (headless). Run: node tests/quick-draw-model.mjs */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { makeTempDir } from './tmp-utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configLoader: 'runner', cacheDir: makeTempDir('mathslides-vite-'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const m = await server.ssrLoadModule('/src/model/quickDraw.ts');
  assert.deepEqual(m.quickDrawBox({ x: 300, y: 200 }, { x: 100, y: 50 }), { x: 100, y: 50, w: 200, h: 150 }, 'any drag direction is normalized');
  assert.deepEqual(m.quickDrawBox({ x: -40, y: 10 }, { x: 5000, y: 9999 }), { x: 0, y: 10, w: 1280, h: 710 }, 'clamped to the slide');
  assert.equal(m.isQuickDrawBigEnough({ x: 0, y: 0, w: 5, h: 100 }), false, 'too thin');
  assert.equal(m.isQuickDrawBigEnough({ x: 0, y: 0, w: 100, h: 3 }), false, 'too flat');
  assert.equal(m.isQuickDrawBigEnough({ x: 0, y: 0, w: 6, h: 6 }), true);
  const el = m.newQuickDrawRect({ x: 10.4, y: 20.6, w: 100.2, h: 50.7 });
  assert.equal(el.type, 'shape');
  assert.equal(el.shape, 'rect');
  assert.equal(el.fill, null);
  assert.equal(el.stroke, '#FF0000');
  assert.equal(el.strokeWidth, 2);
  assert.equal(el.radius, 0);
  assert.deepEqual([el.x, el.y, el.w, el.h], [10, 21, 100, 51]);
  assert.equal(el.doc, undefined, 'no text');
  console.log('quick-draw-model: ok');
} finally {
  await server.close();
}
