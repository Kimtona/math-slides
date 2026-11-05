/**
 * Minimal PNG helpers for the command-line tool (no dependencies): decode 8-bit RGB/RGBA/gray non-interlaced PNGs (what
 * macOS `sips` writes) to an RGBA raster, and drop metadata chunks (EXIF incl. GPS, text) before an image is used.
 */
import { inflateSync } from 'node:zlib';

const KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'iCCP', 'cICP', 'sRGB', 'gAMA', 'cHRM']);

/** The PNG without metadata chunks (eXIf, tEXt, iTXt, zTXt, tIME, …). */
export function stripPngMetadata(buf) {
  const out = [buf.subarray(0, 8)];
  for (let i = 8; i < buf.length;) {
    const n = buf.readUInt32BE(i), type = buf.toString('latin1', i + 4, i + 8);
    if (KEEP.has(type)) out.push(buf.subarray(i, i + 12 + n));
    i += 12 + n;
  }
  return Buffer.concat(out);
}

/** RGBA raster of a non-interlaced 8-bit PNG (color types 0, 2, 4, 6). Throws for anything else. */
export function decodePng(buf) {
  let width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  for (let i = 8; i < buf.length;) {
    const n = buf.readUInt32BE(i), type = buf.toString('latin1', i + 4, i + 8), d = buf.subarray(i + 8, i + 8 + n);
    if (type === 'IHDR') { width = d.readUInt32BE(0); height = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === 'IDAT') idat.push(d);
    i += 12 + n;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  if (depth !== 8 || !ch || interlace) throw new Error(`unsupported PNG (depth ${depth}, color type ${ctype}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch, data = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride), p = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[p++], line = new Uint8Array(raw.subarray(p, p + stride)); p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      line[x] = (line[x] + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, s = x * ch;
      if (ch >= 3) { data[o] = line[s]; data[o + 1] = line[s + 1]; data[o + 2] = line[s + 2]; } else { data[o] = data[o + 1] = data[o + 2] = line[s]; }
      data[o + 3] = ch === 4 ? line[s + 3] : ch === 2 ? line[s + 1] : 255;
    }
    prev = line;
  }
  return { data, width, height };
}
