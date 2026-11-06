// Local-model output format (flat, pixel coordinates, Qwen2.5-VL style `bbox_2d`) and its deterministic
// conversion to the shared model IR ({ elements, notes } with 0..1000 coordinates) that src/sketch/ir.ts validates.
// Nothing is invented here: unreadable or inconsistent items are kept and flagged for review, or dropped with a note.

const { parseInline, markupToBlocks, blocksPlain, parseMarkdownTable, detectGridTable, mergeListItems } = require('./sketch-markup.cjs');

const TYPES = ['title', 'text', 'math', 'circle', 'rectangle', 'arrow', 'line', 'curved_arrow', 'curve', 'heading', 'list', 'quote', 'table'];
const BENDS = ['up', 'down', 'left', 'right'];
const COLORS = ['black', 'blue', 'red', 'green'];
const str = { type: 'string' };
const num = { type: 'number' };

const LOCAL_SCHEMA = {
  type: 'object',
  properties: {
    elements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: str,
          type: { type: 'string', enum: TYPES },
          bbox_2d: { type: 'array', items: num, minItems: 4, maxItems: 4 },
          content: str,
          color: { type: 'string', enum: COLORS },
          points: { type: 'array', items: num, minItems: 4, maxItems: 4 },
          connects: { type: 'array', items: str },
          via: { type: 'array', items: num, minItems: 2, maxItems: 2 },
          bend: { type: 'string', enum: BENDS },
          explains: str,
          // structure: table rows (cells as strings), list items, heading level
          rows: { type: 'array', items: { type: 'array', items: str } },
          header: { type: 'boolean' },
          items: { type: 'array', items: str },
          ordered: { type: 'boolean' },
          level: num,
          pen: { type: 'string', enum: ['pen', 'highlighter'] },
          unsure: str,
        },
        required: ['id', 'type', 'bbox_2d', 'content'],
      },
    },
  },
  required: ['elements'],
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Local models sometimes write LaTeX into JSON without escaping backslashes, so JSON.parse turns `\nabla` into a newline +
 * "abla", `\theta` into a tab + "heta", `\frac` into a form feed + "rac", `\beta` into a backspace + "eta".
 * A control character directly followed by letters is such a broken command and gets its backslash back;
 * any other control character is real whitespace (e.g. a leading newline before `\nabla`, experiment 4).
 */
