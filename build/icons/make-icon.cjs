const { app, BrowserWindow } = require('electron');
const fs = require('fs');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<body></body>');
  const out = await win.webContents.executeJavaScript(`(() => {
    const S = 1024, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    // macOS icon grid: 824px rounded tile centered in the 1024 canvas
    const T = 824, o = (S - T) / 2, r = 185;
    g.beginPath(); g.roundRect(o, o, T, T, r); g.fillStyle = '#F5F7FA'; g.fill();
    g.lineWidth = 2; g.strokeStyle = 'rgba(15,23,42,.10)'; g.stroke();
    // Same glyph, weight, color and font stack as the editor header logo (.logo in styles.css)
    const stack = "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Segoe UI', sans-serif";
    g.font = '700 400px ' + stack; g.textBaseline = 'alphabetic';
    let m = g.measureText('∑');
    const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    const size = Math.round(400 * 430 / h); // ink height ≈ 430px (~52% of the tile)
    g.font = '700 ' + size + 'px ' + stack; m = g.measureText('∑');
    const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight, hh = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    g.fillStyle = '#2f6feb'; g.textAlign = 'left';
    g.fillText('∑', S / 2 - w / 2 + m.actualBoundingBoxLeft, S / 2 - hh / 2 + m.actualBoundingBoxAscent);
    return JSON.stringify({ url: c.toDataURL('image/png'), size, w: Math.round(w), h: Math.round(hh), family: stack });
  })()`);
  const j = JSON.parse(out);
  fs.writeFileSync('icon-1024.png', Buffer.from(j.url.split(',')[1], 'base64'));
  console.log(JSON.stringify({ size: j.size, inkW: j.w, inkH: j.h }));
  app.quit();
});
