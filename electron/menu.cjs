// Application menu template (pure: no Electron imports, so it can be unit-tested under plain Node).
// "Open Configuration…" (Cmd+,) and "Reload Configuration" (Cmd+Shift+,) are menu accelerators because macOS menu
// key equivalents are the reliable way to receive them; the renderer keeps a KeyboardEvent.code fallback.
function buildMenuTemplate({ platform, openConfig, reloadConfig }) {
  const configItems = [
    { id: 'open-config', label: 'Open Configuration…', accelerator: 'CmdOrCtrl+,', click: openConfig },
    { id: 'reload-config', label: 'Reload Configuration', accelerator: 'CmdOrCtrl+Shift+,', click: reloadConfig },
  ];
  const mac = platform === 'darwin';
  return [
    ...(mac ? [{
      label: 'MathSlides',
      submenu: [
        { role: 'about' }, { type: 'separator' }, ...configItems, { type: 'separator' },
        { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
      ],
    }] : [{ label: 'File', submenu: [...configItems, { type: 'separator' }, { role: 'quit' }] }]),
    // Undo/redo and select-all are intentionally not menu accelerators: the app handles
    // those keys itself (slide-level undo vs. text undo). Cut/copy/paste must stay as menu
    // roles on macOS so the page receives clipboard events.
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ];
}

module.exports = { buildMenuTemplate };
