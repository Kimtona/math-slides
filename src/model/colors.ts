/**
 * All color definitions live in this file.
 *
 * PRESET_COLORS: base named colors for defaults (presetHex).
 * Red/Blue/Green are matplotlib's default "tab:" colors, so slides match typical plots.
 */
export const PRESET_COLORS = [
  { name: 'Black', hex: '#000000' },
  { name: 'Dark Gray', hex: '#404040' },
  { name: 'Light Gray', hex: '#BFBFBF' },
  { name: 'White', hex: '#FFFFFF' },
  { name: 'Red', hex: '#D62728' },
  { name: 'Blue', hex: '#1F77B4' },
  { name: 'Green', hex: '#2CA02C' },
] as const;

export const presetHex = (name: (typeof PRESET_COLORS)[number]['name']) =>
  PRESET_COLORS.find((c) => c.name === name)!.hex;

export const sameColor = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

// ---------- text color palette (Text Color button) and highlight palette ----------

/** Static for now: a future deck theme can supply columns with this same shape. */
export interface ThemeColorColumn { name: string; base: string; shades: readonly string[] }
export const THEME_COLORS: readonly ThemeColorColumn[] = [
  { name: 'White', base: '#FFFFFF', shades: ['#F8FAFC', '#F1F5F9', '#E2E8F0', '#CBD5E1', '#94A3B8'] },
  { name: 'Black', base: '#000000', shades: ['#D4D4D8', '#A1A1AA', '#71717A', '#3F3F46', '#18181B'] },
  { name: 'Gray', base: '#64748B', shades: ['#F1F5F9', '#CBD5E1', '#94A3B8', '#475569', '#1E293B'] },
  { name: 'Blue', base: '#3B82F6', shades: ['#DBEAFE', '#93C5FD', '#60A5FA', '#2563EB', '#1E3A8A'] },
  { name: 'Cyan', base: '#06B6D4', shades: ['#CFFAFE', '#67E8F9', '#22D3EE', '#0891B2', '#164E63'] },
  { name: 'Orange', base: '#F97316', shades: ['#FFEDD5', '#FDBA74', '#FB923C', '#EA580C', '#7C2D12'] },
  { name: 'Green', base: '#22C55E', shades: ['#DCFCE7', '#86EFAC', '#4ADE80', '#16A34A', '#14532D'] },
  { name: 'Teal', base: '#14B8A6', shades: ['#CCFBF1', '#5EEAD4', '#2DD4BF', '#0D9488', '#134E4A'] },
  { name: 'Purple', base: '#8B5CF6', shades: ['#EDE9FE', '#C4B5FD', '#A78BFA', '#7C3AED', '#4C1D95'] },
  { name: 'Rose', base: '#F43F5E', shades: ['#FFE4E6', '#FDA4AF', '#FB7185', '#E11D48', '#881337'] },
];

/** Fixed quick-access hues, independent of presentation themes. */
export const STANDARD_COLORS = [
  { name: 'Red', hex: '#DC2626' }, { name: 'Orange', hex: '#F97316' },
  { name: 'Yellow', hex: '#FACC15' }, { name: 'Light Green', hex: '#A3E635' },
  { name: 'Green', hex: '#16A34A' }, { name: 'Cyan', hex: '#06B6D4' },
  { name: 'Blue', hex: '#2563EB' }, { name: 'Purple', hex: '#9333EA' },
  { name: 'Pink', hex: '#EC4899' },
] as const;

export const HIGHLIGHT_COLORS = [
  { name: 'Yellow', hex: '#FEF08A' }, { name: 'Light Green', hex: '#D9F99D' },
  { name: 'Light Cyan', hex: '#BAE6FD' }, { name: 'Light Pink', hex: '#FBCFE8' },
  { name: 'Light Purple', hex: '#DDD6FE' }, { name: 'Light Gray', hex: '#E2E8F0' },
] as const;

/** Accept only opaque RGB HEX; shorthand expands without changing its color. */
export function parseHex(value: string): string | null {
  const hex = value.trim().replace(/^#/, '');
  if (/^[\da-f]{6}$/i.test(hex)) return '#' + hex.toUpperCase();
  if (/^[\da-f]{3}$/i.test(hex)) return '#' + [...hex].map((c) => c + c).join('').toUpperCase();
  return null;
}

/** Browser HTML/clipboard parsing may serialize the same RGB color instead of HEX. */
export function normalizeTextColor(value: string): string {
  const hex = parseHex(value);
  if (hex) return hex;
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(value);
  if (rgb && rgb.slice(1).every((n) => Number(n) <= 255)) {
    return '#' + rgb.slice(1).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  return value.toLowerCase();
}
