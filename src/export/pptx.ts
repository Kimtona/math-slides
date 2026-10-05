import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import type { Asset, Deck, ImageElement, LineElement, ShapeElement, TextElement } from '../model/types';
import { sourceRect } from '../model/imageCrop';
import { FOOTER_COLOR, FOOTER_FONT_SIZE } from '../model/typography';
import { tokenColor } from '../editor/codeHighlight';
import { INLINE_CODE_BACKGROUND, INLINE_CODE_FONT } from '../model/textFormatting';

// Slide units are CSS px on a 1280×720 canvas = 13.333×7.5in (PowerPoint widescreen).
const IN = (px: number) => px / 96;
const PT = (px: number) => px * 0.75;
export const PPT_FONT = 'NanumSquare';

type Slide = PptxGenJS.Slide;
type TextProps = PptxGenJS.TextProps;
type TextPropsOptions = PptxGenJS.TextPropsOptions;

/** Any CSS color → "RRGGBB". */
function hex(c: string): string {
  c = c.trim();
  if (c.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    return h.slice(0, 6).toUpperCase();
  }
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(c);
  if (m) return [m[1], m[2], m[3]].map((v) => Math.round(+v).toString(16).padStart(2, '0')).join('').toUpperCase();
  return '000000';
}

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

interface Rect { x: number; y: number; w: number; h: number }

function relRect(el: Element, origin: DOMRect): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
}

/** Self-contained SVG of an equation, colored and sized for a picture shape. */
function mathSvgData(svg: SVGSVGElement, rect: Rect): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const color = '#' + hex(getComputedStyle(svg).color);
  // Large intrinsic size so the PNG fallback that PowerPoint keeps alongside the SVG is sharp too.
  clone.setAttribute('width', String(Math.max(1, Math.round(rect.w * 4))));
  clone.setAttribute('height', String(Math.max(1, Math.round(rect.h * 4))));
  clone.removeAttribute('style');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const str = new XMLSerializer().serializeToString(clone).replace(/currentColor/g, color);
  return 'data:image/svg+xml;base64,' + b64(str);
}

function addMath(s: Slide, svg: SVGSVGElement | null, origin: DOMRect) {
  if (!svg) return;
  const r = relRect(svg, origin);
  if (r.w < 0.5 || r.h < 0.5) return;
  s.addImage({ data: mathSvgData(svg, r), x: IN(r.x), y: IN(r.y), w: IN(r.w), h: IN(r.h), altText: svg.closest('[data-latex]')?.getAttribute('data-latex') ?? 'equation' });
}

// ---------- text ----------

/** slide id → 1-based slide number, for TOC links (PowerPoint links to the slide part, so it survives reordering in PowerPoint). */
let slideNumbers: Record<string, number> = {};

/** Hyperlink of the <a> around a text node: internal (#slide-<id>) or external (https://…). */
function linkOf(node: Node): TextPropsOptions['hyperlink'] | undefined {
  const a = node.parentElement?.closest('a[href]');
  const href = a?.getAttribute('href');
  if (!href) return undefined;
  if (href.startsWith('#slide-')) {
    const n = slideNumbers[href.slice('#slide-'.length)];
    return n ? { slide: n, tooltip: a!.textContent?.trim() } : undefined;
  }
  return /^https?:\/\//.test(href) ? { url: href, tooltip: href } : undefined;
}

function runOptions(textNode: Node, base: TextElement, text: string): TextPropsOptions {
  const parent = textNode.parentElement!;
  const cs = getComputedStyle(parent);
  const o: TextPropsOptions = {
    fontFace: parent.closest('code') ? INLINE_CODE_FONT : PPT_FONT,
    fontSize: PT(parseFloat(cs.fontSize) || base.style.fontSize),
    color: hex(cs.color),
    bold: parseInt(cs.fontWeight) >= 600,
    italic: cs.fontStyle === 'italic',
    lang: /[ㄱ-힝]/.test(text) ? 'ko-KR' : 'en-US',
  };
  if (parent.closest('u')) o.underline = { style: 'sng' };
  if (parent.closest('s')) o.strike = 'sngStrike';
  const highlight = parent.closest('mark');
  if (highlight) o.highlight = hex(getComputedStyle(highlight).backgroundColor);
  else if (parent.closest('code')) o.highlight = hex(INLINE_CODE_BACKGROUND);
  const link = linkOf(textNode);
  if (link) o.hyperlink = link;
  return o;
}

