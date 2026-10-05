import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Box, ImageElement, LineElement, SlideElement, TextElement } from '../model/types';
import { clampFrameToSource, coverFrame, cropFrom, cropOf, sourceRect } from '../model/imageCrop';
import { SLIDE_H, SLIDE_W } from '../model/types';
import { lineBox } from '../model/defaults';
import { boxOf, intersects, snap1, snapMove, snapTargets, translate, unionBox, type Guide } from '../model/geometry';
import { currentSlide, useStore } from '../store/store';
import { captionStyle, CitationLabel, ElementBody, elementBoxStyle, footerNumberStyle, footerParts, footerRefStyle, LineSvg, ShapeView, slideNumberText } from '../render/ElementView';
import { extractCitations, resolveCitation } from '../citations/resolve';
import { findCitations } from '../citations/providers';
import { TextEditor } from '../editor/TextEditor';
import { insertImageFiles, insertTextAt } from './insert';
import { scaleParagraphSizes } from '../editor/extensions';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'p1' | 'p2';
const SNAP_PX = 6;
const DRAG_START_PX = 3;

// The canvas scale is needed by pointer handlers that live outside React state.
const view = { scale: 1, slideEl: null as HTMLDivElement | null };

function toSlide(clientX: number, clientY: number) {
  const r = view.slideEl!.getBoundingClientRect();
  return { x: (clientX - r.left) / view.scale, y: (clientY - r.top) / view.scale };
}

