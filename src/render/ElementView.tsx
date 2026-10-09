import { Fragment, memo, type CSSProperties, type ReactNode } from 'react';
import { useStore } from '../store/store';
import type { Asset, Citation, LineElement, ShapeElement, Slide, SlideElement, TextElement } from '../model/types';
import { SLIDE_H, SLIDE_W } from '../model/types';
import { StaticText } from './StaticText';
import { TableView } from './TableView';
import { isDocEmpty } from '../editor/docUtils';
import { themeLayout, themedTextColor, todoAccent } from '../model/theme';
import { EMOJI_GLYPH_SCALE, shapeTextInset, shapeTextStyle } from '../model/defaults';
import { slideFontVars } from '../model/fonts';
import { imageRadius } from '../model/imageCrop';
import { blockArrowOutline } from '../model/blockArrow';
import { displayCitation } from '../citations/format';
import { CAPTION_COLOR, CAPTION_GAP, FOOTER_COLOR, FOOTER_FONT_SIZE, FOOTER_MARGIN_X, FOOTER_MARGIN_Y, FOOTER_NUMBER_RESERVE, INSTANCE_BORDER_WIDTH, TYPOGRAPHY } from '../model/typography';

export function textBoxStyle(el: TextElement): CSSProperties {
  return {
    fontSize: el.style.fontSize,
    color: el.style.color,
    textAlign: el.style.align,
    lineHeight: el.style.lineHeight,
    background: el.style.fill ?? undefined,
  };
}

export function ShapeSvg({ el }: { el: ShapeElement }) {
  const sw = el.stroke ? el.strokeWidth : 0;
  const common = { fill: el.fill ?? 'none', stroke: el.stroke ?? 'none', strokeWidth: sw };
  const w = Math.max(el.w - sw, 0), h = Math.max(el.h - sw, 0);
  return (
    <svg className="shape-svg" width={el.w} height={el.h} viewBox={`0 0 ${el.w} ${el.h}`}>
      {el.shape === 'blockArrow' ? (
        <polygon points={blockArrowOutline(el).map((p) => p.join(',')).join(' ')} strokeLinejoin="round" {...common} />
      ) : el.shape === 'ellipse' ? (
        <ellipse cx={el.w / 2} cy={el.h / 2} rx={w / 2} ry={h / 2} {...common} />
      ) : (
        <rect x={sw / 2} y={sw / 2} width={w} height={h}
          rx={el.shape === 'roundRect' ? Math.min(el.radius, w / 2, h / 2) : 0} {...common} />
      )}
    </svg>
  );
}

/** Shape with its (optional) text; `editor` replaces the static text while the shape's text is being edited. */
export function ShapeView({ el, editor }: { el: ShapeElement; editor?: ReactNode }) {
  const hasText = !!el.doc && !isDocEmpty(el.doc);
  const st = shapeTextStyle(el), inset = shapeTextInset(el);
  return (
    <>
      <ShapeSvg el={el} />
      {(editor || hasText) && (
        <div className="shape-text" style={{ padding: `${inset.y}px ${inset.x}px`, fontSize: st.fontSize, color: st.color, textAlign: st.align, lineHeight: st.lineHeight }}>
          {editor ?? <StaticText doc={el.doc!} />}
        </div>
      )}
    </>
  );
}

export const LINE_PAD = 24;

export function arrowSize(sw: number) {
  return { len: Math.max(10, sw * 3.6), half: Math.max(5, sw * 1.8) };
}

/** Line rendered in an SVG whose origin is the line's bounding box minus LINE_PAD. */
export function LineSvg({ el, hit }: { el: LineElement; hit?: boolean }) {
  const ox = el.x - LINE_PAD, oy = el.y - LINE_PAD;
  let x1 = el.x1 - ox, y1 = el.y1 - oy, x2 = el.x2 - ox, y2 = el.y2 - oy;
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  const { len: al, half } = arrowSize(el.strokeWidth);
  const heads: ReactNode[] = [];
  const head = (tx: number, ty: number, dx: number, dy: number, k: string) => {
    const bx = tx - dx * al, by = ty - dy * al;
    heads.push(<polygon key={k} fill={el.stroke}
      points={`${tx},${ty} ${bx - dy * half},${by + dx * half} ${bx + dy * half},${by - dx * half}`} />);
  };
  const [sx1, sy1, sx2, sy2] = [x1, y1, x2, y2];
  if (el.arrowEnd) { head(sx2, sy2, ux, uy, 'e'); x2 -= ux * al * 0.8; y2 -= uy * al * 0.8; }
  if (el.arrowStart) { head(sx1, sy1, -ux, -uy, 's'); x1 += ux * al * 0.8; y1 += uy * al * 0.8; }
  return (
    <svg className="line-svg" width={el.w + 2 * LINE_PAD} height={el.h + 2 * LINE_PAD}
      style={{ left: -LINE_PAD, top: -LINE_PAD }}>
      {hit && <line className="line-hit" x1={sx1} y1={sy1} x2={sx2} y2={sy2} stroke="transparent" strokeWidth={Math.max(16, el.strokeWidth + 12)} />}
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={el.stroke} strokeWidth={el.strokeWidth}
        strokeDasharray={el.dashed ? `${el.strokeWidth * 3} ${el.strokeWidth * 2}` : undefined} />
      {heads}
    </svg>
  );
}

