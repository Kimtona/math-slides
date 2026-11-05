/** Curved lines / curved arrows: Bézier geometry, the Sketch-to-Slides IR (curvedArrow / curve, control point or bend,
 * compatibility with straight arrows), conversion inside the image frame, and the local-model format.
 * Headless (Vite SSR loader, no Electron, no AI). Run: node tests/curve.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configLoader: 'runner', cacheDir: await mkdtemp(path.join(tmpdir(), 'mathslides-vite-')), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const near = (a, b, tol = 0.5, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} ≈ ${b}`);
try {
  const C = await server.ssrLoadModule('/src/model/curve.ts');
  const { newLine, lineBox } = await server.ssrLoadModule('/src/model/defaults.ts');
  const { translate } = await server.ssrLoadModule('/src/model/geometry.ts');
  const { parseIR, applyPatches } = await server.ssrLoadModule('/src/sketch/ir.ts');
  const { irToElements } = await server.ssrLoadModule('/src/sketch/convert.ts');
  const { validateSketch } = await server.ssrLoadModule('/src/sketch/validate.ts');
  const { localToModelIR, LOCAL_SCHEMA } = require(path.join(root, 'electron/sketch-local.cjs'));

  // ---- geometry ----
  {
    const p0 = { x: 100, y: 300 }, p2 = { x: 400, y: 300 };
    const c = C.bendControl(p0, p2, 0.5);
    assert.deepEqual(c, { x: 250, y: 150 }, 'positive bend = left of travel = up for a left-to-right chord');
    const l = newLine(100, 300, 400, 300, true, c);
    assert.ok(C.isCurved(l));
    assert.deepEqual(C.curveMid(l), { x: 250, y: 225 }, 'middle is halfway to the control point');
    assert.deepEqual([l.x, l.y, l.w, l.h], [100, 225, 300, 75], 'bbox covers the bulge, not the control point');
    assert.deepEqual(C.controlFromMid(p0, p2, { x: 250, y: 225 }), c, 'mid ↔ control round trip');
    // Straight lines are unchanged: no control point, same box.
    const s = newLine(10, 20, 110, 70);
    assert.ok(!('cx' in s) && !C.isCurved(s));
    assert.deepEqual(lineBox(s), { x: 10, y: 20, w: 100, h: 50 });
    // Endpoint moves keep the bend: chord rotated 90° and doubled → control rotated and scaled with it.
    const r = C.reframeControl({ x1: 0, y1: 0, x2: 100, y2: 0 }, { x: 50, y: -40 }, { x1: 0, y1: 0, x2: 0, y2: 200 });
    near(r.x, 80, 1e-9); near(r.y, 100, 1e-9);
    // Sub-curve: same shape between t0 and t1.
    const [a, q, b] = C.quadSegment(p0, c, p2, 0.2, 0.9);
    const m1 = C.quadAt(a, q, b, 0.5), m2 = C.quadAt(p0, c, p2, 0.55);
    near(m1.x, m2.x, 1e-9); near(m1.y, m2.y, 1e-9);
    // End tangent points out of the curve at the tip (down-right for this upward arc).
    const tEnd = C.endTangent(p0, c, p2);
    assert.ok(tEnd.x > 0 && tEnd.y > 0);
    // Moving a curve moves its control point.
    const moved = structuredClone(l); translate(moved, l, 30, -10);
    assert.deepEqual([moved.cx, moved.cy, moved.x1, moved.y1], [l.cx + 30, l.cy - 10, 130, 290]);
  }

  // ---- IR: curved kinds, control point / bend / bbox estimate, compatibility ----
  const image = { width: 1000, height: 1000 };
  const base = { from: { x: 100, y: 500 }, to: { x: 500, y: 500 }, bbox: { x: 100, y: 300, w: 400, h: 200 } };
  {
    const { ir, issues } = parseIR({ elements: [
      { id: 'c1', kind: 'curvedArrow', ...base, control: { x: 300, y: 100 } },
      { id: 'c2', kind: 'curve', ...base, bend: 'down', bendDepth: 0.25 },
      { id: 'c3', kind: 'curvedArrow', ...base }, // bbox reaches above the chord → bends up
      { id: 'a1', kind: 'arrow', from: { x: 100, y: 800 }, to: { x: 500, y: 800 }, bbox: { x: 100, y: 790, w: 400, h: 20 } }, // plain straight arrow
      { id: 'a2', kind: 'arrow', ...base, control: { x: 300, y: 100 } }, // straight kind + control → curved arrow
      { id: 'c4', kind: 'curve', ...base, bend: 'left' }, // bend along the chord → impossible → straight
    ] }, image);
    const by = Object.fromEntries(ir.elements.map((e) => [e.id, e]));
    assert.deepEqual(by.c1.control, { x: 300, y: 100 });
    assert.equal(by.c2.kind, 'curve'); assert.deepEqual(by.c2.control, { x: 300, y: 700 }, 'bend down 0.25 → middle 100 below → control 200 below');
    assert.ok(!('bend' in by.c2), 'bend is resolved into a control point');
    assert.ok(by.c3.control.y < 500, 'bbox estimate bends up: ' + JSON.stringify(by.c3.control));
    assert.ok(issues.some((i) => i.id === 'c3' && i.code === 'geometry' && i.severity === 'info'), 'estimate is reported');
    assert.equal(by.a1.kind, 'arrow'); assert.ok(!('control' in by.a1), 'straight arrow stays straight');
    assert.equal(by.a2.kind, 'curvedArrow', 'arrow with a control point is upgraded');
    assert.equal(by.c4.kind, 'line'); assert.ok(!by.c4.control);
    assert.ok(issues.some((i) => i.id === 'c4' && i.severity === 'warning'), 'undeterminable bend is reported');
    // Review patches re-parse an already resolved IR without changing it.
    const again = applyPatches(ir, []).ir;
    assert.deepEqual(again.elements, ir.elements, 're-parse is stable');
    // Non-square image: the bend is perpendicular in PIXELS.
    const wide = parseIR({ elements: [{ id: 'w', kind: 'curve', from: { x: 0, y: 0 }, to: { x: 1000, y: 1000 }, bbox: { x: 0, y: 0, w: 1000, h: 1000 }, bend: 'up', bendDepth: 0.1 }] }, { width: 2000, height: 1000 }).ir.elements[0];
    const cpx = { x: (wide.control.x * 2000) / 1000, y: wide.control.y };
    const dot = (cpx.x - 1000) * 2000 + (cpx.y - 500) * 1000;
    near(dot, 0, 2000, 'control lies on the pixel-space perpendicular bisector');
  }

  // ---- conversion: frame placement, arrowheads, shape attachment ----
  {
    const raw = { elements: [
      { id: 's1', kind: 'shape', shape: 'ellipse', bbox: { x: 50, y: 400, w: 100, h: 200 } },
      { id: 's2', kind: 'shape', shape: 'rect', bbox: { x: 750, y: 400, w: 200, h: 200 } },
      { id: 'ca', kind: 'curvedArrow', from: { x: 150, y: 450 }, to: { x: 760, y: 450 }, control: { x: 450, y: -200 }, fromId: 's1', toId: 's2', bbox: { x: 150, y: 100, w: 610, h: 350 } },
      { id: 'cv', kind: 'curve', from: { x: 200, y: 900 }, to: { x: 800, y: 900 }, bend: 'down', bbox: { x: 200, y: 880, w: 600, h: 100 } },
      { id: 'st', kind: 'arrow', from: { x: 200, y: 700 }, to: { x: 700, y: 700 }, bbox: { x: 200, y: 690, w: 500, h: 20 } },
    ] };
    const img = { width: 800, height: 600 };
    const { ir } = parseIR(raw, img);
    const frame = { x: 200, y: 100, w: 800, h: 600 };
    const conv = irToElements(ir, frame);
    const lines = conv.elements.filter((e) => e.type === 'line');
    const [ca] = conv.map.ca.map((id) => conv.elements.find((e) => e.id === id));
    const [cv] = conv.map.cv.map((id) => conv.elements.find((e) => e.id === id));
    const [st] = conv.map.st.map((id) => conv.elements.find((e) => e.id === id));
    assert.equal(lines.length, 3);
    assert.ok(C.isCurved(ca) && ca.arrowEnd && !ca.arrowStart, 'curved arrow → curved line with an arrowhead');
    assert.ok(C.isCurved(cv) && !cv.arrowEnd, 'curve → curved line without arrowhead');
    assert.ok(!C.isCurved(st) && st.arrowEnd && !('cx' in st), 'straight arrow unchanged');
    // Everything (incl. the whole curve, whose control point was above the image) stays inside the image frame.
    const tol = 1;
    for (const el of conv.elements) assert.ok(el.x >= frame.x - tol && el.y >= frame.y - tol && el.x + el.w <= frame.x + frame.w + tol && el.y + el.h <= frame.y + frame.h + tol, 'inside frame: ' + JSON.stringify([el.type, el.x, el.y, el.w, el.h]));
    assert.ok(ca.cy >= frame.y, 'control point clamped into the frame');
    // Attached ends leave the shapes towards the control point (upwards), not straight at the other shape.
    const s1 = conv.elements.find((e) => e.id === conv.map.s1[0]);
    assert.ok(ca.y1 < s1.y + s1.h / 2 - 5, 'tail leaves the ellipse upward along the curve');
    assert.ok(cv.cy > cv.y1, 'bend down');
    const rep = validateSketch(ir, conv, undefined, { frame });
    assert.equal(rep.counts.error, 0, JSON.stringify(rep.issues));
    // JSON round trip (what .mslides stores) keeps the curve exactly.
    assert.deepEqual(JSON.parse(JSON.stringify(ca)), ca);
  }

  // ---- local-model flat format ----
  {
    assert.ok(LOCAL_SCHEMA.properties.elements.items.properties.type.enum.includes('curved_arrow'));
    const out = localToModelIR({ elements: [
      { id: 'e1', type: 'curved_arrow', bbox_2d: [100, 100, 500, 300], content: '', points: [100, 300, 500, 300], via: [300, 200] },
      { id: 'e2', type: 'curve', bbox_2d: [100, 400, 500, 600], content: '', points: [100, 400, 500, 400], bend: 'down' },
      { id: 'e3', type: 'arrow', bbox_2d: [100, 700, 500, 710], content: '', points: [100, 700, 500, 700] },
    ] }, 1000, 1000);
    const [e1, e2, e3] = out.elements;
    assert.equal(e1.kind, 'curvedArrow'); assert.deepEqual(e1.control, { x: 300, y: 100 }, 'via (on the stroke) → control point');
    assert.equal(e2.kind, 'curve'); assert.equal(e2.bend, 'down');
    assert.equal(e3.kind, 'arrow'); assert.ok(!e3.control && !e3.bend);
    const { ir } = parseIR(out, { width: 1000, height: 1000 });
    assert.deepEqual(ir.elements.map((e) => e.kind), ['curvedArrow', 'curve', 'arrow']);
    assert.ok(ir.elements[1].control.y > 400);
  }
  console.log('curve: all checks passed');
} finally {
  await server.close();
}
