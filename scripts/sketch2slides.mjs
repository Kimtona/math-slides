#!/usr/bin/env node
/**
 * Sketch-to-Slides from the command line (no GUI): image → Claude recognition → IR → MathSlides elements →
 * deterministic validation → a .mslides file you can open in MathSlides.
 *
 *   node scripts/sketch2slides.mjs <image.png|jpg> [--out <dir>] [--model <id>]
 *   node scripts/sketch2slides.mjs <image> --ir <saved.ir.json>   # re-run conversion offline from a saved model output
 *
 * Needs ANTHROPIC_API_KEY (or an `ant auth login` profile) unless --ir is given.
 * The AI review loop needs a rendering of the slide and therefore runs in the desktop app only.
 * Outputs (in --out, default ./sketch-out): <name>.ir.json, <name>.mslides, <name>.report.json
 */
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

/** Pixel size and MIME type from the file header (PNG, JPEG, WebP, GIF). */
export function imageInfo(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1];
      const len = buf.readUInt16BE(o + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { mime: 'image/jpeg', height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      o += 2 + len;
    }
  }
  if (buf.toString('ascii', 0, 4) === 'GIF8') return { mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && buf.toString('ascii', 12, 16) === 'VP8X')
    return { mime: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  throw new Error('Unsupported image (use PNG, JPEG, GIF or WebP).');
}

const MAX_BYTES = 5 * 1024 * 1024; // API per-image limit; resize larger photos first

async function main() {
  const a = args(process.argv.slice(2));
  const input = a._[0];
  if (!input) {
    console.error('usage: node scripts/sketch2slides.mjs <image> [--out <dir>] [--model <id>] [--ir <saved.ir.json>]');
    process.exit(2);
  }
  const outDir = path.resolve(a.out ?? 'sketch-out');
  const name = path.basename(input).replace(/\.[^.]+$/, '');
  const buf = await readFile(input);
  const info = imageInfo(buf);
  const t0 = Date.now();

  let raw, meta = {};
  if (a.ir) {
    const saved = JSON.parse(await readFile(a.ir, 'utf8'));
    raw = saved.output ?? saved; // accepts a *.ir.json written by this tool, or a bare { elements }
    meta = { source: 'saved IR', file: path.resolve(a.ir), model: saved.model ?? null };
  } else {
    if (buf.length > MAX_BYTES) throw new Error(`Image is ${(buf.length / 1048576).toFixed(1)} MB; resize it below 5 MB first.`);
    const { recognize } = require(path.join(root, 'electron/sketch-ai.cjs'));
    const { MODEL_IR_SCHEMA } = await loadTs('/src/sketch/ir.ts');
    process.stderr.write(`Recognizing ${path.basename(input)} (${info.width}×${info.height}) …\n`);
    const r = await recognize({ apiKey: process.env.ANTHROPIC_API_KEY || undefined, model: a.model, schema: MODEL_IR_SCHEMA, image: { base64: buf.toString('base64'), mime: info.mime, width: info.width, height: info.height } });
    raw = r.data;
    meta = { source: 'model', model: r.model, ms: r.ms, usage: r.usage };
  }

  const { parseIR } = await loadTs('/src/sketch/ir.ts');
  const { irToElements } = await loadTs('/src/sketch/convert.ts');
  const { validateSketch } = await loadTs('/src/sketch/validate.ts');
  const { uid } = await loadTs('/src/model/defaults.ts');
  const { ir, issues } = parseIR(raw, { width: info.width, height: info.height });
  const conv = irToElements(ir);
  const report = validateSketch(ir, conv);

  const deck = {
    version: 1, id: uid(), title: name,
    slides: [{ id: uid(), background: '#ffffff', elements: conv.elements, notes: '', reference: '' }],
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, `${name}.ir.json`), JSON.stringify({ ...meta, image: { width: info.width, height: info.height }, output: raw }, null, 2));
  await writeFile(path.join(outDir, `${name}.mslides`), JSON.stringify({ format: 'mathslides', version: 1, deck, assets: {} }));
  await writeFile(path.join(outDir, `${name}.report.json`), JSON.stringify({ ...meta, totalMs: Date.now() - t0, parseIssues: issues, validation: report, ir, map: conv.map }, null, 2));

  const c = report.counts;
  console.log(`${name}: ${conv.elements.length} elements · ${c.error} error(s), ${c.warning} warning(s), ${report.review.length} flagged for review · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const i of [...issues, ...report.issues].filter((i) => i.severity !== 'info' || i.code === 'review')) console.log(`  ${i.severity.padEnd(7)} ${i.id ?? '-'} [${i.code}] ${i.message}`);
  console.log(`→ ${path.join(outDir, name + '.mslides')}`);
}

let server;
async function loadTs(mod) {
  server ??= await createServer({ root, configLoader: 'runner', cacheDir: await mkdtemp(path.join(tmpdir(), 'mathslides-vite-')), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  return server.ssrLoadModule(mod);
}

main()
  .catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; })
  .finally(() => server?.close());
