// Desktop shell: same web app, plus one-click vector PDF export via Chromium's printToPDF.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------- opening .mslides files from the OS (Finder double-click, "Open With", argv) ----------
// Requests are validated here (only *.mslides files), queued until the renderer is ready, and handed to
// the renderer as {path, name, text}. The renderer can only write back to paths that arrived this way.
const MSLIDES = /\.mslides$/i;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
let mainWin = null;
let rendererReady = false;
const openQueue = [];
const allowedFile = () => path.join(app.getPath('userData'), 'native-files.json');
let allowed = null;
function allowedSet() {
  if (!allowed) {
    try { allowed = new Set(JSON.parse(fs.readFileSync(allowedFile(), 'utf8'))); } catch { allowed = new Set(); }
  }
  return allowed;
}
function allow(p) {
  const set = allowedSet();
  if (set.has(p)) return;
  set.add(p);
  try { fs.writeFileSync(allowedFile(), JSON.stringify([...set])); } catch (e) { console.error('could not persist the file allow-list', e); }
}
/** Path of a valid-looking document request, or null. */
function documentPath(p) {
  return typeof p === 'string' && MSLIDES.test(p) ? path.resolve(p) : null;
}
function readDocument(p) {
  const st = fs.statSync(p);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > MAX_FILE_BYTES) throw new Error('file is too large');
  allow(p);
  return { path: p, name: path.basename(p), text: fs.readFileSync(p, 'utf8') };
}
function safeDocument(p) {
  try { return readDocument(p); } catch (e) { return { error: String(e.message || e), name: path.basename(p) }; }
}
function focusWindow() {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}
function requestOpen(candidate) {
  const p = documentPath(candidate);
  if (!p) return;
  if (rendererReady && mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('open-file', safeDocument(p));
  else {
    openQueue.push(p);
    if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow();
  }
  focusWindow();
}
ipcMain.handle('native-open-ready', () => {
  rendererReady = true;
  return openQueue.splice(0).map(safeDocument);
});
// Write-back only to documents that were opened through the OS (current file association of such documents).
ipcMain.handle('native-write', (_event, target, text) => {
  try {
    const p = documentPath(target);
    if (!p || typeof text !== 'string' || !allowedSet().has(p)) return { ok: false, error: 'not an opened document' };
    if (!fs.statSync(p).isFile()) return { ok: false, error: 'not a file' };
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});
app.on('open-file', (event, p) => { event.preventDefault(); requestOpen(p); });
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on('second-instance', (_event, argv, cwd) => {
  argv.slice(1).forEach((a) => requestOpen(typeof a === 'string' && !path.isAbsolute(a) ? path.resolve(cwd || '', a) : a));
  focusWindow();
});
process.argv.slice(1).forEach(requestOpen); // Windows/Linux: the file arrives as an argument

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
  mainWin = win;
  win.on('closed', () => { if (mainWin === win) { mainWin = null; rendererReady = false; } });
  win.webContents.on('did-start-loading', () => { rendererReady = false; }); // reload: the renderer asks again
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
  if (!singleInstance) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