function listInfo(p: Element, content: Element, base: TextElement) {
  // <li><p> or, for linked TOC entries, <li><a><p>
  const parent = p.parentElement;
  const li = parent?.tagName === 'LI' ? parent : parent?.tagName === 'A' && parent.parentElement?.tagName === 'LI' ? parent.parentElement : null;
  if (!li) return null;
  let level = -1;
  for (let n: Element | null = li; n && n !== content; n = n.parentElement) if (n.tagName === 'UL' || n.tagName === 'OL') level++;
  const list = li.parentElement!;
  const indent = PT(base.style.fontSize * 1.3); // matches CSS `padding-left: 1.3em`
  const first = li.querySelector('p') === p;
  const ordered = list.tagName === 'OL';
  return { level: Math.max(0, level), first, ordered, indent, start: Number(list.getAttribute('start') ?? 1), index: [...list.children].indexOf(li) };
}

/** Text runs of one paragraph (<p>), with paragraph-level options on the first run. */
function paragraphRuns(p: Element, content: Element, base: TextElement, last: boolean): TextProps[] {
  const runs: TextProps[] = [];
  let soft = false;
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = n.textContent ?? '';
      if (!text) return;
      runs.push({ text, options: { ...runOptions(n, base, text), ...(soft ? { softBreakBefore: true } : {}) } });
      soft = false;
    } else if (n instanceof HTMLBRElement) {
      if (!n.classList.contains('ProseMirror-trailingBreak')) soft = true;
    } else n.childNodes.forEach(walk);
  };
  walk(p);
  if (soft) runs.push({ text: '', options: { softBreakBefore: true, fontSize: PT(base.style.fontSize) } });
  if (!runs.length) runs.push({ text: '', options: { fontSize: PT(base.style.fontSize), fontFace: PPT_FONT } });

  const li = listInfo(p, content, base);
  if (li) {
    runs[0].options!.indentLevel = li.level;
    runs[0].options!.bullet = li.first
      ? li.ordered ? { type: 'number', indent: li.indent, numberStartAt: li.start } : { indent: li.indent }
      : false;
  }
  // Lines sized with #/##/### get their own exact line spacing (font size × line height).
  const pSize = parseFloat(getComputedStyle(p).fontSize);
  if (pSize && Math.abs(pSize - base.style.fontSize) > 0.01) {
    const spacing = PT(pSize * base.style.lineHeight);
    runs.forEach((r) => { r.options!.lineSpacing = spacing; });
  }
  if (!last) runs[runs.length - 1].options!.breakLine = true;
  return runs;
}

function boxOptions(base: TextElement, r: Rect): PptxGenJS.TextPropsOptions {
  // A little extra width so PowerPoint's slightly different text metrics don't cause an extra wrap.
  const slack = Math.max(4, r.w * 0.02);
  let { x, w } = r;
  if (base.style.align === 'left') w += slack;
  else if (base.style.align === 'center') { x -= slack / 2; w += slack; }
  else { x -= slack; w += slack; }
  return {
    x: IN(x), y: IN(r.y), w: IN(w), h: IN(r.h),
    margin: 0, valign: 'top', wrap: true, fit: 'none',
    fontFace: PPT_FONT, fontSize: PT(base.style.fontSize), color: hex(base.style.color),
    align: base.style.align, lineSpacing: PT(base.style.fontSize * base.style.lineHeight),
    paraSpaceBefore: 0, paraSpaceAfter: 0,
  };
}

/** Consecutive plain paragraphs → one editable PowerPoint text box. */
function addTextGroup(s: Slide, base: TextElement, paras: Element[], content: Element, origin: DOMRect, boxRect: Rect, isWholeBox: boolean) {
  const first = relRect(paras[0], origin), lastR = relRect(paras[paras.length - 1], origin);
  const top = isWholeBox ? boxRect.y : first.y;
  const bottom = isWholeBox ? boxRect.y + boxRect.h : lastR.y + lastR.h;
  const runs = paras.flatMap((p, i) => paragraphRuns(p, content, base, i === paras.length - 1));
  s.addText(runs, boxOptions(base, { x: boxRect.x, y: top, w: boxRect.w, h: Math.max(bottom - top, 1) }));
}

