// Structure recovery for the local (Ollama) model's output.
// A small VLM is much more reliable writing `**bold**`, `- item` or a Markdown table than nested JSON of spans. This module
// turns those markers into the structured IR pieces (spans / blocks / table) BEFORE anything reaches the slide: the markers
// are a transport format between model and adapter and never end up as characters in an element.
// Pure functions (no Electron, no DOM); used by electron/sketch-local.cjs and tested in tests/sketch-convert.mjs.

/** Splits off `$...$` math so formatting markers inside equations are never interpreted. */
const MATH = /(\$[^$\n]+\$)/;

const flagsFor = (d) => (d === '***' ? { bold: true, italic: true } : d === '**' ? { bold: true } : d === '~~' ? { strike: true } : { italic: true });
const STYLE = /(\*\*\*|\*\*|~~|\*)(?=\S)([\s\S]*?\S)\1/;

function push(out, text, style) {
  if (!text) return;
  const last = out[out.length - 1];
  const same = last && ['bold', 'italic', 'strike', 'underline'].every((k) => !!last[k] === !!style[k]);
  if (same) last.text += text;
  else out.push({ text, ...style });
}

/** `a **b** *c* ~~d~~` → spans [{text:'a '},{text:'b',bold:true},…]. Unbalanced markers stay literal characters. */
function parseInline(s, style = {}, out = []) {
  for (const part of String(s).split(MATH)) {
    if (!part) continue;
    if (MATH.test(part) && part.startsWith('$')) { push(out, part, style); continue; } // equation: raw, with its $
    let rest = part;
    for (;;) {
      const m = STYLE.exec(rest);
      if (!m) { push(out, rest, style); break; }
      push(out, rest.slice(0, m.index), style);
      parseInline(m[2], { ...style, ...flagsFor(m[1]) }, out);
      rest = rest.slice(m.index + m[0].length);
    }
  }
  return out;
}

const plain = (spans) => spans.map((s) => s.text).join('');
const styled = (spans) => spans.some((s) => s.bold || s.italic || s.strike || s.underline);

/**
 * Lines of text → blocks: `# ` headings (level = number of #), `> ` quotes, `- `/`• `/`* ` bullets, `1. ` numbered items
 * (consecutive items form one list), everything else paragraphs. Returns null when nothing but plain paragraphs came out
 * (the caller then keeps the plain text exactly as before, so ordinary notes are unaffected).
 */
function markupToBlocks(content) {
  const blocks = [];
  let special = false;
  for (const raw of String(content).replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    let m;
    if ((m = /^\s{0,3}(#{1,4})\s+(.*)$/.exec(line))) { blocks.push({ type: 'heading', level: m[1].length, spans: parseInline(m[2]) }); special = true; }
    else if ((m = /^\s*>\s?(.*)$/.exec(line))) { blocks.push({ type: 'quote', spans: parseInline(m[1]) }); special = true; }
    else if ((m = /^\s*[-•·]\s+(.*)$/.exec(line)) || (m = /^\s*\*\s+(.*)$/.exec(line))) {
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'bullet') last.items.push(parseInline(m[1])); else blocks.push({ type: 'bullet', items: [parseInline(m[1])] });
      special = true;
    } else if ((m = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line))) {
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'ordered') last.items.push(parseInline(m[2])); else blocks.push({ type: 'ordered', start: Number(m[1]) || 1, items: [parseInline(m[2])] });
      special = true;
    } else blocks.push({ type: 'paragraph', spans: parseInline(line) });
  }
  if (!blocks.length) return null;
  const anyStyle = blocks.some((b) => (b.spans ? styled(b.spans) : b.items.some(styled)));
  return special || anyStyle ? blocks : null;
}

/** Plain text of blocks, one line per paragraph / item (the fallback text the rest of the pipeline sizes and merges on). */
function blocksPlain(blocks) {
  return blocks.flatMap((b) => (b.items ? b.items.map(plain) : [plain(b.spans)])).join('\n');
}

/** `| a | b |` lines (with an optional `|---|---|` separator) → rows of cell strings, or null if it is not a table. */
function parseMarkdownTable(content) {
  const lines = String(content).split('\n').map((l) => l.trim()).filter((l) => l.includes('|'));
  if (lines.length < 2) return null;
  const rows = [];
  for (const l of lines) {
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(l)) continue; // separator row
    rows.push(l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
  }
  return rows.length >= 2 && rows.every((r) => r.length >= 2) ? rows : null;
}

