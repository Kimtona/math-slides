/** Pure table model: shape and width invariants, row/column operations. Run: node tests/table-model.mjs */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { makeTempDir } from './tmp-utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configLoader: 'runner', cacheDir: makeTempDir('mathslides-vite-'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
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

  // ---- Phase 2B: appearance (styles, header, fills, border color) ----
  const mk = (o = {}) => ({ ...m.newTable(640, 360), ...o });
  let col = m.tableColors(mk());
  assert.deepEqual(col, { line: '#E5E7EB', last: '#D1D5DB', head: '#9CA3AF', headFill: null }, 'Minimal default colors = the Phase 1 look');
  col = m.tableColors(mk({ style: 'grid' })); assert.deepEqual([col.line, col.last, col.head, col.headFill], ['#D1D5DB', '#D1D5DB', '#D1D5DB', null]);
  col = m.tableColors(mk({ style: 'header' })); assert.equal(col.headFill, '#F3F4F6', 'Header style: neutral light-gray header fill'); assert.equal(col.line, '#E5E7EB');
  assert.equal(m.tableColors(mk({ style: 'header', headerRow: false })).headFill, null, 'header row off: no header fill');
  assert.equal(m.tableColors(mk({ style: 'minimal' })).headFill, null);
  col = m.tableColors(mk({ borderColor: '#DC2626' })); assert.deepEqual([col.line, col.last, col.head], ['#DC2626', '#DC2626', '#DC2626'], 'custom border color replaces every line color');
  assert.equal(m.tableColors(mk({ style: 'header', borderColor: '#DC2626' })).headFill, '#F3F4F6', 'border color does not touch the header fill');
  // borders per style
  const T3 = mk();
  assert.deepEqual(m.cellBorders(T3, 0), [null, null, { color: '#9CA3AF', px: 1.5 }, null], 'Minimal: header rule');
  assert.deepEqual(m.cellBorders(T3, 1), [null, null, { color: '#E5E7EB', px: 1 }, null], 'Minimal: row divider');
  assert.deepEqual(m.cellBorders(T3, 2), [null, null, { color: '#D1D5DB', px: 1 }, null], 'Minimal: last row');
  assert.deepEqual(m.cellBorders(mk({ headerRow: false }), 0), [null, null, { color: '#E5E7EB', px: 1 }, null], 'no header row: ordinary divider');
  const g = m.cellBorders(mk({ style: 'grid' }), 1); assert.ok(g.every((e) => e && e.px === 1 && e.color === '#D1D5DB'), 'Grid: all four sides, 1px');
  assert.ok(m.cellBorders(mk({ style: 'grid', borderColor: '#2563EB' }), 0).every((e) => e.color === '#2563EB' && e.px === 1));
  assert.ok(m.cellBorders(mk({ borderColor: '#2563EB' }), 1).every((e) => !e || (e.color === '#2563EB' && e.px === 1)), 'width is fixed whatever the color');
  // cell fill precedence
  const cells = mk().rows; const filled = { ...cells[0][0], fill: '#FEF08A' };
  assert.equal(m.cellFill(mk({ style: 'header' }), 0, cells[0][1]), '#F3F4F6', 'Header style default on the header row');
  assert.equal(m.cellFill(mk({ style: 'header' }), 0, filled), '#FEF08A', 'a custom fill wins over the style fill');
  assert.equal(m.cellFill(mk({ style: 'header' }), 1, cells[1][0]), null, 'body cells have no default fill');
  assert.equal(m.cellFill(mk({ style: 'header', headerRow: false }), 0, filled), '#FEF08A', 'a custom fill survives the header toggle');
  assert.equal(m.cellFill(mk({ style: 'minimal' }), 0, cells[0][1]), null);
  // fill helpers
  const rows0 = mk().rows, f1 = m.setCellFill(rows0, 1, 2, '#FEF08A');
  assert.equal(f1[1][2].fill, '#FEF08A'); assert.equal(f1[0][0], rows0[0][0], 'other cells are untouched objects'); assert.equal(f1[1][1], rows0[1][1]); assert.equal(rows0[1][2].fill, undefined, 'input not mutated');
  assert.equal(m.setCellFill(f1, 1, 2, null)[1][2].fill, undefined); assert.ok(!('fill' in m.setCellFill(f1, 1, 2, null)[1][2]), 'clearing removes the key');
  assert.equal(f1[1][2].doc, rows0[1][2].doc, 'the cell text is kept');
  const all = m.setAllFills(rows0, '#BAE6FD'); assert.ok(all.flat().every((c) => c.fill === '#BAE6FD')); assert.equal(m.uniformFill(all), '#BAE6FD'); assert.equal(m.uniformFill(f1), null, 'mixed fills'); assert.equal(m.uniformFill(rows0), null);
  assert.ok(m.setAllFills(all, null).flat().every((c) => !('fill' in c)));
  // legacy tables (no optional fields) and paste keep fills
  const legacy = JSON.parse(JSON.stringify(mk())); delete legacy.borderColor; assert.deepEqual(m.tableProblems(legacy), []); assert.equal(m.tableColors(legacy).line, '#E5E7EB');
  assert.deepEqual(Object.keys(mk().rows[0][0]), ['doc'], 'new cells carry no fill key');
  const pf = { ...mk(), rows: m.setCellFill(mk().rows, 1, 1, '#FEF08A') }; const pasted = apply(pf, m.pasteGrid(pf, 1, 1, [['x']])); assert.equal(pasted.rows[1][1].fill, '#FEF08A', 'pasting text keeps the cell fill'); assert.equal(m.cellPlainText(pasted.rows[1][1].doc), 'x');
  assert.deepEqual(m.tableProblems(m.repairTable({ ...pf, cols: [10, 10] })), [], 'repair keeps working with fills');
  console.log('PASS table model: styles, header fill, border color, fills and precedence');

  // ---- merged cells ----
  const mt = (r, c) => { const t = m.newTable(640, 360, { rows: r, cols: c }); return { ...t, headerRow: false }; };
  const txt = (t, r, c, s2) => { t.rows[r][c] = m.textCell(s2); return t; };
  let mgrid = mt(3, 3);
  txt(mgrid, 0, 0, 'a'); txt(mgrid, 0, 1, 'b'); txt(mgrid, 1, 0, 'c');
  const mmg = m.mergeCells(mgrid.rows, { r1: 1, c1: 1, r2: 0, c2: 0 }); // corners in any order
  assert.deepEqual(mmg.rect, { r1: 0, c1: 0, r2: 1, c2: 1 });
  let mg1 = { ...mgrid, rows: mmg.rows }; ok(mg1, 'merged table is still a valid rectangular grid');
  assert.equal(mg1.rows[0][0].rowSpan, 2); assert.equal(mg1.rows[0][0].colSpan, 2);
  assert.ok(mg1.rows[0][1].covered && mg1.rows[1][0].covered && mg1.rows[1][1].covered && !mg1.rows[2][2].covered);
  assert.equal(m.cellPlainText(mg1.rows[0][0].doc), 'a\nb\nc', 'texts of the merged cells are kept, nothing is lost');
  assert.deepEqual(m.rectOf(mg1.rows, 1, 1), { r1: 0, c1: 0, r2: 1, c2: 1 }); assert.deepEqual(m.anchorOf(mg1.rows, 1, 0), { row: 0, col: 0 });
  assert.ok(m.isMerged(mg1.rows, 1, 1) && !m.isMerged(mg1.rows, 2, 2));
  // a selection that cuts a merged cell grows to contain it
  assert.deepEqual(m.expandRect(mg1.rows, { r1: 1, c1: 1, r2: 2, c2: 2 }), { r1: 0, c1: 0, r2: 2, c2: 2 });
  assert.equal(m.mergeCells(mgrid.rows, { r1: 2, c1: 2, r2: 2, c2: 2 }).rows, mgrid.rows, 'one cell: nothing to merge');
  // unmerge restores plain cells (text stays in the top-left one)
  const mum = m.unmergeCells(mg1.rows, 1, 1);
  assert.ok(mum.flat().every((c) => !c.covered && !c.rowSpan && !c.colSpan)); assert.equal(m.cellPlainText(mum[0][0].doc), 'a\nb\nc');
  // rows: inserting inside a merged cell grows it, outside leaves it; deleting shrinks it / moves the anchor down
  let mq = apply(mg1, m.insertRow(mg1, 1)); ok(mq); assert.equal(mq.rows.length, 4); assert.equal(mq.rows[0][0].rowSpan, 3); assert.ok(mq.rows[1][0].covered && mq.rows[1][1].covered && !mq.rows[1][2].covered);
  mq = apply(mg1, m.insertRow(mg1, 2)); ok(mq); assert.equal(mq.rows[0][0].rowSpan, 2, 'inserting below the merge leaves it alone'); assert.ok(!mq.rows[2][0].covered);
  mq = apply(mg1, m.deleteRow(mg1, 1)); ok(mq); assert.equal(mq.rows.length, 2); assert.ok(!mq.rows[0][0].rowSpan, 'rowSpan 2 -> 1 is dropped'); assert.equal(mq.rows[0][0].colSpan, 2);
  mq = apply(mg1, m.deleteRow(mg1, 0)); ok(mq); assert.equal(mq.rows.length, 2);
  assert.ok(!mq.rows[0][0].covered && mq.rows[0][0].colSpan === 2 && !mq.rows[0][0].rowSpan, 'anchor row deleted: the cell below takes over');
  assert.equal(m.cellPlainText(mq.rows[0][0].doc), 'a\nb\nc');
  // columns (same logic through the transpose)
  mq = apply(mg1, m.insertCol(mg1, 1)); ok(mq); assert.equal(mq.cols.length, 4); assert.equal(mq.rows[0][0].colSpan, 3); assert.equal(mq.rows[0][0].rowSpan, 2); assert.ok(mq.rows[0][1].covered && mq.rows[1][1].covered);
  mq = apply(mg1, m.deleteCol(mg1, 1)); ok(mq); assert.equal(mq.cols.length, 2); assert.ok(!mq.rows[0][0].colSpan && mq.rows[0][0].rowSpan === 2);
  mq = apply(mg1, m.deleteCol(mg1, 0)); ok(mq); assert.ok(!mq.rows[0][0].covered && mq.rows[0][0].rowSpan === 2 && !mq.rows[0][0].colSpan);
  // every row/column operation on a merged table keeps a valid grid whose spans stay inside it
  for (let n = 0; n < 40; n++) {
    let w = mt(4, 4); w = { ...w, rows: m.mergeCells(w.rows, { r1: n % 3, c1: (n >> 1) % 3, r2: (n % 3) + 1, c2: ((n >> 1) % 3) + 1 }).rows };
    for (const op of [m.insertRow(w, n % 5), m.deleteRow(w, n % 4), m.insertCol(w, n % 5), m.deleteCol(w, n % 4)]) {
      const o = apply(w, op); ok(o, 'valid after op ' + n);
      o.rows.forEach((row, r) => row.forEach((c, j) => { if (!c.covered) { assert.ok(r + (c.rowSpan ?? 1) <= o.rows.length && j + (c.colSpan ?? 1) <= o.cols.length, 'span inside grid'); } }));
      // every covered cell belongs to exactly one anchor block
      o.rows.forEach((row, r) => row.forEach((c, j) => { if (c.covered) { const k = m.rectOf(o.rows, r, j); assert.ok(!o.rows[k.r1][k.c1].covered && (k.r1 !== r || k.c1 !== j), 'covered cell has an anchor'); } }));
    }
  }
  // paste keeps the merge structure
  const mpg = m.pasteGrid({ ...mg1, x: mg1.x }, 0, 0, [['x', 'y'], ['z', 'w']]); assert.equal(mpg.rows[0][0].rowSpan, 2); assert.ok(mpg.rows[1][1].covered);
  console.log('PASS table model: merge, unmerge, selection growth, row/column operations through merges');

  // ---- whole-table scaling ----
  const sbase = m.newTable(640, 360); const sfont = sbase.textStyle.fontSize;
  let ssc = m.scaleTable(sbase, sbase.w * 2);
  assert.equal(ssc.w, sbase.w * 2); assert.equal(ssc.fontSize, sfont * 2); assert.equal(ssc.padScale, 2); assert.equal(ssc.cols.reduce((a, b) => a + b, 0), ssc.w);
  ssc = m.scaleTable(sbase, sbase.w); assert.equal(ssc.fontSize, sfont); assert.equal(ssc.rows, sbase.rows, 'no change: same rows object');
  ssc = m.scaleTable(sbase, sbase.w / 2); assert.equal(ssc.fontSize, sfont / 2); assert.equal(ssc.padScale, 0.5);
  assert.ok(m.scaleTable(sbase, 10).fontSize >= m.TABLE_MIN_FONT && m.scaleTable(sbase, 10).w >= 3 * m.TABLE_MIN_COL, 'minimums hold');
  assert.ok(m.scaleTable(sbase, 1e6).fontSize <= m.TABLE_MAX_FONT, 'maximum text size holds');
  const ssized = { ...sbase, rows: sbase.rows.map((r, i) => (i ? r : r.map((c) => ({ ...c, doc: { type: 'doc', content: [{ type: 'paragraph', attrs: { fontSize: 20 } }] } })))) };
  assert.equal(m.scaleTable(ssized, ssized.w * 1.5).rows[0][0].doc.content[0].attrs.fontSize, 30, 'per-paragraph sizes scale too');
  assert.deepEqual(m.tablePad({}), { x: m.TABLE_CELL_PAD_X, y: m.TABLE_CELL_PAD_Y }); assert.equal(m.tablePad({ padScale: 2 }).y, 2 * m.TABLE_CELL_PAD_Y);
  console.log('PASS table model: whole-table scaling (columns, text, padding)');
} finally {
  await server.close();
}
