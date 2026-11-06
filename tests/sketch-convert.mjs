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
        { id: 'x', kind: 'chart', bbox: { x: 0, y: 0, w: 10, h: 10 } }, // (table is a supported kind now)
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
  // ---- Structure: tables, formatted text, lists, headings, quotes (src/sketch + electron/sketch-markup.cjs) ----
  {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const M = req(path.join(root, 'electron/sketch-markup.cjs'));
    const { localToModelIR } = req(path.join(root, 'electron/sketch-local.cjs'));
    const { tableProblems } = await server.ssrLoadModule('/src/model/table.ts');
    const toIR = (raw, w = 1000, h = 1000) => parseIR(raw, { width: w, height: h });
    const kindsOf = (els) => els.map((e) => e.type);
    const flatText = (doc) => { const out = []; const walk = (n) => { if (n.text) out.push(n.text); n.content?.forEach(walk); }; walk(doc); return out.join(''); };

    // -- inline markers → spans (never characters); math and literals protected
    assert.deepEqual(M.parseInline('a **b** *c* ~~d~~ e'), [{ text: 'a ' }, { text: 'b', bold: true }, { text: ' ' }, { text: 'c', italic: true }, { text: ' ' }, { text: 'd', strike: true }, { text: ' e' }]);
    assert.deepEqual(M.parseInline('***x***'), [{ text: 'x', bold: true, italic: true }]);
    assert.deepEqual(M.parseInline('$a*b*c$ and **d**'), [{ text: '$a*b*c$ and ' }, { text: 'd', bold: true }], 'markers inside $…$ are not formatting');
    assert.deepEqual(M.parseInline('2 * 3 * 4 and **open'), [{ text: '2 * 3 * 4 and **open' }], 'lone/unbalanced markers stay literal');
    // -- lines → blocks
    const blocks = M.markupToBlocks('# Title\nplain **bold** text\n- one\n- two\n1. first\n2. second\n> quoted');
    assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'bullet', 'ordered', 'quote']);
    assert.equal(blocks[0].level, 1); assert.equal(blocks[2].items.length, 2); assert.equal(blocks[3].items.length, 2);
    assert.equal(M.markupToBlocks('just a plain note\nwith two lines'), null, 'plain notes stay plain (unchanged behavior)');
    assert.equal(M.blocksPlain(blocks), 'Title\nplain bold text\none\ntwo\nfirst\nsecond\nquoted');
    assert.deepEqual(M.parseMarkdownTable('| A | B |\n|---|---|\n| 1 | 2 |'), [['A', 'B'], ['1', '2']]);
    assert.equal(M.parseMarkdownTable('just | one line'), null);

    // -- untrusted model structure: defaults, repair, safe fallbacks
    const issues0 = [];
    const bad = toIR({ elements: [
      { id: 't1', kind: 'table', bbox: { x: 0, y: 0, w: 500, h: 300 }, table: { rows: [['a', 'b', 'c'], ['d'], 'oops', [['x']]] } },          // ragged, junk row, string cells
      { id: 't2', kind: 'table', bbox: { x: 0, y: 400, w: 500, h: 100 }, table: { rows: [] }, text: 'kept words' },                              // no rows but text → note
      { id: 't3', kind: 'table', bbox: { x: 0, y: 600, w: 500, h: 100 }, table: 7 },                                                             // nothing usable → dropped
      { id: 'b1', kind: 'text', bbox: { x: 0, y: 700, w: 500, h: 100 }, blocks: [
        { type: 'heading', level: 99, spans: [{ text: 'H', bold: 'yes', italic: true, evil: 1 }] }, { type: 'nonsense', spans: [{ text: 'p' }] },
        { type: 'bullet', items: [[{ text: 'i1' }], 'i2', [], null] }, 5, { type: 'quote', spans: [] }] },
    ] }, 1000, 1000);
    const byId = Object.fromEntries(bad.ir.elements.map((e) => [e.id, e]));
    assert.equal(byId.t1.kind, 'table'); assert.ok(byId.t1.table.rows.every((r) => r.length === 3), 'ragged rows padded to a rectangle');
    assert.equal(byId.t1.table.header, false, 'header is never assumed');
    assert.ok(bad.issues.some((i) => i.code === 'table' && i.id === 't1'), 'padding is reported');
    assert.equal(byId.t2.kind, 'text'); assert.equal(byId.t2.text, 'kept words'); assert.ok(bad.issues.some((i) => i.id === 't2' && i.code === 'table'));
    assert.ok(!byId.t3, 'a table with nothing usable is dropped, not invented');
    assert.deepEqual(byId.b1.blocks.map((b) => b.type), ['heading', 'paragraph', 'bullet'], 'invalid blocks dropped, unknown type kept as paragraph');
    assert.equal(byId.b1.blocks[0].level, 4, 'level clamped'); assert.deepEqual(byId.b1.blocks[0].spans, [{ text: 'H', italic: true }], 'only known boolean flags survive');
    assert.equal(byId.b1.blocks[2].items.length, 2);
    const huge = toIR({ elements: [{ id: 'h', kind: 'table', bbox: { x: 0, y: 0, w: 900, h: 900 }, table: { rows: Array.from({ length: 100 }, () => Array.from({ length: 30 }, () => 'x')) } }] });
    assert.ok(huge.ir.elements[0].table.rows.length <= 40 && huge.ir.elements[0].table.rows[0].length <= 12 && huge.issues.some((i) => i.code === 'table'), 'oversized tables are cut and reported');

    // -- table → the editor's own TableElement (6 × 2 like the AI-model screenshot), header bold, cell docs are plain rich text
    const cells = [['항목', '제출 내용'], ['AI 모델', 'Ollama + Qwen2.5-VL 7B'], ['Coding Agent', 'Claude Code'], ['Skills', '실제 사용한 skill 파일이 있다면 포함'], ['MCP', '실제 사용한 MCP 서버와 설정이 있다면 명시'], ['Prompts', 'Claude Code 작업 지시 및 주요 반복 개선 기록']];
    const tIR = toIR({ elements: [{ id: 'T', kind: 'table', bbox: { x: 20, y: 40, w: 960, h: 880 }, table: { header: true, rows: cells.map((r, i) => r.map((t) => [{ text: t, ...(i === 0 ? { bold: true } : {}) }])) } }] }, 906, 446).ir;
    const frame = { x: 100, y: 200, w: 1000, h: 480 };
    const tc = irToElements(tIR, frame);
    assert.deepEqual(kindsOf(tc.elements), ['table'], 'one native table, no loose text');
    const T = tc.elements[0];
    assert.equal(T.rows.length, 6); assert.equal(T.cols.length, 2); assert.equal(T.headerRow, true);
    assert.equal(T.cols.reduce((a, b) => a + b, 0), T.w, 'column widths sum to the table width');
    assert.deepEqual(tableProblems(T), [], 'a valid table the table editor can open');
    assert.deepEqual(T.rows.map((r) => r.map((c) => flatText(c.doc))), cells, 'every cell text exact');
    assert.deepEqual(T.rows[0][0].doc.content[0].content[0].marks, [{ type: 'bold' }], 'header cells carry a real bold mark');
    assert.equal(T.rows[1][0].doc.content[0].content[0].marks, undefined);
    assert.ok(T.x >= frame.x - 1 && T.x + T.w <= frame.x + frame.w + 1, 'inside the image frame');
    assert.ok(!/\*\*|\||~~|<b>/.test(JSON.stringify(T.rows)), 'no Markdown/HTML characters in cells');
    assert.ok(validateSketch(tIR, tc, undefined, { frame }).counts.error === 0, 'no validation errors');
    const tjson = JSON.parse(JSON.stringify(tc.elements)); assert.deepEqual(tjson, JSON.parse(JSON.stringify(tc.elements)), 'JSON-safe');

    // -- formatted text → real marks, lists, heading size, blockquote; inline math kept
    const ft = toIR({ elements: [{ id: 'N', kind: 'text', bbox: { x: 30, y: 30, w: 700, h: 500 }, text: 'x', blocks: [
      { type: 'heading', level: 2, spans: [{ text: 'Project notes' }] },
      { type: 'paragraph', spans: [{ text: 'The ' }, { text: 'final model', bold: true }, { text: ' is ' }, { text: 'Qwen', italic: true }, { text: ', the ' }, { text: 'old baseline', strike: true }, { text: ' and $\\pi_\\theta$.' }] },
      { type: 'bullet', items: [[{ text: 'Run locally' }], [{ text: 'Check', bold: true }, { text: ' cells' }]] },
      { type: 'ordered', start: 1, items: [[{ text: 'Convert' }], [{ text: 'Review' }]] },
      { type: 'quote', spans: [{ text: 'Think on paper.' }] },
    ] }] }, 1000, 1000).ir;
    const fc = irToElements(ft, { x: 100, y: 100, w: 1000, h: 500 });
    const doc = fc.elements[0].doc, top = doc.content.map((n) => n.type);
    assert.deepEqual(top, ['paragraph', 'paragraph', 'bulletList', 'orderedList', 'blockquote'], 'native nodes: ' + top);
    assert.ok(doc.content[0].attrs.fontSize > fc.elements[0].style.fontSize, 'heading = paragraph with a larger fontSize (as "# " does)');
    const mk = (n) => (n.marks ?? []).map((m) => m.type);
    const para = doc.content[1].content;
    assert.deepEqual(para.filter((n) => n.type === 'text').map((n) => [n.text, mk(n).join('+')]).filter(([, m]) => m), [['final model', 'bold'], ['Qwen', 'italic'], ['old baseline', 'strike']]);
    assert.ok(para.some((n) => n.type === 'mathInline' && n.attrs.latex === '\\pi_\\theta'), 'inline math is the existing mathInline node');
    assert.deepEqual(doc.content[2].content.map((li) => li.type), ['listItem', 'listItem']); assert.equal(doc.content[3].attrs.start, 1);
    assert.deepEqual(doc.content[2].content[1].content[0].content[0].marks, [{ type: 'bold' }], 'bold inside a list item');
    assert.ok(!/(^|")\s*[-•*]\s|\*\*|~~|(^|")\d+\.\s/.test(JSON.stringify(doc).replace(/"type":"[^"]*"/g, '')), 'no Markdown symbols left as text');

    // -- the local adapter: a flat model answer (markers, rows, items) → the same structures
    const fmtLocal = await fixture('formatted-notes.local.json');
    const loc = localToModelIR(fmtLocal, 1504, 814);
    const lr = toIR(loc, 1504, 814); assert.deepEqual(lr.issues.filter((i) => i.severity !== 'info'), [], 'adapter output is a valid IR');
    const lc = irToElements(lr.ir, { x: 60, y: 60, w: 1100, h: 560 });
    assert.ok(lc.elements.some((e) => e.type === 'table'), 'table from "rows"');
    const lt = lc.elements.filter((e) => e.type === 'text').map((e) => e.doc.content.map((n) => n.type)).flat();
    assert.ok(['bulletList', 'orderedList', 'blockquote'].every((t) => lt.includes(t)), 'list / quote nodes from the flat format: ' + lt);

    // -- grid detection: the real baseline output (12 separate cell boxes) becomes ONE table; look-alikes do not
    const base = JSON.parse(await readFile(path.join(root, 'examples/structured/before/ai-table.ir.json'), 'utf8'));
    const baseIR = localToModelIR(base.localOutput, base.sentImage.width, base.sentImage.height);
    assert.deepEqual(baseIR.elements.map((e) => e.kind), ['table']);
    assert.equal(baseIR.elements[0].table.rows.length, 6); assert.equal(baseIR.elements[0].table.header, true, 'header = the model called the first row headings');
    assert.deepEqual(baseIR.elements[0].table.rows.map((r) => r.map((c) => c.map((sp) => sp.text).join(''))), cells, 'cells exact');
    // -- a REAL looping model answer (12 cells, then an empty "table" repeated until the token limit): finished elements are kept
    const looped = await fixture('ai-table.looped-raw.json');
    const OL = req(path.join(root, 'electron/sketch-ollama.cjs'));
    assert.ok(OL.isRepeating(looped.rawText), 'the loop is detected');
    assert.ok(!OL.isRepeating(base.rawText), 'a complete, normal answer is not flagged');
    const kept = OL.salvageElements(looped.rawText);
    assert.equal(kept.length, 13, 'complete elements kept once each (12 cells + the empty table)');
    const salvaged = localToModelIR({ elements: kept, _salvaged: { kept: kept.length, reason: 'the model started repeating itself' } }, looped.sentImage.width, looped.sentImage.height);
    assert.deepEqual(salvaged.elements.map((e) => e.kind), ['table'], 'the cells become ONE table; the empty table element is dropped, nothing is invented');
    assert.ok(salvaged.notes.some((n) => /cut off/.test(n)) && salvaged.notes.some((n) => /no rows/.test(n)), 'both are reported: ' + salvaged.notes);
    assert.equal(OL.salvageElements('{"elements":[{"id":"a","type":"text","content":"x"},{"id":"b","type":"te').length, 1, 'a half-written element is never completed');
    // -- REAL model output for the user's composite screenshot (test_composite.png): the model gave every table cell, list item
    //    and the display equation as plain `text`; structure has to be recovered from geometry (no hard-coded answer)
    const comp = await fixture('test-composite.real.json');
    const ci = localToModelIR(comp.localOutput, comp.sentImage.width, comp.sentImage.height);
    const tbls = ci.elements.filter((e) => e.kind === 'table');
    assert.equal(tbls.length, 1, 'composite: exactly one table');
    assert.deepEqual(tbls[0].table.rows.map((r) => r.map((c) => c.map((sp) => sp.text).join(''))),
      [['Component', 'Value'], ['Model', 'Qwen2.5-VL 7B'], ['Framework', 'Ollama'], ['Learning Rate', '0.001'], ['Batch Size', '32']], 'composite: 5×2 cells exact');
    const lists = ci.elements.filter((e) => e.blocks?.[0] && ['bullet', 'ordered'].includes(e.blocks[0].type));
    assert.deepEqual(lists.map((e) => [e.blocks[0].type, e.blocks[0].items.map((it) => it.map((sp) => sp.text).join(''))]),
      [['bullet', ['Extract text and equations', 'Reconstruct native tables', 'Preserve editable elements']], ['ordered', ['Upload screenshot', 'Run vision model', 'Edit generated slide']]], 'composite: one bullet list + one ordered list, 3 items each');
    const plainTexts = ci.elements.filter((e) => e.kind === 'text' && !e.blocks).map((e) => e.text);
    for (const h of ['1. Model Configuration', '2. Research Tasks', '3. Workflow', '4. Equations', '5. Conclusion']) assert.ok(plainTexts.includes(h), 'numbered section heading stays a plain line, not a list: ' + h);
    assert.ok(!plainTexts.some((t) => /Component|Qwen|Upload|Extract/.test(t)), 'no table cell / list item is left behind as a text box');
    assert.deepEqual(ci.elements.filter((e) => e.kind === 'math').map((e) => e.latex), ['L = \\frac{1}{N} \\sum_{i=1}^{N} (y_i - \\hat{y}_i)^2'], 'display equation typed as text by the model is a math element');
    assert.ok(plainTexts.includes('Inline: $E = mc^2$'), 'trailing inline equation joins its sentence: ' + plainTexts);
    // negatives: look-alikes must not become a table / list
    const tx = (id, x, y, w, c) => ({ id, type: 'text', bbox_2d: [x, y, x + w, y + 20], content: c });
    const rowsOf = (els) => localToModelIR({ elements: els }, 1000, 1000).elements.map((e) => e.kind);
    assert.deepEqual(rowsOf(Array.from({ length: 6 }, (_, i) => tx('p' + i, 50, 100 + i * 30, 400 + (i % 3) * 20, 'paragraph line number ' + i))).includes('table'), false, 'stacked paragraph lines are not a table');
    assert.deepEqual(rowsOf([tx('a', 50, 100, 100, 'x1'), tx('b', 500, 100, 100, 'y1'), tx('c', 50, 130, 100, 'x2'), tx('d', 500, 130, 100, 'y2')]).includes('table'), false, 'two rows are not a table');
    assert.deepEqual(rowsOf([tx('a', 50, 100, 100, 'x1'), tx('b', 500, 100, 100, 'y1'), tx('c', 50, 130, 100, 'x2'), tx('d', 500, 130, 100, 'y2'), tx('e', 50, 160, 100, 'x3'), tx('f', 500, 160, 100, 'y3')]).includes('table'), true, 'three aligned rows of two cells are a table');
    assert.deepEqual(rowsOf([tx('a', 50, 100, 300, 'Intro line'), tx('b', 150, 140, 200, 'single indented line')]), ['text', 'text'], 'one indented line is not a list');
    assert.deepEqual(rowsOf([tx('a', 50, 100, 300, 'Intro line'), tx('b', 150, 140, 200, 'item one'), tx('c', 150, 200, 200, 'item two'), tx('d', 150, 330, 200, 'far away')]).filter((k) => k === 'text').length, 3, 'irregular spacing is not a list');
    // -- list items listed one element each (the real model's habit) become ONE list; look-alikes stay separate
    const real2 = await fixture('formatted-notes.real-run2.json');
    const r2 = localToModelIR(real2.localOutput, real2.sentImage.width, real2.sentImage.height);
    const types2 = r2.elements.map((e) => (e.blocks ? e.blocks[0].type : e.kind));
    assert.deepEqual(types2, ['text', 'text', 'ordered', 'quote'], 'real output: title, paragraph, ONE list, quote — ' + types2);
    assert.equal(r2.elements[2].blocks[0].items.length, 6, 'six items in one list');
    assert.ok(r2.elements[2].review?.needed && /bullets vs/.test(r2.elements[2].review.reason), 'bullets vs numbers is flagged for review (the model marked bullets as ordered)');
    const li = (id, y, x = 50, ordered = false, h = 30) => ({ id, type: 'list', ordered, bbox_2d: [x, y, x + 300, y + h], content: 'item ' + id });
    const kindsOfList = (els) => localToModelIR({ elements: els }, 1000, 1000).elements.map((e) => e.blocks?.[0]?.items?.length ?? 'x');
    assert.deepEqual(kindsOfList([li('a', 100), li('b', 140), li('c', 180)]), [3], 'stacked, aligned items → one list');
    assert.deepEqual(kindsOfList([li('a', 100), li('b', 400)]), [1, 1], 'a large vertical gap keeps them apart');
    assert.deepEqual(kindsOfList([li('a', 100), li('b', 140, 300)]), [1, 1], 'a different left edge keeps them apart');
    assert.deepEqual(kindsOfList([li('a', 100), li('b', 140, 50, true)]), [1, 1], 'bullet and numbered items are never mixed');
    // -- a REAL answer that repeated the whole run of cells: duplicates are dropped BEFORE grid detection (was a 6×4 table)
    const dup = await fixture('ai-table.duplicated.json');
    assert.equal(dup.localOutput.elements.length, 25, 'fixture: 12 cells + empty table + the 12 cells again');
    const dupIR = localToModelIR(dup.localOutput, dup.sentImage.width, dup.sentImage.height);
    assert.deepEqual(dupIR.elements.map((e) => e.kind), ['table']);
    assert.deepEqual([dupIR.elements[0].table.rows.length, dupIR.elements[0].table.rows[0].length], [6, 2], 'a 6×2 table, not 6×4');
    assert.ok(dupIR.notes.some((n) => /repeated element/.test(n)), 'the repetition is reported');
    const twice = (id) => [{ id, type: 'text', bbox_2d: [100, 100, 300, 130], content: 'Claude Code' }, { id: id + 'b', type: 'text', bbox_2d: [100, 400, 300, 430], content: 'Claude Code' }];
    assert.equal(localToModelIR({ elements: twice('x') }, 1000, 1000).elements.length, 2, 'the same words at another place are two elements');
    const mkText = (id, x, y, w, extra = {}) => ({ id, type: 'text', bbox_2d: [x, y, x + w, y + 30], content: id, ...extra });
    const grid = (rows, cols, jitter = {}) => ({ elements: Array.from({ length: rows * cols }, (_, i) => mkText('c' + i, 50 + (i % cols) * 400 + (jitter[i] ?? 0), 40 + Math.floor(i / cols) * 100, 150)) });
    assert.equal(localToModelIR(grid(4, 2), 1000, 600).elements.filter((e) => e.kind === 'table').length, 1, 'a clean 4×2 grid → table');
    assert.equal(localToModelIR(grid(2, 2), 1000, 600).elements.filter((e) => e.kind === 'table').length, 0, 'a 2×2 arrangement is not turned into a table');
    assert.equal(localToModelIR(grid(4, 2, { 3: 90 }), 1000, 600).elements.filter((e) => e.kind === 'table').length, 0, 'a misaligned column breaks it');
    const mixed = grid(4, 2); mixed.elements.push(mkText('note', 300, 500, 200, { explains: 'c0' }), mkText('n2', 60, 560, 300), mkText('n3', 70, 600, 100));
    const mixedIR = localToModelIR(mixed, 1000, 700).elements;
    assert.equal(mixedIR.filter((e) => e.kind === 'table').length, 1, 'a grid that is only PART of the page is still a table (region-based; the old 80%-of-the-page rule lost tables on composite screenshots)');
    assert.deepEqual(mixedIR.filter((e) => e.kind !== 'table').map((e) => e.id).sort(), ['n2', 'note'].sort(), 'the notes around it are not pulled into the table (n3 stacks under n2 as before)');
  }

  console.log('sketch-convert: all checks passed');
} finally {
  await server.close();
}
