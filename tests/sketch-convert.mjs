/** Sketch-to-Slides: IR parsing, conversion and deterministic validation (headless, no AI, no Electron).
 * Runs through Vite's SSR loader like current-slide.mjs. Run: node tests/sketch-convert.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = async (name) => JSON.parse(await readFile(path.join(root, 'tests/fixtures/sketch', name), 'utf8'));
const server = await createServer({ root, configLoader: 'runner', cacheDir: await mkdtemp(path.join(tmpdir(), 'mathslides-vite-')), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { parseIR, applyPatches } = await server.ssrLoadModule('/src/sketch/ir.ts');
  const { irToElements, boundaryPoint } = await server.ssrLoadModule('/src/sketch/convert.ts');
  const { validateSketch } = await server.ssrLoadModule('/src/sketch/validate.ts');
  const { SLIDE_W, SLIDE_H } = await server.ssrLoadModule('/src/model/types.ts');

  const run = async (name) => {
    const raw = await fixture(name);
    const { ir, issues } = parseIR(raw, raw.image);
    assert.deepEqual(issues, [], `${name}: fixture parses cleanly`);
    const conv = irToElements(ir);
    return { ir, conv, report: validateSketch(ir, conv) };
  };
  const inSlide = (el) => el.x >= 0 && el.y >= 0 && el.x + el.w <= SLIDE_W && el.y + el.h <= SLIDE_H;
  const plain = (doc) => JSON.stringify(doc);

  // ---- Example A: (A) → (B) → (C) with an annotation under the second arrow ----
  {
    const { conv, report } = await run('diagram-abc.ir.json');
    const shapes = conv.elements.filter((e) => e.type === 'shape');
    const lines = conv.elements.filter((e) => e.type === 'line');
    const texts = conv.elements.filter((e) => e.type === 'text');
    assert.equal(shapes.length, 3, 'A: three shapes');
    assert.ok(shapes.every((s) => s.shape === 'ellipse' && s.fill === null && s.stroke), 'A: outlined ellipses');
    assert.deepEqual(shapes.map((s) => plain(s.doc).match(/"text":"(\w)"/)[1]), ['A', 'B', 'C'], 'A: labels live inside their circles');
    assert.equal(lines.filter((l) => l.arrowEnd).length, 2, 'A: two arrows');
    assert.equal(lines.filter((l) => !l.arrowEnd).length, 1, 'A: one plain annotation line');
    assert.equal(texts.length, 1, 'A: one free text (the annotation)');
    assert.ok(plain(texts[0].doc).includes('중요'), 'A: annotation text kept verbatim');
    assert.ok(conv.elements.every(inSlide), 'A: everything on the slide');
    // Arrow 1 starts on circle A's outline and ends on circle B's outline (left of B, right of A).
    const [cA, cB] = shapes;
    const a1 = lines.find((l) => l.arrowEnd && l.x1 < cB.x);
    assert.ok(a1.x1 >= cA.x + cA.w - 2 && a1.x2 <= cB.x + 2, 'A: arrow 1 connects A to B outlines');
    // Relative layout: A left of B left of C, and the annotation below the circles.
    assert.ok(shapes[0].x < shapes[1].x && shapes[1].x < shapes[2].x, 'A: left-to-right order kept');
    assert.ok(texts[0].y > Math.max(...shapes.map((s) => s.y + s.h)), 'A: annotation stays below');
    assert.equal(report.counts.error, 0, 'A: no validation errors ' + JSON.stringify(report.issues));
    assert.equal(report.issues.filter((i) => i.code === 'overlap').length, 0, 'A: no unintended overlaps');
  }

  // ---- Example B: policy gradient equation with red annotations ----
  {
    const { conv, report } = await run('policy-gradient.ir.json');
    const texts = conv.elements.filter((e) => e.type === 'text');
    const math = texts.filter((t) => t.doc.content[0].type === 'mathBlock');
    assert.equal(math.length, 1, 'B: one block equation');
    assert.ok(math[0].doc.content[0].attrs.latex.includes('\\nabla_\\theta J(\\theta)'), 'B: LaTeX kept, not an image');
    const title = texts.find((t) => plain(t.doc).includes('policy gradient'));
    assert.equal(title.style.color.toLowerCase(), '#1f77b4', 'B: blue title ink kept');
    assert.ok(title.style.fontSize >= 32, 'B: title is title-sized');
    const notes = texts.filter((t) => t.style.color.toUpperCase() === '#D62728');
    assert.equal(notes.length, 3, 'B: three red annotations');
    assert.ok(notes.every((n) => n.y > math[0].y), 'B: annotations below the equation');
    assert.ok(title.y < math[0].y, 'B: title above the equation');
    assert.ok(conv.elements.every(inSlide), 'B: everything on the slide');
    assert.equal(report.counts.error, 0, 'B: no validation errors ' + JSON.stringify(report.issues));
  }

  // ---- Robustness: invalid model output is reported, never silently accepted ----
  {
    const { ir, issues } = parseIR({
      elements: [
        { id: 'x', kind: 'table', bbox: { x: 0, y: 0, w: 10, h: 10 } },
        { id: 'm', kind: 'math', bbox: { x: 0, y: 0, w: 10, h: 10 } },
        { id: 't', kind: 'text', text: 'hi', bbox: { x: -50, y: 990, w: 2000, h: 50 }, relations: [{ type: 'inside', target: 'ghost' }] },
        { id: 'a', kind: 'arrow', bbox: { x: 100, y: 100, w: 200, h: 10 }, toId: 'ghost' },
      ],
    }, { width: 800, height: 600 });
    assert.deepEqual(ir.elements.map((e) => e.id), ['t', 'a']);
    assert.ok(issues.some((i) => i.code === 'unsupported' && i.id === 'x'), 'unknown kind reported');
    assert.ok(issues.some((i) => i.id === 'm'), 'math without LaTeX reported');
    assert.ok(issues.some((i) => i.code === 'reference'), 'dangling references reported');
    const t = ir.elements[0];
    assert.ok(t.bbox.x === 0 && t.bbox.y + t.bbox.h <= 1000 && t.bbox.x + t.bbox.w <= 1000, 'coordinates clamped');
    assert.ok(ir.elements[1].from && ir.elements[1].to, 'arrow endpoints derived from bbox');

    // A LaTeX error is a validation error (the equation is kept for the user to fix, not dropped).
    const bad = parseIR({ elements: [{ id: 'eq', kind: 'math', latex: '\\frac{a', bbox: { x: 100, y: 100, w: 500, h: 100 } }] }, { width: 1000, height: 1000 }).ir;
    const rep = validateSketch(bad, irToElements(bad));
    assert.ok(rep.issues.some((i) => i.code === 'latex' && i.severity === 'error'), 'broken LaTeX reported');

    // Unrelated overlapping text is a warning; the same overlap with an "annotates" relation is not.
    const two = (rel) => parseIR({ elements: [
      { id: 'p', kind: 'text', text: 'first text', bbox: { x: 100, y: 100, w: 300, h: 60 } },
      { id: 'q', kind: 'text', text: 'second text', bbox: { x: 120, y: 110, w: 300, h: 60 }, ...(rel ? { relations: [{ type: 'annotates', target: 'p' }] } : {}) },
    ] }, { width: 1000, height: 1000 }).ir;
    assert.ok(validateSketch(two(false), irToElements(two(false))).issues.some((i) => i.code === 'overlap'), 'overlap reported');
    assert.ok(!validateSketch(two(true), irToElements(two(true))).issues.some((i) => i.code === 'overlap'), 'intended overlap allowed');

    // Review patches: update + remove + add, re-validated.
    const patched = applyPatches(ir, [
      { op: 'update', id: 't', element: { text: 'hello' }, reason: 'misread' },
      { op: 'remove', id: 'a', reason: 'not drawn' },
      { op: 'add', id: 'n', element: { kind: 'text', text: 'new', bbox: { x: 0, y: 0, w: 50, h: 50 } }, reason: 'missing' },
    ]);
    assert.deepEqual(patched.ir.elements.map((e) => [e.id, e.text]), [['t', 'hello'], ['n', 'new']]);

    // Boundary point lies on the ellipse outline (plus the gap).
    const p = boundaryPoint({ shape: 'ellipse', x: 0, y: 0, w: 200, h: 100 }, { x: 500, y: 50 });
    assert.ok(Math.abs(p.x - 204) < 0.01 && Math.abs(p.y - 50) < 0.01, 'ellipse boundary point');
  }
  console.log('sketch-convert: all checks passed');
} finally {
  await server.close();
}