/**
 * Fallback for a model that lists every table cell as its own text element: a conservative grid detection on IR elements
 * (coordinates 0..1000 of an image of width×height pixels). Returns { table, ids, bbox } or null.
 * Rules: ≥ 2 columns and ≥ 3 rows; every row has the same number of cells; cells of a column share a left edge; the grid
 * covers ≥ 80 % of the image's text elements (so notes that merely sit in a row are not turned into a table).
 */
function detectGridTable(elements, width, height) {
  const cand = elements.filter((e) => e.kind === 'text' && e.role !== 'annotation' && !e.relations?.length && e.text && !e.text.includes('\n'));
  const texts = elements.filter((e) => e.kind === 'text');
  if (cand.length < 6 || cand.length < 0.8 * texts.length) return null;
  const px = (e) => ({ x: (e.bbox.x * width) / 1000, y: (e.bbox.y * height) / 1000, w: (e.bbox.w * width) / 1000, h: (e.bbox.h * height) / 1000 });
  const med = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const medH = med(cand.map((e) => px(e).h));
  // rows: cluster by vertical center
  const byY = [...cand].sort((a, b) => px(a).y + px(a).h / 2 - (px(b).y + px(b).h / 2));
  const rows = [];
  for (const e of byY) {
    const cy = px(e).y + px(e).h / 2, row = rows[rows.length - 1];
    if (row && Math.abs(cy - row.cy) < 0.6 * medH) { row.cells.push(e); row.cy = (row.cy * (row.cells.length - 1) + cy) / row.cells.length; }
    else rows.push({ cy, cells: [e] });
  }
  const nCols = rows[0].cells.length;
  if (rows.length < 3 || nCols < 2 || nCols > 8 || rows.some((r) => r.cells.length !== nCols)) return null;
  for (const r of rows) r.cells.sort((a, b) => a.bbox.x - b.bbox.x);
  // columns: left edges must line up (within 1.5 % of the image width) down the rows
  const tol = 0.015 * width;
  for (let c = 0; c < nCols; c++) {
    const xs = rows.map((r) => px(r.cells[c]).x);
    if (Math.max(...xs) - Math.min(...xs) > tol) return null;
  }
  const flat = rows.flatMap((r) => r.cells);
  const x1 = Math.min(...flat.map((e) => e.bbox.x)), y1 = Math.min(...flat.map((e) => e.bbox.y));
  const x2 = Math.max(...flat.map((e) => e.bbox.x + e.bbox.w)), y2 = Math.max(...flat.map((e) => e.bbox.y + e.bbox.h));
  // The model called the first row's cells headings: take that as the header (nothing else tells layout alone).
  const header = rows[0].cells.every((e) => e.role === 'title');
  return {
    ids: flat.map((e) => e.id),
    bbox: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
    table: { header, rows: rows.map((r) => r.cells.map((e) => (e.blocks ? e.blocks[0]?.spans ?? [{ text: e.text }] : [{ text: e.text }]))) },
  };
}

/**
 * A model that lists every list item as its own `list` element (instead of one element with "items"): consecutive items of the
 * same kind, left-aligned and stacked closely, become ONE list. Items must carry `_listItem` (set by the adapter).
 * (coordinates 0..1000 of an image of width×height pixels)
 */
function mergeListItems(elements, width, height) {
  const out = [];
  for (const e of elements) {
    const prev = out[out.length - 1];
    const b = e.blocks && e.blocks[0];
    if (prev && prev._listItem && e._listItem && prev.blocks[0].type === b.type) {
      const pb = prev.bbox, eb = e.bbox;
      const lineH = (Math.min(pb.h, eb.h) * height) / 1000;
      const gap = ((eb.y - (pb.y + pb.h)) * height) / 1000, dx = Math.abs(((eb.x - pb.x) * width) / 1000);
      if (gap < 1.6 * lineH && gap > -0.5 * lineH && dx < 0.03 * width) {
        prev.blocks[0].items.push(...b.items);
        const x1 = Math.min(pb.x, eb.x), y1 = Math.min(pb.y, eb.y), x2 = Math.max(pb.x + pb.w, eb.x + eb.w), y2 = Math.max(pb.y + pb.h, eb.y + eb.h);
        prev.bbox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        prev.text = blocksPlain(prev.blocks);
        continue;
      }
    }
    out.push(e);
  }
  return out;
}

module.exports = { mergeListItems, parseInline, markupToBlocks, blocksPlain, parseMarkdownTable, detectGridTable, plain, styled };
