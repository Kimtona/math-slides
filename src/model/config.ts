import { parseHex, presetHex } from './colors';
import { DEFAULT_FONT, SLIDE_FONTS, isSlideFont, type SlideFont } from './fonts';
import { DEFAULT_RADIUS_PRESET } from './imageCrop';
import { TYPOGRAPHY } from './typography';

/**
 * The user configuration file (`config.txt`): a Ghostty-style `key = value` list of CREATION DEFAULTS.
 * Pure model — no Electron, no storage. The file itself is read/written by the Electron main process
 * (electron/main.cjs) and applied by src/store/configFile.ts.
 *
 * Rule that keeps old presentations safe: a configured value is read only at the moment an element is created and
 * is then stored in the element itself (font size, shape fill, ...). It is never consulted when rendering, so
 * changing the file can never restyle existing content. The built-in constants (TYPOGRAPHY, DEFAULT_FONT, ...)
 * remain the fallback for everything that does not store its own value.
 */
export interface Config {
  /** Font (a SLIDE_FONTS id) for newly created text. */
  font: SlideFont;
  /** px on the 1280×720 slide: `#`, `##`, `###` headings and body text (`####`, new text boxes, shape text). */
  heading1: number;
  heading2: number;
  heading3: number;
  bodySize: number;
  /** `null` = no fill. */
  shapeFill: string | null;
  shapeStroke: string;
  /** px */
  shapeStrokeWidth: number;
  /** px — the Corner Radius preset button. */
  imageRadiusPreset: number;
}

/** Shape defaults of a new shape when nothing is configured (no fill, thin black outline). */
export const BUILTIN_SHAPE = { fill: null, stroke: presetHex('Black'), strokeWidth: 1 } as const;

export const DEFAULT_CONFIG: Readonly<Config> = {
  font: DEFAULT_FONT,
  heading1: TYPOGRAPHY.h1,
  heading2: TYPOGRAPHY.h2,
  heading3: TYPOGRAPHY.h3,
  bodySize: TYPOGRAPHY.body,
  shapeFill: BUILTIN_SHAPE.fill,
  shapeStroke: BUILTIN_SHAPE.stroke,
  shapeStrokeWidth: BUILTIN_SHAPE.strokeWidth,
  imageRadiusPreset: DEFAULT_RADIUS_PRESET,
};

export interface ConfigError { line: number; key?: string; message: string }
export type ParseResult = { ok: true; config: Config } | { ok: false; errors: ConfigError[] };

