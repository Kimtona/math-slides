/**
 * Preset colors for text, shapes, lines and slide backgrounds — the ONLY place colors are defined.
 * Add an entry or change a hex value here and every palette in the app picks it up.
 * Red/Blue/Green are matplotlib's default "tab:" colors, so slide text matches typical plots.
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

export const colorName = (hex: string | null | undefined) =>
  PRESET_COLORS.find((c) => sameColor(c.hex, hex))?.name ?? hex ?? 'None';