/** Tracks a pointer drag on window until release. */
function track(e: React.PointerEvent | PointerEvent, onMove: (ev: PointerEvent, dx: number, dy: number) => void, onUp: (ev: PointerEvent, moved: boolean) => void) {
  const sx = e.clientX, sy = e.clientY;
  let moved = false;
  const move = (ev: PointerEvent) => {
    const dx = (ev.clientX - sx) / view.scale, dy = (ev.clientY - sy) / view.scale;
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_START_PX) return;
    moved = true;
    onMove(ev, dx, dy);
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    onUp(ev, moved);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function otherBoxes(exclude: Set<string>): Box[] {
  return currentSlide().elements.filter((e) => !exclude.has(e.id)).map(boxOf);
}

// ---------- element drag ----------

// ---------- links inside text (TOC entries → Sub-title slide, References → paper) ----------

let pendingLink: number | undefined;

/** A click (no drag) on a link in a box that isn't being edited follows it — unless a
 *  double-click (= edit) follows within 250ms. */
function followLinkLater(target: Element | null): boolean {
  const a = target?.closest?.('.slide-content .el a[href]') as HTMLAnchorElement | null;
  if (!a) return false;
  const href = a.getAttribute('href')!;
  clearTimeout(pendingLink);
  pendingLink = window.setTimeout(() => {
    if (href.startsWith('#slide-')) {
      const id = href.slice('#slide-'.length);
      if (useStore.getState().deck.slides.some((x) => x.id === id)) useStore.getState().goToSlide(id);
    } else window.open(href, '_blank', 'noopener');
  }, 250);
  return true;
}
const cancelPendingLink = () => clearTimeout(pendingLink);

function startMove(e: React.PointerEvent, el: SlideElement) {
  const st = useStore.getState();
  let ids = st.selection;
  const wasSelected = ids.includes(el.id);
  if (e.shiftKey) {
    ids = wasSelected ? ids.filter((i) => i !== el.id) : [...ids, el.id];
    st.select(ids);
    if (wasSelected) return;
  } else if (!wasSelected) {
    ids = [el.id];
    st.select(ids);
  }
  const idSet = new Set(ids);
  const origs = new Map(currentSlide().elements.filter((x) => idSet.has(x.id)).map((x) => [x.id, x]));
  const startBox = unionBox([...origs.values()].map(boxOf))!;
  const targets = snapTargets(otherBoxes(idSet));

  track(e, (ev, dx, dy) => {
    const s = useStore.getState();
    s.beginGesture();
    let guides: Guide[] = [];
    if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    if (!ev.altKey) {
      const sn = snapMove({ ...startBox, x: startBox.x + dx, y: startBox.y + dy }, targets, SNAP_PX / view.scale);
      dx += sn.dx; dy += sn.dy; guides = sn.guides;
    }
    s.updateElements([...idSet], (d) => translate(d as SlideElement, origs.get(d.id)!, Math.round(dx), Math.round(dy)), true);
    useStore.setState({ guides });
  }, (ev, moved) => {
    const s = useStore.getState();
    useStore.setState({ guides: [] });
    if (!moved && !e.shiftKey && followLinkLater(e.target as Element)) return;
    if (moved) s.endGesture();
    else if (wasSelected && !e.shiftKey && el.type === 'text' && s.selection.length === 1) {
      // Click on an already-selected text box: start typing where clicked.
      s.startEditing(el.id, { x: ev.clientX, y: ev.clientY });
    } else if (wasSelected && !e.shiftKey && s.selection.length > 1) s.select([el.id]);
  });
}

// ---------- resize ----------

function startResize(e: React.PointerEvent, el: SlideElement, handle: Handle, opts: { crop?: boolean } = {}) {
  e.stopPropagation();
  e.preventDefault();
  const st = useStore.getState();
  if (st.editingId) st.stopEditing();
  const o = el;
  const targets = snapTargets(otherBoxes(new Set([el.id])));
  const thr = () => SNAP_PX / view.scale;

  track(e, (ev) => {
    const s = useStore.getState();
    s.beginGesture();
    const p = toSlide(ev.clientX, ev.clientY);
    const guides: Guide[] = [];

    if (o.type === 'line') {
      let { x, y } = p;
      const fx = handle === 'p1' ? o.x2 : o.x1, fy = handle === 'p1' ? o.y2 : o.y1;
      if (ev.shiftKey) {
        const ang = Math.round(Math.atan2(y - fy, x - fx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(x - fx, y - fy);
        x = fx + Math.cos(ang) * len; y = fy + Math.sin(ang) * len;
      } else if (!ev.altKey) {
        const sx = snap1([x], targets.xs, thr()), sy = snap1([y], targets.ys, thr());
        if (sx) { x += sx.delta; guides.push({ axis: 'x', pos: sx.pos }); }
        if (sy) { y += sy.delta; guides.push({ axis: 'y', pos: sy.pos }); }
      }
      x = Math.round(x); y = Math.round(y);
      s.updateElements([o.id], (d) => {
        const l = d as LineElement;
        if (handle === 'p1') { l.x1 = x; l.y1 = y; } else { l.x2 = x; l.y2 = y; }
        Object.assign(l, lineBox(l));
      }, true);
      useStore.setState({ guides });
      return;
    }

    if (o.type === 'image') {
      resizeImage(o, handle, p, ev, targets, thr(), guides, opts.crop || ev.shiftKey);
      useStore.setState({ guides });
      return;
    }

    const hasW = handle.includes('w'), hasE = handle.includes('e'), hasN = handle.includes('n'), hasS = handle.includes('s');
    let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
    if (hasW) x1 = p.x; if (hasE) x2 = p.x; if (hasN) y1 = p.y; if (hasS) y2 = p.y;
    if (!ev.altKey) {
      if (hasW || hasE) {
        const sn = snap1([hasW ? x1 : x2], targets.xs, thr());
        if (sn) { if (hasW) x1 += sn.delta; else x2 += sn.delta; guides.push({ axis: 'x', pos: sn.pos }); }
      }
      if ((hasN || hasS) && o.type !== 'text') {
        const sn = snap1([hasN ? y1 : y2], targets.ys, thr());
        if (sn) { if (hasN) y1 += sn.delta; else y2 += sn.delta; guides.push({ axis: 'y', pos: sn.pos }); }
      }
    }
    const MIN = 12;
    let w = Math.max(MIN, x2 - x1), h = Math.max(MIN, y2 - y1);
    const corner = (hasW || hasE) && (hasN || hasS);
    const keepAspect = corner && (o.type === 'shape' ? ev.shiftKey : o.type === 'text');
    if (keepAspect) {
      const sc = o.type === 'text' ? w / o.w : Math.max(w / o.w, h / o.h);
      w = Math.max(MIN, o.w * sc); h = Math.max(MIN, o.h * sc);
    }
    const nx = hasW ? o.x + o.w - w : o.x;
    const ny = hasN ? o.y + o.h - h : o.y;
    s.updateElements([o.id], (d) => {
      d.x = Math.round(nx); d.w = Math.round(w);
      if (d.type === 'text') {
        if (corner) {
          // Corner handles on a text box scale the text (Canva behaviour).
          const k = w / o.w;
          d.style.fontSize = Math.max(6, Math.round((o as TextElement).style.fontSize * k * 2) / 2);
          d.doc = scaleParagraphSizes((o as TextElement).doc, k) as any;
          if (hasN) d.y = Math.round(o.y + o.h - o.h * k);
        }
      } else {
        d.y = Math.round(ny); d.h = Math.round(h);
      }
    }, true);
    useStore.setState({ guides });
  }, (_ev, moved) => {
    useStore.setState({ guides: [] });
    // In crop edit mode the whole session is one undo step (closed by exitCrop).
    if (moved && !useStore.getState().cropEditId) useStore.getState().endGesture();
  });
}

/**
 * Image handles:
 *   drag          → resize keeping the current aspect ratio
 *   ⌥ Option+drag → free resize (stretch)
 *   ⇧ Shift+drag  → crop: the frame edge moves, the image stays put (non-destructive)
 */
function resizeImage(o: ImageElement, handle: Handle, p: { x: number; y: number }, ev: PointerEvent,
  targets: ReturnType<typeof snapTargets>, thr: number, guides: Guide[], crop: boolean) {
  const hasW = handle.includes('w'), hasE = handle.includes('e'), hasN = handle.includes('n'), hasS = handle.includes('s');
  let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
  if (hasW) x1 = p.x; if (hasE) x2 = p.x; if (hasN) y1 = p.y; if (hasS) y2 = p.y;
  if (hasW || hasE) {
    const sn = snap1([hasW ? x1 : x2], targets.xs, thr);
    if (sn) { if (hasW) x1 += sn.delta; else x2 += sn.delta; guides.push({ axis: 'x', pos: sn.pos }); }
  }
  if (hasN || hasS) {
    const sn = snap1([hasN ? y1 : y2], targets.ys, thr);
    if (sn) { if (hasN) y1 += sn.delta; else y2 += sn.delta; guides.push({ axis: 'y', pos: sn.pos }); }
  }
  const upd = (fn: (d: ImageElement) => void) => useStore.getState().updateElements([o.id], (d) => fn(d as ImageElement), true);

  if (crop) {
    const R = sourceRect(o, cropOf(o));
    const f = clampFrameToSource({ x1, y1, x2, y2 }, R, { w: hasW, e: hasE, n: hasN, s: hasS });
    const F = { x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h) };
    upd((d) => { Object.assign(d, F); d.crop = cropFrom(F, R); });
    return;
  }

  const MIN = 12;
  let w = Math.max(MIN, x2 - x1), h = Math.max(MIN, y2 - y1);
  let x = hasW ? o.x + o.w - w : o.x, y = hasN ? o.y + o.h - h : o.y;
  if (!ev.altKey) {
    const ratio = o.w / o.h;
    const corner = (hasW || hasE) && (hasN || hasS);
    if (corner) {
      const sc = Math.max(w / o.w, h / o.h);
      w = o.w * sc; h = o.h * sc;
      x = hasW ? o.x + o.w - w : o.x; y = hasN ? o.y + o.h - h : o.y;
    } else if (hasW || hasE) {
      h = w / ratio; y = o.y + o.h / 2 - h / 2; // edge: grow around the perpendicular center
    } else {
      w = h * ratio; x = o.x + o.w / 2 - w / 2;
    }
    if (w < MIN || h < MIN) return;
  }
  upd((d) => { d.x = Math.round(x); d.y = Math.round(y); d.w = Math.round(w); d.h = Math.round(h); });
}

// ---------- crop edit mode (double-click an image) ----------

/** Update the crop of the image in crop mode from a new full-image rectangle R (frame stays fixed). */
function setSourceRect(el: ImageElement, R: Box) {
  const r = coverFrame(el, R);
  useStore.getState().updateElements([el.id], (d) => { (d as ImageElement).crop = cropFrom(d, r); }, true);
}

function startPan(e: React.PointerEvent, el: ImageElement) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const R0 = sourceRect(el, cropOf(el));
  track(e, (_ev, dx, dy) => setSourceRect(el, { ...R0, x: R0.x + dx, y: R0.y + dy }), () => {});
}

/** Dragging a corner of the full image scales it (aspect locked) around the opposite corner. */
function startZoomHandle(e: React.PointerEvent, el: ImageElement, corner: 'nw' | 'ne' | 'se' | 'sw') {
  e.stopPropagation();
  e.preventDefault();
  const R0 = sourceRect(el, cropOf(el));
  const ax = corner.includes('w') ? R0.x + R0.w : R0.x;
  const ay = corner.includes('n') ? R0.y + R0.h : R0.y;
  track(e, (ev) => {
    const p = toSlide(ev.clientX, ev.clientY);
    // Signed distances: dragging past the anchor shrinks to the minimum (coverFrame) instead of flipping.
    const sx = corner.includes('w') ? -1 : 1, sy = corner.includes('n') ? -1 : 1;
    const k = Math.max((sx * (p.x - ax)) / R0.w, (sy * (p.y - ay)) / R0.h, 0.01);
    const w = R0.w * k, h = R0.h * k;
    setSourceRect(el, { x: corner.includes('w') ? ax - w : ax, y: corner.includes('n') ? ay - h : ay, w, h });
  }, () => {});
}

function CropOverlay({ el, scale }: { el: ImageElement; scale: number }) {
  const asset = useStore((s) => s.assets[el.assetId]);
  const ref = useRef<HTMLDivElement>(null);
  const R = sourceRect(el, cropOf(el));

  // Wheel / trackpad pinch zooms the image around the pointer (non-passive to stop browser zoom).
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const cur = currentSlide().elements.find((x) => x.id === el.id) as ImageElement | undefined;
      if (!cur) return;
      const r = sourceRect(cur, cropOf(cur));
      const p = toSlide(ev.clientX, ev.clientY);
      const k = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.002));
      setSourceRect(cur, { x: p.x - (p.x - r.x) * k, y: p.y - (p.y - r.y) * k, w: r.w * k, h: r.h * k });
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [el.id]);

  if (!asset) return null;
  const hs = 10 / scale, bw = 1.5 / scale;
  const corners = ['nw', 'ne', 'se', 'sw'] as const;
  const frameHandles: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const fpos = (h: Handle) => ({
    left: h.includes('w') ? el.x : h.includes('e') ? el.x + el.w : el.x + el.w / 2,
    top: h.includes('n') ? el.y : h.includes('s') ? el.y + el.h : el.y + el.h / 2,
  });
  const done = (e: React.MouseEvent) => { e.stopPropagation(); useStore.getState().exitCrop(); };
  return (
    <div ref={ref} className="crop-layer" onDoubleClick={done}>
      {/* the whole original image, dimmed: what is outside the frame */}
      <div className="crop-ghost" style={{ left: R.x, top: R.y, width: R.w, height: R.h }} onPointerDown={(e) => startPan(e, el)}>
        <img src={asset.dataUrl} draggable={false} alt="" />
      </div>
      {/* the visible part, at full opacity */}
      <div className="crop-window" style={{ left: el.x, top: el.y, width: el.w, height: el.h }} onPointerDown={(e) => startPan(e, el)}>
        <img src={asset.dataUrl} draggable={false} alt="" style={{ left: R.x - el.x, top: R.y - el.y, width: R.w, height: R.h }} />
      </div>
      <div className="sel-frame crop-frame" style={{ left: el.x, top: el.y, width: el.w, height: el.h, borderWidth: bw }} />
      {corners.map((c) => (
        <div key={'z' + c} className={`handle zoom-handle h-${c}`} title="이미지 확대/축소"
          style={{ left: c.includes('w') ? R.x : R.x + R.w, top: c.includes('n') ? R.y : R.y + R.h, width: hs, height: hs, borderWidth: bw }}
          onPointerDown={(e) => startZoomHandle(e, el, c)} />
      ))}
      {frameHandles.map((h) => (
        <div key={'f' + h} className={`handle crop-handle h-${h}`} title="크롭 영역"
          style={{ ...fpos(h), width: hs * 1.6, height: hs * 1.6, borderWidth: bw }}
          onPointerDown={(e) => startResize(e, el, h, { crop: true })} />
      ))}
    </div>
  );
}

