// Desktop shell: same web app, plus one-click vector PDF export via Chromium's printToPDF.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'MathSlides',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#eceef1',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  if (process.env.ELECTRON_DEV_URL) win.loadURL(process.env.ELECTRON_DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Links clicked inside the app (citations, References) open in the browser, never in this window.
  win.webContents.on('will-navigate', (e, url) => {
    if (url.split('#')[0] === win.webContents.getURL().split('#')[0]) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

ipcMain.handle('print-to-pdf', async (event, suggestedName) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const data = await event.sender.printToPDF({
    printBackground: true,
    preferCSSPageSize: true, // @page { size: 1280px 720px } = 13.333 × 7.5 in
    margins: { marginType: 'none' },
  });
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), suggestedName || 'slides.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, data);
  return filePath;
});

// Citation metadata (arXiv sends no CORS headers, so the renderer can't fetch it directly).
// Only the arXiv API host is allowed.
ipcMain.handle('fetch-text', async (_event, url) => {
  if (typeof url !== 'string' || !url.startsWith('https://export.arxiv.org/api/')) return { ok: false, status: 0, text: '' };
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (e) {
    return { ok: false, status: 0, text: String(e) };
  }
});

// Undo/redo and select-all are intentionally not menu accelerators: the app handles
// those keys itself (slide-level undo vs. text undo). Cut/copy/paste must stay as menu
// roles on macOS so the page receives clipboard events.
const template = [
  ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
  { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
  { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  { role: 'windowMenu' },
];

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
