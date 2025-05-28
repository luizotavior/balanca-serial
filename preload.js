const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startServer: (config) => ipcRenderer.invoke('start-server', config),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  onPeso: (callback) => ipcRenderer.on('peso', (event, value) => callback(value)),
});