/**
 * A paragraph containing inline equations. PowerPoint can't put pictures inside a text run,
 * so each line is split at the equations: text pieces become small text boxes, equations
 * become SVG pictures, all at the positions measured in the browser.
 */
function addFragments(s: Slide, base: TextElement, p: Element, content: Element, origin: DOMRect) {
  const li = listInfo(p, content, base);
  if (li?.first) {
    const pr = relRect(p, origin);
    const marker = li.ordered ? `${li.start + li.index}.` : '•';
    const fs = base.style.fontSize;
    s.addText(marker, {
      x: IN(pr.x - fs * 1.3), y: IN(pr.y), w: IN(fs * 1.3), h: IN(fs * base.style.lineHeight),
      margin: 0, valign: 'top', wrap: false, fontFace: PPT_FONT, fontSize: PT(fs), color: hex(base.style.color),
    });
  }
  const range = document.createRange();
  const flushText = (node: Text, start: number, end: number, rects: DOMRect[]) => {
    const text = node.data.slice(start, end);
    if (!text.trim() || !rects.length) return;
    const left = Math.min(...rects.map((r) => r.left)), right = Math.max(...rects.map((r) => r.right));
    const top = Math.min(...rects.map((r) => r.top)), bottom = Math.max(...rects.map((r) => r.bottom));
    const o = runOptions(node, base, text);
    s.addText([{ text, options: o }], {
      x: IN(left - origin.left), y: IN(top - origin.top), w: IN(right - left + Math.max(3, (right - left) * 0.03)), h: IN(bottom - top),
      margin: 0, valign: 'top', wrap: false, fit: 'none', fontFace: PPT_FONT, fontSize: o.fontSize, color: o.color,
    });
  };
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n as Text;
      let start = 0, lineTop: number | null = null, rects: DOMRect[] = [];
      for (let i = 0; i < t.data.length; i++) {
        range.setStart(t, i);
        range.setEnd(t, i + 1);
        const r = range.getClientRects()[0];
        if (!r) continue;
        if (lineTop !== null && Math.abs(r.top - lineTop) > 2) {
          flushText(t, start, i, rects);
          start = i; rects = [];
        }
        lineTop = r.top;
        rects.push(r);
      }
      flushText(t, start, t.data.length, rects);
    } else if (n instanceof Element && n.classList.contains('math-inline')) {
      addMath(s, n.querySelector('svg'), origin);
    } else n.childNodes.forEach(walk);
  };
  walk(p);
}

/**
 * Code Block → native rounded rectangle (its light-gray background) + editable monospace text at the
 * measured inner area, one paragraph per code line (leading spaces kept).
 */
