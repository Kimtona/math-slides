const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  printToPDF: (suggestedName) => ipcRenderer.invoke('print-to-pdf', suggestedName),
  fetchText: (url) => ipcRenderer.invoke('fetch-text', url),
  // .mslides files opened through the OS. openReady() resolves with the requests queued before the renderer was ready.
  openReady: () => ipcRenderer.invoke('native-open-ready'),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_event, file) => cb(file)),
  // Only paths that were opened through the OS are writable.
  writeFile: (target, text) => ipcRenderer.invoke('native-write', target, text),
  // Sketch-to-Slides (the API key stays in the main process; only its source is reported).
  sketch: {
    status: () => ipcRenderer.invoke('sketch:status'),
    setKey: (key) => ipcRenderer.invoke('sketch:set-key', key),
    setSettings: (s) => ipcRenderer.invoke('sketch:set-settings', s),
    recognize: (req) => ipcRenderer.invoke('sketch:recognize', req),
    review: (req) => ipcRenderer.invoke('sketch:review', req),
    capture: (rect) => ipcRenderer.invoke('sketch:capture', rect),
    log: (runId, name, data) => ipcRenderer.invoke('sketch:log', runId, name, data),
  },
});
