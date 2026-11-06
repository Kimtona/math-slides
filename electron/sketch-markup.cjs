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
 * Fallback for a model that lists every table cell as its own text element: region-based grid detection on IR elements
 * (coordinates 0..1000 of an image of width×height pixels). Works on a page that ALSO holds headings, lists and equations:
 * the page's single-line texts are clustered into rows, and a TABLE is a run of ≥ 3 vertically consecutive rows that
 * (a) all have the same number of cells (≥ 2), (b) line up column by column (left, right or centre edges), (c) have a regular row
 * pitch, and (d) whose cells do not overlap horizontally. Paragraph lines, list items (one box per line) and equations
 * never form such a run. Returns { table, ids, bbox } or null. The first row is taken as the header (flagged for review).
 */
function detectGridTable(elements, width, height) {
  const cand = elements.filter((e) => e.kind === 'text' && !e.blocks && e.role !== 'annotation' && !e.relations?.length && e.text && !e.text.includes('\n'));
  if (cand.length < 6) return null;
  const px = (e) => ({ x: (e.bbox.x * width) / 1000, y: (e.bbox.y * height) / 1000, w: (e.bbox.w * width) / 1000, h: (e.bbox.h * height) / 1000 });
  const med = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const medH = med(cand.map((e) => px(e).h));
  const byY = [...cand].sort((a, b) => px(a).y + px(a).h / 2 - (px(b).y + px(b).h / 2));
  const rows = [];
  for (const e of byY) {
    const cy = px(e).y + px(e).h / 2, row = rows[rows.length - 1];
    if (row && Math.abs(cy - row.cy) < 0.6 * medH) { row.cells.push(e); row.cy = (row.cy * (row.cells.length - 1) + cy) / row.cells.length; }
    else rows.push({ cy, cells: [e] });
  }
  for (const r of rows) r.cells.sort((a, b) => a.bbox.x - b.bbox.x);
  const rowOk = (r) => r.cells.every((c, i) => i === 0 || px(r.cells[i - 1]).x + px(r.cells[i - 1]).w <= px(c).x + 2);
  const tol = 0.02 * width;
  const aligned = (run, nCols) => {
    for (let c = 0; c < nCols; c++) {
      const edge = (f) => run.map((r) => f(px(r.cells[c])));
      const ok = [(b) => b.x, (b) => b.x + b.w, (b) => b.x + b.w / 2].some((f) => { const v = edge(f); return Math.max(...v) - Math.min(...v) <= tol; });
      if (!ok) return false;
    }
    return true;
  };
  // longest run of consecutive rows with the same cell count whose columns line up and whose pitch is regular
  let best = null;
  for (let a = 0; a < rows.length; a++) {
    const n = rows[a].cells.length;
    if (n < 2 || n > 8 || !rowOk(rows[a])) continue;
    let b = a;
    while (b + 1 < rows.length && rows[b + 1].cells.length === n && rowOk(rows[b + 1]) && aligned(rows.slice(a, b + 2), n)) {
      const ys = rows.slice(a, b + 2).map((r) => r.cy), gaps = ys.slice(1).map((y, i) => y - ys[i]), m = med(gaps);
      if (gaps.some((g) => Math.abs(g - m) > 0.35 * m)) break;
      b++;
    }
    if (b - a + 1 >= 3 && (!best || b - a > best.b - best.a)) best = { a, b, n };
    a = b; // rows inside a found run cannot start a better one
  }
  if (!best) return null;
  const run = rows.slice(best.a, best.b + 1), flat = run.flatMap((r) => r.cells);
  const x1 = Math.min(...flat.map((e) => e.bbox.x)), y1 = Math.min(...flat.map((e) => e.bbox.y));
  const x2 = Math.max(...flat.map((e) => e.bbox.x + e.bbox.w)), y2 = Math.max(...flat.map((e) => e.bbox.y + e.bbox.h));
  return {
    ids: flat.map((e) => e.id),
    bbox: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
    table: { header: true, rows: run.map((r) => r.cells.map((e) => [{ text: e.text }])) },
  };
}