function addCodeBlock(s: Slide, pre: Element, origin: DOMRect) {
  const r = relRect(pre, origin);
  const cs = getComputedStyle(pre);
  const code = pre.querySelector('code') ?? pre;
  const ccs = getComputedStyle(code);
  const px = (v: string) => parseFloat(v) || 0;
  const radius = Math.min(px(cs.borderTopLeftRadius), r.w / 2, r.h / 2);
  s.addShape('roundRect', { x: IN(r.x), y: IN(r.y), w: IN(r.w), h: IN(r.h), fill: { color: hex(cs.backgroundColor) }, rectRadius: IN(radius), objectName: 'Code Block' });
  const fs = px(ccs.fontSize);
  const lh = px(ccs.lineHeight) || fs * 1.45;
  const color = hex(ccs.color);
  // Per-token runs from the shared tokenizer's output (spans carrying highlight classes); one paragraph per line.
  const toks: { text: string; color: string }[] = [];
  const walk = (n: Node, classes: string[]) => {
    if (n.nodeType === Node.TEXT_NODE) { if (n.textContent) toks.push({ text: n.textContent, color: hex(tokenColor(classes) ?? ccs.color) }); return; }
    if (!(n instanceof Element) || n.tagName === 'BR') return;
    n.childNodes.forEach((c) => walk(c, [...classes, ...n.classList]));
  };
  code.childNodes.forEach((c) => walk(c, []));
  const runs: TextProps[] = [];
  const base = { fontFace: INLINE_CODE_FONT, fontSize: PT(fs) };
  const lines: { text: string; color: string }[][] = [[]];
  for (const t of toks) t.text.split('\n').forEach((part, i) => { if (i) lines.push([]); if (part) lines[lines.length - 1].push({ text: part, color: t.color }); });
  if (lines.length > 1 && !lines[lines.length - 1].length) lines.pop();
  lines.forEach((line, i) => {
    const last = i === lines.length - 1;
    if (!line.length) runs.push({ text: '', options: { ...base, color, ...(last ? {} : { breakLine: true }) } });
    line.forEach((t, j) => runs.push({ text: t.text, options: { ...base, color: t.color, ...(!last && j === line.length - 1 ? { breakLine: true } : {}) } }));
  });
  const pl = px(cs.paddingLeft), pr = px(cs.paddingRight), pt = px(cs.paddingTop), pb = px(cs.paddingBottom);
  s.addText(runs, {
    x: IN(r.x + pl), y: IN(r.y + pt), w: IN(r.w - pl - pr + Math.max(4, r.w * 0.02)), h: IN(Math.max(1, r.h - pt - pb)),
    margin: 0, valign: 'top', wrap: true, fit: 'none', align: 'left',
    fontFace: INLINE_CODE_FONT, fontSize: PT(fs), color, lineSpacing: PT(lh), paraSpaceBefore: 0, paraSpaceAfter: 0, objectName: 'Code',
  });
}

/** Quote → native vertical line where the editor draws the left border. */
function addQuoteLine(s: Slide, quote: Element, origin: DOMRect) {
  const r = relRect(quote, origin);
  const cs = getComputedStyle(quote);
  const bw = parseFloat(cs.borderLeftWidth) || 0;
  if (!bw) return;
  s.addShape('line', { x: IN(r.x + bw / 2), y: IN(r.y), w: 0, h: IN(r.h), line: { color: hex(cs.borderLeftColor), width: PT(bw) }, objectName: 'Quote Line' });
}

/** Callout → native rounded background shape plus its icon as editable text (emoji font falls back in PowerPoint). */
function addCallout(s: Slide, callout: Element, origin: DOMRect) {
  const r = relRect(callout, origin);
  const cs = getComputedStyle(callout);
  const radius = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, r.w / 2, r.h / 2);
  s.addShape('roundRect', { x: IN(r.x), y: IN(r.y), w: IN(r.w), h: IN(r.h), fill: { color: hex(cs.backgroundColor) }, rectRadius: IN(radius), objectName: 'Callout' });
  const iconEl = callout.querySelector(':scope > .callout-icon');
  if (!iconEl) return;
  const ir = relRect(iconEl, origin);
  const ics = getComputedStyle(iconEl);
  const fs = parseFloat(ics.fontSize) || 25;
  s.addText(iconEl.textContent ?? '', {
    x: IN(ir.x), y: IN(ir.y), w: IN(ir.w + fs * 0.6), h: IN(Math.max(ir.h, fs * 1.2)),
    margin: 0, valign: 'top', wrap: false, fit: 'none', align: 'left',
    fontFace: 'Apple Color Emoji', fontSize: PT(fs), objectName: 'Callout Icon',
  });
}