const FONT_SIZE_RANGE = [6, 300] as const; // the font-size box of the toolbar
const STROKE_RANGE = [0.5, 50] as const;
const RADIUS_RANGE = [0, 1000] as const;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** `80` or `80px` (bare = the editor's px, as shown in the toolbar), or `60pt`. 1pt = 4/3 px. Throws a message string for anything else. */
function parseLength(raw: string, [min, max]: readonly [number, number]): number {
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(raw);
  if (!m) throw `"${raw}" is not a number with an optional px/pt unit`;
  const unit = m[2].toLowerCase();
  if (unit !== '' && unit !== 'px' && unit !== 'pt') throw `unsupported unit "${m[2]}" (use px or pt)`;
  const px = round2(unit === 'pt' ? (Number(m[1]) * 4) / 3 : Number(m[1]));
  if (!Number.isFinite(px) || px < min || px > max) throw `${raw} is out of range (${min}–${max}px)`;
  return px;
}

const color = (raw: string): string => {
  const hex = parseHex(raw);
  if (!hex) throw `"${raw}" is not a HEX color like #000000`;
  return hex;
};

type Setter = (c: Config, raw: string) => void;
const KEYS: Record<string, Setter> = {
  font: (c, raw) => {
    const f = SLIDE_FONTS.find((x) => x.id.toLowerCase() === raw.toLowerCase())?.id;
    if (!f || !isSlideFont(f)) throw `unknown font "${raw}" (available: ${SLIDE_FONTS.map((x) => x.id).join(', ')})`;
    c.font = f;
  },
  'heading-1': (c, raw) => { c.heading1 = parseLength(raw, FONT_SIZE_RANGE); },
  'heading-2': (c, raw) => { c.heading2 = parseLength(raw, FONT_SIZE_RANGE); },
  'heading-3': (c, raw) => { c.heading3 = parseLength(raw, FONT_SIZE_RANGE); },
  'body-size': (c, raw) => { c.bodySize = parseLength(raw, FONT_SIZE_RANGE); },
  'shape-fill': (c, raw) => { c.shapeFill = raw.toLowerCase() === 'none' ? null : color(raw); },
  'shape-stroke': (c, raw) => { c.shapeStroke = color(raw); },
  'shape-stroke-width': (c, raw) => { c.shapeStrokeWidth = parseLength(raw, STROKE_RANGE); },
  'image-radius-preset': (c, raw) => { c.imageRadiusPreset = parseLength(raw, RADIUS_RANGE); },
};
export const CONFIG_KEYS = Object.keys(KEYS);

/**
 * Parse the whole file or nothing: any problem (unknown/duplicate key, bad value, line without `=`) is reported with
 * its line number and the result is `ok: false`, so a reload can keep the previous configuration.
 * Syntax: `key = value`; blank lines and lines starting with `#` are ignored (there are no trailing comments, because
 * a value may itself start with `#`, e.g. a color). Keys that are absent keep the built-in default.
 */
export function parseConfig(text: string): ParseResult {
  const config: Config = { ...DEFAULT_CONFIG };
  const errors: ConfigError[] = [];
  const seen = new Map<string, number>();
  text.replace(/^﻿/, '').split(/\r\n|\r|\n/).forEach((rawLine, i) => {
    const line = i + 1;
    const t = rawLine.trim();
    if (!t || t.startsWith('#')) return;
    const eq = t.indexOf('=');
    if (eq < 0) return void errors.push({ line, message: `expected "key = value", got "${t}"` });
    const key = t.slice(0, eq).trim(), value = t.slice(eq + 1).trim();
    if (!key) return void errors.push({ line, message: 'missing key before "="' });
    const set = Object.prototype.hasOwnProperty.call(KEYS, key) ? KEYS[key] : undefined;
    if (!set) return void errors.push({ line, key, message: `unknown key "${key}"` });
    if (seen.has(key)) return void errors.push({ line, key, message: `duplicate ${key} (first set on line ${seen.get(key)})` });
    seen.set(key, line);
    if (!value) return void errors.push({ line, key, message: `${key} has no value` });
    try { set(config, value); } catch (e) { errors.push({ line, key, message: `invalid ${key}: ${String(e)}` }); }
  });
  return errors.length ? { ok: false, errors } : { ok: true, config };
}

/** One-line description of the first error, for the toast: `Config error on line 5: invalid heading-2: ...`. */
export function describeConfigErrors(errors: ConfigError[]): string {
  const [first] = errors;
  return `Config error on line ${first.line}: ${first.message}` + (errors.length > 1 ? ` (+${errors.length - 1} more)` : '');
}

/** The commented file created by "Open Configuration" when none exists; its values are the built-in defaults. */
export function configTemplate(): string {
  const d = DEFAULT_CONFIG;
  return `# MathSlides Configuration
#
# Edit this file, save it, then press Cmd+Shift+, in MathSlides to apply it (no restart needed).
# The file is read again every time MathSlides starts.
#
# These are DEFAULTS FOR NEW CONTENT. Changing them never changes slides you already made:
# headings, text boxes, shapes and images that exist keep the look they were created with.
#
# Syntax: key = value, one per line. Lines starting with # are comments; blank lines are ignored.
# Font sizes (heading-1/2/3, body-size): write a plain number WITHOUT px or pt, like heading-1 = 80.
# Plain numbers are the same numbers you see in MathSlides' font-size box (the toolbar), so heading-1 = 80 is a
# line that shows 80 there. (Advanced: a px or pt suffix is accepted; 1pt = 4/3px, so 60pt = 80. Leave it out
# unless you need it, because 100pt would show 133.33.)
# To reset one setting, delete its line (or put # in front of it). To reset everything, delete this file.
# If a line has a mistake, MathSlides tells you which one and keeps the previous settings.

# Typography
# font: ${SLIDE_FONTS.map((f) => f.id).join(' | ')}
font = ${d.font}
# heading-1/2/3: size of new lines started with #, ##, ###
heading-1 = ${d.heading1}
heading-2 = ${d.heading2}
heading-3 = ${d.heading3}
# body-size: new text boxes, shape text and #### lines
body-size = ${d.bodySize}

# Shapes
# shape-fill: a HEX color such as #FFFFFF, or none
shape-fill = ${d.shapeFill ?? 'none'}
shape-stroke = ${d.shapeStroke}
shape-stroke-width = ${d.shapeStrokeWidth}px

# Images
# image-radius-preset: the value the corner-radius preset button applies
image-radius-preset = ${d.imageRadiusPreset}px
`;
}

// ---------- active configuration (in-memory; the file is the source of truth) ----------

let active: Config = { ...DEFAULT_CONFIG };
const listeners = new Set<() => void>();

export const getConfig = (): Readonly<Config> => active;
export const subscribeConfig = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Atomically replace the active configuration (a complete, already validated Config). */
export function setConfig(next: Config) {
  active = { ...next };
  listeners.forEach((l) => l());
}
export const resetConfig = () => setConfig(DEFAULT_CONFIG);