/** The visual content of an element, without positioning. */
/** Shared by the static caption and the editor's caption input so both lay out identically. */
export const captionStyle: CSSProperties = { marginTop: CAPTION_GAP, fontSize: TYPOGRAPHY.caption, color: CAPTION_COLOR };

export function ElementBody({ el, assets, caption }: { el: SlideElement; assets: Record<string, Asset>; caption?: ReactNode }) {
  switch (el.type) {
    case 'text': return <StaticText doc={el.doc} />;
    case 'image': {
      const a = assets[el.assetId];
      if (!a) return <div className="el-img missing">image</div>;
      // The caption hangs below the element box (its geometry stays the image's); empty = none.
      const cap = caption ?? (el.caption?.trim() ? <div className="img-caption" style={captionStyle}>{el.caption}</div> : null);
      const br = imageRadius(el) || undefined;
      if (!el.crop) return <><img className="el-img" src={a.dataUrl} draggable={false} alt="" style={br ? { borderRadius: br } : undefined} />{cap}</>;
      // Cropped: the full image is drawn larger and offset; the element box clips it.
      const c = el.crop;
      return (
        <>
          <div className="el-img-crop" style={br ? { borderRadius: br } : undefined}>
            <img className="el-img-src" src={a.dataUrl} draggable={false} alt=""
              style={{ left: `${(-c.x / c.w) * 100}%`, top: `${(-c.y / c.h) * 100}%`, width: `${100 / c.w}%`, height: `${100 / c.h}%` }} />
          </div>
          {cap}
        </>
      );
    }
    case 'table': return <TableView el={el} />;
    case 'shape': return <ShapeView el={el} />;
    case 'line': return <LineSvg el={el} />;
    // Real text at the element's size (re-rasterized by the font renderer at every size, never a scaled bitmap).
    case 'emoji': return <span className="emoji-glyph" style={{ fontSize: Math.min(el.w, el.h) * EMOJI_GLYPH_SCALE }}>{el.emoji}</span>;
  }
}

/** Presentation-level theme decorations of a slide (title band / header band / section background / footer accent). Not elements: never selectable. */
export function ThemeDecor({ slide }: { slide: Slide }) {
  const themeColor = useStore((s) => s.deck.themeColor);
  const titleElementId = useStore((s) => s.deck.titleElementId);
  const layout = themeLayout({ themeColor, titleElementId }, slide);
  if (!layout) return null;
  return <>{layout.rects.map((r) => <div key={r.name} className="theme-decor" data-theme-part={r.name} style={{ left: r.x, top: r.y, width: r.w, height: r.h, background: layout.color }} />)}</>;
}

/** Foreground override for text sitting on a theme-colored area (null = element's own color). */
export function useThemedColor(slide: Slide, el: SlideElement): string | null {
  const themeColor = useStore((s) => s.deck.themeColor);
  const titleElementId = useStore((s) => s.deck.titleElementId);
  return themedTextColor({ themeColor, titleElementId }, slide, el);
}

/**
 * Persistent instance border: an outline centered on the element bounds (half inside, half outside), so it never
 * changes the box size or text wrapping and stays visible next to the (inside) blue selection frame.
 */
export function instanceBorderStyle(el: SlideElement): CSSProperties {
  if ((el.type !== 'text' && el.type !== 'image') || !el.borderColor) return {};
  return { outline: `${INSTANCE_BORDER_WIDTH}px solid ${el.borderColor}`, outlineOffset: -INSTANCE_BORDER_WIDTH / 2 };
}