/** Academic Block → native body shape (rounded, tinted, bordered), native header shape, editable type/title text. */
function addAcademicBlock(s: Slide, block: Element, origin: DOMRect) {
  const r = relRect(block, origin);
  const cs = getComputedStyle(block);
  const px = (v: string) => parseFloat(v) || 0;
  const radius = Math.min(px(cs.borderTopLeftRadius), r.w / 2, r.h / 2);
  const bw = px(cs.borderTopWidth);
  s.addShape('roundRect', {
    x: IN(r.x), y: IN(r.y), w: IN(r.w), h: IN(r.h), rectRadius: IN(radius), objectName: 'Block Body',
    fill: { color: hex(cs.backgroundColor) }, line: bw ? { color: hex(cs.borderTopColor), width: PT(bw) } : undefined,
  });
  const head = block.querySelector(':scope > .ablock-head');
  if (!head) return;
  const hr = relRect(head, origin);
  const hcs = getComputedStyle(head);
  // Rounded top corners only: a rounded header plus a square strip over its lower half (no custom geometry needed).
  const fill = { color: hex(hcs.backgroundColor) };
  s.addShape('roundRect', { x: IN(hr.x), y: IN(hr.y), w: IN(hr.w), h: IN(hr.h), fill, rectRadius: IN(Math.min(radius, hr.h / 2)), objectName: 'Block Header' });
  s.addShape('rect', { x: IN(hr.x), y: IN(hr.y + hr.h / 2), w: IN(hr.w), h: IN(hr.h / 2), fill, objectName: 'Block Header Fill' });
  const fs = px(hcs.fontSize), color = hex(hcs.color);
  const runs: TextProps[] = [];
  head.querySelectorAll(':scope > .ablock-type, :scope > .ablock-sep, :scope > .ablock-title').forEach((e) => {
    const bold = getComputedStyle(e).fontWeight === '700' || Number(getComputedStyle(e).fontWeight) >= 600;
    if (e.textContent) runs.push({ text: e.textContent, options: { fontFace: PPT_FONT, fontSize: PT(fs), color, bold } });
  });
  const padL = px(hcs.paddingLeft);
  s.addText(runs, { x: IN(hr.x + padL), y: IN(hr.y), w: IN(hr.w - padL * 2), h: IN(hr.h), margin: 0, valign: 'middle', wrap: true, fit: 'none', align: 'left', fontFace: PPT_FONT, fontSize: PT(fs), color, objectName: 'Block Title' });
}

/** Content area of an Academic Block body: inside its padding. */
function blockContentRect(block: Element, origin: DOMRect): Rect {
  const body = block.querySelector(':scope > .ablock-body') ?? block;
  const r = relRect(body, origin);
  const cs = getComputedStyle(body);
  const l = parseFloat(cs.paddingLeft) || 0, rr = parseFloat(cs.paddingRight) || 0;
  return { x: r.x + l, y: r.y, w: r.w - l - rr, h: r.h };
}

/** Content area of a callout: its body column. */
function calloutContentRect(callout: Element, origin: DOMRect): Rect {
  return relRect(callout.querySelector(':scope > .callout-body') ?? callout, origin);
}

/** Text area of a quote: right of its border and padding. */
function quoteContentRect(quote: Element, origin: DOMRect): Rect {
  const r = relRect(quote, origin);
  const cs = getComputedStyle(quote);
  const inset = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
  return { x: r.x + inset, y: r.y, w: r.w - inset, h: r.h };
}

function addTextElement(s: Slide, el: TextElement, dom: Element, origin: DOMRect) {
  const boxRect = relRect(dom, origin);
  if (el.style.fill) {
    s.addShape('rect', { x: IN(boxRect.x), y: IN(boxRect.y), w: IN(boxRect.w), h: IN(boxRect.h), fill: { color: hex(el.style.fill) } });
  }
  const content = dom.querySelector('.tb-content');
  if (!content) return;
  const blocks = [...content.querySelectorAll('p, .math-block, pre')];
  // A plain box (only paragraphs) becomes one text box with the element's own frame.
  const plain = !content.querySelector('.math-block, .math-inline, pre, blockquote, .callout, .ablock');
  let group: Element[] = [];
  let groupQuote: Element | null = null; // innermost enclosing quote or callout of the current group
  const flush = () => {
    if (group.length) addTextGroup(s, el, group, content, origin, groupQuote ? (groupQuote.classList.contains('callout') ? calloutContentRect(groupQuote, origin) : groupQuote.classList.contains('ablock') ? blockContentRect(groupQuote, origin) : quoteContentRect(groupQuote, origin)) : boxRect, plain);
    group = [];
  };
  const drawnQuotes = new Set<Element>();
  for (const b of blocks) {
    // Quote lines (also of enclosing quotes), drawn once per quote.
    for (let q = b.closest('blockquote, .callout, .ablock'); q && content.contains(q); q = q.parentElement?.closest('blockquote, .callout, .ablock') ?? null) {
      if (!drawnQuotes.has(q)) { drawnQuotes.add(q); if (q.classList.contains('callout')) addCallout(s, q, origin); else if (q.classList.contains('ablock')) addAcademicBlock(s, q, origin); else addQuoteLine(s, q, origin); }
    }
    const quote = b.closest('blockquote, .callout, .ablock');
    if (quote !== groupQuote) { flush(); groupQuote = quote; }
    if (b.tagName === 'PRE') { flush(); addCodeBlock(s, b, origin); }
    else if (b.classList.contains('math-block')) { flush(); addMath(s, b.querySelector('svg'), origin); }
    else if (b.querySelector('.math-inline')) { flush(); addFragments(s, el, b, content, origin); }
    else group.push(b);
  }
  flush();
}

