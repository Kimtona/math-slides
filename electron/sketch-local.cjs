// Local-model output format (flat, pixel coordinates, Qwen2.5-VL style `bbox_2d`) and its deterministic
// conversion to the shared model IR ({ elements, notes } with 0..1000 coordinates) that src/sketch/ir.ts validates.
// Nothing is invented here: unreadable or inconsistent items are kept and flagged for review, or dropped with a note.

const TYPES = ['title', 'text', 'math', 'circle', 'rectangle', 'arrow', 'line'];
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
          explains: str,
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
  const texts = elements.filter((e) => e.kind === 'text' && e.role !== 'title');
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
  const items = Array.isArray(data?.elements) ? data.elements : [];
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
  const elements = [];
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
    const unsure = typeof e.unsure === 'string' && e.unsure.trim() ? e.unsure.trim() : '';
    if (e.type === 'title' || e.type === 'text') {
      Object.assign(out, { kind: 'text', text: wrapInlineCommands(content), role: e.type === 'title' ? 'title' : 'body' });
    } else if (e.type === 'math') {
      Object.assign(out, { kind: 'math', latex: repairLatex(typeof e.content === 'string' ? e.content : '').replace(/^\$+|\$+$/g, '').trim(), role: 'body' });
    } else if (e.type === 'circle' || e.type === 'rectangle') {
      Object.assign(out, { kind: 'shape', shape: e.type === 'circle' ? 'ellipse' : 'rect' });
      if (content) out.text = content;
    } else {
      out.kind = e.type;
      const p = Array.isArray(e.points) && e.points.length === 4 && e.points.every(isNum) ? e.points : null;
      if (p) { out.from = { x: scaleX(p[0]), y: scaleY(p[1]) }; out.to = { x: scaleX(p[2]), y: scaleY(p[3]) }; }
      const c = Array.isArray(e.connects) ? e.connects : [];
      const f = ref(c[0]), t = ref(c[1]);
      if (f && f !== id) out.fromId = f;
      if (t && t !== id) out.toId = t;
    }
    const target = ref(e.explains);
    if (target && target !== id && (out.kind === 'text')) {
      out.role = out.role === 'title' ? 'title' : 'annotation';
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
