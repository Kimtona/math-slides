/** Line/arrow endpoint horizontal/vertical hint (display only, never moves the point) and the down-arrow line data. Headless via Vite SSR. Run: node tests/line-snap.mjs */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configLoader: 'runner', cacheDir: await mkdtemp(path.join(tmpdir(), 'mathslides-vite-')), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { lineAxisHint } = await server.ssrLoadModule('/src/model/geometry.ts');
  const { newLine, lineBox } = await server.ssrLoadModule('/src/model/defaults.ts');
  const T = 6;
  // hint shown near horizontal (0° and 180°) and vertical (90° and 270°)
  assert.equal(lineAxisHint(300, 104, 100, 100, T), 'h');
  assert.equal(lineAxisHint(-100, 96, 100, 100, T), 'h');
  assert.equal(lineAxisHint(104, 300, 100, 100, T), 'v');
  assert.equal(lineAxisHint(96, -100, 100, 100, T), 'v');
  // boundary inclusive; gone immediately outside the tolerance; diagonals never
  assert.equal(lineAxisHint(300, 106, 100, 100, T), 'h');
  assert.equal(lineAxisHint(300, 107, 100, 100, T), null);
  assert.equal(lineAxisHint(106, 300, 100, 100, T), 'v');
  assert.equal(lineAxisHint(107, 300, 100, 100, T), null);
  assert.equal(lineAxisHint(300, 300, 100, 100, T), null);
  // the tolerance is the caller's (screen px / zoom): tighter at higher zoom
  assert.equal(lineAxisHint(300, 104, 100, 100, 6 / 2), null);
  // pure query: no coordinates are returned, so the endpoint cannot be corrected by it
  const line = newLine(100, 100, 300, 104);
  const before = JSON.stringify(line);
  lineAxisHint(line.x2, line.y2, line.x1, line.y1, T);
  assert.equal(JSON.stringify(line), before, 'hint does not touch the line');
  // down arrow is an ordinary arrow line: top → bottom, arrowhead at the end
  const down = newLine(480, 240, 480, 480, true);
  assert.equal(down.type, 'line'); assert.equal(down.arrowEnd, true); assert.equal(down.arrowStart, false);
  assert.ok(down.y2 > down.y1 && down.x1 === down.x2);
  assert.deepEqual(lineBox(down), { x: 480, y: 240, w: 0, h: 240 });
  console.log('PASS line axis hint + down arrow data');
} finally { await server.close(); }