// ---------- components ----------

const CanvasElement = memo(function CanvasElement({ el, editing }: { el: SlideElement; editing: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const assets = useStore((s) => s.assets);
  const selected = useStore((s) => s.selection.length === 1 && s.selection[0] === el.id && s.cropEditId !== el.id);

  // Text boxes are auto-height: measure and store the height (used for selection, snapping, export).
  useLayoutEffect(() => {
    if (el.type !== 'text' || !ref.current) return;
    const node = ref.current;
    const measure = () => {
      const h = node.offsetHeight;
      const cur = currentSlide().elements.find((x) => x.id === el.id);
      if (!cur) return;
      // Equations wider than the box widen it (up to the slide edge) instead of overflowing.
      const content = node.querySelector('.tb-content') as HTMLElement | null;
      const need = content ? Math.ceil(content.scrollWidth) : 0;
      const w = need > cur.w + 1 ? Math.min(need, SLIDE_W - cur.x) : cur.w;
      if (Math.abs(cur.h - h) > 0.5 || w !== cur.w) useStore.getState().updateElements([el.id], (d) => { d.h = h; d.w = w; }, true);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    const content = node.querySelector('.tb-content');
    if (content) ro.observe(content);
    const mo = new MutationObserver(measure);
    mo.observe(node, { subtree: true, childList: true, attributes: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [el.id, el.type, editing]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (editing) { e.stopPropagation(); return; } // let ProseMirror handle it
    e.stopPropagation();
    const st = useStore.getState();
    if (st.editingId) st.stopEditing();
    startMove(e, el);
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    cancelPendingLink();
    if (el.type === 'image') { e.stopPropagation(); useStore.getState().enterCrop(el.id); return; }
    if ((el.type !== 'text' && el.type !== 'shape') || editing) return;
    e.stopPropagation();
    useStore.getState().startEditing(el.id, { x: e.clientX, y: e.clientY });
  };

  return (
    <div ref={ref} className={`el el-${el.type}${editing ? ' editing' : ''}`} style={elementBoxStyle(el)} data-el-id={el.id}
      onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
      {editing && el.type === 'text' ? <TextEditor el={el} />
        : editing && el.type === 'shape' ? <ShapeView el={el} editor={<TextEditor el={el} />} />
        : el.type === 'line' ? <LineSvg el={el} hit />
        : <ElementBody el={el} assets={assets} caption={el.type === 'image' && selected && el.caption !== undefined ? <CaptionInput el={el} /> : undefined} />}
    </div>
  );
});

/** Editor-only caption field (plain text) under a selected image. One undo step per editing session. */
function CaptionInput({ el }: { el: ImageElement }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const active = useRef(false);
  const last = useRef(el.caption ?? '');
  last.current = el.caption ?? '';
  const value = el.caption ?? '';
  useLayoutEffect(() => { const t = ref.current; if (t) { t.style.height = '0'; t.style.height = `${t.scrollHeight}px`; } }, [value, el.w]);
  // Ends the editing session (also when the field unmounts while focused, e.g. the image is deselected).
  const finish = useCallback(() => {
    if (!active.current) return;
    active.current = false;
    const st = useStore.getState();
    // Emptied caption → back to the no-caption state (same gesture, so it is part of the editing step).
    if (!last.current.trim()) st.updateElements([el.id], (d) => { delete (d as ImageElement).caption; }, true);
    st.endGesture();
  }, [el.id]);
  useEffect(() => { if (!el.caption) ref.current?.focus(); return finish; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <textarea ref={ref} className="img-caption-input" style={captionStyle} value={value} rows={1} placeholder="Add a caption..." spellCheck={false}
      onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => { if (!active.current) { active.current = true; useStore.getState().beginGesture(); } useStore.getState().updateElements([el.id], (d) => { (d as ImageElement).caption = e.target.value; }, true); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') ref.current?.blur(); }}
      onBlur={finish} />
  );
}

function SelectionOverlay({ scale }: { scale: number }) {
  const selection = useStore((s) => s.selection);
  const editingId = useStore((s) => s.editingId);
  const cropEditId = useStore((s) => s.cropEditId);
  const slide = useStore((s) => s.deck.slides.find((x) => x.id === s.currentSlideId));
  if (!slide) return null;
  const els = slide.elements.filter((e) => selection.includes(e.id));
  if (!els.length) return null;
  const hs = 10 / scale;
  const bw = 1.5 / scale;

  if (els.length > 1) {
    const u = unionBox(els.map(boxOf))!;
    return (
      <>
        {els.map((e) => <div key={e.id} className="sel-frame thin" style={{ left: e.x, top: e.y, width: e.w, height: e.h, borderWidth: bw / 1.5 }} />)}
        <div className="sel-frame group" style={{ left: u.x, top: u.y, width: u.w, height: u.h, borderWidth: bw }} />
      </>
    );
  }
  const el = els[0];
  if (el.type === 'image' && cropEditId === el.id) return <CropOverlay el={el} scale={scale} />;
  if (el.type === 'line') {
    return (
      <>
        {(['p1', 'p2'] as const).map((h) => (
          <div key={h} className="handle round" style={{ left: h === 'p1' ? el.x1 : el.x2, top: h === 'p1' ? el.y1 : el.y2, width: hs, height: hs, borderWidth: bw }}
            onPointerDown={(e) => startResize(e, el, h)} />
        ))}
      </>
    );
  }
  const handles: Handle[] =
    el.type === 'text' ? ['nw', 'ne', 'se', 'sw', 'e', 'w'] :
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const pos = (h: Handle) => ({
    left: h.includes('w') ? el.x : h.includes('e') ? el.x + el.w : el.x + el.w / 2,
    top: h.includes('n') ? el.y : h.includes('s') ? el.y + el.h : el.y + el.h / 2,
  });
  const editing = editingId === el.id;
  const edge = 8 / scale;
  return (
    <>
      <div className={`sel-frame${editing ? ' editing' : ''}`} style={{ left: el.x, top: el.y, width: el.w, height: el.h, borderWidth: bw }}>
        {editing && (['top', 'bottom', 'left', 'right'] as const).map((side) => (
          // While editing, the box can still be dragged by its border.
          <div key={side} className={`edge-grab ${side}`} style={{ [side]: -edge / 2, ...(side === 'top' || side === 'bottom' ? { height: edge } : { width: edge }) }}
            onPointerDown={(e) => { e.stopPropagation(); useStore.getState().stopEditing(); startMove(e, el); }} />
        ))}
      </div>
      {handles.map((h) => (
        <div key={h} className={`handle h-${h}`} style={{ ...pos(h), width: hs, height: hs, borderWidth: bw }}
          onPointerDown={(e) => startResize(e, el, h)} />
      ))}
    </>
  );
}

/**
 * Alignment references of the current slide's elements — the same snap targets the drag guides use
 * (edges and centers), minus the slide border itself, de-duplicated to the pixel.
 */
export function previewGuides(): Guide[] {
  const t = snapTargets(currentSlide().elements.map(boxOf));
  const uniq = (vs: number[], max: number) => [...new Set(vs.map(Math.round))].filter((v) => v > 0 && v < max);
  return [
    ...uniq(t.xs, SLIDE_W).map((pos) => ({ axis: 'x' as const, pos })),
    ...uniq(t.ys, SLIDE_H).map((pos) => ({ axis: 'y' as const, pos })),
  ];
}

/**
 * Holding Shift on the idle canvas previews the alignment guides (editor-only overlay, nothing is stored).
 * Not while editing text / cropping / typing in a field, not with other keys or modifiers, and it hides
 * on pointer-down (Shift-drag / Shift-click keep their usual meaning) and when the window loses focus.
 */
function useShiftPreview() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const idle = () => {
      const st = useStore.getState();
      const a = document.activeElement as HTMLElement | null;
      const typing = !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
      return st.focusArea === 'canvas' && !st.editingId && !st.cropEditId && !st.presenting && !typing;
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) setOn(idle());
      else if (e.key !== 'Shift') setOn(false);
    };
    const off = () => setOn(false);
    const up = (e: KeyboardEvent) => { if (e.key === 'Shift') off(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', off);
    window.addEventListener('pointerdown', off, true);
    return () => {
      window.removeEventListener('keydown', down); window.removeEventListener('keyup', up);
      window.removeEventListener('blur', off); window.removeEventListener('pointerdown', off, true);
    };
  }, []);
  return on;
}

function Guides({ scale, preview }: { scale: number; preview: boolean }) {
  const dragGuides = useStore((s) => s.guides);
  const elements = useStore((s) => s.deck.slides.find((x) => x.id === s.currentSlideId)?.elements);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const guides = dragGuides.length ? dragGuides : preview ? previewGuides() : [];
  void elements; // re-render when the slide's elements change while previewing
  return (
    <>
      {guides.map((g, i) =>
        g.axis === 'x'
          ? <div key={i} className="guide" style={{ left: g.pos, top: 0, width: 1 / scale, height: SLIDE_H }} />
          : <div key={i} className="guide" style={{ top: g.pos, left: 0, height: 1 / scale, width: SLIDE_W }} />,
      )}
    </>
  );
}

/**
 * Footer on the editing canvas: fixed slide number (not editable, clicks pass through) and the
 * anchored reference area — linked academic citations (click = open paper, hover = remove/retry)
 * followed by free text you can click and type. Pasting/typing an arXiv URL turns it into a citation.
 */
function CanvasFooter({ slideId }: { slideId: string }) {
  const index = useStore((s) => s.deck.slides.findIndex((x) => x.id === slideId));
  const total = useStore((s) => s.deck.slides.length);
  const slide = useStore((s) => s.deck.slides.find((x) => x.id === slideId));
  const registry = useStore((s) => s.deck.citations);
  const reference = slide?.reference ?? '';
  const cites = slide ? footerParts(slide, registry) : [];
  const ref = useRef<HTMLSpanElement>(null);
  // Uncontrolled while focused (keeps the caret); synced from the store otherwise (undo, slide switch).
  useLayoutEffect(() => {
    const node = ref.current;
    if (node && document.activeElement !== node && node.textContent !== reference) node.textContent = reference;
  }, [reference, slideId]);
  const save = (extract: boolean) => {
    const node = ref.current;
    if (!node) return;
    let v = (node.textContent ?? '').replace(/\s*\n\s*/g, ' ');
    if (extract) {
      const rest = extractCitations(slideId, v);
      if (rest !== v) { v = rest; node.textContent = rest; }
    }
    useStore.getState().live((d) => { const sl = d.slides.find((x) => x.id === slideId); if (sl) sl.reference = v; });
  };
  const stop = (e: React.PointerEvent) => { e.stopPropagation(); const st = useStore.getState(); if (st.editingId) st.stopEditing(); if (st.selection.length) st.select([]); };
  return (
    <>
      <div className="footer-num" style={footerNumberStyle}>{slideNumberText(index, total)}</div>
      <div className="footer-ref editable-wrap" style={footerRefStyle} onPointerDown={stop}>
        {cites.map((c, i) => (
          <Fragment key={c.id}>
            {i > 0 && '; '}
            <span className="cite-chip">
              <CitationLabel c={c} />
              {c.status === 'loading' && <span className="cite-state"> 불러오는 중…</span>}
              {c.status === 'error' && <button className="cite-btn" title={`메타데이터를 가져오지 못했습니다 (${c.error}). 다시 시도`} onClick={() => resolveCitation(c.id)}>↻</button>}
              <button className="cite-btn remove" title="이 슬라이드에서 인용 삭제" onClick={() => useStore.getState().removeCitation(slideId, c.id)}>×</button>
            </span>
          </Fragment>
        ))}
        {cites.length > 0 && reference ? '; ' : ''}
        <span ref={ref} className="footer-ref-text" contentEditable="plaintext-only" suppressContentEditableWarning
          spellCheck={false} data-placeholder={cites.length ? '' : '참고문헌 (클릭해서 입력 · arXiv 링크 붙여넣기)'} title="참고문헌 / 출처"
          onFocus={() => useStore.getState().beginGesture()}
          onBlur={() => { save(true); useStore.getState().endGesture(); }}
          onInput={() => save(false)}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text/plain');
            if (!findCitations(text).length) return; // ordinary text: default paste
            e.preventDefault();
            const rest = extractCitations(slideId, text);
            if (rest) document.execCommand('insertText', false, rest);
            save(false);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== 'Escape') return;
            e.preventDefault();
            // Finish here rather than relying on the blur event (not fired when the window lacks focus).
            save(true);
            useStore.getState().endGesture();
            (e.target as HTMLElement).blur();
          }} />
      </div>
    </>
  );
}

export function Canvas() {
  const vpRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [dropping, setDropping] = useState(false);
  const slide = useStore((s) => s.deck.slides.find((x) => x.id === s.currentSlideId)!);
  const editingId = useStore((s) => s.editingId);
  const shiftPreview = useShiftPreview();

  useLayoutEffect(() => {
    const vp = vpRef.current!;
    const fit = () => {
      const pad = 40;
      const s = Math.min((vp.clientWidth - pad * 2) / SLIDE_W, (vp.clientHeight - pad * 2) / SLIDE_H);
      setScale(Math.max(0.1, s));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(vp);
    return () => ro.disconnect();
  }, []);
  view.scale = scale;
  useEffect(() => { view.slideEl = slideRef.current; });

  const onBgPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const st = useStore.getState();
    const wasEditing = !!st.editingId;
    const hadSelection = st.selection.length > 0;
    if (wasEditing) st.stopEditing();
    const base = e.shiftKey ? useStore.getState().selection : [];
    st.select(base);
    const start = toSlide(e.clientX, e.clientY);
    track(e, (ev) => {
      const p = toSlide(ev.clientX, ev.clientY);
      const box = { x: Math.min(p.x, start.x), y: Math.min(p.y, start.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      setMarquee(box);
      const hit = currentSlide().elements.filter((el) => intersects(box, boxOf(el))).map((el) => el.id);
      useStore.getState().select([...new Set([...base, ...hit])]);
    }, (_ev, moved) => {
      setMarquee(null);
      const inside = start.x >= 0 && start.y >= 0 && start.x <= SLIDE_W && start.y <= SLIDE_H;
      // Click on empty slide area (with nothing selected) creates a text box right there.
      // (Shift is allowed: it only previews alignment guides, and with nothing selected it adds nothing to a marquee.)
      if (!moved && !wasEditing && !hadSelection && inside) insertTextAt(start.x, start.y);
    });
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) insertImageFiles(files, toSlide(e.clientX, e.clientY));
  };

  return (
    <div ref={vpRef} className={`canvas-viewport${dropping ? ' dropping' : ''}`} onPointerDown={onBgPointerDown}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={() => setDropping(false)} onDrop={onDrop}>
      <div className="slide-frame" style={{ width: SLIDE_W * scale, height: SLIDE_H * scale }}>
        <div ref={slideRef} className="slide editable" style={{ width: SLIDE_W, height: SLIDE_H, transform: `scale(${scale})`, background: slide.background }}>
          <div className="slide-content" onClickCapture={(e) => { if ((e.target as Element).closest('.el a[href]')) e.preventDefault(); }}>
            {slide.elements.map((el) => <CanvasElement key={el.id} el={el} editing={editingId === el.id} />)}
            <CanvasFooter slideId={slide.id} />
          </div>
          <div className="overlay">
            <SelectionOverlay scale={scale} />
            <Guides scale={scale} preview={shiftPreview} />
            {marquee && <div className="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h, borderWidth: 1 / scale }} />}
          </div>
        </div>
      </div>
    </div>
  );
}
