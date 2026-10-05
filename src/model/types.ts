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
}

interface ElementBase {
  id: ID;
  x: number;
  y: number;
  w: number;
  h: number; // for text: measured from content (auto height)
}

export interface TextElement extends ElementBase {
  type: 'text';
  doc: PMNode;
  style: TextStyle;
}

export interface ImageElement extends ElementBase {
  type: 'image';
  assetId: ID;
}

export type ShapeKind = 'rect' | 'roundRect' | 'ellipse';

export interface ShapeElement extends ElementBase {
  type: 'shape';
  shape: ShapeKind;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  radius: number; // roundRect corner radius, px
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
}

export type SlideElement = TextElement | ImageElement | ShapeElement | LineElement;

export interface Slide {
  id: ID;
  background: string;
  elements: SlideElement[];
  notes: string;
}

export interface Deck {
  version: 1;
  title: string;
  slides: Slide[];
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
