const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  printToPDF: (suggestedName) => ipcRenderer.invoke('print-to-pdf', suggestedName),
  fetchText: (url) => ipcRenderer.invoke('fetch-text', url),
  // .mslides files opened through the OS. openReady() resolves with the requests queued before the renderer was ready.
  openReady: () => ipcRenderer.invoke('native-open-ready'),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_event, file) => cb(file)),
  // Only paths that were opened through the OS are writable.
  writeFile: (target, text) => ipcRenderer.invoke('native-write', target, text),
});