const CONTROL = { '\n': 'n', '\t': 't', '\f': 'f', '\b': 'b', '\r': 'r' };
function repairLatex(s) {
  return s.replace(/[\n\t\f\b\r](?=[A-Za-z])/g, (c) => '\\' + CONTROL[c]).replace(/[\n\t\f\b\r]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * LaTeX commands written into a plain-text note OUTSIDE any math delimiters (e.g. "\rightarrow 행동확률") become inline
 * math so they render as symbols. Parts already inside `$...$`, `$$...$$`, `\(...\)` or `\[...\]` are left exactly as they
 * are (wrapping inside them corrupted `\(\pi_{\theta}\)` into `\($\pi$_{$\theta$}\)` — PPO capture).
 */
const MATH_SPAN = /\$\$[^$]+?\$\$|\$[^$]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/g;
function wrapBlocks(blocks) {
  const fix = (spans) => spans.map((sp) => ({ ...sp, text: wrapInlineCommands(sp.text) }));
  return blocks.map((b) => (b.items ? { ...b, items: b.items.map(fix) } : { ...b, spans: fix(b.spans) }));
}
function wrapInlineCommands(text) {
  let out = '', last = 0, m;
  const re = new RegExp(MATH_SPAN.source, 'g');
  const wrap = (plain) => plain.replace(/\\[A-Za-z]+(?:\{[^{}]*\})*/g, (c) => `$${c}$`);
  while ((m = re.exec(text))) {
    out += wrap(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + wrap(text.slice(last));
}

const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/;
/** Evidence-based review policy (docs/SKETCH_DEVLOG.md, experiment 2): the 7B local model misread Korean handwriting
 * while reporting no uncertainty, and its LaTeX needs a look; so those are always offered for review. */
function localReviewReason(out) {
  if (out.kind === 'math') return 'Equation read by a local model: check the LaTeX against the sketch.';
  if (out.blocks && out.blocks.some((b) => b.items)) return 'List read by a local model: check bullets vs. numbers and the items.';
  if (out.kind === 'table' && out.table.rows.some((r) => r.some((c) => HANGUL.test(c.map((s) => s.text).join(''))))) return 'Table read by a local model: check every cell.';
  if (out.kind === 'text' && HANGUL.test(out.text ?? '')) return 'Korean handwriting read by a local model: check the wording.';
  if (out.kind === 'shape' && HANGUL.test(out.text ?? '')) return 'Korean label read by a local model: check the wording.';
  return '';
}

/**
 * Lines of one note that the model listed separately (same kind, same color, stacked directly below each other,
 * horizontally overlapping) are merged into one multi-line note. Only layout is used; no text is changed.
 * Distances are compared in pixels (width/height of the image): IR x and y units differ on non-square images
 * (a bug found in the GUI run: two notes on one line of a wide image were joined).
 */
function mergeStackedLines(elements, width = 1000, height = 1000) {
  const px = (b) => ({ x: (b.x * width) / 1000, y: (b.y * height) / 1000, w: (b.w * width) / 1000, h: (b.h * height) / 1000 });
  const texts = elements.filter((e) => e.kind === 'text' && e.role !== 'title' && !e.blocks); // structured notes (lists, quotes, formatting) are never merged line by line
  const absorbed = new Set();
  // 1) Words of the same line listed separately (vertical overlap ≥ 50%, small horizontal gap): joined with a space.
  texts.sort((a, b) => a.bbox.x - b.bbox.x);
  for (const left of texts) {
    if (absorbed.has(left.id)) continue;
    for (const right of texts) {
      if (right === left || absorbed.has(right.id) || right.bbox.x < left.bbox.x) continue;
      if ((left.color ?? 'black') !== (right.color ?? 'black') || left.text.includes('\n') || right.text.includes('\n')) continue;
      const L = px(left.bbox), R = px(right.bbox);
      const vOverlap = Math.min(L.y + L.h, R.y + R.h) - Math.max(L.y, R.y);
      const hGap = R.x - (L.x + L.w);
      // Same line: at least half the smaller height overlaps, and the gap is about a word space (≤ 0.6 line height).
      if (vOverlap < 0.5 * Math.min(L.h, R.h) || hGap > 0.6 * Math.min(L.h, R.h)) continue;
      left.text = `${left.text} ${right.text}`;
      const x2 = Math.max(left.bbox.x + left.bbox.w, right.bbox.x + right.bbox.w);
      const y1 = Math.min(left.bbox.y, right.bbox.y), y2 = Math.max(left.bbox.y + left.bbox.h, right.bbox.y + right.bbox.h);
      left.bbox = { x: left.bbox.x, y: y1, w: x2 - left.bbox.x, h: y2 - y1 };
      absorbed.add(right.id);
    }
  }
  // 2) Lines of one note stacked below each other: joined with a line break.
  texts.sort((a, b) => a.bbox.y - b.bbox.y);
  for (const top of texts) {
    if (absorbed.has(top.id)) continue;
    for (const below of texts) {
      if (below === top || absorbed.has(below.id) || below.bbox.y <= top.bbox.y) continue;
      const lineH = top.bbox.h / (top.text.split('\n').length || 1);
      const gap = below.bbox.y - (top.bbox.y + top.bbox.h);
      const overlap = Math.min(top.bbox.x + top.bbox.w, below.bbox.x + below.bbox.w) - Math.max(top.bbox.x, below.bbox.x);
      if ((top.color ?? 'black') !== (below.color ?? 'black') || gap > lineH * 0.8 || gap < -lineH * 0.5) continue;
      if (overlap < 0.3 * Math.min(top.bbox.w, below.bbox.w)) continue;
      top.text = `${top.text}\n${below.text}`;
      const x1 = Math.min(top.bbox.x, below.bbox.x), y1 = top.bbox.y;
      const x2 = Math.max(top.bbox.x + top.bbox.w, below.bbox.x + below.bbox.w), y2 = Math.max(top.bbox.y + top.bbox.h, below.bbox.y + below.bbox.h);
      top.bbox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      if (below.relations && !top.relations) top.relations = below.relations;
      absorbed.add(below.id);
    }
  }
  // References to merged lines now point at the note they joined.
  const into = new Map();
  for (const t of texts) if (!absorbed.has(t.id)) for (const u of texts) if (absorbed.has(u.id) && t.text.includes(u.text)) into.set(u.id, t.id);
  const kept = elements.filter((e) => !absorbed.has(e.id));
  for (const e of kept) {
    if (e.fromId && into.has(e.fromId)) e.fromId = into.get(e.fromId);
    if (e.toId && into.has(e.toId)) e.toId = into.get(e.toId);
    e.relations?.forEach((r) => { if (into.has(r.target)) r.target = into.get(r.target); });
  }
  return { elements: kept, merged: absorbed.size };
}

/** data: local-model JSON; width/height: pixel size of the image the model saw. Returns { elements, notes, warnings }. */
function localToModelIR(data, width, height) {
  const notes = [];
  const warnings = [];
  if (data?._salvaged) warnings.push(`The model's answer was cut off (${data._salvaged.reason}); kept its ${data._salvaged.kept} finished element(s) and dropped the rest.`);
  const all = Array.isArray(data?.elements) ? data.elements : [];
  // A model that repeats itself (even a whole run of elements, with the same ids and boxes) must not double its content:
  // same type + same text + same place (within 8 px-ish buckets) = the same element, kept once. The same words at another place are kept.
  const keyOf = (e) => [e?.type, typeof e?.content === 'string' ? e.content.trim() : '', Array.isArray(e?.items) ? e.items.join('\u0001') : '', Array.isArray(e?.bbox_2d) ? e.bbox_2d.map((v) => Math.round(v / 8)).join(',') : ''].join('|');
  const seenKeys = new Set();
  const items = all.filter((e) => { const k = keyOf(e); if (seenKeys.has(k)) return false; seenKeys.add(k); return true; });
  if (items.length < all.length) warnings.push(`Dropped ${all.length - items.length} repeated element(s) (same type, text and place).`);
  const nx = (x) => (x / width) * 1000;
  const ny = (y) => (y / height) * 1000;
  // Some models answer in 0..1000 although asked for pixels: detect it from the coordinate range.
  const maxX = Math.max(0, ...items.flatMap((e) => (Array.isArray(e?.bbox_2d) ? [e.bbox_2d[0], e.bbox_2d[2]] : [])).filter(isNum));
  const maxY = Math.max(0, ...items.flatMap((e) => (Array.isArray(e?.bbox_2d) ? [e.bbox_2d[1], e.bbox_2d[3]] : [])).filter(isNum));
  // Observed with qwen2.5vl:7b (experiment 2): boxes in a frame ~1.3-1.5x larger than the image sent. Positions are
  // still consistent with each other, so one uniform factor maps them back (no clipping, aspect kept); the
  // converter fits the content into the slide anyway, so only relative placement matters.
  const k = Math.max(1, maxX / width, maxY / height);
  if (k > 1.02) warnings.push(`Coordinates exceeded the image by ${Math.round((k - 1) * 100)}%; rescaled uniformly.`);
  const scaleX = (v) => nx(v / k);
  const scaleY = (v) => ny(v / k);

  const ids = new Set(items.map((e) => e?.id).filter((v) => typeof v === 'string'));
  const ref = (v) => (typeof v === 'string' && v && ids.has(v) ? v : undefined);
  let elements = [];
  for (const [i, e] of items.entries()) {
    const id = typeof e?.id === 'string' && e.id ? e.id : `e${i + 1}`;
    const b = Array.isArray(e?.bbox_2d) && e.bbox_2d.length === 4 && e.bbox_2d.every(isNum) ? e.bbox_2d : null;
    if (!TYPES.includes(e?.type) || !b) { notes.push(`Dropped an element without a valid type/box (${JSON.stringify(e).slice(0, 120)}).`); continue; }
    const x1 = Math.min(b[0], b[2]), x2 = Math.max(b[0], b[2]), y1 = Math.min(b[1], b[3]), y2 = Math.max(b[1], b[3]);
    const bbox = { x: scaleX(x1), y: scaleY(y1), w: scaleX(x2) - scaleX(x1), h: scaleY(y2) - scaleY(y1) };
    // A literal "\n" (backslash + n) the model meant as a line break — but not the start of a LaTeX command such as
    // \nabla or \neq inside inline math.
    const content = typeof e.content === 'string' ? e.content.replace(/\\n(?![A-Za-z])/g, '\n').trim() : '';
    const out = { id, bbox };
    if (COLORS.includes(e.color)) out.color = e.color;
    if (e.pen === 'highlighter' || e.pen === 'pen') out.pen = e.pen;
    const unsure = typeof e.unsure === 'string' && e.unsure.trim() ? e.unsure.trim() : '';
    if (e.type === 'table') {
      // Rows come as arrays of cell strings (or as a Markdown table in `content`); cell markers become spans, never characters.
      const md = !Array.isArray(e.rows) ? parseMarkdownTable(typeof e.content === 'string' ? e.content : '') : null;
      const rawRows = Array.isArray(e.rows) ? e.rows.filter(Array.isArray) : md ?? [];
      const hasSep = typeof e.content === 'string' && /^\s*\|?\s*:?-{2,}/m.test(e.content);
      Object.assign(out, {
        kind: 'table',
        table: { header: typeof e.header === 'boolean' ? e.header : !!md && hasSep, rows: rawRows.map((r) => r.map((c) => parseInline(typeof c === 'string' ? c : String(c ?? '')))) },
      });
      if (!rawRows.length) {
        if (!/[\p{L}\p{N}]{2,}/u.test(content)) { notes.push(`Dropped table ${id}: it had no rows.`); continue; } // nothing readable (e.g. a looping model's ":[["): not a note
        out.kind = 'text'; out.text = content; delete out.table; // no usable rows: keep the words as a note
      }
    } else if (e.type === 'list' || e.type === 'quote' || e.type === 'heading') {
      let blocks = null;
      if (e.type === 'list' && Array.isArray(e.items) && e.items.length) {
        blocks = [{ type: e.ordered ? 'ordered' : 'bullet', items: e.items.filter((x) => typeof x === 'string' && x.trim()).map((x) => parseInline(x.replace(/^\s*(?:[-•·*]|\d{1,3}[.)])\s+/, ''))) }];
      } else if (e.type === 'quote') {
        blocks = [{ type: 'quote', spans: parseInline(content.replace(/^\s*>\s?/, '')) }];
      } else if (e.type === 'heading') {
        blocks = [{ type: 'heading', level: Number.isFinite(e.level) ? Math.max(1, Math.min(4, Math.round(e.level))) : 2, spans: parseInline(content.replace(/^\s*#{1,4}\s+/, '')) }];
      } else if (e.type === 'list' && !Array.isArray(e.items) && content && !content.includes('\n') && !markupToBlocks(content)) {
        // one list element per item (the model's habit): a one-item list now, merged with its neighbours below
        blocks = [{ type: e.ordered ? 'ordered' : 'bullet', items: [parseInline(content)] }]; out._listItem = true;
      } else blocks = markupToBlocks(content); // a list written as lines in `content`
      if (blocks && blocks.length) Object.assign(out, { kind: 'text', blocks: wrapBlocks(blocks), text: blocksPlain(wrapBlocks(blocks)), role: e.type === 'heading' && e.level === 1 ? 'title' : 'body' });
      else Object.assign(out, { kind: 'text', text: wrapInlineCommands(content), role: 'body' });
    } else if (e.type === 'title' || e.type === 'text') {
      Object.assign(out, { kind: 'text', text: wrapInlineCommands(content), role: e.type === 'title' ? 'title' : 'body' });
      // Formatting markers / list / quote / heading lines in a note become structure; a plain note stays exactly as before.
      const blocks = e.type === 'text' || /[*~]|^\s*[-#>]|^\s*\d+[.)]/m.test(content) ? markupToBlocks(content) : null;
      if (blocks) Object.assign(out, { blocks: wrapBlocks(blocks), text: blocksPlain(wrapBlocks(blocks)) });
    } else if (e.type === 'math') {
      Object.assign(out, { kind: 'math', latex: repairLatex(typeof e.content === 'string' ? e.content : '').replace(/^\$+|\$+$/g, '').trim(), role: 'body' });
    } else if (e.type === 'circle' || e.type === 'rectangle') {
      Object.assign(out, { kind: 'shape', shape: e.type === 'circle' ? 'ellipse' : 'rect' });
      if (content) out.text = content;
    } else {
      out.kind = e.type === 'curved_arrow' ? 'curvedArrow' : e.type;
      const p = Array.isArray(e.points) && e.points.length === 4 && e.points.every(isNum) ? e.points : null;
      if (p) { out.from = { x: scaleX(p[0]), y: scaleY(p[1]) }; out.to = { x: scaleX(p[2]), y: scaleY(p[3]) }; }
      // Curves: "via" is a point ON the stroke at its middle (what a model can see); the Bézier control point that
      // puts the curve's middle there is 2·via − (tail + tip)/2. Without it, "bend" gives the bulge side.
      const via = Array.isArray(e.via) && e.via.length === 2 && e.via.every(isNum) ? e.via : null;
      if (via && p && (out.kind === 'curvedArrow' || out.kind === 'curve')) {
        const m = { x: scaleX(via[0]), y: scaleY(via[1]) };
        out.control = { x: 2 * m.x - (out.from.x + out.to.x) / 2, y: 2 * m.y - (out.from.y + out.to.y) / 2 };
      } else if (BENDS.includes(e.bend) && (out.kind === 'curvedArrow' || out.kind === 'curve')) out.bend = e.bend;
      const c = Array.isArray(e.connects) ? e.connects : [];
      const f = ref(c[0]), t = ref(c[1]);
      if (f && f !== id) out.fromId = f;
      if (t && t !== id) out.toId = t;
    }
    const target = ref(e.explains);
    if (target && target !== id && (out.kind === 'text')) {
      out.role = out.role === 'title' ? 'title' : 'annotation';
      out.relations = [{ type: 'annotates', target }];
    } else if (target && target !== id) {
      // A highlight loop or an arrow that belongs to a word (FullDuplex run: the model gave it, the converter dropped it,
      // so the highlighter around 말하기 was reported as an unintended overlap).
      out.relations = [{ type: 'annotates', target }];
    }
    // Empty content where content is required: keep the element visible for review instead of inventing text.
    if ((out.kind === 'text' && !out.text) || (out.kind === 'math' && !out.latex)) {
      notes.push(`Element ${id} (${e.type}) had no readable content and was dropped.`);
      continue;
    }
    elements.push(out);
    out._unsure = unsure;
  }
  elements = mergeListItems(elements, width, height);
  // The model listed every table cell as its own element? Aligned cells covering the page become one table (conservative rules).
  if (!elements.some((e) => e.kind === 'table')) {
    const det = detectGridTable(elements, width, height);
    if (det) {
      const ids = new Set(det.ids);
      for (let i = elements.length - 1; i >= 0; i--) if (ids.has(elements[i].id)) elements.splice(i, 1);
      elements.push({ id: 'tbl1', kind: 'table', bbox: det.bbox, table: det.table, _unsure: det.table.header ? '' : 'Table inferred from aligned cells: check whether the first row is a header.' });
      warnings.push(`Grouped ${det.ids.length} aligned cells into one table (${det.table.rows.length}×${det.table.rows[0].length}).`);
    }
  }
  const { elements: merged, merged: nMerged } = mergeStackedLines(elements, width, height);
  if (nMerged) warnings.push(`Merged ${nMerged} stacked line(s) into multi-line notes.`);
  for (const out of merged) {
    const reason = out._unsure || localReviewReason(out);
    delete out._unsure;
    if (reason) out.review = { needed: true, reason, transcribed: out.kind === 'math' ? out.latex : out.text ?? '' };
  }
  return { elements: merged, notes: [...notes, ...warnings] };
}

module.exports = { LOCAL_SCHEMA, localToModelIR, repairLatex, wrapInlineCommands, mergeStackedLines };
