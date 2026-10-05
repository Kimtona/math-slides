// Generates the .mslides document icon master (1024×1024 PNG): a horizontal 16:9 slide card with the MathSlides blue Σ.
// Run: node_modules/.bin/electron build/icons/make-doc-icon.cjs   (writes mslides-doc-1024.png, mslides.icns and mslides.ico next to this file; icns needs macOS iconutil)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<body></body>');
  const dataUrl = await win.webContents.executeJavaScript(`(() => {
    const S = 1024, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    // 16:9 slide card, centered on the canvas (no folded corner, so it reads as a slide rather than a text page).
    const w = 880, h = 495, r = 44, x0 = (S - w) / 2, y0 = (S - h) / 2, x1 = x0 + w, y1 = y0 + h;
    g.beginPath(); g.roundRect(x0, y0, w, h, r);
    g.save(); g.shadowColor = 'rgba(15,23,42,.22)'; g.shadowBlur = 36; g.shadowOffsetY = 14;
    g.fillStyle = '#F5F7FA'; g.fill(); g.restore();
    g.lineWidth = 3; g.strokeStyle = 'rgba(15,23,42,.18)'; g.stroke();
    // Same glyph, weight, color and font stack as the app icon / header logo.
    const stack = "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Segoe UI', sans-serif";
    g.font = '700 400px ' + stack; g.textBaseline = 'alphabetic';
    let m = g.measureText('∑');
    const size = Math.round(400 * 300 / (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent)); // ink height ≈ 300px
    g.font = '700 ' + size + 'px ' + stack; m = g.measureText('∑');
    const iw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight, ih = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    g.fillStyle = '#2f6feb';
    g.fillText('∑', cx - iw / 2 + m.actualBoundingBoxLeft, cy - ih / 2 + m.actualBoundingBoxAscent);
    return c.toDataURL('image/png');
  })()`);
  fs.writeFileSync(path.join(__dirname, 'mslides-doc-1024.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  const { nativeImage } = require('electron');
  const { execFileSync } = require('child_process');
  const master = nativeImage.createFromBuffer(fs.readFileSync(path.join(__dirname, 'mslides-doc-1024.png')));
  const png = (px) => master.resize({ width: px, height: px, quality: 'best' }).toPNG();
  // .icns via an iconset (16–512 at 1x/2x).
  const set = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mslides-')) + '/mslides.iconset';
  fs.mkdirSync(set);
  for (const n of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(set, `icon_${n}x${n}.png`), png(n));
    fs.writeFileSync(path.join(set, `icon_${n}x${n}@2x.png`), png(n * 2));
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(__dirname, 'mslides.icns')]);
  // .ico: PNG-compressed entries 16–256.
  const sizes = [16, 24, 32, 48, 64, 128, 256], pngs = sizes.map(png);
  const head = Buffer.alloc(6 + 16 * sizes.length); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = head.length;
  sizes.forEach((px, i) => {
    const e = 6 + 16 * i;
    head[e] = px === 256 ? 0 : px; head[e + 1] = px === 256 ? 0 : px;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(off, e + 12); off += pngs[i].length;
  });
  fs.writeFileSync(path.join(__dirname, 'mslides.ico'), Buffer.concat([head, ...pngs]));
  app.quit();
});
