const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('passbookNative', {
  listPrinters: () => ipcRenderer.invoke('list-printers'),
  printRaw: (printer, text) => ipcRenderer.invoke('print-raw', printer, text)
});
