import type { Deck, Slide, SlideElement } from './types';
import { SLIDE_H, SLIDE_W } from './types';
import { DEFAULT_TEXT_COLOR } from './defaults';
import { presetHex } from './colors';

/**
 * Presentation Theme Color — one presentation-level value (`Deck.themeColor`, absent = White) that drives
 * structural decorations: title band, content-slide header band, section-divider background and a thin
 * footer accent. Decorations are *derived* at render/export time from this file's layout, never stored
 * as slide elements, and never recolor user content. White = no decorations (the plain default look).
 */
export const THEME_WHITE = '#FFFFFF';
export const HEADER_H = 120;
export const FOOTER_ACCENT_H = 8;

export const themeColorOf = (deck: Pick<Deck, 'themeColor'>) => deck.themeColor ?? THEME_WHITE;
export const isThemed = (deck: Pick<Deck, 'themeColor'>) => themeColorOf(deck).toUpperCase() !== THEME_WHITE;

const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
/** WCAG relative luminance of #rrggbb. */
export function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
/** Black or white text, whichever has the higher contrast on `background`. */
export function getReadableTextColor(background: string): '#000000' | '#FFFFFF' {
  const l = luminance(background);
  return (1.05) / (l + 0.05) > (l + 0.05) / 0.05 ? '#FFFFFF' : '#000000';
}

export interface ThemeRect { name: string; x: number; y: number; w: number; h: number }
export interface ThemeLayout { color: string; fg: string; rects: ThemeRect[] }

type ThemeDeck = Pick<Deck, 'themeColor' | 'titleElementId'>;

const isTitleSlide = (deck: ThemeDeck, slide: Slide) => !!deck.titleElementId && slide.elements.some((e) => e.id === deck.titleElementId);

/** Where the theme paints on this slide (null = nothing, e.g. White theme). */
export function themeLayout(deck: ThemeDeck, slide: Slide): ThemeLayout | null {
  if (!isThemed(deck)) return null;
  const color = themeColorOf(deck), fg = getReadableTextColor(color);
  if (slide.kind === 'subtitle') return { color, fg, rects: [{ name: 'Theme Section Background', x: 0, y: 0, w: SLIDE_W, h: SLIDE_H }] };
  const rects: ThemeRect[] = [];
  const footer: ThemeRect = { name: 'Theme Footer Accent', x: 0, y: SLIDE_H - FOOTER_ACCENT_H, w: SLIDE_W, h: FOOTER_ACCENT_H };
  if (isTitleSlide(deck, slide)) {
    const t = slide.elements.find((e) => e.id === deck.titleElementId)!;
    rects.push({ name: 'Theme Title Band', x: 48, y: Math.max(0, t.y - 24), w: SLIDE_W - 96, h: t.h + 48 });
  } else if (slide.kind !== 'thanks') rects.push({ name: 'Theme Header Band', x: 0, y: 0, w: SLIDE_W, h: HEADER_H });
  rects.push(footer);
  return { color, fg, rects };
}

const TEMPLATE_DARK = new Set([DEFAULT_TEXT_COLOR.toLowerCase(), presetHex('Dark Gray').toLowerCase()]);

/**
 * Text drawn directly on a theme-colored area gets the readable foreground — but only when its box color is
 * still a default (black / template dark gray). Colors the user chose (box or run colors) are never touched.
 */
export function themedTextColor(deck: ThemeDeck, slide: Slide, el: SlideElement): string | null {
  if (el.type !== 'text' || !TEMPLATE_DARK.has(el.style.color.toLowerCase())) return null;
  const layout = themeLayout(deck, slide);
  if (!layout) return null;
  if (slide.kind === 'subtitle') return layout.fg;
  if (isTitleSlide(deck, slide)) return el.id === deck.titleElementId ? layout.fg : null;
  return layout.rects.some((r) => r.name === 'Theme Header Band') && el.y >= 0 && el.y + el.h <= HEADER_H + 8 ? layout.fg : null;
}