export function elementBoxStyle(el: SlideElement, fg?: string | null): CSSProperties {
  const base: CSSProperties = { left: el.x, top: el.y, width: el.w, ...instanceBorderStyle(el), ...(el.type === 'image' && imageRadius(el) ? { borderRadius: imageRadius(el) } : {}) };
  if (el.type === 'text') return { ...base, ...textBoxStyle(el), ...(fg ? { color: fg } : {}), minHeight: el.style.fontSize * el.style.lineHeight };
  if (el.type === 'table') return base; // rows grow with their content; the stored h is the measured height
  return { ...base, height: el.h };
}

/** "4/12" — computed from the slide's position, never stored. */
export const slideNumberText = (index: number, total: number) => `${index + 1}/${total}`;

export const footerNumberStyle: CSSProperties = {
  left: FOOTER_MARGIN_X, bottom: FOOTER_MARGIN_Y, fontSize: FOOTER_FONT_SIZE, color: FOOTER_COLOR,
};
export const footerRefStyle: CSSProperties = {
  right: FOOTER_MARGIN_X, bottom: FOOTER_MARGIN_Y, fontSize: FOOTER_FONT_SIZE, color: FOOTER_COLOR,
  // Long references wrap toward the left/top but never reach the slide number.
  maxWidth: SLIDE_W - 2 * FOOTER_MARGIN_X - FOOTER_NUMBER_RESERVE,
};

/** One footer citation: the short citation linked to the paper (or the URL while unresolved). */
export function CitationLabel({ c }: { c: Citation }) {
  if (c.status === 'ok') return <a className="cite-link" href={c.url} target="_blank" rel="noopener noreferrer" title={displayCitation(c)}>{c.shortCitation}</a>;
  return <a className={`cite-link pending ${c.status}`} href={c.url} target="_blank" rel="noopener noreferrer">{c.url}</a>;
}

/** Footer citations (by id) and manual reference text, separated by "; ". */
export function footerParts(slide: Slide, registry: Record<string, Citation> | undefined): Citation[] {
  return (slide.citations ?? []).map((id) => registry?.[id]).filter((c): c is Citation => !!c);
}

/** Footer text color: gray, or the readable foreground on a full-theme section-divider slide. */
export function useFooterStyles(slide: Slide) {
  const themeColor = useStore((s) => s.deck.themeColor);
  const fg = slide.kind === 'subtitle' ? themeLayout({ themeColor }, slide)?.fg : undefined;
  return fg ? { num: { ...footerNumberStyle, color: fg }, ref: { ...footerRefStyle, color: fg } } : { num: footerNumberStyle, ref: footerRefStyle };
}

/** Static footer: slide number bottom-left, reference bottom-right (hidden when empty). */
export function SlideFooter({ index, total, slide }: { index: number; total: number; slide: Slide }) {
  const registry = useStore((s) => s.deck.citations);
  const cites = footerParts(slide, registry);
  const manual = slide.reference?.trim();
  const fs = useFooterStyles(slide);
  return (
    <>
      <div className="footer-num" style={fs.num} data-footer-num>{slideNumberText(index, total)}</div>
      {cites.length || manual ? (
        <div className="footer-ref" style={fs.ref} data-footer-ref>
          {cites.map((c, i) => <Fragment key={c.id}>{i > 0 && '; '}<CitationLabel c={c} /></Fragment>)}
          {manual ? <>{cites.length ? '; ' : ''}{manual}</> : null}
        </div>
      ) : null}
    </>
  );
}

function StaticElement({ slide, el, assets }: { slide: Slide; el: SlideElement; assets: Record<string, Asset> }) {
  const fg = useThemedColor(slide, el);
  return (
    <div className={`el el-${el.type}`} style={elementBoxStyle(el, fg)} data-el-id={el.id}>
      <ElementBody el={el} assets={assets} />
    </div>
  );
}

/** Static, non-interactive slide at 1280×720 (thumbnails, presenter, print, export measurement). */
export const SlideView = memo(function SlideView({ slide, assets, className, index, total }: {
  slide: Slide; assets: Record<string, Asset>; className?: string; index: number; total: number;
}) {
  const themeColor = useStore((s) => s.deck.themeColor);
  const fontFamily = useStore((s) => s.deck.fontFamily);
  const accent = todoAccent({ themeColor });
  return (
    <div className={`slide ${className ?? ''}`} style={{ width: SLIDE_W, height: SLIDE_H, background: slide.background, ['--todo-accent' as string]: accent, ...slideFontVars(fontFamily) }} data-slide-id={slide.id}>
      <ThemeDecor slide={slide} />
      {slide.elements.map((el) => <StaticElement key={el.id} slide={slide} el={el} assets={assets} />)}
      <SlideFooter index={index} total={total} slide={slide} />
    </div>
  );
});
