/** Pure table model: shape and width invariants, row/column operations. Run: node tests/table-model.mjs */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configLoader: 'runner', cacheDir: await mkdtemp(path.join(tmpdir(), 'mathslides-vite-')), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const m = await server.ssrLoadModule('/src/model/table.ts');
  const ok = (t, msg) => assert.deepEqual(m.tableProblems(t), [], msg);
  const apply = (t, e) => ({ ...t, ...e });

  // Default table: 3×3, ~60% of the slide, minimal, header row on
  const t0 = m.newTable(640, 360);
  assert.equal(t0.type, 'table'); assert.equal(t0.rows.length, 3); assert.equal(t0.cols.length, 3);
  assert.ok(t0.rows.every((r) => r.length === 3));
  assert.equal(t0.w, Math.round(1280 * 0.6)); assert.equal(t0.style, 'minimal'); assert.equal(t0.headerRow, true);
  assert.equal(t0.x + t0.w / 2, 640, 'centered horizontally'); ok(t0, 'new table is valid');
  assert.deepEqual(t0.cols, [256, 256, 256]);
  assert.notEqual(t0.rows[0][0].doc, t0.rows[1][1].doc, 'cells do not share a doc object');
  assert.equal(m.newTable(0, 0).id === m.newTable(0, 0).id, false, 'unique ids');

  // splitWidth / scaleCols: integers, exact sums, minimums
  assert.deepEqual(m.splitWidth(100, 3), [33, 33, 34]);
  for (const [total, n] of [[768, 3], [769, 4], [1000, 7], [50, 1]]) assert.equal(m.splitWidth(total, n).reduce((a, b) => a + b, 0), total);
  const sc = m.scaleCols([100, 200, 300], 900); assert.deepEqual(sc, [150, 300, 450]);
  assert.equal(m.scaleCols([10, 10, 10], 100).reduce((a, b) => a + b, 0), 100);
  assert.ok(m.scaleCols([1, 1000], 300).every((c) => c >= m.TABLE_MIN_COL));

  // Rows
  let t = apply(t0, m.insertRow(t0, 3)); ok(t); assert.equal(t.rows.length, 4); assert.equal(t.w, t0.w);
  t = apply(t0, m.insertRow(t0, 0)); assert.equal(t.rows.length, 4);
  assert.equal(t.rows[0], t0.rows[0], 'a header row stays first: inserting "above" it goes below');
  t = apply({ ...t0, headerRow: false }, m.insertRow({ ...t0, headerRow: false }, 0)); assert.notEqual(t.rows[0], t0.rows[0], 'no header: row can be inserted at the top');
  t = apply(t0, m.insertRow(t0, 99)); assert.equal(t.rows.length, 4, 'index clamped');
  t = apply(t0, m.deleteRow(t0, 1)); ok(t); assert.equal(t.rows.length, 2); assert.equal(t.rows[1], t0.rows[2]);
  let one = { ...t0, rows: [t0.rows[0]] };
  assert.equal(m.deleteRow(one, 0).rows.length, 1, 'the last row cannot be deleted');
  assert.equal(m.deleteRow(t0, 9).rows.length, 3, 'out-of-range delete is a no-op');

  // Columns: grow by the average width; delete shrinks; invariants hold
  t = apply(t0, m.insertCol(t0, 1)); ok(t); assert.equal(t.cols.length, 4); assert.equal(t.w, t0.w + 256);
  assert.ok(t.rows.every((r) => r.length === 4)); assert.equal(t.rows[0][0], t0.rows[0][0]); assert.equal(t.rows[0][2], t0.rows[0][1]);
  t = apply(t0, m.insertCol(t0, 99)); assert.equal(t.cols.length, 4, 'index clamped');
  // near the slide edge the table keeps its width (columns are scaled instead of overflowing)
  const wide = { ...t0, x: 1280 - t0.w - 10 };
  t = apply(wide, m.insertCol(wide, 3)); ok(t); assert.equal(t.w, wide.w, 'width kept when the table would leave the slide'); assert.equal(t.cols.length, 4);
  t = apply(t0, m.deleteCol(t0, 0)); ok(t); assert.equal(t.cols.length, 2); assert.equal(t.w, 512); assert.equal(t.rows[0][0], t0.rows[0][1]);
  const single = apply(t0, m.deleteCol(apply(t0, m.deleteCol(t0, 0)), 0)); ok(single); assert.equal(single.cols.length, 1);
  assert.equal(m.deleteCol(single, 0).cols.length, 1, 'the last column cannot be deleted');

  // Repeated mixed operations never break the invariants
  let r = t0, seed = 7; const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let i = 0; i < 300; i++) {
    const k = rnd(4);
    r = apply(r, k === 0 ? m.insertRow(r, rnd(r.rows.length + 1)) : k === 1 ? m.deleteRow(r, rnd(r.rows.length)) : k === 2 ? m.insertCol(r, rnd(r.cols.length + 1)) : m.deleteCol(r, rnd(r.cols.length)));
    assert.deepEqual(m.tableProblems(r), [], 'invariants after op ' + i);
  }
  const frozen = structuredClone(t0); m.insertRow(frozen, 1); m.deleteCol(frozen, 0); assert.deepEqual(frozen, t0, 'operations do not mutate their input');

  // Repair of malformed (hand-edited / foreign) tables
  const bad = { w: 300, cols: [100, 100], rows: [[m.emptyCell()], [m.emptyCell(), m.emptyCell(), m.emptyCell()]] };
  const fixed = m.repairTable(bad); assert.deepEqual(m.tableProblems(fixed), []); assert.equal(fixed.rows[0].length, 2);
  assert.deepEqual(m.tableProblems(m.repairTable({ w: 0, cols: [], rows: [] })), []);
  assert.equal(m.repairTable(t0), t0, 'a valid table is returned as is');
  assert.equal(m.cellPlainText(m.cellText('a').doc), 'a');
  console.log('PASS table model (default 3x3, row/column ops, invariants, repair)');
} finally {
  await server.close();
}
