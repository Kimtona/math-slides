/**
 * Document Mode placement: the IR elements of a Markdown transcription (reading order, no coordinates) become native
 * elements flowing top to bottom in one column. Heights come from the rendered preview (the app measures every element), so
 * nothing overlaps; content that does not fit on the slide continues on further slides instead of being cut off.
 * Layout Mode (coordinates → convert.ts irToElements) is untouched; this is the second, parallel path.
 */
import type { SlideElement, TableElement, TextElement } from '../model/types';
import { SLIDE_H, SLIDE_W } from '../model/types';
import { newTable, estimateTableHeight, repairTable, scaleCols, TABLE_CELL_PAD_X } from '../model/table';
import { newText } from '../model/defaults';
import { renderTex } from '../math/mathjax';
import { blocksToDoc, CONTENT_AREA, INK, lineWidthEm, spansToNodes, type ConversionResult, type Frame } from './convert';
import type { IRElement, IRIssue, SketchIR } from './ir';
import { spansPlain } from './ir';

const BODY = 20, TABLE_FONT = 18, MATH_FONT = 26, LH = 1.35, BOTTOM = SLIDE_H - 40, MIN_COL_W = 560;
const round = (v: number) => Math.round(v);

/** Column the document is set in: as wide as the image frame, but never narrower than a readable measure. */
export function documentColumn(frame?: Frame): { x: number; w: number } {
  const w = Math.min(CONTENT_AREA.w, Math.max(frame?.w ?? CONTENT_AREA.w, MIN_COL_W));
  const cx = frame ? frame.x + frame.w / 2 : SLIDE_W / 2;
  return { x: round(Math.max(CONTENT_AREA.x, Math.min(SLIDE_W - CONTENT_AREA.x - w, cx - w / 2))), w: round(w) };
}

function estimateText(e: IRElement, w: number): number {
  const usable = Math.max(40, w - 8);
  let h = 0;
  for (const b of e.blocks ?? []) {
    if ('items' in b) h += b.items.reduce((n, it) => n + Math.max(1, Math.ceil((lineWidthEm(spansPlain(it)) * BODY * 1.06) / (usable - 2 * BODY))) * BODY * LH, 0);
    else {
      const fs = b.type === 'heading' ? Math.min(BODY * 1.6, BODY + (5 - b.level) * 3 + 4) : BODY;
      h += Math.max(1, Math.ceil((lineWidthEm(spansPlain(b.spans)) * fs * 1.06) / (b.type === 'quote' ? usable - 2 * BODY : usable))) * fs * LH;
    }
  }
  return round(h + 6);
}

/** Pass 1: build every element (estimated heights), flowed from the frame's top. `reflowDocument` re-flows with measured heights. */
export function buildDocumentElements(ir: SketchIR, frame?: Frame): ConversionResult {
  const issues: IRIssue[] = [];
  const col = documentColumn(frame);
  const map: Record<string, string[]> = {};
  const els: SlideElement[] = [];
  for (const e of ir.elements) {
    let el: SlideElement | null = null;
    if (e.kind === 'text' && (e.blocks || e.text)) {
      const t = newText(col.x, 0, { w: col.w, doc: e.blocks ? blocksToDoc(e.blocks, BODY) : { type: 'doc', content: [{ type: 'paragraph', content: spansToNodes([{ text: e.text ?? '' }]) }] }, style: { fontSize: BODY, align: 'left', color: INK[e.color ?? 'black'] } });
      t.h = estimateText(e, col.w);
      el = t;
    } else if (e.kind === 'math') {
      const latex = e.latex ?? '';
      const r = renderTex(latex, true);
      let fs = MATH_FONT, w = col.w, h = 60;
      if ('error' in r && r.error) issues.push({ severity: 'error', code: 'latex', id: e.id, message: `LaTeX does not render: ${r.error}` });
      else {
        const m = r as { widthEm: number; heightEm: number };
        const maxW = col.w - 24;
        if (m.widthEm * fs > maxW) fs = Math.max(10, Math.floor(maxW / m.widthEm));
        w = round(m.widthEm * fs + 24); h = round((m.heightEm + 0.3) * fs);
      }
      const t = newText(round(col.x + (col.w - w) / 2), 0, { w: round(w), doc: { type: 'doc', content: [{ type: 'mathBlock', attrs: { latex } }] }, style: { fontSize: fs, align: 'center', color: INK[e.color ?? 'black'] } });
      t.h = h;
      el = t;
    } else if (e.kind === 'table' && e.table) {
      const t = e.table, nRows = t.rows.length, nCols = t.rows[0].length;
      const colEm = Array.from({ length: nCols }, (_, c) => Math.max(1, ...t.rows.map((r) => lineWidthEm(spansPlain(r[c])))));
      let fs = TABLE_FONT;
      const natural = (f: number) => colEm.map((em) => em * f * 1.06 + 2 * TABLE_CELL_PAD_X + 8);
      const sum = (v: number[]) => v.reduce((a, x) => a + x, 0);
      if (sum(natural(fs)) > col.w) fs = Math.max(12, Math.floor((fs * col.w) / sum(natural(fs))));
      const widths = natural(fs), total = round(Math.min(col.w, Math.max(sum(widths), Math.min(col.w, 360))));
      const tb = newTable(0, 0, { rows: nRows, cols: nCols, w: total });
      tb.cols = scaleCols(widths, total);
      tb.rows = t.rows.map((r) => r.map((c) => ({ doc: { type: 'doc', content: [{ type: 'paragraph', content: c.length ? spansToNodes(c, false) : [] }] } as any })));
      tb.textStyle = { ...tb.textStyle, fontSize: fs, color: INK[e.color ?? 'black'] };
      tb.headerRow = t.header;
      tb.w = total; tb.x = col.x; tb.h = estimateTableHeight(nRows, fs, LH);
      el = repairTable(tb);
    }
    if (!el) { issues.push({ severity: 'info', code: 'skipped', id: e.id, message: `Element ${e.id} has nothing Document Mode can place.` }); continue; }
    map[e.id] = [el.id];
    els.push(el);
  }
  const conv: ConversionResult = { elements: els, map, placement: { ox: 0, oy: 0, ux: 1, uy: 1, sx: 1, sy: 1, area: { x: col.x, y: frame?.y ?? CONTENT_AREA.y, w: col.w, h: BOTTOM - (frame?.y ?? CONTENT_AREA.y) } } as any, issues };
  return conv;
}

