/** Pure logic of config.txt: parser, validation, template, and creation defaults (headless, no Electron). Run: node tests/config-model.mjs */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configLoader: 'runner', cacheDir: await mkdtemp(path.join(tmpdir(), 'mathslides-vite-')), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
try {
  const c = await server.ssrLoadModule('/src/model/config.ts');
  const d = await server.ssrLoadModule('/src/model/defaults.ts');
  const ok = (text) => { const r = c.parseConfig(text); assert.ok(r.ok, JSON.stringify(r.errors)); return r.config; };
  const bad = (text) => { const r = c.parseConfig(text); assert.equal(r.ok, false, 'expected an error for: ' + text); return r.errors; };

  // ---- built-in defaults are exactly the previous hard-coded ones ----
  assert.deepEqual({ ...c.DEFAULT_CONFIG }, { font: 'NanumSquare', heading1: 80, heading2: 50, heading3: 30, bodySize: 25, shapeFill: null, shapeStroke: '#000000', shapeStrokeWidth: 1, imageRadiusPreset: 50 });
  assert.deepEqual({ ...c.getConfig() }, { ...c.DEFAULT_CONFIG }, 'active config starts as the defaults');
  assert.deepEqual(ok(''), { ...c.DEFAULT_CONFIG }, 'empty file = defaults');
  assert.deepEqual(ok(c.configTemplate()), { ...c.DEFAULT_CONFIG }, 'the generated template parses to exactly the defaults');
  const tpl = c.configTemplate().split('\n');
  for (const line of ['font = NanumSquare', 'heading-1 = 80', 'heading-2 = 50', 'heading-3 = 30', 'body-size = 25']) assert.ok(tpl.includes(line), 'template shows toolbar values: ' + line);
  assert.equal(tpl.some((l) => /^(heading-\d|body-size)\s*=.*pt/.test(l)), false, 'template has no pt-converted typography values');
  assert.match(c.configTemplate(), /same numbers you see in MathSlides' font-size box/);
  assert.match(c.configTemplate(), /plain number WITHOUT px or pt/);
  // the toolbar's built-in sizes are exactly the template numbers, and pt remains accepted (existing files keep working)
  const T = (await server.ssrLoadModule('/src/model/typography.ts')).TYPOGRAPHY;
  assert.deepEqual([T.h1, T.h2, T.h3, T.body], [80, 50, 30, 25]);
  assert.deepEqual([ok('heading-1 = 80').heading1, ok('heading-1 = 60pt').heading1, ok('heading-1 = 80px').heading1], [80, 80, 80]);
  assert.deepEqual([ok('heading-2 = 37.5pt').heading2, ok('heading-3 = 22.5pt').heading3, ok('body-size = 18.75pt').bodySize], [50, 30, 25], 'old pt templates still resolve to the same sizes');
  console.log('PASS built-in defaults and template');

  // ---- syntax ----
  const full = ok(`# comment\n\n  font   =   Pretendard  \nheading-1=50pt\nheading-2 = 40\nheading-3 = 24.5px\nbody-size = 20px\nshape-fill = #abc\nshape-stroke=#FF0000\nshape-stroke-width = 2px\nimage-radius-preset = 30px\n`);
  assert.deepEqual({ ...full }, { font: 'Pretendard', heading1: 66.67, heading2: 40, heading3: 24.5, bodySize: 20, shapeFill: '#AABBCC', shapeStroke: '#FF0000', shapeStrokeWidth: 2, imageRadiusPreset: 30 });
  assert.equal(ok('shape-fill = none').shapeFill, null); assert.equal(ok('shape-fill = NONE').shapeFill, null);
  assert.equal(ok('heading-1 = 60pt').heading1, 80); assert.equal(ok('heading-1 = 80px').heading1, 80); assert.equal(ok('heading-1 = 80').heading1, 80, 'bare number = px');
  assert.equal(ok('heading-1 = 18.75PT').heading1, 25, 'units are case-insensitive');
  assert.equal(ok('font = noto serif kr').font, 'Noto Serif KR', 'font ids match case-insensitively and may contain spaces');
  assert.equal(ok('# heading-1 = 99\nheading-2 = 41').heading1, 80, 'commented-out line is ignored'); 
  assert.equal(ok('heading-1 = 70\r\nheading-2 = 41\r\n').heading2, 41, 'CRLF'); assert.equal(ok('﻿heading-1 = 70').heading1, 70, 'BOM');
  assert.equal(ok('image-radius-preset = 0').imageRadiusPreset, 0);
  console.log('PASS valid configuration, comments, whitespace, colors, none, units');

  // ---- errors: whole file or nothing, with line numbers ----
  const e1 = bad('heading-1 = 70\nheading-2 = abc\nbogus = 1\nheading-2 = 40');
  assert.deepEqual(e1.map((e) => [e.line, e.key]), [[2, 'heading-2'], [3, 'bogus'], [4, 'heading-2']], 'every problem reported with its line');
  assert.match(e1[1].message, /unknown key/); assert.match(e1[2].message, /duplicate heading-2 \(first set on line 2\)/);
  assert.match(c.describeConfigErrors(e1), /^Config error on line 2: invalid heading-2: .* \(\+2 more\)$/);
  for (const t of ['heading-1 = 50em', 'heading-1 = 50 pt pt', 'heading-1 = -5', 'heading-1 = NaN', 'heading-1 = Infinity', 'heading-1 = 1e3', 'heading-1 = 5', 'heading-1 = 301', 'heading-1 = ', 'heading-1 = pt',
    'shape-fill = red', 'shape-fill = #12', 'shape-fill = #GGGGGG', 'shape-stroke = none', 'shape-stroke-width = 0', 'shape-stroke-width = 51px', 'image-radius-preset = -1', 'image-radius-preset = 1001',
    'font = Comic Sans', 'font =', 'just words', '= 5', 'Heading-1 = 5', '__proto__ = 5', 'constructor = 1']) bad(t);
  assert.equal(bad('heading-1 = 50em')[0].line, 1); assert.match(bad('heading-1 = 50em')[0].message, /unsupported unit "em"/);
  assert.equal(bad('shape-fill = red')[0].key, 'shape-fill');
  assert.equal(bad('heading-1 = 70 # note')[0].line, 1, 'there are no trailing comments');
  console.log('PASS unknown/duplicate keys, invalid numbers, units, colors, fonts, ranges');

  // ---- creation defaults follow the active config, existing elements never change ----
  const before = { text: d.newText(0, 0), shape: d.newShape('rect', 0, 0), title: d.newTitleSlide().slide, content: d.newContentSlide() };
  assert.equal(before.text.style.fontSize, 25); assert.equal('fontFamily' in before.text.style, false, 'default font is not stamped: legacy boxes and new boxes look the same');
  assert.deepEqual([before.shape.fill, before.shape.stroke, before.shape.strokeWidth, 'textStyle' in before.shape], [null, '#000000', 1, false]);
  assert.deepEqual([1, 2, 3, 4, 9].map(d.headingSize), [80, 50, 30, 25, 25]);
  const snapshot = JSON.stringify(before);

  c.setConfig(ok('font = Pretendard\nheading-1 = 50pt\nheading-2 = 40\nheading-3 = 24\nbody-size = 20\nshape-fill = #FFFFFF\nshape-stroke = #FF0000\nshape-stroke-width = 3px'));
  assert.equal(JSON.stringify(before), snapshot, 'existing elements and slides are plain data: nothing changes');
  assert.deepEqual([1, 2, 3, 4].map(d.headingSize), [66.67, 40, 24, 20]);
  const t = d.newText(0, 0);
  assert.deepEqual([t.style.fontSize, t.style.fontFamily, t.h], [20, 'Pretendard', Math.round(20 * 1.35)]);
  const s = d.newShape('ellipse', 0, 0);
  assert.deepEqual([s.fill, s.stroke, s.strokeWidth], ['#FFFFFF', '#FF0000', 3]);
  assert.deepEqual(s.textStyle, { fontSize: 20, color: '#000000', align: 'center', lineHeight: 1.35, fill: null, fontFamily: 'Pretendard' }, 'shape text keeps the configured body size/font');
  assert.deepEqual(d.shapeTextStyle(before.shape), { fontSize: 25, color: '#000000', align: 'center', lineHeight: 1.35, fill: null }, 'a shape without a stored textStyle still falls back to the BUILT-IN style');
  const ts = d.newTitleSlide().slide.elements;
  assert.deepEqual(ts.map((e) => [e.style.fontSize, e.style.fontFamily]), [[66.67, 'Pretendard'], [24, 'Pretendard']], 'templates use the configured sizes and font');
  c.setConfig(ok('body-size = 25px\nshape-fill = none')); // sizes back at built-in, font default
  assert.equal('textStyle' in d.newShape('rect', 0, 0), false, 'nothing stamped when the config equals the built-ins');
  c.resetConfig();
  assert.equal(JSON.stringify({ text: d.newText(0, 0, {}), }).includes('fontFamily'), false);
  console.log('PASS creation defaults follow config; existing elements and built-in fallbacks unchanged');

  // ---- application menu: the two accelerators exist exactly once and nothing else uses them ----
  const { buildMenuTemplate } = createRequire(import.meta.url)('../electron/menu.cjs');
  for (const platform of ['darwin', 'win32', 'linux']) {
    const calls = [];
    const flat = (items) => items.flatMap((i) => [i, ...(i.submenu ? flat(i.submenu) : [])]);
    const items = flat(buildMenuTemplate({ platform, openConfig: () => calls.push('open'), reloadConfig: () => calls.push('reload') }));
    const acc = items.filter((i) => i.accelerator);
    assert.deepEqual(acc.map((i) => [i.id, i.accelerator]), [['open-config', 'CmdOrCtrl+,'], ['reload-config', 'CmdOrCtrl+Shift+,']], platform + ': only the two config accelerators');
    items.find((i) => i.id === 'open-config').click(); items.find((i) => i.id === 'reload-config').click();
    assert.deepEqual(calls, ['open', 'reload']);
    assert.ok(items.some((i) => i.role === 'copy') && items.some((i) => i.role === 'paste') && items.some((i) => i.role === 'cut'), 'clipboard roles kept');
  }
  console.log('PASS application menu accelerators');
} finally {
  await server.close();
}
console.log('ALL PASS');