// ---------- shapes, lines, images ----------

function addShape(pptx: PptxGenJS, s: Slide, el: ShapeElement) {
  const sw = el.stroke ? el.strokeWidth : 0;
  // SVG strokes are drawn inside the element box; PowerPoint centers them on the outline.
  const x = el.x + sw / 2, y = el.y + sw / 2, w = Math.max(1, el.w - sw), h = Math.max(1, el.h - sw);
  const type = el.shape === 'ellipse' ? pptx.ShapeType.ellipse : el.shape === 'roundRect' ? pptx.ShapeType.roundRect : pptx.ShapeType.rect;
  s.addShape(type, {
    x: IN(x), y: IN(y), w: IN(w), h: IN(h),
    fill: el.fill ? { color: hex(el.fill) } : undefined,
    line: el.stroke ? { color: hex(el.stroke), width: PT(sw) } : undefined,
    rectRadius: el.shape === 'roundRect' ? IN(Math.min(el.radius, w / 2, h / 2)) : undefined,
  });
}

function addLine(pptx: PptxGenJS, s: Slide, el: LineElement) {
  s.addShape(pptx.ShapeType.line, {
    x: IN(Math.min(el.x1, el.x2)), y: IN(Math.min(el.y1, el.y2)),
    w: IN(Math.abs(el.x2 - el.x1)), h: IN(Math.abs(el.y2 - el.y1)),
    flipH: el.x2 < el.x1, flipV: el.y2 < el.y1,
    line: {
      color: hex(el.stroke), width: PT(el.strokeWidth), dashType: el.dashed ? 'dash' : 'solid',
      endArrowType: el.arrowEnd ? 'triangle' : undefined, beginArrowType: el.arrowStart ? 'triangle' : undefined,
    },
  });
}

const PPT_NATIVE = /^image\/(png|jpe?g|gif|svg\+xml)$/;
const pngCache = new Map<string, string>();

/** PowerPoint can't read WebP/AVIF/BMP: convert to PNG. SVGs get explicit pixel sizes. */
async function imageData(a: Asset): Promise<string> {
  if (a.mime === 'image/svg+xml') {
    const svg = decodeURIComponent(escape(atob(a.dataUrl.split(',')[1] ?? '')));
    if (/<svg[^>]*\swidth=/.test(svg.slice(0, 2000))) return a.dataUrl;
    const sized = svg.replace(/<svg\b/, `<svg width="${a.width}" height="${a.height}"`);
    return 'data:image/svg+xml;base64,' + b64(sized);
  }
  if (PPT_NATIVE.test(a.mime)) return a.dataUrl;
  const hit = pngCache.get(a.id);
  if (hit) return hit;
  const img = new Image();
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('image load failed')); img.src = a.dataUrl; });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  const png = c.toDataURL('image/png');
  pngCache.set(a.id, png);
  return png;
}

async function addImage(s: Slide, el: ImageElement, assets: Record<string, Asset>) {
  const a = assets[el.assetId];
  if (!a) return;
  const data = await imageData(a);
  if (!el.crop) {
    s.addImage({ data, x: IN(el.x), y: IN(el.y), w: IN(el.w), h: IN(el.h) });
    return;
  }
  // Native PowerPoint crop (<a:srcRect>): the full-resolution original is embedded and only
  // the cropped part is shown, so the crop stays adjustable in PowerPoint (Picture Format → Crop).
  // w/h = the whole image at its displayed scale; sizing.x/y/w/h = the visible frame inside it.
  const R = sourceRect(el, el.crop);
  s.addImage({
    data, x: IN(el.x), y: IN(el.y), w: IN(R.w), h: IN(R.h),
    sizing: { type: 'crop', x: IN(el.x - R.x), y: IN(el.y - R.y), w: IN(el.w), h: IN(el.h) },
  });
}