/**
 * A model that lists every list item as its own `list` element (or writes "1. item" / "- item" as one text per line):
 * consecutive items of the same kind, left-aligned and stacked closely, become ONE list. Items carry `_listItem`
 * (set by the adapter); numbered items must also count up (`_num`), so section headings like "3. Workflow" followed by
 * "1. Upload" are not joined. (coordinates 0..1000 of an image of width×height pixels)
 */
function mergeListItems(elements, width, height) {
  const out = [];
  for (const e of elements) {
    const prev = out[out.length - 1];
    const b = e.blocks && e.blocks[0];
    if (prev && prev._listItem && e._listItem && prev.blocks[0].type === b.type && (b.type !== 'ordered' || e._num === undefined || prev._num === undefined || e._num === prev._num + 1)) {
      const pb = prev.bbox, eb = e.bbox;
      const lineH = (Math.min(pb.h, eb.h) * height) / 1000;
      const gap = ((eb.y - (pb.y + pb.h)) * height) / 1000, dx = Math.abs(((eb.x - pb.x) * width) / 1000);
      if (gap < 1.4 * lineH && gap > -0.5 * lineH && dx < 0.015 * width) {
        prev.blocks[0].items.push(...b.items);
        prev._num = e._num;
        const x1 = Math.min(pb.x, eb.x), y1 = Math.min(pb.y, eb.y), x2 = Math.max(pb.x + pb.w, eb.x + eb.w), y2 = Math.max(pb.y + pb.h, eb.y + eb.h);
        prev.bbox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        prev.text = blocksPlain(prev.blocks);
        prev._merged = true;
        continue;
      }
    }
    out.push(e);
  }
  return out;
}

/**
 * The model dropped the bullet glyphs and wrote each item as a plain single-line text. Several of them stacked at a regular
 * pitch, with one shared left edge, indented from the page's text margin, are a bullet list (the indentation is what is left
 * of the glyph). Returns the elements with such runs merged into one bullet-list element (flagged for review, since the
 * marker is inferred). Only plain texts qualify (no structure, relations, titles); numbered lines are handled by mergeListItems.
 */
function inferBulletLists(elements, width, height) {
  const isPlain = (e) => e.kind === 'text' && !e.blocks && e.role === 'body' && !e.relations?.length && e.text && !e.text.includes('\n') && !/^\s*\d{1,3}[.)]\s/.test(e.text);
  const texts = elements.filter((e) => e.kind === 'text');
  if (!texts.length) return { elements, inferred: 0 };
  const margin = Math.min(...texts.map((e) => (e.bbox.x * width) / 1000));
  const X = (e) => (e.bbox.x * width) / 1000, Y = (e) => (e.bbox.y * height) / 1000, H = (e) => (e.bbox.h * height) / 1000;
  const out = [];
  let inferred = 0;
  for (let i = 0; i < elements.length; ) {
    const run = [];
    if (isPlain(elements[i]) && X(elements[i]) - margin >= 0.04 * width) {
      run.push(elements[i]);
      for (let j = i + 1; j < elements.length && isPlain(elements[j]); j++) {
        const p = run[run.length - 1], e = elements[j];
        const gaps = run.length > 1 ? Y(p) - Y(run[run.length - 2]) : null, pitch = Y(e) - Y(p);
        if (Math.abs(X(e) - X(run[0])) > 0.015 * width || Math.abs(H(e) - H(p)) > 0.3 * H(p) || pitch < 0.9 * H(p) || pitch > 3 * H(p) || (gaps && Math.abs(pitch - gaps) > 0.3 * gaps)) break;
        run.push(e);
      }
    }
    if (run.length >= 2) {
      const x1 = Math.min(...run.map((e) => e.bbox.x)), y1 = Math.min(...run.map((e) => e.bbox.y));
      const x2 = Math.max(...run.map((e) => e.bbox.x + e.bbox.w)), y2 = Math.max(...run.map((e) => e.bbox.y + e.bbox.h));
      const blocks = [{ type: 'bullet', items: run.map((e) => parseInline(e.text)) }];
      out.push({ id: run[0].id, kind: 'text', role: 'body', bbox: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, blocks, text: blocksPlain(blocks), _unsure: 'Bullet markers inferred from the indented, evenly spaced lines: check them.' });
      inferred++;
      i += run.length;
    } else { out.push(elements[i]); i++; }
  }
  return { elements: out, inferred };
}


