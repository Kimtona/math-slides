// Slide coordinates are CSS pixels on a 1280×720 canvas.
// 1280px = 13.333in = PowerPoint "Widescreen" (16:9), so 1px = 1/96in = 0.75pt.
export const SLIDE_W = 1280;
export const SLIDE_H = 720;

export type ID = string;

/** ProseMirror/TipTap document JSON. */
export interface PMNode {
  type: string;
  attrs?: Record<string, any>;
  content?: PMNode[];
  marks?: { type: string; attrs?: Record<string, any> }[];
  text?: string;
}

export interface TextStyle {
  fontSize: number; // px
  color: string; // #rrggbb
  align: 'left' | 'center' | 'right';
  lineHeight: number; // multiplier
  fill: string | null; // background color of the box
  /** A SLIDE_FONTS id for this box. Absent = the presentation font (older files, and every box created with the default font). */
  fontFamily?: string;
}

interface ElementBase {
  id: ID;
  x: number;
  y: number;
  w: number;
  h: number; // for text: measured from content (auto height)
}

/**
 * Text boxes owned by a structural system. 'toc' is the user-edited Table of Contents (source of truth);
 * the others are generated (Sub-title / References slides) and rewritten automatically.
 */
export type TextRole = 'toc' | 'subtitle-current' | 'subtitle-next' | 'references-title' | 'references-list';

export interface TextElement extends ElementBase {
  type: 'text';
  doc: PMNode;
  style: TextStyle;
  role?: TextRole;
  /** Instance border color (#rrggbb), drawn on the box bounds. Absent = no border. */
  borderColor?: string;
}

/**
 * Non-destructive crop: the part of the original image shown inside the element frame,
 * as fractions (0..1) of the source image's natural width/height. The asset is never modified,
 * so shrinking and later re-growing the crop reveals the original pixels again.
 * Maps directly to PowerPoint's <a:srcRect> and to CSS percentages.
 * (A future mask shape, e.g. ellipse, would be a sibling field on ImageElement.)
 */
export interface ImageCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageElement extends ElementBase {
  type: 'image';
  assetId: ID;
  /** Absent (older files, uncropped images) = the whole image. */
  crop?: ImageCrop;
  /**
   * Optional plain-text caption, drawn left-aligned below the image at the image's width.
   * Absent / empty = no caption (older files have none); '' only exists while it is being edited.
   */
  caption?: string;
  /** Instance border color (#rrggbb), drawn on the image bounds. Absent = no border. */
  borderColor?: string;
  /** Corner radius in slide px (absent / 0 = square, as in older files). Rendered clamped to half the shorter side. */
  radius?: number;
}

export type ShapeKind = 'rect' | 'roundRect' | 'ellipse' | 'blockArrow';

export interface ShapeElement extends ElementBase {
  type: 'shape';
  shape: ShapeKind;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  radius: number; // roundRect corner radius, px
  /** blockArrow only: shaft thickness (fraction of height) and arrowhead length (fraction of width). Absent = defaults. */
  shaft?: number;
  head?: number;
  /** Optional text inside the shape (same rich-text document as text boxes). Absent / empty = no text. */
  doc?: PMNode;
  /** Text defaults (size, color, align, line height); absent = centered body text. */
  textStyle?: TextStyle;
}

/** Lines are stored by their endpoints; x/y/w/h is the derived bounding box. */
export interface LineElement extends ElementBase {
  type: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
  arrowEnd: boolean;
  arrowStart: boolean;
  dashed: boolean;
  /** Set only on Markdown/slash dividers: endpoint drags stay horizontal unless ⌥ is held. Absent = ordinary line. */
  role?: 'divider';
}

/**
 * Standalone emoji: the Unicode string itself (rendered as text at the element's size, so it stays sharp at any
 * size; never a bitmap). Always square (w === h); resizing is uniform.
 */
export interface EmojiElement extends ElementBase {
  type: 'emoji';
  emoji: string;
}

/** One table cell: rich text (the same ProseMirror JSON as a text box; no math/blocks/lists in v1). */
export interface TableCell {
  doc: PMNode;
  /** Custom background (#rrggbb). Absent = the style's default (none, or the Header style's gray). Always wins over the style fill. */
  fill?: string;
}

export type TableStyle = 'minimal' | 'grid' | 'header';

/**
 * A table as ONE slide element. `rows[r][c]` is a rectangular grid; `cols` holds the column widths in px and
 * always sums to `w`. Row heights are content-driven (never stored); `h` is the measured height, like text boxes.
 */
export interface TableElement extends ElementBase {
  type: 'table';
  cols: number[];
  rows: TableCell[][];
  /** Appearance preset. Phase 1 renders 'minimal'; the others are reserved. */
  style: TableStyle;
  /** First row is emphasized (header). */
  headerRow: boolean;
  /** Table-wide text defaults (same shape as a text box's style; `fill` is unused). */
  textStyle: TextStyle;
  /** Custom line color (#rrggbb) for every table line (width stays fixed). Absent = the style's default grays. */
  borderColor?: string;
  /** Optional plain-text caption below the table — same behavior as an image caption (absent / empty = none; '' only while being edited). Never auto-numbered. */
  caption?: string;
}

export type SlideElement = TextElement | ImageElement | ShapeElement | LineElement | EmojiElement | TableElement;

export interface Slide {
  id: ID;
  background: string;
  elements: SlideElement[];
  notes: string;
  /** Citation shown bottom-right in the footer. Optional: older files have none. */
  reference?: string;
  /** Academic citations shown in the footer (ids into Deck.citations, e.g. "arxiv:1706.03762"). */
  citations?: ID[];
  /** Structural slide type. Absent = ordinary slide. */
  kind?: SlideKind;
  /** For kind 'subtitle': the TOC section it belongs to. */
  sectionId?: ID;
}

export type SlideKind = 'title' | 'toc' | 'subtitle' | 'references' | 'thanks';

/** One Table of Contents entry. Order = position in Deck.sections. */
export interface Section {
  id: ID;
  title: string;
  subtitleSlideId: ID;
}

/** Academic citation metadata, keyed by a stable identifier ("arxiv:<id>", version stripped). */
export interface Citation {
  id: ID;
  type: 'arxiv';
  sourceId: string;
  url: string; // canonical paper URL used by every hyperlink
  status: 'loading' | 'ok' | 'error';
  title?: string;
  authors?: string[];
  year?: number;
  shortCitation?: string;
  fullCitation?: string;
  error?: string;
}

export interface Deck {
  version: 1;
  /** Stable identity of the presentation (recovery entries are updated, not duplicated). Optional for older files. */
  id?: ID;
  /** Presentation/project title (export default file name). */
  title: string;
  slides: Slide[];
  /**
   * The Title Slide's main title box. Editing its text updates `title`.
   * Explicit link (not inferred from size/position); absent in older files = no syncing.
   */
  titleElementId?: ID;
  /** Table of Contents sections (derived from the TOC box; maps section → Sub-title slide). */
  sections?: Section[];
  /** Presentation font (a SLIDE_FONTS id). Absent = NanumSquare. */
  fontFamily?: string;
  /** Presentation theme color (#rrggbb). Absent = White (no theme decorations). */
  themeColor?: string;
  /** Citation metadata registry. */
  citations?: Record<ID, Citation>;
}

export interface Asset {
  id: ID;
  mime: string;
  dataUrl: string;
  width: number;
  height: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
