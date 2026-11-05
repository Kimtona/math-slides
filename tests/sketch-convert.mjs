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
  // ---- Placement inside the source image's frame (app) ----
  {
    const raw = await fixture('diagram-abc.ir.json');
    const { ir } = parseIR(raw, raw.image);
    const box = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h });
    // A full-image shape maps exactly onto the frame; the frame center maps to the IR center.
    const one = parseIR({ elements: [{ id: 's', kind: 'shape', shape: 'rect', bbox: { x: 0, y: 0, w: 1000, h: 1000 } }, { id: 'l', kind: 'line', bbox: { x: 500, y: 500, w: 0, h: 0 }, from: { x: 500, y: 500 }, to: { x: 500, y: 500 } }] }, { width: 800, height: 400 }).ir;
    const frame = { x: 600, y: 300, w: 400, h: 200 };
    const c1 = irToElements(one, frame);
    assert.deepEqual(box(c1.elements[0]), frame, 'full-image box = frame');
    assert.deepEqual([c1.elements[1].x1, c1.elements[1].y1], [800, 400], 'IR center = frame center');
    // Stretched image (frame aspect 4:1, image 2:1): x and y scale separately, like the picture.
    const c2 = irToElements(one, { x: 100, y: 100, w: 800, h: 200 });
    assert.deepEqual(box(c2.elements[0]), { x: 100, y: 100, w: 800, h: 200 }, 'stretched frame');
    assert.deepEqual([c2.elements[1].x1, c2.elements[1].y1], [500, 200], 'stretched center');

    // The diagram rebuilt in a frame in the lower-right part of the slide (beside other content).
    const f = { x: 560, y: 330, w: 680, h: 332 }; // 1636×798 image at 0.416 scale
    const c = irToElements(ir, f);
    const inF = (el, tol = 1) => el.x >= f.x - tol && el.y >= f.y - tol && el.x + el.w <= f.x + f.w + tol && el.y + el.h <= f.y + f.h + tol;
    assert.ok(c.elements.every((el) => inF(el)), 'every element inside the image frame: ' + JSON.stringify(c.elements.filter((el) => !inF(el)).map(box)));
    const shapes = c.elements.filter((e) => e.type === 'shape');
    assert.ok(shapes[0].x < shapes[1].x && shapes[1].x < shapes[2].x, 'left-to-right order kept in the frame');
    // Relative positions are the image's: circle A's left edge sits where it was drawn (6.7% of the width).
    assert.ok(Math.abs(shapes[0].x - (f.x + 0.067 * f.w)) <= 1, 'drawn position kept: ' + shapes[0].x);
    const arrows = c.elements.filter((e) => e.type === 'line' && e.arrowEnd);
    const [cA, cB, cC] = shapes;
    assert.ok(arrows[0].x1 >= cA.x + cA.w - 2 && arrows[0].x2 <= cB.x + 2, 'arrow A→B still attached to the outlines');
    assert.ok(arrows[1].x1 >= cB.x + cB.w - 2 && arrows[1].x2 <= cC.x + 2, 'arrow B→C still attached to the outlines');
    // Content-area mode (no frame, command-line tool) is unchanged by the frame option.
    assert.deepEqual(irToElements(ir).elements.map(box), irToElements(ir).elements.map(box));

    // Checks against the slide: overlap with an existing element and leaving the image area are reported.
    const title = { id: 'title', type: 'text', x: 64, y: 40, w: 1152, h: 68, doc: { type: 'doc', content: [] }, style: {} };
    const overlapping = { x: 0, y: 0, w: 1280, h: 400 };
    const rep = validateSketch(ir, irToElements(ir, overlapping), undefined, { frame: overlapping, others: [title] });
    assert.ok(rep.issues.some((i) => i.code === 'overlap-existing'), 'overlap with existing content reported');
    const clean = validateSketch(ir, c, undefined, { frame: f, others: [title] });
    assert.ok(!clean.issues.some((i) => i.code === 'overlap-existing' || i.code === 'frame'), 'frame below the title: no overlap, nothing outside ' + JSON.stringify(clean.issues));
    // Text that needs more room than a tiny frame: centered on the frame, reported, never moves other content.
    const note = parseIR({ elements: [{ id: 'n', kind: 'text', text: 'a long handwritten note here', bbox: { x: 0, y: 0, w: 1000, h: 1000 } }] }, { width: 100, height: 30 }).ir;
    const tiny = { x: 600, y: 600, w: 100, h: 30 };
    const cn = irToElements(note, tiny);
    const t = cn.elements[0];
    assert.ok(Math.abs(t.x + t.w / 2 - (tiny.x + tiny.w / 2)) <= 1, 'wide text centered on the frame');
    assert.ok(validateSketch(note, cn, undefined, { frame: tiny }).issues.some((i) => i.code === 'frame'), 'beyond the frame reported');
  }

  // ---- Local-model (Ollama) output format → IR (electron/sketch-local.cjs) ----
  {
    const { createRequire } = await import('node:module');
    const { localToModelIR, repairLatex, wrapInlineCommands } = createRequire(import.meta.url)(path.join(root, 'electron/sketch-local.cjs'));
    // Unescaped backslashes: JSON.parse made control characters; a leading real newline stays whitespace.
    assert.equal(repairLatex(JSON.parse('{"c":"\\nabla_\\theta \\frac{a}{b}"}').c.replace(/\\\\/g, '\\')), '\\nabla_\\theta \\frac{a}{b}');
    assert.equal(repairLatex('\nabla_\theta \frac{a}{b} \beta'.replace(/\\n/, '\n').replace(/\\t/, '\t').replace(/\\f/, '\f').replace(/\\b/, '\b')), '\\nabla_\\theta \\frac{a}{b} \\beta');
    assert.equal(repairLatex('\n\\nabla_{\\theta}J'), '\\nabla_{\\theta}J', 'real leading newline is whitespace');
    assert.equal(wrapInlineCommands('\\rightarrow 행동'), '$\\rightarrow$ 행동');
    const local = { elements: [
      { id: 'c1', type: 'circle', bbox_2d: [100, 100, 300, 300], content: 'A' },
      { id: 'a1', type: 'arrow', bbox_2d: [300, 190, 500, 210], content: '', points: [300, 200, 500, 200], connects: ['c1', 'c2'] },
      { id: 'c2', type: 'circle', bbox_2d: [500, 100, 700, 300], content: 'B' },
      { id: 'w1', type: 'text', bbox_2d: [100, 400, 140, 440], content: '이', color: 'red' },
      { id: 'w2', type: 'text', bbox_2d: [150, 402, 300, 442], content: 'action의', color: 'red' },
      { id: 'l2', type: 'text', bbox_2d: [100, 450, 400, 490], content: '확률을 어떻게 바꿀까', color: 'red', explains: 'm1' },
      { id: 'm1', type: 'math', bbox_2d: [100, 320, 700, 380], content: 'x^2' },
      { id: 'bad', type: 'table', bbox_2d: [0, 0, 1, 1], content: '' },
      { id: 'empty', type: 'text', bbox_2d: [0, 0, 10, 10], content: '' },
    ] };
    const r = localToModelIR(local, 800, 600);
    const byId = Object.fromEntries(r.elements.map((e) => [e.id, e]));
    assert.equal(byId.c1.kind, 'shape'); assert.equal(byId.c1.shape, 'ellipse'); assert.equal(byId.c1.text, 'A');
    assert.equal(byId.a1.fromId, 'c1'); assert.equal(byId.a1.toId, 'c2');
    assert.equal(byId.w1.text, '이 action의\n확률을 어떻게 바꿀까', 'same-line words joined, then stacked line merged');
    assert.ok(!byId.w2 && !byId.l2, 'merged elements removed');
    assert.ok(byId.w1.review?.needed, 'Korean text from a local model is offered for review');
    assert.ok(byId.m1.review?.needed, 'equations from a local model are offered for review');
    assert.ok(!byId.bad && !byId.empty && r.notes.length >= 2, 'invalid/empty elements dropped with a note, not invented');
    assert.ok(Math.abs(byId.c1.bbox.x - 125) < 1e-9 && Math.abs(byId.c1.bbox.w - 250) < 1e-9, 'pixels → 0..1000');
    // Regression (GUI run on a wide 1437×559 image): two notes on one line, far apart, must NOT be joined.
    const wide = localToModelIR({ elements: [
      { id: 'n1', type: 'text', bbox_2d: [465, 325, 778, 383], content: '그 action의', color: 'red' },
      { id: 'n2', type: 'text', bbox_2d: [935, 293, 1130, 390], content: '이 action의', color: 'red' },
    ] }, 1437, 559);
    assert.deepEqual(wide.elements.map((e) => e.text), ['그 action의', '이 action의'], 'separate notes on one line stay separate');
    // Regression (real GUI run, frame placement): notes from the real model output in the image's frame on the
    // slide must not be pushed onto each other at the frame edge.
    const real = localToModelIR({ elements: [
      { id: 't1', type: 'title', bbox_2d: [28, 55, 470, 150], content: '[policy gradient]', color: 'blue' },
      { id: 't3', type: 'text', bbox_2d: [465, 325, 778, 383], content: '그 action의', color: 'red' },
      { id: 't4', type: 'text', bbox_2d: [465, 395, 778, 455], content: '일관나중있다', color: 'red' },
      { id: 't5', type: 'text', bbox_2d: [935, 293, 1130, 390], content: '이 action의', color: 'red' },
      { id: 't6', type: 'text', bbox_2d: [935, 395, 1373, 455], content: '확률은 어떻게 바꿀까', color: 'red' },
      { id: 't7', type: 'text', bbox_2d: [868, 490, 1426, 560], content: '→ 행동확률의 gradient', color: 'red' },
    ] }, 1437, 559);
    const realIR = parseIR(real, { width: 1437, height: 559 }).ir;
    const realFrame = { x: 100, y: 200, w: 1080, h: 420 };
    const realConv = irToElements(realIR, realFrame);
    const realRep = validateSketch(realIR, realConv, undefined, { frame: realFrame });
    assert.ok(realConv.issues.some((i) => i.code === 'fit'), 'a note that does not fit gets a smaller font (instead of moving)');
    assert.ok(!realRep.issues.some((i) => i.code === 'overlap' || i.code === 'frame'), 'notes stay in place without overlapping: ' + JSON.stringify(realRep.issues.filter((i) => i.severity !== 'info')));
    const { ir, issues } = parseIR(r, { width: 800, height: 600 });
    assert.deepEqual(issues, [], 'local output converts to a valid IR');
    assert.equal(validateSketch(ir, irToElements(ir)).counts.error, 0);
  }
  // ---- LaTeX: delimiters, inline math in sentences, long equations, and verbatim preservation ----
  {
    const { inlineNodes, textToSketchDoc } = await server.ssrLoadModule('/src/sketch/convert.ts');
    const { stripMathDelimiters } = await server.ssrLoadModule('/src/sketch/ir.ts');
    const { renderTex } = await server.ssrLoadModule('/src/math/mathjax.ts');
    const { createRequire } = await import('node:module');
    const { wrapInlineCommands, localToModelIR } = createRequire(import.meta.url)(path.join(root, 'electron/sketch-local.cjs'));
    const CASES = ['\\nabla_\\theta', '\\mathbb{E}', '\\pi_{\\theta}', '\\epsilon', 'A_t', '\\frac{a}{b}', '\\left[ x \\right]',
      '\\nabla_\\theta J(\\theta) = \\mathbb{E}_{\\pi_\\theta}\\left[ \\frac{a}{b} A_t \\right]'];
    for (const tex of CASES) assert.ok(!renderTex(tex, false).error && !renderTex(tex, true).error, 'MathJax renders ' + tex);

    // Every inline delimiter becomes a mathInline node with the LaTeX byte for byte; text around it stays text.
    const kinds = (nodes) => nodes.map((n) => n.type === 'text' ? 'T' : 'M:' + n.attrs.latex);
    assert.deepEqual(kinds(inlineNodes('where \\(\\pi_{\\theta}\\) and $A_t$ and $$\\epsilon$$ and \\[\\frac{a}{b}\\] end')),
      ['T', 'M:\\pi_{\\theta}', 'T', 'M:A_t', 'T', 'M:\\epsilon', 'T', 'M:\\frac{a}{b}', 'T']);
    assert.deepEqual(kinds(inlineNodes('price is 5\\$ and \\(unclosed')), ['T'], 'unbalanced delimiters stay literal');
    // Inline math inside a sentence: the note keeps its words and gets real equations, no stray backslashes.
    const sentence = textToSketchDoc('The gradient \\(\\nabla_\\theta J(\\theta)\\) uses \\(\\mathbb{E}\\left[ A_t \\right]\\) with \\(\\epsilon\\).');
    const flat = JSON.stringify(sentence);
    assert.ok(!/"text":"[^"]*\\\\[(\\[]/.test(flat), 'no delimiter left in text: ' + flat);
    assert.equal(sentence.content[0].content.filter((n) => n.type === 'mathInline').length, 3);

    // Commands are wrapped only OUTSIDE existing math (regression: \(\pi_{\theta}\) became \($\pi$_{$\theta$}\)).
    assert.equal(wrapInlineCommands('where \\(\\pi_{\\theta}\\) and \\rightarrow x'), 'where \\(\\pi_{\\theta}\\) and $\\rightarrow$ x');
    assert.equal(wrapInlineCommands('$\\epsilon$ ok'), '$\\epsilon$ ok');
    // Display-math delimiters are removed, content (incl. a plain leading parenthesis) is not.
    assert.equal(stripMathDelimiters('\\\\(J_{PPO}(\\theta) = 1,'), 'J_{PPO}(\\theta) = 1,', 'mis-escaped \\\\( from the PPO run');
    assert.equal(stripMathDelimiters('\\[ \\frac{a}{b} \\]'), '\\frac{a}{b}');
    assert.equal(stripMathDelimiters('$$x^2$$'), 'x^2');
    assert.equal(stripMathDelimiters('(a+b)^2'), '(a+b)^2', 'a real parenthesis is content');

    // JSON round trip (save/load): every string survives exactly.
    const ir0 = parseIR({ elements: CASES.map((tex, i) => ({ id: 'm' + i, kind: 'math', latex: tex, bbox: { x: 0, y: i * 110, w: 900, h: 100 } })) }, { width: 1000, height: 1000 }).ir;
    const conv0 = irToElements(ir0);
    const back = JSON.parse(JSON.stringify(conv0.elements));
    assert.deepEqual(back.map((e) => e.doc.content[0].attrs.latex), CASES, 'LaTeX unchanged through conversion and JSON');

    // The real PPO model output (fixture) in an image frame on the slide.
    const fx = await fixture('ppo-grpo.local.json');
    const local = localToModelIR(fx.localOutput, fx.sentImage.width, fx.sentImage.height);
    const pIR = parseIR(local, fx.sentImage).ir;
    const frame = { x: 100, y: 200, w: 1080, h: 406 };
    const pc = irToElements(pIR, frame);
    const tol = 2;
    for (const el of pc.elements) assert.ok(el.x >= frame.x - tol && el.x + el.w <= frame.x + frame.w + tol, 'inside the image width: ' + JSON.stringify([el.x, el.w]));
    const docs = JSON.stringify(pc.elements.map((e) => e.doc));
    assert.ok(!docs.includes('\\\\(') && !docs.includes('$\\\\pi$'), 'no delimiter or double-wrapped math left in the text');
    const inl = pc.elements.flatMap((e) => (e.doc?.content ?? []).flatMap((p) => p.content ?? [])).filter((n) => n.type === 'mathInline').map((n) => n.attrs.latex);
    assert.deepEqual(inl, ['\\pi_{\\theta}', '\\pi_{\\theta_{old}}', 'q, o', '\\pi_{\\theta_{old}}', '\\varepsilon', 'A_t'], 'the paper sentence’s inline math');
    const block = pc.elements.find((e) => e.doc?.content?.[0]?.type === 'mathBlock').doc.content[0].attrs.latex;
    assert.ok(block.startsWith('J_{PPO}(\\theta) = \\mathbb{E}[q') && block.endsWith('A_t \\right],'), 'display LaTeX = model output minus the stray \\\\( delimiter');
    const rep = validateSketch(pIR, pc, undefined, { frame });
    assert.equal(rep.counts.error + rep.counts.warning, 0, 'no errors/warnings: ' + JSON.stringify(rep.issues.filter((i) => i.severity !== 'info')));

    // A long display equation in a small frame is scaled to the frame width, LaTeX unchanged.
    const eqOf = (n) => Array.from({ length: n }, (_, i) => `\\frac{\\pi_{\\theta}(o_${i})}{\\pi_{old}(o_${i})}`).join(' + ');
    const placeEq = (tex, lf) => irToElements(parseIR({ elements: [{ id: 'L', kind: 'math', latex: tex, bbox: { x: 0, y: 0, w: 1000, h: 1000 } }] }, { width: lf.w, height: lf.h }).ir, lf);
    const lf = { x: 700, y: 100, w: 400, h: 100 };
    const longTex = eqOf(5);
    const lc = placeEq(longTex, lf), lel = lc.elements[0];
    assert.ok(lel.x >= lf.x - 1 && lel.x + lel.w <= lf.x + lf.w + 1, 'long equation fits the frame: ' + JSON.stringify([lel.x, lel.w, lel.style.fontSize]));
    assert.ok(lc.issues.some((i) => i.code === 'fit'), 'scaling is reported');
    assert.equal(lel.doc.content[0].attrs.latex, longTex, 'and its LaTeX is unchanged');
    // Too long even at the smallest size: it may use more than the frame but never leaves the slide, and it is reported.
    const xc = placeEq(eqOf(12), lf), xel = xc.elements[0];
    assert.ok(xel.x >= 0 && xel.x + xel.w <= SLIDE_W, 'never beyond the slide: ' + JSON.stringify([xel.x, xel.w]));
    const xIR = parseIR({ elements: [{ id: 'L', kind: 'math', latex: eqOf(12), bbox: { x: 0, y: 0, w: 1000, h: 1000 } }] }, { width: lf.w, height: lf.h }).ir;
    assert.ok(validateSketch(xIR, xc, undefined, { frame: lf }).issues.some((i) => i.code === 'frame'), 'leaving the image area is reported');
  }
  // ---- Ink measurements from pixels (highlighter color/width, bends) and the FullDuplex sketch ----
  {
    const { measureOutline, measureBulge, applyInkMeasurements } = await server.ssrLoadModule('/src/sketch/ink.ts');
    const W = 600, H = 400;
    const blank = () => { const data = new Uint8Array(W * H * 4); for (let i = 0; i < data.length; i += 4) { data[i] = 238; data[i + 1] = 238; data[i + 2] = 234; data[i + 3] = 255; } return { data, width: W, height: H }; };
    const dot = (img, x, y, rgb, r = 0) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xi = Math.round(x + dx), yi = Math.round(y + dy); if (xi < 0 || yi < 0 || xi >= W || yi >= H) continue; const i = (yi * W + xi) * 4; img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; } };
    const ring = (img, cx, cy, a, b, thick, rgb) => { for (let t = 0; t < 2 * Math.PI; t += 0.002) for (let s = -thick / 2; s <= thick / 2; s += 0.5) dot(img, cx + (a + s) * Math.cos(t), cy + (b + s) * Math.sin(t), rgb); };
    const N = (x, y) => ({ x: (x / W) * 1000, y: (y / H) * 1000 });
    const box = (x, y, w, h) => ({ x: (x / W) * 1000, y: (y / H) * 1000, w: (w / W) * 1000, h: (h / H) * 1000 });
    const LIME = [190, 204, 106], INKC = [30, 30, 30];

    // Thick lime loop: measured color ≈ lime, thickness ≈ 12 px, recognized as a highlighter.
    const img = blank(); ring(img, 200, 200, 120, 70, 12, LIME); ring(img, 450, 200, 60, 60, 2, INKC);
    const hl = { id: 'h', kind: 'shape', shape: 'ellipse', color: 'green', bbox: box(80, 130, 240, 140) };
    const m = measureOutline(hl, img);
    // Color = the stroke's core, white-balanced against the paper (238,238,234 here): 190·255/238, 204·255/238, 106·255/234.
    const wbHex = '#' + [190 * 255 / 238, 204 * 255 / 238, 106 * 255 / 234].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
    assert.ok(m && m.colorHex === wbHex && Math.abs(m.width - 12) <= 3, 'lime highlighter measured: ' + JSON.stringify(m) + ' expected ' + wbHex);
    // A thin black circle has no colored stroke → nothing measured, nothing changed.
    assert.equal(measureOutline({ id: 'c', kind: 'shape', shape: 'ellipse', bbox: box(390, 140, 120, 120) }, img), null, 'black outline: no color invented');
    const applied = applyInkMeasurements({ version: 1, image: { width: W, height: H }, elements: [hl, { id: 'c', kind: 'shape', shape: 'ellipse', bbox: box(390, 140, 120, 120) }] }, img);
    const [ah, ac] = applied.ir.elements;
    assert.equal(ah.pen, 'highlighter'); assert.equal(ah.colorHex, wbHex);
    assert.ok(!ac.colorHex && !ac.pen, 'untouched without a measurement');

    // Bent stroke: the bulge is found and the arrow becomes a curve; a straight stroke whose model endpoints are a few
    // pixels off is NOT turned into a curve; a model-given control point is never replaced.
    const arc = blank(); for (let t = 0; t <= 1; t += 0.001) { const x = (1 - t) ** 2 * 100 + 2 * (1 - t) * t * 300 + t ** 2 * 500, y = (1 - t) ** 2 * 300 + 2 * (1 - t) * t * 120 + t ** 2 * 300; dot(arc, x, y, INKC, 1); }
    assert.ok(measureBulge({ id: 'a', kind: 'arrow', from: N(100, 300), to: N(500, 300), bbox: box(100, 200, 400, 100) }, arc), 'bend found');
    const straight = blank(); for (let x = 100; x <= 500; x++) dot(straight, x, 300, INKC, 1);
    assert.equal(measureBulge({ id: 's', kind: 'arrow', from: N(100, 308), to: N(500, 306), bbox: box(100, 290, 400, 20) }, straight), null, 'endpoints slightly off a straight stroke: still straight');
    const keep = applyInkMeasurements({ version: 1, image: { width: W, height: H }, elements: [
      { id: 'a', kind: 'arrow', from: N(100, 300), to: N(500, 300), bbox: box(100, 200, 400, 100) },
      { id: 'b', kind: 'curvedArrow', from: N(100, 300), to: N(500, 300), control: N(300, 380), bbox: box(100, 200, 400, 100) },
    ] }, arc).ir.elements;
    assert.equal(keep[0].kind, 'curvedArrow'); assert.ok(keep[0].control.y < N(0, 300).y, 'bulges up like the ink');
    assert.deepEqual(keep[1].control, N(300, 380), "the model's control point is kept");

    // Local format: pen + explains on a highlight loop survive (FullDuplex: explains was dropped for shapes).
    const { createRequire } = await import('node:module');
    const { localToModelIR } = createRequire(import.meta.url)(path.join(root, 'electron/sketch-local.cjs'));
    const loc = localToModelIR({ elements: [
      { id: 'e1', type: 'text', bbox_2d: [928, 85, 1116, 182], content: '말하기' },
      { id: 'e7', type: 'circle', bbox_2d: [845, 35, 1206, 198], content: '', color: 'green', explains: 'e1', pen: 'highlighter' },
    ] }, 1252, 641);
    const e7 = loc.elements.find((e) => e.id === 'e7');
    assert.equal(e7.pen, 'highlighter'); assert.deepEqual(e7.relations, [{ type: 'annotates', target: 'e1' }]);

    // A highlighter around a word without `explains` (real model run): still an intended overlap.
    const hlIR = parseIR({ elements: [
      { id: 't', kind: 'text', text: '말하기', bbox: { x: 400, y: 400, w: 200, h: 100 } },
      { id: 'h', kind: 'shape', shape: 'ellipse', pen: 'highlighter', bbox: { x: 350, y: 350, w: 300, h: 200 } },
    ] }, { width: 1000, height: 1000 }).ir;
    assert.ok(!validateSketch(hlIR, irToElements(hlIR)).issues.some((i) => i.code === 'overlap'), 'highlighter overlap is intended');
    // FullDuplex, hand-written correct IR → elements.
    const raw = await fixture('fullduplex.ir.json');
    const { ir: fIR, issues: fIssues } = parseIR(raw, raw.image);
    assert.deepEqual(fIssues, []);
    const frame = { x: 100, y: 200, w: 1000, h: 512 };
    const fc = irToElements(fIR, frame);
    const shapes = fc.elements.filter((e) => e.type === 'shape');
    assert.ok(shapes.every((s) => s.stroke === '#BFCC6A' && s.strokeWidth >= 6 && s.fill === null), 'highlighters: measured lime, thick: ' + JSON.stringify(shapes.map((s) => [s.stroke, s.strokeWidth])));
    const lines = fc.elements.filter((e) => e.type === 'line');
    assert.equal(lines.filter((l) => l.cx !== undefined).length, 2, 'two curved arrows keep their control points');
    assert.equal(lines.filter((l) => l.cx === undefined).length, 1, 'the straight arrow stays straight');
    assert.ok(fc.elements.findIndex((e) => e.type === 'shape') < fc.elements.findIndex((e) => e.type === 'text'), 'highlighters under the text');
    const fRep = validateSketch(fIR, fc, undefined, { frame });
    assert.ok(!fRep.issues.some((i) => i.code === 'overlap'), 'a highlight around its word is not an overlap: ' + JSON.stringify(fRep.issues.filter((i) => i.code === 'overlap')));
    const saved = JSON.parse(JSON.stringify(fc.elements));
    assert.deepEqual(saved.filter((e) => e.type === 'line').map((l) => [l.cx, l.cy]), lines.map((l) => [l.cx, l.cy]), 'control points survive JSON (save/reopen)');
  }
  console.log('sketch-convert: all checks passed');
} finally {
  await server.close();
}