// ---------- XML clean-up ----------

/**
 * pptxgenjs writes one <a:pPr> per run; PowerPoint only allows one per paragraph (first child).
 * Also fix the East-Asian charset (Hangul = 129).
 */
async function fixXml(blob: Blob): Promise<Blob> {
  const zip = await JSZip.loadAsync(blob);
  const files = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  for (const f of files) {
    let xml = await zip.file(f)!.async('string');
    xml = xml.replace(/<a:p>([\s\S]*?)<\/a:p>/g, (_m, inner: string) => {
      let seen = false;
      inner = inner.replace(/<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g, (pp, offset: number) => {
        if (!seen && offset === 0) { seen = true; return pp; }
        return '';
      });
      return `<a:p>${inner}</a:p>`;
    });
    xml = xml.replace(/(<a:ea typeface="[^"]*" pitchFamily="\d+" charset=")-122"/g, '$1-127"');
    zip.file(f, xml);
  }
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', compression: 'DEFLATE' });
}

/** Footer: slide number (bottom-left) and reference (bottom-right, only when non-empty). */
function addFooter(s: Slide, slideDom: Element, origin: DOMRect) {
  const common = {
    margin: 0, valign: 'top' as const, fit: 'none' as const, fontFace: PPT_FONT,
    fontSize: PT(FOOTER_FONT_SIZE), color: hex(FOOTER_COLOR), lineSpacing: PT(FOOTER_FONT_SIZE * 1.3),
  };
  const num = slideDom.querySelector('[data-footer-num]');
  if (num) {
    const r = relRect(num, origin);
    s.addText(num.textContent ?? '', { ...common, x: IN(r.x), y: IN(r.y), w: IN(r.w + 24), h: IN(r.h), align: 'left', wrap: false, objectName: 'Slide Number' });
  }
  const ref = slideDom.querySelector('[data-footer-ref]');
  if (ref?.textContent?.trim()) {
    const r = relRect(ref, origin);
    const slack = Math.max(6, r.w * 0.03); // grows to the left, like the editor
    // Runs keep each citation's hyperlink to its paper.
    const runs: TextProps[] = [];
    const walk = (n: Node) => {
      if (n.nodeType === Node.TEXT_NODE) {
        if (n.textContent) runs.push({ text: n.textContent, options: { color: hex(FOOTER_COLOR), hyperlink: linkOf(n) } });
      } else n.childNodes.forEach(walk);
    };
    walk(ref);
    s.addText(runs, { ...common, x: IN(r.x - slack), y: IN(r.y), w: IN(r.w + slack), h: IN(r.h), align: 'right', wrap: true, objectName: 'Reference' });
  }
}

export async function buildPptx(deck: Deck, assets: Record<string, Asset>, root: HTMLElement): Promise<Blob> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = deck.title;
  pptx.theme = { headFontFace: PPT_FONT, bodyFontFace: PPT_FONT };

  slideNumbers = Object.fromEntries(deck.slides.map((x, i) => [x.id, i + 1]));
  for (const slide of deck.slides) {
    const s = pptx.addSlide();
    s.background = { color: hex(slide.background) };
    const slideDom = root.querySelector(`[data-slide-id="${slide.id}"]`);
    if (!slideDom) continue;
    const origin = slideDom.getBoundingClientRect();
    for (const el of slide.elements) {
      if (el.type === 'shape') addShape(pptx, s, el);
      else if (el.type === 'line') addLine(pptx, s, el);
      else if (el.type === 'image') await addImage(s, el, assets);
      else {
        const dom = slideDom.querySelector(`[data-el-id="${el.id}"]`);
        if (dom) addTextElement(s, el, dom, origin);
      }
    }
    addFooter(s, slideDom, origin);
    if (slide.notes.trim()) s.addNotes(slide.notes);
  }
  const blob = (await pptx.write({ outputType: 'blob' })) as Blob;
  return fixXml(blob);
}
