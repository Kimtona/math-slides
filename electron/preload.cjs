const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  printToPDF: (suggestedName) => ipcRenderer.invoke('print-to-pdf', suggestedName),
});
