/** Pure image corner-radius helpers (headless). Run: node tests/image-radius-model.mjs */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configLoader: 'runner', cacheDir: await mkdtemp(path.join(tmpdir(), 'mathslides-vite-')), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const m = await server.ssrLoadModule('/src/model/imageCrop.ts');
  assert.equal(m.imageRadius({ w: 400, h: 200 }), 0, 'absent radius = square');
  assert.equal(m.imageRadius({ w: 400, h: 200, radius: 0 }), 0);
  assert.equal(m.imageRadius({ w: 400, h: 200, radius: 24 }), 24);
  assert.equal(m.imageRadius({ w: 400, h: 200, radius: 500 }), 100, 'clamped to half the shorter side');
  assert.equal(m.imageRadius({ w: 40, h: 300, radius: 24 }), 20, 'follows a resize');
  assert.equal(m.imageRadius({ w: 400, h: 200, radius: -5 }), 0);
  // adj: radius = min(w,h) * adj / 100000, adj pinned to 0..50000
  assert.equal(m.roundRectAdj({ w: 400, h: 200 }), 0);
  assert.equal(m.roundRectAdj({ w: 400, h: 200, radius: 20 }), 10000);
  assert.equal(m.roundRectAdj({ w: 200, h: 400, radius: 20 }), 10000, 'uses the shorter side either way');
  assert.equal(m.roundRectAdj({ w: 400, h: 200, radius: 9999 }), 50000, 'a full semicircle end is the maximum');
  for (const r of [1, 7, 24, 60, 99]) {
    const el = { w: 333, h: 211, radius: r };
    assert.ok(Math.abs(Math.min(el.w, el.h) * m.roundRectAdj(el) / 100000 - r) < 0.0025 * 211 / 100, 'adj reproduces the radius within rounding');
  }
  assert.equal(m.DEFAULT_RADIUS_PRESET, 50, 'single preset, default 50');
  assert.equal(m.snapRadius, undefined, 'magnetic snapping is gone');
  console.log('PASS image radius helpers');
} finally {
  await server.close();
}