/**
 * Document Mode: a whole screenshot transcribed as Markdown (no coordinates) → ordered blocks, top to bottom:
 *   { type:'heading', level, spans } · { type:'paragraph', spans } · { type:'quote', spans } · { type:'bullet'|'ordered', start?, items }
 *   · { type:'table', header, rows: string[][] } · { type:'math', latex }
 * Pure; never invents content. A looping model's consecutive duplicate blocks are dropped. Unknown syntax stays a paragraph.
 */
function parseMarkdownDocument(md) {
  const text = String(md).replace(/\r/g, '').replace(/^\s*```[a-z]*\s*\n/i, '').replace(/\n\s*```\s*$/, '');
  const lines = text.split('\n');
  const out = [];
  const push = (b) => { const last = out[out.length - 1]; if (!last || JSON.stringify(last) !== JSON.stringify(b)) out.push(b); };
  const isTableLine = (l) => /^\s*\|.*\|\s*$/.test(l) || (l.split('|').length >= 3 && l.trim().startsWith('|'));
  const itemRe = /^\s*(?:[-•·*]|(\d{1,3})[.)])\s+(.*)$/;
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    const t = para.join(' ').trim(); para = [];
    if (!t) return;
    const m = /^\$([^$]+)\$$/.exec(t);
    if (m) push({ type: 'math', latex: m[1].trim() });
    else push({ type: 'paragraph', spans: parseInline(t) });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    if (!line.trim()) { flushPara(); continue; }
    let m;
    // display math: $$ … $$ (one or several lines) or \[ … \]
    if ((m = /^\s*(?:\$\$|\\\[)(.*)$/.exec(line))) {
      flushPara();
      let body = m[1]; const close = /(?:\$\$|\\\])\s*$/;
      if (!close.test(body)) { while (++i < lines.length && !close.test(lines[i])) body += ' ' + lines[i]; if (i < lines.length) body += ' ' + lines[i]; }
      const latex = body.replace(close, '').replace(/\s+/g, ' ').trim();
      if (latex) push({ type: 'math', latex });
      continue;
    }
    if (isTableLine(line)) {
      flushPara();
      const block = [line];
      while (i + 1 < lines.length && isTableLine(lines[i + 1])) block.push(lines[++i]);
      const hasSep = block.some((l) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(l.trim()));
      const rows = parseMarkdownTable(block.join('\n'));
      if (rows) {
        const n = Math.max(...rows.map((r) => r.length));
        push({ type: 'table', header: hasSep, rows: rows.map((r) => Array.from({ length: n }, (_, c) => r[c] ?? '')) });
      } else for (const l of block) push({ type: 'paragraph', spans: parseInline(l.trim()) });
      continue;
    }
    if ((m = /^\s{0,3}(#{1,4})\s+(.*)$/.exec(line))) { flushPara(); push({ type: 'heading', level: m[1].length, spans: parseInline(m[2]) }); continue; }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      flushPara();
      const parts = [m[1]];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) parts.push(lines[++i].replace(/^\s*>\s?/, ''));
      push({ type: 'quote', spans: parseInline(parts.join(' ').trim()) });
      continue;
    }
    if ((m = itemRe.exec(line))) {
      flushPara();
      const ordered = m[1] !== undefined, items = [parseInline(m[2])], start = ordered ? Number(m[1]) || 1 : undefined;
      while (i + 1 < lines.length) {
        const n = itemRe.exec(lines[i + 1].replace(/\s+$/, ''));
        if (!n || (n[1] !== undefined) !== ordered) break;
        items.push(parseInline(n[2])); i++;
      }
      push(ordered ? { type: 'ordered', start, items } : { type: 'bullet', items });
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  return out;
}

module.exports = { parseMarkdownDocument, inferBulletLists, mergeListItems, parseInline, markupToBlocks, blocksPlain, parseMarkdownTable, detectGridTable, plain, styled };
