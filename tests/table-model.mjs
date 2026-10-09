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

  // ---- Phase 2A: width resize, column boundary drag ----
  let r2 = m.resizeToWidth([100, 200, 300], 1200); assert.deepEqual(r2, { cols: [200, 400, 600], w: 1200 }, 'ratios preserved');
  r2 = m.resizeToWidth([256, 256, 256], 500); assert.equal(r2.cols.reduce((a, b) => a + b, 0), 500); assert.equal(r2.w, 500);
  r2 = m.resizeToWidth([256, 256, 256], 10); assert.equal(r2.w, 3 * m.TABLE_MIN_COL, 'never below cols x 40'); assert.deepEqual(r2.cols, [40, 40, 40]);
  for (let w = 120; w < 1400; w += 37) { const q = m.resizeToWidth([123, 77, 301, 50], w); assert.equal(q.cols.reduce((a, b) => a + b, 0), q.w); assert.ok(q.cols.every((c) => c >= m.TABLE_MIN_COL), 'min width at ' + w); }
  const ratio = (c) => c.map((x) => x / c.reduce((a, b) => a + b, 0));
  const a1 = ratio([120, 240, 360]), a2 = ratio(m.resizeToWidth([120, 240, 360], 900).cols); a1.forEach((v, i) => assert.ok(Math.abs(v - a2[i]) < 0.01, 'ratio kept'));
  assert.deepEqual(m.resizeColumn([100, 100, 100], 0, 30), [130, 70, 100], 'only the two adjacent columns change');
  assert.deepEqual(m.resizeColumn([100, 100, 100], 1, -30), [100, 70, 130]);
  assert.deepEqual(m.resizeColumn([100, 100, 100], 0, 500), [160, 40, 100], 'right neighbour stops at 40');
  assert.deepEqual(m.resizeColumn([100, 100, 100], 0, -500), [40, 160, 100], 'left column stops at 40');
  assert.deepEqual(m.resizeColumn([100, 100, 100], 2, 10), [100, 100, 100], 'no boundary after the last column');
  assert.deepEqual(m.resizeColumn([50, 50], 0, 20), [60, 40], 'a pair keeps its sum and its minimum');
  assert.deepEqual(m.resizeColumn([30, 30], 0, 20), [30, 30], 'tiny pair: halves at most');
  for (let i = 0; i < 200; i++) { const c = [60 + rnd(300), 60 + rnd(300), 60 + rnd(300)]; const k = rnd(2); const q = m.resizeColumn(c, k, rnd(400) - 200); assert.equal(q.reduce((a, b) => a + b, 0), c.reduce((a, b) => a + b, 0), 'sum constant'); assert.ok(q.every((x) => x >= 40), 'minimum kept'); q.forEach((x, j) => { if (j !== k && j !== k + 1) assert.equal(x, c[j], 'other columns untouched'); }); }
  // several columns hitting the minimum at once must still sum exactly (regression: [150,300,100,218] -> 160 gave 170)
  assert.deepEqual(m.scaleCols([150, 300, 100, 218], 160), [40, 40, 40, 40]);
  for (const cols of [[150, 300, 100, 218], [10, 500, 10, 500, 10], [40, 40, 700], [256, 256, 256], [1, 1, 1, 1, 1, 1]]) {
    for (let w = cols.length * 40; w <= 1500; w += 13) { const q = m.scaleCols(cols, w); assert.equal(q.reduce((a, b) => a + b, 0), w, `sum for ${cols} -> ${w}`); assert.ok(q.every((c) => c >= 40 && Number.isInteger(c)), `min/int for ${cols} -> ${w}`); }
  }
  const big = m.scaleCols([150, 300, 100, 218], 900); assert.ok(big[1] > big[3] && big[3] > big[0] && big[0] > big[2], 'order of widths preserved when growing');
  console.log('PASS table model: width resize, column boundary drag, minimums');

  // ---- outer right edge: only the last column changes ----
  let e1 = m.resizeLastColumn([100, 200, 300], 100, 50); assert.deepEqual(e1, { cols: [100, 200, 350], w: 650 }, 'last column grows, width follows');
  e1 = m.resizeLastColumn([100, 200, 300], 100, -120); assert.deepEqual(e1, { cols: [100, 200, 180], w: 480 }, 'and shrinks; others untouched');
  e1 = m.resizeLastColumn([100, 200, 300], 100, -5000); assert.deepEqual(e1, { cols: [100, 200, 40], w: 340 }, 'minimum 40');
  e1 = m.resizeLastColumn([100, 200, 300], 500, 5000); assert.equal(500 + e1.w, 1280, 'stops at the slide edge'); assert.deepEqual(e1.cols.slice(0, 2), [100, 200]);
  e1 = m.resizeLastColumn([100, 200, 300], 500, 5000); assert.equal(e1.cols[2], 1280 - 500 - 300, 'exactly fills to the slide edge');
  e1 = m.resizeLastColumn([100, 200, 300], 1100, 80); assert.deepEqual(e1.cols, [100, 200, 300], 'a table already on the edge cannot grow');
  e1 = m.resizeLastColumn([100, 200, 300], 1100, -80); assert.equal(e1.cols[2], 220, 'a table that pokes out may still shrink without jumping');
  e1 = m.resizeLastColumn([500], 10, 100); assert.deepEqual(e1, { cols: [600], w: 600 }, 'single column');
  e1 = m.resizeLastColumn([30, 30], 10, -10); assert.equal(e1.cols[1], 30, 'a column already below the minimum is neither pushed up nor shrunk further');
  for (let i = 0; i < 300; i++) {
    const c = [40 + rnd(300), 40 + rnd(300), 40 + rnd(300)], x = rnd(800), d = rnd(1200) - 600;
    const q = m.resizeLastColumn(c, x, d);
    assert.equal(q.w, q.cols.reduce((a, b) => a + b, 0), 'w = sum'); assert.deepEqual(q.cols.slice(0, 2), c.slice(0, 2), 'others untouched'); assert.ok(q.cols[2] >= 40);
    if (x + c.reduce((a, b) => a + b, 0) <= 1280) assert.ok(x + q.w <= 1280, 'stays on the slide');
  }
  console.log('PASS table model: last-column (outer edge) resize, minimum, slide boundary');

  // ---- Phase 2A: spreadsheet paste ----
  const tsv = await server.ssrLoadModule('/src/model/tsv.ts');
  assert.deepEqual(tsv.parseTsv('a\tb\tc\n1\t2\t3\n'), [['a', 'b', 'c'], ['1', '2', '3']], 'LF, trailing newline is not a row');
  assert.deepEqual(tsv.parseTsv('a\tb\r\n1\t2\r\n'), [['a', 'b'], ['1', '2']], 'Excel CRLF');
  assert.deepEqual(tsv.parseTsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']], 'no trailing newline');
  assert.deepEqual(tsv.parseTsv('hello'), [['hello']]); assert.deepEqual(tsv.parseTsv(''), [['']]);
  assert.deepEqual(tsv.parseTsv('word\r\n'), [['word']], 'a single cell copied from a spreadsheet');
  assert.deepEqual(tsv.parseTsv('"a\tb"\t"line1\nline2"\t"say ""hi"""\n'), [['a\tb', 'line1\nline2', 'say "hi"']], 'quoted cells: tab, newline, doubled quotes');
  assert.deepEqual(tsv.parseTsv('"a\r\nb"\tz'), [['a\r\nb', 'z']], 'CRLF inside quotes is kept');
  assert.deepEqual(tsv.parseTsv('5" pipe\tx'), [['5" pipe', 'x']], 'a quote inside an unquoted cell is literal');
  assert.deepEqual(tsv.parseTsv('a\t\tc\n\t\t\n'), [['a', '', 'c'], ['', '', '']], 'empty cells');
  assert.deepEqual(tsv.parseTsv('a\n\nb'), [['a'], [''], ['b']], 'an empty line in the middle is an empty row');
  assert.deepEqual(tsv.parseTsv('"unterminated\tx'), [['unterminated\tx']], 'an open quote does not lose data');
  assert.equal(tsv.isGrid([['a']]), false); assert.equal(tsv.isGrid([['a', 'b']]), true); assert.equal(tsv.isGrid([['a'], ['b']]), true);

  const base = m.newTable(640, 360); const asText = (t, r, c) => m.cellPlainText(t.rows[r][c].doc);
  let p = apply(base, m.pasteGrid(base, 1, 1, [['a', 'b'], ['c', 'd']])); ok(p, 'paste inside the grid'); assert.equal(p.rows.length, 3); assert.equal(p.cols.length, 3);
  assert.deepEqual([asText(p, 1, 1), asText(p, 1, 2), asText(p, 2, 1), asText(p, 2, 2)], ['a', 'b', 'c', 'd']); assert.equal(asText(p, 0, 0), ''); assert.equal(p.rows[0][0], base.rows[0][0], 'untouched cells are the same objects');
  p = apply(base, m.pasteGrid(base, 1, 1, [['a', 'b', 'c', 'd'], ['1', '2', '3', '4'], ['x', 'y', 'z', 'w']])); ok(p, 'expands rows and columns');
  assert.equal(p.rows.length, 4); assert.equal(p.cols.length, 5); assert.equal(asText(p, 3, 4), 'w'); assert.ok(p.rows.every((r) => r.length === 5));
  p = apply(base, m.pasteGrid(base, 0, 0, [['only', 'row']])); assert.equal(p.rows.length, 3, 'no row growth needed');
  p = apply(base, m.pasteGrid(base, 2, 2, [['a'], ['b'], ['c']])); ok(p); assert.equal(p.rows.length, 5); assert.equal(p.cols.length, 3);
  p = apply(base, m.pasteGrid(base, 0, 0, [['a', 'b'], ['c']])); assert.equal(asText(p, 1, 1), '', 'ragged rows leave the rest alone'); ok(p);
  p = apply(base, m.pasteGrid(base, 0, 0, [['l1\nl2']])); assert.equal(p.rows[0][0].doc.content.length, 2, 'newlines inside a cell become paragraphs');
  const nearEdge = { ...base, x: 1280 - base.w - 4 }; p = apply(nearEdge, m.pasteGrid(nearEdge, 0, 0, [['1', '2', '3', '4', '5']])); ok(p, 'near the slide edge the width is kept'); assert.equal(p.w, base.w); assert.ok(p.cols.every((c) => c >= m.TABLE_MIN_COL));
  const frozen2 = structuredClone(base); m.pasteGrid(frozen2, 0, 0, [['a', 'b', 'c', 'd'], ['x'], ['y'], ['z']]); assert.deepEqual(frozen2, base, 'paste does not mutate its input');
  console.log('PASS TSV parsing (quotes, CRLF, empty cells) and grid paste with automatic expansion');
} finally {
  await server.close();
}