/** Build + flow (estimated heights unless `heights` are given). */
export function documentToElements(ir: SketchIR, frame?: Frame, heights?: Record<string, number>): ConversionResult {
  return reflowDocument(buildDocumentElements(ir, frame), heights, frame);
}

const isHeading = (el: SlideElement) => el.type === 'text' && el.doc.content?.length === 1 && el.doc.content[0].type === 'paragraph' && Number(el.doc.content[0].attrs?.fontSize) > (el as TextElement).style.fontSize;

/**
 * Stacks `conv.elements` (all of them, in reading order) from the frame's top using measured heights (`heights[id]`, else the
 * estimate), starting a new slide whenever the next element would cross the bottom margin. A heading is never left alone at the
 * end of a slide; a table taller than a whole slide is split between rows (the header row repeats). Returns `conv` with
 * `elements` = first slide and `pages` = the following ones.
 */
export function reflowDocument(conv: ConversionResult, heights: Record<string, number> | undefined, frame?: Frame): ConversionResult {
  const all = conv.pages ? [conv.elements, ...conv.pages].flat() : conv.elements;
  const top1 = frame?.y ?? CONTENT_AREA.y;
  const pages: SlideElement[][] = [[]];
  let y = top1;
  const gapBefore = (el: SlideElement, first: boolean) => (first ? 0 : isHeading(el) ? 20 : el.type === 'table' || (el.type === 'text' && el.doc.content?.[0]?.type === 'mathBlock') ? 14 : 8);
  const issues = conv.issues.filter((i) => i.code !== 'overflow');
  const startPage = () => { pages.push([]); y = CONTENT_AREA.y; };
  for (const el of all) {
    const h = round(heights?.[el.id] ?? el.h);
    el.h = h;
    let page = pages[pages.length - 1];
    if (y + gapBefore(el, !page.length) + h > BOTTOM && page.length) {
      const last = page[page.length - 1];
      startPage();
      if (isHeading(last)) { const prev = pages[pages.length - 2]; prev.pop(); last.y = y; pages[pages.length - 1].push(last); y += last.h; }
      page = pages[pages.length - 1];
    }
    if (el.type === 'table' && y + h > BOTTOM && el.rows.length > 1) {
      // taller than what is left of an empty slide: split between rows
      const rowH = h / el.rows.length, rest = [...el.rows];
      const head = el.headerRow ? rest.shift()! : null;
      let first = true;
      while (rest.length) {
        const room = BOTTOM - y - (head ? rowH : 0);
        const take = Math.max(1, Math.min(rest.length, Math.floor(room / rowH)));
        const part: TableElement = first ? el : { ...structuredClone(el), id: newTable(0, 0).id };
        part.rows = [...(head && !first ? [structuredClone(head)] : head && first ? [head] : []), ...rest.splice(0, take)];
        part.h = round(part.rows.length * rowH); part.y = y;
        pages[pages.length - 1].push(part); y += part.h;
        if (rest.length) { startPage(); }
        first = false;
      }
      continue;
    }
    if (h > BOTTOM - CONTENT_AREA.y) issues.push({ severity: 'warning', code: 'overflow', id: el.id, message: 'This block is taller than a whole slide; it runs past the bottom edge (split it after applying).' });
    y += gapBefore(el, !page.length);
    el.y = round(y);
    page.push(el);
    y += h;
  }
  if (pages.length > 1) issues.push({ severity: 'info', code: 'pages', message: `The content is longer than one slide: ${pages.length - 1} more slide(s) will be added after this one.` });
  return { ...conv, elements: pages[0], pages: pages.slice(1), issues };
}
